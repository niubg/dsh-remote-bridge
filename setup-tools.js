/**
 * remote-bridge 引导工具（通道 ②：Agent 对话框代跑）
 *
 * 两个 model-facing 工具：
 *  - remote_bridge_status：只读检测全部配置状态（不改任何东西）。
 *  - remote_bridge_setup：按 step 一次执行一步；需要用户在浏览器操作的两步
 *    （Tailscale 登录、serve 启用）会自动打开页面并返回 waiting——agent 用
 *    ask_user_question 等用户确认后再调下一个 step。
 *
 * 设计约束：
 *  - 所有子进程调用都是异步的（brew 安装可能几分钟，绝不能阻塞 Host 事件循环）；
 *  - login/serve 用分离进程跨工具调用持续跟踪（日志写 ~/.tailscale/）；
 *  - 写 profile patch 的 step 幂等且自动备份（DSH 审批流会对此类调用设卡）；
 *  - 本机已经配好的 step 一律跳过并返回 done，可安全重复调用。
 */

import os from 'node:os'
import { exec as cpExec } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const exec = promisify(cpExec)

const SOCK_DIR = join(os.homedir(), '.tailscale')
const SOCK = join(SOCK_DIR, 'tailscaled.sock')
const STATE_FILE = join(os.homedir(), '.dsh', 'remote-bridge-state.json')
const LOG_FILE = join(SOCK_DIR, 'tailscaled.log')
const PLIST_LABEL = 'dev.remote-bridge.tailscaled-userspace'
const PLIST = join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)

/** 解析 tailscale CLI 路径（Apple Silicon / Intel brew / PATH）。 */
function tsBin() {
  for (const candidate of ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']) {
    if (existsSync(candidate)) return candidate
  }
  return 'tailscale'
}

/** 安全执行 shell 命令，永不抛出（返回 {code, stdout, stderr}）。 */
async function run(command, timeoutMs = 30000) {
  try {
    const { stdout, stderr } = await exec(command, { timeout: timeoutMs })
    return { code: 0, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? '') }
  }
}

/** 从 daemon 日志抓最新的登录授权链接。 */
function latestAuthUrl() {
  try {
    const log = readFileSync(LOG_FILE, 'utf8')
    return (log.match(/https:\/\/login\.tailscale\.com\/a\/[a-z0-9]+/g) ?? []).pop() ?? null
  } catch {
    return null
  }
}

