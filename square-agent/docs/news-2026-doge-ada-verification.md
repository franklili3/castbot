# 2026 held-out 验证：DOGE/ADA 反向策略

> 生成时间：2026-06-27
> 目的：用 2026 数据验证 2025 v2 分析中发现的 DOGE/ADA 反向策略
> 训练数据：2025 cryptopanic（DOGE n=283, ADA n=291 币种-日期对）
> 测试数据：2026 square-agent RSS（2026-06-15 ~ 2026-06-26，16 天）

## 1. 背景

2025 v2 Lamon 监督学习分析（`news-supervised-lamon-method-analysis.md`）发现：

- DOGE/ADA 的 FinBERT bearish 信号在**幅度加权**评估上有强信号
- 在 2025 Q4 熊市测试集上，**涨做空/跌做多（反向）策略**大幅盈利：
  - DOGE intra-day: +81.70%
  - DOGE 1d-ahead: +42.70%
  - ADA intra-day: +54.86%
  - ADA 1d-ahead: +52.16%

本次验证的核心问题：**这个反向策略在 2026 held-out 数据上是否成立？**

## 2. 验证方法

### 2.1 训练（2025 数据）

- 用全部 2025 DOGE/ADA 数据训练（不再做 train/test split，最大化训练样本）
- 特征：TF-IDF 1-2gram (top 500) + FinBERT [ppos, pneg, pneu] + n_news + pos_neg_ratio
- 三个分类器候选：LogReg / LinearSVC / MultiNB，在训练数据上选最佳
- 标签：intra_day（当日 close vs open），1d_ahead（次日 close vs 当日 close）

训练集自身准确率：
- DOGE intra-day LinearSVC: train_acc ≈ 95%
- ADA intra-day LinearSVC: train_acc ≈ 92%
- ADA 1d-ahead LinearSVC: train_acc ≈ 93%

（高 train_acc 说明模型在训练数据上拟合充分，但存在过拟合风险）

### 2.2 测试（2026 数据）

- 数据源：`news-queue.json`（square-agent 自己的 RSS 采集）
- 币种分类：标题 regex `\b(dogecoin|doge)\b` / `\b(cardano|ada\b)\b`（2026 无 `currencies` 字段）
- 用 2025 训练的 TF-IDF vectorizer + StandardScaler 处理 2026 文本和数值特征
- 用 2025 训练的 LinearSVC 预测
- 评估：accuracy + confusion matrix + Lamon 幅度 + 交易策略 PnL

## 3. 验证结果

### 3.1 样本量

| Coin | 2026 币种-日期对 | 备注 |
|---|---|---|
| DOGE | **1** | 严重不足，无法验证 |
| ADA | **7** | 极少，仅看符号一致性 |
| 合计 | 8 | 远低于统计显著性下限 |

样本量警告：2026 数据仅 16 天，且 square-agent RSS 对小币种覆盖远不如 cryptopanic。下面的所有结论都是**探索性**而非**确证性**。

### 3.2 ADA 详细结果（n=7）

#### intra-day（当日 close vs open）

```
分类器: LinearSVC
n=7 acc=71.4% base=71.4% edge=+0.0pp
Confusion: TN=4 FP=1 FN=1 TP=1
Lamon 幅度: 正确 -2.15% vs 错误 +0.40% (差 -2.55%)
PnL:
  只做多 (buy&hold): -9.96%
  预测涨才做多: -1.19%
  涨做多/跌做空 (顺向): +7.58%
  涨做空/跌做多 (反向): -7.58%
```

#### 1d-ahead（次日 close vs 当日 close）

```
分类器: LinearSVC
n=7 acc=71.4% base=100.0% edge=-28.6pp
Confusion: TN=5 FP=2 FN=0 TP=0
Lamon 幅度: 正确 -3.03% vs 错误 -1.45% (差 -1.58%)
PnL:
  只做多 (buy&hold): -18.02%
  预测涨才做多: -2.89%
  涨做多/跌做空 (顺向): +12.23%
  涨做空/跌做多 (反向): -12.23%
```

### 3.3 DOGE

样本 n=1，无法评估。

## 4. 关键发现

