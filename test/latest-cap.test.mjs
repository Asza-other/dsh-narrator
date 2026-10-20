// 浮层记录必须有上限（v0.11.0 重写）
//
// `/api/narrator/latest` 每 2 秒被轮询一次，并把 `latestBySession` 全量下发。
// 若只增不减，长跑后响应体会一路变胖，其中绝大多数是早就结束的会话。
// v0.11.0 改成「注入后截取模型原文」之后，每条记录都是整段正文，
// 比原来的模板短句更大，这个上限就更不能少。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_NARRATOR_CONFIG = join(mkdtempSync(join(tmpdir(), 'narrator-cap-')), 'config.json')
const { apply } = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LATEST_MAX_SESSIONS = 8

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
            return () => {}
          },
        },
        effect(fn) {
          return ctx.effect(fn)
        },
      })
    },
    async emit(name, payload) {
      for (const fn of handlers.get(name) ?? []) await fn(payload)
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
    status() {
      return typeof ctx.narratorStatus === 'function' ? ctx.narratorStatus() : null
    },
    records() {
      return typeof ctx.narratorRecords === 'function' ? ctx.narratorRecords() : []
    },
    async dispose() {
      for (const d of effects) await d()
    },
    _routes: routes,
  }
  return ctx
}

const makeAgent = (sessionId) => ({ id: `agent-${sessionId}`, session: { id: sessionId, events: [] } })

/** 走完「静默超时 → 注入 → 汇报一段正文」的完整链路。 */
async function cycle(ctx, sessionId, text) {
  const agent = makeAgent(sessionId)
  await ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 },
  })
  await sleep(120)
  await ctx.preStep({ agent, turn: 1, step: 2 })
  await ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'start', attemptId: 'a2', turn: 1, step: 2 },
  })
  await ctx.emit('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text } },
  })
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'a2', index: 0 } })
}

const ctx = makeCtx()
apply(ctx, { silentSeconds: 0.05, cooldownSeconds: 0, maxPerTurn: 0, overlayEnabled: true })

// 远超上限的会话数。每条之间错开一点，保证 at 单调递增，淘汰顺序可预测。
const TOTAL = LATEST_MAX_SESSIONS + 4
for (let i = 0; i < TOTAL; i += 1) {
  await cycle(ctx, `cap-sess-${i}`, `第 ${i} 个会话的汇报`)
  await sleep(15)
}

const records = ctx.records()
assert.equal(
  records.length,
  LATEST_MAX_SESSIONS,
  `浮层记录必须封顶在 ${LATEST_MAX_SESSIONS} 条，实际 ${records.length} 条`,
)
assert.equal(ctx.status().stats.captured, TOTAL, '截取次数本身不该被上限影响')

// 淘汰的必须是最旧的几条，而不是随机丢
const kept = new Set(records.map((r) => r.session))
for (let i = TOTAL - LATEST_MAX_SESSIONS; i < TOTAL; i += 1) {
  assert.ok(kept.has(`cap-sess-${i}`), `最新写入的 cap-sess-${i} 不该被淘汰`)
}
assert.ok(!kept.has('cap-sess-0'), '最旧的会话应被淘汰掉')

for (const rec of records) {
  assert.equal(typeof rec.text, 'string')
  assert.equal(typeof rec.at, 'number')
  assert.equal(typeof rec.session, 'string')
}

// /latest 下发的必须是同一批（过滤在路由层，上限在存储层，不能只在一边）
const latestHandler = ctx._routes.get('/api/narrator/latest')
assert.ok(latestHandler !== undefined, '应注册 /api/narrator/latest')
const body = await new Promise((resolve) => {
  const req = { method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: {} }
  const res = {
    writeHead() {},
    end(text) {
      resolve(JSON.parse(text))
    },
  }
  void latestHandler(req, res)
})
assert.equal(body.records.length, LATEST_MAX_SESSIONS, '/latest 也不该下发超过上限的记录')
assert.ok(
  JSON.stringify(body).length < 40_000,
  `响应体应保持小体量，实际 ${JSON.stringify(body).length} 字节`,
)

await ctx.dispose()

console.log(`latest-cap probe: 全部通过（保留 ${records.length} 条记录）`)
