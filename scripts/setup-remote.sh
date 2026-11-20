#!/usr/bin/env bash
# remote-bridge 一键远程配置（macOS + DeepSeek Harness 桌面版）
#
# 用法：
#   ./setup-remote.sh            # 组网内访问（手机装 Tailscale app，最安全，推荐）
#   FUNNEL=1 ./setup-remote.sh   # 额外开启公网 Funnel（免装 app 的浏览器直达）
#
# 自动完成：安装 Tailscale → 启动用户态守护进程 → 引导登录 → 配置 serve
#           → 写 profile 配置（trustedHosts + 插件参数）→ 签发证书 → 端到端自检
# 需要你动手的只有两处：浏览器登录一次、点一次 serve 启用链接（脚本会给出链接并等待）。
set -u

TS_BIN="/opt/homebrew/bin/tailscale"
SOCK_DIR="$HOME/.tailscale"
SOCK="$SOCK_DIR/tailscaled.sock"
PLIST_LABEL="dev.remote-bridge.tailscaled-userspace"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
PROFILE="$HOME/.dsh/profiles/desktop/cordis.patch.yml"
PORT=46084
ts() { "$TS_BIN" --socket="$SOCK" "$@"; }

say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "本脚本目前只支持 macOS"
[ -d "$HOME/.dsh/profiles/desktop" ] || die "未找到 desktop profile —— 请先安装并启动 DeepSeek Harness 桌面版"

say "1/8 Tailscale CLI（brew，约 25MB，无需 sudo）"
if ! command -v brew >/dev/null 2>&1; then die "未找到 Homebrew（https://brew.sh 安装后重跑）"; fi
command -v "$TS_BIN" >/dev/null 2>&1 || HOMEBREW_NO_AUTO_UPDATE=1 brew install tailscale || die "tailscale 安装失败"

say "2/8 用户态守护进程（LaunchAgent，开机自启，无需 sudo）"
mkdir -p "$SOCK_DIR"
if ! launchctl print "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1; then
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/opt/tailscale/bin/tailscaled</string>
    <string>--tun=userspace-networking</string>
    <string>--statedir=$SOCK_DIR</string>
    <string>--socket=$SOCK</string>
    <string>--outbound-http-proxy-listen=127.0.0.1:1056</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$SOCK_DIR/tailscaled.log</string>
  <key>StandardErrorPath</key><string>$SOCK_DIR/tailscaled.log</string>
</dict></plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL"
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$SOCK" ] && break; sleep 1
done
[ -S "$SOCK" ] || die "tailscaled 未就绪（日志: $SOCK_DIR/tailscaled.log）"

say "3/8 登录 Tailscale（浏览器里完成，免费账号）"
ST="$(ts status 2>&1 | head -1)"
if printf '%s' "$ST" | grep -q 'Logged out'; then
  ( ts login >/dev/null 2>&1 ) &
  LOGIN_PID=$!
  sleep 3
  URL="$(grep -o 'https://login.tailscale.com/a/[a-z0-9]*' "$SOCK_DIR/tailscaled.log" | tail -1)"
  [ -n "$URL" ] || die "未取得登录链接（日志: $SOCK_DIR/tailscaled.log）"
  echo "  👉 请打开并完成授权: $URL"
  open "$URL" 2>/dev/null
  printf '  等待登录完成'
  OK=0
  for i in $(seq 1 120); do
    sleep 2; printf '.'
    ts status 2>&1 | head -1 | grep -q 'Logged out' || { echo ' ✓'; OK=1; break; }
    [ "$i" -eq 120 ] && { echo; die "登录超时，重跑本脚本即可"; }
  done
  [ "$OK" -eq 1 ] || die "登录未完成，重跑本脚本即可"
else
  echo "  已登录: $ST"
fi

