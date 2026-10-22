/**
 * 配置路由端到端探针：起一个假 webServer，走真实 apply()，
 * 检查 GET/POST 的行为与持久化。
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, normalizeConfig } from '../lib/index.js'
import { loadOverride, mergeOverride, saveOverride } from '../lib/config-store.js'

/** 构造一个能记录路由的假 ctx。 */
function makeCtx(config) {
  const routes = new Map()
  const handlers = new Map()
  const ctx = {
    systemPrompt: { section: () => {} },
    logger: { info() {}, warn() {}, error() {} },
    on() {
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({
          webServer: {
            register({ path: p, handler }) {
              routes.set(p, true)
              handlers.set(p, handler)
              return () => {
                routes.delete(p)
                handlers.delete(p)
              }
            },
          },
          effect: ctx.effect,
        })
      }
    },
    _handlers: handlers,
  }
  return ctx
}

/** 造一个假 req/res 对。 */
function call(handler, { method = 'GET', body = null, remote = '127.0.0.1', url = null } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const listeners = {}
    const req = {
      method,
      url: url ?? '/',
      socket: { remoteAddress: remote },
      headers: { 'sec-fetch-site': 'same-origin' },
      on(event, fn) {
        listeners[event] = listeners[event] ?? []
        listeners[event].push(fn)
        return req
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(code, headers) {
        this.statusCode = code
        this.headers = headers
        return this
      },
      end(text) {
        this.body = text ?? ''
        resolve({ status: this.statusCode, body: this.body })
      },
    }
    handler(req, res)
    if (body !== null) {
      const buf = Buffer.from(JSON.stringify(body), 'utf8')
      for (const fn of listeners.data ?? []) fn(buf)
    }
    for (const fn of listeners.end ?? []) fn()
  })
}

// 用临时目录隔离配置路径：不设这个变量的话，测试里的 POST 会写到用户真实的
// ~/.dsh/narrator/config.json，把用户调好的触发时长覆盖掉。
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-route-'))
const file = path.join(home, 'config.json')
process.env.DSH_NARRATOR_CONFIG = file

// 1) 存储层自身的往返
const roundTrip = path.join(home, 'roundtrip.json')
await saveOverride({ silentSeconds: 120 }, roundTrip)
assert.deepEqual(await loadOverride(roundTrip), { silentSeconds: 120 }, '覆盖层应能往返')

// 2) 覆盖层只覆盖允许的键
const merged = mergeOverride({ silentSeconds: 25, cooldownSeconds: 60, extra: 1 }, { silentSeconds: 120, evil: 9 }, [
  'silentSeconds',
  'cooldownSeconds',
])
assert.equal(merged.silentSeconds, 120, '允许的键被覆盖')
assert.equal(merged.cooldownSeconds, 60, '未指定的键保留基础层')
assert.equal(merged.extra, 1, '基础层其它字段不丢')
assert.equal(merged.evil, undefined, '白名单外的键不得进入运行配置')

// 3) 走真实 apply() 的 GET
const ctx = makeCtx({ silentSeconds: 25, cooldownSeconds: 60, maxPerTurn: 3 })
apply(ctx, { silentSeconds: 25, cooldownSeconds: 60, maxPerTurn: 3 })

const getHandler = ctx._handlers.get('/api/narrator/config')
assert.ok(getHandler, '应注册 /api/narrator/config')

const got = await call(getHandler)
assert.equal(got.status, 200)
const gotBody = JSON.parse(got.body)
assert.equal(gotBody.ok, true)
assert.equal(gotBody.config.silentSeconds, 25)
assert.equal(gotBody.config.silentMinutes, 0.42, '25 秒 ≈ 0.42 分钟')
assert.equal(gotBody.config.maxPerTurn, 3)

// 4) loopback 校验
const denied = await call(getHandler, { remote: '10.0.0.9' })
assert.equal(denied.status, 403, '非 loopback 必须拒绝')

// 5) 方法校验
const wrongMethod = await call(getHandler, { method: 'PUT' })
assert.equal(wrongMethod.status, 405)

// 6) POST 保存（分钟 → 秒由客户端换算，服务端收秒）
const posted = await call(getHandler, {
  method: 'POST',
  body: { config: { silentSeconds: 300, cooldownSeconds: 120, enabled: true } },
})
assert.equal(posted.status, 200)
const postedBody = JSON.parse(posted.body)
assert.equal(postedBody.config.silentSeconds, 300)
assert.equal(postedBody.config.silentMinutes, 5, '300 秒 = 5 分钟')

// 7) 再 GET 应看到新值
const again = JSON.parse((await call(getHandler)).body)
assert.equal(again.config.silentSeconds, 300)

