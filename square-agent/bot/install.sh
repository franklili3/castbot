#!/bin/bash
# Square Agent v0.2.0 一键安装脚本
#
# 用法:
#   AGENT_TOKEN=bsq_xxxxx curl -sL https://api.square-agent.com/install.sh | bash
#   或:  AGENT_TOKEN=bsq_xxxxx SERVER_URL=https://api.square-agent.com ./install.sh
#
# 改进:
# - 支持 AGENT_TOKEN 环境变量一键安装（非交互）
# - 纯 macOS 原生自动化（AppleScript + Chrome JS），无需 peekaboo
# - 自动从服务器下载 agent.mjs
# - 支持 macOS launchd 开机自启
# - 创建 ~/.square-agent/ 安装目录
# - 不需要 sudo

set -e

SERVER_URL="${SERVER_URL:-https://api.square-agent.com}"

echo "🤖 Square Agent v0.2.0 安装程序"
echo "==================================="
echo "📡 Server: $SERVER_URL"
echo ""

# ============ 检查 Node.js ============
if ! command -v node &> /dev/null; then
    echo "❌ 未检测到 Node.js，请先安装 Node.js v18+"
    echo "   https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 版本过低 (当前: $(node -v))，需要 v18+"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# ============ 检查 macOS ============
if [ "$(uname)" != "Darwin" ]; then
    echo "⚠️  目前仅支持 macOS"
    exit 1
fi

# ============ 检查 Chrome ============
if [ ! -d "/Applications/Google Chrome.app" ]; then
    echo "⚠️  未检测到 Google Chrome，请确保已安装"
else
    echo "✅ Google Chrome"
fi

# ============ 检查 Chrome（自动化载体） ============
if [ ! -d "/Applications/Google Chrome.app" ]; then
    echo "⚠️  未检测到 Google Chrome，请确保已安装"
else
    echo "✅ Google Chrome"
fi

# UI 自动化使用 macOS 原生 AppleScript + Chrome JS，不再需要 peekaboo。
# 仅需在「系统设置 → 隐私与安全性 → 辅助功能」中授权 Terminal/Node。

# ============ 令牌验证 ============
if [ -z "$AGENT_TOKEN" ]; then
    echo ""
    echo "请输入安装令牌（在 Telegram Bot 中获取）："
    read -r AGENT_TOKEN
fi

if [ -z "$AGENT_TOKEN" ]; then
    echo "❌ 令牌不能为空"
    exit 1
fi

echo ""
echo "🔑 验证令牌..."

# ============ 创建安装目录 ============
INSTALL_DIR="$HOME/.square-agent"
mkdir -p "$INSTALL_DIR/logs"

# ============ 测试连接 & 验证令牌 ============
REGISTER_RESULT=$(node -e "
const token = process.argv[1];
const url = process.argv[2];
fetch(url + '/api/agent/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': 'binsquare-dev-key-2026' },
  body: JSON.stringify({ token, hostname: require('os').hostname(), platform: process.platform })
}).then(r => r.json()).then(d => {
  if (d.agentId) {
    console.log(JSON.stringify({ ok: true, agentId: d.agentId, uid: d.user.binance_uid, style: d.user.style }));
  } else {
    console.log(JSON.stringify({ ok: false, error: d.error || 'unknown' }));
  }
}).catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
})
" "$AGENT_TOKEN" "$SERVER_URL")

if echo "$REGISTER_RESULT" | grep -q '"ok":true'; then
    AGENT_ID=$(echo "$REGISTER_RESULT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).agentId)")
    Binance_UID=$(echo "$REGISTER_RESULT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).uid)")
    echo "✅ 连接成功！"
    echo "   Agent ID: $AGENT_ID"
    echo "   币安 UID: $Binance_UID"
else
    ERROR_MSG=$(echo "$REGISTER_RESULT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).error)" 2>/dev/null || echo "未知错误")
    echo "❌ 连接失败: $ERROR_MSG"
    exit 1
fi

# ============ 写入配置 ============
cat > "$INSTALL_DIR/.env" << EOF
AGENT_TOKEN=$AGENT_TOKEN
SERVER_URL=$SERVER_URL
API_KEY=binsquare-dev-key-2026
POLL_INTERVAL=30000
EOF
echo "✅ 配置已写入 $INSTALL_DIR/.env"

# ============ 下载 Agent ============
echo "📥 下载 Agent..."
curl -sL "$SERVER_URL/download/agent" -o "$INSTALL_DIR/agent.mjs"
if [ ! -s "$INSTALL_DIR/agent.mjs" ]; then
    echo "❌ 下载失败"
    exit 1
fi
echo "✅ Agent 已下载 ($(wc -c < "$INSTALL_DIR/agent.mjs") bytes)"

# ============ 创建启动脚本 ============
cat > "$INSTALL_DIR/start.sh" << 'START_EOF'
#!/bin/bash
cd "$(dirname "$0")"
export $(grep -v '^#' .env | xargs)
node agent.mjs
START_EOF
chmod +x "$INSTALL_DIR/start.sh"
echo "✅ 启动脚本已创建"

# ============ macOS launchd 自动启动 ============
LAUNCH_AGENT_NAME="com.binsquare.agent"
PLIST_PATH="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_NAME.plist"

# 先卸载旧的
if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LAUNCH_AGENT_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$INSTALL_DIR/start.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/agent.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/agent.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_TOKEN</key>
        <string>$AGENT_TOKEN</string>
        <key>SERVER_URL</key>
        <string>$SERVER_URL</string>
    </dict>
</dict>
</plist>
PLIST

launchctl load "$PLIST_PATH" 2>/dev/null || true
echo "✅ 已设置开机自动启动 (launchd)"

# ============ 完成 ============
echo ""
echo "🎉 安装完成！"
echo ""
echo "📋 信息："
echo "   安装目录: $INSTALL_DIR"
echo "   配置文件: $INSTALL_DIR/.env"
echo "   Agent:    $INSTALL_DIR/agent.mjs"
echo "   日志目录: $INSTALL_DIR/logs/"
echo ""
echo "🚀 操作："
echo "   手动启动: $INSTALL_DIR/start.sh"
echo "   查看日志: tail -f $INSTALL_DIR/agent.log"
echo "   停止服务: launchctl unload $PLIST_PATH"
echo "   重启服务: launchctl unload $PLIST_PATH && launchctl load $PLIST_PATH"
echo ""
echo "⚠️  请确保："
echo "  1. 在「系统设置 → 隐私与安全性 → 辅助功能」中授权 Terminal/Node"
echo "  2. Chrome 已打开并登录币安 (binance.com)"
echo "  3. 在 Telegram Bot 发送内容并批准发布"
echo "  4. Agent 会自动轮询并发布到币安广场"
