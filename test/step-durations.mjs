/**
 * 统计每个 step 的「纯思考空窗时长」——即最后一个流式分片到 step 结束的间隔，
 * 用来判断 narrator 的 silentSeconds 阈值是否真的有可能被触发。
 *
 * 用法: node test/step-durations.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function readAll(file) {
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
      /* 坏帧跳过 */
    }
  }
  return text
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
}

const events = readAll(process.argv[2])

// 按 (turn, step) 聚合：记录 step 起止时间、首个/末个流式分片时间
const steps = new Map()
const key = (t, s) => `${t}/${s}`

for (const e of events) {
  if (e?.type === 'step/start') {
    const k = key(e.data.turn, e.data.step)
    steps.set(k, { turn: e.data.turn, step: e.data.step, startedAt: e.time, lastChunkAt: null, endedAt: null })
  } else if (e?.type === 'assistant/message' || e?.type === 'assistant/attempt') {
    const k = key(e.data.turn, e.data.step)
    const rec = steps.get(k)
    if (rec) rec.lastChunkAt = e.time
  } else if (e?.type === 'step/end') {
    const k = key(e.data.turn, e.data.step)
    const rec = steps.get(k)
    if (rec) rec.endedAt = e.time
  }
}

const rows = []
for (const rec of steps.values()) {
  if (rec.startedAt == null) continue
  const endRef = rec.endedAt ?? rec.lastChunkAt
  const totalMs = endRef == null ? null : endRef - rec.startedAt
  const tailMs = rec.lastChunkAt != null && rec.endedAt != null ? rec.endedAt - rec.lastChunkAt : null
  rows.push({ ...rec, totalMs, tailMs })
}

rows.sort((a, b) => (b.totalMs ?? -1) - (a.totalMs ?? -1))

console.log(`\n=== ${process.argv[2]}`)
console.log(`step 总数: ${rows.length}\n`)
console.log('turn/step  总时长    末分片→step结束   仍开着')
for (const r of rows.slice(0, 20)) {
  const total = r.totalMs == null ? '   ?  ' : `${(r.totalMs / 1000).toFixed(1)}s`.padStart(8)
  const tail = r.tailMs == null ? '     ?  ' : `${(r.tailMs / 1000).toFixed(1)}s`.padStart(10)
  console.log(`${r.turn}/${r.step}`.padEnd(10), total, tail.padStart(14), r.endedAt == null ? '  是' : '')
}

const over = (sec) => rows.filter((r) => (r.totalMs ?? 0) >= sec * 1000).length
for (const sec of [10, 25, 57]) {
  console.log(`\n总时长 ≥ ${sec} 秒的 step: ${over(sec)} 个`)
}
