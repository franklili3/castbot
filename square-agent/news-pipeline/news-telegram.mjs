// news-telegram.mjs — Telegram 推送 + 审核发布
// 功能：
// 1. 监控 interpreted-news.json，有新解读自动推送到 Telegram
// 2. 内联按钮：✅ 发布 / ✏️ 编辑 / ❌ 丢弃
// 3. 点"发布" → 调用 square-agent server API 创建发布任务

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CONFIG } from './config.mjs';
import { isDuplicate as isDupGlobal, markProcessed as markGlobal } from '../../scripts/dedup.mjs';
import paths from '../src/paths.mjs';

const TELEGRAM_TOKEN = '8927399494:AAEd-d4naIzjQ_kGGIhY2yE6vjF2ELHJ8PE'; // 固定 SquareAgent bot，不用 process.env
// 用 admin chatId（从环境变量或 bot 获取）
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// square-agent server API
const SERVER_URL = process.env.SQUARE_AGENT_SERVER || 'http://127.0.0.1:5577';
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'bsq_mq8uu7h2_h61diu';

const DATA_DIR = CONFIG.dataDir;
const PUSHED_FILE = `${DATA_DIR}/pushed-news.json`;

// 检查审核模式：auto = 自动发布，manual = 人工审核
async function getReviewMode() {
  try {
    const res = await fetch('http://127.0.0.1:3100/api/user/by-token?token=' + AGENT_TOKEN, {
      headers: { 'x-api-key': 'binsquare-dev-key-2026' },
    });
    const data = await res.json();
    return data?.user?.review_mode || 'manual';
  } catch { return 'manual'; }
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

function deriveTopics(item) {
  if (!item) return 'BTC';
  const topics = new Set();
  const coins = item.coins || [];
  if (Array.isArray(coins) && coins.length > 0) {
    for (const coin of coins.slice(0, 3)) topics.add(String(coin).toUpperCase());
  } else {
    const sym = item.symbol?.replace('USDT', '').toUpperCase();
    topics.add(sym || 'BTC');
  }
  const cat = (item.category || '').trim();
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
async function autoPublish(content, item) {
  try {
    const topics = deriveTopics(item);
    const res = await fetch('http://127.0.0.1:3100/api/content/insert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'binsquare-dev-key-2026' },
      body: JSON.stringify({ userId: 3, content, topics, status: 'approved' }),
    });
    const data = await res.json();
    return data?.ok ? data.id : null;
  } catch (e) {
    console.error('Auto-publish failed:', e.message);
    return null;
  }
}

// ============ 状态管理 ============
function loadPushed() {
  try {
    return JSON.parse(readFileSync(PUSHED_FILE, 'utf8'));
  } catch { return { ids: [], items: {} }; }
}

function savePushed(pushed) {
  // 只保留最近 200 条
  pushed.ids = pushed.ids.slice(-200);
  writeFileSync(PUSHED_FILE, JSON.stringify(pushed, null, 2));
}

// ============ Telegram API ============
async function tgSend(chatId, text, inlineKeyboard) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (inlineKeyboard) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${data.description}`);
  return data.result;
}

async function tgAnswerCallback(callbackId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
    signal: AbortSignal.timeout(5000),
  });
}

// ============ 发布到币安广场 ============
// 直接写入 bot DB 为 approved，让 publisher agent 自动拉取发布
// 使用 better-sqlite3（sqlite3 CLI 不支持多行内容）
async function _getDb() {
  // better-sqlite3 是 CJS，在 ESM 中用动态 import
  const mod = await import(join(__dirname, '..', 'bot', 'node_modules', 'better-sqlite3', 'lib', 'index.js'));
  const Database = mod.default;
  const botDbPath = paths.botDb;
  return new Database(botDbPath);
}

async function publishToBinanceSquare(content, topics) {
  const topicStr = Array.isArray(topics) ? topics.join(',') : (topics || 'BTC');
  try {
    const db = await _getDb();
    const result = db.prepare(`INSERT INTO posts (user_id, content, topics, status, scheduled_at) VALUES (?, ?, ?, 'approved', datetime('now'))`).run(3, content || '', topicStr);
    db.close();
    const id = result.lastInsertRowid;
    console.log(`  ✅ Posted to DB as approved, id=${id}`);
    return { ok: true, id, task_id: id };
  } catch (e) {
    console.error(`  ❌ DB insert failed: ${e.message}`);
    return { ok: false, error: e.message.substring(0, 200) };
  }
}

// ============ 推送新解读 ============
function loadInterpreted() {
  try {
    return JSON.parse(readFileSync(`${DATA_DIR}/interpreted-news.json`, 'utf8'));
  } catch { return []; }
}

async function pushNewInterpretations(chatId) {
  const interpreted = loadInterpreted();
  const pushed = loadPushed();
  const reviewMode = await getReviewMode();

  // 找未推送的
  const newItems = interpreted.filter(item =>
    item.interpretedContent && !pushed.ids.includes(item.id)
  );

  if (newItems.length === 0) {
    return 0;
  }

  console.log(`📤 Pushing ${newItems.length} new interpretations (mode: ${reviewMode})...`);

  for (const item of newItems) {
    // 全局去重
    if (isDupGlobal(item.title, 'news-telegram')) {
      console.log(`  🔁 全局去重：跳过 ${item.title.slice(0, 40)}`);
      pushed.ids.push(item.id);
      savePushed(pushed);
      continue;
    }

    if (reviewMode === 'auto') {
      // 自动发布：直接入库，只发简短通知
      const postId = await autoPublish(item.interpretedContent, item);
      const msg = postId
        ? `🤖 新闻已自动发布 #${postId}：${item.interpretedContent.split('\n')[0].replace(/^[📰📊📋🔍💪🧠📐📚🔥💡❓⚠️#\s]+/, '').slice(0, 50)}`
        : `❌ 自动发布失败：${item.interpretedContent.split('\n')[0].slice(0, 50)}`;
      try { await tgSend(chatId, msg); } catch (e) { console.error('TG notify failed:', e.message); }
      pushed.ids.push(item.id);
      pushed.items[item.id] = { pushedAt: Date.now(), title: item.title, autoPublished: true, postId };
      markGlobal(item.title, 'news-telegram', { source: item.source });
      console.log(`  ${postId ? '🤖 Auto-published' : '❌ Failed'}: ${item.title.slice(0, 50)}`);
    } else {
      // 人工审核：发完整内容 + 按钮
      const source = item.source || item.type;
      const preview = item.interpretedContent.slice(0, 3500);
      const text = `<b>📰 新闻快讯解读</b>\n<b>来源:</b> ${source}\n<b>原始标题:</b> ${item.title.slice(0, 100)}\n\n${escapeHtml(preview)}\n\n<i>⏰ ${new Date(item.addedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</i>`;
      const keyboard = [[
        { text: '✅ 发布到广场', callback_data: `pub:${item.id}` },
        { text: '❌ 丢弃', callback_data: `del:${item.id}` },
      ]];
      try {
        await tgSend(chatId, text, keyboard);
        pushed.ids.push(item.id);
        pushed.items[item.id] = { pushedAt: Date.now(), title: item.title };
        markGlobal(item.title, 'news-telegram', { source: item.source });
        console.log(`  ✅ Pushed: ${item.title.slice(0, 50)}`);
      } catch (e) {
        console.error(`  ❌ Push failed: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  savePushed(pushed);
  return newItems.length;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============ Callback 处理（webhook 轮询模式）============
async function processUpdate(update, chatId) {
  if (!update.callback_query) return;

  const cb = update.callback_query;
  const [action, newsId] = cb.data.split(':');

  await tgAnswerCallback(cb.id, '处理中...');

  if (action === 'pub') {
    // 找到对应新闻
    const interpreted = loadInterpreted();
    const item = interpreted.find(n => n.id === newsId);
    if (!item || !item.interpretedContent) {
      await tgSend(chatId, '❌ 找不到这条新闻（可能已过期）');
      return;
    }

    // 调用发布
    const result = await publishToBinanceSquare(item.interpretedContent, deriveTopics(item));

    if (result.ok || result.id) {
      await tgSend(chatId, `✅ 已加入发布队列！\n任务ID: ${result.task_id || result.id || 'N/A'}\n\nAgent 会自动发布到币安广场。`);
    } else {
      await tgSend(chatId, `❌ 发布失败: ${result.error || JSON.stringify(result).slice(0, 200)}`);
    }
  } else if (action === 'del') {
    const pushed = loadPushed();
    if (!pushed.ids.includes(newsId)) pushed.ids.push(newsId);
    savePushed(pushed);
    await tgSend(chatId, '🗑 已丢弃。');
  } else if (action === 'cp_pub') {
    // content-pipeline 的帖子，从 square-agent DB 读取并直接改为 approved
    try {
      const db = await _getDb();
      const row = db.prepare('SELECT id, content, topics FROM posts WHERE id = ?').get(parseInt(newsId));
      if (!row) {
        db.close();
        await tgSend(chatId, '❌ 找不到这篇帖子（ID不存在）');
        return;
      }
      // 直接将状态改为 approved，publisher agent 会自动拉取
      db.prepare("UPDATE posts SET status = 'approved' WHERE id = ?").run(parseInt(newsId));
      db.close();
      await tgSend(chatId, `✅ 已加入发布队列！\n帖子ID: #${row.id}\n\nPublisher Agent 会自动发布到币安广场。`);
    } catch (e) {
      await tgSend(chatId, `❌ 读取帖子失败: ${e.message.substring(0, 100)}`);
    }
  } else if (action === 'cp_del') {
    try {
      const db = await _getDb();
      db.prepare("UPDATE posts SET status = 'rejected' WHERE id = ?").run(parseInt(newsId));
      db.close();
      await tgSend(chatId, '🗑 已丢弃。');
    } catch (e) {
      await tgSend(chatId, `❌ 操作失败: ${e.message.substring(0, 100)}`);
    }
  } else if (action === 'tn_pub') {
    // telegram-notify.mjs --buttons 发送的消息
    const { readFileSync, unlinkSync, existsSync } = await import('fs');
    const pendingPath = join(paths.tgPendingDir, `${newsId}.json`);
    try {
      if (!existsSync(pendingPath)) {
        await tgSend(chatId, '❌ 找不到这条内容（可能已过期）');
        return;
      }
      const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
      // 直接写入 bot DB 为 approved，让 publisher agent 自动拉取发布
      const db = await _getDb();
      const result = db.prepare(`INSERT INTO posts (user_id, content, topics, status, scheduled_at) VALUES (?, ?, ?, 'approved', datetime('now'))`).run(3, pending.message, 'BTC');
      db.close();
      const idResult = result.lastInsertRowid;
      await tgSend(chatId, `✅ 已加入发布队列！\n帖子ID: #${idResult}\n\nPublisher Agent 会自动发布到币安广场。`);
      unlinkSync(pendingPath);
    } catch (e) {
      await tgSend(chatId, `❌ 读取内容失败: ${e.message.substring(0, 100)}`);
    }
  } else if (action === 'tn_del') {
    const { unlinkSync, existsSync } = await import('fs');
    const pendingPath = join(paths.tgPendingDir, `${newsId}.json`);
    try { if (existsSync(pendingPath)) unlinkSync(pendingPath); } catch {}
    await tgSend(chatId, '🗑 已丢弃。');
  }
}

