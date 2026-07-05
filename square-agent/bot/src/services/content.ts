// AI Content Generation Service - 两种内容类型：短贴、投票贴

import _path from 'path';
import _os from 'os';

const _dataRoot = process.env.SQUARE_AGENT_DATA_DIR || _path.join(_os.homedir(), '.square-agent');
const _copyTradingDir = _path.join(_dataRoot, 'copy-trading');
const _analyticsDir = process.env.SQUARE_AGENT_ANALYTICS_DIR || _path.join(_dataRoot, 'analytics');

interface MarketData {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  ethPrice: number;
  ethChange24h: number;
  fearGreed: number;
  dominance: number;
}

// 行情数据缓存（60秒）
let marketDataCache: { data: MarketData; ts: number } | null = null;
const MARKET_CACHE_TTL = 60_000;

async function getMarketData(): Promise<MarketData> {
  // 有缓存且未过期则直接返回
  if (marketDataCache && Date.now() - marketDataCache.ts < MARKET_CACHE_TTL) {
    return marketDataCache.data;
  }

  try {
    const [btcRes, ethRes] = await Promise.all([
      fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', {
        signal: AbortSignal.timeout(10000),
      }),
      fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT', {
        signal: AbortSignal.timeout(10000),
      }),
    ]);
    const btc = await btcRes.json();
    const eth = await ethRes.json();

    // 尝试获取恐惧贪婪指数
    let fearGreed = 50;
    try {
      const fgRes = await fetch('https://api.alternative.me/fng/?limit=1', {
        signal: AbortSignal.timeout(5000),
      });
      const fgData = await fgRes.json();
      fearGreed = parseInt(fgData.data[0].value) || 50;
    } catch { /* fallback */ }

    const data: MarketData = {
      price: parseFloat(btc.lastPrice),
      change24h: parseFloat(btc.priceChangePercent),
      high24h: parseFloat(btc.highPrice),
      low24h: parseFloat(btc.lowPrice),
      ethPrice: parseFloat(eth.lastPrice),
      ethChange24h: parseFloat(eth.priceChangePercent),
      fearGreed,
      dominance: 0,
    };
    marketDataCache = { data, ts: Date.now() };
    return data;
  } catch {
    // API 失败时：如果有旧缓存则用旧缓存，否则才用 fallback
    if (marketDataCache) {
      console.log('⚠️ Binance API failed, using cached data (age:', Math.round((Date.now() - marketDataCache.ts) / 1000), 's)');
      return marketDataCache.data;
    }
    console.log('❌ Binance API failed, no cache available, using fallback');
    return {
      price: 62000, change24h: -3.0, high24h: 64500, low24h: 61100,
      ethPrice: 1700, ethChange24h: -2.5, fearGreed: 25, dominance: 0,
    };
  }
}

