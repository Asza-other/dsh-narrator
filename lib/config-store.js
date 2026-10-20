/**
 * dsh-narrator 的用户覆盖配置存储。
 *
 * 插件有两层配置：
 *   ① 基础层 —— cordis.patch.yml 的 `config:` 块，由部署者写；
 *   ② 覆盖层 —— 用户在设置页里调的值，存到 `~/.dsh/narrator/config.json`。
 *
 * 覆盖层优先于基础层，且只在**用户显式保存过的字段**上生效，没动过的字段
 * 继续跟随 yml。这样用户改了插件配置页不会把 yml 里的其它值一起固化住。
 *
 * 放在固定全局路径（而非插件目录）是因为插件可能从 node_modules 加载，
 * 重装/升级会清空包内文件；`~/.dsh` 是宿主的用户级目录，跨升级存活。
 *
 * @module dsh-narrator/config-store
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

/** 覆盖层配置目录。 */
export function configDir(home = os.homedir()) {
  return path.join(home, '.dsh', 'narrator')
}

/**
 * 覆盖层配置文件路径。
 *
 * `DSH_NARRATOR_CONFIG` 可以把路径指到别处——测试用它隔离真实用户配置，
 * 否则一次测试就会把用户调好的值覆盖掉。
 */
export function configPath(home = os.homedir()) {
  const custom = process.env.DSH_NARRATOR_CONFIG
  if (typeof custom === 'string' && custom !== '') return custom
  return path.join(configDir(home), 'config.json')
}

/**
 * 读覆盖层。文件不存在、损坏、或不是对象都返回空对象——
 * 配置读不出来不应该让插件挂掉。
 *
 * 但**损坏不能静默吞掉**：曾经用 `catch { return {} }` 一把兜住，结果并发写
 * 把文件写坏后，用户所有覆盖配置无声退回默认值，既没日志也没提示。
 * 现在把损坏原因通过 `onError` 报出去（调用方记日志），仍然返回 `{}` 保命。
 *
 * @param {string} [file] 配置文件路径
 * @param {(error:Error)=>void} [onError] 损坏/读失败时的回调
 * @returns {Promise<object>} 覆盖层字段
 */
export async function loadOverride(file = configPath(), onError) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    // 文件不存在是正常的首次运行，不该当成错误
    if (error.code !== 'ENOENT' && typeof onError === 'function') onError(error)
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (typeof onError === 'function') onError(new Error(`override-not-object: ${file}`))
      return {}
    }
    return parsed
  } catch (error) {
    if (typeof onError === 'function') onError(error)
    return {}
  }
}

/**
 * 写覆盖层。先写临时文件再 rename，避免写一半被读到。
 *
 * 临时文件名必须**每次唯一**：原来只用 `${file}.${pid}.tmp`，同进程内两个
 * 并发保存会共用同一个 tmp，实测 6 并发 20 轮出现 41 次 rename ENOENT
 * （先完成的那个已把 tmp 移走），严重的时序下还会写下交错的半截 JSON。
 * 加 `randomUUID()` 后每次写自己的文件，rename 是原子的，最后落地者胜出。
 *
 * @param {object} values 要保存的完整覆盖层
 * @param {string} [file] 配置文件路径
 * @returns {Promise<string>} 实际写入路径
 */
export async function saveOverride(values, file = configPath()) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(values, null, 2), 'utf8')
  try {
    await renameWithRetry(tmp, file)
  } catch (error) {
    // rename 失败时清掉临时文件，别在用户目录里留垃圾
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return file
}

/**
 * rename，带退避重试。
 *
 * Windows 上目标文件正被另一个 rename 持有时会短暂抛 `EPERM`（不是 Linux 那种
 * 原子替换语义）。实测 6 并发 × 10 轮出现 12 次 EPERM——对一次「点保存」来说
 * 就是随机失败。重试几次即可跨过那个毫秒级窗口。
 *
 * @param {string} from 源
 * @param {string} to 目标
 */
async function renameWithRetry(from, to) {
  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      lastError = error
      // 只有「被占用 / 拒绝访问」值得重试，其余（如权限不足）立刻失败更诚实
      if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EBUSY') throw error
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
    }
  }
  throw lastError
}

/**
 * 把覆盖层合并到基础配置上。
 *
 * 只覆盖 `allowed` 里列出的键，避免配置文件里混入不认识的东西被带进运行时。
 * @param {object} base 基础层（cordis.patch.yml 的值）
 * @param {object} override 覆盖层
 * @param {string[]} allowed 允许被覆盖的键名
 * @returns {object} 合并后的配置
 */
export function mergeOverride(base, override, allowed) {
  const out = { ...(base ?? {}) }
  if (override === null || typeof override !== 'object') return out
  for (const key of allowed) {
    if (!Object.hasOwn(override, key)) continue
    const value = override[key]
    if (value === undefined || value === null) continue
    out[key] = value
  }
  return out
}
