/**
 * remote-bridge —— 手机远程控制桌面 Harness 的桥接插件（v1.2）
 *
 * 做三件事：
 *  1. 固定端口 TCP 转发：监听 <bindAddress>:<listenPort>（默认 0.0.0.0:46084），
 *     把字节流转发到 Desktop webserver 的真实端口（每次启动随机）。WebSocket、
 *     SSE、cookie 全部透传，不解析 HTTP —— 唯一的例外是配对页路径：
 *     在固定端口上做 HTTP 窥探多路复用，`/pair`（或 `/remote-bridge/pair`）由插件
 *     直接应答，因此配对页地址恒为 http://127.0.0.1:46084/pair，与 Harness 端口无关。
 *  2. 配对页（仅本机可开）：显示手机要打开的完整地址（含启动 token）与二维码，
 *     并对目标 authority 做栅栏探测（trustedHosts 没配就给出要改的 YAML）。
 *  3. 连接审计：环形缓冲记录最近经过转发器的连接，展示在配对页上。
 *
 * 安全边界：转发器本身无认证（它只是字节管道），认证完全由 DSH 自己的
 * Host/Origin 栅栏 + 签名 cookie 承担；配对页泄露启动 token，因此只放行
 * loopback 访问，非本机请求一律 404 不暴露存在性。
 */

import net from 'node:net'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Vendored（MIT，Kazuhiko Arase）：本地生成二维码，token 不经过任何第三方服务。
import qrcode from './vendor/qrcode.cjs'
// 通道 ②：Agent 对话框代跑的两个引导工具（status / setup）。
import { registerSetupTools, collectStatus, runStep } from './setup-tools.js'
// 通道 ③：GUI 配置向导页。
import { buildWizardPage } from './wizard.js'

/** Cordis function-plugin name. */
export const name = 'remote-bridge'
/** 路由载体 + 连接服务 + 工具注册表。 */
export const inject = ['webServer', 'connection', 'tools']

/** 配对页在本插件的固定端口与 DSH webserver 上都可访问；固定端口用短路径。 */
const PAIR_PATHS = ['/pair', '/remote-bridge/pair']
/** 环形缓冲上限：配对页展示最近 N 条连接。 */
const AUDIT_LIMIT = 50
/** 窥探请求头的上限：超过仍未见到头结束符就当普通流量透传。 */
const PEEK_LIMIT = 16 * 1024

/** 防御式读取行配置（本插件不声明 schemastery schema，缺省值在这里收口）。 */
function readConfig(config) {
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback
  }
  return {
    enabled: config?.enabled !== false,
    listenPort: num(config?.listenPort, 46084, 1024, 65535),
    bindAddress: typeof config?.bindAddress === 'string' && config.bindAddress !== ''
      ? config.bindAddress
      : null,
    publicBaseUrl: typeof config?.publicBaseUrl === 'string' && config.publicBaseUrl !== ''
      ? config.publicBaseUrl
      : null,
  }
}

/** 判断 Host 头的 hostname 是否 loopback（127/8、localhost、::1）。 */
function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.replace(/:\d+$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (net.isIPv4(host)) return host.startsWith('127.')
  if (net.isIPv6(host)) {
    const lower = host.toLowerCase()
    return lower === '::1' || lower === '::' || lower.endsWith(':1')
  }
  return false
}

/** 是否配对页路径（去掉 query 后比对两种写法）。 */
function isPairingPath(target) {
  if (typeof target !== 'string') return false
  const path = target.split('?')[0]
  return PAIR_PATHS.includes(path)
}

/** 自动挑选主用私网 IPv4（10/8、172.16/12、192.168/16），找不到回退 loopback。 */
function detectLanAddress() {
  const tables = os.networkInterfaces()
  for (const addresses of Object.values(tables)) {
    for (const entry of addresses ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      const { address } = entry
      const inPrivate = address.startsWith('10.') || address.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
      if (inPrivate) return address
    }
  }
  return '127.0.0.1'
}

/** authority 的展示形式：默认端口收掉，便于和白名单条目对照。 */
function displayAuthority(url) {
  const hidden = (url.protocol === 'https:' && url.port === '443')
    || (url.protocol === 'http:' && url.port === '80')
  return hidden ? url.hostname : url.host
}

