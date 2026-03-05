#!/bin/bash
# 私有云服务启动脚本

echo "🚀 启动私有云服务..."

# 启动 Stalwart 邮件服务
echo "📧 启动 Stalwart 邮件服务..."
cd ~/clawd/skills/local-mail-server
./scripts/start-mail-server.sh start

# 启动 Nextcloud (后台)
echo "☁️ 启动 Nextcloud..."
cd ~/nextcloud
nohup /opt/homebrew/opt/php@8.2/bin/php -d memory_limit=512M -S 0.0.0.0:8081 -t . > /tmp/nextcloud.log 2>&1 &

# 检查 Tailscale 状态
echo "🔗 检查 Tailscale 连接..."
tailscale status

echo ""
echo "✅ 私有云服务已启动"
echo ""
echo "访问地址:"
echo "  Nextcloud:  https://franks-mac-mini.taile3ecbd.ts.net/"
echo "  Stalwart:   http://localhost:8080"
echo "  ddns-go:    http://localhost:9876"
