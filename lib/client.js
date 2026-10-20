/**
 * dsh-narrator 的浏览器半侧。
 *
 * 产物格式必须是 `window.__ModuleLoader__.load({ id, factory(require) })`，
 * `id` 必须等于包名（宿主按包名挂载模块）。React 由浏览器模块表提供，
 * 不随插件打包，所以直接 `require('react')`。
 *
 * 这里只做两件事：
 *   ① 设置卡（`settings.section`）—— 读写 `/api/narrator/config`
 *   ② 浮窗（`shell.overlay`）—— 轮询 `/api/narrator/latest`，显示模型刚说的原文
 *
 * 为什么必须有浮窗：宿主的 `assistantDefinition.match` 把同一 `turn:step` 的
 * 消息归并成一个会话节点，节点 settled 后 `projectAssistant` 整体改用真实回复的
 * blocks，任何插进对话流的旁白都会被覆盖掉。`shell.overlay` 不参与会话投影。
 */
window.__ModuleLoader__.load({
  id: 'dsh-narrator',

  factory(require) {
    const React = require('react')

    const API = '/api/narrator'

    /** 静默时长滑杆的量程（分钟）。 */
    const MIN_MINUTES = 1
    const MAX_MINUTES = 60
    const MINUTE_STEP = 1

    /** 测试区块的秒级量程。 */
    const TEST_SECONDS_MIN = 1
    const TEST_SECONDS_MAX = 60

    /**
     * 浮窗停留时长的量程。
     *
     * 下限 5 秒：再短用户还没来得及读完标题就没了。
     * 上限 600 秒（10 分钟）：够长，但设成「永不消失」会让浮窗变成钉子户。
     * **不能复用 TEST_SECONDS_MAX（60）**，否则默认的 90 秒会被夹成 60。
     */
    const LINGER_SECONDS_MIN = 5
    const LINGER_SECONDS_MAX = 600

    /** 浮窗透明度量程。 */
    const OPACITY_MIN = 0.35
    const OPACITY_MAX = 1
    const OPACITY_STEP = 0.05

    /**
     * 浮窗轮询间隔。
     *
     * 2 秒是权衡：太快会让宿主每 2 秒处理一次 HTTP 请求（虽小但不为零），
     * 太慢则模型开口之后浮窗要等更久才出现。位置更新另由 ResizeObserver 负责，
     * 不受这个间隔限制。
     */
    const POLL_MS = 2000

    const h = React.createElement

    // ---------------------------------------------------------------------
    // 工具
    // ---------------------------------------------------------------------

    /** 把分钟数排成人话。整分钟直接报分钟，不足 1 分钟才退回秒。 */
    function humanize(minutes) {
      const total = Math.round(Number(minutes) * 60)
      if (!Number.isFinite(total) || total <= 0) return '0 分钟'
      if (total < 60) return `${total} 秒`
      const m = Math.floor(total / 60)
      const s = total % 60
      return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`
    }

    /** 秒 → 分钟（保留两位小数，只用于展示与脏值比较）。 */
    function toMinutes(seconds) {
      const m = Math.round((Number(seconds) / 60) * 100) / 100
      return Number.isFinite(m) && m > 0 ? m : 0
    }

    /**
     * 分钟 → 秒。下限固定 60 秒：界面最小档就是 1 分钟，
     * 低于它的历史配置（比如早先手调的 10 秒）保存后按 1 分钟生效。
     */
    function toSeconds(minutes) {
      const s = Math.round(Number(minutes) * 60)
      if (!Number.isFinite(s)) return MIN_MINUTES * 60
      return Math.max(MIN_MINUTES * 60, s)
    }

    /** 把任意分钟数夹到滑杆量程内，并取整到 1 分钟刻度。 */
    function clampMinutes(minutes) {
      const n = Number(minutes)
      if (!Number.isFinite(n)) return MIN_MINUTES
      return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)))
    }

    /** 测试模式秒数：夹到 1~60 的整数秒。 */
    function clampTestSeconds(seconds, fallback = TEST_SECONDS_MIN) {
      const n = Number(seconds)
      if (!Number.isFinite(n)) return fallback
      return Math.min(TEST_SECONDS_MAX, Math.max(TEST_SECONDS_MIN, Math.round(n)))
    }

    /**
     * 浮窗停留时长：夹到 5~600 秒。
     *
     * 与 `clampTestSeconds` 分开是必须的——后者的上限是 60 秒，而停留时长的
     * 默认值就是 90 秒。复用会让「默认值一进界面就被夹成 60」，保存后再读回来
     * 与输入不符，是那种只有盯着数字才发现得了的静默错误。
     */
    function clampLinger(seconds, fallback = 90) {
      const n = Number(seconds)
      if (!Number.isFinite(n)) return fallback
      return Math.min(LINGER_SECONDS_MAX, Math.max(LINGER_SECONDS_MIN, Math.round(n)))
    }

    /** 透明度：夹到 0.35~1，保留两位。 */
    function clampOpacity(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return OPACITY_MAX
      return Math.round(Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, n)) * 100) / 100
    }

    function opacityPercent(value) {
      return `${Math.round(clampOpacity(value) * 100)}%`
    }

    /**
     * 两批浮层记录是否等价。
     *
     * 轮询每 2 秒来一次，服务端几乎每次都回同样的内容。不做这层判断的话，
     * `setRecords(新数组)` 会让浮层每 2 秒重渲染一次。
     * 只比浮层渲染真正用到的字段。
     */
    const RECORD_FIELDS = [
      'at',
      'text',
      'turn',
      'step',
      'silentSeconds',
      'pending',
      'phase',
      'waiting',
      'waitingTool',
    ]

    function sameRecords(prev, next) {
      if (prev === next) return true
      if (!Array.isArray(prev) || !Array.isArray(next)) return false
      if (prev.length !== next.length) return false
      for (let i = 0; i < next.length; i += 1) {
        const a = prev[i]
        const b = next[i]
        if (a === b) continue
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
        if (a.session !== b.session) return false
        for (const key of RECORD_FIELDS) {
          if (a[key] !== b[key]) return false
        }
      }
      return true
    }

    /** `runningMap` 同理：内容没变就复用旧引用，别触发重渲染。 */
    function sameRunningMap(prev, next) {
      if (prev === next) return true
      if (prev === null || next === null || typeof prev !== 'object' || typeof next !== 'object') return false
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      if (prevKeys.length !== nextKeys.length) return false
      for (const key of nextKeys) {
        if (prev[key] !== next[key]) return false
      }
      return true
    }

    /**
     * `waitingMap` 的专用比较。
     *
     * 每项是对象（`{label, tool, startedAt}`），不能用 `sameRunningMap` 的
     * `prev[key] !== next[key]`——每次轮询服务端都新造对象，引用永远不等，
     * 结果就是每 2 秒一次白重渲染。这里逐字段比，内容一样就复用旧引用。
     *
     * 注意**不要**把「已等了多少秒」放进比较：那是个每秒都在变的值，
     * 只会让去重永远失效。秒数由前端用 `startedAt` 现算。
     */
    function sameWaitingMap(prev, next) {
      if (prev === next) return true
      if (prev === null || next === null || typeof prev !== 'object' || typeof next !== 'object') return false
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      if (prevKeys.length !== nextKeys.length) return false
      for (const key of nextKeys) {
        const a = prev[key]
        const b = next[key]
        if (a === b) continue
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
        if (a.label !== b.label || a.tool !== b.tool || a.startedAt !== b.startedAt) return false
      }
      return true
    }

    /**
     * 取「分钟」那一栏该显示的值。
     *
     * 测试模式打开时，`silentSeconds` 是秒级测试值（比如 5），
     * 上面那个分钟框不该跟着跳到 0，得继续显示用户的正常配置。
     * 服务端为此单独给了 `normalSilentSeconds` / `normalCooldownSeconds`。
     */
    function normalSecondsOf(cfg, key) {
      if (cfg === null || cfg === undefined) return 60
      const normal = key === 'silent' ? cfg.normalSilentSeconds : cfg.normalCooldownSeconds
      if (normal !== undefined && normal !== null && Number.isFinite(Number(normal))) return Number(normal)
      // 老版本服务端没有 normal* 字段，退回生效值
      return key === 'silent' ? cfg.silentSeconds : cfg.cooldownSeconds
    }

    /** 读配置。失败返回 null。 */
    async function fetchConfig() {
      try {
        const res = await fetch(`${API}/config`, { headers: { accept: 'application/json' } })
        if (!res.ok) return null
        const body = await res.json()
        return body && body.ok ? body.config : null
      } catch {
        return null
      }
    }

    /**
     * 存配置。
     *
     * 返回 `{ok:true, config}` 或 `{ok:false, error, keys?}`：服务端对非法值
     * 明确回 400 并列出被拒的键，界面必须把它转成人话，否则用户只会看到
     * 一句含糊的「保存失败，请重试」，重试多少次都不会成功。
     */
    async function saveConfig(patch) {
      try {
        const res = await fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: patch }),
        })
        let body = null
        try {
          body = await res.json()
        } catch {
          body = null
        }
        if (body && body.ok && body.config) return { ok: true, config: body.config }
        return {
          ok: false,
          error: typeof body?.error === 'string' ? body.error : res.ok ? 'unknown' : `http-${res.status}`,
          keys: Array.isArray(body?.keys) ? body.keys : undefined,
        }
      } catch (error) {
        return { ok: false, error: 'network', detail: String(error) }
      }
    }

    /** 把保存失败翻译成用户能据以行动的话。 */
    function describeSaveError(result) {
      const keys = Array.isArray(result?.keys) ? result.keys : []
      if (keys.length > 0) {
        const names = keys.map(fieldLabel).join('、')
        return `这些值不合法，没有保存：${names}。请调整后重试。`
      }
      if (result?.error === 'save-failed') return '写入配置文件失败，请检查磁盘权限后重试。'
      if (result?.error === 'network') return '连不上插件服务，请确认宿主仍在运行。'
      if (result?.error === 'bad-request') return '请求格式不对，请刷新页面后重试。'
      return '保存失败，请重试。'
    }

    /** 配置键 → 界面上的叫法。 */
    function fieldLabel(key) {
      if (key === 'silentSeconds') return '汇报间隔'
      if (key === 'cooldownSeconds') return '两次汇报的最短间隔'
      if (key === 'testSilentSeconds' || key === 'testCooldownSeconds') return '测试模式时长'
      if (key === 'prompt') return '提示词'
      if (key === 'lingerSeconds') return '浮窗停留'
      return String(key)
    }

    // ---------------------------------------------------------------------
    // 与宿主设置页同款的下拉选择器
    //
    // 替换掉原生 <select>：Windows 上它展开是浏览器自绘的直角白菜单，
    // 和宿主截图里那种浅灰圆角面板 + 当前项打勾完全不是一回事。
    //
    // 下面的样式是从宿主 asar 里抄的实测值：
    //   触发器 = PreferenceRow_module_css_default.selector
    //     36px 高 / --dsw-radius-md / --dsw-alias-bg-module-platform / padding 0 14px / gap 12px
    //   菜单卡 = --dsw-specific-menu + --dsw-menu-backdrop-filter + --dsw-elevation-panel
    //     圆角 --dsw-radius-lg / padding 4px / max-height 400px
    //   菜单项 = MenuView_module_css_default.item
    //     34px 高 / padding 6px 8px / 13px 字 / 圆角 --dsw-radius-md
    //   勾选放在 trailing（margin-left:auto）
    //
    // 这些变量都在 app.asar 里核验过存在。教训：--dsw-alias-bg-elevated 宿主
    // 根本没定义，写了会静默回落到兜底深色值，浅色主题下就变黑底。
    // ---------------------------------------------------------------------
    const SELECT_STYLE = `
.narr-field { position: relative; flex: 0 0 auto; }
.narr-trigger {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, currentColor);
  background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.10));
  border: none;
  border-radius: var(--dsw-radius-md, 8px);
  cursor: pointer;
}
.narr-trigger:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16)); }
.narr-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: 1px; }
.narr-trigger.open .narr-caret { transform: rotate(180deg); }
.narr-select-value { white-space: nowrap; }
.narr-caret { flex: none; font-size: 9px; line-height: 1; opacity: 0.72; transition: transform 0.12s ease; }
.narr-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 60;
  box-sizing: border-box;
  min-width: 100%;
  max-height: 400px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border: 0;
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #2b2b2b));
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  box-shadow: var(--dsw-elevation-panel, 0 12px 32px rgba(0,0,0,0.28));
}
.narr-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, currentColor);
  text-align: left;
  white-space: nowrap;
  background: transparent;
  border: none;
  border-radius: var(--dsw-radius-md, 8px);
  cursor: pointer;
}
.narr-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16)); }
.narr-menu-item.active { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16)); }
.narr-menu-check { margin-left: auto; flex: none; display: inline-flex; align-items: center; }
`

    /** 与宿主同款的下拉。`props` = `{options, value, onChange, ariaLabel}` */
    function MenuSelect(props) {
      const { options, value, onChange, ariaLabel } = props
      const [open, setOpen] = React.useState(false)
      const box = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const node = box.current
          if (node !== null && node !== undefined && typeof node.contains === 'function') {
            if (node.contains(event.target)) return
          }
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const current = options.find((option) => String(option.value) === String(value)) ?? options[0]

      return h(
        'div',
        { className: 'narr-field', ref: box },
        h(
          'button',
          {
            type: 'button',
            className: 'narr-trigger' + (open ? ' open' : ''),
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            'aria-label': ariaLabel,
            onClick: () => setOpen((prev) => !prev),
          },
          h('span', { className: 'narr-select-value' }, current === undefined ? '' : current.label),
          h('span', { className: 'narr-caret', 'aria-hidden': 'true' }, '\u25be'),
        ),
        open
          ? h(
              'div',
              { className: 'narr-menu', role: 'listbox', 'aria-label': ariaLabel },
              options.map((option) =>
                h(
                  'button',
                  {
                    key: String(option.value),
                    type: 'button',
                    role: 'option',
                    'aria-selected': String(option.value) === String(value),
                    className:
                      'narr-menu-item' + (String(option.value) === String(value) ? ' active' : ''),
                    onClick: () => {
                      setOpen(false)
                      onChange(option.value)
                    },
                  },
                  h('span', null, option.label),
                  String(option.value) === String(value)
                    ? h('span', { className: 'narr-menu-check', 'aria-hidden': 'true' }, '\u2713')
                    : null,
                ),
              ),
            )
          : null,
      )
    }

    const STYLE = SELECT_STYLE + `
