# SquareAgent 开源方案

> 版本：v1.0 | 日期：2026-06-26

---

## 一、定位与差异化

**一句话定位**：加密垂直的社媒营销自动化框架——行情触发 → AI 内容生成 → 合规过滤 → 多平台分发。

**与 Postiz 的差异**：

```
Postiz    = 通用社媒管理（25+ 平台，无合规，无行情数据）→ 已验证的工程范式
SquareAgent = 加密垂直营销智能体
  ├── 独有：金融合规过滤层 + 行情/链上数据管线 + 多角色审批流
  ├── 借鉴：Connector 抽象 + open-core 模式 + Docker 部署
  └── 不做：通用社媒（Ins/FB/LinkedIn）、CRM、电商
```

**核心壁垒（不开源）**：
- 新闻评分模型与阈值（Pearson r 信号）
- 4h 涨跌预测逻辑
- 多币种轮动优先级
- 具体模板内容与爆款公式

---

## 二、开源/闭源分层

### 🟢 开源（AGPL-3.0）

| 模块 | 说明 | 价值 |
|---|---|---|
| `connectors/` | 平台 Connector 框架 + 币安广场/X/Telegram 实现 | 社区贡献新平台 |
| `compliance/` | 禁用词库 + 风险提示注入 + 辖区路由 | 行业刚需，建立信任 |
| `scheduler/` | 智能发布调度（随机间隔 + 去重 + 配额） | 通用调度能力 |
| `approval-flow/` | 多角色审批状态机 | 持牌机构刚需 |
| `health-monitor/` | 账号健康度监控 | 运维基础 |
| `cli.mjs` | 命令行工具 | 降低使用门槛 |
| `mcp-server.mjs` | MCP Server（AI Agent 集成） | 生态嵌入 |
| `Dockerfile` + `docker-compose.yml` | 一键部署 | 自托管入口 |
| `news-pipeline/` 框架 | RSS 采集 → 去重 → 分发管道骨架 | 不含评分模型 |
| `docs/` | 架构文档 + 痛点分析 + Postiz 借鉴 | 技术博客素材 |

### 🔴 闭源（私有仓库 or 不公开）

| 模块 | 说明 | 理由 |
|---|---|---|
| 评分模型 prompt + 阈值 | LLM 评分系统提示词 + critical/high 分界 | 策略 alpha |
| 4h 预测分析数据 | `docs/news-*-analysis.md` | 回测结论 = 策略价值 |
| 多币种轮动逻辑 | SOL > ETH > BTC 优先级 | alpha 衰减风险 |
| 模板内容 + 爆款公式 | 具体的 SYSTEM_PROMPT 和模板文案 | 内容差异化 |
| 用户数据 + 帖子历史 | DB 文件、API Key、Token | 安全 |

### 🟡 灰区（建议先闭后开）

| 模块 | 现状 | 开放时机 |
|---|---|---|
| Telegram Bot（square-agent-bot） | TypeScript，含用户管理 | 重写为通用 bot 后开放 |
| Server（square-agent-server） | 含业务逻辑 | 抽象为通用 API 后开放 |
| Publisher（agent.mjs） | 含币安 API 细节 | 已迁移到 Connector，可开放 |

---

## 三、仓库结构

