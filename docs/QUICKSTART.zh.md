# 远程桥 · 快速上手（给别人装的第一篇）

5 分钟把「手机远程控制自己的桌面 Harness」跑起来。全程不需要 sudo，不需要公网服务器。

## 前提

- macOS + DeepSeek Harness 桌面版（已启动过，存在 desktop profile）
- Homebrew（脚本用它装 Tailscale，约 25MB）
- 一个免费 Tailscale 账号（登录时会引导注册，可用 Google/GitHub/Apple 登录）

## 安装插件

1. 解压收到的 `remote-bridge` 文件夹（放到任意固定位置，别删）
2. Harness **插件页 → 添加插件**，选中该文件夹
3. 重启 Harness

## 一键远程配置

**方式 A · GUI 向导（保姆级，推荐给所有人）**：装好插件重启后，Mac 浏览器打开固定地址

> `http://127.0.0.1:46084/wizard`

图形化分步向导：状态清单自动显示 → 每步一个按钮（需要浏览器操作的两步会自动弹页面）→ 全部就绪后直接展示手机二维码。整个过程不需要终端、不需要对话框。

**方式 B · 对话框一句话**：在 Harness 对话框里说：

> 帮我把手机远程配置好

Agent 会调用插件自带的 `remote_bridge_setup` 工具分步执行（装 Tailscale → 守护进程 → 登录 → serve → 配置写入 → 证书 → 自检），需要你动手的两处会自动弹出浏览器页面，中途用 `remote_bridge_status` 随时查进度。

**方式 C · 终端脚本**：

```sh
cd <remote-bridge 文件夹>
./scripts/setup-remote.sh
```

脚本会自动：装 Tailscale → 启动守护进程 → 配 serve → 写 profile 配置（含**登录 cookie 十年有效期** `cookieMaxAgeDays: 3650`）→ 签发证书 → 自检。
需要你动手的只有两处（脚本会给出链接并等待）：

1. 浏览器登录 Tailscale 账号（一次）
2. 点一次「启用 serve」的确认链接（一次）

想要「手机不装任何东西、任何浏览器直达」的公网模式，改跑：

```sh
FUNNEL=1 ./scripts/setup-remote.sh
```

## 日常使用

1. Mac 浏览器打开**固定地址** `http://127.0.0.1:46084/pair`（端口固定，不用查 Harness 的端口；被占用时插件会自动顺延，实际端口看 `~/.dsh/remote-bridge-state.json`）
2. 手机**扫码**，或打开页面给出的完整地址（带 `?token=…`）→ 进入完整 GUI
3. 建议在手机上「添加到主屏幕」；登录 cookie 默认 30 天，按快速上手把 `cookieMaxAgeDays` 设成 3650 后十年免登

## 常见问题

| 现象 | 处理 |
|---|---|
| 提示 "dsh web authentication required" | 那个浏览器还没登录过：用**完整带 token 的地址**打开一次（每个浏览器各自登录一次） |
| 地址打不开（serve 模式） | 确认手机 Tailscale app 已连接（同一个账号）；或改用 Funnel 公网模式 |
| 公网首连偶发失败 | Tailscale 入口节点切换，重试一次即可 |
| 固定端口 46084 被占用 | 插件自动顺延到 46085–46104；实际端口看 `~/.dsh/remote-bridge-state.json`，并把 `tailscale serve` 目标改成实际端口 |
| 想换手机地址 | 重启 Harness（令牌随进程更换），重新从配对页/扫码拿 |

## 安全须知

带 token 的地址 = 桌面 Harness 的**完全控制权**（可运行命令）。只在自己设备间使用，不要外发；
停止共享：插件页关闭 remote-bridge，或 `tailscale funnel reset`。

## 配置都写在哪（想手动调整时）

- `~/.dsh/profiles/desktop/cordis.patch.yml`
  - `connection` 行的 `trustedHosts`：放行的访问地址
  - `remote-bridge` 行的 `config`：`enabled` / `listenPort` / `bindAddress` / `publicBaseUrl`
- 插件详情页（插件管理器里点开）有完整说明
