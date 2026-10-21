import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import ../lib/index.js 之前设置，否则用户真实配置会污染用例。
process.env.DSH_NARRATOR_CONFIG = join(mkdtempSync(join(tmpdir(), 'narrator-apply-')), 'config.json')

const { apply, DEFAULT_PROMPT_ZH } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 造一个最小的假 Cordis ctx：记录事件监听器 / effect / 路由，
 * 并提供手动触发事件的能力。
 */
function makeCtx() {
  const handlers = new Map()
  const routes = new Map()
  const effects = []
  const warnings = []

  const wireRoutes = (cb) => {
    const disposers = []
    const child = {
      webServer: {
        register(route) {
          routes.set(route.path, route.handler)
          return () => {}
        },
      },
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => {}
      },
    }
    cb(child)
  }

  return {
    handlers,
    warnings,
    routes,
    /** apply 会把 snapshot 挂成 ctx.narratorStatus */
    status() {
      return typeof this.narratorStatus === 'function' ? this.narratorStatus() : null
    },
    /** 浮层记录：直接读插件内部表，只断言注入次数是看不到浮层通道的 */
    records() {
      return typeof this.narratorRecords === 'function' ? this.narratorRecords() : []
    },
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    logger: {
      info() {},
      warn(...args) {
        warnings.push(args)
      },
      debug() {},
    },
    /** 同步触发所有监听器（返回它们的返回值）。 */
    async emit(name, ...args) {
      const out = []
      for (const fn of handlers.get(name) ?? []) {
        out.push(await fn(...args))
      }
      return out
    },
    /** 触发一次 pre-step：模拟宿主把注册的监听器串成 waterfall。 */
    async preStep(payload) {
      const list = handlers.get('agent/pre-step') ?? []
      const fallback = { kind: 'enter', messages: [] }
      // 从后往前包：最后一个监听器的 next 是宿主 fallback
      let next = async () => fallback
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const fn = list[i]
        const inner = next
        next = () => fn(payload, inner)
      }
      return next()
    },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('webServer')) wireRoutes(cb)
      return () => {}
    },
    async dispose() {
      for (const d of effects) await d()
    },
  }
}

/** 造一个假 agent。 */
function makeAgent(sessionId = 'session-1') {
  const steers = []
  return {
    id: `agent-${sessionId}`,
    session: { id: sessionId, events: [] },
    steer(message) {
      steers.push(message)
    },
    steers,
  }
}

/** 喂一帧 start 让插件建立静默计时状态。 */
function fireStart(ctx, agent, { turn = 1, step = 1 } = {}) {
  void ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'start', attemptId: 'a1', turn, step },
  })
}

/** 喂一帧正文。 */
function fireText(ctx, agent, text = '正在做') {
  void ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text } },
  })
}

/** 喂一帧工具调用。 */
function fireToolCall(ctx, agent) {
  void ctx.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'chunk',
      chunk: { type: 'tool-call-delta', index: 0, id: 'c0', argumentsDelta: '{}' },
    },
  })
}

/** 喂一帧 end。 */
function fireEnd(ctx, agent) {
  void ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'a1', index: 0 } })
}

// ---------------------------------------------------------------------------

test('apply 不再注入 systemPrompt.section（v0.11.0 起改为 pre-step 注入）', () => {
  const ctx = makeCtx()
  apply(ctx, {})
  // 旧版本靠常驻系统提示词约束「每次调工具前先说一句」，属于治标：
  // 模型可以不理。新版本改成「静默超时 → 下一 step 注入一条要求汇报的
  // 用户消息」，模型必须应答。因此不该再往系统提示词里加段落。
  const sections = ctx.handlers.get('systemPrompt/section') ?? []
  assert.equal(sections.length, 0)
})

test('注册了 assistant-stream 与 pre-step 两个钩子', () => {
  const ctx = makeCtx()
  apply(ctx, {})
  assert.ok(ctx.handlers.has('agent/assistant-stream'), '必须监听流事件计时')
  assert.ok(ctx.handlers.has('agent/pre-step'), '必须挂 pre-step 才能注入')
})

