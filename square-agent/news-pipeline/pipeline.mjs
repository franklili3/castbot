#!/usr/bin/env node
// pipeline.mjs - 新闻管道: LLM评分 → LLM生成 → Telegram推送
// 从 news-queue.json 读取采集到的新闻，每条过LLM评分，
// 筛选 critical/high 后调用LLM生成内容，推送到Telegram供审核
//
// 用法:
//   node pipeline.mjs           # 单次运行
//   node pipeline.mjs --watch   # 守护模式:每5分钟一轮

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import crypto from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { CONFIG, getActiveKeywords, getCoinsText, getActiveSymbols } from './config.mjs';
import { isDuplicate as isDupGlobal, markProcessed as markGlobal } from '../../scripts/dedup.mjs';
import { buildPrompt as buildFromTemplate } from '../../scripts/templates.mjs';
import paths, { tmpFile } from '../src/paths.mjs';

// 代理(可选)：本机被墙时通过 HTTPS_PROXY 走 ClashX/V2Ray；VPS 直连时留空
const PROXY = process.env.HTTPS_PROXY || '';
console.log(`🔗 Proxy(Telegram): ${PROXY || '(direct)'}`);

// 审核模式缓存
let _reviewMode = null;
let _reviewModeTs = 0;
let _userSettings = null;
async function getReviewMode() {
  // 缓存60秒
  if (Date.now() - _reviewModeTs < 60_000 && _userSettings) return _reviewMode;
  try {
    const res = await fetch('http://127.0.0.1:3100/api/user/by-token?token=bsq_mq8uu7h2_h61diu', {
      headers: { 'x-api-key': 'binsquare-dev-key-2026' },
    });
    const data = await res.json();
    _userSettings = data?.user || null;
    _reviewMode = _userSettings?.review_mode || 'manual';
    // 同步 DB 中的 language/coins 到 CONFIG（DB 优先于环境变量）
    if (_userSettings?.language) CONFIG.language = _userSettings.language;
    if (_userSettings?.coins) CONFIG.coins = _userSettings.coins.split(',').map(s => s.trim().toUpperCase());
  } catch { _reviewMode = 'manual'; }
  _reviewModeTs = Date.now();
  return _reviewMode;
}

// 将评分分类映射为广场话题标签
const CATEGORY_TOPIC_MAP = [
  [/etf/i, 'ETF'],
  [/安全|黑客/i, '安全事件'],
  [/sec|监管|执法/i, 'SEC'],
  [/fomc|议息|会议/i, '美联储会议'],
  [/降息/i, '美联储降息'],
  [/加息/i, '美联储加息'],
  [/联储|利率/i, '美联储利率'],
  [/cpi|非农|宏观|就业|gdp/i, '宏观经济'],
  [/地缘|冲突|战争/i, '地缘政治'],
  [/油价|oil/i, '宏观经济'],
  [/爆仓|清仓|暴跌|volat/i, '市场波动'],
  [/价格|行情|price/i, '行情分析📈'],
  [/技术|升级|fork/i, 'FORK'],
  [/defi|dapp/i, 'DeFi'],
  [/nft/i, 'NFT'],
  [/layer|l1|l2/i, 'Layer2'],
  [/稳定币|stablecoin/i, '稳定币'],
  [/矿|mining/i, '矿业公司动态'],
  [/分析师|预测|analyst/i, '市场分析'],
  [/行业|数据|milestone/i, '行业活动'],
  [/机构|institutional/i, '机构动向'],
];

function deriveTopics(scoreInfo, item) {
  const topics = new Set();
  const coins = scoreInfo?.coins || [];
  if (coins.length > 0) {
    for (const coin of coins.slice(0, 3)) topics.add(String(coin).toUpperCase());
  } else {
    const sym = item?.symbol?.replace('USDT', '').toUpperCase();
    topics.add(sym || 'BTC');
  }
  const cat = (scoreInfo?.category || '').trim();
  if (cat) {
    let matched = false;
    for (const [re, tag] of CATEGORY_TOPIC_MAP) {
      if (re.test(cat)) { topics.add(tag); matched = true; break; }
    }
    if (!matched && cat.length <= 8) topics.add(cat.replace(/\s+/g, ''));
  }
  return [...topics].join(',');
}

