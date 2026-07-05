#!/bin/bash
# SquareAgent - 一键安装脚本（跨平台：Linux / Windows(WSL) / macOS）
# 用法: AGENT_TOKEN=*** curl -sL https://api.square-agent.com/install.sh | bash
#
# v0.3.0 起，agent 通过币安广场 OpenAPI 纯 HTTP 发帖，无需 Chrome/AppleScript。

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "═══════════════════════════════════════"
echo "  SquareAgent 安装程序"
echo "═══════════════════════════════════════"
echo -e "${NC}"

# ============ OS 检测 ============
OS="$(uname -s)"
case "$OS" in
  Darwin)
    PLATFORM="macos"
    echo -e "${GREEN}✅ 平台: macOS${NC}"
    ;;
  Linux)
    PLATFORM="linux"
    echo -e "${GREEN}✅ 平台: Linux${NC}"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM="windows"
    echo -e "${GREEN}✅ 平台: Windows (WSL/Git Bash)${NC}"
    ;;
  *)
    echo -e "${RED}错误: 不支持的系统: $OS${NC}"
    exit 1
    ;;
esac

# ============ Node.js 检查 + 安装 ============
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}未检测到 Node.js，开始安装...${NC}"
  case "$PLATFORM" in
    macos)
      if ! command -v brew &> /dev/null; then
        echo -e "${YELLOW}正在安装 Homebrew...${NC}"
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      fi
      brew install node
      ;;
    linux)
      # NodeSource 官方安装脚本（最新 LTS）
      if command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs
      elif command -v yum &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
        sudo yum install -y nodejs
      else
        echo -e "${RED}不支持的 Linux 发行版，请手动安装 Node.js 18+: https://nodejs.org/${NC}"
        exit 1
      fi
      ;;
    windows)
      echo -e "${YELLOW}请通过以下方式安装 Node.js 18+:${NC}"
      echo -e "  winget install OpenJS.NodeJS.LTS"
      echo -e "  或使用 nvm-windows: https://github.com/coreybutler/nvm-windows"
      echo -e "${YELLOW}安装后重新运行此脚本。${NC}"
      exit 1
      ;;
  esac
fi

NODE_VERSION=$(node -v | cut -d. -f1 | tr -d 'v')
if [[ "$NODE_VERSION" -lt 18 ]]; then
  echo -e "${RED}错误: 需要 Node.js 18+（当前: $(node -v)），请升级。${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v)${NC}"

# ============ AGENT_TOKEN 检查 ============
if [[ -z "$AGENT_TOKEN" ]]; then
  echo -e "${RED}错误: 必须提供 AGENT_TOKEN。${NC}"
  echo -e "用法: ${YELLOW}AGENT_TOKEN=*** curl -sL https://api.square-agent.com/install.sh | bash${NC}"
  exit 1
fi

# ============ API 验证 ============
API_BASE="${API_BASE_URL:-https://api.square-agent.com}"

echo -e "${BLUE}正在验证 API Key...${NC}"
VERIFY_RESULT=$(curl -s "${API_BASE}/api/agent/verify?key=${AGENT_TOKEN}" 2>&1)
if echo "$VERIFY_RESULT" | grep -q '"user_id":'; then
  USERNAME=$(echo "$VERIFY_RESULT" | node -pe 'JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).user_id||"unknown"' 2>/dev/null || echo "unknown")
  echo -e "${GREEN}✅ API Key 验证成功（用户: ${USERNAME}）${NC}"
else
  echo -e "${RED}错误: API Key 无效，请检查你的令牌。${NC}"
  exit 1
fi

# ============ 安装 agent ============
echo -e "${BLUE}正在安装 SquareAgent...${NC}"
npm install -g ${API_BASE}/downloads/square-agent-publisher.tgz 2>&1 || {
  echo -e "${YELLOW}npm 安装失败，尝试直接下载...${NC}"
  curl -sL "${API_BASE}/downloads/square-agent-publisher.tgz" -o /tmp/square-agent-publisher.tgz
  npm install -g /tmp/square-agent-publisher.tgz 2>&1
  rm -f /tmp/square-agent-publisher.tgz
}

if ! command -v square-agent &> /dev/null; then
  echo -e "${RED}错误: 安装后未找到 square-agent 命令。${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Agent 安装成功${NC}"

# ============ 登录 ============
echo -e "${BLUE}正在登录...${NC}"
square-agent login --key "$AGENT_TOKEN" 2>&1
echo -e "${GREEN}✅ 已登录为 ${USERNAME}${NC}"

# ============ 总结 ============
echo -e "${GREEN}"
echo "═══════════════════════════════════════"
echo "  ✅ 安装完成！"
echo "═══════════════════════════════════════"
echo -e "${NC}"
echo -e "  用户:    ${GREEN}${USERNAME}${NC}"
echo -e "  代理:    ${GREEN}square-agent$(square-agent --version 2>/dev/null && echo '' || echo ' v0.3.0')${NC}"
echo ""
echo -e "  ${BLUE}下一步:${NC}"
echo -e "  1. 配置币安广场 OpenAPI Key:"
echo -e "     ${GREEN}echo \"YOUR_KEY\" > ~/.square-agent/binance-api-key${NC}"
echo -e "     或: ${GREEN}export BINANCE_SQUARE_OPENAPI_KEY=YOUR_KEY${NC}"
echo -e "     获取地址: https://www.binance.com/zh-CN/square/creator-center/home → 创建 API"
echo -e "  2. 运行: ${GREEN}square-agent start${NC}"
echo ""