// ============ 主函数 ============
async function main() {
  console.log(`\n📤 News Telegram Gateway`);

  if (!CHAT_ID) {
    console.error('❌ 请设置 TELEGRAM_CHAT_ID 环境变量');
    console.error('   获取方式：给你的 bot 发消息，然后访问 https://api.telegram.org/bot<TOKEN>/getUpdates');
    process.exit(1);
  }

  const watchMode = process.argv.includes('--watch');
  const pollMode = process.argv.includes('--poll');

  // 推送模式：推一次后退出
  if (pollMode) {
    const count = await pushNewInterpretations(CHAT_ID);
    console.log(`Done: pushed ${count} items`);
    return;
  }

  // 守护模式：持续推送 + 处理回调
  if (watchMode) {
    console.log(`   Chat ID: ${CHAT_ID}`);
    console.log(`   Server: ${SERVER_URL}`);
    console.log(`   Watch mode: ON\n`);

    // 定期推送
    setInterval(async () => {
      await pushNewInterpretations(CHAT_ID);
    }, 60 * 1000); // 每分钟检查

    // 首次推送
    await pushNewInterpretations(CHAT_ID);

    // 轮询 Telegram updates 已移至 square-agent-bot 统一处理，避免 getUpdates 冲突
    // news-telegram 只负责 watch + push，不再 polling

    console.log('✅ Watch mode running. Press Ctrl+C to stop.\n');
  }
}

main().catch(console.error);
