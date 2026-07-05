# SquareAgent 架构改造方案

> 基于 `trader-pain-points.md`（交易员痛点）和 `postiz-analysis.md`（Postiz 借鉴分析）制定

---

## 一、改造原则

1. **不重构现有可用模块** — news-pipeline、publisher、bot 已跑通，改造做增量不做替换
2. **合规优先** — 金融合规过滤层从 MVP 就做，不是后置
3. **Connector 抽象先行** — 后续每新增一个平台只需实现统一接口
4. **开源/闭源分层** — 框架开源，策略闭源

## 二、现状 vs 目标

| 维度 | 现状 | 目标 |
|---|---|---|
| 发布平台 | 仅币安广场 API | Connector 抽象：币安广场 + X + Telegram Channel |
| 合规过滤 | 无（仅加免责声明） | 禁用词库 + 风险提示注入 + 辖区路由 |
| 审批流 | auto/manual 二选一 | 三角色：交易员 → 运营 → 合规（可配置） |
| 发布调度 | 固定间隔 5 分钟 | 随机化间隔 + 窗口避让 + 账号健康度检测 |
| 生态嵌入 | 无 | MCP Server + CLI + Webhook |
| 部署 | 手动 node 进程 + launchd | Docker Compose 一键部署 |
| 监控 | publisher 日志 | 账号健康度仪表盘（浏览/互动/shadowban 检测） |

## 三、模块改造清单（按优先级）

### P0：金融合规过滤层（第 1 周）

**痛点映射**：合规红线约束 → 真实观点无法直接表达 → 内容"安全但无趣" 或 踩红线被封

**改造内容**：

```
square-agent/
└── src/
    └── compliance/
        ├── index.mjs          # 合规过滤入口（pipeline 后处理）
        ├── banned-words.mjs    # 禁用词库
        ├── risk-disclaimer.mjs # 风险提示自动注入
        └── jurisdiction.mjs    # 辖区路由（按账号注册地切换内容版本）
```

**禁用词库规则**：
- 绝对禁止：保本、稳赚、翻倍、内部消息、百分百、零风险
- 条件禁止（需加风险提示）：荐币、目标价、止损位、跟单
- 平台差异：币安广场对"合约""杠杆"类内容有额外审核

**实现位置**：`content-engine.mjs` 的 `applyComplianceFilter()` 已有骨架，扩展即可

**接入点**：news-pipeline `interpretNews()` 返回前 + publisher `postToSquare()` 发帖前

---

### P1：Connector 抽象层（第 2-3 周）

**痛点映射**：多平台风控限流 → 需要多账号矩阵分发 → 当前只支持币安广场

**改造内容**：

```
square-agent/
└── src/
    └── connectors/
        ├── base.mjs            # 统一接口定义
        ├── binance-square.mjs  # 币安广场（现有 API 逻辑迁入）
        ├── x-twitter.mjs       # X/Twitter（OAuth + API v2）
        ├── telegram-channel.mjs # Telegram Channel（Bot API）
        └── registry.mjs        # Connector 注册与路由
```

**统一接口**：
```javascript
class BaseConnector {
  async publish(content, options) {}    // 发布
  async delete(postId) {}               // 删除
  async getStats(postId) {}             // 获取互动数据
  async checkHealth() {}                // 账号健康度
  get capabilities() {}                 // 支持的能力（图片/视频/投票/长文）
}
```

**币安广场 Connector**：从现有 `agent.mjs` 的 `postToSquare()` 迁移，增加图片上传

**X Connector**：复用现有 `square-agent-x/` 的 OAuth 逻辑，封装为统一接口

**Telegram Channel Connector**：用 Bot API 发长文+图片，作为备用发布渠道

---

### P2：发布调度引擎升级（第 3 周）

**痛点映射**：发布间隔固定 → 被平台识别为机器行为 → shadowban/限流

**改造内容**：

在 `publisher/agent.mjs` 中：

1. **间隔随机化**：POST_INTERVAL 从固定 5 分钟 → 5-12 分钟随机
2. **窗口避让**：避开凌晨 2-5 点发帖（低流量+可疑时段）
3. **内容去重增强**：标题相似度 >60% 的帖子自动推迟到次日
4. **每日上限动态调整**：根据近 7 天互动率自动调整（互动率高→加量，低→减量）

```javascript
// 伪代码
function getPostInterval() {
  const base = 5 * 60 * 1000;  // 5 分钟
  const jitter = Math.random() * 7 * 60 * 1000;  // 0-7 分钟随机
  return base + jitter;
}
```

---

### P3：多角色审批流（第 4 周）

**痛点映射**：auto/manual 二选一不够灵活 → 需要交易员出判断、运营改文案、合规做预审

**改造内容**：

在 `square-agent-server` 中新增审批流模块：

```
审批流模式（可配置）：
1. auto          — 自动发布（当前行为，低风险内容）
2. review        — 人工审核（TG 按钮确认，当前行为）
3. multi-step    — 多级审批：
                   AI生成 → 合规预审 → 运营编辑 → 交易员确认 → 发布
```