test('静默超阈值后，在下一个 step 边界注入一条要求汇报的用户消息', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  fireText(ctx, agent, '开始干活')
  // 之后只发 reasoning 不发正文：用户什么也看不到
  await sleep(120)

  const decision = await ctx.preStep({ agent, turn: 1, step: 2, signal: undefined })
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1, '应当注入恰好一条消息')
  const injected = decision.messages[0]
  assert.equal(injected.role, 'user')
  assert.ok(Array.isArray(injected.content))
  const textBlock = injected.content.find((b) => b.type === 'text')
  assert.ok(textBlock, '注入的消息必须带文本块')
  assert.equal(textBlock.text, DEFAULT_PROMPT_ZH, '没有自定义提示词时用内置默认')

  await ctx.dispose()
})

test('注入的消息默认是不可见的（form=notice）', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  const injected = decision.messages[0]
  // form:'notice' 让宿主把它投影成 context 节点，界面看不见但模型读得到
  assert.equal(injected.source?.form, 'notice')

  await ctx.dispose()
})

test('打开 showInjected 后注入可见（kind=user）', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, showInjected: true })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages[0].source?.kind, 'user')

  await ctx.dispose()
})

test('持续输出正文时不会安排汇报', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.15, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  // 每 25ms 喂一次正文，间隔远小于阈值
  for (let i = 0; i < 8; i += 1) {
    fireText(ctx, agent, '正在分析…')
    await sleep(25)
    const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
    assert.equal(decision.messages.length, 0, '有正文时不该插话')
  }

  await ctx.dispose()
})

test('工具调用不算"有文字输出"：连续调工具仍然会汇报', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  // 只喂工具调用、不喂正文：这恰恰是最该汇报的场景。
  // 若工具调用重置了静默计时，长任务里将永远等不到汇报。
  for (let i = 0; i < 6; i += 1) {
    fireToolCall(ctx, agent)
    await sleep(30)
  }

  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages.length, 1, '密集调工具期间必须能汇报')

  await ctx.dispose()
})

test('还没到阈值时 pre-step 不注入', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 30, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages.length, 0)
  assert.ok(ctx.status().stats.skipped.notDue > 0, '没到点应记 notDue')

  await ctx.dispose()
})

test('总开关关掉后既不注入也不计步', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { enabled: false, silentSeconds: 0.05 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages.length, 0)
  assert.ok(ctx.status().stats.skipped.disabled > 0, '关掉后应记 disabled，便于排查')

  await ctx.dispose()
})

test('冷却期内不重复注入', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 60 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  const first = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(first.messages.length, 1)

  // 再等一轮静默：冷却 60 秒还没过，不该再注入
  await sleep(120)
  const second = await ctx.preStep({ agent, turn: 1, step: 3 })
  assert.equal(second.messages.length, 0)
  assert.ok(ctx.status().stats.skipped.cooldown > 0)

  await ctx.dispose()
})

test('maxPerTurn 限次（0 表示不限）', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 1 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  const first = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(first.messages.length, 1)

  await sleep(120)
  const second = await ctx.preStep({ agent, turn: 1, step: 3 })
  assert.equal(second.messages.length, 0, 'maxPerTurn=1 时同回合只报一次')

  await ctx.dispose()
})

test('决策 kind 不是 enter 时绝不往里塞消息', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)

  // 宿主已经决定不进入这一步（比如被中止），此时注入会污染那个决策
  const handlers = ctx.handlers.get('agent/pre-step')
  const reject = { kind: 'reject' }
  const out = await handlers[0]({ agent, turn: 1, step: 2 }, async () => reject)
  assert.equal(out, reject)
  assert.equal(out.messages, undefined, '不得改动 reject 决策')

  await ctx.dispose()
})

test('注入成功后，模型说的第一段正文进入浮层记录', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, overlayEnabled: true })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages.length, 1)

  // 模型开始汇报
  fireText(ctx, agent, '我在改 ')
  fireText(ctx, agent, 'index.js，')
  fireText(ctx, agent, '已经修好了三个 bug。')
  // 说完就开始调工具 → 收口
  fireToolCall(ctx, agent)

  const records = ctx.records()
  assert.equal(records.length, 1, '应记下一条浮层记录')
  assert.equal(records[0].text, '我在改 index.js，已经修好了三个 bug。')
  // 注入发生在 pre-step 的 step=2 边界上，所以汇报属于第 2 步。
  // （曾用上一个 step 的 start 帧记成 1，浮层页脚永远比真实的小 1。）
  assert.equal(records[0].step, 2)

  await ctx.dispose()
})

