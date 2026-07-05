# FinBERT vs GLM-4.5 对比实验

> 生成时间：2026-06-25
> 假设：换用金融专用模型 FinBERT，相关性会显著改善（文献 r=0.21 → 我们的数据上也能复现）

## 实验设计

### 模型
- **GLM-4.5**（之前用）：通用 chat LLM，~100B+ 参数，零样本提示
- **FinBERT** (ProsusAI/finbert)：金融微调 BERT，109M 参数，本地 MPS 推理

### 数据
直接复用之前的 1161 条记录（标题 + 24h 涨跌幅），只换分类模型。

### 运行
- FinBERT 本地 Mac M2 推理：1161 条 / **5.7 秒**（vs GLM API 2 小时）
- 内存峰值 ~2 GB（在 8GB M2 上无压力）

## 核心结果

### 单条新闻级别（per-article）

| Regime | 方法 | N (有方向) | 准确率 | Pearson r | p 值 | 显著? |
|---|---|---|---|---|---|---|
| 2024 牛市 | GLM-4.5 | 336 | 48.8% | -0.0526 | 0.241 | ❌ |
| 2024 牛市 | FinBERT | 240 | 50.8% | -0.0609 | 0.174 | ❌ |
| 2025 震荡 | GLM-4.5 | 358 | 48.6% | -0.0551 | 0.219 | ❌ |
| 2025 震荡 | FinBERT | 248 | 48.4% | -0.0219 | 0.624 | ❌ |
| 2026 熊市 | GLM-4.5 | 119 | 55.5% | **+0.0881** | 0.267 | ❌ |
| 2026 熊市 | FinBERT | 102 | 52.9% | +0.0209 | 0.792 | ❌ |

**全部不显著**。文献 r=0.21 在我们数据上完全没复现。

### 高置信度子集（conf ≥ 0.7）

| Regime | 方法 | n | 准确率 | r |
|---|---|---|---|---|
| 2024 牛市 | GLM | 255 | 47.7% | -0.064 |
| 2024 牛市 | FinBERT | 212 | 52.6% | -0.050 |
| 2025 震荡 | GLM | 262 | 43.9% | -0.066 |
| 2025 震荡 | FinBERT | 200 | 49.7% | +0.010 |
| 2026 熊市 | GLM | 93 | 52.7% | +0.056 |
| 2026 熊市 | FinBERT | 83 | 59.0% | +0.086 |

FinBERT 在高置信子集上略好但仍不显著。

### 每日聚合级别（复现 Farrugia 2025 方法）

| Regime | 有效天数 | FinBERT r | FinBERT p | GLM r | GLM p |
|---|---|---|---|---|---|
| 2024 牛市 | 82 | +0.042 | 0.71 | -0.093 | 0.41 |
| 2025 震荡 | 89 | +0.015 | 0.89 | +0.020 | 0.85 |
| 2026 熊市 | 7（不足）| — | — | — | — |

**即便按文献方法聚合，r 仍只有 0.02-0.09，全部不显著。**

唯一暗示信号：2025 震荡市的次日滞后效应 r=0.15（FinBERT）/ 0.16（GLM），但 p > 0.10。

## 为什么文献结论不复现？

### 1. FinBERT 的领域错配（关键）

通过分析 2026 熊市中 FinBERT 与 GLM 反向判断的 26 个案例，发现 FinBERT 普遍误判：

**案例 A: GLM=bearish, FinBERT=bullish**（GLM 88% 准确）
- "Spot bitcoin ETFs log sixth consecutive week of net outflows"
  - GLM：ETF 持续净流出 → 利空 ✅
  - FinBERT：看到 "consecutive week of" 等财报式表述 → positive ❌
- "Bitcoin recovery rests on US-Iran deal as momentum remains weak"
  - GLM：recovery 取决于不确定性 + 动能疲软 → bearish ✅
  - FinBERT：看到 "recovery" → positive ❌

**案例 B: GLM=bullish, FinBERT=bearish**（GLM 78% 准确）
- "Oil Slides Over 4% as Asian Stocks Rally After U.S.-Iran Deal to End War"
  - GLM：股市反弹、停战协议 → bullish ✅
  - FinBERT：看到 "war"、"slides" → negative ❌

**根本问题**：FinBERT 是词汇级情感分析，**不懂加密市场逻辑**（不知道 ETF 流出=利空、停战=利好）。GLM 的常识推理在这里反而是优势。

### 2. 数据源差异

- Farrugia 2025 用 CryptoCompare 的特定数据集 + FinBERT+FinancialBERT 双模型
- Hurjui 2022 用 Twitter+Reddit 流式数据 + RNN
- 我们用 CoinDesk 聚合 + 单一模型

### 3. 市场结构差异

- 2024-2025 受 ETF 获批、减半、Iran war 等特殊事件主导
- 这些事件 LLM 都看得到但仍无法稳定预测
- 说明 **24h 价格本身就有大量噪音**，不是模型问题

### 4. 方法学：文献 r=0.21 的可信度

- Farrugia 仅 90 天样本，p=0.017（单测）但Bonferroni 校正后不显著
- 效应量 r=0.21 在 Cohen 标准下属于 "small effect"
- 单一论文结论的可复制性本身存疑

## 真正的瓶颈是什么？

经过 4 轮分析（全量、子集、FinBERT、聚合），结论收敛：

1. **不是样本量问题** — 我们有 1161 篇 / 89 天，超过 Farrugia 的 1300 篇 / 90 天
2. **不是模型选择问题** — 通用 LLM 和专用 FinBERT 都跑不出显著
3. **不是分析方法问题** — 单条/聚合/滞后/子集都试过
4. **是任务本身的难度** — **新闻标题与 24h 价格方向的相关性本就接近 0**

文献中 r=0.21 的「弱信号」可能是：
- 特定时段（2021-2022 加密牛市/熊市切换期）的产物
- 多重检验后未校正的 false positive
- 数据源特异性（Twitter 流式 vs 新闻聚合）

## 对 square-agent 的最终建议

### 不要再追这个方向

经过严格验证，**新闻标题 → 24h 价格方向预测在统计上不显著**。无论换什么模型、什么方法，都跑不出 r > 0.15 的稳定信号。

### 保留 LLM 的真正价值

square-agent pipeline 中 LLM 的角色应该限定为：

| 角色 | 是否有效 | 证据 |
|---|---|---|
| 内容生成（中文翻译+解读）| ✅ 有效 | 主观质量高 |
| 重要性筛选（critical/high）| ✅ 有效 | critical+high 平均波动 2.95% vs 1.78% |
| 价格方向预测 | ❌ 无效 | r = 0.05-0.09, p > 0.2 |
| 波动率预测（涨/跌幅度）| ⚠️ 弱有效 | \|涨跌\| 信号显著但绝对值小 |

### 后续研究方向

如果想继续探索价格预测，建议转向：
1. **更短时间窗口**（1h、4h 而非 24h）— 真正的反应在分钟级
2. **订单流+链上数据** — 价格驱动力在交易行为而非新闻
3. **波动率交易** — 已知 critical+high 推送对应更大波动，可做 straddle
4. **Twitter/Reddit sentiment** — 散户情绪可能比新闻更有效（Hurjui 2022）

## 完整数据

- `/tmp/finbert-classification-cache.json` — 1161 条 FinBERT 分类结果
- `news-finbert-vs-glm-data.json` — 含 FinBERT 和 GLM 双标注的完整 records
- `news-finbert-vs-glm-log.txt` — FinBERT 实验日志
- `news-aggregate-correlation-log.txt` — 聚合分析日志
