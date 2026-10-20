import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { buildReport, buildProgressText, DEFAULT_REPORT_TEMPLATE_ZH } from '../lib/index.js'

/**
 * 自动找一份会话存档。
 *
 * 会话存档按「工作目录 + session id」两级目录存放，路径里带本机用户名，
 * 写死在脚本里换台机器就跑不了。这里直接扫 ~/.dsh/sessions 挑最新的那份。
 * 也可以手动传：node test/render-real-report.mjs <file> <turnA,turnB>
 */
function findLatestSession() {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return null
  let best = null
  for (const dir of readdirSync(root)) {
    const sub = join(root, dir)
    let names
    try {
      if (!statSync(sub).isDirectory()) continue
      names = readdirSync(sub)
    } catch {
      continue
    }
    for (const name of names) {
      const f = join(sub, name, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(f)
        if (st.isFile() && (best === null || st.mtimeMs > best.mtimeMs)) best = { file: f, mtimeMs: st.mtimeMs }
      } catch {
        // 没有这个文件，跳过
      }
    }
  }
  return best?.file ?? null
}

const file = process.argv[2] ?? findLatestSession()

if (file === null || file === undefined) {
  console.log('找不到会话存档。可以显式指定：node test/render-real-report.mjs <session.v4.jsonl.zstd>')
  process.exit(1)
}

if (!existsSync(file)) {
  console.log('找不到会话存档：', file)
  process.exit(1)
}

const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
    starts.push(i)
  }
}
const chunks = []
for (let i = 0; i < starts.length; i++) {
  const lo = starts[i]
  const hi = i + 1 < starts.length ? starts[i + 1] : buf.length
  try {
    chunks.push(zlib.zstdDecompressSync(buf.subarray(lo, hi)))
  } catch {
    /* 跳过损坏帧 */
  }
}
const text = Buffer.concat(chunks).toString('utf8')
const events = []
for (const line of text.split('\n')) {
  const s = line.trim()
  if (s === '') continue
  try {
    events.push(JSON.parse(s))
  } catch {
    /* 忽略半行 */
  }
}

let maxTurn = 0
for (const e of events) {
  const t = e?.data?.turn
  if (Number.isFinite(t) && t > maxTurn) maxTurn = t
}
console.log('帧数:', starts.length, '事件数:', events.length, '最大 turn:', maxTurn)

// 可选：`node test/render-real-report.mjs <file> <turnA,turnB,...>`
// 不传就渲染 material 最多的那一轮（演示用，比空壳的最新轮有说服力）。
let targets = []
if (typeof process.argv[3] === 'string' && process.argv[3].trim() !== '') {
  targets = process.argv[3]
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
} else {
  const score = new Map()
  for (const e of events) {
    const t = e?.data?.turn
    if (!Number.isFinite(t)) continue
    score.set(t, (score.get(t) ?? 0) + 1)
  }
  targets = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 1)
    .map(([t]) => t)
}

for (const turn of targets) {
  const report = buildReport(events, turn)
  console.log(`\n======== turn ${turn} ========`)
  console.log('分节:', report.sections.map((s) => `${s.title}(${s.items.length})`).join(' / '))
  const rendered = buildProgressText({ silentSeconds: 12, report: report.markdown }, DEFAULT_REPORT_TEMPLATE_ZH)
  console.log('\n──────── 渲染结果 ────────')
  console.log(rendered)
}
