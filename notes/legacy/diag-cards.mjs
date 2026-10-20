/**
 * 诊断：旁白卡插入的时机分布。
 *
 * 关心三件事：
 *   1. 每条旁白卡落在哪个 turn/step —— 判断是不是每一步都插
 *   2. 旁白正文里的「已 N 秒」是多少 —— 判断 silentMs 算得对不对
 *   3. 相邻卡之间的时间间隔 —— 判断冷却有没有生效
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
}

let text = ''
for (let k = 0; k < starts.length; k++) {
  const hi = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    text += zstdDecompressSync(buf.subarray(lo(k, starts), hi)).toString('utf8')
  } catch {
    /* 坏帧跳过 */
  }
}
function lo(k, arr) {
  return arr[k]
}

const lines = text.split('\n').filter((l) => l.trim() !== '')
const MARKER = '（进度旁白注入）'

const cards = []
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
  if (!blocks.some((b) => b?.type === 'reasoning' && b?.text === MARKER)) continue
  const body = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').replace(/\s+/g, ' ').slice(0, 120)
  cards.push({ seq: obj.seq, turn: obj.data?.turn, step: obj.data?.step, body })
}

console.log(`共 ${cards.length} 条旁白卡\n`)
for (const [i, c] of cards.entries()) {
  console.log(`#${i + 1} seq=${c.seq} turn=${c.turn} step=${c.step}`)
  console.log(`    ${c.body}`)
}

// 按 turn 聚合，看分布
const byTurn = new Map()
for (const c of cards) {
  const k = `${c.turn}`
  byTurn.set(k, (byTurn.get(k) ?? 0) + 1)
}
console.log('\n按 turn 分布:', JSON.stringify([...byTurn]))
const byStep = new Map()
for (const c of cards) byStep.set(`${c.turn}/${c.step}`, (byStep.get(`${c.turn}/${c.step}`) ?? 0) + 1)
console.log('按 turn/step 分布:', JSON.stringify([...byStep]))
