// 两个开关的独立语义（v0.11.0）
//
// 历史：v0.7.0 时是「对话流通道 + 浮层通道」两个开关。v0.11.0 改成
// 「注入提示词让模型自己说」之后，对话流那条不再由插件直接写入了
// （写进去也会被宿主同一步的投影覆盖，见 README），所以两个开关变成：
//   - enabled        要不要让模型定期汇报（控制 pre-step 注入）
//   - overlayEnabled 要不要把模型说的那段原文弹到右下角浮窗
// 关掉浮层不该连带关掉汇报，反之亦然。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import 插件之前设环境变量：插件模块加载时会读配置路径，
// 否则测试会写进用户真实配置（历史上被污染过一次，导致大批用例假失败）。
const dir = mkdtempSync(join(tmpdir(), 'narrator-switch-'))
process.env.DSH_NARRATOR_CONFIG = join(dir, 'config.json')

const { apply, DEFAULTS, normalizeConfig } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeAgent(sessionId = 'chan-1') {
  return { id: `agent-${sessionId}`, session: { id: sessionId, events: [] }, steer() {}, inject() {} }
}

function makeCtx() {
  const handlers = new Map()
  const routes = new Map()
  const effects = []
  const ctx = {
    log() {},
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    logger: { info() {}, warn() {}, debug() {} },
    inject(_deps, cb) {
      cb({
        webServer: {
          register(entry) {
            routes.set(entry.path, entry.handler)
            return () => routes.delete(entry.path)
          },
        },
        effect(fn) {
          return ctx.effect(fn)
        },
      })
    },
    /** 模拟宿主把监听器串成 waterfall。 */
    async preStep(payload) {
      const list = handlers.get('agent/pre-step') ?? []
      const fallback = { kind: 'enter', messages: [] }
      let next = async () => fallback
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const fn = list[i]
        const inner = next
        next = () => fn(payload, inner)
      }
      return next()
    },
    async emit(name, payload) {
      for (const fn of handlers.get(name) ?? []) await fn(payload)
    },
    status() {
      return typeof ctx.narratorStatus === 'function' ? ctx.narratorStatus() : null
    },
    records() {
      return typeof ctx.narratorRecords === 'function' ? ctx.narratorRecords() : []
    },
    async dispose() {
      for (const d of effects) await d()
    },
  }
  return ctx
}

/**
 * 走完「静默超时 → pre-step 注入 → 模型说第一段正文」这条链路。
 */
async function runCycle(config, sessionId) {
  const ctx = makeCtx()
  apply(ctx, config)
  const agent = makeAgent(sessionId)

  await ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 },
  })
  await sleep(220)

  const first = await ctx.preStep({ agent, turn: 1, step: 2 })
  const injected = Array.isArray(first?.messages) ? first.messages.length : 0

  // 模型按提示词汇报：先走一段正文
  await ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'start', attemptId: 'a2', turn: 1, step: 2 },
  })
  await ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '我正在改测试，快好了。' } },
  })
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'a2', index: 0 } })

  const status = ctx.status()
  const records = ctx.records()
  await ctx.dispose()
  return { injected, status, records }
}

test('默认两个开关都开', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.overlayEnabled, true)
  assert.equal(DEFAULTS.enabled, true)
  assert.equal(DEFAULTS.overlayEnabled, true)
})

test('默认会注入，并且截到模型汇报的原文', async () => {
  const { injected, status, records } = await runCycle({ silentSeconds: 0.1, cooldownSeconds: 0 }, 'chan-both')
  assert.equal(injected, 1, '应注入一条要求汇报的消息')
  assert.equal(status.stats.injected, 1)
  assert.equal(status.stats.captured, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].session, 'chan-both')
  assert.match(records[0].text, /我正在改测试/)
})

test('关掉浮层时仍然注入，但不产生浮层记录', async () => {
  const { injected, status, records } = await runCycle(
    { silentSeconds: 0.1, cooldownSeconds: 0, overlayEnabled: false },
    'chan-overlay-off',
  )
  assert.equal(injected, 1, 'overlayEnabled=false 不该影响注入')
  assert.equal(status.stats.injected, 1)
  assert.equal(records.length, 0, '浮层关掉时不该留下任何会话原文')
  assert.ok(status.stats.skipped.overlayOff >= 1, '应记录 overlayOff')
})

test('总开关优先：enabled=false 时既不注入也不截取', async () => {
  const { injected, status, records } = await runCycle({ enabled: false, silentSeconds: 0.1 }, 'chan-disabled')
  assert.equal(injected, 0)
  assert.equal(status.stats.injected, 0)
  assert.equal(records.length, 0)
  assert.ok(status.stats.skipped.disabled >= 1)
})

test('includeSubagents 为 false 时跳过子代理', async () => {
  const ctx = makeCtx()
  apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, includeSubagents: false })
  const agent = makeAgent('chan-sub')
  agent.kind = 'subagent'
  await ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 },
  })
  await sleep(120)
  const decision = await ctx.preStep({ agent, turn: 1, step: 2 })
  assert.equal(decision.messages.length, 0)
  assert.ok(ctx.status().stats.skipped.subagent >= 1)
  await ctx.dispose()
})

// 清理临时配置目录
test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论
  }
})
