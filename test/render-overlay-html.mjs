/**
 * 把浮层渲染树导出成 HTML，供真实浏览器截图。
 *
 * 测试里的假 React 直接产出 { type, props } 树，这里把它翻译成 HTML 字符串，
 * 再套上宿主的主题变量与浮层样式。目的是用眼睛确认表格长什么样，而不是
 * 只靠断言间接推断。
 */
import { writeFileSync } from 'node:fs'

const HOOKS = { list: [], disposers: [], i: 0, pending: [] }

const React = {
  createElement(type, props, ...children) {
    const merged = {
      ...(props ?? {}),
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    }
    if (typeof type === 'function') return type(merged)
    return { type, props: merged }
  },
  useState(initial) {
    const i = HOOKS.i++
    if (!(i in HOOKS.list)) HOOKS.list[i] = initial
    return [HOOKS.list[i], (v) => (HOOKS.list[i] = typeof v === 'function' ? v(HOOKS.list[i]) : v)]
  },
  useEffect(fn) {
    HOOKS.i++
    HOOKS.pending.push(fn)
  },
  useRef(initial) {
    const i = HOOKS.i++
    if (!(i in HOOKS.list)) HOOKS.list[i] = { current: initial }
    return HOOKS.list[i]
  },
  useCallback(fn) {
    HOOKS.i++
    return fn
  },
  useMemo(fn) {
    HOOKS.i++
    return fn()
  },
}

const registrations = []
let clientModule = null
let capturedStyle = ''

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      const mod = spec.factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require: ${name}`)
      })
      clientModule = mod
      mod.apply({
        slots: {
          inject(name, cb) {
            const entry = cb()
            entry.__slot = name
            registrations.push(entry)
          },
          register(options, Component) {
            return { options, Component }
          },
        },
      })
    },
  },
}

await import('../lib/client.js')

// 抓出浮层样式
const src = clientModule.__internal?.OVERLAY_STYLE
if (typeof src === 'string') capturedStyle = src

const overlayEntry = registrations.find((r) => r.__slot === 'shell.overlay')
if (!overlayEntry) throw new Error('没找到 shell.overlay 注册')

const runEffects = () => {
  const pending = HOOKS.pending
  HOOKS.pending = []
  // effect 的返回值是清理函数（浮层拿它清 setInterval）。不收好就会挂住进程。
  for (const fn of pending) {
    const dispose = fn()
    if (typeof dispose === 'function') HOOKS.disposers.push(dispose)
  }
}

const mount = async (payload, session = 'sess-1') => {
  HOOKS.list = []
  HOOKS.disposers = []
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, ...payload }) })
  globalThis.document = {
    querySelector: (sel) =>
      sel === '[data-conversation-session]' ? { getAttribute: () => session } : null,
    querySelectorAll: () => [],
    body: null,
  }
  if (typeof globalThis.window !== 'object' || globalThis.window === null) globalThis.window = {}
  globalThis.window.addEventListener = () => {}
  globalThis.window.removeEventListener = () => {}
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  HOOKS.i = 0
  HOOKS.pending = []
  overlayEntry.Component({})
  runEffects()
  await new Promise((r) => setTimeout(r, 0))
  HOOKS.i = 0
  HOOKS.pending = []
  const tree = overlayEntry.Component({})
  for (const dispose of HOOKS.disposers) dispose()
  HOOKS.disposers = []
  return tree
}

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const toHtml = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return esc(node)
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node !== 'object') return ''
  const { type, props } = node
  if (typeof type === 'function') return toHtml(type(props ?? {}))
  const pattrs = []
  const style = props?.style
  if (props?.className) pattrs.push(`class="${esc(props.className)}"`)
  if (style && typeof style === 'object') {
    const css = Object.entries(style)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
      .join(';')
    if (css) pattrs.push(`style="${esc(css)}"`)
  }
  if (props?.onClick) pattrs.push('data-clickable="1"')
  const kids = toHtml(props?.children)
  const tag = type === 'div' || type === 'span' || type === 'table' ? type : type
  return `<${tag}${pattrs ? ' ' + pattrs.join(' ') : ''}>${kids}</${tag}>`
}

const now = Date.now()
const tableText = [
  '模型收到「请汇报」后往往先把手上的活干完再开口。第一个 `tool-call-delta` 到来时缓冲区还是空的，窗口就被删了。',
  '',
  '**两条回归测试用真实事件顺序**（`tool-call → step → tool-call → text → tool-call`），变异验证：',
  '',
  '| 变异 | 报错 |',
  '| --- | --- |',
  '| 把 `delete` 挪回判空之前 | 「先调工具后说话的汇报原文不能丢」 |',
  '| 去掉时间闸 | 「超时之后窗口必须被丢掉」 |',
  '',
  '65 项测试全部通过，提交 `5f79728`，安装副本已同步。',
].join('\n')

const payload = {
  enabled: true,
  overlayEnabled: true,
  overlayOpacity: 1,
  lingerSeconds: 300,
  records: [
    {
      session: 'sess-1',
      text: tableText,
      turn: 3,
      step: 7,
      at: now - 20_000,
      textAt: now - 20_000,
      silentSeconds: 65,
      pending: false,
      phase: 'reporting',
    },
  ],
  runningMap: { 'sess-1': true },
  textAtMap: { 'sess-1': now - 20_000 },
  waitingMap: {},
}

const dark = process.argv.includes('--dark')
const tree = await mount(payload)
const body = toHtml(tree)

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root{
    --dsw-alias-bg-layer-1:${dark ? '#232324' : '#fff'};
    --dsw-alias-bg-layer-2:${dark ? '#2c2c2e' : '#fff'};
    --dsw-alias-label-primary:${dark ? '#f9fafb' : '#111'};
    --dsw-alias-label-secondary:${dark ? '#cfd3d6' : '#61666b'};
    --dsw-alias-border-l2:${dark ? 'rgba(255,255,255,0.12)' : 'rgba(128,128,128,0.28)'};
    --dsw-alias-state-warn-primary:#f0a020;
  }
  html,body{margin:0;padding:0;background:${dark ? '#1b1b1c' : '#f4f5f7'};font-family:-apple-system,'Segoe UI',system-ui,sans-serif}
  body{padding:24px;display:flex;justify-content:flex-start;align-items:flex-start}
  .narr-overlay{position:static !important}
  .narr-overlay-card{max-width:420px}
  ${capturedStyle}
</style></head><body>
${body}
</body></html>`

const out = process.argv[2] || 'overlay-table.html'
writeFileSync(out, html, 'utf8')
console.log('written', out, html.length, 'chars')