/** 403 拒绝 + 一段可抄的 YAML（本机诊断用，不对外提供）。 */
function fenceSnippet(authority) {
  return [
    '# ~/.dsh/profiles/desktop/cordis.patch.yml 追加（改完重启 Harness 生效）：',
    '- id: connection',
    "  name: '@deepseek-ai/dsh-client-connection'",
    '  inject: [webStartup]',
    '  config:',
    `    trustedHosts: ['${authority}']`,
  ].join('\n')
}

/** 手机打开的完整地址：铸 token + 校验栅栏是否放行该 authority。 */
function mintMobileUrl(ctx, baseUrl) {
  let url = null
  let mintError = null
  try {
    url = new URL(ctx.connection.authenticatedUrl(baseUrl))
  } catch (error) {
    mintError = error instanceof Error ? error.message : String(error)
  }
  let fence = null
  if (url !== null) {
    try {
      const rejection = ctx.connection.requestRejection({ headers: { host: url.host } })
      // 语义：403 = 栅栏拒绝（Host/Origin 不在白名单）；401 = 已放行、只是没登录；
      // undefined = 放行。配对页的探测请求本来就不带 cookie，401 是预期结果。
      fence = rejection === undefined
        ? 'allow'
        : rejection === 401 ? 'allow-unauth' : 'deny'
    } catch (error) {
      fence = 'error:' + (error instanceof Error ? error.message : String(error))
    }
  }
  return { url, mintError, fence }
}

/** 手机扫码直达：服务端把带 token 的地址生成 QR SVG（版本自动、纠错 M，失败则不显示）。 */
function makeQrSvg(text) {
  try {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  } catch {
    return null
  }
}

/** 生成配对页响应：仅 loopback 可见，其余 404 不暴露存在性。 */
function buildPairingResponse(ctx, cfg, listen, audit) {
  return (hostHeader) => {
    if (!isLoopbackHost(hostHeader)) {
      return { status: 404, type: 'text/plain; charset=utf-8', body: '' }
    }
    let dshPort = null
    try {
      dshPort = ctx.webServer.port
    } catch {
      dshPort = null
    }
    const publicBase = cfg.publicBaseUrl
      ?? `http://${listen.listenAddress}:${cfg.listenPort}`
    const mint = mintMobileUrl(ctx, publicBase)
    const qrSvg = mint.url === null ? null : makeQrSvg(mint.url.toString())
    const html = pairingPage({ cfg, listen, mint, audit, dshPort, qrSvg })
    return { status: 200, type: 'text/html; charset=utf-8', body: html }
  }
}

/** 转发器：固定端口上的每条 TCP 连接先窥探请求头——配对页由插件直接应答，
 * 其余字节流原样转发到当前真实 webserver 端口。
 * 端口获取是自愈式的：首选端口被占先重试 3 次（热重载竞态），仍失败则顺延
 * 最多 20 个端口；实际端口写入 ~/.dsh/remote-bridge-state.json 供人/agent 查询。 */
