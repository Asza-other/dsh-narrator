/**
 * 演示：用假宿主驱动真实的 `apply()`，把 v0.11 的四幕行为演一遍。
 *
 * v0.11 的机制：插件只在静默超时后记一笔"该汇报了"，等下一个 step 边界
 * 在 `agent/pre-step` 注入一段提示词，**由模型自己**用正文说话；浮窗显示的
 * 就是模型刚说的那段原文。
 *
 * 跑法：
 *   node test/demo.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离开真实配置：不设这个，用户设置卡里的时间会覆盖演示参数
process.env.DSH_NARRATOR_CONFIG = join(mkdtempSync(join(tmpdir(), 'narrator-demo-')), 'config.json')

const { apply } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const line = (c = '─') => console.log(c.repeat(68))

function makeHost() {
  const hooks = new Map()
  return {
    on(name, listener) {
      const list = hooks.get(name) ?? []
      list.push(listener)
      hooks.set(name, list)
    },
    effect(fn) {
      fn()
    },
    logger: { info() {}, warn() {}, debug() {} },
    emit(name, agent, payload = {}) {
      for (const hook of hooks.get(name) ?? []) hook({ ...payload, agent })
    },
    /**
     * 按宿主原样派发：`session/event` 的签名是 `(session, event)` 两个参数，
     * 不能走上面那个「自动补 agent」的 `emit`。
     */
    dispatch(name, ...args) {
      for (const hook of hooks.get(name) ?? []) hook(...args)
    },
    async preStep(agent) {
      let out = null
      const next = async () => ({ kind: 'enter', messages: [] })
      for (const hook of hooks.get('agent/pre-step') ?? []) {
        const r = await hook({ agent, turn: 1, step: 1 }, next)
        if (r !== null && r !== undefined) out = r
      }
      return out ?? { kind: 'enter', messages: [] }
    },
  }
}

function makeAgent() {
  const events = []
  return {
    id: 'agent-demo',
    session: { id: 'sess-demo', events, append(t, d) { events.push({ type: t, data: d }) } },
  }
}

const config = {
  silentSeconds: 1,
  cooldownSeconds: 2,
  maxPerTurn: 0,
  includeSubagents: true,
  overlayEnabled: true,
}

const host = makeHost()
apply(host, config)
const agent = makeAgent()

// 从插件内部读浮窗快照（等价于 /api/narrator/latest 的 records）
const readLatest = () => {
  const s = host.narratorRecords ? host.narratorRecords() : []
  return s.length === 0 ? null : s[0]
}

console.log(`\n配置：连续 ${config.silentSeconds} 秒没有正文输出就安排一次汇报（演示值，真实默认 60 秒）\n`)

line()
console.log('【第 1 幕】模型进入长思考：只 stream reasoning，没有正文')
line()
host.emit('agent/assistant-stream', agent, {
  frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 },
})
for (let i = 1; i <= 4; i++) {
  host.emit('agent/assistant-stream', agent, {
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '让我想想…' } },
  })
  await sleep(350)
  const rec = readLatest()
  console.log(`  reasoning 输出中… 静默 ${(i * 0.35).toFixed(1)}s  浮窗=${rec === null ? '无' : '有'}`)
}
console.log('\n  说明：静默超时了，但插件**什么也没插进对话流**——它只是记了一笔"该汇报了"。')
console.log('  真正的发言要等下一个 step 边界，由模型拼进请求时一起送过去。\n')

line()
console.log('【第 2 幕】下一个 step 边界：注入提示词，模型自己开口')
line()
const decision = await host.preStep(agent)
console.log(`  pre-step 决策：${decision.kind}`)
console.log(`  注入消息数：${decision.messages.length}`)
const injected = decision.messages[0]
console.log(`  role：${injected?.role}`)
console.log(`  source.kind：${injected?.source?.kind}（form:notice → 客户端归为 context，界面上不显示）`)
console.log(`  提示词首行：${(injected?.content?.[0]?.text ?? '').split('\n')[0]}`)
console.log('\n  ⚠ 这一条不会打断当前回合：宿主把它当成额外的一条 user 消息，')
console.log('    下一个 step 照常继续，回合不会关闭。\n')

