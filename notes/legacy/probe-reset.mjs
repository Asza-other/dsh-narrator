/**
 * 测量「续报节奏」：在无冷却、无上限的情况下，旁白到底隔多久报一次、
 * 报出来的「已 N 秒」是不是在真实增长。
 *
 * 这个脚本是为了回答一个变异测试暴露的问题：把「播报后重置静默起点」
 * 那行删掉，26 个用例全过——说明那条约束根本没有被验证。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_NARRATOR_CONFIG = join(mkdtempSync(join(tmpdir(), 'narrator-probe-')), 'config.json')

const { apply } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx() {
  const sections = []
  const handlers = new Map()
  const routes = new Map()
  const self_inject_routes = (cb) => {
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
  const effects = []
  const warnings = []
  return {
    sections,
    handlers,
    warnings,
    systemPrompt: { section: (e) => sections.push(e) },
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
    logger: { info() {}, warn: (...a) => warnings.push(a), debug() {} },
    emit(name, ...args) {
      for (const fn of handlers.get(name) ?? []) fn(...args)
    },
    routes,
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('webServer')) self_inject_routes(cb)
      return () => {}
    },
    async dispose() {
      for (const d of effects) await d()
    },
  }
}

const SEED_SOURCE = { kind: 'model', provider: 'test-provider', model: 'test-model' }
const seedEvents = () => [
  { type: 'assistant/message', data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'seed' }], source: SEED_SOURCE } } },
]

function makeAgent(events = seedEvents()) {
  const appends = []
  return {
    id: 'agent-1',
    appends,
    session: {
      id: 'session-1',
      events,
      append(type, data, meta) {
        appends.push({ at: Date.now(), type, data, meta })
        events.push({ type, data })
      },
    },
    inject() {},
  }
}

const ctx = makeCtx()
const agent = makeAgent()
apply(ctx, { silentSeconds: 0.2, cooldownSeconds: 0, maxPerTurn: 0 })

ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 } })
await sleep(1150)

console.log('插入条数:', agent.appends.length)
const gaps = agent.appends.slice(1).map((a, i) => a.at - agent.appends[i].at)
console.log('相邻间隔(ms):', gaps.join(', ') || '(只有一条)')

const reported = agent.appends.map((a) => {
  const block = a.data.message.content.find((b) => b.type === 'text')
  const m = block.text.match(/已 (\d+) 秒/)
  return m ? Number(m[1]) : null
})
console.log('各条报的秒数:', reported.join(', '))

// 期望：间隔 ≈ 200ms（阈值），报出的秒数不增长（因为每次都重新计时）
const okGap = gaps.every((g) => g >= 150 && g <= 400)
const okSeconds = reported.every((s) => s !== null && s <= 2)
console.log('间隔合理(150~400ms):', okGap)
console.log('报出秒数未累加(<=2):', okSeconds)

await ctx.dispose()