// 自动发布：直接写入 bot DB
async function autoPublishToBotDB(content, imageUrl = null, topics = null) {
  try {
    const body = { userId: 3, content, topics: topics || 'BTC', status: 'approved' };
    if (imageUrl) body.imageUrl = imageUrl;
    const res = await fetch('http://127.0.0.1:3100/api/content/insert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'binsquare-dev-key-2026' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data?.ok ? data.id : null;
  } catch (e) {
    console.error('Auto-publish failed:', e.message);
    return null;
  }
}

// 代理版 fetch 封装（仅用于 Telegram API；GLM API 是国内端点直连）
async function proxyFetch(url, options = {}) {
  const method = options.method || 'GET';
  const cmd = `curl -s --max-time 30 -x "${PROXY}" "${url}"`;
  if (method === 'POST' && options.body) {
    const tmpPath = tmpFile('pipeline-fetch') + '.json';
    writeFileSync(tmpPath, options.body);
    const result = execSync(`${cmd} -X POST -H "Content-Type: application/json" -d @${tmpPath}`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    try { unlinkSync(tmpPath); } catch {}
    return { json: () => Promise.resolve(JSON.parse(result)), ok: true };
  }
  const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  return { json: () => Promise.resolve(JSON.parse(result)), ok: true, text: () => Promise.resolve(result) };
}

const DATA_DIR = CONFIG.dataDir;
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ============ pipeline-state.json（已处理记录）============
function loadState() {
  try { return JSON.parse(readFileSync(`${DATA_DIR}/pipeline-state.json`, 'utf8')); }
  catch { return { processed: [], outputs: [] }; }
}
function saveState(q) {
  q.processed = q.processed.slice(-500);
  q.outputs = q.outputs.slice(-200);
  writeFileSync(`${DATA_DIR}/pipeline-state.json`, JSON.stringify(q, null, 2));
}

// ============ 从 news-queue.json 读取待评条目 ============
function collectFromQueue(processedSet) {
  try {
    const queue = JSON.parse(readFileSync(`${DATA_DIR}/news-queue.json`, 'utf8'));
    const now = Date.now() / 1000;
    return (Array.isArray(queue) ? queue : [])
      .filter(item => item.interpreted === false)
      .filter(item => item.id && !processedSet.has(item.id))
      .filter(item => {
        let ts = item.timestamp || item.date;
        if (!ts && item.addedAt) ts = new Date(item.addedAt).getTime() / 1000;
        if (!ts && item.pubDate) ts = new Date(item.pubDate).getTime() / 1000;
        const ageMin = ts ? (now - ts) / 60 : 0;
        return ageMin >= 0 && ageMin < 180; // 3小时内
      });
  } catch (e) {
    console.log(`  ⚠️ 读取 news-queue.json 失败: ${e.message}`);
    return [];
  }
}

// ============ GLM JWT ============
function generateJWT(apiKey) {
  const [id, secret] = apiKey.split('.');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' })).toString('base64url');
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ api_key: id, exp: now + 3600000, timestamp: now })).toString('base64url');
  const sign = crypto.createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + sign;
}

