// news-interpreter.mjs — AI 新闻解读引擎
// 从 news-queue.json 读取未处理的新闻，调用 GLM-5.1 生成解读
// 输出：3段式快讯（一句话新闻 + 影响判断 + 操作建议）

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { CONFIG, getActiveSymbols } from './config.mjs';

const DATA_DIR = CONFIG.dataDir;

// ============ GLM API 调用（智谱需要 JWT 签名）============
import crypto from 'crypto';

function generateJWT(apiKey) {
  const [id, secret] = apiKey.split('.');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' })).toString('base64url');
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ api_key: id, exp: now + 3600000, timestamp: now })).toString('base64url');
  const sign = crypto.createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + sign;
}

async function callGLM(messages) {
  const token = generateJWT(CONFIG.glm.apiKey);
  const url = `${CONFIG.glm.baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: CONFIG.glm.model,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GLM API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices[0]?.message?.content || '';
}

// ============ 行情数据 ============
async function getMarketContext() {
  const symbols = getActiveSymbols();
  try {
    const results = await Promise.all(
      symbols.map(sym => 
        fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`, { signal: AbortSignal.timeout(10000) })
          .then(r => r.json())
      )
    );
    const lines = results.map((data, i) => {
      const coin = symbols[i].replace('USDT', '');
      return `${coin}: $${parseFloat(data.lastPrice).toLocaleString()} (24h ${parseFloat(data.priceChangePercent).toFixed(2)}%)`;
    });
    let fearGreed = 50;
    try {
      const fgRes = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(5000) });
      const fgData = await fgRes.json();
      fearGreed = parseInt(fgData.data[0].value) || 50;
    } catch {}
    return lines.join('\n') + `\n恐惧贪婪指数: ${fearGreed}/100`;
  } catch {
    return '行情数据获取失败';
  }
}

// ============ 提示词模板 ============
function buildPrompt(newsItem, marketContext) {
  const isPriceAlert = newsItem.type === 'price_alert';
  const isFundingAlert = newsItem.type === 'funding_alert_long' || newsItem.type === 'funding_alert_short';

  if (isPriceAlert) {
    return {
      system: '你是一个有实战经验的加密货币交易员，在币安广场上写价格异动快讯。你的风格直接、有观点、不废话。',
      user: `写一条价格异动快讯，要求：

## 触发信号
${newsItem.title}
${newsItem.description}

## 当前行情
${marketContext}

## 输出格式（严格遵守）
${newsItem.symbol.replace('USDT', '')} 异动 ${newsItem.changePct >= 0 ? '📈' : '📉'}

📊 ${newsItem.symbol.replace('USDT', '')} $${newsItem.price.toLocaleString()} (24h ${newsItem.changePct >= 0 ? '+' : ''}${newsItem.changePct.toFixed(2)}%)

💡 {对这次异动的判断：是趋势还是噪音？市场在交易什么逻辑？}

🎯 {操作建议：关注什么点位，是追还是等回调}

⚠️ 不构成投资建议

## 规则
- 150-250 字
- 口语化，像交易员在群里发消息
- 不要用"值得关注""让我们看看""值得注意的是"等AI味词
- 有明确观点，不要模棱两可`,
    };
  }

  if (isFundingAlert) {
    return {
      system: '你是一个专注衍生品分析的加密货币交易员，在币安广场上写资金费率分析。风格犀利、数据驱动。',
      user: `写一条资金费率异动分析：

## 触发信号
${newsItem.title}
${newsItem.description}

## 当前行情
${marketContext}

## 输出格式
💰 ${newsItem.symbol.replace('USDT', '')} 资金费率异动

${newsItem.rate >= 0 ? '多头' : '空头'} 持仓拥挤 📊
年化费率: ${newsItem.annualized.toFixed(1)}%

{分析拥挤度，历史上这种情况意味着什么}

{操作建议：逆向交易者该怎么布局}

⚠️ 不构成投资建议

## 规则
- 150-200 字
- 直接给出观点
- 不要AI味`,
    };
  }

  // 默认：新闻解读
  return {
    system: '你是一个加密货币分析师，在币安广场上写新闻快讯解读。你的核心价值是速度+判断力——不仅要转述新闻，更要点出对市场的影响。风格像资深交易员在群里分享一条重要消息。',
    user: `写一条新闻快讯解读：

## 原始新闻
标题：${newsItem.title}
来源：${newsItem.source || '未知'}
内容：${newsItem.description || newsItem.title}

## 当前行情
${marketContext}

## 输出格式（严格遵守）
📰 {一句话概括，20字以内，要抓眼球}

{2-3句话转述新闻核心事实，加上自己的判断}

💡 影响：{利好/利空/中性 + 一句话原因}

🎯 关注：{这个消息意味着什么？交易者该关注什么指标/点位？}

⚠️ 不构成投资建议

## 规则
- 总长度 150-300 字
- 口语化、直接、有观点
- 绝对不要用"值得关注""让我们看看""值得注意的是""这可能"等AI味词
- 第一句话必须立刻抓住读者注意力
- 标题（📰 那行）要让人想点进来看`,
  };
}

