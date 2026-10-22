import test from 'node:test'
import assert from 'node:assert/strict'

// ⚠️ 必须在 import ../lib/index.js 之前设置：插件默认读
// `~/.dsh/narrator/config.json`。不隔离的话，用户在自己设置卡里调过的值
// 会污染用例（历史上曾因此让一批用例假失败）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_NARRATOR_CONFIG = join(mkdtempSync(join(tmpdir(), 'narrator-pure-')), 'config.json')

const mod = await import('../lib/index.js')

const {
  DEFAULTS,
  CONFIG_KEYS,
  DEFAULT_PROMPT_ZH,
  DEFAULT_PROMPT_EN,
  INJECT_SOURCE_NOTICE,
  INJECT_SOURCE_VISIBLE,
  TEST_SECONDS_MIN,
  TEST_SECONDS_MAX,
  OVERLAY_OPACITY_MIN,
  OVERLAY_OPACITY_MAX,
  normalizeConfig,
  isSubagent,
  finalizeCapture,
} = mod

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

test('DEFAULTS 与 CONFIG_KEYS 一致', () => {
  assert.deepEqual([...CONFIG_KEYS].sort(), Object.keys(DEFAULTS).sort())
})

test('默认值：开关默认开，阈值默认 1 分钟，单回合不限次', () => {
  assert.equal(DEFAULTS.enabled, true)
  assert.equal(DEFAULTS.overlayEnabled, true)
  // 注入的提示词默认隐藏：那是给模型的指令，不是给人看的
  assert.equal(DEFAULTS.showInjected, false)
  assert.equal(DEFAULTS.silentSeconds, 60)
  assert.equal(DEFAULTS.cooldownSeconds, 60)
  // 0 = 不限次数，由冷却限流。长静默不该报到第三条就彻底沉默
  assert.equal(DEFAULTS.maxPerTurn, 0)
  assert.equal(DEFAULTS.lingerSeconds, 90)
  assert.equal(DEFAULTS.overlayOpacity, 1)
  // 子代理的会话用户根本看不见，往它里面注入汇报纯属浪费一次模型调用
  assert.equal(DEFAULTS.includeSubagents, false)
  assert.equal(DEFAULTS.testMode, false)
  assert.equal(DEFAULTS.prompt, null)
})

test('内置提示词包含四点式要求，并要求说完继续', () => {
  for (const prompt of [DEFAULT_PROMPT_ZH, DEFAULT_PROMPT_EN]) {
    assert.match(prompt, /1\./)
    assert.match(prompt, /2\./)
    assert.match(prompt, /3\./)
    assert.match(prompt, /4\./)
  }
  // 中文版必须明确「说完必须继续执行，不要结束任务」——
  // 少了这句模型容易把汇报当成任务终点
  assert.match(DEFAULT_PROMPT_ZH, /继续执行/)
  assert.match(DEFAULT_PROMPT_EN, /keep going/i)
})

test('隐藏注入用 form=notice，可见注入用 kind=user', () => {
  // form:'notice' 会被宿主投影成 context 节点，isVisibleChatNode 会排除它，
  // 于是模型读得到、界面看不到。改掉这个 form 会让注入的指令出现在对话里。
  assert.equal(INJECT_SOURCE_NOTICE.form, 'notice')
  assert.notEqual(INJECT_SOURCE_NOTICE.kind, 'user')
  assert.equal(INJECT_SOURCE_VISIBLE.kind, 'user')
})

test('测试模式与透明度的量程常量', () => {
  assert.equal(TEST_SECONDS_MIN, 1)
  assert.equal(TEST_SECONDS_MAX, 60)
  assert.equal(OVERLAY_OPACITY_MIN, 0.35)
  assert.equal(OVERLAY_OPACITY_MAX, 1)
})

// ---------------------------------------------------------------------------
// normalizeConfig
// ---------------------------------------------------------------------------

