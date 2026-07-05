"""
BTC 新闻信号回放策略（freqtrade）

数据源：
- /Users/mac/clawd/square-agent/data/btc-samples.json       （入场时点 buy_dt）
- /Users/mac/clawd/square-agent/data/btc-oos-predictions.json（OOS 预测 pred/conf）

策略逻辑：
1. 启动时加载两份 JSON，按 date 对齐，得到 (buy_dt, pred, conf) 三元组
2. populate_indicators：把信号 merge 到 1h K线 dataframe
3. populate_entry_trend：pred=1 & conf>=thr → enter_long；
                        pred=0 & conf>=thr → enter_short
4. custom_exit：开仓 12h 后强制平仓
5. 配套 futures 模式，freqtrade 自动扣 funding（与原始研究的资金费率口径一致）

⚠️ 信号回放策略：用于独立验证离线 alpha 在 freqtrade 真实成本/slippage 下是否复现。
   不是生产策略——生产策略需要在线 FinBERT + LogReg 推理。
"""
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional, TYPE_CHECKING

import pandas as pd
from pandas import DataFrame

from freqtrade.strategy import IStrategy

if TYPE_CHECKING:
    from freqtrade.persistence import Trade

logger = logging.getLogger(__name__)


# === 数据路径（相对于项目根）===
PROJECT_ROOT = Path("/Users/mac/clawd/square-agent")
SAMPLES_JSON = PROJECT_ROOT / "data" / "btc-samples.json"
PREDICTIONS_JSON = PROJECT_ROOT / "data" / "btc-oos-predictions.json"


