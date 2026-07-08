#!/bin/bash
# Binance Square 采集 + 分析 cron wrapper
# 每 30 分钟：采集 → 分析 → 同步到 VPS

set -euo pipefail

LOG="/home/frank/clawd/square-agent/data/scrape-cron.log"
exec >> "$LOG" 2>&1

TS=$(date '+%Y-%m-%d %H:%M:%S')
echo "$TS === 采集+分析开始 ==="

# 确保 Xvfb :1 在运行
if ! pgrep -f "Xvfb :1" > /dev/null 2>&1; then
    rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null
    Xvfb :1 -screen 0 1440x900x24 &
    sleep 2
fi

# 激活 venv
source /home/frank/venv-camoufox/bin/activate

# 1. 采集
DISPLAY=:1 python3 /home/frank/clawd/square-agent/scrape/scrape-local-uc.py

# 2. 分析
python3 /home/frank/clawd/square-agent/scrape/analyze-square.py

# 3. 执行改进方案（提取规则 + 推送删除建议）
python3 /home/frank/clawd/square-agent/scrape/apply-improvements.py || \
    echo "$TS ⚠️ 改进执行失败（非致命）"

# 4. 同步到 VPS
rsync -avz --timeout=30 \
    /home/frank/clawd/square-agent/data/creator-home-stats.json \
    /home/frank/clawd/square-agent/data/content-buzz-stats.json \
    /home/frank/clawd/square-agent/data/draft-stats.json \
    /home/frank/clawd/square-agent/data/removed-stats.json \
    /home/frank/clawd/square-agent/data/creator-home.png \
    /home/frank/clawd/square-agent/data/content-buzz.png \
    /home/frank/clawd/square-agent/data/draft.png \
    /home/frank/clawd/square-agent/data/removed.png \
    /home/frank/clawd/square-agent/data/reports/latest-analysis.json \
    /home/frank/clawd/square-agent/data/reports/latest-analysis.md \
    linuxuser@100.70.142.56:/home/linuxuser/binance-square/data/ 2>/dev/null || \
    echo "$TS ⚠️ VPS 同步失败（可能离线）"

echo "$TS === 完成 ==="
