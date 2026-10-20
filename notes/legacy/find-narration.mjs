/**
 * 精确查找 narrator 插入的旁白卡。
 *
 * 判据必须结构化，不能搜文本：模型自己在对话里提过「进度旁白注入」这几个字，
 * 纯文本搜索会误报。真正的旁白卡是：
 *   assistant/message，content 里有一个 type==='reasoning' 且 text 恰为
 *   '（进度旁白注入）' 的块。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('用法: node find-narration.mjs <session.v4.jsonl.zstd>')
  process.exit(1)
}

const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
}

let text = ''
let frames = 0
for (let k = 0; k < starts.length; k++) {
  const lo = starts[k]
  const hi = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    text += zstdDecompressSync(buf.subarray(lo, hi)).toString('utf8')
    frames++
  } catch {
    /* 跳过坏帧 */
  }
}

const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`解压 ${frames} 帧，${lines.length} 行事件`)

const MARKER = '（进度旁白注入）'
let hits = 0
for (const line of lines) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    continue
  }
  if (obj?.type !== 'assistant/message') continue
  const blocks = obj?.data?.message?.content
  if (!Array.isArray(blocks)) continue
  const reasoning = blocks.find((b) => b?.type === 'reasoning' && b?.text === MARKER)
  if (reasoning === undefined) continue

  hits++
  const body = blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
  console.log(`\n===== 旁白卡 #${hits} =====`)
  console.log('turn/step :', obj.data?.turn, '/', obj.data?.step)
  console.log('块构成    :', blocks.map((b) => b.type).join(', '))
  console.log('正文      :\n' + body)
}

console.log(`\n结论：该会话中共有 ${hits} 条插件插入的旁白卡`)