test('浮层记录按会话隔离', async () => {
  const ctx = makeCtx()
  const a = makeAgent('session-a')
  const b = makeAgent('session-b')
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0 })

  for (const [agent, sid] of [
    [a, 'session-a'],
    [b, 'session-b'],
  ]) {
    fireStart(ctx, agent, { turn: 1, step: 1 })
    await sleep(120)
    await ctx.preStep({ agent, turn: 1, step: 2 })
    fireText(ctx, agent, `${sid} 的汇报`)
    fireToolCall(ctx, agent)
  }

  const records = ctx.records()
  assert.equal(records.length, 2, '两个会话各一条')
  const bySession = new Map(records.map((r) => [r.session, r]))
  assert.equal(bySession.get('session-a').text, 'session-a 的汇报')
  assert.equal(bySession.get('session-b').text, 'session-b 的汇报')

  await ctx.dispose()
})

test('浮层通道关掉时仍注入，但不产生浮层记录', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, overlayEnabled: false })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages.length, 1, '关浮层不影响注入')

  fireText(ctx, agent, '这段不该进浮层')
  fireToolCall(ctx, agent)
  assert.equal(ctx.records().length, 0)

  await ctx.dispose()
})

test('子代理默认不汇报，includeSubagents=true 时才参与', async () => {
  // 默认关：子代理的会话在界面上根本看不到，往里注入汇报纯属浪费一次
  // 模型调用。主窗口在等子代理时该不该出旁白是另一回事——那时主 agent
  // 自己的静默计时照常在跑。
  const off = makeCtx()
  const subOff = makeAgent('sub-1')
  subOff.parent = {}
  apply(off, { silentSeconds: 0.05, cooldownSeconds: 0 })
  fireStart(off, subOff, { turn: 1, step: 1 })
  await sleep(120)
  const none = await off.preStep({ agent: subOff, turn: 1, step: 2 })
  assert.equal(none.messages.length, 0, '默认子代理不参与')
  assert.ok(off.status().stats.skipped.subagent > 0)
  await off.dispose()

  const on = makeCtx()
  const subOn = makeAgent('sub-2')
  subOn.parent = {}
  apply(on, { silentSeconds: 0.05, cooldownSeconds: 0, includeSubagents: true })
  fireStart(on, subOn, { turn: 1, step: 1 })
  await sleep(120)
  const got = await on.preStep({ agent: subOn, turn: 1, step: 2 })
  assert.equal(got.messages.length, 1, '显式打开后子代理也汇报')
  await on.dispose()
})

test('新回合重新计时：用户刚发消息就是最新可见内容', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.3, cooldownSeconds: 0 })

  // 第一回合静默很久
  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(400)

  // 用户发了新消息 → turn/end
  await ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })

  // 第二回合开始：静默应从此刻重新算
  fireStart(ctx, agent, { turn: 2, step: 1 })
  const decision = await ctx.preStep({ agent, turn: 2, step: 2 })
  assert.equal(decision.messages.length, 0, '新回合刚开始不该立刻汇报')

  await ctx.dispose()
})

test('step 之间不清零静默计时（跨 step 累计）', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.2, cooldownSeconds: 0 })

  // 第一步只跑 120ms 就结束了，单步永远到不了 0.2 秒
  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  fireEnd(ctx, agent)

  // 第二步再跑 120ms
  fireStart(ctx, agent, { turn: 1, step: 2 })
  await sleep(120)

  // 累计 240ms > 200ms，必须已经排上汇报
  const decision = await ctx.preStep({ agent, turn: 1, step: 3 })
  assert.equal(decision.messages.length, 1, '静默时长必须跨 step 累计')

  await ctx.dispose()
})

test('agent 被销毁时清掉状态，不留僵尸定时器', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await ctx.emit('agent/disposed', { agent })
  await sleep(120)

  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages.length, 0)

  await ctx.dispose()
})

test('ctx 销毁后清掉所有定时器', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await ctx.dispose()
  await sleep(120)

  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages.length, 0)

  await ctx.dispose()
})

test('stats 里能看到注入与截取计数', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0 })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  await ctx.preStep({ agent, turn: 1, step: 2 })
  fireText(ctx, agent, '汇报内容')
  fireToolCall(ctx, agent)

  const stats = ctx.status().stats
  assert.equal(stats.injected, 1)
  assert.equal(stats.captured, 1)
  assert.equal(stats.startFrames, 1)
  assert.ok(stats.chunkFrames >= 2)

  await ctx.dispose()
})

