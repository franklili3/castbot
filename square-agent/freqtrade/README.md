# BTC 新闻信号回放 — freqtrade 回测

> 目的：用 freqtrade 的独立成本/slippage/funding 模型，验证 `data/btc-oos-predictions.json` 中的 BTC 12h 持仓 alpha 在更接近实盘的环境下是否复现。

## 1. 前置

### 1.1 安装 freqtrade

```bash
# 建议在虚拟环境里安装
python3 -m venv .venv
source .venv/bin/activate

pip install freqtrade
# 或者从源码（推荐，futures 回测功能较新）：
# git clone https://github.com/freqtrade/freqtrade.git
# cd freqtrade && pip install -e .
```

### 1.2 确认数据文件存在

```bash
ls /Users/mac/clawd/square-agent/data/btc-samples.json
ls /Users/mac/clawd/square-agent/data/btc-oos-predictions.json
# 如缺失：见 docs/news-multi-coin-btc-eth-sol-ada-final.md 复现方法
```

## 2. 下载历史数据（futures）

freqtrade 回测需要它自己的 `.feather` 格式 OHLCV + funding rate 数据。

```bash
cd /Users/mac/clawd/square-agent/freqtrade

# 1h K线 2021-2025（覆盖训练折 2021 + OOS 2022-2025）
freqtrade download-data \
    --config config-btc-news.json \
    --timeframes 1h \
    --timerange 20210101-20260101 \
    --trading-mode futures

# Funding rate（futures 模式必需）
freqtrade download-data \
    --config config-btc-news.json \
    --timeframes 1h \
    --timerange 20210101-20260101 \
    --trading-mode futures \
    --datatype funding_rate

# Mark price（futures 模式必需，用于止损触发）
freqtrade download-data \
    --config config-btc-news.json \
    --timeframes 1h \
    --timerange 20210101-20260101 \
    --trading-mode futures \
    --datatype mark
```

数据存到 `data/binance/futures/`。

## 3. 回测

```bash
cd /Users/mac/clawd/square-agent/freqtrade

# 全 OOS 回测（2022-01-01 ~ 2025-12-03）
freqtrade backtesting \
    --config config-btc-news.json \
    --strategy BtcNewsSignalReplay \
    --timerange 20220101-20251203 \
    --timeframe 1h \
    --enable-protections 0

# 输出会在 user_data/backtest_results/ 或当前目录
```

### 3.1 关键回测指标对照

`docs/news-multi-coin-btc-eth-sol-ada-final.md` 的原始结果（用我们自己的回测脚本）：

| 指标 | 原始研究值 |
|---|---|
| OOS 交易数 | 503（pred=1 多头，conf≥0.10） |
| 累计收益 | +186% |
| 日频 Sharpe | +2.28 |
| Bootstrap 95% CI | [+1.26, +3.28] |

**预期 freqtrade 回测数字**：
- 交易数：~503（多头）+ ~少量（空头，pred=0 也开仓）
- 累计收益：低于 +186%（freqtrade 扣 slippage + 实际 funding）
- Sharpe：可能下降到 1.5-2.0

如果 freqtrade 显示 Sharpe < 1 或累计负，说明 alpha 在更严格成本下不成立。

### 3.2 多空分别回测

`BtcNewsSignalReplay` 默认同时做多头和空头。要单独测：

```bash
# 仅多头：在 config-btc-news.json 加 "can_short": false
# 或在策略文件里改 can_short = False

# 也可以加 --strategy-list 跑对比
```

## 4. 文件清单

```
freqtrade/
├── README.md                          ← 本文件
├── config-btc-news.json               ← 回测配置（futures / 1h / BTC-USDT 永续）
├── strategies/
│   └── BtcNewsSignalReplay.py         ← 信号回放策略
└── data/                              ← freqtrade 下载的 .feather 数据（自动生成）
    └── binance/futures/
        ├── BTC_USDT_USDT-1h-futures.feather
        ├── BTC_USDT_USDT-1h-futures-funding_rate.feather
        └── BTC_USDT_USDT-1h-futures-mark.feather
```

## 5. 策略行为说明

### 5.1 入场时机

- 信号 JSON 里每条带 `buy_dt`（如 `2022-01-01 03:00:00`）= "当天首条新闻后的下一个整点"
- freqtrade 在那根 1h K线触发 `enter_long` / `enter_short`
- 用 `market` 单（taker 费率 0.05%）

### 5.2 退出时机

- `custom_exit` 在持仓 ≥ 12 小时后强制平仓
- 单笔止损 -15%（很宽松，原始研究未触发止损）
- 不主动止盈（minimal_roi 设为 100% 即"永不"）

### 5.3 资金费率

- `trading_mode: futures` 让 freqtrade 自动按真实历史 funding rate 扣/收
- 多头在 funding>0 时付；空头在 funding>0 时收
- 与原始研究口径完全一致

### 5.4 杠杆

- `leverage()` 返回 1.0 — 等同现货，避免 funding 放大 + 强平风险
- 实盘如想加杠杆，改这里

## 6. 局限与注意

1. **信号回放 ≠ 实盘**：策略读取预先算好的 OOS 预测，不能用于 live。
2. **OOS 数据泄漏风险**：信号生成时用了"今天首条新闻"，实盘时这条新闻可能晚到 1-2 小时——需要 live testing 验证。
3. **funding 时区**：freqtrade 用 UTC，原始研究也是 UTC（币安 API）。时区一致。
4. **freqtrade 单仓限制**：`max_open_trades: 1`，如果信号密集出现会跳过部分（原始研究里没这个限制）。
5. **slippage**：默认 freqtrade 不模拟滑点，可用 `--strategy-list` 配合 slippage 配置加上。

## 7. 实盘前置检查清单

- [ ] freqtrade 回测 Sharpe > 1.5
- [ ] freqtrade 回测累计收益 > +50%
- [ ] 月度 Sharpe 正月份 > 9/12
- [ ] 单笔最大亏损 < -8%
- [ ] paper trading 1 个月：live vs paper slippage < 0.1%

## 8. 下一步：在线推理策略

本策略只是**验证 alpha 真实性**。如果通过，下一步：

1. 把 `verify_multi_coin_full.py` 里的 LogReg + TF-IDF + FinBERT 管道封装成 `BtcNewsOnlineStrategy`
2. 策略启动时加载训练好的 `.pkl` 模型
3. 每根 K线检查最近 1h 内的新闻 → 实时打分 → 入场
4. 这是真正能上 live 的策略
