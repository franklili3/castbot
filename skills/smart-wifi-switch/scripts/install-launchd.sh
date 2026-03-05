#!/bin/bash
# 安装智能WiFi切换为开机启动服务

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR}")"
LAUNCH_AGENT_NAME="com.openclaw.smart-wifi-switch"
LAUNCH_AGENT_PLIST="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_NAME}.plist"

echo "=== 安装智能WiFi切换开机启动服务 ==="
echo ""

# 检查配置文件
if [[ ! -f "${SKILL_DIR}/.env" ]]; then
    echo "⚠️  请先创建配置文件:"
    echo "   cp ${SKILL_DIR}/.env.example ${SKILL_DIR}/.env"
    echo "   然后编辑 .env 设置你的 WiFi 参数"
    echo ""
    exit 1
fi

# 检查必要配置
source "${SKILL_DIR}/.env"

if [[ -z "${WIFI_DOMESTIC_SSID}" && -z "${WIFI_FOREIGN_SSID}" ]]; then
    echo "⚠️  请在 .env 中至少配置一个 WiFi SSID"
    exit 1
fi

# 初始化数据
echo "初始化数据..."
"${SCRIPT_DIR}/smart-wifi-switch.sh" init

# 首次更新 GFWList
echo "下载 GFWList..."
"${SCRIPT_DIR}/smart-wifi-switch.sh" update

# 创建 plist 文件
cat > "${LAUNCH_AGENT_PLIST}" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_NAME}</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>source ${SKILL_DIR}/.env &amp;&amp; ${SCRIPT_DIR}/smart-wifi-switch.sh switch domestic</string>
    </array>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>/tmp/smart-wifi-switch.log</string>
    
    <key>StandardErrorPath</key>
    <string>/tmp/smart-wifi-switch.error.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLIST_EOF

echo "✅ 已创建 LaunchAgent 配置文件"
echo ""

# 加载服务
read -p "是否现在加载服务（开机自动连接国内WiFi）？(y/n): " confirm
if [[ "${confirm}" == "y" || "${confirm}" == "Y" ]]; then
    launchctl load "${LAUNCH_AGENT_PLIST}" 2>/dev/null
    echo "✅ 服务已加载"
    echo ""
    echo "管理命令:"
    echo "   查看状态: launchctl list ${LAUNCH_AGENT_NAME}"
    echo "   停止服务: launchctl unload ${LAUNCH_AGENT_PLIST}"
    echo "   重启服务: launchctl unload ${LAUNCH_AGENT_PLIST} && launchctl load ${LAUNCH_AGENT_PLIST}"
else
    echo ""
    echo "手动加载命令:"
    echo "   launchctl load ${LAUNCH_AGENT_PLIST}"
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "使用方法:"
echo "   智能切换: ${SCRIPT_DIR}/smart-wifi-switch.sh smart google.com"
echo "   手动切换: ${SCRIPT_DIR}/smart-wifi-switch.sh switch foreign"
echo "   查看状态: ${SCRIPT_DIR}/smart-wifi-switch.sh status"