test('自定义提示词会被用上', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, prompt: '汇报一下现在的情况' })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  const textBlock = decision.messages[0].content.find((b) => b.type === 'text')
  assert.equal(textBlock.text, '汇报一下现在的情况')

  await ctx.dispose()
})

test('多次注入不会串台：每次截取独立收口', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 0 })

  // 第一次
  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  await ctx.preStep({ agent, turn: 1, step: 2 })
  fireText(ctx, agent, '第一次汇报')
  fireToolCall(ctx, agent)

  // 第二次：换 step，静默重新累计
  fireStart(ctx, agent, { turn: 1, step: 3 })
  await sleep(120)
  const second = await ctx.preStep({ agent, turn: 1, step: 4 })
  assert.equal(second.messages.length, 1)
  fireText(ctx, agent, '第二次汇报')
  fireToolCall(ctx, agent)

  const records = ctx.records()
  assert.equal(records.length, 1, '同会话只保留最新一条浮层记录')
  assert.equal(records[0].text, '第二次汇报', '不得把两轮汇报拼在一起')

  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// 静默到期那一刻就把浮窗亮出来（不等 step 边界）
// ---------------------------------------------------------------------------

test('静默到期时立刻亮出浮窗，不必等下一个 step 边界', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, overlayEnabled: true })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)

  // 注意：**没有**调用 preStep。主窗口在等子代理时，这个 step 可能还要
  // 挂好几分钟，等它结束再亮卡，用户早就以为卡死了。
  const records = ctx.records()
  assert.equal(records.length, 1, '到期就该有浮窗记录')
  assert.equal(records[0].pending, true, '应标成"还在等"')
  assert.equal(records[0].phase, 'working', '还没要求汇报，只是等')
  assert.equal(records[0].session, 'session-1')
  assert.ok(Number.isFinite(records[0].at), 'at 是关闭识别键与停留计时起点，必须有')

  await ctx.dispose()
})

test('第二次到期时保留上一段汇报的原文，不覆盖成空白', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 0, overlayEnabled: true })

  // 第一轮：到期 → 注入 → 模型汇报 → 收口
  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  await ctx.preStep({ agent, turn: 1, step: 2 })
  fireText(ctx, agent, '我已经把三个候选插件读完了，正在核对它们挂的钩子。')
  fireToolCall(ctx, agent)

  const first = ctx.records()[0]
  assert.equal(first.text, '我已经把三个候选插件读完了，正在核对它们挂的钩子。')
  assert.equal(first.pending, undefined, '收口后不再是 pending')

  // 第二轮：换 step，静默重新累计直到再次到期
  fireStart(ctx, agent, { turn: 1, step: 3 })
  await sleep(120)

  const second = ctx.records()[0]
  assert.equal(second.pending, true, '第二轮到期应重新亮卡')
  // 核心断言：原文必须还在。早期实现这里写的是 text: ''，卡片当场变空白，
  // 用户眼前的信息反而比刚才少。
  assert.equal(second.text, first.text, '上一段汇报的原文必须保留')
  assert.equal(second.at, first.at, 'at 沿用旧值，否则用户关掉的卡会重新冒出来')

  await ctx.dispose()
})

test('已要求汇报但模型还在憋话时，再到期不会把状态降回"还在等"', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 0, overlayEnabled: true })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(ctx.records()[0].phase, 'reporting', '注入后应推进到 reporting')

  // 模型还在憋那段话（只有 reasoning，没有正文），静默继续走
  fireStart(ctx, agent, { turn: 1, step: 3 })
  await sleep(120)

  // 这段静默恰恰是模型在整理汇报，界面上该说"正在整理汇报"，
  // 而不是退回"还在等"——后者会让用户以为提示词没送到。
  assert.equal(ctx.records()[0].phase, 'reporting', 'phase 不能被降回 working')

  await ctx.dispose()
})

test('等待态会带上"在等什么"，主窗口等子任务时说得清', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, overlayEnabled: true })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  fireText(ctx, agent, '我把这个拆成三个子任务并行去查。')
  // 工具真正开始执行是在 assistant/message 落库之后（tool-call 块已经完整），
  // 不是在流式的 tool-call-delta 阶段——那时参数还在拼，宿主都还没派发。
  void ctx.emit(
    'session/event',
    { id: 'session-1' },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{ type: 'tool-call', id: 'c-1', name: 'subagent', arguments: '{}' }],
        },
      },
    },
  )
  await sleep(120)

  const rec = ctx.records()[0]
  assert.equal(rec.waiting, '正在等子任务返回', '应说明在等子任务')
  assert.equal(rec.waitingTool, 'subagent')

  await ctx.dispose()
})

