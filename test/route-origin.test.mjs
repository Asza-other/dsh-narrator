import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_NARRATOR_CONFIG = join(mkdtempSync(join(tmpdir(), 'narrator-origin-')), 'config.json')
const { apply } = await import('../lib/index.js')

/**
 * 跨源防护探针。
 *
 * 只校验 loopback 是不够的：浏览器里任何网页都能 fetch 到 127.0.0.1，
 * 源地址同样是 loopback。于是恶意页面可以 POST /config 改阈值（副作用型，
 * 不需要读响应），或 GET /latest 拿走旁白正文（里面有任务目标、路径、命令、
 * 报错原文）。这里锁住「带外站 Origin 一律拒绝」。
 */

function makeCtx() {
  const handlers = new Map()
  const ctx = {
    on() {},
    systemPrompt: { section() {} },
    inject(_deps, cb) {
      cb({
        webServer: {
          register(route) {
            handlers.set(route.path, route.handler)
            return () => handlers.delete(route.path)
          },
        },
        effect(fn) {
          fn()
        },
      })
    },
    effect() {},
    _handlers: handlers,
  }
  return ctx
}

const ctx = makeCtx()
apply(ctx, { silentSeconds: 60, cooldownSeconds: 60 })

/** 发一个请求，返回 {status, body}。 */
const call = (
  path,
  { method = 'GET', origin, host = '127.0.0.1:61201', remote = '127.0.0.1', contentType, body } = {},
) =>
  new Promise((resolve) => {
    const handler = ctx._handlers.get(path)
    assert.ok(handler, `${path} 未注册`)
    const headers = {}
    if (origin !== undefined) headers.origin = origin
    if (host !== undefined) headers.host = host
    if (contentType !== undefined) headers['content-type'] = contentType
    const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
    const req = {
      method,
      url: '/',
      headers,
      socket: { remoteAddress: remote },
      on(event, fn) {
        if (event === 'data') for (const c of chunks) fn(c)
        if (event === 'end') fn()
      },
      destroy() {},
    }
    const res = {
      status: 0,
      body: '',
      writeHead(code) {
        this.status = code
      },
      end(text) {
        this.body = text ?? ''
        resolve({ status: this.status, body: this.body })
      },
    }
    try {
      handler(req, res)
    } catch (error) {
      resolve({ status: -1, body: String(error) })
    }
  })

// ---- 1) 同源请求放行 -------------------------------------------------------
{
  const res = await call('/api/narrator/config', { origin: 'http://127.0.0.1:61201' })
  assert.equal(res.status, 200, `同源请求应放行，实际 ${res.status} ${res.body}`)
}

// ---- 2) 外站 Origin 拒绝 ---------------------------------------------------
for (const origin of ['http://evil.example', 'https://attacker.test:8443', 'null']) {
  const res = await call('/api/narrator/config', { origin })
  if (origin === 'null') {
    // Origin: null（沙箱 iframe、file://）解析失败 → 视为跨源
    assert.equal(res.status, 403, `Origin=null 应拒绝，实际 ${res.status}`)
    assert.ok(res.body.includes('cross-origin'))
  } else {
    assert.equal(res.status, 403, `外站 Origin ${origin} 应拒绝，实际 ${res.status}`)
    assert.ok(res.body.includes('cross-origin'), res.body)
  }
}

// ---- 3) 跨源的写操作绝不生效（这才是真正的风险） ---------------------------
{
  const before = JSON.parse((await call('/api/narrator/config')).body).config.silentSeconds
  const res = await call('/api/narrator/config', {
    method: 'POST',
    origin: 'http://evil.example',
  })
  assert.equal(res.status, 403)
  const after = JSON.parse((await call('/api/narrator/config')).body).config.silentSeconds
  assert.equal(after, before, '跨源 POST 不得改动配置')
}

// ---- 4) /latest 不得把旁白正文交给外站 ------------------------------------
{
  const res = await call('/api/narrator/latest', { origin: 'http://evil.example' })
  assert.equal(res.status, 403)
  assert.ok(!res.body.includes('records'), '跨源请求不应拿到 records')
}

