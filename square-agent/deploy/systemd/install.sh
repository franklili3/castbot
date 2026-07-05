#!/bin/bash
# 安装/刷新 square-agent 的 systemd user 服务
# 用法（在 VPS 上）:
#   ~/projects/square-agent/square-agent/deploy/systemd/install.sh
# 幂等：可重复运行；修改 .service 后跑这个就生效

set -e

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DST_DIR="$HOME/.config/systemd/user"
mkdir -p "$DST_DIR"

UNITS=(square-agent-server square-agent-news-monitor square-agent-pipeline square-agent-publisher square-agent-bot)

for u in "${UNITS[@]}"; do
  install -m 0644 "$SRC_DIR/$u.service" "$DST_DIR/$u.service"
  echo "✅ installed $u.service"
done

systemctl --user daemon-reload

# enable + (re)start 已存在的单元；首次安装也会拉起
for u in "${UNITS[@]}"; do
  systemctl --user enable "$u.service" >/dev/null
  systemctl --user restart "$u.service" 2>/dev/null || true
done

echo ""
echo "已启动。常用命令："
echo "  systemctl --user status 'square-agent-*'"
echo "  journalctl --user -u square-agent-server -f"
echo "  systemctl --user stop square-agent-server square-agent-pipeline square-agent-publisher"