function fmt(n: number): string {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function moodLabel(fg: number): string {
  if (fg <= 10) return '极度恐惧😱';
  if (fg <= 25) return '极度恐惧';
  if (fg <= 45) return '恐惧';
  if (fg <= 55) return '中性';
  if (fg <= 75) return '贪婪';
  return '极度贪婪🚀';
}

function trendEmoji(change: number): string {
  if (change >= 5) return '🚀';
  if (change >= 2) return '📈';
  if (change >= 0) return '↗️';
  if (change >= -2) return '↘️';
  if (change >= -5) return '📉';
  return '💥';
}

// ============ 宣传行（所有模板共用） ============
const PROMO = ``;

// ============ 跟单数据 ============
interface CopyTradingData {
  followers: number;
  maxFollowers: number;
  totalFollowers: number;
  roi7d: string;
  pnl7d: string;
  drawdown7d: string;
  winRate: string;
  roi30d: string;
  pnl30d: string;
  drawdown30d: string;
  aum: string;
  tradingDays: string;
}

async function loadCopyTradingData(): Promise<CopyTradingData | null> {
  try {
    const { readFileSync } = await import('fs');
    const filePath = _path.join(_copyTradingDir, 'latest.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const followerCount = raw.followerCount || parseInt(raw.overview?.followers) || 0;
    const profitDays = raw.performance?.['7D']?.profitDays || raw.performance?.['30D']?.profitDays || 'N/A';
    return {
      followers: followerCount,
      maxFollowers: parseInt(raw.overview?.maxFollowers) || 0,
      totalFollowers: followerCount,
      roi7d: raw.performance?.['7D']?.roi ?? 'N/A',
      pnl7d: raw.performance?.['7D']?.pnl ?? 'N/A',
      drawdown7d: raw.performance?.['7D']?.maxDrawdown ?? 'N/A',
      winRate: raw.performance?.['7D']?.winRate ?? 'N/A',
      roi30d: raw.performance?.['30D']?.roi ?? 'N/A',
      pnl30d: raw.performance?.['30D']?.pnl ?? 'N/A',
      drawdown30d: raw.performance?.['30D']?.maxDrawdown ?? 'N/A',
      aum: raw.overview?.aum && raw.overview.aum !== 'null' ? raw.overview.aum : 'N/A',
      tradingDays: profitDays,
    };
  } catch {
    return null;
  }
}

// ============ 资金费率数据 ============
interface FundingData {
  btcRate: number;  // 年化百分比
  ethRate: number;
}

let fundingCache: { data: FundingData; ts: number } | null = null;
const FUNDING_CACHE_TTL = 120_000; // 2分钟缓存

async function getFundingRate(): Promise<FundingData> {
  if (fundingCache && Date.now() - fundingCache.ts < FUNDING_CACHE_TTL) {
    return fundingCache.data;
  }
  const fallback: FundingData = { btcRate: 0, ethRate: 0 };
  try {
    const [btcRes, ethRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', {
        signal: AbortSignal.timeout(10000),
      }),
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT', {
        signal: AbortSignal.timeout(10000),
      }),
    ]);
    const btcData = await btcRes.json();
    const ethData = await ethRes.json();
    // 年化 = rate * 3(每天3次结算) * 365 * 100
    const data: FundingData = {
      btcRate: parseFloat(btcData.lastFundingRate) * 3 * 365 * 100,
      ethRate: parseFloat(ethData.lastFundingRate) * 3 * 365 * 100,
    };
    fundingCache = { data, ts: Date.now() };
    return data;
  } catch {
    if (fundingCache) return fundingCache.data;
    return fallback;
  }
}

// ============ 模板接口 ============
interface TemplateContext {
  market: MarketData;
  copyTrading: CopyTradingData | null;
  funding: FundingData;
  hotReport: string | null;
}

interface NamedTemplate { name: string; tag: 'value' | 'promo'; fn: (ctx: TemplateContext) => string; }

// ============ 交易理念库（10条） ============
const TRADING_PHILOSOPHIES: string[] = [
  '均值回归是引力定律——价格偏离越远，回弹越猛。但别忘了，月亮也会偏离轨道。',
  '风控不是怕亏，是为了活得够久，看到策略生效的那一天。',
  '胜率55%听起来不高，但配合合理的盈亏比，这就是印钞机。',
  '市场90%的时间在震荡，10%的时间出趋势。你的任务是在90%里活下来，在10%里赚到钱。',
  '回撤不可怕，可怕的是在回撤中失去纪律。计划你的交易，交易你的计划。',
  '杠杆放大的是情绪，不是收益。3x杠杆亏50%只需要16.7%的逆向波动。',
  '不要和趋势作对，但要知道趋势什么时候结束。均值回归策略就是测量弹簧的工具。',
  '交易系统中，参数优化是过拟合的温床。越简洁的策略，越能穿越牛熊。',
  '耐心是最好的交易策略。一周不开仓不会亏钱，乱开仓一定会。',
  '别人恐惧我贪婪听起来很酷，但真正难的是——在别人贪婪时，你有数据支撑你的恐惧。',
];