// ---- 5) 同源下 /latest 正常 -------------------------------------------------
{
  const res = await call('/api/narrator/latest', { origin: 'http://127.0.0.1:61201' })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.records))
}

// ---- 6) 只读接口的方法校验 -------------------------------------------------
{
  for (const path of ['/api/narrator/status', '/api/narrator/latest']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await call(path, { method })
      assert.equal(res.status, 405, `${method} ${path} 应回 405，实际 ${res.status}`)
    }
    const ok = await call(path, { method: 'GET' })
    assert.equal(ok.status, 200, `GET ${path} 应正常`)
  }
}

// ---- 7) 非 loopback 仍然拒绝 ------------------------------------------------
{
  const res = await call('/api/narrator/config', { remote: '10.0.0.9' })
  assert.equal(res.status, 403)
  assert.ok(res.body.includes('loopback-only'))
}

// ---- 8) 不带 Origin 的请求放行（curl / 宿主自身 fetch） --------------------
{
  const res = await call('/api/narrator/status')
  assert.equal(res.status, 200, '无 Origin 的请求应放行')
}

// ---- 9) DNS rebinding：Origin 与 Host 一致但都不是本机 → 必须拒绝 ---------
//
// 这是最隐蔽的一种攻击：攻击者让 evil.com 解析到 127.0.0.1，那么浏览器发出的
// Origin 与 Host 天然都是 evil.com，只比「两项是否相同」的校验会直接放行。
{
  for (const origin of ['http://evil.example:61201', 'http://attacker.test']) {
    const host = origin.replace(/^https?:\/\//, '')
    const res = await call('/api/narrator/config', { origin, host })
    assert.equal(res.status, 403, `DNS rebinding（Origin=${origin} Host=${host}）应拒绝，实际 ${res.status}`)
    assert.ok(res.body.includes('cross-origin'), res.body)
  }
  // 读接口同样不能放行——这里泄露的是旁白正文
  const leak = await call('/api/narrator/latest', {
    origin: 'http://evil.example:61201',
    host: 'evil.example:61201',
  })
  assert.equal(leak.status, 403)
  assert.ok(!leak.body.includes('records'))
}

// ---- 10) 本机别名（localhost / [::1]）不得被误杀 ---------------------------
{
  const localhost = await call('/api/narrator/config', {
    origin: 'http://localhost:61201',
    host: 'localhost:61201',
  })
  assert.equal(localhost.status, 200, `localhost 应放行，实际 ${localhost.status} ${localhost.body}`)

  const v6 = await call('/api/narrator/config', {
    origin: 'http://[::1]:61201',
    host: '[::1]:61201',
  })
  assert.equal(v6.status, 200, `[::1] 应放行，实际 ${v6.status} ${v6.body}`)
}

// ---- 11) POST 只接受 application/json --------------------------------------
//
// 不限制 Content-Type 的话，任何页面都能用 form / text/plain 发出"简单请求"
// 绕过 CORS 预检。虽然前面两道守卫已经拦住了跨站，但改阈值的接口不该留口子。
{
  const withJson = await call('/api/narrator/config', {
    method: 'POST',
    origin: 'http://127.0.0.1:61201',
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ config: { silentSeconds: 120 } }),
  })
  assert.equal(withJson.status, 200, `application/json 应接受，实际 ${withJson.status} ${withJson.body}`)

  const withForm = await call('/api/narrator/config', {
    method: 'POST',
    origin: 'http://127.0.0.1:61201',
    contentType: 'application/x-www-form-urlencoded',
    body: JSON.stringify({ config: { silentSeconds: 30 } }),
  })
  assert.equal(withForm.status, 415, `非 JSON 的 Content-Type 应回 415，实际 ${withForm.status}`)
  assert.ok(withForm.body.includes('unsupported-media-type'), withForm.body)

  // 被拒的那次不能改动配置
  const after = JSON.parse((await call('/api/narrator/config')).body).config.silentSeconds
  assert.equal(after, 120, '被 415 拒绝的请求不得写进配置')
}

console.log('route-origin probe: 全部通过')
