/**
 * 读取 narrator 的运行期自检，并给出人话诊断。
 *
 * 用法: node test/check-status.mjs [port]
 */
const port = process.argv[2] ?? '50090'

async function get(path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`)
  const ct = r.headers.get('content-type') ?? ''
  if (!r.ok) return { ok: false, status: r.status, body: await r.text() }
  if (!ct.includes('json')) return { ok: false, status: r.status, body: await r.text() }
  return { ok: true, status: r.status, body: await r.json() }
}

const s = await get('/api/narrator/status')
if (!s.ok) {
  console.log(`端口 ${port} 上没有 narrator 路由（HTTP ${s.status}）`)
  console.log(`返回内容: ${String(s.body).slice(0, 120)}`)
  console.log('\n可能原因：')
  console.log('  1. 宿主重启后端口变了，你查的是旧端口')
  console.log('  2. 插件没有加载（检查 package.json 的 dsh.profile.bundles 是否含 dsh-narrator）')
  process.exit(1)
}

const d = s.body
console.log(JSON.stringify(d, null, 2))

const st = d.stats ?? {}
const cfg = d.config ?? {}

console.log('\n=== 诊断 ===')
if (st.startFrames === undefined) {
  console.log('✗ stats 缺失：宿主加载的是很旧的版本')
} else if (st.startFrames === 0) {
  console.log('✗ 没有任何流式事件到达插件：插件没被加载，或宿主跑的是旧代码')
} else {
  console.log(`✓ 流式事件正常：start ${st.startFrames} / chunk ${st.chunkFrames} / end ${st.endFrames}`)
}

if (st.stepsSeen > 0) {
  const maxSec = st.maxStepSeconds ?? 0
  const avgSec = st.avgStepSeconds ?? 0
  const silent = cfg.silentSeconds ?? 25
  console.log(`✓ 观测到 ${st.stepsSeen} 个 step，最长 ${maxSec}s，平均 ${avgSec}s`)

  if (maxSec < silent) {
    console.log(`\n⚠ 关键：最长的 step 只有 ${maxSec}s，而你设的阈值是 ${silent}s ——`)
    console.log('  一次都触发不了是正常的，不是 bug。')
    console.log(`  想要它出现，把阈值调到 ${Math.max(1, Math.floor(maxSec * 0.6))}s 以下，`)
    console.log('  或者等一个真正长的思考。')
  } else {
    console.log(`✓ 有 step 超过阈值 ${silent}s`)
  }
} else if (st.startFrames > 0) {
  console.log('· 还没观测到完整的 step（start 到 end），多跑几轮再看')
}

if (st.injected > 0) {
  console.log(`✓ 已成功插入 ${st.injected} 条旁白，最近一次 ${st.lastInjectAt}`)
} else {
  console.log('· 尚未插入过旁白')
  const sk = st.skipped ?? {}
  const nonzero = Object.entries(sk).filter(([, v]) => v > 0)
  if (nonzero.length > 0) {
    console.log('  跳过计数：' + nonzero.map(([k, v]) => `${k}=${v}`).join(', '))
    console.log('  （notSilent 大是正常的，代表每次都在重新计时）')
  }
}

if (st.lastError) {
  console.log(`\n✗ 写侧报错：${st.lastError}`)
  console.log('  assistant/message 不能带 sourceEventSeqs，且必须带 stream: []')
}

console.log(`\n配置：阈值 ${cfg.silentSeconds}s（${cfg.silentMinutes} 分钟）`
  + ` / 冷却 ${cfg.cooldownSeconds}s / 每回合上限 ${cfg.maxPerTurn}`)
