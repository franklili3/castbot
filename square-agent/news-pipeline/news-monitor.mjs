// news-monitor.mjs — 新闻信号聚合器
// 功能：RSS 聚合 + CryptoPanic + Binance 价格异动 + Funding Rate
// 每 2 分钟轮询，去重后输出到 data/news-queue.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { CONFIG, getActiveKeywords } from './config.mjs';

const DATA_DIR = CONFIG.dataDir;
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ============ 智能代理（连通性探测判断）============
// 默认走直连；本机被墙时通过 HTTPS_PROXY 显式指定代理
const PROXY = process.env.HTTPS_PROXY || '';
const PROBE_URL = 'https://api.binance.com/api/v3/ping';
const PROBE_INTERVAL = 5 * 60 * 1000; // 缓存5分钟

let _directWorks = null;
let _directCheckedAt = 0;

async function checkDirectConnectivity() {
  if (_directWorks !== null && Date.now() - _directCheckedAt < PROBE_INTERVAL) {
    return _directWorks;
  }
  try {
    const res = await fetch(PROBE_URL, { signal: AbortSignal.timeout(3000) });
    _directWorks = res.ok;
  } catch {
    _directWorks = false;
  }
  _directCheckedAt = Date.now();
  console.log(`🌐 直连探测: ${_directWorks ? '✅ 可直连，不走代理' : '❌ 直连失败，走代理'}`);
  return _directWorks;
}

async function smartFetch(url, options = {}) {
  if (await checkDirectConnectivity()) {
    return fetch(url, options);
  }
  // 走 ClashX 代理
  const headers = { 'User-Agent': 'Mozilla/5.0', ...options.headers };
  const headerFlags = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ');
  const cmd = `curl -s --max-time 30 -x "${PROXY}" ${headerFlags} "${url}"`;
  const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  return {
    ok: true,
    text: () => Promise.resolve(result),
    json: () => Promise.resolve(JSON.parse(result)),
  };
}

// ============ 去重状态管理 ============
function loadSeen() {
  try {
    return JSON.parse(readFileSync(CONFIG.stateFile, 'utf8'));
  } catch {
    return { hashes: {}, lastCleanup: Date.now() };
  }
}

function saveSeen(seen) {
  // 清理 24 小时前的记录
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const cleaned = {};
  for (const [k, v] of Object.entries(seen.hashes)) {
    if (v > cutoff) cleaned[k] = v;
  }
  seen.hashes = cleaned;
  seen.lastCleanup = Date.now();
  writeFileSync(CONFIG.stateFile, JSON.stringify(seen, null, 2));
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return 'h' + Math.abs(h).toString(36);
}

function isDuplicate(seen, text) {
  const h = hash(text.toLowerCase().slice(0, 200));
  if (seen.hashes[h]) return true;
  seen.hashes[h] = Date.now();
  return false;
}

// ============ 关键词过滤 ============
function matchesKeywords(text) {
  const lower = text.toLowerCase();
  return getActiveKeywords().some(kw => lower.includes(kw));
}

// ============ RSS 抓取 ============
async function fetchRSS(url) {
  try {
    const res = await smartFetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
    });
    const xml = await res.text();
    // 解析 RSS <item>
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s)?.[1]
                 || block.match(/<title>(.*?)<\/title>/s)?.[1] || '';
      const link = block.match(/<link>(.*?)<\/link>/s)?.[1]?.trim() || '';
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/s)?.[1]?.trim() || '';
      const desc = block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s)?.[1]
                || block.match(/<description>(.*?)<\/description>/s)?.[1] || '';
      // 提取图片 URL（多种 RSS 图片格式）
      const mediaContent = block.match(/<media:content[^>]*url="([^"]+)"[^>]*>/)?.[1];
      const enclosure = block.match(/<enclosure[^>]*url="([^"]+)"[^>]*>/)?.[1];
      const mediaThumbnail = block.match(/<media:thumbnail[^>]*url="([^"]+)"[^>]*>/)?.[1];
      const contentEncoded = block.match(/<content:encoded><!\[CDATA\[<img[^>]+src="([^"]+)"/)?.[1]
                             || block.match(/<content:encoded>(?:<img[^>]+src="([^"]+)")/)?.[1];
      const descImg = desc.match(/<img[^>]+src="([^"]+)"/)?.[1];
      const imageUrl = mediaContent || enclosure || mediaThumbnail || contentEncoded || descImg || '';
      items.push({ title: title.trim(), link, pubDate, description: desc.replace(/<[^>]+>/g, '').trim().slice(0, 500), imageUrl });
    }
    return items;
  } catch (e) {
    console.error(`  ❌ RSS fetch failed: ${url} — ${e.message}`);
    return [];
  }
}

