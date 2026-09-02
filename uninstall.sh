#!/bin/bash
# Castbot Bot (castbot) - 卸载脚本（Linux / macOS / Windows WSL）
# 用法: curl -sL https://api.castbot.io/uninstall.sh | bash
# 保留配置/API Key: KEEP_CONFIG=1 curl -sL https://api.castbot.io/uninstall.sh | bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "═══════════════════════════════════════"
echo "  Castbot Bot 卸载程序"
echo "═══════════════════════════════════════"
echo -e "${NC}"

DATA_DIR="$HOME/.castbot"

# ============ 1. 停止后台进程 ============
if [ -f "$DATA_DIR/agent.pid" ]; then
  PID="$(cat "$DATA_DIR/agent.pid" 2>/dev/null)"
  if [ -n "$PID" ] && kill "$PID" 2>/dev/null; then
    echo -e "${GREEN}✅ 已停止后台进程 (pid $PID)${NC}"
  fi
fi
if pkill -f "node.*castbot" 2>/dev/null; then
  echo -e "${GREEN}✅ 已停止其余 castbot 进程${NC}"
fi
sleep 1

# ============ 2. 卸载 npm 全局包 ============
if npm uninstall -g castbot 2>/dev/null; then
  echo -e "${GREEN}✅ 已卸载 npm 全局包 castbot${NC}"
else
  echo -e "${YELLOW}⚠️ npm 包未安装或已卸载，跳过${NC}"
fi

# ============ 3. 删除配置目录（含 API Key / 日志）============
if [ "${KEEP_CONFIG:-0}" = "1" ]; then
  echo -e "${YELLOW}⚠️ KEEP_CONFIG=1，保留配置目录 $DATA_DIR（含 API Key）${NC}"
elif [ -d "$DATA_DIR" ]; then
  rm -rf "$DATA_DIR"
  echo -e "${GREEN}✅ 已删除 $DATA_DIR（含 API Key 与日志）${NC}"
else
  echo -e "${YELLOW}⚠️ 配置目录 $DATA_DIR 不存在，跳过${NC}"
fi

echo -e "${GREEN}"
echo "═══════════════════════════════════════"
echo "  ✅ 卸载完成"
echo "═══════════════════════════════════════"
echo -e "${NC}"
echo -e "如需重新使用: ${GREEN}curl -sL https://api.castbot.io/install.sh | bash${NC}"
