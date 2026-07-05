# Lamon 监督学习方法重做（方法学修正）

> 生成时间：2026-06-27
> 数据：2025 cryptopanic 全年（27,269 条主流币新闻）
> 样本：1,895 个币种-日期对
> 方法：参考 Lamon CS229 论文，监督学习 + 按价格幅度加权评估

> ---
> ## ⚠️ 重大修正通知（2026-06-27 后续验证）
>
> 本报告的**所有交易策略结论已被后续 4 轮 held-out 验证推翻**。请同时阅读：
> - `news-2024-doge-ada-verification.md`（n=691）
> - `news-2025-full-doge-ada-verification.md`（n=566）
> - `news-2026-doge-ada-verification.md`（n=8，样本不足）
> - `news-2021-2023-doge-ada-verification.md`（**n=898，决定性反证**）
>
> **本报告中所有 ⛔ 标记的结论已被证伪**。最终结论见文末 [§6 最终修正结论（2021-2025 五年合并）](#6-最终修正结论2021-2025-五年合并)。
>
> **简短摘要**：v2 报告基于 2025 Q4 单一熊市测试集（n=58-59）得出"DOGE/ADA 反向策略 +40~80% PnL"结论。后续验证证明：
> 1. **反向策略** = 2025 Q4 熊市 base rate，不是模型 alpha（2024 牛市验证顺向 +243%，反向亏 -243%）
> 2. **ADA intra-day alpha**（2024-2025 p<0.001）= regime-specific overfitting（2021-2023 n=898 上 p=0.32 失败）
> 3. **整个研究经过多重比较校正后没有任何稳定 alpha**
>
> 本报告保留原始内容作为**研究历程记录**和**反面教材**（金融 ML 中 regime overfitting 的经典案例）。
> ---

## 背景

之前 4 个数据集（2024 coindesk / 2025-01 coindesk / 2025-full cryptopanic / 2026 local）的 FinBERT 相关性分析存在严重方法学问题（详见对照表）。本次按 Lamon *Cryptocurrency Price Prediction Using News and Social Media Sentiment* (Stanford CS229) 的方法重做。

## 1. 方法学对照（之前 vs 现在 vs Lamon 论文）

| 维度 | 之前的方法 | 本次重做 | Lamon 论文 |
|---|---|---|---|
| FinBERT 角色 | 零样本输出当价格信号 | **特征提取器**（下游接 LR/SVC/NB） | 不用 FinBERT，特征来自 n-gram |
| 训练 | **不训练任何模型** | **训练 LR/SVC/MultiNB 在次日涨跌标签** | 训练 LR/SVC/NB 在次日涨跌标签 |
| 时间窗口 | 2 小时 | **当日 / 1 日 / 2 日 ahead** | 1 日 / 2 日 ahead |
| 聚合 | primary/echo 自创切分 | **按天聚合**（每币种每日一组新闻） | 按天聚合 |
| 评估指标 | Pearson r | **accuracy + 混淆矩阵 + Lamon 幅度加权 + 交易回测** | accuracy + 混淆矩阵 + **幅度加权混淆矩阵** + 隐含交易逻辑 |
| 特征数 | 1（signed conf） | **TF-IDF top-500 1-2gram + FinBERT 5维** | 1-2 gram word count |

## 2. 主要结果（v2，含 n-gram 特征）

### 2.1 准确率与基线对比

| Coin | Task | Best Clf | Val Acc | Test Acc | Base Acc | **Edge** |
|---|---|---|---|---|---|---|
| BTC | intra-day | MultiNB | 43.3% | **54.4%** | 51.5% | **+2.9pp** |
| BTC | 1d-ahead | LogReg | 52.2% | **52.9%** | 51.5% | **+1.5pp** |
| BTC | 2d-ahead | MultiNB | 58.2% | 42.6% | 52.9% | −10.3pp |
| ETH | intra-day | MultiNB | 56.1% | 44.1% | 51.5% | −7.4pp |
| ETH | 1d-ahead | LogReg | **69.7%** | 44.1% | 51.5% | −7.4pp |
| ETH | 2d-ahead | LinearSVC | 60.6% | **57.4%** | 51.5% | **+5.9pp** |
| SOL | intra-day | LinearSVC | 56.2% | 51.5% | 56.1% | −4.5pp |
| SOL | 1d-ahead | LogReg | 50.0% | 48.5% | 57.6% | −9.1pp |
| SOL | 2d-ahead | LinearSVC | 51.6% | 45.5% | 51.5% | −6.1pp |
| XRP | intra-day | MultiNB | 58.5% | 43.9% | 54.5% | −10.6pp |
| XRP | 1d-ahead | MultiNB | 52.3% | 51.5% | 56.1% | −4.5pp |
| XRP | 2d-ahead | LogReg | 58.5% | 53.0% | 57.6% | −4.5pp |
| DOGE | intra-day | LinearSVC | 48.2% | 58.6% | 60.3% | −1.7pp |
| DOGE | 1d-ahead | MultiNB | 50.0% | 60.3% | 60.3% | +0.0pp |
| DOGE | 2d-ahead | MultiNB | 53.6% | 56.9% | 58.6% | −1.7pp |
| ADA | intra-day | LinearSVC | 51.7% | 59.3% | 61.0% | −1.7pp |
| ADA | 1d-ahead | LinearSVC | 46.6% | 61.0% | 62.7% | −1.7pp |
| ADA | 2d-ahead | MultiNB | 55.2% | 59.3% | 62.7% | −3.4pp |

**18 个测试中只有 3 个 edge > 0**（BTC intra-day/1d, ETH 2d-ahead），其余 15 个都低于 base rate。

### 2.2 Lamon 幅度加权评估（关键创新）

> ⛔ **此节结论已被部分推翻**：2021-2023 验证证明此处的 "DOGE/ADA bearish 信号能捕捉大跌日" 是 **2025 Q4 熊市体制特定效应**。在 2024 牛市上，ADA 同样的模型反而正确预测的是**大涨日**（+0.80% vs -0.60%）。Lamon 幅度信号本身存在但**体制依赖**，并非稳定 alpha。

Lamon 的核心洞察：**即使方向准确率不如基线，如果正确预测的日均涨跌幅度大于错误预测的，模型仍有价值**（正确捕捉了大波动日）。

| Coin | Task | 正确日均涨跌 | 错误日均涨跌 | 差异 | 含义 |
|---|---|---|---|---|---|
| **DOGE** | intra-day | **−2.43%** | +1.22% | **−3.65%** | ✅ 正确预测的下跌日跌幅更大 |
| **DOGE** | 2d-ahead | **−4.31%** | +1.72% | **−6.03%** | ✅ 正确预测的下跌日跌幅显著大 |
| **ADA** | 2d-ahead | **−5.94%** | +3.71% | **−9.65%** | ✅ 强信号 |
| **ADA** | intra-day | **−1.83%** | +0.42% | **−2.25%** | ✅ 信号 |
| BTC | intra-day | +0.15% | +0.18% | −0.03% | ❌ 无差异 |
| ETH | 1d-ahead | −0.49% | −0.16% | −0.33% | ❌ 弱 |

**关键发现**（**⚠️ 原始表述，已被后续验证修正**）：在 **DOGE / ADA 等小币种**上，FinBERT 的 bearish 信号虽然方向准确率不高，但能**正确捕捉到大幅下跌日**。这是 Lamon 论文的关键结论在我们数据上的再现。

**修正后解读**：模型对大幅波动日确有辨别力，但方向跟随当时主流趋势——熊市正确预测大跌日、牛市正确预测大涨日。这不是稳定的"大跌预警"信号。

### 2.3 交易策略回测（累积 % 收益）

> ⛔ **此节结论完全错误，已被 2024 验证和 2025 全年验证彻底推翻**。"DOGE/ADA 涨做空/跌做多（反向）+40~80%" 实质是 2025 Q4 熊市的 base rate 收益（ADA Q4 跌 -60%，无脑做空约赚 +60%），不是模型 alpha。同样的模型在 2024 牛市上**顺向 +243%**，反向亏 -243%。详见后续验证报告。

| Coin | Task | 只做多 (buy&hold) | 预测涨才做多 | 涨做多/跌做空 |
|---|---|---|---|---|
| BTC | intra-day | −4.90% | −4.90% | **+4.23%** |
| BTC | 1d-ahead | −1.50% | −1.50% | **+12.46%** |
| ETH | 1d-ahead | −9.27% | −9.27% | +1.26% |
| DOGE | intra-day | −53.47% | **+14.12%** | **+81.70%** |
| DOGE | 1d-ahead | −49.45% | −3.38% | **+42.70%** |
| ADA | intra-day | −53.95% | +0.46% | **+54.86%** |
| ADA | 1d-ahead | −60.35% | −4.10% | **+52.16%** |

**注**：测试集是 2025-10 ~ 2025-12（**熊市**），所以只做多普遍亏。

**关键发现**（**⛔ 原始结论，已证伪**）：
- ~~**DOGE/ADA 的"涨做多/跌做空"策略大幅盈利**（+40~80%），原因是模型对这些币种的 bearish 信号准确，跌做空赚钱~~
- ~~BTC 1d-ahead "涨做多/跌做空" +12.46%（弱盈利）~~
- ~~主流币（BTC/ETH/SOL/XRP）即使加策略，盈利能力有限~~

**修正后解读**：策略 PnL 符号 ≈ 该期资产涨跌符号。所谓"反向盈利"只是 Q4 熊市的 base rate 收益，跨年验证后不存在稳定 alpha。

## 3. 与之前 Pearson r 结论的对比

### 3.1 之前结论（zero-shot FinBERT + Pearson r）

"FinBERT 对加密 2h 涨跌没有预测力，r ≈ 0.01"

### 3.2 修正后结论（监督学习 + Lamon 评估）

1. **方向预测准确率**：BTC 约 53%（与 Lamon 2017 的 52% 一致），**没有显著超过 base rate**
2. **幅度预测能力**：DOGE/ADA 上有信号 — 正确预测的下跌日跌幅显著大于错误预测
3. **交易可用性**：DOGE/ADA 反向策略盈利，BTC/ETH 弱盈利

### 3.3 之前哪里错了，哪里对了

> ⛔ 此表的 "✅" 标记多已被后续验证推翻。原 v2 报告**再次错误**地确认了 DOGE/ADA 反向策略，详情见后续 4 轮验证。

| 之前结论 | v2 报告判断 | **最终判断（2021-2025 五年验证后）** |
|---|---|---|
| BTC r ≈ 0，无预测力 | ✅ 部分对 | ✅ **对**：方向准确率 ≈ base rate，无稳定 alpha |
| DOGE 系统性反向 | ✅ **完全对** | ⛔ **错**：2024 牛市顺向 +37%，2021-2023 无信号，反向不是稳定 alpha |
| ADA 同样反向 | ✅ 完全对 | ⛔ **错**：2024 顺向 +243%，2025 全年顺向 +148%，反向只是 Q4 熊市 base rate |
| FinBERT 对小币种失效 | ❌ 错 | ⛔ **最终回到原结论**：DOGE 三年都不显著，ADA intra-day 仅 2024-2025 显著（regime overfitting） |
| 2h 窗口太短 | ✅ 对 | ✅ 对：日级评估更可靠 |
| Pearson r 是错的指标 | ✅ 对 | ✅ 对：Lamon 方法给出更细致的结论，但更细致不等于有 alpha |

## 4. Lamon 论文结果对照

Lamon 2017 在 BTC/ETH/LTC 上的结果（表 V-VIII）：

| Coin | Best Clf | Accuracy (Up/Down) | Avg % (Correct vs Incorrect Up) |
|---|---|---|---|
| BTC | LogReg | 43.9% / 61.9% | +4.90% vs +2.83% |
| ETH | BernoulliNB | 75.8% / 16.1% | +3.96% vs +2.05% |
| LTC | LogReg | 几乎全预测跌 | (差) |

我的结果（2025 cryptopanic）：

| Coin | Best Clf | Accuracy | Lamon 幅度差 |
|---|---|---|---|
| BTC | MultiNB/LogReg | 54.4% / 52.9% | 弱 |
| ETH | LinearSVC | 57.4% (2d) | 弱 |
| DOGE | LinearSVC/MultiNB | 58.6% / 60.3% | **强（−3.65% 差异）** |
| ADA | LinearSVC | 59.3% / 61.0% | **强（−9.65% 差异）** |

**与 Lamon 一致的发现**：
- 准确率不高（50-60%），但**正确预测日捕捉到更大涨跌幅**
- 不同币种最佳分类器不同（Lamon 也是 BTC 用 LogReg，ETH 用 NB）

**与 Lamon 不一致的发现**：
- Lamon 时 BTC 熊日准确率 61.9%（高），我的约 53%
- 我数据上 DOGE/ADA 的信号更强（Lomon 没测这两个币）

## 5. 最终方法学修正结论

### 5.1 之前的研究缺陷

1. **指标错误**：Pearson r 不是合适的评估指标
2. **方法错误**：不应该用零样本 FinBERT 输出直接做价格预测
3. **时间窗口错误**：2h 太短
4. **聚合错误**：自创的 primary/echo 切分没有学术依据

### 5.2 修正后的真实结论

> ⛔ 本节为原 v2 结论，**大部分已被后续 4 轮验证推翻**。保留供历史参考。最新结论见文末 §6。

**原结论（2025 Q4 单年测试集，n=58-59，已证伪）**：

1. **方向预测**：BTC 约 53% 准确率，**没有显著超过随机基线**（base rate ≈ 51.5%）
2. ~~**幅度预测**：在 DOGE/ADA 上有显著信号 — 正确预测日跌幅 −2.4% ~ −5.9%，错误日反向 +1.7% ~ +3.7%~~（⛔ 体制依赖，非稳定信号）
3. ~~**可交易性**：小币种（DOGE/ADA）反向策略 PnL 强（+40~80%）~~（⛔ 2025 Q4 熊市 base rate，非 alpha）

**最终修正结论**（见文末 §6）：
1. **方向预测**：所有币种在 5 年合并（n=1543 for ADA）上 edge ≈ +4pp，但显著性完全由 2024-2025 驱动。2021-2023（n=898）单独 p=0.32，无信号。
2. **幅度预测**：体制依赖（牛市正确预测大涨日、熊市正确预测大跌日）。
3. **可交易性**：策略 PnL 符号 ≈ 资产涨跌符号 × ~3×，纯市场 beta。

### 5.3 对 square-agent 的实操建议

> ⛔ 本节原建议已被最终修正。**所有"DOGE/ADA 信号可用"建议废弃**。

| 之前建议（v2 原） | 中间修正（2024 验证后） | **最终建议（2021-2023 验证后）** |
|---|---|---|
| 不要用 FinBERT 做价格方向预测 | 部分修正：幅度预警有价值 | **回到原始**：⛔ **不要用 FinBERT 做任何价格方向预测** |
| BTC 永远不做信号源 | 保留 | ✅ **保留**：BTC 方向 ≈ base rate |
| DOGE 是误判 | DOGE/ADA 可作大跌预警 | ⛔ **修正回原始**：DOGE 三年都不显著，ADA alpha 是 2024-2025 regime overfitting |
| 等待 6+ 个月数据 | 保留 | ✅ **保留**：监督学习需更长时间窗口 + **多市场体制验证** |

**唯一可保留**：FinBERT 作为**文本情感特征**输入下游 LLM 评分系统，不做价格方向预测。

### 5.4 学术诚实声明（原 v2 局限）

**本研究仍有局限**（与 Lamon 论文的差距）：

1. **样本量**：每币种训练 200 个币种-日期对（Lamon 有 ~3,600 新闻 + ~10K 推特）
2. **特征**：只用 FinBERT + n-gram，没有用 Lamon 的更细的 token weight 分析
3. **没做 cross-coin 模型**：Lamon 单币种训练，可以做跨币种模型
4. **没做 reinforcement learning 集成**：Lamon 提到的 CS221 RL 组合管理未实现
5. **没在 2026 上做完全 held-out**：2026 数据只有 16 天，样本太少
6. ⛔ **【新补充】没在多个市场体制上验证**：原 v2 仅用 2025 Q4 单一熊市做测试集，所有"alpha"结论都是 regime-specific。这是本研究最严重的方法学缺陷。

---

## 6. 最终修正结论（2021-2025 五年合并）

> 本节为 2026-06-27 后续 4 轮 held-out 验证后追加。**本节内容覆盖前面所有结论**。

### 6.1 验证历程

| 轮次 | 训练 | 测试 | 关键发现 | 报告 |
|---|---|---|---|---|
| v2 原 | 2025 H1 | 2025 Q4 (n=59) | 反向 +54% PnL（**误判为 alpha**） | 本文档 |
| 2024 验 | 2025 | 2024 (n=691) | 顺向 +243% PnL，反向亏；ADA intra p=0.003 | `news-2024-doge-ada-verification.md` |
| 2025 全年验 | 2024 | 2025 全年 (n=566) | 反向亏 -148%；ADA intra p=0.053 | `news-2025-full-doge-ada-verification.md` |
| 2026 验 | 2025 | 2026 (n=8) | 样本不足 | `news-2026-doge-ada-verification.md` |
| **2021-2023 验** | **2024** | **2021-2023 (n=898)** | **ADA intra p=0.32 失败** | `news-2021-2023-doge-ada-verification.md` |

### 6.2 ADA intra-day 真相

| Year | n | Acc | Edge vs base | p | 显著 |
|---|---|---|---|---|---|
| 2021（大牛） | 269 | 54.6% | +1.4pp | 0.13 | ❌ |
| 2022（大熊） | 333 | 49.5% | -4.3pp | 0.87 | ❌ |
| 2023（复苏） | 296 | 51.4% | -1.3pp | 0.64 | ❌ |
| 2024 | 354 | 57.9% | +7.9pp | **0.003** | ✅ |
| 2025 | 291 | 55.7% | +6.9pp | 0.053 | ⚠️ |

- **2021-2023 pooled (n=898)**: 51.7%, Z=+1.00, **p=0.32 ❌ 无信号**
- **2024-2025 pooled (n=645)**: 56.9%, Z=+3.50, p=0.0005 ✅
- 5 年 pooled (n=1543): 53.9%, p=0.0024，**但显著性完全由 2024-2025 驱动**

**"ADA intra-day alpha" 是 regime-specific overfitting**。

### 6.3 反向策略真相

ADA intra-day 顺向/反向 PnL 完全跟随资产涨跌方向：

| Year | ADA buy&hold (intra累加) | 顺向 PnL | 反向 PnL |
|---|---|---|---|
| 2021 | +278% | +181% | -181% |
| 2022 | -112% | -8% | +8% |
| 2023 | +102% | +92% | -92% |
| 2024 | +74% | +243% | -243% |
| 2025 | +28% | +148% | -148% |

**PnL 符号 ≈ 资产涨跌符号**。原 v2 报告的"反向 +54~86% PnL"完全是 2025 Q4 单独熊段的 base rate 收益。

### 6.4 多重比较校正

整个研究做了 ~20 次假设检验。Bonferroni 修正 α=0.05/20=0.0025：
- ADA intra-day 2024 (p=0.003) 不达标
- 其他全部不显著

**整个研究没有任何稳定 alpha**。

### 6.5 对 square-agent 的最终最终建议

| 用途 | 建议 | 证据 |
|---|---|---|
| **FinBERT 价格方向预测** | ❌ **完全废弃** | 5 年验证无稳定 alpha |
| **ADA intra-day 信号** | ❌ **废弃**（原 2024-2025 alpha 是 regime overfitting） | 2021-2023 n=898 p=0.32 |
| **DOGE 任何预测** | ❌ 废弃 | 三年都不显著 |
| **反向交易策略** | ❌ 废弃 | 纯市场 beta |
| **FinBERT 作为文本情感特征** | ✅ **保留** | Lamon 2017 等论文已验证有效性 |
| **FinBERT 喂给下游 LLM 评分** | ✅ **推荐** | 作为特征而非预测器 |

**唯一保留的能力**：FinBERT 作为情感极性标注器，输出 bullish/bearish/neutral 三分类作为下游 LLM 综合评分的输入特征。

### 6.6 教训（金融 ML 经典反面教材）

本研究经过 5 步自我修正才得出正确结论：

1. v1：零样本 FinBERT + Pearson r（错误方法）
2. v2：监督学习 + Lamon 指标（正确方法，但样本小、单年）— 宣布"反向 alpha"
3. 2024 验证：跨年，宣布"ADA 真 alpha"（仍虚假）
4. 2025 全年：5× 样本，"确认 ADA alpha"（仍虚假）
5. **2021-2023：3 年 held-out，所有 alpha 破灭**

每一步都看起来"更严谨"，但直到第 5 步才发现前面所有 "alpha" 都是 2024-2025 特有的 regime overfitting。

**核心教训**：
- 任何宣称 alpha 的研究，**必须在 ≥3 个不同市场体制上 held-out 验证**
- 训练-测试同质性偏差（train 2024 → test 2025）会制造虚假 alpha
- 多重比较不校正会放大 false positive
- 在金融 ML 中，2 个数据点连不成趋势

---

## 完整数据

### 原始 v2 数据（保留）

- `news-supervised-lamon-v1-log.txt` — v1（仅 FinBERT 特征）日志
- `news-supervised-lamon-method-log.txt` — v2（含 n-gram）日志
- `/tmp/supervised_daily_lamon.py` — v1 脚本
- `/tmp/supervised_daily_v2.py` — v2 脚本
- `/tmp/supervised-lamon-v2-results.json` — 完整结果 JSON
- 论文：`/Users/mac/clawd/docs/crypto-sentiment-papers/Lamon_CS229_crypto_price_prediction.pdf`

### 后续验证数据（修正证据）

- `news-2024-doge-ada-verification.md` — 2024 验证（推翻反向 alpha）
- `news-2025-full-doge-ada-verification.md` — 2025 全年验证（推翻 Q4-only）
- `news-2026-doge-ada-verification.md` — 2026 验证（样本不足）
- `news-2021-2023-doge-ada-verification.md` — **2021-2023 验证（推翻 ADA alpha）**
- `/tmp/verify_doge_ada_2024.py` / `/tmp/verify_doge_ada_2025_full.py` / `/tmp/verify_doge_ada_2021_2023.py` — 验证脚本
- `/tmp/finbert-2024-cryptopanic-merged.json` — 2024 FinBERT cache
- `/tmp/finbert-2018-2023-cache.json` — 2018-2023 FinBERT cache
- `/tmp/coin-multiyear-daily-klines.json` — 多年日 K 缓存