// ============ CryptoPanic 抓取 ============
async function fetchCryptoPanic() {
  if (!CONFIG.cryptoPanic.token) {
    return []; // 未配置 token，跳过
  }
  try {
    const params = new URLSearchParams({
      auth_token: CONFIG.cryptoPanic.token,
      kind: CONFIG.cryptoPanic.kind,
      filter: CONFIG.cryptoPanic.filter,
    });
    const res = await smartFetch(`${CONFIG.cryptoPanic.url}?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return (data.results || []).map(p => ({
      title: p.title,
      link: p.url,
      pubDate: p.published_at,
      description: (p.body || '').replace(/<[^>]+>/g, '').trim().slice(0, 500),
      source: p.source?.title || 'CryptoPanic',
    }));
  } catch (e) {
    console.error(`  ❌ CryptoPanic fetch failed: ${e.message}`);
    return [];
  }
}

// ============ Binance 价格监控 ============
let priceHistory = {}; // { BTCUSDT: [{ price, ts }], ... }

async function checkBinancePrice() {
  const alerts = [];
  for (const symbol of CONFIG.binance.symbols) {
    try {
      const res = await smartFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      const price = parseFloat(data.lastPrice);
      const changePct = parseFloat(data.priceChangePercent);

      // 检查 24h 涨跌幅
      if (Math.abs(changePct) >= CONFIG.binance.priceAlertThreshold) {
        const dir = changePct > 0 ? '📈' : '📉';
        alerts.push({
          type: 'price_alert',
          symbol,
          title: `${symbol.replace('USDT', '')} ${dir} 24h ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`,
          price,
          changePct,
          description: `${symbol} 当前价格 $${price.toLocaleString()}, 24h涨跌 ${changePct.toFixed(2)}%`,
          source: 'Binance',
          pubDate: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error(`  ❌ Binance price failed: ${symbol} — ${e.message}`);
    }
  }
  return alerts;
}

// ============ Binance Funding Rate ============
async function checkFundingRate() {
  const alerts = [];
  for (const symbol of CONFIG.binance.symbols) {
    try {
      const res = await smartFetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      const rate = parseFloat(data.lastFundingRate);
      const annualized = rate * 3 * 365 * 100; // 年化百分比

      if (rate >= CONFIG.binance.fundingAlertThreshold) {
        alerts.push({
          type: 'funding_alert_long',
          symbol,
          title: `${symbol.replace('USDT', '')} 资金费率过高 (${annualized.toFixed(1)}% 年化) — 多头拥挤`,
          rate,
          annualized,
          description: `${symbol} 资金费率 ${(rate * 100).toFixed(4)}%, 年化 ${annualized.toFixed(1)}%, 多头持仓拥挤，存在踩踏风险`,
          source: 'Binance Futures',
          pubDate: new Date().toISOString(),
        });
      } else if (rate <= CONFIG.binance.fundingNegativeThreshold) {
        alerts.push({
          type: 'funding_alert_short',
          symbol,
          title: `${symbol.replace('USDT', '')} 资金费率为负 (${annualized.toFixed(1)}% 年化) — 空头拥挤`,
          rate,
          annualized,
          description: `${symbol} 资金费率 ${(rate * 100).toFixed(4)}%, 年化 ${annualized.toFixed(1)}%, 空头持仓拥挤，轧空风险上升`,
          source: 'Binance Futures',
          pubDate: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error(`  ❌ Funding rate failed: ${symbol} — ${e.message}`);
    }
  }
  return alerts;
}

// ============ Binance Square News API ============
// 币安广场官方新闻，平均6分钟一条，比RSS快5-10倍

async function fetchBinanceSquareNews() {
  try {
    const res = await smartFetch('https://www.binance.com/bapi/composite/v4/friendly/pgc/feed/news/list?strategy=10', {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    const data = await res.json();
    const items = data?.data?.vos || [];
    const results = [];
    for (const item of items.slice(0, 20)) {
      const title = item.title || '';
      const subTitle = (item.subTitle || '').replace(/<[^>]+>/g, '').trim().slice(0, 500);
      const ts = item.date || 0;
      const ageMin = (Date.now() / 1000 - ts) / 60;
      // 只取 3 小时内的新闻
      if (ageMin > 180 || ageMin < 0) continue;
      
      results.push({
        title,
        link: item.webLink || `https://www.binance.com/en/square/post/${item.id}`,
        pubDate: new Date(ts * 1000).toISOString(),
        description: subTitle,
        source: 'Binance Square',
        priority: ageMin < 30 ? 4 : ageMin < 60 ? 3 : 2, // 新鲜度加分
        binanceId: item.id,
        author: item.authorName || 'Binance News',
      });
    }
    return results;
  } catch (e) {
    console.error(`  ❌ Binance Square News failed: ${e.message}`);
    return [];
  }
}