/** 读 profile patch 文本（不存在返回 null）。 */
function readProfile() {
  try {
    return readFileSync(join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
  } catch {
    return null
  }
}

/** 当前登录设备的 ts.net 域名（未登录返回 null）。 */
async function fqdnNow() {
  const st = await run(`"${tsBin()}" --socket="${SOCK}" status --json`, 15000)
  try {
    return String(JSON.parse(st.stdout).Self?.DNSName ?? '').replace(/\.$/, '') || null
  } catch {
    return null
  }
}

/** 汇总全部配置状态（status 工具与 setup/detect、向导页共用）。 */
export async function collectStatus(cfg, listen) {
  const bin = tsBin()
  const installed = existsSync(bin) || (await run('command -v tailscale')).code === 0
  const daemonSocket = existsSync(SOCK)
  let loggedIn = false
  let fqdn = null
  let serveOn = false
  let funnelOn = false
  if (installed && daemonSocket) {
    const st = await run(`"${bin}" --socket="${SOCK}" status --json`, 15000)
    try {
      const json = JSON.parse(st.stdout)
      loggedIn = json.BackendState === 'Running'
      fqdn = String(json.Self?.DNSName ?? '').replace(/\.$/, '') || null
    } catch { /* 未登录或输出不可解析 */ }
    if (loggedIn) {
      const serve = await run(`"${bin}" --socket="${SOCK}" serve status`, 15000)
      serveOn = serve.code === 0 && /https:\/\/.+\.ts\.net/.test(serve.stdout)
      const funnel = await run(`"${bin}" --socket="${SOCK}" funnel status`, 15000)
      funnelOn = funnel.code === 0 && /Funnel on/.test(funnel.stdout)
    }
  }
  const profile = readProfile()
  const trustedHostsOk = profile !== null && fqdn !== null && profile.includes(fqdn)
  const cookieOk = profile !== null && /cookieMaxAgeDays:\s*3650/.test(profile)
  const stateFile = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null
  const forwarderPort = stateFile?.port ?? cfg.listenPort
  const pairingUrl = `http://127.0.0.1:${forwarderPort ?? cfg.listenPort}/pair`

  const checks = {
    tailscaleInstalled: installed,
    daemonRunning: daemonSocket,
    loggedIn,
    fqdn,
    serveConfigured: serveOn,
    funnelEnabled: funnelOn,
    trustedHostsOk,
    cookieMaxAge3650: cookieOk,
    forwarderListening: listen.ok === true,
  }
  // 下一步提示：按依赖顺序给出第一件没完成的事
  let nextStep = 'done'
  if (!checks.tailscaleInstalled) nextStep = 'install'
  else if (!checks.daemonRunning) nextStep = 'daemon'
  else if (!checks.loggedIn) nextStep = 'login'
  else if (!checks.serveConfigured) nextStep = 'serve'
  else if (!checks.trustedHostsOk || !checks.cookieMaxAge3650) nextStep = 'patch'
  else if (listen.ok !== true) nextStep = 'restart-harness'
  return { checks, fqdn, serveOn, funnelOn, pairingUrl, forwarderPort, nextStep }
}

/** 单步执行器：Agent 工具与 GUI 向导共用。返回 { lines, waiting }——
 * waiting=true 表示有浏览器动作待用户完成（向导页据此显示「我已完成」按钮）。 */
export async function runStep(step, cfg, listen) {
  const bin = tsBin()
  const say = (lines, waiting = false) => ({ lines, waiting })

  if (step === 'detect') {
    const status = await collectStatus(cfg, listen)
    return say([
      `当前 nextStep: ${status.nextStep}`,
      `配对页: ${status.pairingUrl}`,
      ...Object.entries(status.checks).map(([key, value]) => `- ${key}: ${value === true ? '✓' : value === false ? '✗' : String(value)}`),
    ])
  }

  if (step === 'install') {
    if (existsSync(bin) || (await run('command -v tailscale')).code === 0) {
      return say(['✓ Tailscale 已安装，跳过。下一步: daemon'])
    }
    const brew = await run('HOMEBREW_NO_AUTO_UPDATE=1 brew install tailscale', 600000)
    return brew.code === 0
      ? say(['✓ Tailscale 安装完成（CLI formula）。下一步: daemon'])
      : say([`✗ 安装失败: ${brew.stderr.slice(-300)}`, '请确认已安装 Homebrew（https://brew.sh）后重试 install'])
  }

  if (step === 'daemon') {
    if (existsSync(SOCK)) {
      return say(['✓ 用户态守护进程已在运行（socket 存在），跳过。下一步: login'])
    }
    writeFileSync(PLIST, buildPlist())
    const boot = await run(`launchctl bootstrap gui/$(id -u) "${PLIST}"`)
    if (boot.code !== 0) await run(`launchctl kickstart -k gui/$(id -u)/${PLIST_LABEL}`)
    let ready = false
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (existsSync(SOCK)) { ready = true; break }
    }
    return ready
      ? say(['✓ 守护进程已启动（userspace 模式，开机自启）。下一步: login'])
      : say([`✗ 守护进程未就绪，日志: ${LOG_FILE}`])
  }

  if (step === 'login') {
    const st = await run(`"${bin}" --socket="${SOCK}" status --json`, 15000)
    let loggedIn = false
    try { loggedIn = JSON.parse(st.stdout).BackendState === 'Running' } catch { /* 尚未登录 */ }
    if (loggedIn) return say(['✓ 已登录。下一步: serve'])
    // 分离进程发起登录（跨工具调用持续存活），然后打开浏览器
    await run(`( "${bin}" --socket="${SOCK}" login >/dev/null 2>&1 ) &`, 3000)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const url = latestAuthUrl()
    if (url) await run(`open "${url}"`)
    return say([
      url ? `⏳ waiting：已打开浏览器登录页 ${url}` : '⏳ waiting：已发起登录但未取得链接（稍后重调 login 或 detect）',
      '请在浏览器完成授权（免费账号可用 Google/GitHub/Apple 登录）。',
      '完成后告诉 agent 回你一声，再调 setup step=login 确认（已登录会返回 done）。',
    ], true)
  }

  if (step === 'serve') {
    const fqdn = await fqdnNow()
    if (!fqdn) return say(['✗ 未登录，先完成 login'])
    const before = await run(`"${bin}" --socket="${SOCK}" serve status`, 15000)
    if (before.code === 0 && before.stdout.includes(fqdn)) {
      return say([`✓ serve 已配置: https://${fqdn} → 127.0.0.1:${cfg.listenPort}。下一步: patch`])
    }
    // 分离进程执行 serve（可能因未启用而等待），拿到启用链接交给用户
    await run(`( "${bin}" --socket="${SOCK}" serve --bg 127.0.0.1:${cfg.listenPort} > "${SOCK_DIR}/serve-setup.log" 2>&1 ) &`, 3000)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const after = await run(`"${bin}" --socket="${SOCK}" serve status`, 15000)
    if (after.code === 0 && after.stdout.includes(fqdn)) {
      return say([`✓ serve 已配置: https://${fqdn}。下一步: patch`])
    }
    let enableUrl = null
    try {
      const log = readFileSync(join(SOCK_DIR, 'serve-setup.log'), 'utf8')
      enableUrl = (log.match(/https:\/\/login\.tailscale\.com\/f\/serve\?\S+/g) ?? []).pop() ?? null
    } catch { /* 日志还没写 */ }
    if (enableUrl) await run(`open "${enableUrl}"`)
    return say([
      enableUrl
        ? `⏳ waiting：tailnet 尚未启用 serve，已打开确认页 ${enableUrl}`
        : '⏳ waiting：serve 正在配置（证书签发可能要几十秒）',
      '用户点击确认后，再调 setup step=serve 确认（已配置会返回 done）。',
    ], true)
  }

  if (step === 'patch') {
    const fqdn = await fqdnNow()
    if (!fqdn) return say(['✗ 未登录，先完成 login'])
    const profilePath = join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
    if (!existsSync(profilePath)) return say(['✗ 未找到 profile patch 文件（桌面版应已存在）'])
    let text = readFileSync(profilePath, 'utf8')
    const backupPath = `${profilePath}.bak-remote-bridge-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`
    copyFileSync(profilePath, backupPath)
    const changed = []
    if (text.includes('id: connection')) {
      if (!text.includes(fqdn)) {
        text = text.replace(/^([ \t]*trustedHosts:[ \t]*\[.*?)[ \t]*\][ \t]*$/m, `$1, '${fqdn}' ]`)
        changed.push(`trustedHosts += '${fqdn}'`)
      }
      if (!/cookieMaxAgeDays/.test(text)) {
        text = text.replace(/^([ \t]*trustedHosts:[ \t]*\[.*?\][ \t]*)$/m, `$1\n    cookieMaxAgeDays: 3650`)
        changed.push('cookieMaxAgeDays: 3650')
      }
    } else {
      text += `\n\n# remote-bridge：放行手机访问的 authority + 登录 cookie 十年有效期\n- id: connection\n  name: '@deepseek-ai/dsh-client-connection'\n  inject: [ webStartup ]\n  config:\n    trustedHosts: [ '${fqdn}' ]\n    cookieMaxAgeDays: 3650\n`
      changed.push('新增 connection 行（trustedHosts + cookie 3650）')
    }
    if (!text.includes('id: remote-bridge')) {
      text += `\n# remote-bridge：转发器绑定与手机地址（覆盖 bundle 层完整 config）\n- id: remote-bridge\n  name: '@local/remote-bridge'\n  config:\n    enabled: true\n    listenPort: ${cfg.listenPort}\n    bindAddress: '0.0.0.0'\n    publicBaseUrl: 'https://${fqdn}'\n`
      changed.push('新增 remote-bridge 行（端口/绑定/手机地址）')
    }
    if (changed.length === 0) return say(['✓ profile 配置已就绪（无需改动）。下一步: cert'])
    writeFileSync(profilePath, text)
    return say([`✓ 已写入 profile 配置（${changed.join('；')}），自动备份为 ${backupPath}。配置经 HMR/重启生效。下一步: cert`])
  }

  if (step === 'cert') {
    const fqdn = await fqdnNow()
    if (!fqdn) return say(['✗ 未登录，先完成 login'])
    const cert = await run(`"${bin}" --socket="${SOCK}" cert "${fqdn}"`, 90000)
    return cert.code === 0
      ? say(['✓ TLS 证书已就绪。下一步: check'])
      : say([`⚠️ 证书签发未完成: ${cert.stderr.slice(-200)}`, 'serve 会自动重试；稍后重跑 step=cert 或直接 check'])
  }

  if (step === 'check') {
    const stateFile = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null
    const port = stateFile?.port ?? cfg.listenPort
    const host = await fqdnNow()
    if (!host) return say(['✗ 未登录，先完成 login'])
    const code = await run(`curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy http://127.0.0.1:1056 "https://${host}/"`, 30000)
    const status = code.stdout.trim()
    return status === '401'
      ? say(['✓ 端到端自检通过：入口返回 401（等待令牌，健康态）。', `手机入口: https://${host}`])
      : say([`⚠️ 入口返回 ${status || '无响应'}（期望 401）。检查 daemon 日志 ${LOG_FILE}；公网首连偶发失败可重试`])
  }

  if (step === 'funnel_on' || step === 'funnel_off') {
    const fqdn = await fqdnNow()
    if (!fqdn) return say(['✗ 未登录，先完成 login'])
    const on = step === 'funnel_on'
    const out = await run(`"${bin}" --socket="${SOCK}" funnel ${on ? `--bg 127.0.0.1:${cfg.listenPort}` : '--https=443 off'}`, 60000)
    if (out.code !== 0) {
      return say([`✗ Funnel 操作失败: ${out.stderr.slice(-200)}`])
    }
    // tailscaled 状态传播有延迟：轮询直到 funnel status 反映真实结果（最多 ~8s），
    // 避免向导页刷新时读到旧状态、按钮/徽标翻转滞后。
    let nowOn = null
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const chk = await run(`"${bin}" --socket="${SOCK}" funnel status`, 15000)
      nowOn = chk.code === 0 && /Funnel on/.test(chk.stdout)
      if (nowOn === on) break
    }
    return nowOn === on
      ? say([on ? '✓ Funnel 已开启：同一地址对公网可达（免装 app），靠 token/cookie 兜底。用完建议 funnel_off。' : '✓ Funnel 已关闭，回到组网内可达。'])
      : say([`⚠️ 命令已执行，但状态确认中（当前读数：${nowOn ? 'on' : 'off'}）。几秒后刷新向导页核实。`])
  }

  return say([`未知 step: ${step}。可用值见工具描述。`])
}

