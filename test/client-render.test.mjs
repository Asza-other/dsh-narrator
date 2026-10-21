/**
 * 客户端组件渲染探针（v0.11.0 重写）
 *
 * 用一个迷你 React 桩真实跑一遍组件树，确认：
 *   - 设置卡结构 = 两个勾选开关 + 两个分钟行 + 透明度 + 停留时长 + 提示词框 + 测试区
 *   - 浮层渲染 = 模型那段原文（不拼模板）、按会话隔离、停留 N 秒后消散
 *
 * 桩的关键点：`createElement` 遇到函数组件就**立即调用展开**（这正是真实
 * React 渲染时做的事），这样每次完整渲染的 hooks 顺序与索引自然对齐。
 *
 * 历史教训（都还在生效）：
 *   - 浮层里挂了 setInterval，不清理会让 node 永远不退出 → mountOverlay 末尾必须清
 *   - setState 只改 HOOKS.list，必须**再渲染一次**才能看到新树（rerender 不重置索引）
 *   - 断言里不要用 `?.` 包住核心判断，否则对象不存在时断言静默跳过
 */
import assert from 'node:assert/strict'

// ---- 迷你 React 桩 ---------------------------------------------------------
const HOOKS = { list: [], i: 0, pending: [], disposers: [] }

const React = {
  createElement(type, props, ...children) {
    const merged = {
      ...(props ?? {}),
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    }
    // 函数组件立即展开，等价于 React 渲染
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

// ---- 捕获注册 -------------------------------------------------------------
/** 所有 slot 注册（设置卡 + 浮层）。 */
const registrations = []
/** 模块本体，用来拿 `__internal`（宿主的几何计算没法靠渲染树断言）。 */
let clientModule = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      const mod = spec.factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require: ${name}`)
      })
      clientModule = mod
      const ctx = {
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
      }
      mod.apply(ctx)
    },
  },
}

await import('../lib/client.js')

const settingsEntry = registrations.find((r) => r.__slot === 'settings.section')
const overlayEntry = registrations.find((r) => r.__slot === 'shell.overlay')

assert.ok(settingsEntry, 'client 应注册 settings.section')
assert.equal(settingsEntry.options.id, 'narrator')
assert.equal(typeof settingsEntry.options.label, 'function')
assert.equal(settingsEntry.options.label(), '进度旁白')

assert.ok(overlayEntry, 'client 应注册 shell.overlay')
assert.equal(overlayEntry.options.name, 'shell.overlay')
assert.equal(overlayEntry.options.id, 'narrator-progress')

/** 只渲染一次，返回展开后的 DOM 节点树（函数组件已被 createElement 展开）。 */
function renderOnce() {
  HOOKS.i = 0
  HOOKS.pending = []
  return settingsEntry.Component({})
}

/** 重渲染但**不重置** hooks 列表 —— 相当于 React 的一次重新渲染。 */
function rerender() {
  HOOKS.i = 0
  HOOKS.pending = []
  return settingsEntry.Component({})
}

/** 跑一遍本轮渲染收集到的 effect（同步部分）。 */
function runEffects() {
  const fns = HOOKS.pending
  HOOKS.pending = []
  for (const fn of fns) {
    const dispose = fn()
    if (typeof dispose === 'function') HOOKS.disposers.push(dispose)
  }
}

/** 收集所有宿主 DOM 节点。 */
const collect = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  const kids = node.props?.children
  if (Array.isArray(kids)) for (const k of kids) collect(k, out)
  else if (kids && typeof kids === 'object') collect(kids, out)
  return out
}

/**
 * 取整棵树的纯文本（用于文案断言）。
 *
 * 子节点之间**不加分隔符**，按原样拼接——这就是浏览器渲染文本的方式。
 * 早期这里写的是 `.join(' ')`，看上去只是「拼得更松」，实际会造出原文里
 * 不存在的空格：`['a ', '*', ' b']` 渲染出来是 `a * b`，join(' ') 却拼成
 * `a  *  b`，让人误判星号被吃掉了一个。
 */
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  const kids = node.props?.children
  if (Array.isArray(kids)) return kids.map(textOf).join('')
  return textOf(kids)
}

/**
 * 挂载设置卡：反复渲染直到状态稳定（fetch 的 setState 要一轮，
 * MinuteRow 内部「draft 跟随 value」的 effect 又要再一轮）。
 */
async function mount(config) {
  HOOKS.list = []
  HOOKS.disposers = []
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config }) })
  let tree = null
  for (let i = 0; i < 8; i += 1) {
    tree = renderOnce()
    runEffects()
    await new Promise((r) => setTimeout(r, 0))
  }
  tree = renderOnce()
  return { tree, nodes: collect(tree), text: textOf(tree) }
}

const config = {
  enabled: true,
  overlayEnabled: true,
  showInjected: false,
  overlayOpacity: 1,
  overlayOpacityMin: 0.35,
  overlayOpacityMax: 1,
  silentSeconds: 300,
  silentMinutes: 5,
  cooldownSeconds: 300,
  cooldownMinutes: 5,
  normalSilentSeconds: 300,
  normalCooldownSeconds: 300,
  testMode: false,
  testSilentSeconds: 5,
  testCooldownSeconds: 10,
  testSecondsMin: 1,
  testSecondsMax: 60,
  maxPerTurn: 0,
  lingerSeconds: 90,
  includeSubagents: true,
  prompt: null,
  defaultPrompt: '（内置默认提示词）',
  defaults: {
    silentSeconds: 60,
    cooldownSeconds: 60,
    maxPerTurn: 0,
    lingerSeconds: 90,
    prompt: null,
    enabled: true,
    overlayEnabled: true,
    showInjected: false,
    includeSubagents: true,
    overlayOpacity: 1,
    testMode: false,
    testSilentSeconds: 5,
    testCooldownSeconds: 10,
  },
}

const { tree, nodes, text } = await mount(config)

// ---- 基本结构 -------------------------------------------------------------
assert.equal(tree.type, 'div')
assert.equal(tree.props.className, 'narr-root')

const styleNode = nodes.find((n) => n.type === 'style')
assert.ok(styleNode, '应渲染样式')
assert.ok(styleNode.props.children.includes('.narr-root'), '样式应包含根类')

// 根容器底部不能留内边距。
//
// sticky 的行程受包含块 padding box 限制：滚到底时底栏最多贴到内容盒底边。
// 根节点若留了 padding-bottom，底栏就比「贴住视口下沿」时高出那几像素，
// 用户滚到最下面那一下会看到保存按钮自己往上跳。
// 这里锁死 padding-bottom 为 0，并留出顶部/左右的内边距不动。
{
  const rootRules = [...styleNode.props.children.matchAll(/\.narr-root\s*\{([^}]*)\}/g)].map((m) => m[1])
  assert.equal(rootRules.length, 1, '应只有一条 .narr-root 规则')
  const padding = rootRules[0].match(/padding:\s*([^;]+)/)
  assert.ok(padding, '.narr-root 应显式声明 padding')
  const parts = padding[1].trim().split(/\s+/)
  assert.equal(parts.length, 3, `padding 应写成「上 左右 下」三值形式，实际「${padding[1].trim()}」`)
  assert.equal(
    parts[2],
    '0',
    `根节点底部内边距必须为 0，否则滚到底时底栏会上跳 ${parts[2]}；实际「${padding[1].trim()}」`,
  )
}

// 保存/恢复默认固定在卡片下沿：设置项一多，滚到底改完再滚回去找按钮太折腾。
// 用 sticky 而不是给宿主的滚动容器写死定位——不用知道容器是谁。
assert.ok(
  /\.narr-foot\s*\{[^}]*position:\s*sticky/.test(styleNode.props.children),
  '底部按钮栏必须 sticky 固定在设置卡下沿，不随内容滚走',
)
assert.ok(
  /\.narr-foot\s*\{[^}]*bottom:\s*0/.test(styleNode.props.children),
  'sticky 要贴住下沿',
)
assert.ok(
  /\.narr-foot\s*\{[^}]*background:/.test(styleNode.props.children),
  'sticky 栏必须有底色，否则内容会从按钮缝里透出来',
)

// 光有底色还不够：滚到底时 sticky 被包含块拽住，下沿对不上视口下沿，而宿主
// 滚动容器自己的 24px padding-bottom 属于滚动区，滚过去的文字照样从按钮底下
// 穿出来。所以底栏必须再向下溢出一截实心背景把那段盖住。
// 用 box-shadow 而不是 ::after：绝对定位会撑大 scrollHeight，滚到底多出空白。
const footRules = [...styleNode.props.children.matchAll(/\.narr-foot\s*\{([^}]*)\}/g)].map((m) => m[1])
assert.ok(footRules.length > 0, '应有 .narr-foot 规则')
const shadowDecl = footRules.map((d) => d.match(/box-shadow:\s*([^;]+)/)).find(Boolean)
assert.ok(shadowDecl, 'sticky 栏必须向下外溢实心底色盖住宿主滚动容器的下内边距，否则内容会从按钮下方透出来')
// box-shadow: <offset-x> <offset-y> <blur> <spread> <color>
const shadowValue = shadowDecl[1].trim()
const parts = shadowValue.match(
  /^(-?\d*\.?\d+)(?:px)?\s+(-?\d*\.?\d+)(?:px)?\s+(-?\d*\.?\d+)(?:px)?(?:\s+(-?\d*\.?\d+)(?:px)?)?/,
)
assert.ok(parts, `外溢阴影要写成「0 Npx 0 0 <色>」的形状，实际是「${shadowValue}」`)
const [, offX, offY, blur, spread] = parts
assert.equal(Number(offX), 0, '外溢阴影只向下，不能左右偏')
assert.equal(Number(blur), 0, '外溢阴影必须是实心色块，不能有模糊（模糊会露出底下文字）')
assert.equal(spread === undefined ? 0 : Number(spread), 0, '外溢阴影不需要扩散半径')
assert.ok(
  Number(offY) >= 24,
  `向下偏移要够盖住宿主滚动容器的 24px padding-bottom，实际只有 ${offY}px`,
)
assert.ok(
  !/\.narr-foot::(?:after|before)/.test(styleNode.props.children),
  '不要用伪元素方案盖那条缝：绝对定位会撑大 scrollHeight，滚到底多出一截空白',
)

assert.ok(text.includes('分钟'), '界面文案必须出现「分钟」')
assert.ok(text.includes('多久没有文字输出就让它说一句'), '应有静默时长项')
assert.ok(text.includes('两次汇报至少间隔'), '应有间隔项')

// v0.11.0 不再有「旁白形态」三选一，也不该有「两个通道」下拉：
// 机制变成「注入提示词让模型自己说」，两条通道折成两个勾选开关。
assert.ok(!text.includes('两个通道'), '两个通道下拉已删除')
assert.ok(!text.includes('旁白说什么'), '旁白形态下拉已删除')
assert.equal(
  nodes.filter((n) => n.type === 'select').length,
  0,
  '设置卡不应使用原生 select',
)
assert.equal(
  nodes.filter((n) => n.props?.['aria-haspopup'] === 'listbox').length,
  0,
  'v0.11.0 的设置卡不再有下拉框',
)

// ---- 两个独立勾选开关 -----------------------------------------------------
const checkboxes = nodes.filter((n) => n.type === 'input' && n.props?.type === 'checkbox')
assert.ok(checkboxes.length >= 2, `至少两个勾选开关，实际 ${checkboxes.length}`)
assert.ok(text.includes('让模型定期汇报'), '主开关文案')
assert.ok(text.includes('同时把汇报内容弹到对话区左下角浮窗'), '浮窗开关文案')
// 默认配置下两个都该是勾上的
assert.equal(checkboxes.filter((c) => c.props.checked === true).length >= 2, true, '默认两个开关都开')

// ---- 分钟滑杆：线性、1~60、步进 1 ----------------------------------------
const ranges = nodes.filter((n) => n.type === 'input' && n.props?.type === 'range')
// 分钟 x2 + 透明度 x1 + 浮窗停留 x1 + 测试区 x2 = 6
assert.equal(ranges.length, 6, `应有六个滑杆，实际 ${ranges.length}`)

// 分钟滑杆和测试区滑杆的 min/max 都是 1~60，只能靠 aria-valuetext 区分
// （MinuteRow 用「5 分钟」，TestRow 用「5 秒」）。
const minuteRanges = ranges.filter((r) => String(r.props['aria-valuetext']).includes('分钟'))
// 秒级滑杆有三个：浮窗停留时长 + 测试区两个（都复用 TestRow，量程一致）
const testRanges = ranges.filter((r) => String(r.props['aria-valuetext']).includes('秒'))
assert.equal(minuteRanges.length, 2, `应有两个分钟滑杆，实际 ${minuteRanges.length}`)
assert.equal(testRanges.length, 3, `应有三个秒级滑杆（停留 + 测试x2），实际 ${testRanges.length}`)
for (const r of minuteRanges) {
  assert.equal(r.props.min, 1, '滑杆下限必须是 1 分钟')
  assert.equal(r.props.max, 60, '滑杆上限必须是 60 分钟')
  assert.equal(r.props.step, 1, '滑杆刻度必须是 1 分钟')
  assert.ok(Number.isInteger(r.props.value), `滑杆值应为整数分钟，实际 ${r.props.value}`)
}
// 线性刻度：300 秒 = 位置 5（不是 0~1000 的对数位置）
assert.equal(minuteRanges[0].props.value, 5, '300 秒应映射到滑杆位置 5（线性）')

// ---- 分钟用数字输入框，不是下拉档位 --------------------------------------
const nums = nodes.filter(
  (n) => n.type === 'input' && n.props?.type === 'number' && n.props?.className === 'narr-numinput',
)
// 分钟 x2 + 浮窗停留 x1 + 测试 x2 = 5
assert.equal(nums.length, 5, `应有五个数字输入框，实际 ${nums.length}`)

// 分钟框靠 aria-label 后缀区分（TestRow 也是 min=1 max=60，不能靠量程区分）
const minuteNums = nums.filter((n) => String(n.props['aria-label']).endsWith('（分钟）'))
assert.equal(minuteNums.length, 2, `应有两个分钟数字框，实际 ${minuteNums.length}`)
for (const n of minuteNums) {
  assert.equal(n.props.step, 1, '数字框步进必须是 1 分钟')
  assert.ok(/^\d+$/.test(String(n.props.value)), `数字框初值应为整数分钟，实际「${n.props.value}」`)
}
assert.equal(Number(minuteNums[0].props.value), 5, '300 秒应显示成 5 分钟')
assert.equal(typeof minuteNums[0].props.onChange, 'function', '数字框必须可输入')
assert.equal(typeof minuteNums[0].props.onBlur, 'function', '数字框失焦要夹紧范围')
assert.ok(!/0\.\d+ 分钟/.test(text), '界面不应出现小数分钟')

// ---- 刻度标注 -------------------------------------------------------------
const scales = nodes.filter((n) => n.props?.className === 'narr-scale')
assert.equal(scales.length, 6, `六个滑杆都应标注量程，实际 ${scales.length}`)
const minuteScales = scales.filter((s) => textOf(s).includes('分钟'))
assert.equal(minuteScales.length, 2, '两个分钟滑杆要标注量程')
for (const s of minuteScales) {
  assert.ok(textOf(s).includes('1 分钟'), `刻度起点应为 1 分钟，实际：${textOf(s)}`)
  assert.ok(textOf(s).includes('60 分钟'), `刻度终点应为 60 分钟，实际：${textOf(s)}`)
}

// ---- 浮窗透明度：0.35~1，排在「测试」之前 --------------------------------
{
  const opacityRange = ranges.find((n) => n.props['aria-label'] === '浮窗透明度')
  assert.ok(opacityRange, '设置卡应有「浮窗透明度」滑杆')
  assert.equal(opacityRange.props.min, 0.35, '透明度下限 0.35')
  assert.equal(opacityRange.props.max, 1, '透明度上限 1')
  assert.equal(opacityRange.props.step, 0.05, '透明度刻度 0.05')
  assert.equal(Number(opacityRange.props.value), 1, '默认完全不透明')

  const labels = nodes.filter((n) => n.props?.className === 'narr-label').map((n) => textOf(n))
  const opacityAt = labels.indexOf('浮窗透明度')
  const testAt = labels.indexOf('测试')
  assert.ok(opacityAt >= 0, '应有「浮窗透明度」标签')
  assert.ok(testAt >= 0, '应有「测试」标签')
  assert.ok(opacityAt < testAt, '透明度要放在测试的上面')
}

// ---- 浮窗停留时长：秒级数字框 + 滑杆 ------------------------------------
{
  const lingerNum = nums.find((n) => String(n.props['aria-label']).includes('浮窗停留'))
  assert.ok(lingerNum, '应有「浮窗停留多久后自动消失」数字框')
  assert.ok(text.includes('浮窗停留多久后自动消失'), '停留时长文案')
  assert.equal(Number(lingerNum.props.value), 90, '默认 90 秒')
}

// ---- 提示词可编辑 ---------------------------------------------------------
{
  const area = nodes.find((n) => n.type === 'textarea' && n.props?.className === 'narr-textarea')
  assert.ok(area, '应有一个提示词文本框')
  assert.equal(typeof area.props.onChange, 'function', '提示词必须可编辑')
  assert.equal(area.props.placeholder, '（内置默认提示词）', '空值时应显示内置默认作为 placeholder')
  assert.ok(text.includes('汇报内容怎么给模型说'), '提示词区块标题')
  assert.ok(text.includes('在对话里显示这条提示词'), '应有「显示注入原文」开关')
  assert.ok(text.includes('子任务里也照样汇报'), '应有子代理开关')
}

// ---- 测试区块 -------------------------------------------------------------
{
  const block = nodes.find((n) => n.type === 'div' && n.props?.className === 'narr-test')
  assert.ok(block, '设置卡底部应有「测试」区块')
  const inner = collect(block)
  const testNums = inner.filter(
    (n) => n.type === 'input' && n.props?.type === 'number' && n.props?.className === 'narr-numinput',
  )
  assert.equal(testNums.length, 2, `测试区块应有 2 个秒级数字框，实际 ${testNums.length}`)
  for (const n of testNums) {
    assert.equal(n.props.min, 1, '测试秒数下限 1')
    assert.equal(n.props.max, 60, '测试秒数上限 60')
    assert.ok(String(n.props['aria-label']).endsWith('（秒）'), '测试框单位是秒')
  }
  assert.ok(text.includes('用秒级阈值试一下'), '测试开关文案')
}

// ---- 边界：低于最小档的配置先夹到 1 分钟，并给出说明 --------------------
{
  const { text: t, nodes: ns } = await mount({ ...config, silentSeconds: 10, silentMinutes: 0.17, normalSilentSeconds: 10 })
  const rs = ns.filter((n) => n.type === 'input' && n.props?.type === 'range')
  assert.equal(rs[0].props.value, 1, '低于最小档的配置应夹到 1 分钟显示')
  assert.ok(t.includes('10 秒'), '应指出当前配置是 10 秒')
  assert.ok(t.includes('按 1 分钟生效'), '应说明保存后会按最小档 1 分钟生效')
}

// ---- 边界：超过上限的配置夹到 60 分钟 -----------------------------------
{
  const { nodes: ns } = await mount({ ...config, silentSeconds: 7200, silentMinutes: 120, normalSilentSeconds: 7200 })
  const rs = ns.filter((n) => n.type === 'input' && n.props?.type === 'range')
  assert.equal(rs[0].props.value, 60, '超过上限的配置应夹到 60 分钟')
}

// ---- fetch 失败时不应抛 --------------------------------------------------
{
  HOOKS.list = []
  HOOKS.disposers = []
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
  renderOnce()
  runEffects()
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(textOf(renderOnce()).includes('读不到插件配置'), '读配置失败应给出提示')
}

// ===========================================================================
// 浮层
// ===========================================================================
{
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb
    }
    observe() {}
    disconnect() {}
  }
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
}

/**
 * 挂载浮层：首渲染 → 跑 effect（fetch）→ 等微任务 → 重渲染。
 *
 * `session` 是「用户当前正在看的会话 id」。浮层靠它从 records 里挑自己那条，
 * 所以测试必须模拟宿主写在 `[data-conversation-session]` 上的属性。
 */
const mountOverlay = async (payload, session = 'sess-1') => {
  HOOKS.list = []
  HOOKS.disposers = []
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, ...payload }) })
  globalThis.document = {
    querySelector: (sel) =>
      sel === '[data-conversation-session]' ? { getAttribute: () => session } : null,
    // `measureSeat()` 与它上面的 ResizeObserver 都会枚举同名节点（宿主 DOM 里
    // `[data-chat-flow]` 不止一处，不能只取第一个）。桩里一律返回空列表，
    // 让 measureSeat 走到兜底分支，测的是「不崩」而不是真实布局。
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
  HOOKS.i = 0
  HOOKS.pending = []
  overlayEntry.Component({})
  runEffects()
  await new Promise((r) => setTimeout(r, 0))
  HOOKS.i = 0
  HOOKS.pending = []
  const tree = overlayEntry.Component({})
  // 浮层里挂了 setInterval，不清理会让 node 永远等下去
  for (const dispose of HOOKS.disposers) dispose()
  HOOKS.disposers = []
  return { tree, nodes: collect(tree), text: textOf(tree) }
}

/** 一条浮层记录（v0.11.0 结构：只有模型原文，没有模板字段）。 */
const rec = (extra = {}) => ({
  session: 'sess-1',
  text: '我把几个候选插件的 README 读完了，正在核对他们各自挂的是哪个钩子。',
  turn: 3,
  step: 7,
  at: Date.now(),
  silentSeconds: 120,
  ...extra,
})

const empty = await mountOverlay({ enabled: true, records: [] })
assert.equal(empty.tree, null, '还没汇报过时浮层不应渲染任何东西')

const shown = await mountOverlay({ enabled: true, records: [rec()], runningMap: { 'sess-1': true } })
assert.ok(shown.tree, '有汇报时应渲染浮层')
assert.equal(shown.tree.props.className, 'narr-overlay')
assert.ok(shown.text.includes('正在汇报'), '浮层标题')
assert.ok(shown.text.includes('约 120 秒没说话'), '浮层应报静默时长')
assert.ok(shown.text.includes('第 7 步'), '浮层应报当前步数')
// 正文就是模型原文，不拼模板、不改写
assert.ok(
  shown.text.includes('我把几个候选插件的 README 读完了'),
  `正文必须是模型那段原文，实际：${shown.text}`,
)
assert.ok(!shown.text.includes('正在做：'), '不应再出现插件拼接的模板句')

// ---- 浮窗透明度跟着后端下发 ----------------------------------------------
{
  const dim = await mountOverlay({ enabled: true, overlayOpacity: 0.6, records: [rec()], runningMap: { 'sess-1': true } })
  assert.equal(dim.tree.props.style['--narr-overlay-opacity'], '0.6', '透明度应取自后端')
  const full = await mountOverlay({ enabled: true, overlayOpacity: 1, records: [rec()], runningMap: { 'sess-1': true } })
  assert.equal(full.tree.props.style['--narr-overlay-opacity'], '1', '默认完全不透明')
}

// ---- 配色与定位（踩过的坑，必须锁住）------------------------------------
{
  const overlayStyle = shown.nodes.find((n) => n.type === 'style')
  assert.ok(overlayStyle, '浮层应自带样式')
  assert.ok(
    !overlayStyle.props.children.includes('--dsw-alias-bg-elevated'),
    '不得使用宿主不存在的 --dsw-alias-bg-elevated（会导致黑底黑字）',
  )
  assert.ok(overlayStyle.props.children.includes('--dsw-alias-bg-layer-1'), '背景应使用宿主真实存在的主题变量')
  assert.ok(!overlayStyle.props.children.includes('position:fixed'), '浮层不得用 fixed 定位（会压住输入框）')
  assert.ok(overlayStyle.props.children.includes('position:absolute'), '浮层应相对 overlayLayer 用 absolute 定位')
  assert.ok(
    overlayStyle.props.children.includes('body[data-ds-dark-theme]'),
    '样式必须含 body[data-ds-dark-theme] 分支，否则夜间模式下兜底色是白底白字',
  )
  assert.ok(overlayStyle.props.children.includes('#232324'), '夜间分支应给出深色底')
  assert.ok(overlayStyle.props.children.includes('transition:left'), '位置变化要有过渡')

  assert.ok(/^\d+(\.\d+)?px$/.test(shown.tree.props.style.left), `left 应是像素值，实际 ${shown.tree.props.style.left}`)
  assert.ok(/^\d+(\.\d+)?px$/.test(shown.tree.props.style.bottom), `bottom 应是像素值，实际 ${shown.tree.props.style.bottom}`)
}

// ---- 浮窗水平对齐：必须挑主对话列，不能被侧栏那份骗走 ---------------------
/**
 * 这是「浮窗跑到左下角」那个 bug 的回归测试。
 *
 * 宿主 DOM 里 `[data-chat-flow]` 有多份（主聊天列 + `ChatGroupSeat` 里的
 * 工作步骤面板各一份）。用 `document.querySelector` 只拿第一个，一旦命中
 * 侧栏那份（左边界贴近窗口边缘），`left` 会算出个极小的值，浮窗就贴到
 * 整个窗口最左边、压住侧边栏。正确做法是筛掉侧栏/步骤面板、取最宽的那个。
 */
{
  const { measureSeat } = clientModule.__internal
  assert.equal(typeof measureSeat, 'function', '模块应暴露 measureSeat 供测试调用')

  /** 造一个假元素：给定视口内 left/width，可选 side 标记。 */
  const fakeEl = (left, width, options = {}) => ({
    isConnected: true,
    parentElement: null,
    closest: (sel) => (options.closestHit !== undefined && sel.includes(options.closestHit) ? {} : null),
    getBoundingClientRect: () => ({ left, width, top: 600, bottom: 700, height: 100, right: left + width }),
  })

  const layer = fakeEl(0, 1200)
  layer.getBoundingClientRect = () => ({ left: 0, width: 1200, top: 0, bottom: 800, height: 800, right: 1200 })

  // 侧栏里那份：贴着窗口左边缘、很窄
  const sidebarFlow = fakeEl(8, 220, { closestHit: 'data-sidebar-right-session' })
  // 另一份没被 closest 标记拦住的窄节点（宿主里 `ChatGroupSeat` 也会挂
  // `data-chat-flow`），它在文档序上排在主列**前面**
  const nestedFlow = fakeEl(40, 300)
  // 主对话列：居中、很宽
  const mainFlow = fakeEl(320, 760)
  // 输入框列：与主列同左边界
  const composerSeat = fakeEl(320, 760)

  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', gridTemplateColumns: '280px' })
  globalThis.document = {
    querySelector: (sel) => (sel === '[data-shell-overlay]' ? layer : null),
    querySelectorAll: (sel) => {
      // 顺序刻意如此：窄的在前，宽的主列在后。取第一个会把浮窗拖到 40。
      if (sel === '[data-chat-flow]') return [sidebarFlow, nestedFlow, mainFlow]
      if (sel === '[data-composer-seat]') return [composerSeat]
      return []
    },
    body: null,
  }

  const seat = measureSeat()
  assert.equal(
    seat.left,
    320,
    `必须对齐最宽的主对话列（320），不能是侧栏那份（8）、也不能是排在前面的窄节点（40），实际 ${seat.left}。` +
      '出现 8 或 40 就说明又回到了「拿第一个匹配」的老写法。',
  )
  // bottom 由输入框顶边换算：layerBox.bottom(800) - seat.top(600) + 16 = 216
  assert.equal(seat.bottom, 216, `底边应贴合输入框上方，实际 ${seat.bottom}`)

  // 只剩侧栏那份时：它属于排除对象，应当**继续往下**走兜底，
  // 而不是勉强拿它算位置（拿它算就会贴到窗口最左边）。
  globalThis.document.querySelectorAll = (sel) => {
    if (sel === '[data-chat-flow]') return [sidebarFlow]
    if (sel === '[data-composer-seat]') return []
    return []
  }
  const onlySidebar = measureSeat()
  assert.equal(onlySidebar.left, 304, `侧栏那份必须被排除并回落兜底 304，实际 ${onlySidebar.left}`)

  // 什么都找不到时同样走兜底：侧边栏宽度 + 24
  globalThis.document.querySelectorAll = () => []
  const nothing = measureSeat()
  assert.equal(nothing.left, 304, `全都找不到时应回落到 280+24=304，实际 ${nothing.left}`)
}

// ---- 停留 N 秒后消散（不再靠「出文字就撤」）------------------------------
{
  const linger = 90
  // 已经过去 10 分钟，任务也结束了 → 该散
  const gone = await mountOverlay({
    enabled: true,
    lingerSeconds: linger,
    records: [rec({ at: Date.now() - 10 * 60 * 1000 })],
    runningMap: { 'sess-1': false },
  })
  assert.equal(gone.tree, null, '任务已结束且超过停留时长后应自动消散')

  // 同样很久，任务还在跑，但模型**没有**再开口 → 继续挂着
  // （用户随时切回窗口都该看到；这条是「任务在跑就一直挂」的正当场景）
  const stillRunning = await mountOverlay({
    enabled: true,
    lingerSeconds: linger,
    records: [rec({ at: Date.now() - 10 * 60 * 1000 })],
    runningMap: { 'sess-1': true },
    textAtMap: {},
  })
  assert.ok(stillRunning.tree, '任务仍在跑且模型没再说话时，即使汇报已久也应继续显示')

  // 刚汇报完、任务已结束、但还在停留期内 → 仍显示
  const lingerWindow = await mountOverlay({
    enabled: true,
    lingerSeconds: linger,
    records: [rec({ at: Date.now() - 5 * 1000 })],
    runningMap: { 'sess-1': false },
  })
  assert.ok(lingerWindow.tree, '停留期内不该消散')
}

// ---- 主窗口又说了正文 → 立刻撤卡 -----------------------------------------
/**
 * 用户实测反馈：任务一直在跑，模型早就输出了一大段正文，浮窗却还挂着不消失，
 * 而且叉掉后切走再切回又冒出来。
 *
 * 根因有两个：
 *   1. 消失条件写的是 `!pending && !running && 超时`——`running` 让长任务
 *      期间**永不**撤卡，90 秒停留形同虚设。
 *   2. 有一个 `useEffect(() => setClosedAt(0), [viewingSession])`，切换会话
 *      就把「已关闭」清掉，叉按钮等于白点。
 */
{
  const now = Date.now()
  const session = 'sess-1'

  // ① 模型在写这条汇报之后又说了正文 → 撤
  const spokeAfter = await mountOverlay({
    enabled: true,
    records: [rec({ at: now - 60_000, textAt: now - 90_000 })],
    runningMap: { [session]: true },
    textAtMap: { [session]: now },
  })
  assert.equal(
    spokeAfter.tree,
    null,
    '主窗口在汇报之后又输出过正文时，浮窗必须撤掉——不能因为任务还在跑就永远挂着',
  )

  // ② 只有恰好等于记录里的 textAt（就是汇报原文本身）→ 不撤
  const selfOnly = await mountOverlay({
    enabled: true,
    records: [rec({ at: now - 60_000, textAt: now - 60_000 })],
    runningMap: { [session]: true },
    textAtMap: { [session]: now - 60_000 },
  })
  assert.ok(
    selfOnly.tree,
    '汇报原文本身就是一串 text-delta，它不能被自己撤掉——否则浮窗刚亮就消失',
  )

  // ③ 记录里没有 textAt（旧服务端）→ 回落到 at，行为不变
  const legacy = await mountOverlay({
    enabled: true,
    records: [rec({ at: now - 60_000 })],
    runningMap: { [session]: true },
    textAtMap: { [session]: now - 120_000 },
  })
  assert.ok(legacy.tree, '记录里缺 textAt 时应回落用 at 比较，不能凭空撤卡')

  // ④ 别的会话在说话，不影响本会话
  const otherSessionTalks = await mountOverlay({
    enabled: true,
    records: [rec({ at: now - 60_000, textAt: now - 60_000 })],
    runningMap: { [session]: true },
    textAtMap: { 'sess-2': now },
  })
  assert.ok(otherSessionTalks.tree, '别的会话输出正文不该撤掉本会话的浮窗')

  // ⑤ 子代理的输出进不了 textAtMap（服务端在子会话上就 return），
  //    所以「主窗口在等子代理」这段仍会显示——这正是最需要它的时候。
  const waitingSubagent = await mountOverlay({
    enabled: true,
    records: [
      rec({
        at: now - 60_000,
        textAt: now - 60_000,
        pending: true,
        phase: 'working',
        waiting: '正在等子任务返回',
        waitingTool: 'subagent',
      }),
    ],
    runningMap: { [session]: true },
    waitingMap: { [session]: { label: '正在等子任务返回', tool: 'subagent', startedAt: now - 120_000 } },
    textAtMap: { [session]: now - 60_000 },
  })
  assert.ok(waitingSubagent.tree, '等子代理期间没有主窗口正文，浮窗应继续显示')
  assert.ok(waitingSubagent.text.includes('等这一步跑完再汇总'), `实际：${waitingSubagent.text}`)
}

// ---- 叉掉后切走再切回，同一条汇报不再出现 -------------------------------
/**
 * `mountOverlay` 每次都是全新挂载（hooks 从头来），模拟不了「同一个组件实例
 * 里切换 viewingSession」。所以这里直接断言源码里没有那个清零 effect——
 * 它是这个 bug 的唯一来源，删掉了行为就对。
 */
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 先剥掉注释再判断：源码里那段注释就在讲「曾经这么写过，现在不写了」，
  // 不剥会把解释文字当成代码，测试反过来冤枉自己。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.ok(
    !/setClosedAt\(0\)/.test(code),
    '不得在会话切换时把 closedAt 清零：那会让用户叉掉的浮窗在切回来时又冒出',
  )
  // 关闭仍然要按「哪一条汇报」记，否则关一次就永久失聪
  assert.ok(
    /setClosedAt\(latest\.at\)/.test(code),
    '关闭要按该条汇报的 at 记，新汇报（at 变了）才重新出现',
  )
}

// ---- 右上角关闭 -----------------------------------------------------------
{
  const withClose = await mountOverlay({ enabled: true, records: [rec()], runningMap: { 'sess-1': true } })
  const btn = withClose.nodes.find((n) => n.type === 'button' && n.props?.className === 'narr-overlay-close')
  assert.ok(btn, '浮层右上角必须有可点的关闭按钮')
  assert.equal(btn.props['aria-label'], '关闭进度提示', '关闭按钮要有可访问名称')
  assert.equal(typeof btn.props.onClick, 'function', '关闭按钮要绑事件')
}

// ---- 只显示当前会话：别的会话有汇报也不应冒出来 -------------------------
{
  const other = await mountOverlay({
    enabled: true,
    records: [rec({ session: 'someone-else', text: '别的会话的汇报' })],
    runningMap: { 'someone-else': true },
  })
  assert.equal(other.tree, null, '别的会话在长思考，当前会话不应显示它的汇报')

  const both = await mountOverlay(
    {
      enabled: true,
      records: [rec({ session: 'sess-1', text: '本会话的汇报' }), rec({ session: 'sess-2', text: '别的会话的汇报' })],
      runningMap: { 'sess-1': true, 'sess-2': true },
    },
    'sess-2',
  )
  assert.ok(both.tree, '当前看 sess-2 时应显示 sess-2 的汇报')
  assert.ok(both.text.includes('别的会话的汇报'), '应显示当前会话的原文')
  assert.ok(!both.text.includes('本会话的汇报'), '不得把别的会话的汇报显示出来')
}

// ---- 开关 -----------------------------------------------------------------
{
  const off = await mountOverlay({ enabled: false, records: [rec()] })
  assert.equal(off.tree, null, '插件关闭时浮层不应出现')

  const overlayOff = await mountOverlay({ enabled: true, overlayEnabled: false, records: [rec()] })
  assert.equal(overlayOff.tree, null, 'overlayEnabled=false 时浮层不应出现，哪怕总开关是开的')
}

// ---- 等待态：到期立刻亮卡，且保留上一段汇报的原文 -------------------------
// 主窗口调子代理时，这个 step 可能挂好几分钟。等它结束再亮卡，用户早就
// 以为卡死了。所以到期那一刻（还没注入、模型还没开口）就该有卡片。
{
  // 第一次亮卡：还没汇报过，没有原文，只有"在等什么"
  const waiting = await mountOverlay({
    enabled: true,
    records: [rec({ text: '', pending: true, phase: 'working', waiting: '正在等子任务返回', waitingTool: 'subagent' })],
    runningMap: { 'sess-1': true },
    waitingMap: { 'sess-1': { label: '正在等子任务返回', tool: 'subagent', startedAt: Date.now() - 42 * 1000 } },
  })
  assert.ok(waiting.tree, '到期就该有卡片，不能等 step 边界')
  assert.ok(waiting.text.includes('等这一步跑完再汇总'), `标题应说明在等工具返回，实际：${waiting.text}`)
  assert.ok(waiting.text.includes('正在等子任务返回'), '应说清在等什么')
  assert.ok(waiting.text.includes('已经等了 42 秒'), `应报已等秒数，实际：${waiting.text}`)
  // 标题已经说了「等这一步跑完再汇总」，正文再补一句「等它返回后，这一步才会
  // 汇总」是同一句话说两遍，白占一行高度。用户明确要求去掉。
  assert.ok(
    !waiting.text.includes('才会汇总'),
    `正文不该重复标题已经说过的话，实际：${waiting.text}`,
  )
  assert.ok(
    !waiting.text.includes('等它返回后'),
    `正文不该重复标题已经说过的话，实际：${waiting.text}`,
  )

  // 已经汇报过一轮，又到期了：原文必须还在，不能变成空白卡
  const keepText = await mountOverlay({
    enabled: true,
    records: [
      rec({
        text: '我把三个候选插件的 README 读完了，正在核对它们各自挂的钩子。',
        pending: true,
        phase: 'working',
        waiting: '正在等子任务返回',
        waitingTool: 'subagent',
      }),
    ],
    runningMap: { 'sess-1': true },
    waitingMap: { 'sess-1': { label: '正在等子任务返回', tool: 'subagent', startedAt: Date.now() - 10 * 1000 } },
  })
  assert.ok(keepText.tree, '第二次到期也要有卡片')
  assert.ok(
    keepText.text.includes('我把三个候选插件的 README 读完了'),
    `上一段汇报的原文必须保留，实际：${keepText.text}`,
  )
  assert.ok(keepText.text.includes('正在等子任务返回'), '同时要说清这次在等什么')
  assert.ok(keepText.text.includes('等这一步跑完再汇总'), '标题应说明在等工具返回')

  // 已经在等模型憋汇报（phase=reporting）：说"正在整理汇报"，不是等待态标题
  const reporting = await mountOverlay({
    enabled: true,
    records: [rec({ text: '', pending: true, phase: 'reporting' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(reporting.tree, '等模型开口时卡片要继续挂着')
  assert.ok(reporting.text.includes('正在整理汇报'), `实际：${reporting.text}`)
  assert.ok(!reporting.text.includes('等这一步'), '不能把"正在整理汇报"说成等待态')

  // 等待态不会被停留时长吃掉：它描述的是"此刻"，不是一次已经说完的汇报
  const longWaiting = await mountOverlay({
    enabled: true,
    lingerSeconds: 90,
    records: [rec({ text: '', pending: true, phase: 'working', at: Date.now() - 10 * 60 * 1000 })],
    runningMap: { 'sess-1': false },
  })
  assert.ok(longWaiting.tree, 'pending 的卡不按停留时长消散')

  // 表格：模型爱在汇报里写 GFM 表格，原样渲染的话竖线会糊在正文里
  const tableReport = [
    '**两条回归测试用真实事件顺序**，变异验证：',
    '',
    '| 变异 | 报错 |',
    '| --- | --- |',
    '| 把 `delete` 挪回判空之前 | 「先调工具后说话的汇报原文不能丢」 |',
    '| 去掉时间闸 | 「超时之后窗口必须被丢掉」 |',
  ].join('\n')
  const withTable = await mountOverlay({
    enabled: true,
    records: [rec({ text: tableReport })],
    runningMap: { 'sess-1': true },
  })
  const tags = withTable.nodes.map((n) => n.type)
  assert.ok(tags.includes('table'), `表格必须渲染成真 table，实际标签：${tags.join(',')}`)
  assert.ok(tags.includes('th') && tags.includes('td'), '表头与单元格要分别成 th / td')
  const thTexts = withTable.nodes.filter((n) => n.type === 'th').map((n) => textOf(n).trim())
  assert.deepStrictEqual(thTexts, ['变异', '报错'], `表头不对：${JSON.stringify(thTexts)}`)
  const tdTexts = withTable.nodes.filter((n) => n.type === 'td').map((n) => textOf(n).trim())
  assert.strictEqual(tdTexts.length, 4, `两行两列应有 4 个单元格，实际：${JSON.stringify(tdTexts)}`)
  assert.ok(
    !withTable.nodes.some((n) => n.type === 'div' && typeof n.props?.children === 'string' && n.props.children.includes('| --- |')),
    '分割行不能被当成正文显示出来',
  )
  assert.ok(
    withTable.text.includes('把') && withTable.text.includes('不能丢'),
    '表格单元格里的文字要照常出现',
  )

  // 表头与分割行列数对不上（模型手滑写多了），不能硬认成表格把正文吃掉
  const badTable = await mountOverlay({
    enabled: true,
    records: [rec({ text: '| 甲 | 乙 |\n| --- |\n后续正文' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    !badTable.nodes.map((n) => n.type).includes('table'),
    '列数对不上的行不是表格，应退回纯文本',
  )
  assert.ok(badTable.text.includes('后续正文'), '认不出表格时正文一个字都不能丢')

  // 段中间的竖线不是表格：认错会把正常句子拆成格子
  const pipeMidText = await mountOverlay({
    enabled: true,
    records: [rec({ text: '先跑 a | b 再跑 c\n然后收尾' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    !pipeMidText.nodes.map((n) => n.type).includes('table'),
    '没有分割行的竖线是正文，不是表格',
  )
  assert.ok(pipeMidText.text.includes('a | b'), `正文里的竖线要原样保留，实际：${pipeMidText.text}`)

  // 第二行也带竖线，但不是分割行（没有连字符）：仍然不是表格。
  // 只靠「两行都有竖线」判表格的话，这种正文会被硬拆成格子。
  const notDivider = await mountOverlay({
    enabled: true,
    records: [rec({ text: '| 甲 | 乙 |\n这条也带竖线 | 但它不是分割行' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    !notDivider.nodes.map((n) => n.type).includes('table'),
    '第二行不是分割行就不能认成表格',
  )
  assert.ok(
    notDivider.text.includes('它不是分割行'),
    `认不出表格时原文要照常显示，实际：${notDivider.text}`,
  )

  // 反引号里的竖线：模型常写 `a|b` 这种管道运算符，它不能把单元格劈开
  const pipeInCode = await mountOverlay({
    enabled: true,
    records: [
      rec({
        text: '| 文件 | 说明 |\n| --- | --- |\n| `a|b` | 反引号里的竖线 |',
      }),
    ],
    runningMap: { 'sess-1': true },
  })
  const codeCells = pipeInCode.nodes.filter((n) => n.type === 'td').map((n) => textOf(n).trim())
  assert.deepStrictEqual(
    codeCells,
    ['a|b', '反引号里的竖线'],
    `反引号内的竖线不应当分隔符，实际单元格：${JSON.stringify(codeCells)}`,
  )
  assert.ok(
    pipeInCode.nodes.some((n) => n.type === 'code' && textOf(n) === 'a|b'),
    '单元格里的反引号要渲染成行内代码',
  )

  // ---- 行内标记 ----------------------------------------------------------
  const inline = await mountOverlay({
    enabled: true,
    records: [rec({ text: '**粗体**、*斜体*、`code`，还有 a * b 这种乘法' })],
    runningMap: { 'sess-1': true },
  })
  const inlineTags = inline.nodes.map((n) => n.type)
  assert.ok(inlineTags.includes('strong'), `**粗体** 要渲染成 strong，实际标签：${inlineTags.join(',')}`)
  assert.ok(inlineTags.includes('em'), `*斜体* 要渲染成 em`)
  assert.ok(inline.nodes.some((n) => n.type === 'code' && textOf(n) === 'code'), '行内代码照旧')
  const strongText = inline.nodes.filter((n) => n.type === 'strong').map(textOf).join('|')
  assert.strictEqual(strongText, '粗体', `strong 只该包住粗体内容，实际：${strongText}`)
  assert.ok(
    inline.text.includes('a * b'),
    `两侧空白的星号是乘法不是斜体，原文要留着，实际：${inline.text}`,
  )

  // 两个散落的星号配对最容易误伤：`1 * 2 和 3 * 4` 里的 ` 2 和 3 ` 不能被当成斜体。
  // 只有一个星号的乘法配不成对，判据坏掉也看不出来，所以这里必须用两个。
  const multiply = await mountOverlay({
    enabled: true,
    records: [rec({ text: '算了下 1 * 2 和 3 * 4 都是偶数' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    !multiply.nodes.map((n) => n.type).includes('em'),
    '两侧带空格的星号是乘法，不能配成斜体',
  )
  assert.ok(
    multiply.text.includes('1 * 2 和 3 * 4'),
    `乘法的星号一个都不能少，实际：${multiply.text}`,
  )

  // ---- 反引号成对计数 ----------------------------------------------------
  //
  // 想在正文里展示「代码里带反引号」的写法，人写的是 `` `x` ``（外层两个反引号）。
  // 逐字符配对的实现会拿第一个反引号去和第二个配，得到一个空代码块，真正的 x 漏成
  // 普通文字。开几个就必须闭几个。
  const nested = await mountOverlay({
    enabled: true,
    records: [rec({ text: '写法是 `` `x` `` 这样，还有 **粗** 和 *斜*' })],
    runningMap: { 'sess-1': true },
  })
  const codeBodies = nested.nodes.filter((n) => n.type === 'code').map(textOf)
  assert.deepStrictEqual(
    codeBodies,
    ['`x`'],
    `双反引号里包着单个反引号时，该整体是一个代码节点，实际：${JSON.stringify(codeBodies)}`,
  )
  assert.ok(
    !codeBodies.includes(''),
    '反引号配对不能配出空代码块',
  )
  assert.ok(
    nested.nodes.map((n) => n.type).includes('strong'),
    '双反引号后面的 **粗** 不能受影响',
  )
  assert.ok(
    nested.nodes.map((n) => n.type).includes('em'),
    '双反引号后面的 *斜* 不能受影响',
  )

  // 落单的反引号原样显示，不能吞掉后面的整段文字
  const strayTick = await mountOverlay({
    enabled: true,
    records: [rec({ text: '这里有个落单的反引号 ` 后面还有字' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    strayTick.text.includes('后面还有字'),
    `落单的反引号后面必须原样输出，实际：${strayTick.text}`,
  )

  // ---- 斜体两侧空白：两条判据各自单独生效 --------------------------------
  //
  // 这两条是冗余的防线，随便删一条，另一条通常还能兜住，所以要么就用「只有一条
  // 能兜住」的输入来测，否则变异测试看不出区别。
  //
  // ① 只测开头：`1 * 2 和 3* 4` 里第一个星号后面是空格（开头判据拦），但它
  //    到下一个星号之间是「2 和 3」，结尾不是空白（结尾判据兜不住）。
  const openSide = await mountOverlay({
    enabled: true,
    records: [rec({ text: '1 * 2 和 3* 4' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    !openSide.nodes.map((n) => n.type).includes('em'),
    `星号后面紧跟空格是乘法，不能起斜体，实际：${openSide.text}`,
  )
  assert.ok(openSide.text.includes('1 * 2 和 3* 4'), `原文一个字都不能少，实际：${openSide.text}`)

  // ② 只测结尾：`*abc *` 开头是字母（开头判据放行），但收尾在空格上，只能靠
  //    结尾判据拦住。
  const closeSide = await mountOverlay({
    enabled: true,
    records: [rec({ text: '写成 *abc * 这样' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    !closeSide.nodes.map((n) => n.type).includes('em'),
    `星号紧贴空格收尾是乘法，不能算斜体，实际：${closeSide.text}`,
  )
  assert.ok(closeSide.text.includes('*abc *'), `原文一个字都不能少，实际：${closeSide.text}`)

  // ---- 粗体中间不许夹星号 ------------------------------------------------
  //
  // `**a*b**` 里那对双星号如果一路配到底，会把 `a*b` 整个吞进 strong。宁可
  // 退回纯文本——粗体没认出来只是少了个视觉强调，吞掉星号是丢内容。
  const boldWithStar = await mountOverlay({
    enabled: true,
    records: [rec({ text: '写成 **a*b** 这样' })],
    runningMap: { 'sess-1': true },
  })
  const swallowed = boldWithStar.nodes.filter((n) => n.type === 'strong').map(textOf).join('|')
  assert.ok(
    !swallowed.includes('a*b'),
    `粗体不能把中间的星号一起吞掉，实际 strong 内容：${swallowed || '(无)'}`,
  )
  assert.ok(
    boldWithStar.text.includes('**a*b**') || boldWithStar.text.includes('*ab**'),
    `星号至少要原样留在正文里，实际：${boldWithStar.text}`,
  )

  // ---- 下划线不认 --------------------------------------------------------
  const underscores = await mountOverlay({
    enabled: true,
    records: [rec({ text: '改的是 `dsh_plugin_research` 下那几个文件' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    !underscores.nodes.map((n) => n.type).includes('em'),
    'snake_case 里的下划线不能被当成斜体',
  )
  assert.ok(
    underscores.nodes.some((n) => n.type === 'code' && textOf(n) === 'dsh_plugin_research'),
    '下划线标识符要原样留在行内代码里',
  )

  // ---- 标题与列表 --------------------------------------------------------
  const structured = await mountOverlay({
    enabled: true,
    records: [
      rec({
        text: [
          '## 已完成的工作',
          '',
          '改了三处：',
          '',
          '- 浮层标题不再重复',
          '- 底栏补底色',
          '1. 先跑测试',
          '2. 再同步副本',
        ].join('\n'),
      }),
    ],
    runningMap: { 'sess-1': true },
  })
  const structTags = structured.nodes.map((n) => n.type)
  assert.ok(structTags.includes('h2'), `## 要渲染成 h2，实际标签：${structTags.join(',')}`)
  assert.ok(!structured.text.includes('##'), '标题的井号不能再显示出来')
  assert.ok(structured.text.includes('已完成的工作'), '标题文字要留着')
  const listMarks = structured.nodes
    .filter((n) => n.props?.className === 'narr-overlay-li-mark')
    .map((n) => textOf(n))
  assert.deepStrictEqual(
    listMarks,
    ['•', '•', '1.', '2.'],
    `列表标记不对：${JSON.stringify(listMarks)}`,
  )

  // 标记后没空格的是正文，不是列表
  const notList = await mountOverlay({
    enabled: true,
    records: [rec({ text: '-3 度到 5 度\n#不是标题' })],
    runningMap: { 'sess-1': true },
  })
  assert.ok(
    !notList.nodes.some((n) => n.props?.className === 'narr-overlay-li-mark'),
    '`-3 度` 是正文，标记后没空格不能当列表',
  )
  assert.ok(
    !notList.nodes.map((n) => n.type).includes('h1'),
    '`#不是标题` 没有空格，不能当标题',
  )
  assert.ok(notList.text.includes('-3 度'), `正文一个字都不能丢，实际：${notList.text}`)
}

console.log('client-render probe: 全部通过')
