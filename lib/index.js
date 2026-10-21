/**
 * dsh-narrator —— 长思考时让模型自己说一句
 *
 * 解决的问题：模型长时间干活（连续思考、连续调工具）时，界面上很久没有正文，
 * 用户不知道它到底在干什么、是不是卡住了。
 *
 * 宿主的硬约束（`dsh-agent-loop` 的 turn 循环原文）：
 *   `if (turnEnds && decision.messages.length === 0) break;`
 * 也就是说，模型若单独发一条不带工具调用的纯文本想"先说明一下"，宿主会判定
 * 本回合已完成并关闭回合——任务被迫中断。这正是早期版本踩过的坑。
 *
 * 因此本插件不改模板、不拼卡片，而是**把"该汇报了"这件事交给模型自己说**：
 *
 *   ① 计时 —— 挂 `agent/assistant-stream`，持续统计"距最后一次正文输出过了多久"。
 *      工具调用不算可见输出（密集调工具恰恰是最该汇报的场景）。
 *
 *   ② 注入 —— 静默超过阈值时**不当场插话**（那时可能正卡在两次工具调用之间），
 *      只在状态里记一个"待汇报"标记；等到下一个 step 边界，在 `agent/pre-step`
 *      这个 waterfall 里把一条"请汇报这四点"的 user 消息并入本步消息批次。
 *      消息带 `source.form = 'notice'`，宿主投影为 context 节点，默认在界面上
 *      不显示——模型照样读得到。
 *
 *   ③ 浮窗 —— 模型真的开口之后，把它的**原文**截下来（注入后的第一个 step 里、
 *      首个工具调用之前的正文段），送到对话区左下角浮窗。不拼模板、不改写、不总结。
 *
 * 与 `dsh-thinking-guard`（熔断 cancel）方向相反：那个是掐断，这个是"先问一句再继续"。
 *
 * @module dsh-narrator
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

import { loadOverride, mergeOverride, saveOverride } from './config-store.js'

export const name = 'narrator'

/**
 * 读自身 package.json 的版本号。
 *
 * 不要在这里写死字符串：status 路由是排查「宿主到底加载了哪份代码」的唯一手段，
 * 版本一旦对不上就会把「跑的是旧代码」误判成「功能没生效」。读不到就返回
 * 'unknown'，让自检明确暴露异常，而不是给出一个看起来正常的假版本。
 * @returns {string} 版本号，读不到时为 'unknown'
 */
function readOwnVersion() {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''))
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export const VERSION = readOwnVersion()

// 事件总线走 ctx.on，不需要注入任何服务；webServer 在 apply 里按需 inject。
export const inject = []

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

export const DEFAULTS = Object.freeze({
  /** 总开关：让模型在长时间没说话时主动汇报一次 */
  enabled: true,
  /** 同时把汇报原文弹到对话区左下角浮窗 */
  overlayEnabled: true,
  /** 在对话里显示注入的提示词原文（默认关：那是给模型的指令，不是给人看的） */
  showInjected: false,
  /** 距最后一次正文输出多少秒后安排一次汇报；60 = 界面最小档 1 分钟 */
  silentSeconds: 60,
  /** 两次汇报之间的最小间隔（秒） */
  cooldownSeconds: 60,
  /** 单个回合最多汇报几次（0 表示不限，由冷却兜底） */
  maxPerTurn: 0,
  /** 浮窗在模型说完之后继续停留多少秒 */
  lingerSeconds: 90,
  /**
   * 浮窗透明度（0~1）。
   * 1 = 完全不透明。太低会让文字糊在背景上，所以下限给 0.35。
   */
  overlayOpacity: 1,
  /**
   * 是否也让子代理各自汇报。
   *
   * 默认 **关闭**：子代理的会话在界面上根本看不到，往里注入汇报纯属浪费一次
   * 模型调用。主窗口在等子代理时该不该出旁白是另一回事——那时主 agent 自己
   * 的静默计时照常在跑，子代理跑得越久，主窗口越该提示"还在等"。
   */
  includeSubagents: false,
  locale: 'zh',
  /** 自定义注入提示词；null 表示按 locale 取内置默认 */
  prompt: null,
  /**
   * 测试模式：打开后用 `testSilentSeconds` / `testCooldownSeconds` 顶替
   * `silentSeconds` / `cooldownSeconds`，好让人在几秒内就能看见触发，
   * 不必等一分钟。**只覆盖这两个时长**，其余配置一律照旧——这样关掉测试
   * 模式后，正常配置原封不动。
   */
  testMode: false,
  /** 测试模式的静默阈值（秒，1~60） */
  testSilentSeconds: 5,
  /** 测试模式的冷却（秒，1~60） */
  testCooldownSeconds: 10,
})

/**
 * 内置注入提示词（中文）。
 *
 * 写法上刻意贴近"用户中途插一句话"：先让模型停一下，再按四点说清楚，
 * 最后明确要求"说完继续"，避免它把这次汇报当成任务终点。
 *
 * 为什么是这四点：这是模型在被人打断问"现在什么情况"时自然给出的结构，
 * 比要求它"输出结构化报告"更不容易被敷衍成一句"正在处理中"。
 */
export const DEFAULT_PROMPT_ZH = [
  '先停一下，用一段正文说明当前进展，然后立刻继续手上的工作。',
  '',
  '请按这四点回答：',
  '1. 你现在正在做什么；',
  '2. 已经完成了什么（具体到改了哪个文件、跑了什么命令、得到什么结论）；',
  '3. 接下来准备做什么；',
  '4. 有没有卡住或不确定的地方。',
  '',
  '要求：写结论，不要罗列工具名；这是中途汇报，说完必须继续执行，不要结束任务。',
].join('\n')

export const DEFAULT_PROMPT_EN = [
  'Pause briefly and describe your progress in prose, then continue the work immediately.',
  '',
  'Answer these four points:',
  '1. What you are doing right now;',
  '2. What you have completed (which files changed, which commands ran, what you concluded);',
  '3. What you plan to do next;',
  '4. Anything blocking or uncertain.',
  '',
  'Requirements: state conclusions, not tool names; this is a mid-task update — keep going afterwards, do not end the task.',
].join('\n')

/**
 * 注入消息的来源标记。
 *
 * `form: 'notice'` 让宿主把它投影成 context 节点，`isVisibleChatNode` 会把它
 * 从可见对话行里排除（原文：`node.kind !== 'context' || ...`），所以默认不出现在
 * 界面上——但模型照样读得到。想要看见注入原文时，改用 `kind: 'user'`。
 */
export const INJECT_SOURCE_NOTICE = Object.freeze({
  kind: 'narrator',
  form: 'notice',
  summary: '要求汇报当前进度',
})

export const INJECT_SOURCE_VISIBLE = Object.freeze({ kind: 'user' })

// ---------------------------------------------------------------------------
// 配置归一化
// ---------------------------------------------------------------------------

function unwrap(value) {
  // Cordis 的配置可能是响应式引用（有 .get()）
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return value
    }
  }
  return value
}

function num(value, fallback, min = 0) {
  const n = Number(unwrap(value))
  if (!Number.isFinite(n) || n < min) return fallback
  return n
}

export const TEST_SECONDS_MIN = 1
export const TEST_SECONDS_MAX = 60