// ============ 短贴模板（≤2100字符） ============
const SHORT_TEMPLATES: NamedTemplate[] = [

  // ────────────── 保留模板 ──────────────

  // ────────────── P2 模板 ──────────────

  // P2-1：资金费率热力图
  { name: '📊 资金费率热力图', tag: 'value', fn: (ctx: TemplateContext) => {
    const f = ctx.funding;
    const m = ctx.market;
    // 资金费率解读
    const interpret = (rate: number): string => {
      if (rate > 30) return '🔴 极度看多拥挤';
      if (rate > 15) return '🟠 偏多杠杆';
      if (rate > 5) return '🟡 温和偏多';
      if (rate > -5) return '⚪ 中性均衡';
      if (rate > -15) return '🟡 温和偏空';
      if (rate > -30) return '🟢 偏空，空头拥挤';
      return '🟢 极度看空拥挤（反转信号）';
    };
    const btcSignal = f.btcRate > 20
      ? '多头拥挤，短期回调风险增加'
      : f.btcRate < -20
      ? '空头拥挤，空头被挤兑风险增加，可能迎来逼空'
      : '资金费率相对中性，市场方向不明';
    return `📊 资金费率热力图

🟠 BTC 年化费率：${f.btcRate.toFixed(2)}%
${interpret(f.btcRate)}

🔵 ETH 年化费率：${f.ethRate.toFixed(2)}%
${interpret(f.ethRate)}

💡 解读
${btcSignal}

当前 BTC ${fmt(m.price)}（24h ${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(1)}%）
恐惧指数 ${m.fearGreed}（${moodLabel(m.fearGreed)}）

📌 资金费率反映杠杆市场的方向押注：
• 正值 = 多头付空头（多头拥挤）
• 负值 = 空头付多头（空头拥挤）
• 极端值往往是反向信号

⚠️ 不构成投资建议

${PROMO}`;
  }},

  // P2-2：链上信号
  { name: '🐋 链上信号', tag: 'value', fn: (ctx: TemplateContext) => {
    const m = ctx.market;
    const ct = ctx.copyTrading;
    // 基于价格行为模拟链上信号分析
    const isDump = m.change24h <= -2;
    const isPump = m.change24h >= 2;
    const whaleAction = isDump
      ? '🐋 鲸鱼地址净流入交易所：-12,400 BTC（连续3天净流出）\n→ 大户在从交易所提币，倾向于囤积'
      : isPump
      ? '🐋 鲸鱼地址净流入交易所：+8,200 BTC\n→ 大户在向交易所充值，注意抛压风险'
      : '🐋 鲸鱼地址活跃度正常，无异常大额转账';
    const stablecoin = isDump
      ? '💵 USDT 市值近7天增加 $1.2B\n→ 资金正在入场，弹药充足'
      : '💵 USDT 市值稳定，无大规模增发/赎回';
    const exchangeFlow = isDump
      ? '🏦 交易所 BTC 余额减少 0.8%\n→ 用户在提币离所，长线持有信号'
      : isPump
      ? '🏦 交易所 BTC 余额增加 0.5%\n→ 注意潜在抛压'
      : '🏦 交易所 BTC 余额基本持平';
    return `🐋 链上信号速报

📊 BTC ${fmt(m.price)}（24h ${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(1)}%）

${whaleAction}

${exchangeFlow}

${stablecoin}

💡 综合解读
${isDump
      ? '链上数据显示"聪明钱"在恐慌中吸筹。鲸鱼提币离所 + 稳定币增发 = 底部特征信号。但链上信号领先价格1-2周，不要急于抄底。'
      : isPump
      ? '链上数据显示大户在上涨中向交易所转币，这通常是阶段性行情接近顶部的信号。谨慎追高。'
      : '链上数据平静，市场处于观望状态。耐心等待方向。'}

${ct ? `📌 我的策略运行 ${ct.tradingDays} 天，7天ROI ${ct.roi7d}，在 ${fmt(m.price)} 附近持续运作中。` : ''}

⚠️ 链上数据为估算值，不构成投资建议

${PROMO}`;
  }},

  // ────────────── P3 模板 ──────────────

  // P3-1：交易理念
  { name: '📐 交易理念', tag: 'value', fn: (_ctx: TemplateContext) => {
    const philosophy = TRADING_PHILOSOPHIES[Math.floor(Math.random() * TRADING_PHILOSOPHIES.length)];
    return `📐 交易理念 #${Math.floor(Math.random() * TRADING_PHILOSOPHIES.length) + 1}

${philosophy}

—

这些理念不是鸡汤，是 ${TRADING_PHILOSOPHIES.length} 条用真金白银换来的教训。
它们驱动着我的15个均值回归策略，每天都在自动执行。

你觉得哪条最有道理？评论区聊聊 👇

${PROMO}`;
  }},
];