// ============ 主处理循环 ============
function loadQueue() {
  try {
    return JSON.parse(readFileSync(`${DATA_DIR}/news-queue.json`, 'utf8'));
  } catch { return []; }
}

function saveQueue(queue) {
  writeFileSync(`${DATA_DIR}/news-queue.json`, JSON.stringify(queue, null, 2));
}

function loadInterpreted() {
  const path = `${DATA_DIR}/interpreted-news.json`;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return []; }
}

function saveInterpreted(interpreted) {
  // 只保留最近 200 条
  const trimmed = interpreted.slice(-200);
  writeFileSync(`${DATA_DIR}/interpreted-news.json`, JSON.stringify(trimmed, null, 2));
}

async function processOne(newsItem, marketContext) {
  const prompt = buildPrompt(newsItem, marketContext);
  const content = await callGLM([
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ]);
  return content.trim();
}

async function main() {
  console.log(`\n🧠 News Interpreter started at ${new Date().toISOString()}`);
  console.log(`   Model: ${CONFIG.glm.model}`);
  console.log(`   Endpoint: ${CONFIG.glm.baseUrl}`);

  // 单次模式：处理所有 pending 后退出
  // 守护模式：--watch 持续轮询
  const watchMode = process.argv.includes('--watch');

  async function processBatch() {
    const queue = loadQueue();
    const pending = queue.filter(n => !n.interpreted);

    if (pending.length === 0) {
      console.log('  ⏳ No pending news to interpret');
      return;
    }

    console.log(`\n📋 Processing ${pending.length} pending items...`);

    // 获取行情上下文（批量共享）
    const marketContext = await getMarketContext();
    console.log(`   Market: ${marketContext.split('\n')[0]}`);

    const interpreted = loadInterpreted();
    let processed = 0;
    let failed = 0;

    for (const item of pending) {
      try {
        console.log(`\n  📰 [${item.source || item.type}] ${item.title.slice(0, 60)}...`);
        const content = await processOne(item, marketContext);
        console.log(`  ✅ Generated ${content.length} chars`);

        // 保存解读结果
        interpreted.push({
          ...item,
          interpretedContent: content,
          interpretedAt: new Date().toISOString(),
          marketContext,
        });

        // 标记已处理
        item.interpreted = true;
        item.interpretedContent = content;
        processed++;

        // 间隔 2 秒避免限流
        if (processed < pending.length) await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`  ❌ Failed: ${e.message}`);
        item.interpreted = true;
        item.interpretedContent = null;
        item.error = e.message;
        failed++;
      }
    }

    saveQueue(queue);
    saveInterpreted(interpreted);

    console.log(`\n✅ Done: ${processed} interpreted, ${failed} failed`);

    // 打印最新解读预览
    if (interpreted.length > 0) {
      const latest = interpreted[interpreted.length - 1];
      console.log(`\n--- Latest interpretation preview ---`);
      console.log(`Source: ${latest.source || latest.type}`);
      console.log(`Title: ${latest.title}`);
      console.log(`Content:\n${latest.interpretedContent?.slice(0, 500) || '(failed)'}`);
      console.log(`---`);
    }
  }

  await processBatch();

  if (watchMode) {
    console.log('\n👁 Watch mode enabled. Checking every 60s...');
    setInterval(processBatch, 60 * 1000);
  }
}

main().catch(console.error);
