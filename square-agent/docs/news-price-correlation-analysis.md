# 新闻标题价格影响相关性分析报告

> 生成时间：2026-06-25
> 数据：公开学术数据集 + square-agent 实采
> 分析脚本：`/tmp/multi-regime-analysis.py`、`/tmp/news-price-correlation.py`

## 目标

验证一个常见假设：**LLM 能否仅凭新闻标题预测加密货币短期价格方向？**

square-agent 的 news-pipeline 当前流程是「LLM 评分 → 筛 critical/high → LLM 生成解读 → 推 Telegram 审核」。如果标题方向预测有效，可把信号接入交易/告警；如果无效，则应明确把 LLM 角色限制为「内容生成器」而非「价格预测器」。

## 方法

### 数据源

square-agent 的 RSS / 币安广场 / CryptoPanic 采集代码**不支持历史回溯**（RSS 只暴露最新 20-50 条，CryptoPanic token 未配置）。因此采用公开学术数据集替代：

| 阶段 | 数据源 | 条数 |
|---|---|---|
| 2024 牛市 (02~12) | HuggingFace `maryamfakhari/crypto-news-coindesk-2020-2025` | 115K 可用，采样 500 |
| 2025 震荡 (01~02 + 07~11) | 同上 + GitHub `mouadja02/bitcoin-news-data` | 38K 可用，采样 500 |
| 2026 熊市 (06) | square-agent `pipeline-state.json` 实采 | 161 条（全量） |

### 流程

```
原始数据
  ↓ 采样 500/阶段 (random_state=42)
LLM 分类（GLM-4.5，batch=5）
  - 币种: BTC / ETH / BOTH / OTHER
  - 方向: bullish / bearish / neutral
  - 置信度: 0.0-1.0
  ↓
Binance 历史 K 线 (1h interval)
  - 取发布时刻 open 价
  - 取 +24h 后 open 价
  - 计算 24h 涨跌%
  ↓
统计分析
  - 方向准确率 (predicted_sign × actual_sign)
  - Pearson r (predicted_sign × conf  vs  actual_pct)
  - Spearman ρ
  - 按 direction/coin/source 分组
```

### 已知方法学局限

1. **24h 窗口偏长** — 真正的价格反应通常在 1~4h 内完成，24h 会引入大量噪音
2. **BTC 替代效应** — OTHER/BOTH 都用 BTC 价格作大盘基准
3. **样本不均衡** — 2026 熊市只有 161 条（其他阶段 500 条）
4. **LLM 单次调用** — 没做 ensemble，温度 0.2 仍存在调用间方差
5. **历史数据集来源偏差** — Coindesk/Decrypt 等偏向西方媒体，可能遗漏中文/韩文市场信号

## 结果

### 跨市场阶段对比

| Regime | N (有方向) | 方向准确率 | Pearson r | p 值 | bullish 准确 | bearish 准确 |
|---|---|---|---|---|---|---|
| 2024 牛市 | 337 | **48.7%** | -0.053 | 0.24 | 51.5% | 42.3% |
| 2025 震荡 | 359 | **48.7%** | -0.055 | 0.22 | 50.2% | 44.4% |
| 2026 熊市 | 119 | **55.5%** | +0.088 | 0.27 | 34.3% | **85.7%** |

**所有 p 值均 > 0.05，无一达到统计显著。**

### 实际涨跌分布（按 LLM 预测方向分组）

| Regime | bullish 中位 | bearish 中位 | neutral 中位 |
|---|---|---|---|
| 2024 牛市 | +0.04% | +0.28% | +0.35% |
| 2025 震荡 | +0.02% | +0.27% | -0.09% |
| 2026 熊市 | -2.05% | **-2.74%** | -1.91% |

注：在牛市/震荡市中，bullish 和 bearish 的中位涨跌几乎一致（差异 <0.3pp）；2026 熊市中 bearish 标的的跌幅比 bullish 多 0.69pp，是唯一可观察到的实际信号。

### 预测分布的严重多头偏差

LLM 在所有阶段都倾向预测 bullish，即使市场在大跌：

| Regime | bullish 占比 | bearish 占比 | neutral 占比 |
|---|---|---|---|
| 2024 牛市 | 69% | 31% | — |
| 2025 震荡 | 75% | 25% | — |
| 2026 熊市 | **59%** | 41% | — |

在 BTC 单月跌 29% 的 2026 年 6 月，LLM 仍然把近 6 成新闻判为「利好」。

## 核心结论

### 1. LLM 标题方向预测在牛市/震荡市无任何 alpha

48.7% 准确率与抛硬币相当；Pearson r ≈ 0；Spearman 在牛市 p=0.037* 但 ρ 仅 -0.09（效应量极小，且方向为负，更像是 LLM 反向指标）。

### 2. 熊市中出现微弱但非显著的信号

55.5% 方向准确率，**强非对称**：
- bearish 预测：85.7% 准确
- bullish 预测：34.3% 准确（比随机还差）

LLM 识别坏消息的能力 >> 识别好消息。

### 3. 唯一可利用的信号

**熊市中只采纳 LLM 的 bearish 预测**，忽略所有 bullish 预测。85.7% 的准确率可作为做空/减仓的辅助过滤条件。但 p=0.27 说明样本不足，需 200+ 熊市样本才能确认。

### 4. 对 square-agent 的实际意义

当前 pipeline 的「LLM 评分 → critical/high → 生成解读 → 推送」流程**不应被当作价格预测信号**。LLM 在这套流程中的真正价值是：
- **内容生成器**：把生硬的英文标题翻译为可读的中文快讯（这是它擅长的）
- **重要性筛选器**：用 critical/high 等级控制推送量（避免噪音）
- **不是价格方向预测器**

如未来要把方向预测接入交易，需要：
- 缩短到 1~4h 窗口（而非 24h）
- 用专门微调的金融模型（而非通用 chat 模型）
- 至少 1000+ 有标签样本 + ensemble 推理

## 附录：可复现性

### 复现命令

```bash
# 1. 下载数据集
mkdir -p /tmp/crypto-news-data
# HuggingFace (240MB, 走代理)
python3 -c "import requests; ..."  # 见脚本 load_regime_samples()
# GitHub mouadja (76MB)
curl -L https://raw.githubusercontent.com/mouadja02/bitcoin-news-data/main/datasets/news.csv -o /tmp/crypto-news-data/mouadja-news.csv

# 2. 运行分析
python3 /tmp/multi-regime-analysis.py
```

### 缓存策略

- 分类缓存：`/tmp/multi-regime-cache.json`（1162 条 LLM 分类结果，键 = regime + idx + 标题哈希）
- 失败回退：内容过滤触发时（err:1301）逐条降级；其他错误标记 neutral/conf=0
- 价格缓存：无（每次重新拉取 Binance K 线，受 API 限速影响约 1.5s/条）

### 完整数据文件

- `/tmp/multi-regime-results.json` — 全量 records + per-regime stats（~1MB）
- `/tmp/multi-regime-summary.txt` — 纯文本摘要
- `/tmp/multi-regime-v4.log` — 完整运行日志
- `/tmp/news-correlation-results.json` — 早期 138 条 square-agent 实采单独分析结果
