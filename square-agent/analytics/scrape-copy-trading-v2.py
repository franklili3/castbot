#!/usr/bin/env python3
"""币安带单数据采集 v2 — 纯 HTTP，无浏览器依赖

用法:
  python3 scrape-copy-trading-v2.py                    # 默认所有时间段
  python3 scrape-copy-trading-v2.py --portfolio 4458914342020236800  # 指定带单员
  python3 scrape-copy-trading-v2.py --proxy http://127.0.0.1:7890    # 指定代理

支持 Linux / macOS / Windows，只需 Python 3 + requests。
"""

import argparse
import json
import os
import sys
import time
from urllib.request import Request, urlopen
from urllib.parse import urlencode

DEFAULT_PORTFOLIO = "4458914342020236800"
BASE_URL = "https://www.binance.com/bapi/futures/v1"
OUTPUT_DIR = os.path.expanduser(os.environ.get("SQUARE_AGENT_COPY_TRADING_DIR", "~/.square-agent/copy-trading"))

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "clienttype": "web",
    "lang": "zh-CN",
    "Content-Type": "application/json",
}

TIME_RANGES = ["7D", "30D", "90D", "180D"]


def fetch(url, proxy=None):
    """HTTP GET with optional proxy, returns parsed JSON."""
    req = Request(url, headers=HEADERS)
    proxies = {"http": proxy, "https": proxy} if proxy else None
    if proxies:
        # urllib doesn't support HTTPS proxy directly via proxies dict;
        # use urllib's ProxyHandler
        from urllib.request import build_opener, ProxyHandler
        opener = build_opener(ProxyHandler(proxies))
        resp = opener.open(req, timeout=15)
    else:
        resp = urlopen(req, timeout=15)
    return json.loads(resp.read().decode("utf-8"))


def get_detail(portfolio_id, proxy=None):
    """获取带单员概览信息"""
    url = f"{BASE_URL}/friendly/future/spot-copy-trade/lead-portfolio/detail?portfolioId={portfolio_id}"
    data = fetch(url, proxy)
    if data.get("code") != "000000":
        raise RuntimeError(f"detail API error: {data}")
    d = data["data"]
    return {
        "nickname": d.get("nickname", "").strip(),
        "description": d.get("description"),
        "avatarUrl": d.get("avatarUrl"),
        "status": d.get("status"),
        "tradingDays": d.get("joinDays"),
        "followers": d.get("currentCopyCount"),
        "maxFollowers": d.get("maxCopyCount"),
        "totalFollowers": d.get("totalCopyCount"),
        "favorites": d.get("favoriteCount"),
        "walletBalance": d.get("walletBalanceAmount"),
        "aum": d.get("aumAmount"),
        "copierPnl": d.get("copierPnl"),
        "profitShareRate": d.get("profitSharingRate"),
        "lastTradeTime": d.get("lastTradeTime"),
        "startTime": d.get("startTime"),
    }


def get_performance(portfolio_id, time_range, proxy=None):
    """获取指定时间段的表现数据"""
    url = (
        f"{BASE_URL}/public/future/spot-copy-trade/lead-portfolio/performance"
        f"?portfolioId={portfolio_id}&timeRange={time_range}"
    )
    data = fetch(url, proxy)
    if data.get("code") != "000000":
        raise RuntimeError(f"performance API error ({time_range}): {data}")
    d = data["data"]
    return {
        "timeRange": d.get("timeRange"),
        "roi": f"{float(d['roi']):.2f}%" if d.get("roi") else None,
        "pnl": d.get("pnl"),
        "maxDrawdown": f"{float(d['mdd']):.2f}%" if d.get("mdd") else None,
        "copierPnl": f"{d['copierPnl']} USDT" if d.get("copierPnl") else None,
        "winRate": f"{float(d['winRate']):.2f}%" if d.get("winRate") else None,
        "profitDays": str(d.get("winDays", "")) if d.get("winDays") else None,
        "sharpe": f"{float(d['sharpRatio']):.2f}" if d.get("sharpRatio") else None,
        "aum": d.get("aum"),
    }


def get_chart_data(portfolio_id, time_range, data_type="ROI", proxy=None):
    """获取收益率图表数据"""
    url = (
        f"{BASE_URL}/public/future/spot-copy-trade/lead-portfolio/performance-chart-data"
        f"?dataType={data_type}&portfolioId={portfolio_id}&timeRange={time_range}"
    )
    data = fetch(url, proxy)
    if data.get("code") != "000000":
        return None  # 图表数据可选
    return data.get("data")