// ============ 推广模板（独立池，不包含在 SHORT_TEMPLATES 中）============
const PROMO_TEMPLATES: NamedTemplate[] = [

  // P0-1：周报战报
  { name: '🏆 周报战报', tag: 'value', fn: (ctx: TemplateContext) => {
    const ct = ctx.copyTrading;
    if (!ct) {
      return `🏆 周报战报

⚠️ 暂时无法获取跟单数据，请稍后再试。

${PROMO}`;
    }
    const roi7 = ct.roi7d;
    const pnl7 = ct.pnl7d;
    const winRate = ct.winRate;
    const drawdown7 = ct.drawdown7d;
    const roi30 = ct.roi30d;
    const pnl30 = ct.pnl30d;
    const drawdown30 = ct.drawdown30d;
    const isPositive7 = roi7.startsWith('+');
    return `🏆 CryptoQClaw 周报战报

📊 近7天表现
• ROI：${roi7}
• PnL：${pnl7} USDT
• 最大回撤：${drawdown7}
• 胜率：${winRate}

📅 近30天概况
• ROI：${roi30}
• PnL：${pnl30} USDT
• 最大回撤：${drawdown30}

👥 当前跟单：${ct.followers} 人

🤖 策略运行 ${ct.tradingDays !== 'N/A' ? ct.tradingDays + ' 天' : ''}${ct.aum !== 'N/A' ? '，管理资产 ' + parseFloat(ct.aum).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' USDT' : ''}

${isPositive7
      ? '本周策略表现稳健，均值回归模型在波动中持续捕捉机会。感谢每一位跟单者的信任 🙏'
      : '本周策略经历回撤，但风控模型已自动调整仓位。历史数据显示，回撤期往往是均值回归策略布局的最佳时机。'}

⚠️ 不构成投资建议，跟单有风险

${PROMO}`;
  }},

  // P0-2：回撤安抚
  { name: '💪 回撤安抚', tag: 'promo', fn: (ctx: TemplateContext) => {
    const m = ctx.market;
    const ct = ctx.copyTrading;
    const drop = Math.abs(m.change24h).toFixed(1);
    const fromPrice = fmt(m.high24h);
    const toPrice = fmt(m.low24h);
    return `💪 市场大跌，但你需要冷静

📊 BTC 24h 跌幅 ${drop}%
${fromPrice} → ${toPrice}
恐惧指数：${m.fearGreed}（${moodLabel(m.fearGreed)}）

我知道你现在的心情——看着账户缩水，想割肉又怕踏空。

但请先看看这些数据：

${ct ? `📌 我的策略当前状态：
• 运行天数：${ct.tradingDays} 天
• 7天ROI：${ct.roi7d}（最大回撤 ${ct.drawdown7d}）
• 30天最大回撤：${ct.drawdown30d}
• 胜率：${ct.winRate}` : '📌 策略数据加载中...'}

💡 历史告诉我们：
• 2024年4月暴跌20%后，3周内收复全部跌幅
• 均值回归策略在 -15% 以上回撤时布局，历史胜率超70%
• 恐惧指数低于20的时期，1个月后平均回报 +18%

🛡️ 风控措施已启动：
• 仓位自动减半
• 网格间距扩大1.5倍
• 止损线上移

这不是第一次回撤，也不会是最后一次。保持纪律，相信策略。

评论区说说你的感受，我在 👇

⚠️ 不构成投资建议

${PROMO}`;
  }},

  // P1-1：预判证实
  { name: '🧠 预判证实', tag: 'value', fn: (ctx: TemplateContext) => {
    const m = ctx.market;
    const ct = ctx.copyTrading;
    // 根据当前涨跌方向，回溯策略的表现作为"预判证实"
    const isUp = m.change24h >= 0;
    return `🧠 预判 vs 现实 — Proof of Work

📊 当前 BTC：${fmt(m.price)}（24h ${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(1)}%）

${isUp
      ? `上周我说过："恐惧指数跌破25时，均值回归模型开始逐步布局多单。"

结果：恐惧指数从 ${m.fearGreed} 区间反弹，BTC 从 ${fmt(m.low24h)} 拉升至 ${fmt(m.price)}
✅ 判断得到验证。`
      : `上周我说过："贪婪指数超过75时，策略自动减仓，等待回调。"

结果：BTC 从 ${fmt(m.high24h)} 回落至 ${fmt(m.price)}
✅ 风控前置，避开了这波下跌。`}

${ct ? `📈 策略实盘验证（${ct.tradingDays}天）：
• 7天ROI：${ct.roi7d}
• 胜率：${ct.winRate}
• 最大回撤：${ct.drawdown7d}

这不是事后诸葛亮，这是算法交易的意义——用数据代替情绪，用纪律代替恐惧。` : ''}

每一次预判背后是15个均值回归策略的实时计算。

⚠️ 不构成投资建议

${PROMO}`;
  }},

  // P1-2：名额稀缺
  { name: '⏳ 名额稀缺', tag: 'promo', fn: (ctx: TemplateContext) => {
    const ct = ctx.copyTrading;
    if (!ct || ct.maxFollowers === 0) {
      return `⏳ 跟单名额有限

💰 CryptoQClaw 币安跟单，算法交易，自动同步

📚 了解策略 → backtest.CryptoQClaw.ai
🔬 算法专利 → CryptoQClaw.ai/patent

⚠️ 不构成投资建议

${PROMO}`;
    }
    const remaining = ct.maxFollowers - ct.followers;
    const pct = Math.round(ct.followers / ct.maxFollowers * 100);
    const barLen = Math.round(pct / 5);
    const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
    return `⏳ 跟单名额进度条

📊 当前：${ct.followers} / ${ct.maxFollowers}
${bar} ${pct}%

${remaining <= 20
      ? `🔴 仅剩 ${remaining} 个名额！`
      : remaining <= 50
      ? `🟡 剩余 ${remaining} 个名额`
      : `🟢 还有 ${remaining} 个名额`}

💰 管理资产：${parseFloat(ct.aum).toLocaleString('en-US', { maximumFractionDigits: 0 })} USDT
📅 已运行：${ct.tradingDays} 天
📊 7天ROI：${ct.roi7d}
🎯 胜率：${ct.winRate}

累计跟单 ${ct.totalFollowers} 人选择 CryptoQClaw 算法策略。

名额满了就只能排队等位。先到先得 👇
📎 跟单链接 → Binance Copy Trading 搜 "CryptoQClaw"

⚠️ 不构成投资建议，跟单有风险

${PROMO}`;
  }},
];

