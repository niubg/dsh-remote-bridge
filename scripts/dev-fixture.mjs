// 转发器/工具联调 fixture（开发自检用）：上游回源 5.6MB 大响应 + 真实插件转发器。
// 用法：ELECTRON_RUN_AS_NODE=1 node scripts/dev-fixture.mjs （前台常驻，测完 Ctrl-C）
import http from 'node:http'
import crypto from 'node:crypto'

const PORT_UPSTREAM = 60499
const PORT_FWD = 46084
const PAYLOAD = crypto.randomBytes(5_627_366)
console.log(`[fixture] 上游 payload: ${PAYLOAD.length} bytes, sha256=${crypto.createHash('sha256').update(PAYLOAD).digest('hex').slice(0, 16)}…`)

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/javascript', 'content-length': PAYLOAD.length })
  res.end(PAYLOAD)
})
await new Promise((r) => upstream.listen(PORT_UPSTREAM, '127.0.0.1', r))
console.log(`[fixture] mock 上游: 127.0.0.1:${PORT_UPSTREAM}`)

const mod = await import('../index.js')
const ctx = {
  effect: (fn) => fn(),
  tools: { register: () => () => {} },
  webServer: { register: () => () => {}, port: PORT_UPSTREAM },
  connection: { authenticatedUrl: (b) => b + '/?token=DEVTEST', requestRejection: () => 401 },
}
mod.apply(ctx, { enabled: true, listenPort: PORT_FWD, bindAddress: '127.0.0.1', publicBaseUrl: 'https://dev-fixture.invalid' })
console.log(`[fixture] 插件转发器: 127.0.0.1:${PORT_FWD} 就绪（/pair、/wizard、批量 URL 均可测）`)
setInterval(() => {}, 1000)
