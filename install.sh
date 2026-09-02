#!/bin/bash
# Castbot Bot - 一键安装脚本（跨平台：Linux / Windows(WSL) / macOS）
# 用法: curl -sL https://api.castbot.io/install.sh | bash
#
# v0.3.0 起，agent 通过币安广场 OpenAPI 纯 HTTP 发帖，无需 Chrome/AppleScript。

set -e

# API服务器地址
API_BASE="${API_BASE_URL:-https://api.castbot.io}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "═══════════════════════════════════════"
echo "  Castbot Bot 安装程序"
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

# ============ 安装 agent ============
# v1.0.25+：npm 主源（中国大陆可达性最好；可设 CASTBOT_NPM_REGISTRY 用 npmmirror 镜像）。
# 回退链：npm registry → GitHub Releases tgz（需代理）→ server tgz。
NPM_REGISTRY="${CASTBOT_NPM_REGISTRY:-https://registry.npmjs.org}"
GH_TGZ_URL="${CASTBOT_TGZ_URL:-https://github.com/franklili3/castbot/releases/latest/download/castbot.tgz}"
SERVER_TGZ_URL="${API_BASE}/downloads/castbot.tgz"

echo -e "${BLUE}正在安装 Castbot Bot...${NC}"
npm install -g castbot --registry "${NPM_REGISTRY}" 2>&1 || {
  echo -e "${YELLOW}npm registry 安装失败，尝试 GitHub Releases...${NC}"
  npm install -g "${GH_TGZ_URL}" 2>&1 || {
    echo -e "${YELLOW}GitHub 不可达，尝试 server 源...${NC}"
    curl -sL "${SERVER_TGZ_URL}" -o /tmp/castbot.tgz
    npm install -g /tmp/castbot.tgz 2>&1
    rm -f /tmp/castbot.tgz
  }
}

if ! command -v castbot &> /dev/null; then
  echo -e "${RED}错误: 安装后未找到 castbot 命令。${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Agent 安装成功${NC}"

# ============ 自动登录（CASTBOT_API_KEY 由一键安装命令传入）============
if [ -n "${CASTBOT_API_KEY:-}" ]; then
  echo -e "${BLUE}检测到 API Key，自动登录...${NC}"
  if castbot login --key "${CASTBOT_API_KEY}"; then
    echo -e "${GREEN}✅ 已自动登录${NC}"
  else
    echo -e "${YELLOW}⚠️ 自动登录失败，请手动执行: castbot login --key YOUR_API_KEY${NC}"
  fi
fi

# ============ 总结 ============
echo -e "${GREEN}"
echo "═══════════════════════════════════════"
echo "  ✅ 安装完成！"
echo "═══════════════════════════════════════"
echo -e "${NC}"
echo -e "  代理:    ${GREEN}castbot$(castbot --version 2>/dev/null && echo '' || echo ' v1.0.0')${NC}"
echo ""
if [ -n "${CASTBOT_API_KEY:-}" ] && [ -f "$HOME/.castbot/config.json" ]; then
  echo -e "  ${BLUE}下一步:${NC}"
  echo -e "  1. 配置币安广场 OpenAPI Key:"
  echo -e "     ${GREEN}echo \"YOUR_KEY\" > ~/.castbot/binance-api-key${NC}"
  echo -e "     获取地址: https://www.binance.com/zh-CN/square/creator-center/home → 创建 API"
  echo -e "  2. 运行: ${GREEN}castbot start${NC}"
else
  echo -e "  ${BLUE}下一步:${NC}"
  echo -e "  1. 登录:"
  echo -e "     ${GREEN}castbot login --key YOUR_API_KEY${NC}"
  echo -e "  2. 配置币安广场 OpenAPI Key:"
  echo -e "     ${GREEN}echo \"YOUR_KEY\" > ~/.castbot/binance-api-key${NC}"
  echo -e "     或: ${GREEN}export BINANCE_SQUARE_OPENAPI_KEY=YOUR_KEY${NC}"
  echo -e "     获取地址: https://www.binance.com/zh-CN/square/creator-center/home → 创建 API"
  echo -e "  3. 运行: ${GREEN}castbot start${NC}"
fi
echo ""