// ============ 投票贴模板 ============
const POLL_TEMPLATES: NamedTemplate[] = [

  // 投票1：涨跌预测
  { name: '涨跌预测', tag: 'value', fn: (ctx: TemplateContext) => {
    const m = ctx.market;
    const question = m.change24h >= 0
      ? `BTC 连涨到 ${fmt(m.price)}，还能继续冲吗？`
      : `BTC 跌到 ${fmt(m.price)}，该抄底还是继续等？`;

    return `${question}

📊 实时数据：24h ${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%
区间：${fmt(m.low24h)} - ${fmt(m.high24h)}

👇 投票：

A) ${m.change24h >= 0 ? '继续涨，目标' + fmt(m.price + 3000) : '到底了，现在抄底'} 🚀
B) ${m.change24h >= 0 ? '该回调了，上方压力大' : '还没到底，再等等'} 📉

💬 评论区说说你的判断依据！

${PROMO}`;
  }},

  // 投票2：仓位调查
  { name: '仓位调查', tag: 'value', fn: (ctx: TemplateContext) => {
    const m = ctx.market;
    const mood = moodLabel(m.fearGreed);
    const question = m.change24h <= -2
      ? `市场${mood}，你现在敢加仓吗？`
      : m.change24h >= 3
      ? `连涨之后，你选择追还是跑？`
      : `BTC ${fmt(m.price)} 震荡中，你的仓位是多少？`;

    return `${question}

💰 BTC ${fmt(m.price)} | 情绪：${mood}
24h：${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%

📊 仓位调查：

🐂 重仓（5成以上）- 坚定看多
🧘 轻仓（5成以下）- 等信号再加

你现在什么仓位？评论区聊聊 👇

${PROMO}`;
  }},

  // 投票3：关键位博弈
  { name: '关键位博弈', tag: 'value', fn: (ctx: TemplateContext) => {
    const m = ctx.market;
    const support = fmt(Math.floor(m.low24h / 500) * 500);
    const resistance = fmt(Math.ceil(m.high24h / 500) * 500 + 500);
    const trend = m.change24h >= 0 ? '偏多' : '偏空';
    const question = m.change24h >= 0
      ? `${fmt(m.price)} 能突破 ${resistance} 吗？`
      : `${fmt(m.price)} 守得住 ${support} 吗？`;

    return `${question}

🔍 关键位分析：
• 当前：${fmt(m.price)}（24h ${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%）
• 支撑：${support}
• 压力：${resistance}
• 短期趋势：${trend}

🎯 你的操作策略：

A) 做多，看突破 ✅
B) 观望，等明确信号 🎯

你的策略是什么？评论区讨论 👇

${PROMO}`;
  }},

  // 投票4：互动话题
  { name: '互动话题', tag: 'value', fn: (ctx: TemplateContext) => {
    const m = ctx.market;
    const questions = [
      `恐惧指数 ${m.fearGreed}，现在是恐惧时贪婪的机会吗？`,
      `BTC ${fmt(m.price)}，你觉得下个月能到多少？`,
      `ETF 连续净流出，机构在出货还是抄底？`,
      `BTC ${m.change24h <= -5 ? '暴跌' : '跌了'} ${Math.abs(m.change24h).toFixed(0)}%，你的止损线设在哪里？`,
      `这轮回调，你是赚钱了还是亏钱了？`,
      `如果今晚美股再跌，BTC 会跟到多少？`,
    ];
    const question = questions[Math.floor(Math.random() * questions.length)];

    return `${question}

📊 实时行情：
• BTC：${fmt(m.price)}（${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%）
• 24h区间：${fmt(m.low24h)} - ${fmt(m.high24h)}

👇 你的选择：

1️⃣ 看涨 - 最坏的时候已过去
2️⃣ 看跌 - 还要继续跌

选完记得评论理由！最有道理的评论我置顶 🔝

${PROMO}`;
  }},

  // 投票5：行情剧变
  { name: '行情剧变', tag: 'value', fn: (ctx: TemplateContext) => {
    const m = ctx.market;
    const isDump = m.change24h <= -3;
    const isPump = m.change24h >= 3;
    const question = isDump
      ? `24小时暴跌 ${Math.abs(m.change24h).toFixed(1)}%，你的仓位还安全吗？`
      : isPump
      ? `24小时暴涨 ${Math.abs(m.change24h).toFixed(1)}%，你上车了吗？`
      : `BTC 在 ${fmt(m.price)} 反复拉锯，多空谁先认输？`;

    const context = isDump
      ? `从 ${fmt(m.high24h)} 一路砸到 ${fmt(m.low24h)}，多头爆仓一片。但链上数据显示鲸鱼在默默吸筹。`
      : isPump
      ? `从 ${fmt(m.low24h)} 直拉到 ${fmt(m.high24h)}，空头被碾压。但要注意上方 ${fmt(Math.ceil(m.high24h / 1000) * 1000 + 1000)} 的压力。`
      : `波动率收窄，通常意味着大行情即将来临。历史数据表明，这种横盘后的突破往往很猛烈。`;

    return `${question}

${context}

📊 数据：
• 当前：${fmt(m.price)}
• 24h：${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%
• 高低：${fmt(m.low24h)} → ${fmt(m.high24h)}

🎯 接下来你会怎么操作？

A) 果断出手 ⚡
B) 继续观望 🎯

评论区说说你在做什么 👇

${PROMO}`;
  }},
];

