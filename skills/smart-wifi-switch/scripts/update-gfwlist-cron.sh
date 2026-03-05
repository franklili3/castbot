#!/bin/bash
# 定期更新 GFWList 的 cron 任务安装脚本

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_SCRIPT="${SCRIPT_DIR}/smart-wifi-switch.sh"

echo "=== 安装 GFWList 定期更新任务 ==="
echo ""

# 检查当前的 crontab
echo "当前 crontab:"
crontab -l 2>/dev/null | grep -v "smart-wifi-switch" || echo "  (空)"
echo ""

# 添加更新任务（每天凌晨3点更新）
CRON_JOB="0 3 * * * ${UPDATE_SCRIPT} update >> /tmp/gfwlist-update.log 2>&1"

echo "将添加以下 cron 任务:"
echo "  ${CRON_JOB}"
echo ""

read -p "确认添加？(y/n): " confirm
if [[ "${confirm}" == "y" || "${confirm}" == "Y" ]]; then
    # 备份当前 crontab
    crontab -l > /tmp/crontab.backup 2>/dev/null || true
    
    # 添加新任务
    (crontab -l 2>/dev/null | grep -v "smart-wifi-switch"; echo "${CRON_JOB}") | crontab -
    
    echo "✅ 已添加 cron 任务"
    echo ""
    echo "更新日志: /tmp/gfwlist-update.log"
else
    echo "已取消"
fi