/** 测试模式的秒数：整数、夹在 1~60 */
function clampSeconds(value, fallback) {
  const n = Number(unwrap(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(TEST_SECONDS_MAX, Math.max(TEST_SECONDS_MIN, Math.round(n)))
}

export const OVERLAY_OPACITY_MIN = 0.35
export const OVERLAY_OPACITY_MAX = 1

/**
 * 浮窗停留时长的量程（秒）。
 *
 * 下限 5 秒：再短用户还没读完标题就没了。
 * 上限 600 秒：够长，但不给「永不消失」的口子，否则浮窗会变成钉子户。
 * 前端 `lib/client.js` 的 `LINGER_SECONDS_MIN/MAX` 必须与这里保持一致。
 */
export const LINGER_SECONDS_MIN = 5
export const LINGER_SECONDS_MAX = 600

function clampLinger(value, fallback) {
  const raw = unwrap(value)
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  // 非正数是「写错了」，不是「设得太短」：回落到默认值，别悄悄夹成 5 秒。
  // 只有正数才按量程夹紧（比如 9999 秒 → 600 秒）。
  if (n <= 0) return fallback
  return Math.min(LINGER_SECONDS_MAX, Math.max(LINGER_SECONDS_MIN, Math.round(n)))
}

function clampOpacity(value) {
  const raw = unwrap(value)
  // `Number(null) === 0`、`Number('') === 0`、`Number(false) === 0` 都是有限值，
  // 若直接走后面的夹紧会把「没配过」当成「想调到最透明」，配置里缺这个键时
  // 就凭空变成 0.35 而不是默认的 1。先排掉这些「压根没给数」的形态。
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
    return DEFAULTS.overlayOpacity
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULTS.overlayOpacity
  const clamped = Math.min(OVERLAY_OPACITY_MAX, Math.max(OVERLAY_OPACITY_MIN, n))
  // 保留两位：滑杆是 0.05 一档，多余的精度只会让配置文件变脏
  return Math.round(clamped * 100) / 100
}

function str(value, fallback) {
  const raw = unwrap(value)
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * 归一化配置。三层来源（DEFAULTS / cordis.patch.yml / 设置页覆盖层）合成后
 * 都要过这一道，保证任何一处写错值都不会让插件跑飞。
 * @param {object} [raw] 原始配置
 * @returns {object} 可直接使用的配置
 */
export function normalizeConfig(raw = {}) {
  const root = unwrap(raw) ?? {}
  const input = typeof root === 'object' ? root : {}
  const locale = unwrap(input.locale) === 'en' ? 'en' : 'zh'
  const zh = locale === 'zh'

  // 测试模式只覆盖「两个时长」，其余一律照旧。这样关掉测试模式时，
  // 正常配置连一个字节都没被改过——不会出现「测完发现阈值变成 5 秒」。
  const testMode = unwrap(input.testMode) === true
  const normalSilent = num(input.silentSeconds, DEFAULTS.silentSeconds, 0.001)
  const normalCooldown = num(input.cooldownSeconds, DEFAULTS.cooldownSeconds, 0)
  const testSilent = clampSeconds(unwrap(input.testSilentSeconds), DEFAULTS.testSilentSeconds)
  const testCooldown = clampSeconds(unwrap(input.testCooldownSeconds), DEFAULTS.testCooldownSeconds)

  return {
    enabled: unwrap(input.enabled) !== false,
    overlayEnabled: unwrap(input.overlayEnabled) !== false,
    showInjected: unwrap(input.showInjected) === true,
    silentSeconds: testMode ? testSilent : normalSilent,
    cooldownSeconds: testMode ? testCooldown : normalCooldown,
    testMode,
    testSilentSeconds: testSilent,
    testCooldownSeconds: testCooldown,
    /** 未被测试模式覆盖的真实配置，设置卡回填用 */
    normalSilentSeconds: normalSilent,
    normalCooldownSeconds: normalCooldown,
    maxPerTurn: num(input.maxPerTurn, DEFAULTS.maxPerTurn, 0),
    lingerSeconds: clampLinger(input.lingerSeconds, DEFAULTS.lingerSeconds),
    // `=== true` 而不是 `!== false`：没配置过（undefined）时必须回落到
    // DEFAULTS 的 false。写成 `!== false` 会让「没配过」被当成「打开」，
    // 与 DEFAULTS 相反——曾经就是这样，子代理一直跟着汇报。
    includeSubagents: unwrap(input.includeSubagents) === true,
    overlayOpacity: clampOpacity(input.overlayOpacity),
    locale,
    prompt: str(input.prompt, zh ? DEFAULT_PROMPT_ZH : DEFAULT_PROMPT_EN),
  }
}

// ---------------------------------------------------------------------------
// 纯函数（导出以便单测）
// ---------------------------------------------------------------------------

/**
 * 判断一个 agent 是不是子代理。
 *
 * 子代理的会话用户在界面上看不到，但它同样会长时间跑；`includeSubagents`
 * 打开时它们各算各的进度，互不干扰。
 *
 * **不能只看 `parentSession`。** 分支会话（从某个对话「分叉」出来的新会话）
 * 同样带 `parentSession`，但它是用户在界面上正常查看的主会话。曾经把
 * 「有 parentSession」当子代理，结果用户在本窗口里看到的一切播报都被拦掉，
 * 自检里 `skipped.subagent` 涨到二十七万——那条判据是错的。
 *
 * 一手实证（扫过 58 个会话存档的 header）：
 *   - 分支会话：`origin=undefined`，`parentSession=<某个主会话>`，`isSeeded=true`
 *   - 真子代理：`origin='subagent'`，`parentSession=<主会话>`，`delegationDepth=1`
 * 所以判据是 `origin === 'subagent'`，`parentSession` 只能作为**辅助**条件：
 * 宿主自己的 `hasApiSessionSubagentOwner` 也是先看 origin，再看父子归属关系。
 * @param {object} agent agent 对象
 * @returns {boolean} 是否子代理
 */
export function isSubagent(agent) {
  if (!agent || typeof agent !== 'object') return false

  const header = agent.session?.header
  if (header !== null && typeof header === 'object') {
    // 唯一可靠判据：宿主给真子代理写 `origin: 'subagent'`。
    if (header.origin === 'subagent') return true
    // 有 parentSession 但没有 origin，是**分支会话**，不是子代理。
    // 只有当它同时还标着非零委派层级时才算（宿主对子代理会话会写 depth>=1）。
    if (header.parentSession !== undefined && header.parentSession !== null) {
      return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
    }
  }

  // 下面几条是给非宿主环境（测试桩、其它实现）留的宽松判据。
  // 真实宿主上它们恒为 false，所以不能只靠它们。
  if (agent.parent != null && agent.parent !== agent) return true
  if (typeof agent.parentSessionId === 'string' && agent.parentSessionId !== '') return true
  if (agent.kind === 'subagent' || agent.role === 'subagent') return true
  return false
}

/**
 * 从一段流式正文里取出"该给用户看的那一段"。
 *
 * 模型被要求汇报后，通常会先说一段正文、紧接着就调工具。截取规则就是
 * 「首个工具调用之前的全部正文」，再压掉首尾空白。
 * @param {string} buffer 累积的正文
 * @returns {string} 处理后的正文，没有内容时为空串
 */
export function finalizeCapture(buffer) {
  if (typeof buffer !== 'string') return ''
  const text = buffer.trim()
  return text === '' ? '' : text
}

// ---------------------------------------------------------------------------
// createUserMessage；宿主包按候选路径动态解析
// ---------------------------------------------------------------------------

const LLM_CANDIDATES = [
  process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js')
    : null,
  path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? '',
    '.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
  ),
].filter((p) => typeof p === 'string' && p !== '')

let createUserMessageImpl = null

async function resolveCreateUserMessage() {
  if (createUserMessageImpl !== null) return createUserMessageImpl
  const anchors = [process.argv[1], ...LLM_CANDIDATES].filter(Boolean)
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      const resolved = req.resolve('@deepseek-ai/dsh-llm')
      const mod = await import(pathToFileURL(resolved).href)
      if (typeof mod.createUserMessage === 'function') {
        createUserMessageImpl = mod.createUserMessage
        return createUserMessageImpl
      }
    } catch {
      // 换下一个锚点
    }
  }
  createUserMessageImpl = (input) => ({
    ...input,
    id: randomUUID(),
    role: 'user',
  })
  return createUserMessageImpl
}