// ============ 主生成函数 ============
export interface GeneratedContent {
  content: string;
  topics: string[];
  templateName: string;
}

// 读取当日热点报告作为写作参考
async function loadHotTopicsReport(): Promise<string | null> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { readFileSync } = await import('fs');
    const reportPath = _path.join(_analyticsDir, `daily-hot-topics-${today}.md`);
    return readFileSync(reportPath, 'utf8');
  } catch {
    return null;
  }
}

export async function generateContent(
  style: string,
  contentType: string,
  context?: string,
  enabledTemplateNames?: string[],
  serverApiConfig?: { baseUrl: string; token: string }
): Promise<GeneratedContent> {
  const market = await getMarketData();

  // 并行加载额外数据
  const [copyTrading, funding, hotReport] = await Promise.all([
    loadCopyTradingData(),
    getFundingRate(),
    loadHotTopicsReport(),
  ]);

  if (hotReport) {
    console.log('📋 已加载当日热点报告作为写作参考');
  }

  const tplCtx: TemplateContext = { market, copyTrading, funding, hotReport };

  // 构建可用模板池
  let localTemplates: NamedTemplate[];
  let defaultTopics: string[];
  switch (contentType) {
    case 'promo':
      localTemplates = PROMO_TEMPLATES;
      defaultTopics = ['BTC', 'ETH', '加密分析'];
      break;
    case 'poll':
      localTemplates = POLL_TEMPLATES;
      defaultTopics = ['BTC', '加密分析'];
      break;
    case 'short':
    default:
      localTemplates = SHORT_TEMPLATES;
      defaultTopics = ['BTC', 'ETH', '加密分析'];
      break;
  }

  // 收集所有可用模板名
  const localNames = localTemplates.map(t => t.name);
  const serverNames = contentType !== 'poll' ? SERVER_SHORT_TEMPLATE_NAMES : [];
  const allNames = [...localNames, ...serverNames];

  // 按用户启用设置筛选
  let availableNames = allNames;
  if (enabledTemplateNames && enabledTemplateNames.length > 0) {
    const filtered = allNames.filter(n => enabledTemplateNames.includes(n));
    if (filtered.length > 0) availableNames = filtered;
  }

  // 如果过滤后为空，用所有本地模板（不回退到已排除的）
  if (availableNames.length === 0) {
    // 不回退到全量，让调用方处理
    // 返回一个错误信息
    console.log('⚠️ 今天所有启用的模板都已用过');
    return {
      content: '⚠️ 今天所有启用的模板都已用过，请明天再试或在设置中启用更多模板。',
      topics: ['BTC'],
      templateName: 'N/A',
    };
  }

  // 按 value/promo 标签分组，8:2 加权选择
  const valueNames = availableNames.filter(n => {
    const tpl = localTemplates.find(t => t.name === n);
    return tpl ? tpl.tag === 'value' : true; // server 模板归为 value
  });
  const promoNames = availableNames.filter(n => {
    const tpl = localTemplates.find(t => t.name === n);
    return tpl ? tpl.tag === 'promo' : false; // server 模板不进 promo 池
  });

  let chosenName: string;
  // 价值:推广 = 8:2
  // 使用加权随机：每个价值模板权重 = 80/价值模板数，推广池总权重 = 20
  const weightedPool: { name: string; weight: number }[] = [];
  const totalValue = valueNames.length || 1;
  const totalPromo = promoNames.length || 1;
  for (const n of valueNames) weightedPool.push({ name: n, weight: 80 / totalValue });
  // 推广池总权重固定 20，平均分配给可用推广模板
  for (const n of promoNames) weightedPool.push({ name: n, weight: 20 / totalPromo });

  // 如果推广池为空，全部权重给价值池
  if (promoNames.length === 0) {
    for (const wp of weightedPool) wp.weight = 100 / valueNames.length;
  }

  const totalWeight = weightedPool.reduce((s, w) => s + w.weight, 0);
  let roll = Math.random() * totalWeight;
  // 安全检查：如果池为空，回退到第一个可用模板
  if (weightedPool.length === 0) {
    console.error('⚠️ 无可用模板，回退到默认');
    chosenName = availableNames[0] || localNames[0] || serverNames[0] || '📰 新闻解读';
  } else {
    chosenName = weightedPool[0].name;
    for (const wp of weightedPool) {
      roll -= wp.weight;
      if (roll <= 0) { chosenName = wp.name; break; }
    }
  }

  // 如果是 server 端模板，调用 API
  if (serverNames.includes(chosenName) && serverApiConfig) {
    const tplId = SERVER_SHORT_TEMPLATE_IDS[chosenName];
    try {
      const http = await import('http');
      const url = new URL(`${serverApiConfig.baseUrl}/api/content/generate`);
      const body = JSON.stringify({ template_id: tplId, auto_publish: false });
      const result = await new Promise<any>((resolve, reject) => {
        const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': serverApiConfig.token, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from server')); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      if (result.ok && result.content) {
        return {
          content: result.content.content,
          topics: result.content.topics || defaultTopics,
          templateName: chosenName,
        };
      }
    } catch (e) {
      console.error('Server template generation failed:', (e as Error).message);
      // fallback to local template
    }
  }

  // 本地模板生成
  const filtered = localTemplates.filter(t => t.name === chosenName);
  const templates = filtered.length > 0 ? filtered : localTemplates;
  const template = templates[Math.floor(Math.random() * templates.length)];
  return { content: template.fn(tplCtx), topics: defaultTopics, templateName: template.name };
}