```
github.com/yourname/square-agent          # 开源主仓库 (AGPL-3.0)
│
├── README.md                              # 英文，面向海外开发者
├── LICENSE                                # AGPL-3.0
├── CONTRIBUTING.md                        # 贡献指南
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
│
├── src/
│   ├── connectors/                        # 平台连接器
│   │   ├── base.mjs
│   │   ├── binance-square.mjs
│   │   ├── x-twitter.mjs
│   │   ├── telegram-channel.mjs
│   │   └── registry.mjs
│   ├── compliance/                        # 合规过滤
│   │   ├── index.mjs
│   │   ├── banned-words.mjs
│   │   ├── risk-disclaimer.mjs
│   │   └── jurisdiction.mjs
│   ├── scheduler.mjs                      # 智能调度
│   ├── approval-flow.mjs                  # 审批流
│   ├── health-monitor.mjs                 # 健康监控
│   ├── cli.mjs                            # CLI 工具
│   └── mcp-server.mjs                     # MCP Server
│
├── news-pipeline/                         # 新闻采集管道（框架）
│   ├── config.example.mjs                 # 配置模板（不含真实 key）
│   ├── news-monitor.mjs                   # RSS 采集
│   ├── news-interpreter.mjs               # 去重/分类
│   └── pipeline.mjs                       # 主管道（评分 prompt 用占位符）
│
├── docs/
│   ├── trader-pain-points.md              # 痛点分析
│   ├── postiz-analysis.md                 # Postiz 借鉴
│   ├── architecture.md                    # 架构文档（新写）
│   └── api-reference.md                   # API 文档（新写）
│
├── examples/
│   ├── basic-publish.mjs                  # 基础发帖示例
│   ├── multi-platform.mjs                 # 多平台分发
│   ├── custom-connector.mjs               # 自定义 Connector
│   └── compliance-filter.mjs              # 合规过滤示例
│
└── scripts/
    └── setup.mjs                          # 交互式配置向导


github.com/yourname/square-agent-private    # 私有仓库
│
├── prompts/                                # 评分/生成系统提示词
├── analysis/                               # 回测数据和结论
├── templates/                              # 内容模板（真实版本）
├── configs/                                # 生产环境配置
└── data/                                   # 历史数据
```

---

## 四、开源前改造清单

### Phase 1：清理与脱敏（1-2 天）

- [ ] **创建独立仓库** `square-agent`，不包含任何 API Key / Token
- [ ] **config 脱敏**：所有 `config.mjs` → `config.example.mjs`，key 用占位符
- [ ] **移除私有数据**：`data/`、`logs/`、`*.jsonl`、`*.db` 不进仓库
- [ ] **.gitignore**：`.env`、`data/`、`logs/`、`*.db`、`config.mjs`
- [ ] **移除分析文档**：`docs/news-*-analysis.md` 移到私有仓库
- [ ] **内置开源 prompt**：`prompts/` 目录放通用版 scoring + generation + templates（详见 `open-source/COMPARISON.md`）
- [ ] **prompt 加载机制**：pipeline 优先加载私有版，找不到则回退开源版（兼容两种部署）

### Phase 2：补全基础（2-3 天）

- [ ] **package.json**：name、description、bin（CLI）、exports
- [ ] **README.md**（英文）：
  - What（是什么）
  - Why（为什么不用 Postiz）
  - Quick Start（docker-compose up）
  - Architecture（架构图）
  - Contributing（欢迎 PR）
