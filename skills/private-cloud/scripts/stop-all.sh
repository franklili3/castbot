#!/bin/bash
# 私有云服务停止脚本

echo "🛑 停止私有云服务..."

# 停止 Nextcloud
echo "☁️ 停止 Nextcloud..."
pkill -f "php.*8081" 2>/dev/null && echo "   ✅ 已停止" || echo "   ℹ️ 未运行"

# 停止 Stalwart
echo "📧 停止 Stalwart..."
cd ~/clawd/skills/local-mail-server
./scripts/start-mail-server.sh stop

# ddns-go 不停止（后台服务）
echo "🌐 ddns-go 保持运行（后台服务）"

echo ""
echo "✅ 私有云服务已停止"