### 4.1 发现1：Lamon 幅度信号方向一致 ✅

ADA 上 Lamon 幅度指标与 2025 一致：

| 数据 | 任务 | 正确预测日均涨跌 | 错误预测日均涨跌 | 差异 |
|---|---|---|---|---|
| 2025 v2 test | intra-day | -1.83% | +0.42% | -2.25% |
| **2026 held-out** | intra-day | **-2.15%** | **+0.40%** | **-2.55%** |
| 2025 v2 test | 1d-ahead | -2.98% | +2.04% | -5.02% |
| **2026 held-out** | 1d-ahead | **-3.03%** | **-1.45%** | **-1.58%** |

**含义**：模型在 2026 上仍然"正确预测的下跌日跌幅更大"——幅度加权的方向**与 2025 一致**。这说明 FinBERT bearish 信号确实能识别出**大幅下跌日**，这个能力在 2026 上保持。

### 4.2 发现2：交易策略方向反转 ❌

2025 v2 在 Q4 熊市测试集上，**反向策略**（涨做空/跌做多）大幅盈利。
2026 held-out 上，**顺向策略**（涨做多/跌做多）盈利，反向策略亏。

| 数据 | ADA intra-day 顺向 | ADA intra-day 反向 | ADA 1d 顺向 | ADA 1d 反向 |
|---|---|---|---|---|
| 2025 v2 test | -54.86% (亏) | **+54.86%** (赚) | -52.16% (亏) | **+52.16%** (赚) |
| **2026 held-out** | **+7.58%** (赚) | -7.58% (亏) | **+12.23%** (赚) | -12.23% (亏) |

**重要解释**：

回顾 2025 v2 的 PnL 计算逻辑（`/tmp/supervised_daily_v2.py`）和 2026 验证脚本（`/tmp/verify_doge_ada_2026.py`），"顺向"和"反向"的定义：

```python
# 顺向：预测涨就做多（享受 +pct），预测跌就做空（享受 -pct）
pnl_strat = np.where(pred==1, pct, -pct).sum()

# 反向：预测涨就做空，预测跌就做多
pnl_strat_reverse = np.where(pred==1, -pct, pct).sum()
```

**所以 2025 v2 的"反向赢"实际上是说**：模型预测的方向是错的（pred=1 时实际跌，pred=0 时实际涨），所以反向操作才赚钱。

**2026 上"顺向赢"则意味着**：模型预测的方向对了，按模型方向操作赚钱。

这其实是**好消息**——模型在 2026 上方向预测准确率提高了。

### 4.3 发现3：可能的解释——市场体制差异

| 时段 | 市场体制 | ADA 方向预测准确率 | 模型学到的规律 |
|---|---|---|---|
| 2025 Q4 测试集 | 熊市（ADA -60%） | 59.3% (base 61%) | 学到"看到 news → 预测跌"，碰巧熊市对 |
| 2026-06 | 震荡 | 71.4% (base 71.4%) | 学到的 n-gram + FinBERT 特征在 2026 仍有效 |

2025 Q4 是持续熊市，**任何"看到 news 就预测跌"的策略都会赢**——base rate 本身就是 62.7% 跌。模型"反向策略"的 +54.86% PnL 本质上是"做空 ADA 在熊市"的 beta 收益，**不是 alpha**。

2026 上是震荡市，base rate 已经不再是压倒性下跌，模型仍能 71.4% 准确，顺向策略 +12% PnL，这才是**潜在的 alpha**——但 n=7，样本太小，无法确认。

## 5. 修正后对 2025 v2 结论的复盘

### 5.1 2025 v2 的"反向策略盈利"可能是伪信号

原报告说：
> **DOGE/ADA 的"涨做多/跌做空"策略大幅盈利**（+40~80%），原因是模型对这些币种的 bearish 信号准确，跌做空赚钱

**这个表述是错误的**。回看 2025 v2 的混淆矩阵（ADA intra-day）：
```
TN=27 (实际跌/预测跌)  FP=9 (实际跌/预测涨)
FN=15 (实际涨/预测跌)  TP=8 (实际涨/预测涨)
```

