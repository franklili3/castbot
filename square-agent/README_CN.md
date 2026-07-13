# SquareAgent — 加密社媒自动化工具

[English](README.md) | 中文文档

定时采集加密新闻，用大模型生成内容，一键发布到币安广场、X/Twitter、Telegram 频道。

## ⚠️ 免责声明

本软件**不包含**内容安全过滤、频率限制或合规审查功能。
用户需自行确保遵守平台服务条款和当地法律法规。
**风险自负。**

## 功能总览

### 🟢 开源版

- **多平台发布** — 币安广场、X/Twitter、Telegram 频道
- **RSS 新闻聚合** — 从多个来源自动采集加密新闻
- **大模型内容生成** — 把原始新闻转化为社媒帖子
- **MCP Server** — 对接 AI Agent（Claude、OpenClaw 等）
- **CLI 命令行** — 快速发布、生成、健康检查
- **零依赖** — 纯 Node.js（>= 18），使用原生 `fetch`
- **Docker 一键部署**

### 🔵 商业版（Telegram Bot + 自动发布 Agent）

商业版在开源版基础上，新增 **Telegram Bot 交互管理** 和 **本地自动发布 Agent**，实现从内容生成到发布的完整闭环。

#### Telegram Bot 功能

| 命令 | 功能 |
|---|---|
| `/start` | 注册账号（输入币安 UID → 选择内容风格 → 获取 Agent 安装令牌） |
| `/preview` | 生成内容预览，支持批准/重新生成/丢弃 |
| `/schedule` | 管理定时任务（add/remove/toggle），支持 cron 表达式 |
| `/settings` | 全面的偏好设置面板（详见下方） |
| `/stats` | 查看发布数据统计（总计/今日/各状态分布） |
| `/history` | 查看最近发布记录 |
| `/token` | 获取 Agent 安装令牌 |
| `/help` | 帮助文档 |
| `/unregister` | 注销账号并删除数据 |

#### ⚙️ Settings 偏好设置面板

Bot 提供丰富的内联键盘设置界面，用户可直接在 Telegram 中完成所有配置：

**内容风格**（3种）
- 🔥 激进型 — 观点鲜明，情绪驱动
- ⚖️ 稳健型 — 客观分析，数据说话
- 📊 量化型 — 策略导向，回测支撑

**发布频率**
- 1 篇/天、2 篇/天、3 篇/天

**内容类型**（可多选）
- 📝 短贴、📊 投票贴

**模板管理**（21 个模板，按类别分组，逐个开关）

| 类别 | 模板 |
|---|---|
| 📈 行情短贴（仅需行情数据） | 📊 资金费率热力图、🐋 链上信号、📐 交易理念 |
| 📰 新闻短贴（AI + 搜索） | 📰 新闻解读、⚡ 链上速报、🚨 价格异动、🐋 巨鲸速报、😱 情绪分析、📊 深度分析、💬 热点短评、🪂 空投教程、🏛️ 宏观解读 |
| 📊 投票贴（仅需行情数据） | 涨跌预测、仓位调查、关键位博弈、互动话题、行情剧变 |
| 📢 推广贴 | 🏆 周报战报、💪 回撤安抚、🧠 预判证实、⏳ 名额稀缺 |

**其他设置**
- 🔍 审核模式 — 🤖 自动发布 / ✋ 人工审核
- 🌐 语言 — 中文 / English / 日本語 / 한국어
- 🪙 关注币种 — BTC、ETH、SOL、BNB、XRP、DOGE、MARA、CLSK、RIOT、NVDA、TSM、SK海力士

#### 自动发布 Agent（Mac）

- **一键安装**：`curl -sL https://api.square-agent.com/install.sh | AGENT_TOKEN=xxx bash`
- 自动注册 → 轮询待发布内容 → 通过 AppleScript 控制 Chrome 发布到币安广场
- 发布成功/失败自动通过 Telegram 通知
- 30 秒心跳上报 + 自动重连
- 防重复发布（内容 hash 校验）

#### API Server

- Agent 注册/心跳
- 待发布内容拉取
- 发布状态回传
- 帖子数据管理
- Agent 日志上传
- 静态资源分发（安装脚本、Agent 包）

#### 内容引擎（Server 端）

- 12+ AI 生成模板（早报、复盘、深度分析、新闻快讯等）
- 实时行情数据注入（Binance API）
- 恐惧贪婪指数、资金费率、链上数据
- 跟单数据集成（ROI、胜率、回撤）
- 每日热点报告参考
- 防重复发布 + 每日模板不重复

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/franklili3/square-agent.git
cd square-agent

