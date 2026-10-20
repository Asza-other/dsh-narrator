import fs from 'node:fs'

const p = 'lib/client.js'
let s = fs.readFileSync(p, 'utf8')

// ChoiceSelect 起始行（含上面的 jsdoc 头）
const startMark = '    /**\n     * 自绘下拉：右侧显示当前值 + ▼，展开一列选项，当前项打勾。'
let start = s.indexOf(startMark)
if (start < 0) {
  // 退一步：从函数名往前找最近的 /** 开始
  const fnIdx = s.indexOf('    function ChoiceSelect(props) {')
  if (fnIdx < 0) throw new Error('找不到 ChoiceSelect')
  start = s.lastIndexOf('    /**', fnIdx)
  if (start < 0) throw new Error('找不到 ChoiceSelect 的 jsdoc 头')
}
const fnIdx = s.indexOf('    function ChoiceSelect(props) {', start)
if (fnIdx < 0) throw new Error('ChoiceSelect 签名不在 jsdoc 之后')

// 从函数体开头数大括号，找到配对的结束位置
let depth = 0
let i = s.indexOf('{', fnIdx)
const bodyStart = i
for (; i < s.length; i += 1) {
  const ch = s[i]
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0) {
      i += 1
      break
    }
  }
}
if (depth !== 0) throw new Error('ChoiceSelect 大括号没配平')
// 吃掉结尾换行
while (s[i] === '\n') i += 1

const removed = s.slice(start, i)
if (!removed.includes('function ChoiceSelect')) throw new Error('切出的片段不含 ChoiceSelect')

s = s.slice(0, start) + s.slice(i)
fs.writeFileSync(p, s)
console.log(`删除 ${removed.length} 字节（ChoiceSelect jsdoc + 函数体 ${bodyStart}..${i}）`)