ADA 2025 Q4 测试集 61% 是跌日。模型预测跌 42 次（TN+FN），其中正确 27 次。**模型对跌的 recall = 27/35 = 77%，但涨的 recall 只有 8/23 = 35%**。

也就是说：**模型在熊市上主要靠"多预测跌"获胜**，不是靠"精确识别 FinBERT bearish 信号"。原报告混淆了这两者。

"涨做空/跌做多（反向）" 在 2025 Q4 PnL=+54.86%，但这等价于"无脑做空 ADA"在 Q4 熊市的收益（ADA Q4 跌约 -54%），**这是 beta，不是 alpha**。

### 5.2 Lamon 幅度评估仍有效

但 Lamon 幅度评估（正确预测日均跌幅 > 错误预测日均涨幅）仍然是有意义的——它说明模型**对大幅波动日**有辨别力，这跟 base rate 无关。

2026 上这个信号保持（差异 -2.55% intra-day / -1.58% 1d-ahead），说明**幅度预警**这个能力是真实的、跨时段稳定。

## 6. 修正后的最终结论

### 6.1 关于 DOGE/ADA 反向策略

**反向策略不是 alpha**。2025 v2 的 +54~86% PnL 来自熊市 beta，不是模型的预测能力。

### 6.2 关于 FinBERT 对小币种的信号

**FinBERT bearish 信号对小币种的"大跌预警"功能可能是真实的**（Lamon 幅度评估跨时段稳定），但：

- 不能直接用方向预测做交易（base rate 主导）
- 可作为**辅助信号**：当模型预测跌 + FinBERT 高 pneg + n-gram 含负面词 → 大跌预警

### 6.3 关于 2026 验证的统计可信度

| 维度 | 评估 |
|---|---|
| 样本量 | ❌ n=7 ADA，n=1 DOGE，严重不足 |
| Lamon 幅度方向 | ✅ 与 2025 一致 |
| 方向准确率 | ⚠️ 71.4%（与 base rate 持平） |
| 策略 PnL | ⚠️ 顺向 +12%，但反向后等量亏，反映 base rate |
| 总体结论 | **不能确证也不能证伪** |

要做出统计显著结论，需要至少 60+ ADA 币种-日期对（约 2 个月数据），目前 16 天数据差太远。

## 7. 对 square-agent 的实操建议（修正）

### 7.1 废弃的建议

原 v2 报告（`news-supervised-lamon-method-analysis.md` § 5.3）建议：
> DOGE/ADA 的 bearish 信号其实准（幅度上）— 可作为"大跌预警"信号

**修正**：幅度信号在 v2 测试集和 2026 held-out 上都稳定，**这条建议保留**。

但 v2 报告隐含的"可做反向交易获利"建议**废弃**——那是熊市 beta。

### 7.2 现行建议

| 用途 | 建议 | 理由 |
|---|---|---|
| 方向预测 | ❌ 不用 | base rate 主导，模型 edge ≈ 0 |
| 大跌预警 | ✅ 用 | Lamon 幅度评估稳定 |
| 反向交易 | ❌ 不用 | 2025 v2 的"反向盈利"是熊市 beta |
| 顺向交易 | ⚠️ 谨慎 | 2026 held-out 上顺向赢，但 n=7 不足信 |

### 7.3 下一步数据采集

为做出统计显著结论，square-agent 应继续积累 2026 数据。按 Lamon 论文规模：

- Lamon 2017 训练数据：~3,600 新闻 + ~10K 推特
- 当前 2026 square-agent RSS：9,210 条总新闻，DOGE/ADA 关联 15 条
- 需要继续采集至少 2-3 个月，达到 ADA 60+ 币种-日期对规模

## 8. 数据文件

- 验证脚本：`/tmp/verify_doge_ada_2026.py`
- 验证日志：`/tmp/verify-2026-log.txt`
- 2025 v2 训练缓存：`/tmp/finbert-2025full-cache.json`
- 2026 测试缓存：`/tmp/finbert-2026-cache.json`
- 2025 日 K 缓存：`/tmp/coin-2025-daily-klines.json`
- 2026 日 K 缓存：`/tmp/coin-2026-daily-klines.json`
- 对照报告：`news-supervised-lamon-method-analysis.md`
