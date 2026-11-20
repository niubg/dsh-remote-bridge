# 远程桥（remote-bridge）

手机浏览器打开一个地址，直接控制这台桌面 Harness —— 同一个 Host 进程、同一份会话与工作区数据，没有同步层。

## 它做什么

1. **固定端口转发器**：Desktop 的 webserver 每次启动端口随机（`--port 0`）。本插件监听一个固定端口（默认 `46084`），把每条 TCP 连接原样转发到当前真实端口。WebSocket、SSE、cookie 全部透传。
2. **配对页（固定地址）**：在 Mac 本机浏览器打开
   `http://127.0.0.1:46084/pair`
   端口就是插件配置里的 `listenPort`（默认 46084，与 Harness 端口无关——转发器上做了 HTTP 窥探复用，`/pair` 由插件直接应答，其余流量照常透传）。
   页面显示手机要打开的完整地址（含本次启动 token）与对应**二维码**——手机扫码直达，无需复制粘贴。token 只在本进程内有效，重启 Harness 后重新取。
3. **连接审计**：配对页展示最近经过转发器的连接（时间、来源、目标端口）。

## 首次使用

1. 在 Mac 浏览器打开配对页（地址见上）。
2. 页面会检查目标地址是否被 DSH 的 Host 栅栏放行；若提示拒绝，按页面给出的 YAML 把地址加进 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `connection` 行 `trustedHosts`，重启 Harness。
3. 手机（与 Mac 同一网络）打开页面显示的地址，即进入完整 GUI，与桌面完全一致。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉即停止转发器与配对页 |
| `listenPort` | `46084` | 转发器监听端口；被占用时自动顺延（最多 +20），实际端口看 `~/.dsh/remote-bridge-state.json` |
| `bindAddress` | 自动探测主用私网 IPv4 | 监听地址；写 `127.0.0.1` 可只限本机 |
| `publicBaseUrl` | `http://<bindAddress>:<listenPort>` | 配对页生成的手机地址前缀；接 Tailscale / 公网中继时改成对应 HTTPS 地址 |

登录 cookie 有效期由 `connection` 行的 `cookieMaxAgeDays` 控制（推荐 3650，见 QUICKSTART），与插件参数无关。

## 安全须知

- 持有手机地址（带 token）的人拥有这台 Harness 的完全控制权（可运行命令）。不要把地址发给别人。
- 转发器本身无认证，认证由 DSH 的 Host/Origin 栅栏 + 签名 cookie 承担；`trustedHosts` 只加确信的 authority。
- 配对页只在本机（loopback）可开；非本机请求一律 404。
- 已知限制：v1 走 HTTP 明文（家庭内网可接受）；公网使用请配合 TLS 中继（Tailscale serve 或自有 VPS），并把配对页的 `publicBaseUrl` 指向 HTTPS 地址。