- [ ] **architecture.md**：系统架构图 + 模块说明
- [ ] **examples/**：4 个可运行示例
- [ ] **setup.mjs**：交互式配置（API Key、平台选择等）
- [ ] **CI**：GitHub Actions（lint + node --check）

### Phase 3：社区就绪（1-2 天）

- [ ] **CONTRIBUTING.md**：代码规范、PR 流程、Connector 开发指南
- [ ] **Issue 模板**：bug report + feature request
- [ ] **Discussion 区**：开启 GitHub Discussions
- [ ] **LICENSE**：AGPL-3.0 全文
- [ ] **GitHub Topics**：`crypto` `social-media` `automation` `binance` `ai-agent`
- [ ] **首批 Star**：自己的 GitHub profile + 朋友
- [ ] **技术博客**：基于 trader-pain-points.md + postiz-analysis.md 改写

---

## 五、README.md 结构（英文）

```markdown
# SquareAgent — Crypto Social Media Automation

> Schedule, generate, filter, and publish crypto content across Binance Square, X/Twitter, and Telegram — with built-in financial compliance.

## ✨ Features

- 🤖 **AI Content Generation** — News-triggered content engine (bring your own LLM)
- 🛡️ **Compliance Filter** — Banned words, risk disclaimers, jurisdiction routing
- 📡 **Multi-Platform** — Binance Square, X/Twitter, Telegram (extensible)
- ⏱️ **Smart Scheduler** — Randomized intervals, dedup, daily quotas
- 📋 **Approval Flow** — Auto / Review / Multi-step (trader → editor → compliance)
- 🏥 **Health Monitor** — Success rate tracking, failure alerts
- 🔌 **MCP Server** — Integrate with AI agents (OpenClaw, Claude, etc.)
- 🐳 **Docker Ready** — One command to run everything

## Quick Start

\`\`\`bash
git clone https://github.com/yourname/square-agent.git
cd square-agent
cp .env.example .env  # Fill in your API keys
docker-compose up -d
\`\`\`

## Architecture

[diagram]

## Extending

### Add a New Platform Connector

\`\`\`javascript
import { BaseConnector } from 'square-agent/src/connectors/base.mjs';

class MyConnector extends BaseConnector {
  constructor() {
    super();
    this.name = 'My Platform';
    this.platform = 'my-platform';
  }
  
  async publish(content, options) {
    // Your API call here
  }
}
\`\`\`

## License

AGPL-3.0 — Free for self-hosting. Commercial SaaS requires a license.
```

---

## 六、商业化路径

```
免费 (开源 AGPL-3.0)
├── 自托管全部功能
├── 社区支持 (GitHub Issues)
└── 适合：个人开发者、小团队
     ↓ 升级
付费云版 (SaaS, $29-99/月)
├── 免运维 + 自动更新
├── 合规审计日志
├── 优先支持
└── 适合：KOL、小型交易团队
     ↓ 升级
企业版 (Private, 联系销售)
├── 私有化部署
├── 自定义合规规则
├── SLA 保障
├── 培训 + onboarding
└── 适合：交易所、持牌机构
```

**关键原则**（学 Postiz）：社区版与云版功能无差异，付费靠"免运维 + 合规审计 + 企业 SLA"，不阉割开源版。

---

## 七、推广策略

| 渠道 | 内容 | 时机 |
|---|---|---|
| GitHub | README + Topics + Discussions | 开源当天 |
| Twitter/X | "Postiz for crypto — open source" | 开源当天 |
| Hacker News | Show HN: SquareAgent | 开源后 1 周 |
| Reddit r/CryptoCurrency | 痛点分析 + 解决方案 | 开源后 1 周 |
| v2ex /即刻 | 中文技术分享 | 开源后 2 周 |
| 技术博客 | "How to build a crypto content compliance layer" | 持续 |

---

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| 被用于诈骗项目（喊单/拉盘） | 合规过滤层是核心模块，默认启用；README 明确免责声明 |
| AGPL 被规避（SaaS 不分发） | 双许可：AGPL + Commercial License |
| 币安 API 变更 | Connector 抽象层隔离，社区可快速适配 |
| 合规词库过时 | 词库独立文件，社区可 PR 更新 |
| 国内法律风险 | README 标注"不含中国大陆辖区"，不做中文推广 |
| Alpha 泄露 | 评分 prompt/分析数据在私有仓库，不进开源代码 |

---

## 九、时间线

| 阶段 | 时间 | 交付 |
|---|---|---|
| Phase 1 清理脱敏 | 6/27-6/28 | 干净的开源仓库 |
| Phase 2 补全基础 | 6/29-7/1 | README + examples + CI |
| Phase 3 社区就绪 | 7/2-7/3 | CONTRIBUTING + Discussions |
| 🚀 开源发布 | 7/4 | GitHub Public + 首条推文 |
| 推广期 | 7/4-7/14 | HN + Reddit + 博客 |
| 首次社区反馈迭代 | 7/15+ | 根据反馈调整 |

---

_核心思路：借 Postiz 的"形"（open-core + 工程架构），造自己的"神"（合规 + 垂直内容）。开源是获客手段，不是核心壁垒。_