say "4/8 本机 ts.net 固定域名"
FQDN="$(ts status --json 2>/dev/null | /usr/bin/sed -n 's/.*"DNSName" *: *"\([^"]*\)".*/\1/p' | head -1 | sed 's/\.$//')"
[ -n "$FQDN" ] || die "未取得 DNSName"
echo "  https://$FQDN"

say "5/8 写 profile 配置（自动备份，幂等）"
if [ ! -f "$PROFILE" ]; then die "未找到 $PROFILE"; fi
cp "$PROFILE" "$PROFILE.bak-remote-bridge-$(date +%Y%m%d-%H%M%S)"
if grep -q 'id: connection' "$PROFILE"; then
  # 已有 connection 行：把 FQDN 并进 trustedHosts，并确保 cookie 十年有效期
  /usr/bin/sed -i '' "s|^\([[:space:]]*trustedHosts:[[:space:]]*\[.*\)\][[:space:]]*$|\1, '$FQDN' ]|" "$PROFILE" \
    || echo "  ⚠️ connection 行已存在但自动改写失败，请手动把 '$FQDN' 加进 trustedHosts"
  grep -q "$FQDN" "$PROFILE" || echo "  ⚠️ 请确认 trustedHosts 已包含 '$FQDN'"
  if ! grep -q 'cookieMaxAgeDays' "$PROFILE"; then
    /usr/bin/perl -pi -e "s/^([[:space:]]*trustedHosts:[[:space:]]*\[.*\])[[:space:]]*\$/\$1\n    cookieMaxAgeDays: 3650/" "$PROFILE" \
      && echo "  ✓ cookie 有效期已设为 3650 天" || echo "  ⚠️ 请手动在 connection 行 config 里加 cookieMaxAgeDays: 3650"
  fi
else
  cat >> "$PROFILE" <<EOF

# remote-bridge：放行手机访问的 authority + 登录 cookie 十年有效期
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [ webStartup ]
  config:
    trustedHosts: [ '$FQDN' ]
    cookieMaxAgeDays: 3650
EOF
fi
if ! grep -q 'id: remote-bridge' "$PROFILE"; then
  cat >> "$PROFILE" <<EOF
# remote-bridge：转发器绑定与手机地址（覆盖 bundle 层完整 config）
- id: remote-bridge
  name: '@local/remote-bridge'
  config:
    enabled: true
    listenPort: $PORT
    bindAddress: '0.0.0.0'
    publicBaseUrl: 'https://$FQDN'
EOF
fi
echo "  ✓ trustedHosts 与插件参数已写入（重启 Harness 或等 HMR 生效）"

say "6/8 配置 serve（组网内 HTTPS）"
SERVE_OUT="$(ts serve --bg "127.0.0.1:$PORT" 2>&1 || true)"
if printf '%s' "$SERVE_OUT" | grep -q 'Serve is not enabled'; then
  EN_URL="$(printf '%s' "$SERVE_OUT" | grep -o 'https://login.tailscale.com/f/serve[^[:space:]]*' | head -1)"
  echo "  👉 请打开并启用一次: $EN_URL"
  open "$EN_URL" 2>/dev/null
  printf '  等待启用'
  OK=0
  for i in $(seq 1 60); do
    sleep 3; printf '.'
    ts serve status 2>&1 | grep -q "$FQDN" && { echo ' ✓'; OK=1; break; }
    [ "$i" -eq 60 ] && { echo; die "等待启用超时：请确认已点击链接，然后重跑本脚本"; }
  done
  [ "$OK" -eq 1 ] || die "等待启用超时：请确认已点击链接，然后重跑本脚本"
  ts serve --bg "127.0.0.1:$PORT" >/dev/null 2>&1
fi
ts serve status 2>&1 | grep -q "$FQDN" || die "serve 配置未生效，请重跑本脚本"
echo "  ✓ https://$FQDN → 127.0.0.1:$PORT"

say "7/8 签发 TLS 证书（funnel/serve 共用）"
ts cert "$FQDN" >/dev/null 2>&1 && echo "  ✓ 证书已就绪" || echo "  ⚠️ 证书签发未完成（首次可能要几十秒，稍后重跑或忽略——serve 会自动重试）"

if [ "${FUNNEL:-0}" = "1" ]; then
  say "7.5/8 开启 Funnel（公网直达，免装 app）"
  ts funnel --bg "127.0.0.1:$PORT" 2>&1 | sed 's/^/  /'
fi

say "8/8 端到端自检"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy http://127.0.0.1:1056 "https://$FQDN/" 2>/dev/null)"
case "$CODE" in
  401) echo "  ✓ 公网/组网入口返回 401（等待令牌，正确）" ;;
  *)   echo "  ⚠️ 入口返回 $CODE（401 才是健康态）；稍等片刻重跑自检或检查 $SOCK_DIR/tailscaled.log" ;;
esac

cat <<EOF

──────────────────────────────────────────────────
✅ 配置完成。日常使用：

  1. Mac 浏览器打开固定入口:  http://127.0.0.1:$PORT/pair
     （端口固定，与 Harness 随机端口无关；被占用时插件自动顺延，
       实际端口看 ~/.dsh/remote-bridge-state.json）
  2. 手机扫码，或打开页面给出的完整地址（带 ?token=…）→ 进入完整 GUI
  3. cookie 十年有效；重启 Harness 后令牌更换，重新扫码即可

安全提示：带 token 的地址 = 桌面完全控制权，不要外发。
停用：插件页关闭 remote-bridge，或 ts funnel reset / ts serve reset。
──────────────────────────────────────────────────
EOF