# 2. 配置
cp .env.example .env
# 编辑 .env，填入你的 API Key

# 3. 启动管道（RSS → 大模型生成 → 发布）
npm start

# 或单独运行某个组件：
node news-pipeline/news-monitor.mjs     # RSS 采集器
node news-pipeline/pipeline.mjs --watch # 完整管道
node src/cli.mjs publish --text "你好"   # 快速发布
node src/mcp-server.mjs                 # MCP Server
```

## Docker 部署

```bash
cp .env.example .env
# 编辑 .env
docker compose up -d
```

## 架构

```
                        ┌──────────────────────────────┐
                        │     Telegram Bot               │
                        │  (用户注册/设置/审核/通知)      │
                        └──────────┬───────────────────┘
                                   │
RSS 源 ──→ news-monitor.mjs ──→ news-queue.json      │
                                        │               │
                              pipeline.mjs               │
                                        │               │
                              news-generator.mjs         │
                              （大模型内容引擎）           │
                                        │               │
                              registry.mjs ──→ 币安广场  │
                                            ──→ X/Twitter
                                            ──→ Telegram 频道
                                            ──→ Bot API Server
                                                        │
                                              Agent（Mac）← 轮询 + AppleScript 发布
                                                        │
                                              发布结果 ──→ Telegram 通知
```

详见 [docs/architecture.md](docs/architecture.md)。

## 平台连接器

### 币安广场
- 通过官方 OpenAPI 发送文本 + 图片帖子
- 在 `.env` 中设置 `BINANCE_SQUARE_API_KEY`

### X/Twitter
- 通过 X API v2 发送文本帖子
- 在 `.env` 中设置 `X_OAUTH_TOKEN`

### Telegram 频道
- 通过 Bot API 发送文本 + 图片帖子
- 在 `.env` 中设置 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHANNEL_ID`

### 自定义平台
继承 `BaseConnector`，实现 `publish()` 方法：
```javascript
import { BaseConnector } from 'square-agent/connectors/base';

class MyConnector extends BaseConnector {
  async publish(content, options = {}) {
    // 你的逻辑
    return { success: true, postId: '123' };
  }
}
```

## MCP 集成

SquareAgent 内置 MCP（Model Context Protocol）Server：

```json
{
  "mcpServers": {
    "square-agent": {
      "command": "node",
      "args": ["/path/to/square-agent/src/mcp-server.mjs"]
    }
  }
}
```

可用工具：`publish_post`、`generate_content`、`check_health`。

## 配置

复制 `news-pipeline/config.example.mjs` 为 `news-pipeline/config.mjs`，自定义：

- RSS 新闻源
- 关键词过滤
- 大模型端点
- 发布平台

## 开源版 vs 商业版

| 能力 | 开源版 | 商业版 |
|---|---|---|
| RSS 新闻采集 | ✅ | ✅ |
| 大模型内容生成 | ✅ 基础 | ✅ 12+ 模板 + 行情/情绪数据注入 |
| 多平台发布 | ✅ | ✅ |
| MCP / CLI | ✅ | ✅ |
| Docker 部署 | ✅ | ✅ |
| **Telegram Bot 管理** | ❌ | ✅ 注册/设置/审核/通知 |
| **内容模板系统** | ❌ | ✅ 21 个模板（行情/新闻/投票/推广） |
| **偏好设置面板** | ❌ | ✅ 风格/频率/类型/模板/审核/语言/币种 |
| **自动发布 Agent** | ❌ | ✅ Mac AppleScript + Chrome |
| **定时任务调度** | ❌ | ✅ cron 表达式 + 模板排期 |
| **审核工作流** | ❌ | ✅ 人工审核 / 自动发布 |
| **发布通知** | ❌ | ✅ 成功/失败 Telegram 推送 |
| **跟单数据集成** | ❌ | ✅ ROI/胜率/回撤/粉丝 |
| **防重复发布** | ❌ | ✅ 内容 hash 校验 |
| 敏感词过滤 | ❌ | ✅ |
| 风险提示注入 | ❌ | ✅ |
| 内容去重 | ❌ | ✅ |
| 发布频率控制 | ❌ | ✅ |
| 审批流 | ❌ | ✅ |
| 账号健康监控 | ❌ | ✅ |

需要完整风控和自动化运营能力？联系：348104201@qq.com

## 许可证

MIT — 详见 [LICENSE](LICENSE)