/** 测试用：把缓存清掉，方便注入桩实现。 */
export function __resetCreateUserMessage() {
  createUserMessageImpl = null
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 挂载进度旁白。
 * @param {object} ctx Cordis 插件上下文
 * @param {object} [config] 插件配置
 */
export function apply(ctx, config) {
  /**
   * 用户覆盖层（设置页保存的值）。异步加载完成后替换引用；
   * 在那之前所有读取自动退回基础层，不需要等待。
   * @type {object}
   */
  let override = {}
  /** @type {Promise<void>|null} 首次加载的 promise，保证并发保存不打架 */
  let loading = null

  /** 基础层 + 覆盖层合成后的原始配置。 */
  const rawConfig = () => mergeOverride(unwrap(config) ?? {}, override, CONFIG_KEYS)

  /** 合成后归一化的配置。 */
  const effectiveConfig = () => normalizeConfig(rawConfig())

  /** @type {Map<string, object>} 每个 session 一个静默计时状态 */
  const states = new Map()
  /** @type {Map<string, {lastInjectAt: number, byTurn: Map<number, number>}>} 限频账本 */
  const ledgers = new Map()

  /**
   * 每个会话最近一次汇报的快照，供浏览器半侧的浮层读取（`/api/narrator/latest`）。
   *
   * **按会话维度存**：浮层只该出现在正在长思考的那一个对话窗口里，
   * 用户在 A 会话思考时切到 B 会话，B 不该冒出 A 的进度。
   * @type {Map<string, {text: string, turn: number, step: number, at: number, silentSeconds: number}|[]>}
   */
  const latestBySession = new Map()

  /**
   * 正在截取模型汇报的状态。
   *
   * 注入之后模型可能先思考再说话，也可能说一句就直接调工具。这里在
   * `assistant-stream` 上跟着走：一旦开始出正文就累积，遇到第一个工具调用
   * 或 step 结束就收口——那一段就是模型的汇报原文。
   * @type {Map<string, {buffer: string, turn: number, step: number, at: number}>}
   */
  const captures = new Map()

  /**
   * 截取窗口最长挂多久（毫秒）。
   *
   * 注入之后模型可能先把手上的活干完才开口，窗口要一直等着；但它不能无限
   * 等下去——一个注入后彻底沉默的会话会把缓冲区永远留在内存里。
   */
  const CAPTURE_MAX_MS = 10 * 60 * 1000

  /**
   * 浮层记录最多保留几条。
   *
   * `/api/narrator/latest` 每 2 秒被前端轮询一次，会把 `latestBySession`
   * **全量**下发（前端要本地判"我现在看的是哪个会话"）。只增不减会让
   * 每 2 秒都推一份越来越大的响应体，而其中绝大多数是早已结束的陈旧会话。
   */
  const LATEST_MAX_SESSIONS = 8

  /**
   * 正在执行中的工具调用（每个会话一份），供浮窗显示「还在等什么」。
   *
   * 主窗口调子代理时，整个子任务期间主 agent 自己的流是静的：模型既没有
   * 正文输出，也没有工具调用完成。这时静默计时照常跑，到点后 `pre-step`
   * 迟早在子代理返回后触发，但用户在那之前什么都看不到——浮窗需要一条
   * 「正在等 subagent 返回」这类信息才说明得清他为什么在等。
   * @type {Map<string, {callId: string, name: string, startedAt: number}>}
   */
  const runningTools = new Map()

  /**
   * 从工具名推一句「在等什么」。只做本地推导，不猜内容。
   * @param {string} name 工具名
   * @returns {string|null} 等待中的描述，不适用时返回 null
   */
  function waitingLabel(name) {
    if (typeof name !== 'string' || name === '') return null
    if (/^(subagent|subagent_fork|spawn_teammate|workflow|task)$/.test(name)) return '正在等子任务返回'
    if (/^(web_search|web_fetch|read_page|x_search|modlens_read_image)$/.test(name)) return '正在查外部资料'
    if (/^(ops_bash|bash|pwsh|shell|pty|job_)/.test(name)) return '正在跑命令'
    if (/^(ops_read|read|ops_grep|grep|ops_glob|glob)/.test(name)) return '正在读文件'
    return null
  }

  /** 写入浮层记录，并按 `at` 淘汰最旧的几条。 */
  const rememberLatest = (sessionId, record) => {
    latestBySession.set(sessionId, record)
    if (latestBySession.size <= LATEST_MAX_SESSIONS) return
    const stale = [...latestBySession.entries()]
      .sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0))
      .slice(0, latestBySession.size - LATEST_MAX_SESSIONS)
    for (const [key] of stale) latestBySession.delete(key)
  }

  /**
   * 运行期自检计数：通过 /api/narrator/status 暴露，用来回答
   * 「插件到底有没有收到流事件 / 定时器有没有到期 / 为什么没注入」。
   */
  const stats = {
    startFrames: 0,
    chunkFrames: 0,
    endFrames: 0,
    ticks: 0,
    preSteps: 0,
    skipped: {
      disabled: 0,
      subagent: 0,
      cooldown: 0,
      maxPerTurn: 0,
      notSilent: 0,
      /** pre-step 来了但没有任何会话处于"待汇报"状态 */
      notDue: 0,
      /** 找不到 agent / session / decision 结构 */
      badShape: 0,
      /** 浮层通道被关掉 */
      overlayOff: 0,
    },
    /** 成功注入提示词的次数 */
    injected: 0,
    /** 成功截到模型汇报原文的次数 */
    captured: 0,
    lastInjectAt: null,
    lastCaptureAt: null,
    lastError: null,
    lastTickAt: null,
    // 观测「阈值是不是设得太高」用：记录每个 step 从 start 到 end 的实际时长，
    // 给出最大值/均值。如果最长 step 都远小于 silentSeconds，说明功能永远不会触发，
    // 这时候该调的是阈值，而不是继续怀疑插件坏了。
    stepsSeen: 0,
    maxStepMs: 0,
    totalStepMs: 0,
    lastStepMs: null,
  }
  const bump = (key) => {
    stats.skipped[key] = (stats.skipped[key] ?? 0) + 1
  }

  /**
   * 记录一个 step 的生命周期长度。
   * @param {number} ms 从 start 到 end 的毫秒数
   */
  function recordStepDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return
    stats.stepsSeen += 1
    stats.totalStepMs += ms
    stats.lastStepMs = Math.round(ms)
    if (ms > stats.maxStepMs) stats.maxStepMs = Math.round(ms)
  }
  /** 当前观察窗口里最长 step 的时长（毫秒 → 秒，保留一位）。 */
  const maxStepSeconds = () => Math.round(stats.maxStepMs / 100) / 10
  /**
   * 平均 step 时长（毫秒 → 秒，保留一位）。
   * 口径必须与 maxStepSeconds 完全一致，否则会出现「平均值大于最大值」这种
   * 一眼假的数据（曾因为多乘了 10 再除 1000，把 4.6 秒报成 46.14 秒）。
   */
  const avgStepSeconds = () =>
    stats.stepsSeen === 0 ? 0 : Math.round(stats.totalStepMs / stats.stepsSeen / 100) / 10

  const log = (level, ...args) => {
    try {
      ctx.logger?.[level]?.(...args)
    } catch {
      // 日志永不阻断主流程
    }
  }

  function ledgerOf(sessionId) {
    let l = ledgers.get(sessionId)
    if (l === undefined) {
      l = { lastInjectAt: 0, byTurn: new Map() }
      ledgers.set(sessionId, l)
    }
    return l
  }

  /**
   * 组装自检快照。status 路由和测试共用同一份，避免两边字段漂移。
   * @returns {object} 对外可见的运行期状态
   */
  function snapshot() {
    return {
      ok: true,
      version: VERSION,
      name,
      config: publicConfig(),
      stats: {
        ...stats,
        skipped: { ...stats.skipped },
        // 便于人眼判断「阈值是不是设得太高」
        maxStepSeconds: maxStepSeconds(),
        avgStepSeconds: avgStepSeconds(),
      },
      active: states.size,
      due: [...states.values()].filter((st) => st.due === true).length,
    }
  }

  /** 清掉某个 attempt 的定时器。 */
  function clearState(st) {
    if (st?.timer != null) {
      clearTimeout(st.timer)
      st.timer = null
    }
  }

  /**
   * 每个会话「主窗口最后一次自己说出正文」的时刻，供浮窗判断该不该撤。
   *
   * 为什么需要它：浮窗展示的是「模型长时间不说话时的一段汇报」。一旦模型
   * 重新开口，用户已经有新东西可看，那张卡就该退场。原来前端只能靠
   * `running`（会话还在跑吗）来决定去留，可任务往往连着跑十几分钟，浮窗
   * 于是永不消失。
   *
   * 判据只能来自 `assistant-stream` 的 `text-delta`，不能靠 DOM：
   *   - **汇报原文本身不算**。写入浮窗记录时会把当时的 `lastTextAt` 冻结
   *     进记录（见 `rememberLatest` 调用处），前端比的是"记录之后又说过话
   *     没有"，所以记录那一刻的内容不会把自己撤掉。
   *   - **子代理不算**。`onStream` 一开始就把子会话挡掉了（`includeSubagents`
   *     为假时直接 return），所以这里天然只含主窗口。
   * @type {Map<string, number>}
   */
  const lastTextAt = new Map()

  /** 安排下一次静默检查。 */
  function schedule(agent, st, delayMs) {
    clearState(st)
    const timer = setTimeout(() => {
      st.timer = null
      try {
        tick(agent, st)
      } catch (error) {
        log('warn', '[narrator] tick failed: %s', String(error))
      }
    }, Math.max(0, delayMs))
    // 定时器不应阻止进程退出
    if (typeof timer.unref === 'function') timer.unref()
    st.timer = timer
  }

  /**
   * 定时器到点：判断是否该安排一次汇报。
   *
   * 注意这里**不注入**，只置 `st.due`。原因是"该汇报了"这个判断发生时，
   * 模型往往正卡在两次工具调用之间，此时往会话里塞消息会落在
   * assistant(tool_calls) 与 tool 结果之间，宿主会直接报错。
   * 真正的注入点在下一次 `agent/pre-step`。
   */
  function tick(agent, st) {
    const cfg = effectiveConfig()
    if (!cfg.enabled) {
      bump('disabled')
      return
    }

    stats.ticks += 1
    stats.lastTickAt = new Date().toISOString()

    const now = Date.now()
    const silentMs = now - st.lastVisibleAt
    if (silentMs < cfg.silentSeconds * 1000) {
      bump('notSilent')
      schedule(agent, st, cfg.silentSeconds * 1000 - silentMs)
      return
    }

    // 已经排过一次、还没等到 step 边界：不要重复排期，等 pre-step 取走
    if (st.due === true) return

    const sessionId = st.sessionId
    const ledger = ledgerOf(sessionId)
    if (cfg.cooldownSeconds > 0 && now - ledger.lastInjectAt < cfg.cooldownSeconds * 1000) {
      bump('cooldown')
      schedule(agent, st, cfg.cooldownSeconds * 1000 - (now - ledger.lastInjectAt))
      return
    }
    const used = ledger.byTurn.get(st.turn) ?? 0
    // maxPerTurn = 0 表示不限：长时间静默应当持续续报，由冷却负责限流
    if (cfg.maxPerTurn > 0 && used >= cfg.maxPerTurn) {
      bump('maxPerTurn')
      schedule(agent, st, 15_000)
      return
    }

    st.due = true
    st.dueAt = now
    st.dueSilentMs = silentMs

    // 到点了，但真正的注入要等下一个 step 边界——主窗口在等子代理（或任何
    // 长时间工具）时，这一等可能是好几分钟，期间界面上什么都不动，用户根本
    // 不知道是卡死了还是在跑。
    //
    // 浮窗是纯前端通道，不往会话里写任何东西，所以这里可以立刻亮出来。
    // 等模型在下一个 step 边界终于开口，`commitCapture` 会用它的原话替换掉这张。
    if (cfg.overlayEnabled) {
      const prev = latestBySession.get(sessionId)
      const tool = runningTools.get(sessionId)
      // 关键：**保留上一段汇报的原文**。
      // 早期这里直接写一条 `text: ''` 的新记录，结果是：模型刚汇报完，静默
      // 计时重新起算，到点后那张卡"啪"地变成空白——用户眼前的信息反而变少
      // 了。原文留着，只把 `pending` 打开，界面会在这段原文下面补一行
      // "正在等什么"，讲清楚这次又在等。
      //
      // `phase` 不能无脑写成 working：模型已经拿到「请汇报」的提示、正憋着
      // 那段话时（reporting），这段静默恰恰是它在整理汇报，界面上该说「正在
      // 整理汇报」而不是「还在等」。只有本来就没在等汇报，才回落到 working。
      //
      // **已经注入过（`injectedAt` 有值）就必须留在 reporting。**
      //
      // 踩过的坑：注入把卡推进到 reporting，紧接着本函数又被排期跑一次
      // （冷却到了、模型还没开口），`prev.phase === 'reporting'` 本该保住它，
      // 但若那一次 `prev` 取到的是注入前的快照，就会写回 working——界面上
      // 明明已经在等模型开口，却退回成「还在等」，让人以为提示没发出去。
      // 以 `injectedAt` 为准：它是"提示已经送进会话"的硬证据，比 phase 可靠。
      const alreadyInjected = typeof prev?.injectedAt === 'number'
      rememberLatest(sessionId, {
        ...(prev ?? {}),
        pending: true,
        phase: alreadyInjected || prev?.phase === 'reporting' ? 'reporting' : 'working',
        turn: st.turn,
        step: st.step,
        // 第一次亮卡才定 `at`：它是「用户点关闭」的识别键，也是停留计时
        // 的起点。已经有过一条记录时沿用旧值，免得用户关掉的卡又冒出来。
        at: prev === undefined ? now : prev.at,
        // **重新亮卡时必须刷新 textAt 基准。**
        //
        // 前端的撤卡判据是「现在的最后正文时刻 > 记录里的 textAt」。若这里
        // 沿用旧记录的 textAt（`...(prev ?? {})` 会带过来），而 textAtMap 早已
        // 推进到模型后来说过的话，那么卡一立起来就被判定为"模型又开口了"，
        // 立刻撤掉——表现为浮窗永远闪一下就没。
        //
        // 取 `now`：这张卡诞生在"最后一次正文之后又静默了这么久"的时刻，
        // 此前所有正文都已经被听见了，不该再拿它们当撤卡理由。
        textAt: now,
        silentSeconds: Math.max(1, Math.round(silentMs / 1000)),
        waiting: tool === undefined ? null : waitingLabel(tool.name),
        waitingTool: tool === undefined || tool.name === '' ? null : tool.name,
      })
    }
    log('info', '[narrator] due at turn=%s step=%s silent=%ss', st.turn, st.step, Math.round(silentMs / 1000))
  }

  /**
   * 把模型的汇报原文收口，送进浮窗。
   * @param {string} sessionId 会话 id
   */
  function commitCapture(sessionId) {
    const cap = captures.get(sessionId)
    if (cap === undefined) return
    const text = finalizeCapture(cap.buffer)
    if (text === '') {
      // 模型这一轮只调了工具、还没开口。**不能把截取窗口关掉**。
      //
      // 注入发生在 step 边界，而模型收到「请汇报」之后常常先把手上的活干完，
      // 隔一两步才真的开口。早先这里是无条件 `captures.delete`，于是第一个
      // `tool-call-delta`（缓冲区还空着）就把窗口收了；等模型真说话时
      // `captures.get` 已经拿不到东西，那段汇报走了「自主发言」分支，既进不了
      // 浮窗、又推进 `lastTextAt` 把卡片撤掉——多 step 场景下 `captured` 恒为 0
      // 就是这么来的。
      //
      // 保留窗口等它开口，但加一道时间闸：注入之后迟迟不说话的会话不能把
      // 缓冲区永远挂在那里。
      if (Date.now() - cap.at > CAPTURE_MAX_MS) captures.delete(sessionId)
      // 那张"正在整理汇报"的卡不能一直挂着——它会让用户以为模型还在憋一段话。
      // 退回"还在等"，等正文真的来了再替换。
      const prev = latestBySession.get(sessionId)
      if (prev !== undefined && prev.pending === true && prev.phase === 'reporting') {
        rememberLatest(sessionId, { ...prev, phase: 'working' })
      }
      return
    }
    captures.delete(sessionId)
    // 浮层通道单独关掉时，注入照旧发生（模型仍然要汇报），但这段原文不该
    // 进浮层记录：否则前端虽然会撤卡，`/latest` 的响应体里仍带着会话内容。
    if (!effectiveConfig().overlayEnabled) {
      bump('overlayOff')
      return
    }
    const now = Date.now()
    // 「正在等什么」只在截取这一刻取一次并冻结进记录：之后工具可能已经返回，
    // 但用户看到的那张卡讲的正是"他等的那阵子在等什么"，跟着实时变会前后矛盾。
    const tool = runningTools.get(sessionId)
    rememberLatest(sessionId, {
      text,
      turn: cap.turn,
      step: cap.step,
      at: now,
      // 这条记录诞生的那一刻，主窗口最后一次自己说话是什么时候。
      //
      // 前端拿它跟实时 `textAt` 比：比它**更新**就说明模型在写这段汇报之后
      // 又开口了，浮窗该撤。把它冻结进记录（而不是前端拿 `at` 去比）是因为
      // 汇报原文本身也是一串 `text-delta`——若只比 `at`，模型刚写完汇报、
      // 前端一算"有新正文了"，浮窗会在你读到之前就消失。
      // 正常情况下它就等于 `now`（`commitCapture` 在最后一个 text-delta 之后
      // 的 tool-call-delta / step end 触发），取到 null 时回落到 `now`。
      textAt: lastTextAt.get(sessionId) ?? now,
      // 触发这次汇报时已经静默了多久。不能用 (now - cap.at)，那是"模型憋了
      // 多久才开口"，与本句要表达的「已经多久没有文字输出」不是一回事。
      silentSeconds: Math.max(1, Math.round((cap.silentMs ?? 0) / 1000)),
      /** 模型开口之前，这个会话正卡在哪个工具上（没有则为 null） */
      waiting: tool === undefined ? null : waitingLabel(tool.name),
      waitingTool: tool === undefined || tool.name === '' ? null : tool.name,
    })
    stats.captured += 1
    stats.lastCaptureAt = new Date(now).toISOString()
  }

  /**
   * step 边界上的注入点。
   *
   * `agent/pre-step` 是 waterfall：`await next()` 拿到下游（含宿主 fallback）
   * 组装好的决策，再把我们的消息并进去。因为是在决策定型之后追加，
   * 既不破坏宿主已经算好的 runtime context，也不受其它插件的影响。
   */
  async function onPreStep(payload, next) {
    const decision = await next()
    stats.preSteps += 1

    try {
      const cfg = effectiveConfig()
      if (!cfg.enabled) {
        bump('disabled')
        return decision
      }

      const agent = payload?.agent
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        bump('badShape')
        return decision
      }
      if (!cfg.includeSubagents && isSubagent(agent)) {
        bump('subagent')
        return decision
      }
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') {
        // 宿主已经决定不进入这一步（reject），不该往里塞东西
        bump('badShape')
        return decision
      }
      if (!Array.isArray(decision.messages)) {
        bump('badShape')
        return decision
      }

      const st = states.get(sessionId)
      if (st === undefined || st.due !== true) {
        bump('notDue')
        return decision
      }

      const ledger = ledgerOf(sessionId)
      const now = Date.now()
      const used = ledger.byTurn.get(st.turn) ?? 0
      if (cfg.maxPerTurn > 0 && used >= cfg.maxPerTurn) {
        bump('maxPerTurn')
        st.due = false
        return decision
      }

      const createUserMessage = await resolveCreateUserMessage()
      const message = createUserMessage({
        content: [{ type: 'text', text: cfg.prompt }],
        source: cfg.showInjected ? INJECT_SOURCE_VISIBLE : INJECT_SOURCE_NOTICE,
      })

      st.due = false
      st.lastVisibleAt = now
      ledger.lastInjectAt = now
      ledger.byTurn.set(st.turn, used + 1)
      stats.injected += 1
      stats.lastInjectAt = new Date(now).toISOString()

      // 从现在起截取模型接下来说的第一段正文
      // `silentMs` 存的是「触发这次汇报时的静默时长」，不是"汇报花了多久"：
      // 浮层上那句「已 N 秒没有文字输出」说的是触发理由，必须是这个数。
      //
      // turn/step 取 **payload** 而不是 `st`：`st` 是被上一个 step 的 `start`
      // 帧建的（`end` 帧不删状态），而注入发生在这一次的 step 边界上，两者
      // 差一步。用 `st.step` 会让浮层页脚永远比真实的小 1。
      captures.set(sessionId, {
        buffer: '',
        turn: payload.turn ?? st.turn,
        step: payload.step ?? st.step,
        at: now,
        silentMs: st.dueSilentMs ?? 0,
      })

      if (cfg.overlayEnabled) {
        // 到点那一刻已经亮过一张"还在等"的卡（见 `tick`）。注入之后模型还要
        // 思考一阵才会开口，这期间不能让浮窗凭空消失——只把状态推进到
        // "已经在整理汇报"，等 `commitCapture` 拿到原话再整体替换。
        const prev = latestBySession.get(sessionId)
        if (prev !== undefined && prev.pending === true) {
          rememberLatest(sessionId, { ...prev, phase: 'reporting', injectedAt: now })
        } else {
          // 没有待续的那张（比如浮窗刚被打开）：撤掉旧内容，避免旧汇报挂着
          latestBySession.delete(sessionId)
        }
      } else {
        bump('overlayOff')
      }

      log('info', '[narrator] injected at turn=%s step=%s silent=%ss', st.turn, st.step, Math.round((st.dueSilentMs ?? 0) / 1000))

      // 定时器重新起算：汇报本身也要占满一个阈值才会再触发
      schedule(agent, st, cfg.silentSeconds * 1000)

      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      stats.lastError = String(error)
      log('warn', '[narrator] pre-step injection failed: %s', String(error))
      return decision
    }
  }

  /** 收到一个流事件。 */
  function onStream(payload) {
    const cfg = effectiveConfig()
    if (!cfg.enabled) {
      // 总开关关着时每一帧都直接返回。这里照样记一笔，
      // 用户问「为什么没出现」时 status 里能看到 disabled > 0，不用猜。
      bump('disabled')
      return
    }

    const agent = payload?.agent
    const frame = payload?.frame
    if (agent === undefined || agent === null) return
    if (frame === undefined || frame === null || typeof frame.type !== 'string') return

    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return
    if (!cfg.includeSubagents && isSubagent(agent)) {
      bump('subagent')
      return
    }

    if (frame.type === 'start') {
      stats.startFrames += 1
      const now = Date.now()
      const prev = states.get(sessionId)
      // 跨 step 复用静默计时：用户感知的「等了很久」是连续的，不能因为
      // 模型内部换了一步（比如刚跑完一次工具、马上发起下一步）就把
      // 「已经多久没看到东西」清零——那样每个 step 都从 0 开始重新数，
      // 只要单步短于阈值就永远不会触发（实测最长单步仅 17.5 秒）。
      // 但换成新回合时必须归零：用户刚发消息，他自己就是最新可见内容。
      const sameTurn = prev !== undefined && prev.turn === (frame.turn ?? 0)
      const lastVisibleAt = sameTurn && prev.lastVisibleAt > 0 ? prev.lastVisibleAt : now
      clearState(prev)
      const st = {
        sessionId,
        turn: frame.turn ?? 0,
        step: frame.step ?? 0,
        startedAt: now,
        lastVisibleAt,
        timer: null,
        due: false,
        dueAt: null,
        dueSilentMs: null,
      }
      states.set(sessionId, st)
      const silentMs = now - lastVisibleAt
      schedule(agent, st, cfg.silentSeconds * 1000 - silentMs)
      return
    }

    if (frame.type === 'end') {
      stats.endFrames += 1
      const st = states.get(sessionId)
      if (st !== undefined) {
        recordStepDuration(Date.now() - st.startedAt)
        // 只记时长，不删状态、不清定时器：一步结束到下一步开始之间，
        // 模型正在等下一次响应，用户同样什么都看不到，静默计时必须继续。
        // 真正的清理交给 turn/end 与 agent/disposed。
        st.startedAt = Date.now()
      }
      // 这一步结束了还没等到工具调用：把已经说出来的正文收口
      commitCapture(sessionId)
      return
    }

    if (frame.type !== 'chunk') return

    stats.chunkFrames += 1

    const st = states.get(sessionId)
    const chunk = frame.chunk
    if (chunk === undefined || chunk === null || typeof chunk?.type !== 'string') return

    switch (chunk.type) {
      case 'text-delta': {
        // 出现正文 → 用户已经看得到东西了，重新计时
        if (typeof chunk.text === 'string' && chunk.text !== '') {
          const now = Date.now()
          if (st !== undefined) {
            st.lastVisibleAt = now
            // 模型自己开口了，之前排的那次汇报就不该再补一刀。
            // 少了这一句，长任务里 `due` 会在 step 中途被置位、模型随后
            // 在同一 step 内终于说了正文，下一个 pre-step 仍会再注入一次
            // 「请汇报这四点」，用户看到一段自问自答。
            st.due = false
            st.dueAt = null
            st.dueSilentMs = null
          }
          const cap = captures.get(sessionId)
          if (cap !== undefined) {
            // 这段正文是**插件自己要求来的汇报**，不是模型干活时随口说的话。
            // 它绝不能推进 `lastTextAt`：那个时钟的意思是「主窗口自主开口的
            // 最后时刻」，前端拿实时 `textAtMap` 跟记录里冻结的 `textAt` 比，
            // 谁更新就说明模型在汇报之后又说了别的话，浮窗该撤。
            //
            // 汇报本身也是一串 `text-delta`。一旦在这里推进，浮窗会在模型
            // 正写着总结的时候被它自己撤掉——用户的原话是「弹窗在有文字输出
            // 后消失不包括总结」，总结不该算数。所以只有截取窗口之外的话才推进。
            cap.buffer += chunk.text
          } else {
            // 截取窗口之外：模型在干活的间隙自己开口了，这才是撤卡的正当理由。
            lastTextAt.set(sessionId, now)
          }
        }
        return
      }
      case 'tool-call-delta': {
        // 工具调用**不算**"有文字输出"：用户要的是长时间没有正文时提示一次，
        // 而密集的工具调用恰好是最需要提示的场景。若在这里重置计时，连续调工具的
        // 长任务将永远不触发——那正是最初的缺陷。
        //
        // 但它标志着「模型已经说完汇报，开始干活了」，所以在这里收口截取。
        commitCapture(sessionId)
        return
      }
      case 'block-start': {
        // 只有 text 块算可见正文，tool-call 块不算
        if (chunk.blockType === 'text') {
          if (st !== undefined) st.lastVisibleAt = Date.now()
        } else if (chunk.blockType === 'tool-call') {
          commitCapture(sessionId)
        }
        return
      }
      default:
        // reasoning-delta 等：纯思考，不算可见进展，什么都不做
        return
    }
  }

  ctx.on('agent/assistant-stream', onStream, { global: true })
  ctx.on('agent/pre-step', onPreStep, { global: true })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return
    const st = states.get(sessionId)
    if (st !== undefined) {
      clearState(st)
      states.delete(sessionId)
    }
    ledgers.delete(sessionId)
    captures.delete(sessionId)
    lastTextAt.delete(sessionId)
  }, { global: true })

  // 跟踪会话事件：工具调用的开始与结束、以及回合收尾
  ctx.on('session/event', (_session, event) => {
    const sessionId = _session?.id
    if (typeof sessionId !== 'string') return

    // 工具调用的生命周期，用来回答"主窗口现在在等什么"
    if (event?.type === 'assistant/message') {
      const blocks = event?.data?.message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block?.type !== 'tool-call' || typeof block.id !== 'string') continue
          // 一个 assistant 步可能并发多个工具，记最后一个即可：浮窗只说
          // 一句"正在等什么"，没必要把整队都列出来。
          runningTools.set(sessionId, {
            callId: block.id,
            name: typeof block.name === 'string' ? block.name : '',
            startedAt: Date.now(),
          })
        }
      }
      return
    }
    if (event?.type === 'tool/result') {
      const callId = event?.data?.message?.toolCallId
      const cur = runningTools.get(sessionId)
      if (cur !== undefined && (callId === undefined || cur.callId === callId)) {
        runningTools.delete(sessionId)
      }
      return
    }

    if (event?.type !== 'turn/end') return
    // 回合彻底结束：清掉静默计时状态。下一回合由用户发起，从零开始数。
    const st = states.get(sessionId)
    if (st !== undefined) {
      clearState(st)
      states.delete(sessionId)
    }
    captures.delete(sessionId)
    runningTools.delete(sessionId)
    // 上一回合的浮层记录也要撤掉。
    //
    // 不撤的后果是：新回合 `start` 帧一到，`runningMap[sessionId]` 又变 true，
    // 前端"任务还在跑就继续挂着"的判断会短路掉停留期内过期逻辑，
    // 于是**上一回合的汇报文本挂着「正在汇报」继续展示**——用户会以为
    // 模型现在正在说那件事，其实是十分钟前的旧话。
    latestBySession.delete(sessionId)
    // 「最后一次正文」也一起清：下一回合由用户发消息开始，他自己就是最新
    // 可见内容，把上一回合的旧时刻留着会让浮窗判断错乱。
    lastTextAt.delete(sessionId)
    const ledger = ledgers.get(sessionId)
    if (ledger === undefined) return
    const turn = event?.data?.turn
    ledger.byTurn.delete(turn)
  }, { global: true })

  // ctx 销毁时清所有定时器
  ctx.effect(() => () => {
    for (const st of states.values()) clearState(st)
    states.clear()
    ledgers.clear()
    captures.clear()
    runningTools.clear()
    lastTextAt.clear()
  })

  // -------------------------------------------------------------------------
  // 配置读写通道
  //
  // 宿主对第三方插件的 settings 命名空间没有开放保证（内置插件靠 bundle 声明
  // 才有），所以这里自带一条 loopback-only 的 HTTP 路由：浏览器半侧的配置卡
  // 直接读写它，不依赖宿主 UI 原语，也就不怕接口变动。
  // -------------------------------------------------------------------------

  /** 允许用户在设置页调整的字段（其余字段仍只在 cordis.patch.yml 里配）。 */
  const EDITABLE = [
    'enabled',
    'overlayEnabled',
    'showInjected',
    'silentSeconds',
    'cooldownSeconds',
    'maxPerTurn',
    'lingerSeconds',
    // 浮窗透明度：只影响浮窗那一层，跟通道开关是两个语义
    'overlayOpacity',
    'includeSubagents',
    'prompt',
    'testMode',
    'testSilentSeconds',
    'testCooldownSeconds',
  ]

  const isLoopback = (req) => {
    const addr = req.socket?.remoteAddress
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  /**
   * 判断请求是不是「从别的网站发起的」。
   *
   * 光校验 loopback 不够：用户浏览器里任何一个网页都能 `fetch` 到
   * `http://127.0.0.1:<port>/api/narrator/...`，源地址同样是 127.0.0.1。
   * 那意味着恶意页面可以：
   *   - `POST /config` 把阈值改成极小值，制造注入风暴（副作用型，不需读响应）；
   *   - `GET /latest` 拿走模型汇报原文，而里面有任务目标、文件路径、报错原文
   *     ——这是会话内容外泄，不只是配置泄露。
   *
   * 两道判据：
   *   1. **Host 必须指向本机**。只比 Origin 与 Host 是否相同是防不住
   *      DNS rebinding 的：攻击者让 `evil.com` 解析到 127.0.0.1，浏览器发出的
   *      `Origin: http://evil.com` 与 `Host: evil.com` 天然一致，两项等值校验
   *      直接放行，恶意页面就能读走全部旁白。把 Host 白名单化才真正堵死。
   *   2. 带 `Origin` 时，Origin 也必须指向本机。
   * 不带 `Origin` 的（同源导航、curl、宿主自己的 fetch）继续放行。
   *
   * @param {object} req HTTP 请求
   * @returns {boolean} 是否应拒绝
   */
  const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

  /** 取 URL 里的 hostname，失败返回 null。 */
  const hostnameOf = (value) => {
    try {
      return new URL(value).hostname
    } catch {
      return null
    }
  }

  const isCrossOrigin = (req) => {
    // 入口：Host 头本身必须是本机。不校验这条，上面注释里的 rebinding 就成立。
    const hostHeader = req.headers?.host
    if (typeof hostHeader === 'string' && hostHeader !== '') {
      // Host 头不含协议，补一个再解析
      const hostName = hostnameOf(`http://${hostHeader}`)
      if (hostName === null) return true
      if (!LOOPBACK_HOSTNAMES.has(hostName.toLowerCase())) return true
    }

    const origin = req.headers?.origin
    if (typeof origin !== 'string' || origin === '') return false

    // Origin 形如 "http://127.0.0.1:61201"
    const originHost = hostnameOf(origin)
    if (originHost === null) return true // 解析不了的 Origin 一律当成跨源
    if (!LOOPBACK_HOSTNAMES.has(originHost.toLowerCase())) return true

    // Host 缺失时无法比对端口，但两边都已确认是本机，放行
    if (typeof hostHeader !== 'string' || hostHeader === '') return false
    return new URL(origin).host !== hostHeader
  }

  /** 路由统一入口守卫：loopback + 同源。 */
  const guard = (req, res, json) => {
    if (!isLoopback(req)) {
      res.writeHead(403, json)
      res.end('{"ok":false,"error":"loopback-only"}')
      return false
    }
    if (isCrossOrigin(req)) {
      res.writeHead(403, json)
      res.end('{"ok":false,"error":"cross-origin"}')
      return false
    }
    return true
  }

  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 64 * 1024) {
          reject(new Error('body-too-large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve(text === '' ? {} : JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })

  /** 把生效配置投影成设置页需要的样子（分钟 + 秒双份）。 */
  const publicConfig = () => {
    const cfg = effectiveConfig()
    return {
      enabled: cfg.enabled,
      overlayEnabled: cfg.overlayEnabled,
      showInjected: cfg.showInjected,
      // 浮窗透明度（0.35~1）。只作用于浮层那张卡。
      overlayOpacity: cfg.overlayOpacity,
      overlayOpacityMin: OVERLAY_OPACITY_MIN,
      overlayOpacityMax: OVERLAY_OPACITY_MAX,
      // 生效值（测试模式下就是测试值）；设置卡的滑杆与数字框读这个
      silentSeconds: cfg.silentSeconds,
      silentMinutes: Math.round((cfg.silentSeconds / 60) * 100) / 100,
      cooldownSeconds: cfg.cooldownSeconds,
      cooldownMinutes: Math.round((cfg.cooldownSeconds / 60) * 100) / 100,
      // 未被测试模式覆盖的真实配置；「测试」区块里的说明要用
      normalSilentSeconds: cfg.normalSilentSeconds,
      normalCooldownSeconds: cfg.normalCooldownSeconds,
      // 测试模式三件套
      testMode: cfg.testMode,
      testSilentSeconds: cfg.testSilentSeconds,
      testCooldownSeconds: cfg.testCooldownSeconds,
      testSecondsMin: TEST_SECONDS_MIN,
      testSecondsMax: TEST_SECONDS_MAX,
      maxPerTurn: cfg.maxPerTurn,
      lingerSeconds: cfg.lingerSeconds,
      includeSubagents: cfg.includeSubagents,
      // 注入提示词：自定义值与内置默认分开给，设置卡才能做「恢复默认」
      prompt: cfg.prompt,
      defaultPrompt: cfg.locale === 'en' ? DEFAULT_PROMPT_EN : DEFAULT_PROMPT_ZH,
      defaults: {
        silentSeconds: DEFAULTS.silentSeconds,
        cooldownSeconds: DEFAULTS.cooldownSeconds,
        maxPerTurn: DEFAULTS.maxPerTurn,
        lingerSeconds: DEFAULTS.lingerSeconds,
        prompt: DEFAULTS.prompt,
        overlayEnabled: DEFAULTS.overlayEnabled,
        showInjected: DEFAULTS.showInjected,
        includeSubagents: DEFAULTS.includeSubagents,
        overlayOpacity: DEFAULTS.overlayOpacity,
        // 少了下面这几项，「恢复默认」只能恢复一半：开关总闸与测试模式
        // 无处取默认值，用户点完按钮仍然显示「保存」，与直觉相反。
        enabled: DEFAULTS.enabled,
        testMode: DEFAULTS.testMode,
        testSilentSeconds: DEFAULTS.testSilentSeconds,
        testCooldownSeconds: DEFAULTS.testCooldownSeconds,
      },
    }
  }

  /** 载入覆盖层；只做一次，重复调用复用同一个 promise。 */
  const ensureLoaded = () => {
    if (loading === null) {
      loading = loadOverride(undefined, (error) => {
        // 配置文件损坏会被 loadOverride 兜成 {}，用户调好的值会无声退回默认。
        // 至少在日志里留一条，排查「设置怎么自己变回去了」时有据可查。
        log('warn', '[narrator] 读取用户配置失败，已回退到默认值: %s', String(error))
        stats.lastConfigError = String(error)
      })
        .then((values) => {
          override = values
        })
        .catch(() => {
          override = {}
        })
    }
    return loading
  }
  void ensureLoaded()

  // 裸 cordis / 测试桩里可能没有 ctx.inject，没有就不装路由（旁白本身照常工作）。
  const registerRoutes = (child) => {
    const webServer = child?.webServer
    if (webServer === undefined || webServer === null) return
    const json = { 'content-type': 'application/json; charset=utf-8' }

    child.effect(() => {
      const routes = [
        webServer.register({
          kind: 'exact',
          path: '/api/narrator/config',
          handler: (req, res) => {
            const r = res
            if (!guard(req, r, json)) return
            if (req.method === 'GET') {
              void ensureLoaded().then(() => {
                r.writeHead(200, json)
                r.end(JSON.stringify({ ok: true, config: publicConfig() }))
              })
              return
            }
            if (req.method !== 'POST') {
              r.writeHead(405, json)
              r.end('{"ok":false,"error":"method-not-allowed"}')
              return
            }
            readJsonBody(req)
              .then(async (body) => {
                const patch = body?.config
                if (patch === null || typeof patch !== 'object') {
                  r.writeHead(400, json)
                  r.end('{"ok":false,"error":"bad-request"}')
                  return
                }
                // Content-Type 校验：只接受 JSON。
                //
                // 省掉这条的后果是：任何能触发「简单请求」的页面（form、
                // text/plain）都能不经预检打到这个 POST 上。虽然 loopback +
                // 同源两道守卫已经拦掉了跨站，但少一层就是少一层，而这里
                // 改的是能控制注入频率的阈值。
                const contentType = req.headers?.['content-type']
                if (typeof contentType === 'string' && !contentType.includes('application/json')) {
                  r.writeHead(415, json)
                  r.end('{"ok":false,"error":"unsupported-media-type"}')
                  return
                }
                await ensureLoaded()
                const next = { ...override }
                /** 被拒绝的键；非空时回 400 并告诉前端哪些值没被接受。 */
                const badKeys = []
                for (const key of EDITABLE) {
                  if (!Object.hasOwn(patch, key)) continue
                  const value = patch[key]
                  // 开关类都是纯布尔，只认 === true，避免 "false" 字符串被当成真
                  if (
                    key === 'enabled' ||
                    key === 'overlayEnabled' ||
                    key === 'showInjected' ||
                    key === 'includeSubagents' ||
                    key === 'testMode'
                  ) {
                    next[key] = value === true
                    continue
                  }
                  // 提示词：空串视为「用内置默认」，写 null 而不是空串
                  if (key === 'prompt') {
                    const raw = typeof value === 'string' ? value.trim() : ''
                    next.prompt = raw === '' ? null : raw
                    continue
                  }
                  // 测试模式的两个时长固定 1~60 整秒，超界就夹紧而不是丢弃，
                  // 免得界面传了 0 或 120 之后这个键悄悄没了、回到默认值。
                  if (key === 'testSilentSeconds' || key === 'testCooldownSeconds') {
                    const raw = Number(value)
                    if (!Number.isFinite(raw)) {
                      badKeys.push(key)
                      continue
                    }
                    next[key] = Math.min(TEST_SECONDS_MAX, Math.max(TEST_SECONDS_MIN, Math.round(raw)))
                    continue
                  }
                  // maxPerTurn 的 0 是**有意义的合法值**，表示「不限次数」，
                  // 正是默认值。早期这里和其余数值一样要求 n > 0，导致
                  // 界面一旦把上限改成非 0，就再也改不回 0（保存直接被拒）。
                  if (key === 'maxPerTurn') {
                    const n = Number(value)
                    if (!Number.isFinite(n) || n < 0) {
                      badKeys.push(key)
                      continue
                    }
                    next[key] = Math.round(n)
                    continue
                  }
                  // 透明度：夹紧而不是拒绝。用户拖动滑杆时可能瞬间传来 0，
                  // 拒绝会让「保存」按钮报错，而夹紧的结果一样可见。
                  if (key === 'overlayOpacity') {
                    const raw = Number(value)
                    if (!Number.isFinite(raw)) {
                      badKeys.push(key)
                      continue
                    }
                    next[key] = clampOpacity(raw)
                    continue
                  }
                  // 浮窗停留时长：夹到 5~600 秒。与测试区那两个 1~60 的键不同源，
                  // 不能再走下面的通用整秒分支（那样默认的 90 秒会被拒或改写）。
                  if (key === 'lingerSeconds') {
                    const raw = Number(value)
                    if (!Number.isFinite(raw)) {
                      badKeys.push(key)
                      continue
                    }
                    next[key] = clampLinger(raw, DEFAULTS.lingerSeconds)
                    continue
                  }
                  const n = Number(value)
                  if (!Number.isFinite(n) || n <= 0) {
                    // 不再静默丢弃：前端会看到「保存成功」而实际没写进去，
                    // 排查时极难定位。明确报错，让界面能提示用户。
                    badKeys.push(key)
                    continue
                  }
                  // silentSeconds 允许小数（分钟换算会带小数），其余取整
                  const parsed =
                    key === 'silentSeconds' || key === 'cooldownSeconds' || key === 'lingerSeconds'
                      ? n
                      : Math.round(n)
                  next[key] = parsed
                }
                // 校验不通过就到此为止：**绝不能先落盘再报错**。
                // 曾经的顺序是「先写内存 + 写盘，再看 badKeys 回 400」，
                // 于是前端提示"这些值不合法、都没保存"，而合法的键其实已经生效
                // 并写进磁盘了——用户下次重启看到的就是那个"没保存"的值。
                if (badKeys.length > 0) {
                  r.writeHead(400, json)
                  r.end(JSON.stringify({ ok: false, error: 'invalid-values', keys: badKeys }))
                  return
                }
                try {
                  await saveOverride(next)
                } catch (error) {
                  log('warn', '[narrator] save override failed: %s', String(error))
                  // 写盘失败时内存也**不能**先改：否则这次"失败"的保存在
                  // 本进程内已经生效，重启后才回滚，两边不一致。
                  r.writeHead(500, json)
                  r.end(JSON.stringify({ ok: false, error: 'save-failed' }))
                  return
                }
                // 落盘成功之后才提交内存
                override = next
                r.writeHead(200, json)
                r.end(JSON.stringify({ ok: true, config: publicConfig() }))
              })
              .catch(() => {
                r.writeHead(400, json)
                r.end('{"ok":false,"error":"bad-request"}')
              })
          },
        }),
        webServer.register({
          kind: 'exact',
          path: '/api/narrator/status',
          handler: (req, res) => {
            const r = res
            if (!guard(req, r, json)) return
            // 原来不校验方法，POST/DELETE 也返回 200，容易被跨站「探活」
            if (req.method !== 'GET') {
              r.writeHead(405, json)
              r.end('{"ok":false,"error":"method-not-allowed"}')
              return
            }
            r.writeHead(200, json)
            r.end(JSON.stringify(snapshot()))
          },
        }),
        // 浏览器半侧的浮层轮询它。
        //
        // `?session=<id>` 取该会话的旁白：浮层只该出现在正在长思考的那个
        // 对话窗口里，不能把 A 会话的进度显示到 B 会话上。
        // 不带 session 参数时退回「当前唯一在跑的那个会话」。
        webServer.register({
          kind: 'exact',
          path: '/api/narrator/latest',
          handler: async (req, res) => {
            const r = res
            if (!guard(req, r, json)) return
            // 只读接口，只接受 GET（原来任意方法都会返回旁白正文）
            if (req.method !== 'GET') {
              r.writeHead(405, json)
              r.end('{"ok":false,"error":"method-not-allowed"}')
              return
            }

            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const want = url.searchParams.get('session') ?? ''
            const activeIds = [...states.keys()]

            // 指定了会话就只报它；没指定则取唯一在跑的那个，避免串会话。
            let sid = want
            if (sid === '' && activeIds.length === 1) sid = activeIds[0]

            const rec = sid === '' ? null : (latestBySession.get(sid) ?? null)
            // `running` 只问「这个会话还在跑吗」，不是全局计数：
            // 前端要据此判断浮层该不该继续挂着。
            const running = sid !== '' && states.has(sid)

            // 全部会话的旁白快照（带 session 字段）。
            // 为什么要全给：前端要靠 `MutationObserver` 实时跟踪用户正在看哪个会话，
            // 然后在本地下判断。如果这里只按请求参数过滤，切换会话后前端必须再等
            // 一轮网络往返才拿到新会话的数据，浮层会「迟一步才消失」。
            // 记录数量等于活跃会话数，通常 0~2 条，全量下发没有成本。
            const records = []
            const runningMap = {}
            // 每个会话「主窗口最后一次说出正文」的时刻，跟记录一起下发。
            // 前端拿它跟记录里冻结的 `textAt` 比：更新的就撤卡。
            // 单列一张表而不是塞进每条记录里，是因为它是「此刻」而非
            // 「这条汇报诞生时」——后者已冻结在 `value.textAt` 里。
            const textAtMap = {}
            for (const [key, value] of latestBySession) {
              records.push({ ...value, session: key })
              runningMap[key] = states.has(key)
            }
            for (const [key, at] of lastTextAt) textAtMap[key] = at

            // 实时等待状态：浮窗在"已到点、还在等 step 边界"的那段里要说明白
            // 主窗口在等什么。这条不进 `latestBySession`——它只描述此刻，
            // 不描述模型说过什么，混进记录里会被误当成一次汇报。
            const waitingMap = {}
            for (const [key, tool] of runningTools) {
              waitingMap[key] = {
                label: waitingLabel(tool.name),
                tool: tool.name === '' ? null : tool.name,
                // 只给起点，秒数交给前端用本地时钟算：否则这条每轮轮询都在变，
                // 引用去重失效，浮层每 2 秒白重渲染一次。
                startedAt: tool.startedAt,
              }
            }

            const cfg = effectiveConfig()
            r.writeHead(200, json)
            r.end(
              JSON.stringify({
                ok: true,
                enabled: cfg.enabled,
                // 浮层通道单独关掉时，前端要据此立刻撤掉卡片
                overlayEnabled: cfg.overlayEnabled,
                // 浮窗透明度与停留时长：每次轮询都下发，改设置后 2 秒内自动生效
                overlayOpacity: cfg.overlayOpacity,
                lingerSeconds: cfg.lingerSeconds,
                session: sid === '' ? null : sid,
                latest: rec === null ? null : { ...rec, session: sid },
                records,
                runningMap,
                waitingMap,
                // 每个会话「主窗口最后一次说出正文」的时刻。前端据此判断
                // 浮窗该不该撤：比记录里的 `textAt` 新 → 模型又开口了。
                textAtMap,
                running,
                active: activeIds.length,
              }),
            )
          },
        }),
      ]
      return () => {
        for (const dispose of routes) {
          try {
            dispose()
          } catch {
            // 卸载失败不影响插件退出
          }
        }
      }
    })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], registerRoutes)
  }

  // 测试与本地调试用：把自检快照挂到 ctx 上，避免测试去猜内部状态。
  // 真实宿主里 ctx 是框架对象，多挂一个方法无副作用。
  try {
    ctx.narratorStatus = snapshot
    // 浮层记录也要能被测试读到：只断言注入次数是看不到浮层通道的。
    ctx.narratorRecords = () => [...latestBySession.entries()].map(([session, value]) => ({ ...value, session }))
    // 撤卡时钟也要能被测试读到。前端判据是「实时 textAtMap > 记录里的
    // textAt」，光看记录看不出这个比较的结果，必须拿到服务端此刻的值。
    ctx.narratorTextAt = () => Object.fromEntries(lastTextAt)
    // 截取窗口也要能被测试读到。时间闸那条测试必须把窗口的出生时刻往前推
    // （真等 10 分钟不现实），光看 captured 观察不到"窗口有没有被丢掉"。
    ctx.narratorCaptures = () => captures
  } catch {
    // 某些上下文对象可能不可写，忽略
  }
}

/**
 * 供宿主设置页/校验使用的配置说明（无 schemastery 依赖，纯描述）。
 * 配置来源有三层：DEFAULTS < cordis.patch.yml < 设置页覆盖层
 * （`~/.dsh/narrator/config.json`），统一由 normalizeConfig 归一化。
 */
export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULTS))