class BtcNewsSignalReplay(IStrategy):
    """
    信号回放策略：12h 持仓 + thr=0.10（最佳配置）。

    默认参数与 docs/news-multi-coin-btc-eth-sol-ada-final.md 报告一致：
    - 持仓 12h
    - 置信度阈值 0.10
    - 双边 taker 0.10%（freqtrade config 里配置 fee=0.001）
    - funding：futures 模式自动扣除
    """

    INTERFACE_VERSION = 3

    # 1h K线 —— 与 buy_dt 精度对齐
    timeframe = "1h"

    # 不主动止盈 —— 完全依赖 12h 时间退出
    # freqtrade 看到 ROI 后会立即平仓，所以这里给一个超大的值
    minimal_roi = {"0": 100.0}

    # 单笔止损：宽松 15%（原始研究里没设止损，最高单笔亏损 ~6%）
    # 实盘建议更紧（5-8%），这里保持研究口径
    stoploss = -0.15

    # 关闭 trailing —— 时间退出，不让短期波动触发
    trailing_stop = False

    # === 关键：futures 模式以支持做空 + 自动扣 funding ===
    can_short = True

    # 多头空头使用相同信号阈值
    # （可通过 env 变量或 config override 调整）

    # 默认配置（可被 config 文件中的 strategy属性覆盖）
    HOLDING_HOURS = 12
    CONF_THRESHOLD = 0.10
    HOLDING_KEY = "12h"  # 选哪个持仓时长的预测：1h/2h/4h/6h/8h/12h/24h/48h/72h/96h

    # 延迟初始化（IStrategy __init__ 签名多变，懒加载更稳）
    _signals_df: DataFrame = None

    # ------------------------------------------------------------------ #
    # 信号加载
    # ------------------------------------------------------------------ #
    @classmethod
    def _load_signals(cls, holding_key: str) -> DataFrame:
        """
        加载 samples + predictions，按 date merge，返回带 buy_dt 的信号 DataFrame。

        返回字段：buy_dt, date, pred, conf, fold, funding_pct
        """
        with open(SAMPLES_JSON) as f:
            samples_data = json.load(f)
        with open(PREDICTIONS_JSON) as f:
            preds_data = json.load(f)

        sample_by_date = {s["date"]: s for s in samples_data["samples"]}

        preds = preds_data["predictions_all_holdings"].get(holding_key)
        if preds is None:
            raise ValueError(
                f"predictions_all_holdings 缺少 key '{holding_key}'，"
                f"可用: {list(preds_data['predictions_all_holdings'].keys())}"
            )

        rows = []
        for p in preds:
            s = sample_by_date.get(p["date"])
            if s is None:
                continue
            rows.append({
                "buy_dt": s["buy_dt"],          # "2022-01-01 03:00:00"
                "date": p["date"],
                "pred": int(p["pred"]),
                "conf": float(p["conf"]),
                "fold": p["fold"],
                "funding_pct": float(p["funding_pct"]),
                "pct_actual": float(p["pct"]),
            })

        df = pd.DataFrame(rows)
        df["buy_dt"] = pd.to_datetime(df["buy_dt"])
        logger.info(
            f"加载 BTC 信号 {holding_key}: {len(df)} 条 | "
            f"多头 {(df['pred']==1).sum()} 空头 {(df['pred']==0).sum()} | "
            f"高置信度 (conf>={cls.CONF_THRESHOLD}) {(df['conf']>=cls.CONF_THRESHOLD).sum()}"
        )
        return df

    def bot_loop(self, current_time, **kwargs):
        """每根 K线调一次；这里用作懒加载触发。"""
        if self._signals_df is None:
            self._signals_df = self._load_signals(self.HOLDING_KEY)
        super().bot_loop(current_time, **kwargs)

    # ------------------------------------------------------------------ #
    # 指标 / 信号注入
    # ------------------------------------------------------------------ #
    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        把信号 merge 到 1h K线。dataframe['date'] 是 UTC 时间戳。
        """
        if self._signals_df is None:
            self._signals_df = self._load_signals(self.HOLDING_KEY)

        # dataframe['date'] 是 UTC datetime；信号里 buy_dt 是 naive local time
        # freqtrade 回测币安数据时，dataframe['date'] 实际是 UTC naive
        # 我们假设两者都是 UTC（币安 API 返回 UTC）
        sig = self._signals_df[["buy_dt", "pred", "conf", "fold", "funding_pct"]].copy()
        sig = sig.rename(columns={"buy_dt": "signal_dt"})

        dataframe = dataframe.merge(
            sig,
            left_on="date",
            right_on="signal_dt",
            how="left",
        )

        # 标记：当根 K线是否有信号
        dataframe["has_signal"] = dataframe["pred"].notna().astype(int)
        dataframe["pred"] = dataframe["pred"].fillna(-1).astype(int)  # -1 = 无信号
        dataframe["conf"] = dataframe["conf"].fillna(0.0)

        return dataframe

    # ------------------------------------------------------------------ #
    # 入场
    # ------------------------------------------------------------------ #
    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        当根 K线出现信号且置信度达标：
        - pred=1 → 做多
        - pred=0 → 做空

        ⚠️ freqtrade 一根 K线最多开一个仓位（除非 position_adjustment_enable=True）
        """
        long_mask = (
            (dataframe["pred"] == 1)
            & (dataframe["conf"] >= self.CONF_THRESHOLD)
        )
        short_mask = (
            (dataframe["pred"] == 0)
            & (dataframe["conf"] >= self.CONF_THRESHOLD)
        )

        dataframe.loc[long_mask, "enter_long"] = 1
        dataframe.loc[short_mask, "enter_short"] = 1

        return dataframe

    # ------------------------------------------------------------------ #
    # 退出（不用 exit_trend；用 custom_exit 控制 12h 时间退出）
    # ------------------------------------------------------------------ #
    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """不主动退出；custom_exit 接管时间退出。"""
        return dataframe

    def custom_exit(self, pair: str, trade: "Trade", current_time: datetime,
                    **kwargs) -> Optional[str]:
        """
        持仓时间达到 HOLDING_HOURS 后强制平仓。
        """
        holding_seconds = self.HOLDING_HOURS * 3600
        elapsed = (current_time - trade.open_date_utc).total_seconds()
        if elapsed >= holding_seconds:
            return f"holding_{self.HOLDING_HOURS}h_exit"
        return None

    # ------------------------------------------------------------------ #
    # 可选：杠杆调整（futures 模式）
    # ------------------------------------------------------------------ #
    def leverage(self, pair: str, current_time: datetime, current_rate: float,
                 proposed_leverage: float, max_leverage: float, side: str,
                 **kwargs) -> float:
        """原始研究用 1x 等同现货；保持低杠杆。"""
        return 1.0