test('normalizeConfig 空输入给出全套默认值', () => {
  const cfg = normalizeConfig()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.overlayEnabled, true)
  assert.equal(cfg.showInjected, false)
  assert.equal(cfg.silentSeconds, DEFAULTS.silentSeconds)
  assert.equal(cfg.cooldownSeconds, DEFAULTS.cooldownSeconds)
  assert.equal(cfg.maxPerTurn, 0)
  assert.equal(cfg.lingerSeconds, DEFAULTS.lingerSeconds)
  assert.equal(cfg.overlayOpacity, 1)
  assert.equal(cfg.includeSubagents, false)
  assert.equal(cfg.testMode, false)
  assert.equal(cfg.prompt, DEFAULT_PROMPT_ZH)
})

test('normalizeConfig 容忍 null / 非对象 / 脏数据', () => {
  assert.equal(normalizeConfig(null).enabled, true)
  assert.equal(normalizeConfig('garbage').enabled, true)
  assert.equal(normalizeConfig(42).enabled, true)
  const dirty = normalizeConfig({
    silentSeconds: 'abc',
    cooldownSeconds: Number.NaN,
    lingerSeconds: 'oops',
    overlayOpacity: null,
    prompt: '   ',
  })
  assert.equal(dirty.silentSeconds, DEFAULTS.silentSeconds)
  assert.equal(dirty.cooldownSeconds, DEFAULTS.cooldownSeconds)
  assert.equal(dirty.lingerSeconds, DEFAULTS.lingerSeconds)
  assert.equal(dirty.overlayOpacity, 1)
  // 全空白提示词回落到内置默认，不然等于给模型发了个空指令
  assert.equal(dirty.prompt, DEFAULT_PROMPT_ZH)
})

test('总开关与浮层开关：不等于 false 就算开', () => {
  // 字符串 'false' 不是布尔 false，仍然算开——这是刻意的宽容：
  // YAML 里写成字符串时不该把功能整体关掉。
  const cfg = normalizeConfig({
    enabled: 'false',
    overlayEnabled: 'false',
    // includeSubagents 是反过来的：只认严格 true。
    // 它是「多干活」的开关，误开的代价是多花一次模型调用，
    // 而误关只是子代理不多说一句。两者不对称，所以判据也不同。
    includeSubagents: 'true',
  })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.overlayEnabled, true)
  assert.equal(cfg.includeSubagents, false)

  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ overlayEnabled: false }).overlayEnabled, false)
  assert.equal(normalizeConfig({ includeSubagents: false }).includeSubagents, false)
  assert.equal(normalizeConfig({ includeSubagents: true }).includeSubagents, true)
})

test('showInjected 与 testMode 只认严格 true', () => {
  // 这两个开关都会「多露出」东西（模型指令 / 秒级阈值），
  // 宁可漏开也不能误开。
  assert.equal(normalizeConfig({ showInjected: 'true' }).showInjected, false)
  assert.equal(normalizeConfig({ testMode: 'true' }).testMode, false)
  assert.equal(normalizeConfig({ showInjected: true }).showInjected, true)
  assert.equal(normalizeConfig({ testMode: true }).testMode, true)
})

test('测试模式只覆盖两个时长，其余配置原样保留', () => {
  const cfg = normalizeConfig({
    silentSeconds: 600,
    cooldownSeconds: 900,
    testMode: true,
    testSilentSeconds: 5,
    testCooldownSeconds: 10,
    lingerSeconds: 30,
    overlayOpacity: 0.5,
  })
  // 生效值是测试值
  assert.equal(cfg.silentSeconds, 5)
  assert.equal(cfg.cooldownSeconds, 10)
  // 但正常值原封不动地留着：关掉测试模式后必须回到 600/900
  assert.equal(cfg.normalSilentSeconds, 600)
  assert.equal(cfg.normalCooldownSeconds, 900)
  assert.equal(cfg.lingerSeconds, 30)
  assert.equal(cfg.overlayOpacity, 0.5)
})

test('测试模式关闭时 normal* 与生效值一致', () => {
  const cfg = normalizeConfig({ silentSeconds: 120, cooldownSeconds: 180 })
  assert.equal(cfg.silentSeconds, 120)
  assert.equal(cfg.normalSilentSeconds, 120)
  assert.equal(cfg.cooldownSeconds, 180)
  assert.equal(cfg.normalCooldownSeconds, 180)
})

