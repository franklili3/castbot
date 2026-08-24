#!/bin/bash
# square-agent 卸载脚本（跨平台）
# 停止 agent、删除所有文件、移除服务

# 不使用 set -e，卸载应尽可能继续即使某些步骤无操作

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

AGENT_DIR="$HOME/.square-agent"

echo "🗑️  卸载 Square Agent..."

OS="$(uname -s)"

# 1. 停止服务
case "$OS" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.binsquare.agent.plist"
    if [ -f "$PLIST" ]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo -e "${GREEN}✅ 已停止并移除 LaunchAgent${NC}"
    else
      echo "ℹ️  LaunchAgent 不存在，跳过"
    fi
    ;;
  Linux)
    SERVICE="$HOME/.config/systemd/user/square-agent.service"
    if [ -f "$SERVICE" ]; then
      systemctl --user stop square-agent 2>/dev/null || true
      systemctl --user disable square-agent 2>/dev/null || true
      rm -f "$SERVICE"
      systemctl --user daemon-reload 2>/dev/null || true
      echo -e "${GREEN}✅ 已停止并移除 systemd 服务${NC}"
    else
      echo "ℹ️  systemd 服务不存在，跳过"
    fi
    ;;
  *)
    # Windows/WSL/其他：仅靠进程清理
    echo "ℹ️  当前系统 $OS 无系统服务管理"
    ;;
esac

# 2. 杀死运行中的 agent 进程（兼容旧名 binsquare 与新名 square-agent）
if pkill -f "node.*agent.mjs.*bsq_" 2>/dev/null; then
  echo -e "${GREEN}✅ 已停止运行中的 Agent (agent.mjs)${NC}"
elif pkill -f "node.*square-agent" 2>/dev/null; then
  echo -e "${GREEN}✅ 已停止运行中的 Agent (square-agent)${NC}"
else
  echo "ℹ️  没有运行中的 Agent"
fi

# 3. 删除数据目录
if [ -d "$AGENT_DIR" ]; then
  rm -rf "$AGENT_DIR"
  echo -e "${GREEN}✅ 已删除 $AGENT_DIR${NC}"
else
  echo "ℹ️  Agent 目录不存在，跳过"
fi

# 4. 卸载 npm 全局包
if command -v npm &> /dev/null; then
  if npm ls -g square-agent-publisher --depth=0 2>/dev/null | grep -q square-agent-publisher; then
    npm uninstall -g square-agent-publisher 2>/dev/null && echo -e "${GREEN}✅ 已卸载 npm 全局包 square-agent-publisher${NC}"
  elif npm ls -g square-agent --depth=0 2>/dev/null | grep -q square-agent; then
    npm uninstall -g square-agent 2>/dev/null && echo -e "${GREEN}✅ 已卸载 npm 全局包 square-agent${NC}"
  else
    echo "ℹ️  未安装 npm 全局包，跳过"
  fi
fi

echo ""
echo -e "${GREEN}✅ 卸载完成！${NC}"
echo "💡 如需重新安装，请在 Telegram Bot 中发送 /start 获取安装命令。"
