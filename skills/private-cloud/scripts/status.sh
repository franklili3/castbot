#!/bin/bash
# 私有云服务状态检查

echo "📊 私有云服务状态"
echo "=================="

# 检查 Nextcloud
echo ""
echo "☁️ Nextcloud:"
if pgrep -f "php.*8081" > /dev/null; then
    echo "   ✅ 运行中"
    echo "   地址: https://franks-mac-mini.taile3ecbd.ts.net/"
else
    echo "   ❌ 未运行"
fi

# 检查 Stalwart
echo ""
echo "📧 Stalwart Mail:"
if nc -z localhost 143 2>/dev/null; then
    echo "   ✅ IMAP 运行中 (143)"
else
    echo "   ❌ IMAP 未运行"
fi
if nc -z localhost 587 2>/dev/null; then
    echo "   ✅ SMTP 运行中 (587)"
else
    echo "   ❌ SMTP 未运行"
fi

# 检查 ddns-go
echo ""
echo "🌐 ddns-go:"
if nc -z localhost 9876 2>/dev/null; then
    echo "   ✅ 运行中"
    echo "   域名: mail.lilibtc.com"
else
    echo "   ❌ 未运行"
fi

# 检查 Tailscale
echo ""
echo "🔗 Tailscale:"
TS_STATUS=$(tailscale status --json 2>/dev/null | jq -r '.BackendState' 2>/dev/null)
if [ "$TS_STATUS" = "Running" ]; then
    TS_IP=$(tailscale ip -4 2>/dev/null)
    echo "   ✅ 已连接"
    echo "   IP: $TS_IP"
    echo "   主机名: franks-mac-mini.taile3ecbd.ts.net"
else
    echo "   ❌ 未连接 ($TS_STATUS)"
fi

echo ""
echo "=================="