**实现**：
- `posts` 表新增 `approval_status` 字段：pending → compliance_ok → editor_ok → published
- 每个状态变更有 TG 通知 + 按钮
- 可按内容类型配置流程（新闻快讯=auto，深度分析=multi-step）

---

### P4：账号健康度监控（第 5 周）

**痛点映射**：X/Twitter shadowban → 账号被悄悄限流 → 流量下滑不自知

**改造内容**：

```
square-agent/
└── src/
    └── monitor/
        ├── health-check.mjs     # 定期检测账号状态
        ├── shadowban-check.mjs  # X shadowban 检测
        └── stats-tracker.mjs    # 互动数据追踪
```

**检测项**：
- 币安广场：创作者中心浏览量采集（修复现有 Peekaboo 脚本）
- X：用无痕模式检查帖子是否可见（shadowban 检测）
- 互动率预警：连续 3 天平均浏览量下降 >50% → TG 通知

---

### P5：生态嵌入（第 6 周）

**痛点映射**：交易员已有 n8n/Make 自动化工作流 → 需要嵌入而非替换

**改造内容**：

1. **MCP Server**：把 square-agent 的核心能力暴露为 MCP 工具
   - `publish_post` — 发布帖子
   - `generate_content` — 生成内容
   - `get_stats` — 获取互动数据
   - `manage_schedule` — 管理定时任务

2. **Webhook**：内容生成/发布/互动事件推送到外部系统

3. **CLI 工具**：`square-agent publish --text "..." --platform binance,x,telegram`

---

### P6：Docker 部署（第 7 周）

**改造内容**：

```yaml
# docker-compose.yml
services:
  server:
    build: .
    ports: ["5577:5577"]
    volumes: ["./data:/app/data"]
    environment:
      - GLM_API_KEY=${GLM_API_KEY}
  
  pipeline:
    build: .
    command: node news-pipeline/pipeline.mjs --watch
    environment:
      - GLM_API_KEY=${GLM_API_KEY}
  
  bot:
    build: .
    command: node square-agent-bot/dist/bot.js
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
  
  publisher:
    build: .
    command: node agent.mjs
    environment:
      - BINANCE_SQUARE_OPENAPI_KEY=${BINANCE_SQUARE_OPENAPI_KEY}
```

---

## 四、开源/闭源分层

| 模块 | 开源/闭源 | 理由 |
|---|---|---|
| Connector 抽象框架 | 🟢 开源 (AGPL-3.0) | 工程框架，不含 alpha |
| 币安广场/X/Telegram Connector | 🟢 开源 | 平台对接代码，无策略价值 |
| 新闻采集管道（RSS→去重→评分） | 🟢 开源 | 工程能力，不含策略 |
| 多模板内容引擎框架 | 🟢 开源 | 模板骨架开放，具体模板可私有 |
| 合规过滤层 | 🟢 开源 | 合规是行业刚需，开源增加信任 |
| 调度引擎（Temporal/randomization） | 🟢 开源 | 通用调度，无策略 |
| Docker 部署 + MCP/CLI | 🟢 开源 | 降低社区使用门槛 |
| **新闻评分模型与阈值** | 🔴 闭源 | 策略 alpha（r=0.23 的信号） |
| **4h 涨跌预测逻辑** | 🔴 闭源 | 核心策略，论文已证明有信号 |
| **多币种轮动优先级** | 🔴 闭源 | SOL > ETH > BTC 的 alpha |
| **具体模板内容与爆款公式** | 🟡 可选 | 差异化内容能力，先闭源后开放 |

## 五、实施路径（7 周计划）

| 周次 | 交付物 | 验证标准 |
|---|---|---|
| W1 | 合规过滤层 | 禁用词拦截率 100%，风险提示自动注入 |
| W2 | Connector 抽象 + 币安广场迁移 | 发帖行为不变，代码通过统一接口 |
| W3 | X + Telegram Connector + 调度升级 | 一条内容三端分发成功 |
| W4 | 多角色审批流 | 多级审批 TG 流程跑通 |
| W5 | 账号健康度监控 | 浏览量+shadowban 检测报告 |
| W6 | MCP Server + CLI | 外部系统能调用 publish/generate |
| W7 | Docker Compose + 文档 | `docker-compose up` 一键启动 |

## 六、与 Postiz 的差异化定位

```
Postiz = 通用社媒管理工具（25+ 平台，无合规过滤，无行情数据）
     ↑
     | 借鉴工程骨架
     |
SquareAgent = 加密垂直营销智能体
     ↓
     深化差异
     ↓
核心壁垒 = 金融合规过滤 + 行情/链上数据管线 + 4h预测信号 + 多币种策略
```

**一句话总结**：借 Postiz 的"形"（工程架构+开源模式+Connector 设计），造自己的"神"（合规+垂直内容+交易信号）。
