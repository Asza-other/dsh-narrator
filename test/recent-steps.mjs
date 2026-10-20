/**
 * 只看最近 N 个 step 的时长分布，判断 silentSeconds 阈值是否可能被触发。
 *
 * 用法: node test/recent-steps.mjs <session.v4.jsonl.zstd> [N]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const file = process.argv[2]
const want = Number(process.argv[3] ?? 15)

const buf = readFileSync(file)
const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
}
let text = ''
for (let k = 0; k < starts.length; k++) {
  const hi = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    text += zstdDecompressSync(buf.subarray(starts[k], hi)).toString('utf8')
  } catch {
    /* 坏帧 */
  }
}

const events = text
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

// 用 step/start 与 step/end 配对
const open = new Map()
const done = []
for (const e of events) {
  const t = e?.data?.turn
  const s = e?.data?.step
  if (t === undefined || s === undefined) continue
  const k = `${t}/${s}`
  if (e.type === 'step/start') {
    open.set(k, e.time)
  } else if (e.type === 'step/end' && open.has(k)) {
    done.push({ turn: t, step: s, ms: e.time - open.get(k) })
    open.delete(k)
  }
}

const recent = done.slice(-want)
console.log(`\n最近 ${recent.length} 个 step 的时长（阈值 57s）:`)
for (const r of recent) {
  const sec = r.ms / 1000
  const bar = '█'.repeat(Math.min(40, Math.round(sec)))
  const flag = sec >= 57 ? '  ← 超阈值' : ''
  console.log(`${String(r.turn).padStart(2)}/${String(r.step).padEnd(3)} ${sec.toFixed(1).padStart(6)}s ${bar}${flag}`)
}

const over57 = recent.filter((r) => r.ms >= 57000).length
const max = recent.reduce((a, r) => Math.max(a, r.ms), 0) / 1000
const avg = recent.reduce((a, r) => a + r.ms, 0) / recent.length / 1000
console.log(`\n最长 ${max.toFixed(1)}s / 平均 ${avg.toFixed(1)}s / 超过 57s 的有 ${over57} 个`)
if (over57 === 0) {
  console.log(`\n结论：最近 ${recent.length} 个 step 都没有超过 57 秒，`)
  console.log('      所以 ticks: 0 是正常现象，不是 bug。')
  console.log(`      想要触发，阈值需要低于 ${max.toFixed(0)} 秒。`)
}