def get_active_holding(portfolio_id, proxy=None):
    """获取当前持仓"""
    url = f"{BASE_URL}/friendly/future/spot-copy-trade/lead-portfolio/get-active-holding-by-page"
    # This is a POST endpoint, use POST
    req = Request(
        url,
        data=json.dumps({"portfolioId": portfolio_id, "page": 1, "pageSize": 50}).encode(),
        headers={**HEADERS, "Content-Type": "application/json"},
        method="POST",
    )
    if proxy:
        from urllib.request import build_opener, ProxyHandler
        opener = build_opener(ProxyHandler({"http": proxy, "https": proxy}))
        resp = opener.open(req, timeout=15)
    else:
        resp = urlopen(req, timeout=15)
    data = json.loads(resp.read().decode("utf-8"))
    if data.get("code") != "000000":
        return None
    return data.get("data")


def main():
    parser = argparse.ArgumentParser(description="币安带单数据采集 (纯HTTP)")
    parser.add_argument("--portfolio", default=DEFAULT_PORTFOLIO, help="Portfolio ID")
    parser.add_argument("--proxy", default=None, help="HTTP proxy URL (e.g. http://127.0.0.1:7890)")
    parser.add_argument("--output", default=OUTPUT_DIR, help="Output directory")
    parser.add_argument("--time-ranges", nargs="*", default=TIME_RANGES, help="Time ranges to fetch")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    print(f"Fetching data for portfolio {args.portfolio}...")
    if args.proxy:
        print(f"Using proxy: {args.proxy}")

    # 1. Overview
    print("\n=== Overview ===")
    detail = get_detail(args.portfolio, args.proxy)
    for k, v in detail.items():
        if v is not None:
            print(f"  {k}: {v}")

    # 2. Performance by period
    print("\n=== Performance ===")
    all_perf = {}
    for tr in args.time_ranges:
        print(f"  Fetching {tr}...", end=" ")
        try:
            perf = get_performance(args.portfolio, tr, args.proxy)
            all_perf[tr] = perf
            print(f"ROI={perf.get('roi')}, MaxDD={perf.get('maxDrawdown')}, "
                  f"WinRate={perf.get('winRate')}, Sharpe={perf.get('sharpe')}")
        except Exception as e:
            print(f"FAILED: {e}")
            all_perf[tr] = {"error": str(e)}
        time.sleep(0.5)  # be nice to API

    # 3. Chart data (30D ROI)
    print("\n=== Chart Data (30D ROI) ===")
    try:
        chart = get_chart_data(args.portfolio, "30D", "ROI", args.proxy)
        if chart:
            if isinstance(chart, list):
                print(f"  Got {len(chart)} data points")
            else:
                print(f"  Got data: {str(chart)[:200]}")
    except Exception as e:
        print(f"  Skipped: {e}")
        chart = None

    # 4. Active holdings
    print("\n=== Active Holdings ===")
    try:
        holdings = get_active_holding(args.portfolio, args.proxy)
        if holdings:
            holding_list = holdings.get("list", holdings) if isinstance(holdings, dict) else holdings
            if isinstance(holding_list, list):
                print(f"  {len(holding_list)} positions")
                for h in holding_list[:5]:
                    asset = h.get("asset") or h.get("symbol", "?")
                    qty = h.get("remainingAmount") or h.get("amount", "?")
                    pnl = h.get("unrealizedPnl") or h.get("pnl", "?")
                    print(f"    {asset}: {qty} (PnL: {pnl})")
        else:
            print("  No active holdings or not available")
    except Exception as e:
        print(f"  Skipped: {e}")
        holdings = None

    # 5. Save
    result = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "portfolioId": args.portfolio,
        "source": "binance-api-v2",
        "overview": detail,
        "performance": all_perf,
        "chartData30D": chart,
        "holdings": holdings,
    }

    date_str = time.strftime("%Y-%m-%d")
    for fname in [f"{date_str}.json", "latest.json"]:
        fpath = os.path.join(args.output, fname)
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

    print(f"\nSaved: {args.output}/{date_str}.json, latest.json")


if __name__ == "__main__":
    main()
