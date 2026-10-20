/**
 * 探针：用真实的 cordis 语义模拟宿主，验证 dsh-narrator v0.11 的端到端行为。
 *
 * v0.11 的机制和以前完全不同：
 *   - 以前：插件自己拼一段模板文案，`session.append('assistant/message')` 硬插进对话流。
 *   - 现在：插件只在状态里记一个"该汇报了"，等下一个 step 边界在 `agent/pre-step`
 *     注入一段提示词，由**模型自己**用正文说明进展。
 *
 * 关键点在于模拟 `agentEvents` 的 fused 行为：
 *   const fused = (payload) => ({ ...payload, agent })
 * 宿主派发 agent/assistant-stream 时只给 { frame }，由框架补 agent。
 * 这里如实复刻，确认插件在这个契约下工作。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import ../lib/index.js 之前设置：插件会读 ~/.dsh/narrator/config.json
// 这份真实用户覆盖层。不隔离的话，用户在设置卡里调过的时间会污染探针
// （曾因此让 12 项假失败——阈值被抬到 2 秒，20ms 的等待永远等不到）。
process.env.DSH_NARRATOR_CONFIG = join(mkdtempSync(join(tmpdir(), 'narrator-probe-')), 'config.json')

const {
  apply,
  DEFAULT_PROMPT_ZH,
  INJECT_SOURCE_NOTICE,
  INJECT_SOURCE_VISIBLE,
  LINGER_SECONDS_MIN,
  LINGER_SECONDS_MAX,
} = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}`)
  } else {
    fail++
    console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

/** 复刻宿主的 agentEvents：fused(payload) 自动补 agent，dispatch 以 carrier 为 this。 */
function makeHost() {
  const hooks = new Map()
  return {
    on(name, listener) {
      const list = hooks.get(name) ?? []
      list.push({ listener, global: true })
      hooks.set(name, list)
    },
    effect(fn) {
      fn()
    },
    logger: { info() {}, warn() {}, debug() {} },
    /**
     * 宿主真实派发方式：agentEvents(agent).emit(name, { frame })
     * → dispatch 时把 agent fused 进 payload。
     */
    emitAgentEvent(name, agent, payload) {
      const fused = { ...payload, agent }
      for (const hook of hooks.get(name) ?? []) {
        try {
          hook.listener(fused)
        } catch (e) {
          console.log('listener threw:', e)
        }
      }
    },
    /** pre-step 是 waterfall，需要 await next()。 */
    async preStep(agent, position = {}) {
      const payload = { ...position, agent }
      const next = async () => ({ kind: 'enter', messages: [] })
      let out = null
      for (const hook of hooks.get('agent/pre-step') ?? []) {
        try {
          const r = await hook.listener(payload, next)
          if (r !== undefined && r !== null) out = r
        } catch (e) {
          console.log('pre-step listener threw:', e)
        }
      }
      return out ?? { kind: 'enter', messages: [] }
    },
  }
}

function makeAgent() {
  const events = []
  const appends = []
  return {
    id: 'agent-x',
    session: {
      id: 'sess-x',
      events,
      append(type, data, meta) {
        appends.push({ type, data, meta })
        events.push({ type, data })
      },
    },
    appends,
  }
}

console.log('\n=== 1. 系统提示词 ===')
{
  const host = makeHost()
  apply(host, {})
  // v0.11 不再常驻注入 systemPrompt.section（那是给「每次工具调用前先说话」用的，
  // 现在的机制是 pre-step 注入提示词，不需要额外占用系统提示词）。
  check('不再注册 systemPrompt.section', host.sections === undefined || host.sections.length === 0)
}

console.log('\n=== 2. 静默超时只记账，不直接插话 ===')
{
  const host = makeHost()
  apply(host, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 0 })
  const agent = makeAgent()

  host.emitAgentEvent('agent/assistant-stream', agent, {
    frame: { type: 'start', attemptId: 'att-1', turn: 2, step: 3 },
  })
  // 只吐 reasoning，一个字正文都没有
  for (let i = 0; i < 5; i++) {
    host.emitAgentEvent('agent/assistant-stream', agent, {
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '让我想想…' } },
    })
    await sleep(15)
  }
  await sleep(120)

  check('静默超时后没有往对话流插任何东西', agent.appends.length === 0, `实际 ${agent.appends.length}`)
  host.emitAgentEvent('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'att-1' } })
}

