#!/bin/bash
# WiFi 切换通知脚本
# 用法: wifi-notify.sh <network_type> <ssid>

NETWORK_TYPE="$1"
TARGET_SSID="$2"

if [[ -z "$TARGET_SSID" ]]; then
    echo "用法: wifi-notify.sh <domestic|foreign> <ssid>"
    exit 1
fi

# 发送系统通知
osascript -e "display notification \"请手动切换到 WiFi: $TARGET_SSID\" with title \"WiFi 切换提醒\" sound name \"Glass\""

# 同时用 say 语音提醒
say "请切换到 $TARGET_SSID 网络" &

echo "ℹ️ 已发送切换提醒: $TARGET_SSID"
