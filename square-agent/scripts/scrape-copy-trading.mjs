#!/usr/bin/env node
/**
 * 币安带单数据采集 — Node.js 版（零额外依赖）
 *
 * 移植自 analytics/scrape-copy-trading-v2.py，输出 schema 完全一致。
 * HTTP 通过 child_process 调 curl（支持代理，无 npm 依赖）。
 *
 * 用法:
 *   node scrape-copy-trading.mjs                                # 默认 portfolio + 所有时间段
 *   node scrape-copy-trading.mjs --portfolio 4458914342020236800
 *   node scrape-copy-trading.mjs --proxy http://127.0.0.1:7890
 *   node scrape-copy-trading.mjs --output /path/to/dir
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ============ 默认值 ============
const DEFAULT_PORTFOLIO = '4458914342020236800';
const BASE_URL = 'https://www.binance.com/bapi/futures/v1';
const TIME_RANGES = ['7D', '30D', '90D', '180D'];

function defaultOutputDir() {
  // 优先 SQUARE_AGENT_COPY_TRADING_DIR
  // → ~/.square-agent/copy-trading/
  // → 旧路径 ~/clawd/data/binance-content/copy-trading/
  const env = process.env.SQUARE_AGENT_COPY_TRADING_DIR;
  if (env) return env;
  const neo = join(homedir(), '.square-agent', 'copy-trading');
  if (existsSync(neo)) return neo;
  const legacy = join(homedir(), 'clawd', 'data', 'binance-content', 'copy-trading');
  if (existsSync(legacy)) {
    process.stderr.write(`[scrape] using legacy path ${legacy}\n[scrape]   → migrate to ${neo}\n`);
    return legacy;
  }
  return neo;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
  clienttype: 'web',
  lang: 'zh-CN',
  'Content-Type': 'application/json',
};

// ============ curl 封装 ============
function curlAvailable() {
  try { execSync('command -v curl', { stdio: 'pipe' }); return true; } catch { return false; }
}

function fetchJson(url, proxy) {
  const args = ['-s', '--max-time', '15'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const out = execSync(`curl ${args.map(a => JSON.stringify(a)).join(' ')}`, {
    timeout: 20000,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function postJson(url, payload, proxy) {
  const args = ['-s', '--max-time', '15', '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(payload)];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const out = execSync(`curl ${args.map(a => JSON.stringify(a)).join(' ')}`, {
    timeout: 20000,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

// ============ API 调用（逻辑与 Python 版一致） ============
function getDetail(portfolioId, proxy) {
  const url = `${BASE_URL}/friendly/future/spot-copy-trade/lead-portfolio/detail?portfolioId=${portfolioId}`;
  const data = fetchJson(url, proxy);
  if (data.code !== '000000') throw new Error(`detail API error: ${JSON.stringify(data)}`);
  const d = data.data;
  return {
    nickname: (d.nickname || '').trim(),
    description: d.description ?? null,
    avatarUrl: d.avatarUrl ?? null,
    status: d.status ?? null,
    tradingDays: d.joinDays ?? null,
    followers: d.currentCopyCount ?? null,
    maxFollowers: d.maxCopyCount ?? null,
    totalFollowers: d.totalCopyCount ?? null,
    favorites: d.favoriteCount ?? null,
    walletBalance: d.walletBalanceAmount ?? null,
    aum: d.aumAmount ?? null,
    copierPnl: d.copierPnl ?? null,
    profitShareRate: d.profitSharingRate ?? null,
    lastTradeTime: d.lastTradeTime ?? null,
    startTime: d.startTime ?? null,
  };
}

function getPerformance(portfolioId, timeRange, proxy) {
  const url = `${BASE_URL}/public/future/spot-copy-trade/lead-portfolio/performance?portfolioId=${portfolioId}&timeRange=${timeRange}`;
  const data = fetchJson(url, proxy);
  if (data.code !== '000000') throw new Error(`performance API error (${timeRange}): ${JSON.stringify(data)}`);
  const d = data.data;
  return {
    timeRange: d.timeRange ?? null,
    roi: d.roi != null ? `${Number(d.roi).toFixed(2)}%` : null,
    pnl: d.pnl ?? null,
    maxDrawdown: d.mdd != null ? `${Number(d.mdd).toFixed(2)}%` : null,
    copierPnl: d.copierPnl != null ? `${d.copierPnl} USDT` : null,
    winRate: d.winRate != null ? `${Number(d.winRate).toFixed(2)}%` : null,
    profitDays: d.winDays != null ? String(d.winDays) : null,
    sharpe: d.sharpRatio != null ? Number(d.sharpRatio).toFixed(2) : null,
    aum: d.aum ?? null,
  };
}

function getChartData(portfolioId, timeRange, dataType, proxy) {
  const url = `${BASE_URL}/public/future/spot-copy-trade/lead-portfolio/performance-chart-data?dataType=${dataType}&portfolioId=${portfolioId}&timeRange=${timeRange}`;
  try {
    const data = fetchJson(url, proxy);
    if (data.code !== '000000') return null;
    return data.data ?? null;
  } catch {
    return null;
  }
}

function getActiveHolding(portfolioId, proxy) {
  const url = `${BASE_URL}/friendly/future/spot-copy-trade/lead-portfolio/get-active-holding-by-page`;
  try {
    const data = postJson(url, { portfolioId, page: 1, pageSize: 50 }, proxy);
    if (data.code !== '000000') return null;
    return data.data ?? null;
  } catch {
    return null;
  }
}

// ============ CLI 参数解析（轻量，无依赖） ============
function parseArgs(argv) {
  const opts = {
    portfolio: DEFAULT_PORTFOLIO,
    proxy: null,
    output: defaultOutputDir(),
    timeRanges: TIME_RANGES,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--portfolio') opts.portfolio = argv[++i];
    else if (a.startsWith('--portfolio=')) opts.portfolio = a.slice('--portfolio='.length);
    else if (a === '--proxy') opts.proxy = argv[++i];
    else if (a.startsWith('--proxy=')) opts.proxy = a.slice('--proxy='.length);
    else if (a === '--output') opts.output = argv[++i];
    else if (a.startsWith('--output=')) opts.output = a.slice('--output='.length);
    else if (a === '--time-ranges') opts.timeRanges = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '-h' || a === '--help') {
      console.log(`用法: node scrape-copy-trading.mjs [--portfolio ID] [--proxy URL] [--output DIR] [--time-ranges 7D,30D,90D,180D]`);
      process.exit(0);
    }
  }
  return opts;
}

// ============ 主流程 ============
function main() {
  if (!curlAvailable()) {
    console.error('❌ 需要 curl 命令（用于 HTTP + 代理支持）。请安装后重试。');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.output)) mkdirSync(args.output, { recursive: true });

  console.log(`Fetching data for portfolio ${args.portfolio}...`);
  if (args.proxy) console.log(`Using proxy: ${args.proxy}`);

  // 1. Overview
  console.log('\n=== Overview ===');
  const detail = getDetail(args.portfolio, args.proxy);
  for (const [k, v] of Object.entries(detail)) {
    if (v != null) console.log(`  ${k}: ${v}`);
  }

  // 2. Performance by period
  console.log('\n=== Performance ===');
  const allPerf = {};
  for (const tr of args.timeRanges) {
    process.stdout.write(`  Fetching ${tr}... `);
    try {
      const perf = getPerformance(args.portfolio, tr, args.proxy);
      allPerf[tr] = perf;
      console.log(`ROI=${perf.roi}, MaxDD=${perf.maxDrawdown}, WinRate=${perf.winRate}, Sharpe=${perf.sharpe}`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      allPerf[tr] = { error: e.message };
    }
    sleep(500); // 对 API 友好
  }

  // 3. Chart data (30D ROI)
  console.log('\n=== Chart Data (30D ROI) ===');
  let chart = null;
  try {
    chart = getChartData(args.portfolio, '30D', 'ROI', args.proxy);
    if (chart) {
      console.log(`  Got ${Array.isArray(chart) ? chart.length + ' data points' : 'data'}`);
    }
  } catch (e) {
    console.log(`  Skipped: ${e.message}`);
  }

  // 4. Active holdings
  console.log('\n=== Active Holdings ===');
  let holdings = null;
  try {
    holdings = getActiveHolding(args.portfolio, args.proxy);
    if (holdings) {
      const list = holdings.list ?? (Array.isArray(holdings) ? holdings : null);
      if (Array.isArray(list)) {
        console.log(`  ${list.length} positions`);
        for (const h of list.slice(0, 5)) {
          const asset = h.asset || h.symbol || '?';
          const qty = h.remainingAmount ?? h.amount ?? '?';
          const pnl = h.unrealizedPnl ?? h.pnl ?? '?';
          console.log(`    ${asset}: ${qty} (PnL: ${pnl})`);
        }
      }
    } else {
      console.log('  No active holdings or not available');
    }
  } catch (e) {
    console.log(`  Skipped: ${e.message}`);
  }

  // 5. Save
  const result = {
    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
    portfolioId: args.portfolio,
    source: 'binance-api-v2-node',
    overview: detail,
    performance: allPerf,
    chartData30D: chart,
    holdings,
  };

  const dateStr = new Date().toISOString().split('T')[0];
  for (const fname of [`${dateStr}.json`, 'latest.json']) {
    writeFileSync(join(args.output, fname), JSON.stringify(result, null, 2));
  }
  console.log(`\nSaved: ${args.output}/${dateStr}.json, latest.json`);
}

function sleep(ms) {
  // 同步 sleep，用于节流（避免顶层 await 的 import 复杂度）
  execSync(`sleep ${Math.max(0, ms / 1000)}`, { timeout: ms + 1000 });
}

main();