console.log('\n=== 3. 下一个 step 边界注入提示词 ===')
{
  const host = makeHost()
  apply(host, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 0 })
  const agent = makeAgent()

  host.emitAgentEvent('agent/assistant-stream', agent, {
    frame: { type: 'start', attemptId: 'att-2', turn: 3, step: 1 },
  })
  await sleep(120)

  const decision = await host.preStep(agent, { turn: 3, step: 2 })
  check('pre-step 决策仍是 enter', decision?.kind === 'enter', JSON.stringify(decision?.kind))
  check('注入了一条消息', decision.messages.length === 1, `实际 ${decision.messages.length}`)
  const msg = decision.messages[0]
  check('注入的是 user 消息', msg?.role === 'user', String(msg?.role))
  const text = msg?.content?.[0]?.text ?? ''
  check('注入内容是提示词', text === DEFAULT_PROMPT_ZH, JSON.stringify(text.slice(0, 60)))
  check(
    '默认 source 是 notice（客户端隐藏，模型照读）',
    msg?.source?.kind === INJECT_SOURCE_NOTICE.kind && msg?.source?.form === 'notice',
    JSON.stringify(msg?.source),
  )
  check('宿主原有消息没被顶掉', Array.isArray(decision.messages) && decision.kind === 'enter')

  // 同一笔 due 只能取走一次：紧接着再来一个 pre-step 不该重复注入
  const second = await host.preStep(agent, { turn: 3, step: 3 })
  check('同一次到期只注入一次', second.messages.length === 0, `实际 ${second.messages.length}`)

  host.emitAgentEvent('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'att-2' } })
}

console.log('\n=== 4. 没有静默超时就不注入 ===')
{
  const host = makeHost()
  apply(host, { silentSeconds: 5, cooldownSeconds: 0, maxPerTurn: 0 })
  const agent = makeAgent()

  host.emitAgentEvent('agent/assistant-stream', agent, {
    frame: { type: 'start', attemptId: 'att-3', turn: 4, step: 1 },
  })
  for (let i = 0; i < 4; i++) {
    host.emitAgentEvent('agent/assistant-stream', agent, {
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: '正在读取配置…' } },
    })
    await sleep(20)
  }
  const decision = await host.preStep(agent, { turn: 4, step: 2 })
  check('持续有正文时 pre-step 不注入', decision.messages.length === 0, `实际 ${decision.messages.length}`)
  host.emitAgentEvent('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'att-3' } })
}

