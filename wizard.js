/**
 * GUI 向导页（通道 ③）：http://127.0.0.1:46084/wizard（仅本机可开）
 *
 * 服务端渲染当前状态 + 内联轻脚本驱动分步操作：
 *   状态清单随页面渲染（每步执行完自动 reload 刷新）→ 每步一个按钮 → 执行输出
 *   经 sessionStorage 跨刷新展示 → waiting 态显示「我已完成，继续」→ 全部就绪后
 *   展示手机二维码与地址。
 * 交互走同源 API（POST /remote-bridge/api/step），由 index.js 的转发器窥探复用应答；
 * 本页只在本机（loopback）可达。
 */

/** 产出向导页 HTML。status 来自 collectStatus；mintUrl/qrSvg 来自配对页同一铸造逻辑。 */
export function buildWizardPage({ status, mintUrl, qrSvg, cfg, listen }) {
  const esc = (text) => String(text)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

  /** 单步按钮定义：id、标题、说明。 */
  const STEPS = [
    { id: 'install', title: '1 · 安装 Tailscale', desc: 'brew 安装 CLI（约 25MB，无需 sudo；一到几分钟）', skipWhen: status.checks.tailscaleInstalled },
    { id: 'daemon', title: '2 · 启动守护进程', desc: '用户态模式，开机自启，无需 sudo', skipWhen: status.checks.daemonRunning },
    { id: 'login', title: '3 · 登录 Tailscale', desc: '会自动打开浏览器，完成授权后点「继续」', waitingWhen: status.nextStep === 'login' },
    { id: 'serve', title: '4 · 配置 HTTPS 入口', desc: '会自动打开确认页，点一次开关后点「继续」', waitingWhen: status.nextStep === 'serve' },
    { id: 'patch', title: '5 · 写入本机配置', desc: 'trustedHosts 白名单 + 登录 cookie 十年（自动备份）' },
    { id: 'cert', title: '6 · 签发证书', desc: 'TLS 证书（几十秒内完成）' },
  ]
  const stepButtons = STEPS.map((step) => {
    const done = step.skipWhen === true
    const waiting = step.waitingWhen === true
    const cls = done ? 'done' : waiting ? 'waiting' : ''
    const label = done ? '✓ 已完成，跳过' : waiting ? '等待你完成浏览器操作 → 点「继续」' : '点击执行'
    return `<button class="step ${cls}" data-step="${step.id}" ${done ? 'disabled' : ''}>
      <b>${esc(step.title)}</b><small>${esc(label)}<br>${esc(step.desc)}</small>
    </button>`
  }).join('\n')

  const names = {
    tailscaleInstalled: 'Tailscale 已安装',
    daemonRunning: '守护进程运行中',
    loggedIn: '已登录 Tailscale',
    serveConfigured: 'HTTPS 入口已配置',
    trustedHostsOk: '白名单已放行',
    cookieMaxAge3650: '登录 cookie 十年有效',
    forwarderListening: '转发器监听中',
  }
  const checks = Object.entries(status.checks).map(([key, value]) => {
    if (key === 'funnelEnabled') return ''
    const mark = value === true ? '<span class="ok">✓</span>' : value === false ? '<span class="todo">待完成</span>' : esc(String(value))
    return `<li>${names[key] ?? esc(key)}: ${mark}</li>`
  }).filter(Boolean).join('\n')

  const ready = status.nextStep === 'done' || (mintUrl !== null && status.checks.forwarderListening === true)
  const doneView = ready && mintUrl !== null
    ? `<section>
        <h2>🎉 配置完成 — 手机最后一步</h2>
        <div class="qr">${qrSvg ?? ''}</div>
        <p class="hint" style="text-align:center;margin-top:0">手机扫码，或打开下面的地址（含本次启动令牌）</p>
        <p class="url">${esc(mintUrl)}</p>
        <p class="hint">进入的就是与桌面完全相同的 Harness。建议手机上「添加到主屏幕」。Cookie 十年有效。</p>
      </section>`
    : ''
  const funnelLabel = status.funnelEnabled ? '🔴 关闭 Funnel（收回公网可达）' : '🟢 开启 Funnel（公网免装 app 直达）'
  const funnelBadge = status.funnelEnabled
    ? '<span class="badge on">公网可达中 · Funnel 开启</span><span class="hint" style="margin:0 0 10px">当前任何人拿到地址都能访问本入口（安全由 token/cookie 兜底）。不用时点下面按钮关闭。</span>'
    : '<span class="badge off">仅组网内可达 · Funnel 关闭</span><span class="hint" style="margin:0 0 10px">只有装了 Tailscale app 并登录的设备能访问（推荐状态）。</span>'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remote Bridge · 配置向导</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 40px 20px; background: #F5F7FB; color: #0F172A;
    font: 15px/1.65 "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 24px; line-height: 1.3; margin: 0 0 6px; }
  .sub { color: #55657D; margin: 0 0 24px; font-size: 14px; }
  section { background: #fff; border: 1px solid #E2E8F0; border-radius: 12px;
    padding: 18px 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
  h2 { font-size: 15px; margin: 0 0 12px; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding: 5px 0; border-bottom: 1px solid #F1F5F9; font-size: 14px; }
  li:last-child { border-bottom: 0; }
  .ok { color: #12805C; font-weight: 600; }
  .todo { color: #B45309; font-weight: 600; }
  .steps { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  button.step { text-align: left; padding: 12px 14px; border: 1px solid #E2E8F0;
    border-radius: 10px; background: #fff; cursor: pointer; font: inherit; color: inherit;
    transition: border-color .15s, background .15s; }
  button.step:hover:not(:disabled) { border-color: #2457F5; background: #F7F9FF; }
  button.step:disabled { opacity: .55; cursor: default; }
  button.step.done { background: #F0FDF6; border-color: #BBE7D0; }
  button.step.waiting { background: #FFFBEB; border-color: #F5D68A; }
  button.step b { display: block; font-size: 14px; margin-bottom: 4px; }
  button.step small { display: block; color: #55657D; font-size: 12.5px; line-height: 1.5; }
  button.primary { padding: 10px 18px; border: 0; border-radius: 10px; background: #2457F5;
    color: #fff; font: 600 14px/1.4 system-ui, sans-serif; cursor: pointer; }
  button.primary:disabled { opacity: .5; cursor: default; }
  .log { background: #0F172A; color: #D8E2F2; border-radius: 10px; padding: 12px 14px;
    font: 12px/1.6 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap;
    max-height: 200px; overflow-y: auto; margin: 10px 0 0; }
  .url { font: 600 15px/1.5 ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all;
    background: #E8EEFD; color: #16336e; border-radius: 8px; padding: 12px 14px;
    user-select: all; }
  .qr { display: flex; justify-content: center; padding: 8px 0 2px; }
  .qr svg { width: 184px; height: 184px; }
  .hint { color: #55657D; font-size: 13px; margin: 10px 0 0; }
  .busy { color: #2457F5; font-size: 13px; }
  .danger { border-color: #F3C9B5; background: #FDF7F4; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px;
    font: 600 13px/1.4 inherit, system-ui, sans-serif; margin-right: 8px; }
  .badge.on { background: #FDECEC; color: #B4430C; border: 1px solid #F3C9B5; }
  .badge.off { background: #EAF6F0; color: #12805C; border: 1px solid #BBE7D0; }
</style>
</head>
<body>
<main>
  <h1>Remote Bridge · 配置向导</h1>
  <p class="sub">点下面的按钮一步步来；需要你在浏览器操作的两步会自动打开页面。全部就绪后手机扫码即可。</p>

  <section>
    <h2>当前状态</h2>
    <ul id="checks">${checks}</ul>
  </section>

  <section>
    <h2>配置步骤</h2>
    <div class="steps" id="steps">${stepButtons}</div>
    <p><button class="primary" id="continue" style="display:none">我已完成浏览器操作，继续 →</button>
       <span class="busy" id="busy" style="display:none">执行中，请稍候…（长任务可能一到几分钟）</span></p>
    <div class="log" id="log" style="display:none"></div>
  </section>

  <section id="funnel">
    <h2>可选 · 公网直达（Funnel）</h2>
    <p>${funnelBadge}</p>
    <button class="primary" id="funnelBtn" data-on="${status.funnelEnabled ? '1' : '0'}">${esc(funnelLabel)}</button>
  </section>

  ${doneView}

  <section class="danger">
    <h2>安全提示</h2>
    <p class="hint" style="margin:0">本向导只在 Mac 本机可开。持有手机地址（含 token）的人拥有这台 Harness 的完全控制权，不要外发；停用远程访问请在插件页关闭 remote-bridge。</p>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id)
  let running = false
  function bind() {
    document.querySelectorAll('button.step').forEach((btn) => {
      btn.onclick = () => run(btn.dataset.step)
    })
    const cont = $('continue')
    if (cont) cont.onclick = () => location.reload()
    const fb = $('funnelBtn')
    if (fb) fb.onclick = () => run(fb.dataset.on === '1' ? 'funnel_off' : 'funnel_on')
    const saved = sessionStorage.getItem('rbLog')
    if (saved) {
      const log = $('log')
      if (log) { log.style.display = 'block'; log.textContent = saved }
      sessionStorage.removeItem('rbLog')
    }
  }
  async function run(step) {
    if (running) return
    running = true
    const busy = $('busy'), log = $('log')
    if (busy) busy.style.display = 'inline'
    if (log) { log.style.display = 'block'; log.textContent = '执行 ' + step + ' …（长任务可能一到几分钟，页面会自动刷新）' }
    document.querySelectorAll('button').forEach((b) => { b.disabled = true })
    try {
      const r = await fetch('/remote-bridge/api/step', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step }),
      })
      const data = await r.json()
      const text = (data.lines || []).join('\\n') || '（无输出）'
      if (log) log.textContent = text
      sessionStorage.setItem('rbLog', text)
    } catch (e) {
      sessionStorage.setItem('rbLog', '执行失败：' + e)
    }
    setTimeout(() => location.reload(), 1200)
  }
  bind()
</script>
</body>
</html>`
}