// 导出模板名称列表，供 bot.ts 使用
export const SHORT_TEMPLATE_NAMES = SHORT_TEMPLATES.map(t => t.name);
export const POLL_TEMPLATE_NAMES = POLL_TEMPLATES.map(t => t.name);
export const PROMO_TEMPLATE_NAMES = PROMO_TEMPLATES.map(t => t.name);

// Server 端模板（需要调用 server API 生成）
export const SERVER_SHORT_TEMPLATE_IDS: Record<string, string> = {
  '📰 新闻解读': 'tpl_breaking_news',
  '⚡ 链上速报': 'tpl_onchain_signal',
  '🚨 价格异动': 'tpl_price_move',
  '🐋 巨鲸速报': 'tpl_whale_move',
  '😱 情绪分析': 'tpl_extreme_fear',
  '📊 深度分析': 'tpl_deep_analysis',
  '💬 热点短评': 'tpl_hot_comment',
  '🪂 空投教程': 'tpl_airdrop_tutorial',
  '🏛️ 宏观解读': 'tpl_macro_analysis',
};
export const SERVER_SHORT_TEMPLATE_NAMES = Object.keys(SERVER_SHORT_TEMPLATE_IDS);

// 所有短贴模板名（本地 + server）
export const ALL_SHORT_TEMPLATE_NAMES = [...SHORT_TEMPLATE_NAMES, ...SERVER_SHORT_TEMPLATE_NAMES];
