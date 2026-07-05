// config.mjs — 新闻管道配置
// GLM API 用 OpenAI 兼容端点（和 square-agent-bot 一致）

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import paths from '../src/paths.mjs';

// 加载父目录 .env（square-agent/.env）到 process.env，不覆盖已有值。
// launchd 启动的进程不继承 shell env，需主动加载以保证 NEWS_ZHIPU_API_KEY 等可用。
// 之后追加加载统一 .env（~/.square-agent/.env），同样不覆盖已有值。
function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}
try { loadEnvFile(paths.envFile); } catch {}

export const CONFIG = {
  // 发帖语言：zh(中文) / en(英文) / ja(日文) / ko(韩文)
  language: process.env.SQUARE_LANGUAGE || 'zh',

  // 关注的币种（影响新闻筛选、评分、行情拉取、标签生成）
  coins: (process.env.SQUARE_COINS || 'BTC,ETH').split(',').map(s => s.trim().toUpperCase()),

  // GLM API (智谱编码套餐)
  glm: {
    apiKey: process.env.NEWS_ZHIPU_API_KEY,
    baseUrl: process.env.NEWS_ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: process.env.NEWS_ZHIPU_MODEL || 'glm-4-flash-250414',
  },

  // RSS 信号源（按优先级排序）
  rssSources: [
    { name: 'Bitcoinist',      url: 'https://bitcoinist.com/feed/',            priority: 3, lang: 'en' },
    { name: 'CryptoBriefing',  url: 'https://cryptobriefing.com/feed/',        priority: 3, lang: 'en' },
    { name: 'NewsBTC',         url: 'https://www.newsbtc.com/feed/',           priority: 2, lang: 'en' },
    { name: 'CoinTelegraph',   url: 'https://cointelegraph.com/rss',          priority: 1, lang: 'en' },
    { name: 'Bitcoin.com',     url: 'https://news.bitcoin.com/feed/',         priority: 2, lang: 'en' },
    { name: 'The Block',       url: 'https://www.theblock.co/rss.xml',        priority: 2, lang: 'en' },
  ],

  // CryptoPanic (需注册免费 token: https://cryptopanic.com/news/api/)
  cryptoPanic: {
    token: process.env.CRYPTOPANIC_TOKEN || '',  // TODO: 用户注册后填入
    url: 'https://cryptopanic.com/api/v1/posts/',
    filter: 'hot',          // hot | rising | important
    kind: 'news',
  },

  // Binance 价格异动监控
  binance: {
    wsUrl: 'wss://stream.binance.com:9443/ws/!ticker@arr',
    // 触发阈值
    priceAlertThreshold: 2,     // 5分钟内涨跌幅 >2% 触发
    fundingAlertThreshold: 0.05, // 费率 >0.05% 触发（多头拥挤）
    fundingNegativeThreshold: -0.03, // 费率 <-3% 触发（空头拥挤）
    symbols: (process.env.SQUARE_COINS || 'BTC,ETH').split(',').map(s => s.trim().toUpperCase() + 'USDT'),
  },

  // Telegram 推送
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID || '2137877154',
  },

  // square-agent server（发布到币安广场）
  server: {
    url: process.env.SQUARE_AGENT_SERVER || 'http://127.0.0.1:3100',
    agentToken: process.env.AGENT_TOKEN || '',  // TODO: 从 bot DB 获取
  },

  // 数据目录
  dataDir: paths.newsDataDir,
  stateFile: paths.newsDataDir + '/seen-news.json',

  // 轮询间隔（毫秒）
  intervals: {
    rss: 2 * 60 * 1000,        // 2 分钟
    cryptoPanic: 3 * 60 * 1000, // 3 分钟
    binanceTicker: 30 * 1000,   // 30 秒（REST 轮询价格）
    fundingRate: 5 * 60 * 1000, // 5 分钟
  },

  // 关键词过滤：基础通用词 + 根据配置的币种动态扩展
  keywords: [
    // 通用加密/宏观词汇（与具体币种无关）
    'crypto', 'cryptocurrency', 'stablecoin', 'defi', 'exchange',
    'binance', 'coinbase', 'etf', 'sec', 'regulation', 'fed', 'rate', 'cpi',
    'hack', 'exploit', 'breach', 'liquidation',
    'elon', 'trump', 'treasury', 'strategy', 'microstrategy',
    'upgrade', 'fork', 'airdrop',
    'funding', 'open interest', 'whale', 'inflow', 'outflow',
    '加密', '监管', '黑客', '攻击', '暴跌', '暴涨',
    // 宏观市场关键词
    'oil', 'gold', 'nasdaq', 's&p', 'dollar', 'inflation',
    'iran', 'war', 'deal', 'peace', 'tariff',
    'hype', 'siren', 'fund', 'flow', 'mining', 'hash',
    'token', 'coin', 'blockchain', 'web3',
  ],

  // 币种关键词映射表（根据配置的 coins 自动展开）
  coinKeywords: {
    BTC: ['bitcoin', 'btc', '比特币'],
    ETH: ['ethereum', 'eth', '以太坊'],
    SOL: ['solana', 'sol', '索拉纳'],
    BNB: ['bnb', 'bnbchain', '币安币'],
    XRP: ['ripple', 'xrp', '瑞波'],
    DOGE: ['dogecoin', 'doge', '狗狗币'],
    ADA: ['cardano', 'ada', '艾达'],
    AVAX: ['avalanche', 'avax'],
    DOT: ['polkadot', 'dot', '波卡'],
    LINK: ['chainlink', 'link'],
    MATIC: ['polygon', 'matic', '马蹄'],
    TON: ['toncoin', 'ton'],
  },

  // 语言标签映射
  languageLabels: {
    zh: { name: '中文', disclaimer: '不构成投资建议' },
    en: { name: 'English', disclaimer: 'Not financial advice' },
    ja: { name: '日本語', disclaimer: '投資アドバイスではありません' },
    ko: { name: '한국어', disclaimer: '투자 조言이 아닙니다' },
  },
};

// ========== 辅助函数 ============

/** 获取配置币种的关键词列表（合并通用 + 币种专属） */
export function getActiveKeywords() {
  const coinWords = CONFIG.coins.flatMap(c => CONFIG.coinKeywords[c] || [c.toLowerCase()]);
  return [...CONFIG.keywords, ...coinWords];
}

/** 获取配置币种的交易对 */
export function getActiveSymbols() {
  return CONFIG.coins.map(c => `${c}USDT`);
}

/** 获取语言的指令文本（嵌入 prompt） */
export function getLanguageInstruction() {
  const lang = CONFIG.language;
  if (lang === 'zh') return ''; // 默认中文，不需要额外指令
  const labels = {
    en: 'Write the entire post in English.',
    ja: '日本語で投稿を書いてください。',
    ko: '한국어로 게시물을 작성하세요.',
  };
  return labels[lang] || '';
}

/** 获取语言对应的免责声明 */
export function getDisclaimer() {
  return CONFIG.languageLabels[CONFIG.language]?.disclaimer || '不构成投资建议';
}

/** 获取币种列表的文字描述（嵌入 prompt） */
export function getCoinsText() {
  return CONFIG.coins.join('/');
}