test('测试模式秒数被夹到 1~60 整秒', () => {
  assert.equal(normalizeConfig({ testSilentSeconds: 0 }).testSilentSeconds, TEST_SECONDS_MIN)
  assert.equal(normalizeConfig({ testSilentSeconds: 999 }).testSilentSeconds, TEST_SECONDS_MAX)
  assert.equal(normalizeConfig({ testSilentSeconds: 7.6 }).testSilentSeconds, 8)
  assert.equal(normalizeConfig({ testCooldownSeconds: -5 }).testCooldownSeconds, TEST_SECONDS_MIN)
  assert.equal(normalizeConfig({ testCooldownSeconds: 120 }).testCooldownSeconds, TEST_SECONDS_MAX)
})

test('透明度被夹到 0.35~1', () => {
  assert.equal(normalizeConfig({ overlayOpacity: 0 }).overlayOpacity, OVERLAY_OPACITY_MIN)
  assert.equal(normalizeConfig({ overlayOpacity: -3 }).overlayOpacity, OVERLAY_OPACITY_MIN)
  assert.equal(normalizeConfig({ overlayOpacity: 9 }).overlayOpacity, OVERLAY_OPACITY_MAX)
  assert.equal(normalizeConfig({ overlayOpacity: 0.5 }).overlayOpacity, 0.5)
  // 两位小数，避免滑杆上出现 0.123456789
  assert.equal(normalizeConfig({ overlayOpacity: 0.456789 }).overlayOpacity, 0.46)
})

test('负值的数值配置回落到默认，而不是变成负数', () => {
  assert.equal(normalizeConfig({ lingerSeconds: -1 }).lingerSeconds, DEFAULTS.lingerSeconds)
  assert.equal(normalizeConfig({ maxPerTurn: -1 }).maxPerTurn, 0)
})

test('locale=en 时提示词换成英文内置版', () => {
  assert.equal(normalizeConfig({ locale: 'en' }).locale, 'en')
  assert.equal(normalizeConfig({ locale: 'en' }).prompt, DEFAULT_PROMPT_EN)
  assert.equal(normalizeConfig({ locale: 'fr' }).locale, 'zh')
  assert.equal(normalizeConfig({ locale: 'fr' }).prompt, DEFAULT_PROMPT_ZH)
})

test('自定义提示词被保留并去空白', () => {
  assert.equal(normalizeConfig({ prompt: '  说点什么  ' }).prompt, '说点什么')
  assert.equal(normalizeConfig({ prompt: '' }).prompt, DEFAULT_PROMPT_ZH)
})

test('normalizeConfig 解包响应式引用（有 .get()）', () => {
  const reactive = { get: () => ({ silentSeconds: 42, enabled: false }) }
  const cfg = normalizeConfig(reactive)
  assert.equal(cfg.silentSeconds, 42)
  assert.equal(cfg.enabled, false)
})

// ---------------------------------------------------------------------------
// isSubagent
// ---------------------------------------------------------------------------

test('isSubagent 认得四种标记', () => {
  assert.equal(isSubagent({ parent: {} }), true)
  assert.equal(isSubagent({ parentSessionId: 's1' }), true)
  assert.equal(isSubagent({ kind: 'subagent' }), true)
  assert.equal(isSubagent({ role: 'subagent' }), true)
})

// 这条是 2026-10-20 线上反馈的回归测试：
// 在「分支会话」里一切播报都被拦掉，自检 skipped.subagent 涨到 27 万。
// 根因是曾经把「有 parentSession」当成子代理，而分支会话也有 parentSession。
test('isSubagent 不把分支会话当成子代理', () => {
  // 分支会话（一手实证）：origin 缺失、有 parentSession、isSeeded=true、depth=0
  const branch = {
    session: {
      header: {
        id: 'session-d5d4f68e-0a40-4d4b-a3cd-cac593be404b',
        parentSession: 'session-0b3b6f81-0aa5-48f5-8725-a236a1dd58d6',
        isSeeded: true,
        delegationDepth: 0,
      },
    },
  }
  assert.equal(isSubagent(branch), false, '分支会话是用户正常查看的主会话，不能被子代理判据拦掉')

  // 同一份头，但缺 delegationDepth：仍然不是子代理（origin 才是唯一可靠判据）
  const branchNoDepth = {
    session: { header: { parentSession: 'session-parent', isSeeded: true } },
  }
  assert.equal(isSubagent(branchNoDepth), false, '没有 origin=subagent 就不该判为子代理')
})