/** 原始 HTTP 应答（转发器窥探路径用）。 */
function writeRaw(socket, status, type, body) {
  if (socket.destroyed) return
  const payload = Buffer.from(body)
  const reason = status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error'
  socket.end(Buffer.concat([
    Buffer.from(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: ${type}\r\ncache-control: no-store\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n`),
    payload,
  ]))
}

function startForwarder(ctx, cfg, listen, audit, answerPairing) {
  const server = net.createServer((socket) => {
    let upstream = null
    let buffered = Buffer.alloc(0)
    const kill = () => {
      socket.destroy()
      upstream?.destroy()
    }
    socket.setTimeout(0)
    socket.on('error', kill)
    /** 纯透传：把已窥探到的字节连同后续流一起接到当前真实 webserver 端口。 */
    const passthrough = (initial) => {
      let port
      try {
        port = ctx.webServer.port
      } catch {
        // webServer 尚未绑定（理论上注入顺序保证不会走到）；直接断开避免挂死对端。
        socket.destroy()
        return
      }
      upstream = net.connect({ host: '127.0.0.1', port })
      socket.setTimeout(0)
      upstream.setTimeout(0)
      if (initial.length > 0) upstream.write(initial)
      socket.pipe(upstream)
      upstream.pipe(socket)
      audit.push({ time: new Date().toISOString(), from: String(socket.remoteAddress ?? '?'), to: `127.0.0.1:${port}` })
      if (audit.length > AUDIT_LIMIT) audit.shift()
    }

    socket.on('data', function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk])
      const headEnd = buffered.indexOf('\r\n\r\n')
      if (headEnd === -1) {
        if (buffered.length > PEEK_LIMIT) {
          // 头比上限还大：不是本插件关心的请求，按普通流量透传。
          socket.removeListener('data', onData)
          passthrough(buffered)
        }
        return
      }
      const head = buffered.slice(0, headEnd).toString('utf8')
      const lines = head.split('\r\n')
      const requestLine = lines[0] ?? ''
      const method = requestLine.split(' ')[0] ?? ''
      const target = (requestLine.split(' ')[1] ?? '').split('?')[0]
      const hostLine = lines.find((line) => /^host:/i.test(line))
      const host = hostLine ? hostLine.slice(5).trim() : ''

      if (method === 'GET' && isPairingPath(target)) {
        socket.removeListener('data', onData)
        const answer = answerPairing(host)
        writeRaw(socket, answer.status, answer.type, answer.body)
        return
      }

      // 向导页与它的 API（全部仅 loopback 可达）
      const isWizard = method === 'GET' && target === '/wizard'
      const isApiStatus = method === 'GET' && target === '/remote-bridge/api/status'
      const isApiStep = method === 'POST' && target === '/remote-bridge/api/step'
      if (isWizard || isApiStatus || isApiStep) {
        if (isApiStep) {
          // POST 先收完请求体再处理
          const declared = Number((lines.find((line) => /^content-length:/i.test(line)) ?? '').split(':')[1] ?? 0) || 0
          if (buffered.length < headEnd + 4 + declared) return
        }
        socket.removeListener('data', onData)
        void (async () => {
          try {
            if (!isLoopbackHost(host)) {
              writeRaw(socket, 404, 'text/plain; charset=utf-8', '')
              return
            }
            if (isWizard) {
              const status = await collectStatus(cfg, listen)
              const publicBase = cfg.publicBaseUrl
                ?? `http://${listen.listenAddress}:${listen.port ?? cfg.listenPort}`
              const mint = mintMobileUrl(ctx, publicBase)
              const qrSvg = mint.url === null ? null : makeQrSvg(mint.url.toString())
              writeRaw(socket, 200, 'text/html; charset=utf-8',
                buildWizardPage({ status, mintUrl: mint.url?.toString() ?? null, qrSvg, cfg, listen }))
              return
            }
            if (isApiStatus) {
              writeRaw(socket, 200, 'application/json; charset=utf-8',
                JSON.stringify(await collectStatus(cfg, listen)))
              return
            }
            const bodyText = buffered.slice(headEnd + 4).toString('utf8')
            let step = 'detect'
            try {
              step = String(JSON.parse(bodyText).step ?? 'detect')
            } catch { /* 非法 body 按 detect 处理 */ }
            const { lines: outLines } = await runStep(step, cfg, listen)
            writeRaw(socket, 200, 'application/json; charset=utf-8', JSON.stringify({ lines: outLines }))
          } catch (error) {
            try {
              writeRaw(socket, 500, 'text/plain; charset=utf-8', String(error?.message ?? error))
            } catch { /* socket 已断 */ }
          }
        })()
        return
      }
      // ⚠️ 必须先摘掉 onData 监听再透传：否则 socket 同时有两个读消费者
      //（onData 与 pipe），多数据包请求会被撕裂/截断（批量 bundle 就是这样坏的）。
      socket.removeListener('data', onData)
      passthrough(buffered)
    })
  })
  const wanted = cfg.listenPort
  listen.listenAddress = cfg.bindAddress ?? detectLanAddress()
  listen.port = wanted

  /** 把解析出的实际端口落到状态文件（人/agent 查询用，无敏感内容）。 */
  const writeState = (patch) => {
    try {
      const file = join(os.homedir(), '.dsh', 'remote-bridge-state.json')
      const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
      // 新值优先于旧状态：避免旧测试/旧配置残留（如 test.ts.net）覆盖当前配置。
      writeFileSync(file, JSON.stringify({ ...prev, pid: process.pid, publicBaseUrl: cfg.publicBaseUrl ?? prev.publicBaseUrl ?? null, ...patch, updatedAt: new Date().toISOString() }, null, 2))
    } catch {
      // 状态文件写不进去不影响功能，只影响可发现性。
    }
  }

  /** 尝试绑定一个端口；成功 resolve(true)，被占 resolve('EADDRINUSE')，其他错误 resolve(error.code)。 */
  const tryBind = (port) => new Promise((resolve) => {
    const onError = (error) => {
      server.removeAllListeners('error')
      resolve(error.code === 'EADDRINUSE' ? 'EADDRINUSE' : String(error.code ?? error.message))
    }
    server.once('error', onError)
    server.listen(port, listen.listenAddress, () => {
      server.removeListener('error', onError)
      resolve(true)
    })
  })

  /** 自愈式端口获取：重试首选 → 顺延扫描；记录冲突进程与最终端口。 */
  async function acquire() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    let code = await tryBind(wanted)
    for (let retry = 1; code === 'EADDRINUSE' && retry <= 2; retry++) {
      await sleep(2000) // 热重载竞态：旧监听器可能还在关，稍等再抢
      code = await tryBind(wanted)
    }
    if (code === true) {
      listen.ok = true
      listen.error = null
      listen.port = wanted
      writeState({ port: wanted, listenAddress: listen.listenAddress, conflict: null })
      return
    }
    if (code === 'EADDRINUSE') {
      listen.conflict = conflictOwner(wanted)
    }
    for (let drift = 1; drift <= 20; drift++) {
      code = await tryBind(wanted + drift)
      if (code === true) {
        listen.ok = true
        listen.error = null
        listen.port = wanted + drift
        writeState({ port: listen.port, listenAddress: listen.listenAddress, conflict: listen.conflict ?? null })
        return
      }
    }
    listen.ok = false
    listen.error = { code: code === 'EADDRINUSE' ? 'EADDRINUSE' : code, message: `端口 ${wanted}..${wanted + 20} 全部不可用` }
    writeState({ port: null, conflict: listen.conflict ?? null, error: listen.error.message })
  }
  void acquire().catch(() => {})
  return () => {
    listen.ok = false
    server.close()
    server.closeAllConnections()
    writeState({ port: null })
  }
}