test('子代理的输出不会重置主窗口的静默计时', async () => {
  const ctx = makeCtx()
  const main = makeAgent('main-1')
  const sub = makeAgent('sub-1')
  sub.parent = {}
  apply(ctx, { silentSeconds: 0.15, cooldownSeconds: 0, includeSubagents: false })

  // 主窗口发起子任务后就没动静了
  fireStart(ctx, main, { turn: 1, step: 1 })
  fireText(ctx, main, '我拆成两个子任务并行去查。')
  void ctx.emit(
    'session/event',
    { id: 'main-1' },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'c1', name: 'subagent' }] } },
    },
  )

  // 子代理在那边疯狂输出正文——这些事件绝不能算到主窗口头上
  for (let i = 0; i < 8; i += 1) {
    fireStart(ctx, sub, { turn: 1, step: i + 1 })
    fireText(ctx, sub, `子代理第 ${i} 段输出`)
    await sleep(32)
  }
  await sleep(160)

  const rec = ctx.records().find((r) => r.session === 'main-1')
  assert.ok(rec, '主窗口静默到期后必须有浮窗记录')
  assert.equal(rec.pending, true, '还卡在等子任务，应标成 pending')
  assert.equal(rec.waiting, '正在等子任务返回')
  assert.ok(
    !ctx.records().some((r) => r.session === 'sub-1'),
    '子代理默认不汇报，不该有它自己的浮窗记录',
  )

  await ctx.dispose()
})

test('模型先调工具后说话时，汇报原文照样进浮窗', async () => {
  // 真机上的常态：注入之后模型不立刻开口，而是先把手上那个命令跑完。
  // 早先 commitCapture 遇到空缓冲区会无条件 captures.delete，第一个
  // tool-call-delta 就把截取窗口收了，等模型真说话时已经拿不到缓冲区——
  // 那段汇报被当成"自主发言"，既进不了浮窗、又推进 lastTextAt 把卡撤掉。
  // 表现为多 step 长任务里 captured 恒为 0。
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 0, overlayEnabled: true })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  await ctx.preStep({ agent, turn: 1, step: 2 })

  // 注入之后先干了两轮活，一句话没说
  fireToolCall(ctx, agent)
  fireStart(ctx, agent, { turn: 1, step: 3 })
  fireToolCall(ctx, agent)

  // 这时候才开口汇报
  fireText(ctx, agent, '我扫完了 1201 个文件，')
  fireText(ctx, agent, '发现 29 个是空文件。')
  fireToolCall(ctx, agent)

  const records = ctx.records()
  assert.equal(records.length, 1, '应记下一条浮层记录')
  assert.equal(
    records[0].text,
    '我扫完了 1201 个文件，发现 29 个是空文件。',
    '先调工具后说话的汇报原文不能丢',
  )
  assert.equal(ctx.status().stats.captured, 1, 'captured 要真的加一，不能空转')

  await ctx.dispose()
})

test('注入后一直不开口时，截取窗口不能永远挂着', async () => {
  // 上一条改成"空缓冲区保留窗口"之后，必须有时间闸兜底：一个注入后彻底
  // 沉默的会话会把缓冲区永久留在内存里。
  const ctx = makeCtx()
  const agent = makeAgent()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 0, overlayEnabled: true })

  fireStart(ctx, agent, { turn: 1, step: 1 })
  await sleep(120)
  await ctx.preStep({ agent, turn: 1, step: 2 })

  // 直接把窗口的出生时刻往前推：等价于"已经挂了很久"
  // （真实的 CAPTURE_MAX_MS 是 10 分钟，测试里不能真等）
  const caps = ctx.narratorCaptures()
  assert.ok(caps !== undefined, '需要拿到截取窗口才能做这个断言')
  const cap = caps.get('session-1')
  assert.ok(cap !== undefined, '注入之后窗口应该存在')
  cap.at -= 11 * 60 * 1000

  fireToolCall(ctx, agent)
  assert.equal(caps.get('session-1'), undefined, '超时之后窗口必须被丢掉')

  await ctx.dispose()
})