/*
 * 底部不留内边距（padding-bottom 为 0）。
 *
 * sticky 的行程受包含块的 padding box 限制：滚到底时它最多贴到内容盒底边。
 * 这里若留了 4px 下内边距，底栏就会比「贴住视口下沿」时高出 4px——表现
 * 就是用户滚到最下面那一下，保存按钮自己往上跳一下。
 * 顶部那 4px 保留（视觉呼吸），左右 2px 保留（与卡片描边对齐）。
 */
.narr-root { display: flex; flex-direction: column; gap: 16px; max-width: 700px; padding: 4px 2px 0; }
.narr-head { display: flex; flex-direction: column; gap: 6px; }
.narr-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, currentColor); }
.narr-desc { font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95)); }
.narr-row { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28)); border-radius: 10px; }
.narr-row-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.narr-label { font-size: 13.5px; font-weight: 550; color: var(--dsw-alias-label-primary, currentColor); }
.narr-hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95)); }
.narr-slider { width: 100%; margin: 0; accent-color: var(--dsw-alias-brand-primary, #247bbf); }
.narr-scale { display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.8)); }
.narr-numfield { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.narr-value { font-size: 13px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95)); }
.narr-numinput { width: 64px; padding: 6px 9px; font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; color: var(--dsw-alias-label-primary, currentColor); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4)); border-radius: 8px; }
.narr-numinput:hover { border-color: var(--dsw-alias-border-l3, rgba(127,127,127,0.6)); }
.narr-numinput:focus { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: 1px; border-color: transparent; }
.narr-unit { font-size: 12.5px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95)); }
.narr-toggle { display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer; color: var(--dsw-alias-label-primary, #1f2329); }
.narr-toggle input { margin: 0; accent-color: var(--dsw-alias-brand-primary, #247bbf); }
.narr-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--dsw-alias-label-primary, currentColor); }
.narr-switch input { accent-color: var(--dsw-alias-brand-primary, #247bbf); }
.narr-textarea { width: 100%; box-sizing: border-box; min-height: 132px; padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-primary, currentColor); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4)); border-radius: 8px; resize: vertical; }
.narr-textarea:focus { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: 1px; border-color: transparent; }
.narr-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
/*
 * 保存/恢复默认固定在设置卡底部。
 *
 * 设置项一多（现在有十几个），用户拖到下面改完某一行后要滚回去找保存按钮，
 * 或者滚到底后看不到当前是"保存中"还是"已保存"。sticky 让它跟随滚动停在
 * 卡片下沿——不需要知道宿主的滚动容器是谁，也不影响上面的布局。
 *
 * 背景必须不透明，而且必须**向下溢出一截**：
 *
 *   1. sticky bottom: 0 只保证底栏"不早于滚动视口下沿"。滚到底时它被自己的
 *      包含块（.narr-root）拽住，停在内容末尾，下沿就对不上视口下沿了。
 *   2. 宿主设置面板的滚动容器（.wCInkW_options）在滚动区里留了 24px 的
 *      padding-bottom，那 24px 属于滚动区，滚过去的文字照样从按钮底下穿。
 *
 * 所以按钮条下面那截也得上底色。用向下偏移的实心 box-shadow：
 *   - 不参与布局。先前试过 ::after 绝对定位，它会把 scrollHeight 撑大 12px，
 *     滚到底凭空多出一截空白，反而更难看；
 *   - 不拦截点击，纯视觉；
 *   - 超出面板的部分由宿主的 overflow: hidden 裁掉，不会漏到面板外。
 * 40px 足够盖住 24px 内边距加滚动条余量，滚到任意位置都留不出缝。
 * 深色主题走同一个 --dsw-alias-bg-layer-1，不用单独写分支。
 */
.narr-foot { position: sticky; bottom: 0; z-index: 2; margin-top: 4px; padding: 10px 0 4px; background: var(--dsw-alias-bg-layer-1, #fff); border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28)); box-shadow: 0 40px 0 0 var(--dsw-alias-bg-layer-1, #fff); }
.narr-btn { padding: 6px 14px; font-size: 13px; color: #fff; background: var(--dsw-alias-brand-primary, #247bbf); border: none; border-radius: 7px; cursor: pointer; }
.narr-btn:disabled { opacity: 0.55; cursor: default; }
.narr-btn.quiet { color: var(--dsw-alias-label-primary, currentColor); background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4)); }
.narr-msg { font-size: 12.5px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95)); }
.narr-msg.err { color: var(--dsw-alias-state-error-primary, #d9534f); }
.narr-note { font-size: 12px; line-height: 1.6; padding: 9px 12px; border-radius: 8px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.95)); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08)); }
.narr-test { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border-radius: 10px; border: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.4)); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); }
.narr-test-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
`

    /**
     * 一行设置：标题在左、自绘下拉在右，下面一行说明。
     * @param {{label: string, hint: string, value: string, options: Array<{value: string, label: string}>, onChange: (v: string) => void}} props
     */
    function NativeSelectRow(props) {
      const { label, hint, value, options, onChange } = props
      return h(
        'div',
        { className: 'narr-row' },
        h(
          'div',
          { className: 'narr-row-head' },
          h('span', { className: 'narr-label' }, label),
          h(MenuSelect, { value, options, ariaLabel: label, onChange }),
        ),
        hint === undefined || hint === null ? null : h('div', { className: 'narr-hint' }, hint),
      )
    }

    /**
     * 一行「分钟」设置：标题 + 数字输入框 + 线性滑杆。
     *
     * 用户明确要求用**能直接敲数字的输入框**而不是预设档位：档位再全也覆盖不了
     * 「我要 7 分钟」这种需求。滑杆是线性的（1~60 分钟，步进 1 分钟），
     * 因为对数刻度看起来像坏了——同样是 1 格，两端差了几十倍。
     */
    function MinuteRow(props) {
      const { label, hint, minutes, setMinutes, min, max } = props
      const low = min ?? MIN_MINUTES
      const high = max ?? MAX_MINUTES
      const value = clampMinutes(minutes)
      // 输入过程中的原始文本要留住，否则敲「12」时第一下「1」会被夹成合法值再回写，
      // 光标跳走、后面的「2」也接不上。失焦时才夹紧并归一。
      const [draft, setDraft] = React.useState(String(value))
      const [focused, setFocused] = React.useState(false)

      React.useEffect(() => {
        if (!focused) setDraft(String(value))
      }, [value, focused])

      const commit = () => {
        setFocused(false)
        const n = Number(draft)
        if (!Number.isFinite(n) || draft.trim() === '') {
          setMinutes(value)
          setDraft(String(value))
          return
        }
        const clamped = Math.min(high, Math.max(low, Math.round(n)))
        setMinutes(clamped)
        setDraft(String(clamped))
      }

      return h(
        'div',
        { className: 'narr-row' },
        h(
          'div',
          { className: 'narr-row-head' },
          h('span', { className: 'narr-label' }, label),
          h(
            'div',
            { className: 'narr-numfield' },
            h('input', {
              className: 'narr-numinput',
              type: 'number',
              min: low,
              max: high,
              step: MINUTE_STEP,
              value: draft,
              'aria-label': `${label}（分钟）`,
              onFocus: () => setFocused(true),
              onChange: (e) => {
                setDraft(e.target.value)
                // 边敲边生效（合法就采纳），让滑杆跟着动；非法值等失焦再兜底
                const n = Number(e.target.value)
                if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= low && n <= high) {
                  setMinutes(Math.round(n))
                }
              },
              onBlur: commit,
              onKeyDown: (e) => {
                if (e && e.key === 'Enter') commit()
              },
            }),
            h('span', { className: 'narr-unit' }, '分钟'),
          ),
        ),
        h('input', {
          className: 'narr-slider',
          type: 'range',
          min: low,
          max: high,
          step: MINUTE_STEP,
          value,
          'aria-label': label,
          'aria-valuetext': humanize(value),
          onChange: (e) => setMinutes(clampMinutes(e.target.value)),
        }),
        h(
          'div',
          { className: 'narr-scale' },
          h('span', null, `${low} 分钟`),
          h('span', null, `${high} 分钟`),
        ),
        h('div', { className: 'narr-hint' }, hint),
      )
    }

    /**
     * 一行「秒」设置：标题 + 数字输入框 + 线性滑杆。
     *
     * 量程默认走测试区块的 1~60 秒，但可以用 `min`/`max` 覆盖：浮窗停留时长
     * 的默认值就是 90 秒，若也按 60 封顶，用户设的值会被**静默夹小**
     * （保存后再读回来变成 60，与输入不符）。
     */
    function TestRow(props) {
      const { label, seconds, setSeconds, min, max, hint } = props
      const low = min ?? TEST_SECONDS_MIN
      const high = max ?? TEST_SECONDS_MAX
      const clamp = (v, fallback) => {
        const n = Number(v)
        if (!Number.isFinite(n)) return fallback
        return Math.min(high, Math.max(low, Math.round(n)))
      }
      const value = clamp(seconds, low)
      return h(
        'div',
        { className: 'narr-row' },
        h(
          'div',
          { className: 'narr-row-head' },
          h('span', { className: 'narr-label' }, label),
          h(
            'div',
            { className: 'narr-numfield' },
            h('input', {
              className: 'narr-numinput',
              type: 'number',
              min: low,
              max: high,
              step: 1,
              value: String(value),
              'aria-label': `${label}（秒）`,
              onChange: (e) => setSeconds(clamp(e.target.value, value)),
            }),
            h('span', { className: 'narr-unit' }, '秒'),
          ),
        ),
        h('input', {
          className: 'narr-slider',
          type: 'range',
          min: low,
          max: high,
          step: 1,
          value,
          'aria-label': label,
          'aria-valuetext': `${value} 秒`,
          onChange: (e) => setSeconds(clamp(e.target.value, value)),
        }),
        h(
          'div',
          { className: 'narr-scale' },
          h('span', null, `${low} 秒`),
          h('span', null, `${high} 秒`),
        ),
        hint === undefined || hint === null ? null : h('div', { className: 'narr-hint' }, hint),
      )
    }

    /** 设置卡主体。 */
    function NarratorSettingsCard() {
      const [loaded, setLoaded] = React.useState(null)
      const [silentMinutes, setSilentMinutes] = React.useState(MIN_MINUTES)
      const [cooldownMinutes, setCooldownMinutes] = React.useState(MIN_MINUTES)
      const [enabled, setEnabled] = React.useState(true)
      const [overlayEnabled, setOverlayEnabled] = React.useState(true)
      const [showInjected, setShowInjected] = React.useState(false)
      const [includeSubagents, setIncludeSubagents] = React.useState(true)
      const [overlayOpacity, setOverlayOpacity] = React.useState(OPACITY_MAX)
      const [lingerSeconds, setLingerSeconds] = React.useState(90)
      const [prompt, setPrompt] = React.useState('')
      const [testMode, setTestMode] = React.useState(false)
      const [testSilentSeconds, setTestSilentSeconds] = React.useState(5)
      const [testCooldownSeconds, setTestCooldownSeconds] = React.useState(10)
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const alive = React.useRef(true)

      /** 把服务端返回的配置回填到各输入项。 */
      const applyConfig = React.useCallback((cfg) => {
        setSilentMinutes(clampMinutes(toMinutes(normalSecondsOf(cfg, 'silent'))))
        setCooldownMinutes(clampMinutes(toMinutes(normalSecondsOf(cfg, 'cooldown'))))
        setEnabled(cfg.enabled !== false)
        setOverlayEnabled(cfg.overlayEnabled !== false)
        setShowInjected(cfg.showInjected === true)
        // 与后端同一个判据：只有显式 true 才算打开。后端 `normalizeConfig`
        // 也是 `=== true`，两处必须一致，否则界面显示"开"、实际没开。
        setIncludeSubagents(cfg.includeSubagents === true)
        setOverlayOpacity(clampOpacity(cfg.overlayOpacity))
        setLingerSeconds(clampLinger(cfg.lingerSeconds, 90))
        setPrompt(typeof cfg.prompt === 'string' ? cfg.prompt : '')
        setTestMode(cfg.testMode === true)
        setTestSilentSeconds(clampTestSeconds(cfg.testSilentSeconds, 5))
        setTestCooldownSeconds(clampTestSeconds(cfg.testCooldownSeconds, 10))
      }, [])

      React.useEffect(() => {
        alive.current = true
        fetchConfig().then((cfg) => {
          if (!alive.current) return
          if (cfg === null) {
            setMessage({ kind: 'err', text: '读不到插件配置，宿主服务可能尚未就绪。' })
            return
          }
          setLoaded(cfg)
          applyConfig(cfg)
        })
        return () => {
          alive.current = false
        }
      }, [applyConfig])

      const dirty =
        loaded !== null &&
        (toSeconds(silentMinutes) !== toSeconds(toMinutes(normalSecondsOf(loaded, 'silent'))) ||
          toSeconds(cooldownMinutes) !== toSeconds(toMinutes(normalSecondsOf(loaded, 'cooldown'))) ||
          enabled !== (loaded.enabled !== false) ||
          overlayEnabled !== (loaded.overlayEnabled !== false) ||
          showInjected !== (loaded.showInjected === true) ||
          includeSubagents !== (loaded.includeSubagents === true) ||
          overlayOpacity !== clampOpacity(loaded.overlayOpacity) ||
          lingerSeconds !== clampLinger(loaded.lingerSeconds, lingerSeconds) ||
          // 提示词：空串是**合法**的「用内置默认」，必须算脏，
          // 否则清空输入框后保存按钮永远是禁用的，「恢复默认」也点不动。
          prompt !== (typeof loaded.prompt === 'string' ? loaded.prompt : '') ||
          testMode !== (loaded.testMode === true) ||
          testSilentSeconds !== clampTestSeconds(loaded.testSilentSeconds, testSilentSeconds) ||
          testCooldownSeconds !== clampTestSeconds(loaded.testCooldownSeconds, testCooldownSeconds))

      // 历史配置可能低于最小档（早期版本允许按秒调），提示一下它会按 1 分钟生效。
      const legacySeconds =
        loaded !== null &&
        Number(normalSecondsOf(loaded, 'silent')) > 0 &&
        Number(normalSecondsOf(loaded, 'silent')) < MIN_MINUTES * 60
          ? Number(normalSecondsOf(loaded, 'silent'))
          : null

      const save = React.useCallback(async () => {
        setSaving(true)
        setMessage(null)
        const result = await saveConfig({
          silentSeconds: toSeconds(silentMinutes),
          cooldownSeconds: toSeconds(cooldownMinutes),
          enabled,
          overlayEnabled,
          showInjected,
          includeSubagents,
          overlayOpacity,
          lingerSeconds: clampLinger(lingerSeconds, 90),
          // 空串交给服务端解释成「用内置默认」
          prompt,
          testMode,
          testSilentSeconds: clampTestSeconds(testSilentSeconds),
          testCooldownSeconds: clampTestSeconds(testCooldownSeconds),
        })
        // 先恢复按钮状态，再判断组件是否还活着：否则组件在请求期间重挂载时，
        // saving 会永远停在 true，按钮卡在「保存中…」再也点不动。
        if (alive.current) setSaving(false)
        if (!alive.current) return
        if (result.ok !== true) {
          setMessage({ kind: 'err', text: describeSaveError(result) })
          return
        }
        setLoaded(result.config)
        applyConfig(result.config)
        setMessage({ kind: 'ok', text: '已保存，立即生效。' })
      }, [
        silentMinutes,
        cooldownMinutes,
        enabled,
        overlayEnabled,
        showInjected,
        includeSubagents,
        overlayOpacity,
        lingerSeconds,
        prompt,
        testMode,
        testSilentSeconds,
        testCooldownSeconds,
        applyConfig,
      ])

      const reset = React.useCallback(() => {
        const d = (loaded && loaded.defaults) || {}
        setEnabled(d.enabled !== false)
        setSilentMinutes(clampMinutes(toMinutes(d.silentSeconds != null ? d.silentSeconds : 60)))
        setCooldownMinutes(clampMinutes(toMinutes(d.cooldownSeconds != null ? d.cooldownSeconds : 60)))
        setOverlayEnabled(d.overlayEnabled !== false)
        setShowInjected(d.showInjected === true)
        setIncludeSubagents(d.includeSubagents === true)
        setOverlayOpacity(clampOpacity(d.overlayOpacity))
        setLingerSeconds(clampLinger(d.lingerSeconds, 90))
        // 提示词恢复成内置默认：服务端把 null 解释成默认值，这里用 defaultPrompt 回填原文，
        // 免得用户看到一个空框、以为自己把提示词删没了。
        setPrompt('')
        setTestMode(d.testMode === true)
        setTestSilentSeconds(clampTestSeconds(d.testSilentSeconds, 5))
        setTestCooldownSeconds(clampTestSeconds(d.testCooldownSeconds, 10))
        setMessage(null)
      }, [loaded])

      const defaultPrompt = loaded !== null && typeof loaded.defaultPrompt === 'string' ? loaded.defaultPrompt : ''

      return h(
        'div',
        { className: 'narr-root' },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'narr-head' },
          h('div', { className: 'narr-title' }, '长思考进度旁白'),
          h(
            'div',
            { className: 'narr-desc' },
            '长时间没有文字输出时，插件会让模型先说一句在做什么，然后接着干。任务不会中断。',
          ),
        ),
        h(
          'label',
          { className: 'narr-switch' },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: (e) => setEnabled(e.target.checked),
          }),
          h('span', null, '让模型定期汇报'),
        ),
        legacySeconds === null
          ? null
          : h(
              'div',
              { className: 'narr-note' },
              `当前配置是 ${legacySeconds} 秒，低于最小档 1 分钟；保存后会按 1 分钟生效。`,
            ),
        h(MinuteRow, {
          label: '多久没有文字输出就让它说一句',
          hint: '从最后一次正文输出开始计时。只思考、只调工具都不算。',
          minutes: silentMinutes,
          setMinutes: setSilentMinutes,
          min: MIN_MINUTES,
          max: MAX_MINUTES,
        }),
        h(MinuteRow, {
          label: '两次汇报至少间隔',
          hint: '防止刷屏。设得越小，汇报越频繁。',
          minutes: cooldownMinutes,
          setMinutes: setCooldownMinutes,
          min: MIN_MINUTES,
          max: MAX_MINUTES,
        }),
        h(
          'label',
          { className: 'narr-switch' },
          h('input', {
            type: 'checkbox',
            checked: overlayEnabled,
            onChange: (e) => setOverlayEnabled(e.target.checked),
          }),
          h('span', null, '同时把汇报内容弹到对话区左下角浮窗'),
        ),
        h(
          'div',
          { className: 'narr-row' },
          h(
            'div',
            { className: 'narr-row-head' },
            h('span', { className: 'narr-label' }, '浮窗透明度'),
            h('div', { className: 'narr-numfield' }, h('span', { className: 'narr-value' }, opacityPercent(overlayOpacity))),
          ),
          h('input', {
            className: 'narr-slider',
            type: 'range',
            min: OPACITY_MIN,
            max: OPACITY_MAX,
            step: OPACITY_STEP,
            value: overlayOpacity,
            'aria-label': '浮窗透明度',
            'aria-valuetext': opacityPercent(overlayOpacity),
            onChange: (e) => setOverlayOpacity(clampOpacity(e.target.value)),
          }),
          h(
            'div',
            { className: 'narr-scale' },
            h('span', null, opacityPercent(OPACITY_MIN)),
            h('span', null, opacityPercent(OPACITY_MAX)),
          ),
          h('div', { className: 'narr-hint' }, '只影响对话区左下角浮窗的底色。挡视线就调低。'),
        ),
        h(TestRow, {
          label: '浮窗停留多久后自动消失',
          seconds: lingerSeconds,
          setSeconds: setLingerSeconds,
          min: LINGER_SECONDS_MIN,
          max: LINGER_SECONDS_MAX,
          hint: '最后一条汇报在浮窗里停留多久。期间没有新的汇报就自动收起。',
        }),
        h(
          'div',
          { className: 'narr-row' },
          h(
            'div',
            { className: 'narr-row-head' },
            h('span', { className: 'narr-label' }, '汇报内容怎么给模型说'),
          ),
          h('textarea', {
            className: 'narr-textarea',
            value: prompt,
            placeholder: defaultPrompt,
            'aria-label': '提示词',
            onChange: (e) => setPrompt(e.target.value),
          }),
          h(
            'div',
            { className: 'narr-hint' },
            '留空就用内置默认（上面灰色那段就是默认值）。这条会以用户消息的形式发给模型。',
          ),
          h(
            'label',
            { className: 'narr-toggle' },
            h('input', {
              type: 'checkbox',
              checked: showInjected,
              onChange: (e) => setShowInjected(e.target.checked),
            }),
            h('span', null, '在对话里显示这条提示词（默认隐藏）'),
          ),
          h(
            'label',
            { className: 'narr-toggle' },
            h('input', {
              type: 'checkbox',
              checked: includeSubagents,
              onChange: (e) => setIncludeSubagents(e.target.checked),
            }),
            h('span', null, '子任务里也照样汇报'),
          ),
        ),
        h(
          'div',
          { className: 'narr-test' },
          h(
            'div',
            { className: 'narr-test-head' },
            h('span', { className: 'narr-label' }, '测试'),
            h(
              'label',
              { className: 'narr-switch' },
              h('input', {
                type: 'checkbox',
                checked: testMode,
                onChange: (e) => setTestMode(e.target.checked),
              }),
              h('span', null, '用秒级阈值试一下'),
            ),
          ),
          h('div', { className: 'narr-hint' }, '开启后临时顶替上面的分钟值，方便几秒内看到效果。关掉即恢复。'),
          h(TestRow, {
            label: '多久没有文字输出就提示一次',
            seconds: testSilentSeconds,
            setSeconds: setTestSilentSeconds,
          }),
          h(TestRow, {
            label: '两次提示之间至少间隔',
            seconds: testCooldownSeconds,
            setSeconds: setTestCooldownSeconds,
          }),
        ),
        h(
          'div',
          { className: 'narr-foot' },
          h(
            'button',
            { className: 'narr-btn', type: 'button', disabled: saving || !dirty, onClick: save },
            saving ? '保存中…' : dirty ? '保存' : '已保存',
          ),
          h('button', { className: 'narr-btn quiet', type: 'button', onClick: reset }, '恢复默认'),
          message === null
            ? null
            : h('span', { className: 'narr-msg' + (message.kind === 'err' ? ' err' : '') }, message.text),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 浮窗
    // ---------------------------------------------------------------------

    /**
     * 读当前正在看的会话 id。
     *
     * 宿主在会话根节点上写了 `data-conversation-session`（asar 一手）：
     *   div[data-conversation-content][data-conversation-session=<sessionId>]
     * 浮层只该挂到这一个会话上——用户在 A 会话长思考时切到 B，
     * B 里不该冒出 A 的汇报。
     */
    function currentSessionId() {
      try {
        if (typeof document === 'undefined') return null
        const node = document.querySelector('[data-conversation-session]')
        const id = node?.getAttribute('data-conversation-session')
        return typeof id === 'string' && id !== '' ? id : null
      } catch {
        return null
      }
    }

    /**
     * 实测浮层该待的位置，返回相对 overlayLayer 的 `{left, bottom}`（px）。
     *
     * 对齐目标是**对话正文的左边界**，不是侧边栏右缘，也不是面板左缘。
     * 会话区结构（asar 一手）：
     *   div[data-chat-following-tail] > div.scroll > div.column[data-chat-flow]
     * `.column` 自身 `margin:0 auto` 居中，所以盒左边界就是文字起点，
     * 不能再额外加 padding-left（那会把浮层推右，看着比正文缩进一格）。
     *
     * `bottom` 必须量 `[data-composer-seat]` 的顶边：写死会压住输入框
     * （这是实机踩过的——浮窗挡住输入框，用户没法打字）。
     */
    function measureSeat() {
      const fallback = { left: 304, bottom: 188 }
      try {
        if (typeof document === 'undefined') return fallback
        const layer = document.querySelector('[data-shell-overlay]')
        const layerBox = layer?.getBoundingClientRect()

        /**
         * 判断元素是否真的显示着。
         *
         * 抄宿主自己的 `displayed()`（asar 里 `dsh-client-ui-chat` 的
         * `mainChatRoot()` 用它筛候选）：只认 `[hidden]` 祖先和计算样式的
         * display/visibility，不走 offsetParent —— 后者在 `position:fixed`
         * 的祖先下会误判成隐藏。
         */
        const displayed = (el) => {
          if (el === null || el === undefined) return false
          if (el.isConnected === false) return false
          if (el.closest('[hidden]') !== null) return false
          for (let node = el; node !== null; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (style.display === 'none' || style.visibility === 'hidden') return false
          }
          return true
        }

        const textLeftOf = (el) => {
          if (el === null || el === undefined || layerBox === undefined) return null
          const box = el.getBoundingClientRect()
          if (!(box.width > 0)) return null
          const left = box.left - layerBox.left
          return Number.isFinite(left) ? left : null
        }

        /**
         * 找「主对话」的消息列。
         *
         * ⚠ 这里**不能**用 `document.querySelector('[data-chat-flow]')`。
         * 宿主 DOM 里 `[data-chat-flow]` 不止一处（asar 实测：聊天列本身、
         * `ChatGroupSeat` 的 `[data-step-process-content]` 内部各有一份），
         * 而 `querySelector` 返回**文档序第一个**——它很可能落在侧栏或
         * 折叠的工作步骤面板里。那两者的左边界贴近窗口边缘，量出来的
         * `left` 极小，浮窗就跑到了整个窗口的最左边、压住侧边栏。
         * 症状就是「浮窗现在在左下角」。
         *
         * 宿主自己的 `mainChatRoot()` 是这么筛的（原文）：
         *   [...document.querySelectorAll('[data-slot="main.conversation"]
         *      [data-slot="conversation.view"] [data-chat-flow]')]
         *     .find((element) => element.closest(
         *         '[data-sidebar-right-session], [data-step-process-body]') === null
         *       && displayed(element));
         * 但它依赖 `data-slot` 那两层外壳，插件没法保证它们一定在。
         * 这里退一步：拿全部候选，按「排除侧栏 / 工作步骤面板 / 不可见」
         * 过滤，再取**宽度最大**的那个 —— 主对话列一定是同一屏里最宽
         * 且最居中的那块，侧栏和折叠面板都比它窄。
         */
        const mainFlow = () => {
          const all = [...document.querySelectorAll('[data-chat-flow]')]
          const usable = all.filter(
            (el) =>
              el.closest('[data-sidebar-right-session], [data-step-process-body]') === null && displayed(el),
          )
          if (usable.length === 0) return null
          return usable.reduce((best, el) =>
            el.getBoundingClientRect().width > best.getBoundingClientRect().width ? el : best,
          )
        }

        // ① 首选：消息列本体，与正文同一左边界
        let left = textLeftOf(mainFlow())
        // ② 次选：输入框所在列（与消息列同属一个居中容器）
        if (left === null) {
          const seats = [...document.querySelectorAll('[data-composer-seat]')].filter(displayed)
          left = textLeftOf(seats[0] ?? null)
        }
        // ③ 兜底：侧边栏宽度 + 面板内边距
        if (left === null) {
          let sidebar = 280
          const frame = layer?.parentElement ?? null
          if (frame !== null) {
            const first = Number.parseFloat(String(getComputedStyle(frame).gridTemplateColumns).split(' ')[0])
            if (Number.isFinite(first) && first >= 0) sidebar = first
          }
          left = sidebar + 24
        }

        let bottom = fallback.bottom
        const seat = [...document.querySelectorAll('[data-composer-seat]')].find(displayed) ?? null
        if (seat !== null && layerBox !== undefined && layerBox.height > 0) {
          const gap = layerBox.bottom - seat.getBoundingClientRect().top + 16
          if (Number.isFinite(gap) && gap > 0) bottom = gap
        }

        return { left: Math.max(0, Math.round(left)), bottom: Math.round(bottom) }
      } catch {
        return fallback
      }
    }

    /** 把正文里的行内代码（反引号包起来的部分）渲染成 <code>。 */
    function renderInline(text, keyPrefix) {
      const source = typeof text === 'string' ? text : String(text ?? '')
      if (source === '') return []
      const out = []
      const re = /`([^`]+)`/g
      let cursor = 0
      let match = re.exec(source)
      let i = 0
      while (match !== null) {
        if (match.index > cursor) out.push(source.slice(cursor, match.index))
        out.push(h('code', { key: `${keyPrefix}-c${i}`, className: 'narr-overlay-code' }, match[1]))
        cursor = match.index + match[0].length
        i += 1
        match = re.exec(source)
      }
      if (cursor < source.length) out.push(source.slice(cursor))
      return out
    }

    /**
     * 把模型汇报的原文按段落渲染。
     *
     * 不做 markdown 解析：这段文本是模型临时写给人看的，通常就是几段话（可能带
     * 有序列表）。按空行切段、段内换行原样保留，比强行解析标题/列表更稳，
     * 也不会因为模型偶尔写出 `##` 就把它当标题吃掉。
     */
    function renderReport(text, keyPrefix) {
      const source = typeof text === 'string' ? text : String(text ?? '')
      const paragraphs = source.split(/\n{2,}/).filter((p) => p.trim() !== '')
      return paragraphs.map((para, i) =>
        h(
          'div',
          { key: `${keyPrefix}-p${i}`, className: 'narr-overlay-para' },
          para.split('\n').map((line, j) =>
            h(
              'div',
              { key: `${keyPrefix}-l${i}-${j}`, className: 'narr-overlay-line' },
              renderInline(line, `${keyPrefix}-i${i}-${j}`),
            ),
          ),
        ),
      )
    }

    const OVERLAY_STYLE = `
.narr-overlay{position:absolute;z-index:5;pointer-events:none;max-width:min(420px,38vw);transition:left .12s ease-out,bottom .12s ease-out}
.narr-overlay-card{pointer-events:auto;padding:10px 14px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);opacity:var(--narr-overlay-opacity,1);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));box-shadow:0 6px 24px rgba(0,0,0,.14);font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary,#111);display:flex;flex-direction:column;gap:4px}
.narr-overlay-head{display:flex;align-items:center;gap:6px}
.narr-overlay-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f0a020);flex:none;animation:narr-pulse 1.4s ease-in-out infinite}
@keyframes narr-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.narr-overlay-title{font-weight:600}
.narr-overlay-meta{margin-left:auto;opacity:.66;white-space:nowrap;color:var(--dsw-alias-label-secondary,#61666b)}
.narr-overlay-close{flex:none;width:18px;height:18px;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;opacity:.5;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center}
.narr-overlay-close:hover{opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}
.narr-overlay-body{opacity:.92;max-height:min(46vh,420px);overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:7px}
.narr-overlay-para{display:flex;flex-direction:column;gap:1px}
.narr-overlay-line{margin:0;word-break:break-word}
.narr-overlay-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:0 3px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}
.narr-overlay-foot{opacity:.6;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}
.narr-overlay-wait{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:0 3px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}
body[data-ds-dark-theme] .narr-overlay-card{background:#232324;color:#f9fafb;border-color:#ffffff1f;box-shadow:0 6px 24px rgba(0,0,0,.5);opacity:var(--narr-overlay-opacity,1)}
body[data-ds-dark-theme] .narr-overlay-meta,body[data-ds-dark-theme] .narr-overlay-foot{color:#cfd3d6}
body[data-ds-dark-theme] .narr-overlay-code{background:#ffffff1a}
`

    /**
     * 浮层：轮询 `/api/narrator/latest`，把模型刚说的那段原文显示成对话区左下角小卡。
     *
     * 为什么不用对话流里的卡片：宿主把 `assistant/message` 按 `turn:step` 投影成
     * 一个 `assistant-step` 节点，节点 settled 后 `projectAssistant` 直接改用真实
     * 回复的 blocks，插进去的文字会被同一步的真实回复整体覆盖。浮层不参与会话
     * 投影，是唯一稳定的可见通道。
     *
     * 消散规则（v0.11.0 改）：提示词注入后模型一开口就消失是旧行为，与「显示模型
     * 刚说的原文」直接冲突——说完的瞬间就撤，根本看不完。改成**停留 N 秒**
     * （`lingerSeconds`，设置卡可调），或者手动点右上角关。
     */
    function NarratorOverlay() {
      // 全部会话的旁白快照（每条自带 `session`）。
      // 为什么存全集而不是只存当前会话：切换会话要**零延迟**生效。
      // 如果按会话过滤后再存，用户切走时要等下一次轮询才发现该藏起来，
      // 浮层会残留最长 POLL_MS（2 秒）。
      const [records, setRecords] = React.useState([])
      const [runningMap, setRunningMap] = React.useState({})
      /** 此刻各会话正在等什么（还没轮到 step 边界时也有内容）。 */
      const [waitingMap, setWaitingMap] = React.useState({})
      /**
       * 各会话「主窗口最后一次自己说出正文」的时刻。
       *
       * 浮窗是「模型长时间不出声」的补位。模型一旦重新开口，用户就有新东西
       * 可看，这张卡该退场。判据只能来自服务端的真实事件流（`text-delta`），
       * 不能看 DOM：虚拟滚动、代码高亮、折叠面板都会让 DOM 乱动。
       * 与记录里冻结的 `textAt` 比较——更新的才撤，汇报原文自己不会撤自己。
       */
      const [textAtMap, setTextAtMap] = React.useState({})
      /** 浮窗透明度与停留时长，由后端每轮下发；设置卡改完 2 秒内生效。 */
      const [opacity, setOpacity] = React.useState(OPACITY_MAX)
      const [lingerSeconds, setLingerSeconds] = React.useState(90)
      // 位置每次轮询重量一次：用户拖侧边栏、改窗口高度都会让它变。
      const [seat, setSeat] = React.useState(measureSeat)
      // 用户手动关掉的那条汇报的 `at`：相同 at 的不再出现，换代了自动放行。
      const [closedAt, setClosedAt] = React.useState(0)
      /**
       * 驱动「停留到期自动消散」的心跳。
       *
       * 过期判定原来是纯渲染期计算（`Date.now() - latest.at > lingerSeconds * 1000`），
       * 但轮询里所有 setState 都做了引用去重：内容不变就返回同一个值，React 不重渲染，
       * 那个判断**永远不会被重新求值**，卡片于是一直挂在屏幕上。必须有一个独立于数据
       * 变化的定时器把时间推进入 state。
       */
      const [nowTick, setNowTick] = React.useState(0)

      React.useEffect(() => {
        const id = setInterval(() => setNowTick((n) => n + 1), 1000)
        return () => clearInterval(id)
      }, [])
      // 当前正在看的会话 id：由 MutationObserver 实时跟踪，**不是**轮询时才算。
      const [viewingSession, setViewingSession] = React.useState(currentSessionId)

      /**
       * 实时跟踪「用户现在看的是哪个会话」。
       *
       * 宿主把会话 id 写在 `div[data-conversation-session]` 上，切换对话时
       * 要么改这个属性的值、要么整块节点换掉。两种都要捕捉，所以 attributes
       * 与 childList 一起监听；用 rAF 合并，流式输出狂改 DOM 时每帧最多查一次。
       */
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
        if (typeof MutationObserver !== 'function') return undefined
        let frame = 0
        const sync = () => {
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            const sid = currentSessionId()
            setViewingSession((prev) => (prev === sid ? prev : sid))
          })
        }
        const mo = new MutationObserver(sync)
        mo.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-conversation-session'],
          childList: true,
          subtree: true,
        })
        sync()
        return () => {
          mo.disconnect()
          if (frame !== 0) cancelAnimationFrame(frame)
        }
      }, [])

      // 不在这里把「关掉过」清零。
      //
      // 曾经写过 `React.useEffect(() => setClosedAt(0), [viewingSession])`，
      // 理由是「切走再切回来用户也许还想看」。实际用下来是反的：用户点了
      // 右上角的叉，就是在说「这条我看过了，别再挡着」；切个会话回来它
      // 又冒出来，等于叉按钮没生效。
      //
      // 现在的语义：「已关闭」按**哪一条汇报**记（`closedAt` 存的是那条的
      // `at`）。切走再切回同一条汇报不再弹出；等下一条新汇报（`at` 变了）
      // 才重新出现，所以不会变成永久失聪。

      /**
       * 侧边栏宽度一变就立刻重量位置，不等下一次轮询。
       *
       * 为什么不能只靠轮询：用户拖分隔条时宽度是连续变化的，而轮询每 POLL_MS
       * 才跑一次，浮层会明显「跟不上去、卡住然后跳一下」。
       * 这几个标记都是 asar 里实证存在的：
       *   - `[data-shell-overlay]`：浮层自己的容器（inset:0，跟 frame 同尺寸）
       *   - `[data-chat-flow]`    ：对话列，左边界就是浮层要对齐的位置
       *   - `[data-composer-seat]`：输入框列，决定浮层的底边
       */
      React.useEffect(() => {
        if (
          typeof window === 'undefined' ||
          typeof document === 'undefined' ||
          typeof ResizeObserver !== 'function'
        ) {
          return undefined
        }
        const targets = [
          document.querySelector('[data-shell-overlay]'),
          // 观察**全部**候选而不是第一个：`querySelector` 拿到的可能是侧栏
          // 里那份（见 measureSeat 里的长注释），观察错了就等不到主列的
          // resize，拖侧边栏时浮层会不动。
          ...document.querySelectorAll('[data-chat-flow]'),
          ...document.querySelectorAll('[data-composer-seat]'),
        ].filter((el) => el !== null)

        // 拖拽时一次 resize 可能连发几十个回调，逐次 setState 会掉帧。
        let frame = 0
        const sync = () => {
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            setSeat(measureSeat())
          })
        }
        const ro = new ResizeObserver(sync)
        for (const el of targets) ro.observe(el)
        window.addEventListener('resize', sync)
        return () => {
          ro.disconnect()
          window.removeEventListener('resize', sync)
          if (frame !== 0) cancelAnimationFrame(frame)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          // 轮询仍然保留重量：字体变化等 RO 未必捕捉到的情况由它兜底。
          // 但位置变了才 setState，避免每 2 秒无条件重渲染。
          const nextSeat = measureSeat()
          setSeat((prev) =>
            prev !== null && prev.left === nextSeat.left && prev.bottom === nextSeat.bottom
              ? prev
              : nextSeat,
          )
          try {
            const res = await fetch(`${API}/latest`, { headers: { accept: 'application/json' } })
            if (!res.ok) return
            const body = await res.json()
            if (!alive || !body || !body.ok) return
            // 透明度与停留时长跟着轮询走：设置卡保存后最多 2 秒就生效，不用重启。
            setOpacity((prev) => {
              const next = clampOpacity(body.overlayOpacity)
              return prev === next ? prev : next
            })
            const nextLinger = clampLinger(body.lingerSeconds, 90)
            setLingerSeconds((prev) => (prev === nextLinger ? prev : nextLinger))
            // 总开关或浮层通道单独关掉时，都直接撤卡
            if (body.enabled === false || body.overlayEnabled === false) {
              setRecords([])
              setRunningMap({})
              setWaitingMap({})
              return
            }
            // 存**全集**，渲染时再按 viewingSession 挑：
            // 这样切换会话只触发一次本地重渲染，不需要等网络往返。
            const nextRecords = Array.isArray(body.records) ? body.records : []
            setRecords((prev) => (sameRecords(prev, nextRecords) ? prev : nextRecords))
            const nextRunning =
              body.runningMap !== null && typeof body.runningMap === 'object' ? body.runningMap : {}
            setRunningMap((prev) => (sameRunningMap(prev, nextRunning) ? prev : nextRunning))
            const nextWaiting =
              body.waitingMap !== null && typeof body.waitingMap === 'object' ? body.waitingMap : {}
            setWaitingMap((prev) => (sameWaitingMap(prev, nextWaiting) ? prev : nextWaiting))
            // textAtMap 的值是毫秒时间戳（数字），`sameRunningMap` 那种按字段
            // 值比较正好适用——内容没变就复用旧引用，别让浮层白重渲染。
            const nextTextAt =
              body.textAtMap !== null && typeof body.textAtMap === 'object' ? body.textAtMap : {}
            setTextAtMap((prev) => (sameRunningMap(prev, nextTextAt) ? prev : nextTextAt))
          } catch {
            // 网络抖动不影响主流程，下一轮再试
          }
        }
        void tick()
        const id = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(id)
        }
      }, [])

      // 当前所看会话的那条汇报：**每次渲染现挑**，切换会话时同帧生效。
      const latest =
        viewingSession === null ? null : (records.find((r) => r.session === viewingSession) ?? null)
      const running = viewingSession === null ? false : runningMap[viewingSession] === true
      // 实时等待状态（还没到 step 边界、模型还没开口的那段）。
      // 与 `latest` 分开：`latest` 是「模型说过什么」，`waitingMap` 是「此刻在等什么」。
      const waiting =
        viewingSession === null || waitingMap === null ? null : (waitingMap[viewingSession] ?? null)

      // 关闭只关**这一次**：记住被关掉的那条汇报的 `at`。
      // 切走再切回同一条汇报不再弹出（用户叉掉就是在说"我看过了"），
      // 等下一条新汇报 `at` 变了才重新出现——所以不会变成永久失聪。
      const close = () => {
        if (latest === null) return
        setClosedAt(latest.at)
      }

      if (latest === null) return null
      // ① 用户刚点过关闭，且还是同一条汇报 → 藏起来
      if (latest.at === closedAt) return null
      //    `nowTick` 是每秒递增的心跳：下面「已经多久没说话」这类判断
      //    要在渲染期重新求值，而轮询里的 state 全是引用去重的，
      //    没有这个心跳的话卡片会永久挂住。
      void nowTick
      const pending = latest.pending === true

      // ② 主窗口又自己说了正文 → 撤卡。
      //
      // 浮窗的职责是补「模型长期不出声」这段信息真空。它一开口，用户就有
      // 新东西可看，这张卡继续占着只是挡路。原来这里只有 `running`
      // （会话还在跑吗）——长任务连着跑十几分钟，浮窗于是永不消失，
      // 正文早就输出过一大段也没用。
      //
      // 比的是「现在最后一次正文时刻」与「这条记录诞生时冻结的 textAt」：
      //   - 汇报原文自己那串 `text-delta` 已经把 `textAt` 冻进记录了，
      //     所以不会出现"刚写完就把自己撤掉"；
      //   - 子代理的输出进不到 `textAtMap`（服务端在子会话上就 return 了）。
      const currentTextAt = viewingSession === null ? 0 : (textAtMap[viewingSession] ?? 0)
      const recordTextAt = Number.isFinite(latest.textAt) ? latest.textAt : latest.at
      if (currentTextAt > recordTextAt) return null

      // ③ 任务结束且已过停留期 → 自动消散（任务还在跑就一直挂着）
      if (!pending && !running && Date.now() - latest.at > lingerSeconds * 1000) return null

      // 「还在等」那张卡：模型已被要求汇报，但还要等到下一个 step 边界才真的
      // 开口。主窗口调子代理时这段可能长达几分钟，卡片得说清在等什么。
      const reporting = pending && latest.phase === 'reporting'
      const waitInfo =
        waiting !== null && waiting !== undefined
          ? waiting
          : latest.waiting === null || latest.waiting === undefined
            ? null
            : { label: latest.waiting, tool: latest.waitingTool, startedAt: null }
      const waitSeconds =
        waitInfo !== null && Number.isFinite(waitInfo.startedAt)
          ? Math.max(1, Math.round((Date.now() - waitInfo.startedAt) / 1000))
          : null

      const title = pending ? (reporting ? '正在整理汇报' : '还在等') : '正在汇报'

      let body = null
      if (pending) {
        // 「还在等」这张卡：先放上一段汇报的原文（如果有），再补一行说清这次在等
        // 什么、等了多久。原文必须留住——只显示"还在等"会让用户眼前的信息倒退回
        // 去：明明刚看过模型说了什么，一到点反而看不见了。
        const waitLine =
          waitInfo === null
            ? reporting
              ? '模型正在整理这次汇报，任务没有中断。'
              : '模型还没开口，任务没有中断。'
            : waitSeconds === null
              ? `${waitInfo.label}。`
              : `${waitInfo.label}，已经等了 ${waitSeconds} 秒。`
        const waitNode = h(
          'div',
          { className: 'narr-overlay-para narr-overlay-waitline', key: 'wait' },
          h('div', { className: 'narr-overlay-line' }, waitLine),
        )
        body = h(
          'div',
          { className: 'narr-overlay-body' },
          ...(typeof latest.text === 'string' && latest.text !== ''
            ? // 展开成扁平数组：`renderReport` 本身返回数组，再套一层会变成
              // [[...], waitNode]，React 能展平但测试桩不展，且可读性差。
              [...renderReport(latest.text, 'r'), waitNode]
            : [waitNode]),
        )
      } else if (typeof latest.text === 'string' && latest.text !== '') {
        // 正文就是模型自己写的那段原文，不拼模板、不改写、不总结。
        body = h('div', { className: 'narr-overlay-body' }, renderReport(latest.text, 'r'))
      }

      return h(
        'div',
        {
          className: 'narr-overlay',
          style: {
            left: `${seat.left}px`,
            bottom: `${seat.bottom}px`,
            '--narr-overlay-opacity': String(opacity),
          },
        },
        h('style', null, OVERLAY_STYLE),
        h(
          'div',
          { className: 'narr-overlay-card' },
          h(
            'div',
            { className: 'narr-overlay-head' },
            h('span', { className: 'narr-overlay-dot' }),
            h('span', { className: 'narr-overlay-title' }, title),
            h(
              'span',
              { className: 'narr-overlay-meta' },
              `约 ${Math.max(1, Math.round(latest.silentSeconds))} 秒没说话`,
            ),
            h(
              'button',
              {
                className: 'narr-overlay-close',
                type: 'button',
                title: '关闭',
                'aria-label': '关闭进度提示',
                onClick: close,
              },
              '\u00d7',
            ),
          ),
          body,
          h('div', { className: 'narr-overlay-foot' }, `第 ${latest.step} 步 · 任务没有中断`),
        ),
      )
    }

    return {
      inject: ['slots'],

      /**
       * 给测试用的内部出口。
       *
       * 浏览器插件模块只有一个 `apply` 入口，宿主不认别的字段，所以这些
       * 函数正常情况下拿不到外部调用者。但「浮窗贴哪儿」这类几何计算没法
       * 靠渲染树断言——它读的是真实 DOM 的 `getBoundingClientRect`，
       * 必须能单独喂假 DOM 才测得出来。这里的额外字段宿主会忽略，无副作用。
       */
      __internal: { measureSeat },

      /**
       * 挂载浏览器半侧。
       * @param {object} ctx 浏览器插件上下文
       */
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'narrator',
              order: 60,
              label: () => '进度旁白',
            },
            NarratorSettingsCard,
          ),
        )

        // 浮层通道：对话流里的旁白会被宿主的 step 投影覆盖，
        // 所以真正「一定看得见」的是这条与对话投影无关的全局悬浮层。
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'narrator-progress',
              order: 100,
            },
            NarratorOverlay,
          ),
        )
      },
    }
  },
})