line()
console.log('【第 3 幕】模型照着提示词用正文说了一段 → 浮窗显示这段原文')
line()
host.emit('agent/assistant-stream', agent, {
  frame: { type: 'start', attemptId: 'a2', turn: 1, step: 2 },
})
const spoken = [
  '当前正在把 narrator 的触发机制改到 pre-step 注入。',
  '已经完成：删掉了 1300 行模板引擎，新增 onPreStep 钩子。',
  '接下来：跑一遍全量测试并同步到 profile。',
  '暂时没卡住。',
].join('')
for (const ch of spoken) {
  host.emit('agent/assistant-stream', agent, {
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: ch } },
  })
  await sleep(6)
}
host.emit('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'a2' } })
await sleep(80)

const rec = readLatest()
if (rec === null) {
  console.log('  ✘ 浮窗记录为空——正文截取没生效')
} else {
  console.log('  浮窗内容：')
  for (const l of String(rec.text).split('\n')) console.log(`    │ ${l}`)
  console.log('\n  这段文字是模型自己说的，不是插件拼的模板。')
  console.log('  停留到设定时长后自动消失，也可点右上角关掉。')
}
console.log()

line()
console.log('【第 4 幕】主窗口在等子代理：到期就亮卡，说明在等什么')
line()
{
  const h4 = makeHost()
  apply(h4, { ...config })
  const a4 = makeAgent()
  h4.emit('agent/assistant-stream', a4, {
    frame: { type: 'start', attemptId: 'd1', turn: 1, step: 1 },
  })
  // 模型发起子任务调用 → 记入 runningTools（真实链路里这是 assistant/message 落库）
  h4.dispatch('session/event', { id: 'sess-demo' }, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-call', id: 'call-1', name: 'subagent', arguments: '{}' }] },
    },
  })
  await sleep(1300)
  const waiting = h4.narratorRecords ? h4.narratorRecords()[0] : null
  console.log(`  浮窗记录：${waiting === undefined || waiting === null ? '无（不该）' : '有'}`)
  if (waiting !== undefined && waiting !== null) {
    console.log(`  pending：${String(waiting.pending)}（还没到 step 边界，只是"到点了该汇报"）`)
    console.log(`  在等什么：${String(waiting.waiting)}（工具：${String(waiting.waitingTool)}）`)
    console.log(`  已静默：${String(waiting.silentSeconds)} 秒`)
  }
  console.log('\n  这一步里子代理可能要跑好几分钟，宿主不会产生新的 assistant 流事件。')
  console.log('  等它结束再亮卡，用户早就以为卡死了——所以到期那一刻就先把卡亮出来。')
  console.log('  等模型真的开口，`commitCapture` 会用它的原话替换这张。\n')
}

line()
console.log('【第 5 幕】开关：关掉「让模型定期汇报」就彻底不动')
line()
{
  const h2 = makeHost()
  apply(h2, { ...config, enabled: false })
  const a2 = makeAgent()
  h2.emit('agent/assistant-stream', a2, { frame: { type: 'start', attemptId: 'b1', turn: 1, step: 1 } })
  await sleep(1300)
  const st = h2.narratorStatus ? h2.narratorStatus() : null
  const d = await h2.preStep(a2)
  console.log(`  enabled=false 时 pre-step 注入：${d.messages.length} 条（应为 0）`)
  console.log(`  统计 skipped：${JSON.stringify(st?.stats?.skipped ?? {})}`)
  console.log('  skipped 里能看到 disabled 在涨，说明是「主动不介入」而不是坏了。')
}
console.log()

line()
console.log('演示结束。真实环境里对应的证据：')
console.log('  GET /api/narrator/status   → stats.preSteps / injected / skipped')
console.log('  GET /api/narrator/latest   → 当前会话的浮窗快照（模型说的原文）')
console.log('  node test/check-status.mjs <port>  → 人话诊断')
line()