/** 注册两个 model-facing 工具（供 agent 对话框代跑）。 */
export function registerSetupTools(ctx, cfg, listen) {
  ctx.tools.register({
    name: 'remote_bridge_status',
    description: '只读检测「手机远程控制桌面 Harness」的完整配置状态：Tailscale 安装/守护进程/登录、serve/funnel、trustedHosts、cookie 有效期、转发器监听与配对页地址。不修改任何东西。配置或排查远程访问时先调它，按返回的 nextStep 引导用户。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const status = await collectStatus(cfg, listen)
      const lines = [
        `手机远程状态：${status.nextStep === 'done' ? '✅ 已就绪' : '未完成（nextStep: ' + status.nextStep + '）'}`,
        ...Object.entries(status.checks).map(([key, value]) => `- ${key}: ${value === true ? '✓' : value === false ? '✗' : String(value)}`),
        `- 配对页(本机): ${status.pairingUrl}`,
        status.fqdn ? `- ts.net 地址: https://${status.fqdn}` : '',
        `- 手机可用性：serve 模式需手机装 Tailscale app 并登录同一账号；Funnel 模式任何浏览器直达（当前 ${status.funnelOn ? '已开启' : '未开启'}）`,
      ].filter(Boolean)
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'remote_bridge_setup',
    description: '分步执行「手机远程控制桌面 Harness」的配置。参数 step 每次调一步：detect(检测) / install(brew 装 Tailscale) / daemon(用户态守护进程) / login(登录，会自动打开浏览器并返回 waiting) / serve(配 serve，未启用时自动打开确认页并返回 waiting) / patch(写 trustedHosts+cookie 十年，幂等) / cert(签发 TLS 证书) / check(端到端自检) / funnel_on|funnel_off(公网模式开关)。先调 remote_bridge_status 看 nextStep，按它推进；返回 waiting 时用 ask_user_question 等用户完成浏览器操作后再继续。',
    parameters: {
      type: 'object',
      properties: {
        step: {
          type: 'string',
          description: '要执行的一步',
          enum: ['detect', 'install', 'daemon', 'login', 'serve', 'patch', 'cert', 'check', 'funnel_on', 'funnel_off'],
        },
      },
      required: ['step'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const { lines } = await runStep(String(args?.step ?? 'detect'), cfg, listen)
      return lines.join('\n')
    },
  })
}

/** 生成用户态 LaunchAgent plist 文本（与 setup-remote.sh 同款）。 */
function buildPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${tsBin()}</string>
    <string>--tun=userspace-networking</string>
    <string>--statedir=${SOCK_DIR}</string>
    <string>--socket=${SOCK}</string>
    <string>--outbound-http-proxy-listen=127.0.0.1:1056</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict></plist>`
}
