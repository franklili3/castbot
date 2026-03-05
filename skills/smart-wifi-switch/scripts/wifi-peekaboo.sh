#!/bin/bash
# WiFi 切换脚本 - 使用 Peekaboo (v19 - 更新网络配置)
# 用法: wifi-peekaboo.sh <SSID>
# 
# 当前网络布局（无个人热点）：
#   - 已知网络标题 (y=60)
#   - HUAWEI_DOMESTIC (y=90) - 第一个
#   - HUAWEI-FOREIGN (y=125) - 第二个

set -e

SSID="$1"

if [[ -z "$SSID" ]]; then
    echo "用法: wifi-peekaboo.sh <SSID>"
    exit 1
fi

echo "ℹ️ 尝试连接到: $SSID"

# 函数：检查 en1 是否有 IP 地址（表示已连接）
check_connection() {
    local ip
    ip=$(/sbin/ifconfig en1 2>/dev/null | grep "inet " | awk '{print $2}')
    if [[ -n "$ip" ]]; then
        echo "$ip"
        return 0
    fi
    return 1
}

# 先关闭所有菜单和弹窗
peekaboo press escape 2>/dev/null || true
sleep 0.3

# 步骤1: 点击 WiFi 图标
echo "ℹ️ 点击 WiFi 图标..."
peekaboo click --coords 1670,12 2>/dev/null || true
sleep 1.5

# 步骤2: 双击目标网络
echo "ℹ️ 选择网络 $SSID..."

case "$SSID" in
    "HUAWEI_DOMESTIC")
        # 已知网络 - 第一个
        TARGET_Y=90
        ;;
    "HUAWEI-FOREIGN")
        # 已知网络 - 第二个
        TARGET_Y=125
        ;;
    *)
        echo "❌ 未知网络: $SSID"
        peekaboo press escape 2>/dev/null || true
        exit 1
        ;;
esac

# 双击网络名称
echo "ℹ️ 双击位置 y=$TARGET_Y..."
peekaboo click --coords 1670,$TARGET_Y 2>/dev/null || true
sleep 0.2
peekaboo click --coords 1670,$TARGET_Y 2>/dev/null || true

# 等待连接完成
echo "ℹ️ 等待连接..."
sleep 5

# 关闭 WiFi 菜单
peekaboo press escape 2>/dev/null || true
sleep 1

# 检查连接状态（通过 IP 地址）
IP=$(check_connection)
if [[ -n "$IP" ]]; then
    echo "✅ 已连接到网络，IP 地址: $IP"

    # 保存当前网络状态到文件
    echo "$SSID" > /Users/mac/clawd/skills/smart-wifi-switch/data/current-wifi.state

    exit 0
else
    echo "❌ 未能连接到 $SSID"
    exit 1
fi
