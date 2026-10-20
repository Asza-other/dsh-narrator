/**
 * 检查会话存档里所有 assistant/message 事件，找出会让投影崩溃的「半成品消息」。
 *
 * 判据来自宿主 dsh-token-meter 的投影代码：它对 assistant/message 直接读
 * `data.stream.length`（lastAssistantStreamChunk），缺 stream 就抛 TypeError，
 * 进而被包成 SESSION_QUERY_CORRUPT_SESSION，整个会话打不开。
 *
 * 用法: node test/audit-archive.mjs <session.v4.jsonl.zstd> [更多文件...]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 追加式 zstd：必须逐帧解压再拼，整文件解一次只拿得到第一帧。 */
function readFrames(file) {
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
  return { text, frames: starts.length }
}

for (const file of process.argv.slice(2)) {
  const { text, frames } = readFrames(file)
  const lines = text.split('\n').filter((l) => l.trim() !== '')

  let assistants = 0
  const problems = []

  for (const line of lines) {
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj?.type !== 'assistant/message') continue
    assistants += 1
    const d = obj?.data
    const missing = []
    if (d?.stream === undefined) missing.push('stream')
    else if (!Array.isArray(d.stream)) missing.push('stream(非数组)')
    if (d?.usage === undefined) missing.push('usage')
    if (missing.length > 0) {
      const blocks = Array.isArray(d?.message?.content) ? d.message.content.map((b) => b?.type).join(',') : '?'
      const isNarrator = Array.isArray(d?.message?.content)
        && d.message.content.some((b) => b?.type === 'reasoning' && b?.text === '（进度旁白注入）')
      problems.push({ seq: obj.seq, turn: d?.turn, step: d?.step, missing, blocks, isNarrator })
    }
  }

  console.log(`\n=== ${file}`)
  console.log(`帧数 ${frames} / 事件行 ${lines.length} / assistant/message ${assistants}`)
  if (problems.length === 0) {
    console.log('✅ 没有半成品消息，投影不会因此崩溃')
  } else {
    console.log(`❌ ${problems.length} 条半成品消息：`)
    for (const p of problems.slice(0, 20)) {
      console.log(`   seq=${p.seq} turn=${p.turn} step=${p.step} 缺=[${p.missing.join(',')}] 块=[${p.blocks}] narrator=${p.isNarrator}`)
    }
    if (problems.length > 20) console.log(`   … 另有 ${problems.length - 20} 条`)
  }
}