// ============ LLM 批量评分（每条标题过LLM判断对BTC/ETH的重要性）============
async function scoreWithLLM(items) {
  if (!items.length) return [];

  const token = generateJWT(CONFIG.glm.apiKey);
  const BATCH = 10;

  const coinsText = getCoinsText();
  const coinsList = CONFIG.coins.join(', ');
  const systemPrompt = `你是加密货币新闻分析师，评估每条新闻对 ${coinsList} 价格的影响。
对每条新闻返回JSON评分。

评分标准（按对 ${coinsText} 价格影响程度）：
- critical(90-100): 直接重大影响 — ETF获批/否决, 重大黑客(>1亿美元), SEC重大执法, FOMC利率决议, 重大地缘冲突
- high(70-89): 间接重要影响 — 宏观数据(CPI/非农), 大额爆仓, 机构大额买入/卖出, 重大技术升级
- normal(40-69): 一般影响 — 常规分析, 小币种消息, 中等鲸鱼异动
- low(0-39): 噪音 — 活动推广, 问答游戏, 非加密相关, 贵金属常规波动

返回纯JSON数组，不要markdown代码块：
[{"i":0,"s":85,"t":"high","c":"ETF","r":"现货ETF资金流入","d":"bullish","co":["${CONFIG.coins[0]}"]}]

字段含义：i=序号 s=分数(0-100) t=等级(critical/high/normal/low) c=分类 r=一句话理由 d=方向(bullish利空/bearish利空/neutral中性) co=受影响币种数组(coins范围: ${CONFIG.coins.join(', ')})`;

  const results = [];

  for (let batchStart = 0; batchStart < items.length; batchStart += BATCH) {
    const batch = items.slice(batchStart, batchStart + BATCH);
    const userPrompt = `逐条评分（只看标题判断对 ${coinsText} 的影响）：\n` +
      batch.map((item, i) => `[${i}] ${item.title}`).join('\n');

    const _t0 = Date.now();
    console.log(`  🤖 [LLM评分] → ${CONFIG.glm.model} | ${batch.length}条 | batch ${Math.floor(batchStart / BATCH) + 1}`);

    try {
      const res = await fetch(CONFIG.glm.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          model: CONFIG.glm.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content || '';
      const _dur = Date.now() - _t0;
      const _usage = data.usage || {};
      console.log(`  🤖 [LLM评分] ✓ ${_dur}ms | tokens:${_usage.total_tokens || '?'}`);

      // 解析JSON（容错：去掉可能的markdown代码块标记）
      const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const scores = JSON.parse(jsonStr);

      for (const s of scores) {
        const idx = s.i ?? s.index;
        if (idx >= 0 && idx < batch.length) {
          results.push({
            item: batch[idx],
            score: s.s ?? s.score ?? 0,
            tier: s.t ?? s.tier ?? 'low',
            category: s.c ?? s.category ?? '',
            reason: s.r ?? s.reason ?? '',
            direction: s.d ?? s.direction ?? 'neutral',
            coins: s.co ?? s.coins ?? ['BTC'],
          });
        }
      }
    } catch (e) {
      console.log(`  ⚠️ LLM评分失败: ${e.message.substring(0, 80)}`);
      for (const item of batch) {
        results.push({ item, score: 0, tier: 'low', category: 'error', reason: 'LLM评分失败' });
      }
    }
  }

  return results;
}

// ============ 价格一致性校验 ============
// 防止 LLM 从新闻标题引用过时价格，强制使用 marketContext 的实时数据
// 解析: "BTC: $59,298.01 (24h -0.96%)" → { BTC: 59298.01 }
function parseMarketPrices(marketContext) {
  const prices = {};
  if (!marketContext || marketContext.includes('获取失败')) return prices;
  for (const line of marketContext.split('\n')) {
    const m = line.match(/^([A-Z]+):\s*\$([\d,]+(?:\.\d+)?)/);
    if (m) prices[m[1]] = parseFloat(m[2].replace(/,/g, ''));
  }
  return prices;
}

// 扫描正文 $价格，找出与实时行情偏差 > tolerancePct 的项
// 仅当引用价"距某币种实际价 30% 以内"才判为该币种价格误报
// （避免误伤 $150M 市值、$316M ETF 流出等非价格数字）
function findPriceDeviations(content, marketPrices, tolerancePct = 2) {
  const violations = [];
  if (!content || Object.keys(marketPrices).length === 0) return violations;
  const re = /\$([\d,]+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const mentioned = parseFloat(m[1].replace(/,/g, ''));
    for (const [coin, actual] of Object.entries(marketPrices)) {
      const relDiff = Math.abs(mentioned - actual) / actual;
      if (relDiff <= 0.30 && relDiff > tolerancePct / 100) {
        violations.push({
          mentioned, actual, coin,
          deviationPct: (relDiff * 100).toFixed(1),
        });
        break; // 归因到第一个匹配币种
      }
    }
  }
  return violations;
}

// 剥离模型把 prompt 指令原样回吐进正文的情况
// 合法帖子以「不构成投资建议」结尾；该行之后的内容一律视为泄漏的指令并丢弃
// （例如回吐的 priceHint、模板里的「代币：/话题：」指令块）
// 关键：必须在价格校验前调用，否则模型可借回吐 priceHint 里的正确价格"作弊"通过校验
function stripPromptLeakage(content) {
  if (!content) return content;
  const idx = content.lastIndexOf('不构成投资建议');
  if (idx === -1) return content; // 找不到免责声明：不强行截断，交由其他校验处理
  const lineEnd = content.indexOf('\n', idx);
  return lineEnd === -1 ? content : content.slice(0, lineEnd);
}

// ============ LLM 内容生成 ============
async function interpretNews(item, marketContext, scoreInfo = null) {
  const token = generateJWT(CONFIG.glm.apiKey);
  const isPriceAlert = item.type === 'price_alert' || item.type === 'funding_alert_long' || item.type === 'funding_alert_short';

  const tplType = isPriceAlert ? 'price_move' : 'breaking_news';
  const { system, user } = buildFromTemplate(tplType, {
    title: item.title,
    desc: item.description || item.title,
    source: item.source,
    symbol: item.symbol,
    change: item.changePct,
    marketCtx: marketContext,
  });

  const MIN_CONTENT_LEN = 150; // 最小内容长度，低于此重试
  const marketPrices = parseMarketPrices(marketContext);

  let _content = '';
  let _usage = {};
  let _dur = 0;
  let priceHint = '';

  // 方向提示：把评分阶段判定的方向传给生成 LLM，避免正文观点与预测方向矛盾
  const dirHint = scoreInfo?.direction
    ? `\n\n⚠️ 方向提示：评分系统判定此新闻为${scoreInfo.direction === 'bullish' ? '利多（看涨）' : scoreInfo.direction === 'bearish' ? '利空（看跌）' : '中性'}，请确保正文观点与此方向一致，不要写出与此方向矛盾的涨跌描述。`
    : '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const _t0 = Date.now();
    const userMsg = user + dirHint + priceHint;
    console.log(`    🤖 [LLM生成] → ${CONFIG.glm.model} | attempt=${attempt} | prompt=${system.length + userMsg.length}字符 | ${item.title.slice(0, 40)}`);

    const res = await fetch(CONFIG.glm.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ model: CONFIG.glm.model, messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }], temperature: attempt === 1 ? 0.8 : 0.9, max_tokens: 2048 }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json();
    _dur = Date.now() - _t0;
    _content = data.choices?.[0]?.message?.content || '';
    _usage = data.usage || {};

    // 先剥离回吐的 prompt 指令（priceHint / 模板指令块），防止泄漏进正文
    // 也防止模型借回吐的正确价格绕过价格校验
    _content = stripPromptLeakage(_content);

    // 去掉标题行后的正文长度
    const bodyLen = _content.replace(/^📰.*\n?/m, '').replace(/^#+\s.*\n?/m, '').trim().length;
    if (bodyLen < MIN_CONTENT_LEN) {
      console.log(`    ⚠️ [LLM生成] 内容过短(${bodyLen}字符), attempt=${attempt}/3 重试...`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // 价格一致性校验：禁止从新闻标题引用价格，必须用实时行情
    const deviations = findPriceDeviations(_content, marketPrices);
    if (deviations.length === 0) {
      console.log(`    🤖 [LLM生成] ✓ ${_content.length}字符 (正文${bodyLen}) | tokens:${_usage.total_tokens || '?'} | ${_dur}ms`);
      break;
    }
    const summary = deviations.map(v => `${v.coin} $${v.mentioned.toLocaleString()}≠$${v.actual.toLocaleString()}(${v.deviationPct}%)`).join('; ');
    console.log(`    ⚠️ [价格校验] 偏差过大 attempt=${attempt}/3: ${summary}`);
    if (attempt < 3) {
      priceHint = `\n\n⚠️ 价格更正（上次输出含错误价格）。以下为实时行情，必须且只能使用这些数字，禁止从新闻标题或正文引用任何价格：\n` +
        Object.entries(marketPrices).map(([c, p]) => `- ${c} 当前价格: $${p.toLocaleString()}`).join('\n');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // 重试后仍含错误价格 → 拒绝发布（避免误导读者，与合规拦截一致）
  const finalDeviations = findPriceDeviations(_content, marketPrices);
  if (finalDeviations.length > 0) {
    const summary = finalDeviations.map(v => `${v.coin} $${v.mentioned.toLocaleString()}≠$${v.actual.toLocaleString()}`).join('; ');
    console.log(`    🚫 [价格校验] 3 次重试仍含错误价格，拒绝发布: ${summary}`);
    return null;
  }

  // 非 BTC/ETH 的预判段直接删除（只有 BTC/ETH 才有影响预判）
  if (_content && _content.includes('影响预判')) {
    const _predCoinLine = _content.match(/币种[：:]([^\n]+)/);
    if (_predCoinLine) {
      const _predCoins = (_predCoinLine[1].match(/[A-Za-z]+/g) || []).map(c => c.toUpperCase());
      if (!_predCoins.includes('BTC') && !_predCoins.includes('ETH')) {
        _content = _content.replace(/\n*🎯 影响预判\n- 币种[：:][^\n]*\n- 方向[：:][^\n]*\n- 时长[：:][^\n]*/g, '');
        console.log(`    🔧 [后处理] 删除非BTC/ETH预判段 (${_predCoins.join('/')})`);
      }
    }
  }

  // 后处理：如果 LLM 没按格式输出「影响预判」，从评分结果推断并补上（仅 BTC/ETH）
  if (_content && !_content.includes('影响预判')) {
    const score = scoreInfo || item._scoreInfo;
    if (score) {
      const isBullish = score.direction === 'bullish' || (score.sentiment && score.sentiment > 0);
      const direction = isBullish ? '利多📈 预测涨' : '利空📉 预测跌';
      let coins = (score.coins || (item.symbol ? [item.symbol] : ['BTC'])).slice(0, 3);
      // 只有 BTC/ETH 才有影响预判
      coins = coins.filter(c => ['BTC', 'ETH'].includes(String(c).toUpperCase()));
      if (coins.length > 0) {
        const PRED_DURATION = { BTC: '12小时', ETH: '24小时' };
        const durations = coins.map(c => PRED_DURATION[String(c).toUpperCase()] || '4小时');
        const uniqDurations = [...new Set(durations)];
        const durationLine = uniqDurations.length === 1
          ? `时长：${durations[0]}`
          : `时长：${coins.map((c, i) => `${String(c).toUpperCase()} ${durations[i]}`).join(' / ')}`;
        const pred = `\n\n🎯 影响预判\n- 币种：${coins.join('/')}\n- 方向：${direction}\n- ${durationLine}`;
        // 插入到「⚠️ 不构成投资建议」之前
        if (_content.includes('⚠️ 不构成投资建议')) {
          _content = _content.replace('⚠️ 不构成投资建议', pred + '\n\n⚠️ 不构成投资建议');
        } else if (_content.includes('⚠️')) {
          _content = _content.replace(/⚠️[^\n]*$/, pred + '\n\n⚠️ 不构成投资建议，预测仅供参考');
        } else {
          _content += pred + '\n\n⚠️ 不构成投资建议，预测仅供参考';
        }
        console.log(`    🔧 [后处理] 补充影响预判段: ${direction} | ${coins.join('/')}`);
      }
    }
  }

  // 预判次数注入（与 content-engine 一致）
  if (_content && _content.includes('影响预判')) {
    try {
      const counterPath = paths.predictionCounter;
      const counter = JSON.parse(readFileSync(counterPath, 'utf8'));
      counter.count += 1;
      counter.updated_at = new Date().toISOString();
      writeFileSync(counterPath, JSON.stringify(counter));
      _content = _content.replace('🎯 影响预判', `🎯 第${counter.count}次预判`);
      console.log(`    🔧 [后处理] 预判次数: 第${counter.count}次`);
    } catch (e) {
      console.log(`    ⚠️ 预判次数注入失败: ${e.message}`);
    }
  }

  // 时长强制覆盖（LLM 默认 4 小时 → BTC 12h / ETH 24h）
  if (_content && _content.includes('时长')) {
    const _predDur = { BTC: '12小时', ETH: '24小时' };
    const _coinLine = _content.match(/币种[：:]([^\n]+)/);
    if (_coinLine) {
      const _coins = [...new Set((_coinLine[1].match(/[A-Za-z]+/g) || []).map(c => c.toUpperCase()))];
      if (_coins.length > 0) {
        const _durations = _coins.map(c => _predDur[c] || '4小时');
        const _uniqDur = [...new Set(_durations)];
        const _durLine = _uniqDur.length === 1
          ? `时长：${_durations[0]}`
          : `时长：${_coins.map((c, i) => `${c} ${_durations[i]}`).join(' / ')}`;
        const _before = _content.match(/- 时长：[^\n]+/)?.[0];
        _content = _content.replace(/- 时长：[^\n]+/, `- ${_durLine}`);
        if (_before && _before !== `- ${_durLine}`) {
          console.log(`    🔧 [后处理] 时长覆盖: ${_before} → - ${_durLine}`);
        }
      }
    }
  }

  // 方向一致性检查：从正文关键词推断涨跌，覆盖与正文矛盾的预测方向
  if (_content && (_content.includes('预测涨') || _content.includes('预测跌'))) {
    // 取正文（排除预判段和免责声明）
    const _body = _content.replace(/🎯[^\n]*预判[\s\S]*$/, '').replace(/⚠️[^\n]*$/, '');
    const _bull = (_body.match(/涨超|暴涨|大涨|上涨|看涨|利好|飙升|拉升|走强|新高|带飞|pump|bullish/gi) || []).length;
    const _bear = (_body.match(/暴跌|大跌|下跌|看跌|利空|跳水|走弱|新低|泼冷水|dump|bearish/gi) || []).length;
    if (_bull > 0 || _bear > 0) {
      const _inferredBull = _bull >= _bear;
      const _currentBull = _content.includes('预测涨');
      if (_inferredBull !== _currentBull) {
        const _newDir = _inferredBull ? '利多📈 预测涨' : '利空📉 预测跌';
        const _oldDir = _currentBull ? '利多📈 预测涨' : '利空📉 预测跌';
        _content = _content.replace(/方向[：:][^\n]+/, `方向：${_newDir}`);
        console.log(`    🔧 [后处理] 方向修正: ${_oldDir} → ${_newDir} (正文: 涨${_bull}/跌${_bear})`);
      }
    }
  }

  // 合规过滤
  try {
    const { complianceFilter } = await import('../src/compliance/index.mjs');
    const result = complianceFilter(_content, { platform: 'binance' });
    if (!result.passed) {
      console.log(`    🚫 [合规] 拒绝发布：${result.actions.join('; ')}`);
      return null; // 返回 null 表示内容被合规拦截
    }
    _content = result.content;
    if (result.actions.length > 0) {
      console.log(`    🛡️ [合规] ${result.actions.join('; ')}`);
    }
  } catch (e) {
    console.log(`    ⚠️ [合规] 过滤失败（跳过）：${e.message.substring(0, 60)}`);
  }

  console.log(`    🤖 [LLM生成] ✓ ${_content.length}字符 | tokens:${_usage.total_tokens || '?'} | ${_dur}ms`);
  return _content;
}

// ============ 行情上下文（供LLM生成参考）============
async function getMarketContext() {
  const symbols = getActiveSymbols();
  const tryFetch = async (useProxy) => {
    const results = [];
    for (const sym of symbols) {
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`;
      const data = useProxy
        ? JSON.parse(execSync(`curl -s --max-time 10 -x "${PROXY}" "${url}"`, { encoding: 'utf-8', maxBuffer: 1024*1024 }))
        : await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
      const coin = sym.replace('USDT', '');
      results.push(`${coin}: $${parseFloat(data.lastPrice).toLocaleString()} (24h ${parseFloat(data.priceChangePercent).toFixed(2)}%)`);
    }
    return results.join('\n');
  };
  try {
    return await tryFetch(false);
  } catch {
    try { return await tryFetch(true); } catch { return '行情数据获取失败'; }
  }
}

// ============ Telegram 推送 ============
// 纯文本推送（无按钮，用于 auto 模式通知）
async function pushTelegramText(chatId, text) {
  const res = await proxyFetch(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`, {
    method: 'POST',
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const d = await res.json();
  return d.ok;
}

async function pushToTelegram(item, content, chatId, scoreInfo) {
  const scoreBadge = scoreInfo ? `\n<b>评分:</b> ${scoreInfo.score}分 [${scoreInfo.tier}] ${scoreInfo.category}` : '';
  const text = `📰 <b>新闻快讯解读</b>\n<b>来源:</b> ${item.source || item.type}\n<b>原始标题:</b> ${item.title.slice(0, 100)}${scoreBadge}\n\n${content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 3500)}\n\n<i>⏰ ${new Date(item.addedAt || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</i>`;

  const keyboard = { inline_keyboard: [[
    { text: '✅ 发布到广场', callback_data: `pub:${item.id}` },
    { text: '❌ 丢弃', callback_data: `del:${item.id}` },
  ]]};

  const res = await proxyFetch(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`, {
    method: 'POST',
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard }),
  });
  const d = await res.json();
  return d.ok;
}

// ============ 主流程 ============
async function runCycle(chatId) {
  const q = loadState();
  const processedSet = new Set(q.processed);
  const now = new Date().toISOString();
  let newCount = 0;

  console.log(`\n[${now}] Cycle start`);

  // 1. 从 news-queue.json 读取待评条目
  const fresh = collectFromQueue(processedSet);
  console.log(`  📰 从 queue 读取: ${fresh.length} 条待评`);

  if (fresh.length === 0) {
    console.log('  ⏳ Nothing new. Waiting...');
    return 0;
  }

  // 2. LLM 批量评分（每条标题都过LLM）
  const scored = await scoreWithLLM(fresh);

  // 3. 筛选 critical + high
  const qualified = scored.filter(s => s.tier === 'critical' || s.tier === 'high');
  const filteredOut = scored.filter(s => s.tier !== 'critical' && s.tier !== 'high');

  for (const s of filteredOut) {
    console.log(`  🗑 LLM过滤(${s.tier} ${s.score}分): ${s.item.title.slice(0, 50)}`);
    markGlobal(s.item.title, 'news-pipeline', { filtered: 'low_score', score: s.score });
    q.processed.push(s.item.id);
  }

  console.log(`  ✅ ${qualified.length} 条 critical/high (淘汰 ${filteredOut.length} 条)`);

  if (qualified.length === 0) {
    saveState(q);
    return 0;
  }

  // 4. 获取行情上下文
  const marketCtx = await getMarketContext();
  console.log(`  📊 Market: ${marketCtx.split('\n')[0]}`);

  // 5. 逐条：去重 → LLM生成 → 推送Telegram（最多5条/轮）
  // 每日发帖上限检查
  const DAILY_LIMIT = 100;
  let todayCount = 0;
  try {
    const { execSync } = await import('child_process');
    todayCount = parseInt(execSync(`sqlite3 "${paths.botDb}" "SELECT COUNT(*) FROM posts WHERE date(created_at) = date('now', 'localtime');"`, { encoding: 'utf-8' }).trim()) || 0;
  } catch {}
  console.log(`  📊 今日已发布: ${todayCount}/${DAILY_LIMIT}`);
  if (todayCount >= DAILY_LIMIT) {
    console.log(`  🚫 达到每日上限 ${DAILY_LIMIT}，跳过本轮`);
    saveState(q);
    return 0;
  }
  const remaining = DAILY_LIMIT - todayCount;
  const toProcess = qualified.slice(0, Math.min(5, remaining));

  for (let i = 0; i < toProcess.length; i++) {
    const { item, score, tier, category } = toProcess[i];
    console.log(`  🧠 [${tier} ${score}分/${category}] ${item.title.slice(0, 50)}...`);

    // 全局去重
    if (isDupGlobal(item.title, 'news-pipeline')) {
      console.log(`    🔁 全局去重:跳过`);
      q.processed.push(item.id);
      continue;
    }

    try {
      const content = await interpretNews(item, marketCtx, { score, tier, category, direction: toProcess[i].direction, coins: toProcess[i].coins });
      if (content && content.length > 20) {
        console.log(`    ✅ ${content.length} chars`);
        const reviewMode = await getReviewMode();
        if (reviewMode === 'auto') {
          // 自动模式：直接入库，不发 TG 审核
          const _topics = deriveTopics({ score, tier, category, direction: toProcess[i].direction, coins: toProcess[i].coins }, item);
          const postId = await autoPublishToBotDB(content, item.imageUrl || null, _topics);
          console.log(`    🤖 Auto-published: #${postId || 'FAIL'} (${reviewMode})`);
          // 发简短 TG 通知（不带按钮）
          const shortMsg = postId
            ? `🤖 新闻已自动发布 #${postId}：${content.split('\n')[0].replace(/^[📰📊📋🔍💪🧠📐📚🔥💡❓⚠️#\s]+/, '').slice(0, 50)}`
            : `❌ 自动发布失败：${content.split('\n')[0].slice(0, 50)}`;
          try { await pushTelegramText(chatId, shortMsg); } catch (e) { console.error('TG notify failed:', e.message); }
        } else {
          const pushed = await pushToTelegram(item, content, chatId, { score, tier, category });
          console.log(`    📤 TG: ${pushed ? 'sent' : 'failed'} (${reviewMode})`);
        }
        markGlobal(item.title, 'news-pipeline', { source: item.source, score, tier });
        q.outputs.push({ ...item, score, tier, category, coins: toProcess[i].coins, direction: toProcess[i].direction, interpretedContent: content, interpretedAt: now });
        newCount++;
      } else {
        console.log(`    ⚠️ Empty response, skipping`);
      }
    } catch (e) {
      console.error(`    ❌ ${e.message}`);
    }

    q.processed.push(item.id);

    // 限流:每条间隔 3 秒
    if (i < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  saveState(q);
  console.log(`  ✅ Cycle done: ${newCount} new interpretations pushed`);
  return newCount;
}

// ============ CLI ============
async function main() {
  const chatId = CONFIG.telegram.chatId;
  const watchMode = process.argv.includes('--watch');

  console.log(`🤖 News Pipeline | GLM: ${CONFIG.glm.model} | TG: ${chatId}`);
  console.log(`   Mode: ${watchMode ? 'WATCH (daemon)' : 'ONCE'}`);

  if (!watchMode) {
    await runCycle(chatId);
    console.log('\n✅ Done.');
    return;
  }

  // 守护模式:每 5 分钟一轮
  console.log('   Interval: 5 min\n');
  await runCycle(chatId);
  setInterval(() => runCycle(chatId), 5 * 60 * 1000);
  console.log('\n✅ Watch mode running. Ctrl+C to stop.');
}

main().catch(console.error);