test('isSubagent 认得真子代理', () => {
  // 真子代理（一手实证）：origin='subagent'、delegationDepth=1
  const sub = {
    session: {
      header: {
        id: 'a183d5f3-3ddc-4f9d-8869-a06eb4dbbe7c',
        origin: 'subagent',
        parentSession: 'session-c7c101e9-c250-451a-b7a1-130ab75a8d49',
        isSeeded: false,
        delegationDepth: 1,
      },
    },
  }
  assert.equal(isSubagent(sub), true)

  // 只有 depth 没有 origin：也按子代理算（宿主对子代理会写 depth>=1）
  const depthOnly = {
    session: { header: { parentSession: 'session-parent', delegationDepth: 2 } },
  }
  assert.equal(isSubagent(depthOnly), true, '有 parentSession 且 delegationDepth>0，是子代理')
})

test('isSubagent 不误判主代理与脏数据', () => {
  assert.equal(isSubagent({}), false)
  assert.equal(isSubagent({ parent: null }), false)
  assert.equal(isSubagent({ parentSessionId: '' }), false)
  assert.equal(isSubagent({ kind: 'main' }), false)
  assert.equal(isSubagent(null), false)
  assert.equal(isSubagent(undefined), false)
  assert.equal(isSubagent('x'), false)
  // parent 指向自己不算子代理（防御自引用）
  const self = {}
  self.parent = self
  assert.equal(isSubagent(self), false)
})

// ---------------------------------------------------------------------------
// finalizeCapture
// ---------------------------------------------------------------------------

test('finalizeCapture 压掉首尾空白', () => {
  assert.equal(finalizeCapture('  \n 正在做 A \n\n '), '正在做 A')
})

test('finalizeCapture 保留内部换行与缩进', () => {
  assert.equal(finalizeCapture('\n第一段\n\n第二段\n'), '第一段\n\n第二段')
})

test('finalizeCapture 对空内容与非字符串返回空串', () => {
  assert.equal(finalizeCapture(''), '')
  assert.equal(finalizeCapture('   \n\t '), '')
  assert.equal(finalizeCapture(null), '')
  assert.equal(finalizeCapture(undefined), '')
  assert.equal(finalizeCapture(42), '')
})

// ---------------------------------------------------------------------------
// 注入提示词的长度闸（审计 P1：prompt 无上限 → 可被塞任意长文本进 user 消息）
// ---------------------------------------------------------------------------

test('PROMPT_MAX_CHARS 是一个明确的正整数上限', () => {
  assert.equal(typeof mod.PROMPT_MAX_CHARS, 'number')
  assert.ok(Number.isInteger(mod.PROMPT_MAX_CHARS) && mod.PROMPT_MAX_CHARS > 0)
})

test('超长 prompt 在归一化时被截断到上限', () => {
  const tooLong = 'x'.repeat(mod.PROMPT_MAX_CHARS + 500)
  const cfg = mod.normalizeConfig({ prompt: tooLong })
  assert.equal(cfg.prompt.length, mod.PROMPT_MAX_CHARS, '应截断到上限')
  assert.notEqual(cfg.prompt.length, tooLong.length, '不得原样放行')
})

test('恰好等于上限的 prompt 不被截断', () => {
  const exact = 'y'.repeat(mod.PROMPT_MAX_CHARS)
  const cfg = mod.normalizeConfig({ prompt: exact })
  assert.equal(cfg.prompt.length, mod.PROMPT_MAX_CHARS)
})

test('空 prompt 仍回落到内置默认，而不是留空串', () => {
  const cfg = mod.normalizeConfig({ prompt: '   ' })
  assert.ok(cfg.prompt.length > 0, '空提示词应回落默认')
  assert.notEqual(cfg.prompt.trim(), '')
})