// 8) 非法输入被明确拒绝，且不写入脏值
//    早先这里是 200 + 静默忽略，前端看到「保存成功」却什么也没改，
//    排查时极难定位；现在改为 400 并列出被拒的键。
const bad = await call(getHandler, {
  method: 'POST',
  body: { config: { silentSeconds: -5, cooldownSeconds: 'abc' } },
})
assert.equal(bad.status, 400, '非法值应明确报错，而不是谎报成功')
const badBody = JSON.parse(bad.body)
assert.equal(badBody.ok, false)
assert.deepEqual([...badBody.keys].sort(), ['cooldownSeconds', 'silentSeconds'])

// 旧值必须原样保留（没被脏值污染）
const afterBad = JSON.parse((await call(getHandler)).body)
assert.equal(afterBad.config.silentSeconds, 300, '负数被拒，保留旧值')
assert.equal(afterBad.config.cooldownSeconds, 120, '非数字被拒，保留旧值')

// 8.5) maxPerTurn: 0 是合法值（表示不限次数），必须能存回去
//      早期这里和其余数值一样要求 n > 0，导致界面把上限改成非 0 之后
//      再也改不回「不限」——保存直接被拒，且报错信息里看不出 0 是特殊的。
{
  const zero = await call(getHandler, { method: 'POST', body: { config: { maxPerTurn: 0 } } })
  assert.equal(zero.status, 200, 'maxPerTurn=0 应被接受（0 = 不限次数）')
  assert.equal(JSON.parse((await call(getHandler)).body).config.maxPerTurn, 0, '0 要真的存进去')

  const five = await call(getHandler, { method: 'POST', body: { config: { maxPerTurn: 5 } } })
  assert.equal(five.status, 200)
  assert.equal(JSON.parse((await call(getHandler)).body).config.maxPerTurn, 5)

  // 负数是真非法，仍然要拒
  const neg = await call(getHandler, { method: 'POST', body: { config: { maxPerTurn: -1 } } })
  assert.equal(neg.status, 400, '负数应被拒')
  assert.equal(JSON.parse((await call(getHandler)).body).config.maxPerTurn, 5, '被拒时保留旧值')
}

// 10) 超长 prompt 在写入侧被拒（审计 P1：prompt 无上限）
{
  const before = JSON.parse((await call(getHandler)).body).config.prompt
  const tooLong = 'z'.repeat(4097)
  const over = await call(getHandler, { method: 'POST', body: { config: { prompt: tooLong } } })
  assert.equal(over.status, 400, '超过上限的 prompt 应被拒')
  const payload = JSON.parse(over.body)
  assert.ok(Array.isArray(payload.keys) && payload.keys.includes('prompt'), '回执要写明 prompt 被拒')
  assert.equal(JSON.parse((await call(getHandler)).body).config.prompt, before, '被拒时保留旧值')

  // 恰好等于上限要放行（不能把边界一起拒了）
  const exact = 'q'.repeat(4096)
  const ok = await call(getHandler, { method: 'POST', body: { config: { prompt: exact } } })
  assert.equal(ok.status, 200, '等于上限的 prompt 应接受')
}

// 9) normalizeConfig 对覆盖层之后的值仍给出完整快照
const snapshot = normalizeConfig({ silentSeconds: 300, cooldownSeconds: 120 })
assert.equal(snapshot.enabled, true)
assert.equal(snapshot.silentSeconds, 300)
assert.equal(typeof snapshot.prompt, 'string')
// v0.11.0 起不再有常驻系统提示词段落，「旁白形态」三选一与模板也都删了
assert.equal(snapshot.sectionOrder, undefined, 'sectionOrder 属已删除的旧配置')
assert.equal(snapshot.style, undefined, 'style 三形态已随模板引擎删除')

// 10) status 路由
const statusHandler = ctx._handlers.get('/api/narrator/status')
assert.ok(statusHandler, '应注册 /api/narrator/status')
const st = JSON.parse((await call(statusHandler)).body)
assert.equal(st.ok, true)
assert.equal(st.name, 'narrator')

// 11) latest 路由：浮层通道的数据源
const latestHandler = ctx._handlers.get('/api/narrator/latest')
assert.ok(latestHandler, '应注册 /api/narrator/latest')
const beforeInject = JSON.parse((await call(latestHandler)).body)
assert.equal(beforeInject.ok, true)
assert.equal(beforeInject.latest, null, '还没播报过时应为 null')
assert.equal(beforeInject.enabled, true)

const deniedLatest = JSON.parse((await call(latestHandler, { remote: '10.0.0.9' })).body)
assert.equal(deniedLatest.ok, false, 'latest 也必须只允许 loopback')

// 12) latest 按会话隔离：指定别的会话时应为 null，不能串到当前会话
{
  const other = JSON.parse((await call(latestHandler, { url: '/api/narrator/latest?session=other-session' })).body)
  assert.equal(other.ok, true)
  assert.equal(other.latest, null, '别的会话没有旁白时必须是 null（浮层不该跨会话显示）')
  assert.equal(other.running, false, '没在跑的会话 running 应为 false')
}