/** 谁占了端口（尽力而为，给配对页的诊断栏用）。 */
function conflictOwner(port) {
  try {
    const out = execSync(`/usr/sbin/lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`, { timeout: 4000, encoding: 'utf8' })
    const line = out.split('\n').find((row, index) => index > 0 && row.trim() !== '')
    if (line) return line.trim().slice(0, 120)
  } catch {
    // lsof 不可用/无输出就算了
  }
  return `端口 ${port} 被其他进程占用（原因未知）`
}

/** 配对页：零脚本、可选中复制的地址与诊断信息。 */
function pairingPage(state) {
  const { cfg, listen, mint, audit, qrSvg } = state
  const esc = (text) => String(text)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  const mobile = mint.url === null
    ? `<p class="bad">铸 token 失败：${esc(mint.mintError ?? '未知错误')}</p>`
    : `<p class="url" title="手机浏览器打开这个地址">${esc(mint.url.toString())}</p>`
  const fenceView = (() => {
    if (mint.url === null) return ''
    if (mint.fence === 'allow' || mint.fence === 'allow-unauth') {
      return '<p class="ok">栅栏检查：trustedHosts 已放行该地址 ✓</p>'
    }
    if (mint.fence === 'deny') {
      const authority = displayAuthority(mint.url)
      return `<p class="bad">栅栏会拒绝该地址。把 <code>${esc(authority)}</code> 加入 trustedHosts：</p>
<pre class="snippet">${esc(fenceSnippet(authority))}</pre>`
    }
    return `<p class="bad">栅栏探测失败：${esc(String(mint.fence))}</p>`
  })()
  const auditRows = audit.length === 0
    ? '<li class="empty">还没有连接经过转发器。</li>'
    : audit.slice().reverse().map((row) =>
      `<li><span>${esc(row.time)}</span><span>${esc(row.from)}</span><span>→ ${esc(row.to)}</span></li>`,
    ).join('')
  const listenView = listen.ok
    ? `<code>${esc(`${listen.listenAddress}:${listen.port ?? cfg.listenPort}`)}</code>`
    : `<span class="bad">监听失败：${esc(listen.error?.code ?? listen.error?.message ?? '未知')}</span>`
  const conflictView = listen.conflict
    ? `<tr><td>首选端口占用</td><td>${esc(listen.conflict)}<br><span class="hint">已顺延到上面的实际端口；如需恢复 ${esc(String(cfg.listenPort))}，释放占用后重启，并把 serve 目标改成新端口</span></td></tr>`
    : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remote Bridge · 配对</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 40px 20px; background: #F5F7FB; color: #0F172A;
    font: 15px/1.65 "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 24px; line-height: 1.3; margin: 0 0 6px; }
  .sub { color: #55657D; margin: 0 0 28px; font-size: 14px; }
  section { background: #fff; border: 1px solid #E2E8F0; border-radius: 12px;
    padding: 18px 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .url { font: 600 15px/1.5 ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all;
    background: #E8EEFD; color: #16336e; border-radius: 8px; padding: 12px 14px; margin: 0;
    user-select: all; }
  .ok { color: #12805C; font-size: 13.5px; margin: 10px 0 0; }
  .bad { color: #C2410C; font-size: 13.5px; margin: 10px 0 0; }
  .snippet { background: #F5F7FB; border: 1px solid #E2E8F0; border-radius: 8px;
    padding: 12px 14px; font: 12.5px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
    overflow-x: auto; user-select: all; margin: 10px 0 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px;
    font-variant-numeric: tabular-nums; }
  td { padding: 6px 8px; border-bottom: 1px solid #EEF2F8; }
  td:first-child { color: #55657D; width: 9em; }
  li.empty { color: #55657D; font-size: 13.5px; list-style: none; margin: 0; }
  ul { margin: 0; padding: 0; }
  .hint { color: #55657D; font-size: 13px; margin: 10px 0 0; }
  .qr { display: flex; justify-content: center; padding: 8px 0 2px; }
  .qr svg { width: 184px; height: 184px; }
  .danger { border-color: #F3C9B5; background: #FDF7F4; }
</style>
</head>
<body>
<main>
  <h1>Remote Bridge · 配对</h1>
  <p class="sub">手机打开下面的地址即可进入与桌面完全相同的 Harness 界面；地址只在本次 Harness 进程内有效。</p>
  <section>
    <h2>1 · 手机打开的地址</h2>
    ${qrSvg === null ? '' : `<div class="qr" title="手机扫码直达（地址已含令牌）">${qrSvg}</div><p class="hint" style="text-align:center;margin-top:0">↑ 手机扫码直达，无需复制粘贴</p>`}
    ${mobile}
    <p class="hint">本机入口固定为 <code>http://127.0.0.1:${esc(String(cfg.listenPort))}/pair</code>（与 Harness 端口无关）。</p>
    ${fenceView}
  </section>
  <section>
    <h2>2 · 转发器状态</h2>
    <table>
      <tr><td>转发监听</td><td>${listenView}</td></tr>
      ${conflictView}
      <tr><td>DSH 实际端口</td><td><code>${esc(String(state.dshPort ?? '未绑定'))}</code></td></tr>
      <tr><td>手机地址</td><td><code>${esc(mint.url ? displayAuthority(mint.url) : '—')}</code></td></tr>
    </table>
  </section>
  <section>
    <h2>3 · 最近连接（${audit.length}/${50}）</h2>
    <ul>${auditRows}</ul>
  </section>
  <section class="danger">
    <h2>安全提示</h2>
    <p class="hint" style="margin:0">此页只在 Mac 本机可开。持有手机地址的人拥有这台桌面 Harness 的完全控制权（可运行命令），不要把带 token 的地址发给别人；要停用远程访问，在插件配置里把 enabled 置为 false。</p>
  </section>
</main>
</body>
</html>`
}

/** 插件主体：注册转发器与配对页，全部经 ctx.effect 挂卸。 */
export function apply(ctx, config) {
  const cfg = readConfig(config)
  if (!cfg.enabled) {
    // 保持一行安静的禁用态：不注册任何资源，下次启动按配置决定。
    return
  }
  const audit = []
  const listen = { ok: false, error: null, listenAddress: cfg.bindAddress ?? '127.0.0.1', port: cfg.listenPort, conflict: null }
  const answerPairing = buildPairingResponse(ctx, cfg, listen, audit)
  registerSetupTools(ctx, cfg, listen)

  // 配对页同时注册在真实 webserver 上（Host=loopback 才放行），兼容旧入口。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/remote-bridge/pair',
    handler: (req, res) => {
      const answer = answerPairing(String(req.headers.host ?? ''))
      if (answer.status !== 200) {
        res.statusCode = answer.status
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', answer.type)
      res.setHeader('cache-control', 'no-store')
      if (req.method === 'HEAD') {
        res.setHeader('content-length', String(Buffer.byteLength(answer.body)))
        res.end()
        return
      }
      res.end(answer.body)
    },
  }), 'remote-bridge: GET /remote-bridge/pair (loopback only)')

  // 固定端口转发器：同步注册、异步生效；失败只反映在配对页的状态区。
  ctx.effect(() => startForwarder(ctx, cfg, listen, audit, answerPairing),
    `remote-bridge: TCP forwarder ${cfg.bindAddress ?? 'auto'}:${cfg.listenPort}`)
}