console.log('\n=== 5. 总开关关闭时完全不介入 ===')
{
  const host = makeHost()
  apply(host, { enabled: false, silentSeconds: 0.02, cooldownSeconds: 0 })
  const agent = makeAgent()
  host.emitAgentEvent('agent/assistant-stream', agent, {
    frame: { type: 'start', attemptId: 'att-4', turn: 5, step: 1 },
  })
  await sleep(120)
  const decision = await host.preStep(agent, { turn: 5, step: 2 })
  check('enabled=false 时不注入', decision.messages.length === 0, `实际 ${decision.messages.length}`)
  host.emitAgentEvent('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'att-4' } })
}

console.log('\n=== 6. 单回合次数上限 ===')
{
  const host = makeHost()
  apply(host, { silentSeconds: 0.02, cooldownSeconds: 0, maxPerTurn: 2 })
  const agent = makeAgent()
  let injected = 0
  for (const step of [1, 2, 3]) {
    host.emitAgentEvent('agent/assistant-stream', agent, {
      frame: { type: 'start', attemptId: `att-5-${step}`, turn: 6, step },
    })
    await sleep(90)
    const d = await host.preStep(agent, { turn: 6, step: step + 1 })
    injected += d.messages.length
  }
  check('最多 2 次', injected === 2, `实际 ${injected}`)
  host.emitAgentEvent('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'att-5-3' } })
}

console.log('\n=== 7. 冷却期 ===')
{
  const host = makeHost()
  apply(host, { silentSeconds: 0.02, cooldownSeconds: 30, maxPerTurn: 0 })
  const agent = makeAgent()
  host.emitAgentEvent('agent/assistant-stream', agent, {
    frame: { type: 'start', attemptId: 'att-6', turn: 7, step: 1 },
  })
  await sleep(90)
  const first = await host.preStep(agent, { turn: 7, step: 2 })
  await sleep(120)
  const second = await host.preStep(agent, { turn: 7, step: 3 })
  check('冷却期内只注入 1 次', first.messages.length + second.messages.length === 1, `${first.messages.length}+${second.messages.length}`)
  host.emitAgentEvent('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'att-6' } })
}

console.log('\n=== 8. 子代理 ===')
{
  const host = makeHost()
  apply(host, { silentSeconds: 0.02, cooldownSeconds: 0, maxPerTurn: 0, includeSubagents: false })
  const agent = makeAgent()
  agent.parentSessionId = 'parent-z'
  host.emitAgentEvent('agent/assistant-stream', agent, {
    frame: { type: 'start', attemptId: 'att-7', turn: 8, step: 1 },
  })
  await sleep(90)
  const d = await host.preStep(agent, { turn: 8, step: 2 })
  check('includeSubagents=false 时子代理不注入', d.messages.length === 0, `实际 ${d.messages.length}`)
  host.emitAgentEvent('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'att-7' } })
}

console.log('\n=== 9. showInjected 换成可见 source ===')
{
  const host = makeHost()
  apply(host, { silentSeconds: 0.02, cooldownSeconds: 0, maxPerTurn: 0, showInjected: true })
  const agent = makeAgent()
  host.emitAgentEvent('agent/assistant-stream', agent, {
    frame: { type: 'start', attemptId: 'att-8', turn: 9, step: 1 },
  })
  await sleep(90)
  const d = await host.preStep(agent, { turn: 9, step: 2 })
  const msg = d.messages[0]
  check('source.kind 变成 user（客户端显示原文）', msg?.source?.kind === INJECT_SOURCE_VISIBLE.kind, JSON.stringify(msg?.source))
  host.emitAgentEvent('agent/assistant-stream', agent, { frame: { type: 'end', attemptId: 'att-8' } })
}

console.log('\n=== 10. 各种坏输入不崩 ===')
{
  const host = makeHost()
  apply(host, { silentSeconds: 0.02 })
  let threw = false
  try {
    host.emitAgentEvent('agent/assistant-stream', {}, {
      frame: { type: 'start', attemptId: 'a', turn: 1, step: 1 },
    })
    host.emitAgentEvent('agent/assistant-stream', { session: {} }, { frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'x' } } })
    host.emitAgentEvent('agent/assistant-stream', makeAgent(), { frame: null })
    host.emitAgentEvent('agent/assistant-stream', makeAgent(), {})
    host.emitAgentEvent('agent/disposed', {}, {})
    // pre-step 的坏 payload
    await host.preStep(null, {})
    await host.preStep(makeAgent(), {})
  } catch (e) {
    threw = true
    console.log('   threw:', e.message)
  }
  check('坏输入不抛异常', !threw)
}

console.log('\n=== 11. 默认提示词 ===')
{
  // v0.11 起不再有模板引擎：改成注入一段提示词让模型自己说，所以这里
  // 校验的是提示词本体的四个要素，而不是占位符替换。
  const text = DEFAULT_PROMPT_ZH
  check('提示词要求说明正在做什么', /正在做什么|在做什么/.test(text))
  check('提示词要求说明已完成什么', /已经完成|已完成/.test(text))
  check('提示词要求说明接下来做什么', /接下来/.test(text))
  check('提示词问有没有卡住', /卡住|阻碍|不确定/.test(text))
  check('提示词不残留模板占位符', !/\{(silent|step|toolCalls|lastToolPart|report)\}/.test(text))
  check('提示词要求用正文输出', /正文/.test(text))
  check('提示词要求说完继续', /继续/.test(text))
}

console.log('\n=== 12. 停留时长的量程 ===')
{
  check('停留下限是 5 秒', LINGER_SECONDS_MIN === 5, String(LINGER_SECONDS_MIN))
  check('停留上限是 600 秒', LINGER_SECONDS_MAX === 600, String(LINGER_SECONDS_MAX))
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====\n`)
process.exit(fail === 0 ? 0 : 1)