// 13) 关闭状态只存在前端（切会话要能复位），路由不做持久化：确认 GET 幂等
{
  const a = JSON.parse((await call(latestHandler, { url: '/api/narrator/latest?session=ghost' })).body)
  const b = JSON.parse((await call(latestHandler, { url: '/api/narrator/latest?session=ghost' })).body)
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'latest 应是只读查询，多次调用结果一致')
}

// 14) 测试模式：POST 能存下三个键，并且只覆盖两个时长
{
  // 先存一份正常配置
  await call(getHandler, {
    method: 'POST',
    body: { config: { silentSeconds: 600, cooldownSeconds: 300, enabled: true } },
  })

  // 打开测试模式
  const on = await call(getHandler, {
    method: 'POST',
    body: { config: { testMode: true, testSilentSeconds: 5, testCooldownSeconds: 12 } },
  })
  assert.equal(on.status, 200)
  const onCfg = JSON.parse(on.body).config
  assert.equal(onCfg.testMode, true, 'testMode 应落库')
  assert.equal(onCfg.testSilentSeconds, 5)
  assert.equal(onCfg.testCooldownSeconds, 12)
  assert.equal(onCfg.silentSeconds, 5, '生效阈值被测试值顶替')
  assert.equal(onCfg.cooldownSeconds, 12, '生效冷却被测试值顶替')
  // 正常值必须原样留着，这是「不冲突」的核心
  assert.equal(onCfg.normalSilentSeconds, 600, '正常阈值不得被测试值改写')
  assert.equal(onCfg.normalCooldownSeconds, 300, '正常冷却不得被测试值改写')

  // 关掉测试模式：应立刻回到正常值
  const off = await call(getHandler, { method: 'POST', body: { config: { testMode: false } } })
  const offCfg = JSON.parse(off.body).config
  assert.equal(offCfg.testMode, false)
  assert.equal(offCfg.silentSeconds, 600, '关掉后回到正常阈值')
  assert.equal(offCfg.cooldownSeconds, 300, '关掉后回到正常冷却')
  // 测试值本身仍保留，下次打开还是上次填的
  assert.equal(offCfg.testSilentSeconds, 5, '测试值要留着，方便复用')
}

// 15) 测试模式秒数越界要夹到 1~60，而不是把键丢掉
{
  const r = await call(getHandler, {
    method: 'POST',
    body: { config: { testSilentSeconds: 0, testCooldownSeconds: 999 } },
  })
  const cfg = JSON.parse(r.body).config
  assert.equal(cfg.testSilentSeconds, 1, '0 秒应夹到 1')
  assert.equal(cfg.testCooldownSeconds, 60, '999 秒应夹到 60')
}

// 16) 测试模式不得污染磁盘上的正常配置
{
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(raw.silentSeconds, 600, '磁盘上 normal silentSeconds 应还是 600')
  assert.equal(raw.testMode, false, '磁盘上 testMode 应是最后一次写的 false')
}

// 17) 浮窗透明度：写入后能读回，越界值夹紧而不是丢弃
//     夹紧的理由：拖滑杆时可能瞬间传来 0；拒绝会让「保存」按钮报错，
//     而夹到下限的视觉效果和用户预期一致。
{
  const r1 = await call(getHandler, { method: 'POST', body: { config: { overlayOpacity: 0.6 } } })
  const cfg1 = JSON.parse(r1.body).config
  assert.equal(cfg1.overlayOpacity, 0.6, '透明度 0.6 应原样存下')

  const r2 = await call(getHandler, { method: 'POST', body: { config: { overlayOpacity: 0 } } })
  const cfg2 = JSON.parse(r2.body).config
  assert.equal(cfg2.overlayOpacity, 0.35, '0 应夹到下限 0.35，不能变成 0（那等于藏了浮窗）')

  const r3 = await call(getHandler, { method: 'POST', body: { config: { overlayOpacity: 5 } } })
  const cfg3 = JSON.parse(r3.body).config
  assert.equal(cfg3.overlayOpacity, 1, '超过 1 应夹到 1')

  // 刷新后仍在（真正落盘了，不只是内存里改了）
  const r4 = await call(getHandler, {})
  assert.equal(JSON.parse(r4.body).config.overlayOpacity, 1, '重启后仍应读回最后写入的值')

  // 下限上限也要下发给前端，界面才能画对量程
  const body = JSON.parse(r4.body)
  assert.equal(body.config.overlayOpacityMin, 0.35, '应下发透明度下限')
  assert.equal(body.config.overlayOpacityMax, 1, '应下发透明度上限')
}

await fs.rm(home, { recursive: true, force: true })
console.log('config-route probe: 全部通过')