// ============ 新闻队列管理 ============
function loadQueue() {
  try {
    return JSON.parse(readFileSync(`${DATA_DIR}/news-queue.json`, 'utf8'));
  } catch { return []; }
}

function saveQueue(queue) {
  // 只保留最近 100 条未处理
  const pending = queue.filter(n => !n.interpreted);
  const interpreted = queue.filter(n => n.interpreted).slice(-50);
  writeFileSync(`${DATA_DIR}/news-queue.json`, JSON.stringify([...pending, ...interpreted], null, 2));
}

// ============ 主循环 ============
async function pollRSS(seen, queue) {
  console.log('📰 Polling RSS feeds...');
  let added = 0;

  // 并行抓取所有 RSS
  const allFeeds = await Promise.all(
    CONFIG.rssSources.map(async src => {
      const items = await fetchRSS(src.url);
      return items.map(item => ({ ...item, source: src.name, priority: src.priority }));
    })
  );

  for (const items of allFeeds) {
    for (const item of items) {
      if (!matchesKeywords(item.title + ' ' + item.description)) continue;
      if (isDuplicate(seen, item.title)) continue;

      queue.push({
        id: hash(item.title + Date.now()),
        type: 'rss',
        ...item,
        addedAt: new Date().toISOString(),
        interpreted: false,
      });
      added++;
    }
  }

  // CryptoPanic
  const cpItems = await fetchCryptoPanic();
  for (const item of cpItems) {
    if (!matchesKeywords(item.title)) continue;
    if (isDuplicate(seen, item.title)) continue;

    queue.push({
      id: hash(item.title + Date.now()),
      type: 'cryptopanic',
      ...item,
      addedAt: new Date().toISOString(),
      interpreted: false,
    });
    added++;
  }

  // Binance Square News（最快的新闋源）
  const bnItems = await fetchBinanceSquareNews();
  for (const item of bnItems) {
    if (!matchesKeywords(item.title + ' ' + item.description)) continue;
    if (isDuplicate(seen, item.title)) continue;
    queue.push({
      id: hash(item.title + Date.now()),
      type: 'binance_square',
      ...item,
      addedAt: new Date().toISOString(),
      interpreted: false,
    });
    added++;
  }
  
  console.log(`  ✅ RSS+BIN: ${added} new articles added`);
  return added;
}

async function pollBinance(seen, queue) {
  console.log('📊 Checking Binance price + funding...');
  let added = 0;

  // 价格异动
  const priceAlerts = await checkBinancePrice();
  for (const alert of priceAlerts) {
    if (isDuplicate(seen, alert.title)) continue;
    queue.push({
      id: hash(alert.title + Date.now()),
      ...alert,
      addedAt: new Date().toISOString(),
      interpreted: false,
    });
    added++;
    console.log(`  🚨 ${alert.title}`);
  }

  // 资金费率
  const fundingAlerts = await checkFundingRate();
  for (const alert of fundingAlerts) {
    if (isDuplicate(seen, alert.title)) continue;
    queue.push({
      id: hash(alert.title + Date.now()),
      ...alert,
      addedAt: new Date().toISOString(),
      interpreted: false,
    });
    added++;
    console.log(`  💰 ${alert.title}`);
  }

  return added;
}

async function main() {
  console.log(`\n🤖 News Monitor started at ${new Date().toISOString()}`);
  console.log(`   RSS interval: ${CONFIG.intervals.rss / 1000}s`);
  console.log(`   Binance interval: ${CONFIG.intervals.binanceTicker / 1000}s`);
  console.log(`   GLM model: ${CONFIG.glm.model}`);

  const seen = loadSeen();
  let queue = loadQueue();

  // 首次立即执行
  await pollRSS(seen, queue);
  await pollBinance(seen, queue);
  saveQueue(queue);
  saveSeen(seen);

  console.log(`\n📋 Queue: ${queue.filter(n => !n.interpreted).length} pending, ${queue.filter(n => n.interpreted).length} interpreted`);

  // 定时轮询
  setInterval(async () => {
    await pollRSS(seen, queue);
    saveQueue(queue);
    saveSeen(seen);
  }, CONFIG.intervals.rss);

  setInterval(async () => {
    await pollBinance(seen, queue);
    saveQueue(queue);
    saveSeen(seen);
  }, CONFIG.intervals.binanceTicker);

  setInterval(async () => {
    await checkFundingRate();
    saveQueue(queue);
    saveSeen(seen);
  }, CONFIG.intervals.fundingRate);

  console.log('\n✅ Monitor running. Press Ctrl+C to stop.\n');
}

main().catch(console.error);
