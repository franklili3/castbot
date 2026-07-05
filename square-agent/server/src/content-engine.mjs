/**
 * 内容生成引擎
 * 
 * 支持：
 * - 模板管理（早报/复盘/深度分析/投票/短评）
 * - 排期调度（定时生成+自动下发任务）
 * - AI 内容生成（调用 OpenAI/GLM 等）
 * - 市场数据注入（行情/恐惧指数/链上数据）
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import paths from '../../src/paths.mjs';

// 从统一模板源导入 reactive 类模板的 prompt 构建
import { SYSTEM_PROMPT, buildPrompt as buildUnifiedPrompt, TEMPLATES as UNIFIED_TEMPLATES } from '../../../scripts/templates.mjs';

// ========== 模板定义 ==========

export const BUILTIN_TEMPLATES = [
  {
    id: 'tpl_news_digest',
    name: '📰 新闻快讯',
    description: '多条新闻汇总摘要',
    type: 'post',
    category: 'on_demand',
    unified_type: 'news_digest',
    prompt: `写一条加密市场新闻摘要。

## 最新新闻
{{news}}

## 市场数据
{{market_data}}

## 输出格式（150-300字）
📰 [今日要点标题]

[3-4条要点，每条一句话]

🎯 影响预判
- 币种：[受影响的币种，如BTC/ETH，最多3个]
- 方向：[利多📈 预测涨 / 利空📉 预测跌]
- 时长：4小时

💡 [个人观点]

❓ [互动提问]

⚠️ 不构成投资建议，预测仅供参考`,
    frequency: 'on_demand',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_deep_analysis',
    name: '📊 深度分析',
    description: '单个主题深度拆解+数据支撑',
    type: 'post',
    category: 'on_demand',
    unified_type: 'deep_analysis',
    prompt: `你是一个加密市场深度分析师。

## 主题
{{topic}}

## 输出格式
🔍 [主题] | 深度拆解

📊 核心数据
[3-5个关键数据点]

📝 分析
[分2-3个小节，每节一个论点，有数据支撑]

💡 结论
[明确观点+操作建议]

## 数据
{{market_data}}

## 规则
- 300-500字
- 每个论点都要有数据支撑，不空谈
- 结论要明确，不写"视情况而定"
- 避免AI味（不要"让我们""值得注意的是"）`,
    frequency: 'on_demand',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_hot_comment',
    name: '💬 热点短评',
    description: '对突发新闻的快速评论，50-80字',
    type: 'post',
    category: 'on_demand',
    unified_type: 'hot_comment',
    prompt: `你是一个币圈老韭菜，对突发新闻发表简短评论。

## 新闻
{{news}}

## 规则
- 50-80字
- 像朋友圈评论，口语化
- 要有观点（利好/利空/中性），不灌水
- 可以嘲讽、可以激动、可以有态度
- 不要用emoji开头`,
    frequency: 'on_demand',
    requires_disclaimer: true
  },
  {
    id: 'tpl_poll_post',
    name: '📊 投票互动',
    description: '带投票的市场互动帖',
    type: 'post',
    category: 'scheduled',
    prompt: `你是一个加密KOL，要发一个带投票的互动帖子。

## 主题
{{topic}}

## 输出格式（纯文本，不要JSON）
帖子正文（50-100字，有观点，引出投票问题）

🅰️ 选项A（8字内）
🅱️ 选项B（8字内）

👉 赞一下选哪个

## 规则
- 帖子正文要像真实KOL的语气
- 两个选项要对立（看涨vs看跌、抄底vs观望等）
- 选项文字简洁有力，8字以内
- 直接输出纯文本，不要输出JSON格式`,
    frequency: 'on_demand',
    requires_disclaimer: true
  },
  {
    id: 'tpl_breaking_news',
    name: '📰 新闻解读',
    description: '新闻解读/价格异动快讯，由评分系统自动触发',
    type: 'post',
    category: 'reactive',
    unified_type: 'breaking_news',
    prompt: `写一条新闻解读快讯。你是一个有5年经验的加密交易员，在币安广场写帖子。

## 突发新闻/异动
{{news}}

## 当前行情
{{market_data}}

## 其他新闻参考
{{news_summary}}

## 核心原则（决定浏览量）
1. **标题要具体，不要标题党**：用问句或反直觉的事实，不要用"捡钱""炸裂"等空洞词
2. **正文要有干货**：至少提到一个具体项目名、数据点或链上指标。不要只说"叙事确定性强""想象空间巨大"等空话
3. **新闻和分析必须相关**：如果新闻讲体育+加密，分析就得围绕体育赛道项目（CHZ/Sorare等），不能跑题去分析BTC大盘
4. **预测要有逻辑链**：不能只说"看涨"，要说清楚为什么（技术面/资金面/情绪面）

## 输出格式（200-400字）
📰 [标题：一句话说清这篇在讲什么，可以带悬念但别夸大]

🔥 [核心解读：2-3句。这条新闻为什么重要？给具体数字或项目名，不要泛泛而谈]

📊 [深度补充：2-3个有信息量的要点。比如相关代币当前数据、历史对比、链上信号]

🎯 第N次预判
- 币种：[受影响的币种]
- 方向：[利多📈 预测涨 / 利空📉 预测跌 / 中性➡️ 震荡]
- 时长：4小时
- 依据：[1-2句具体理由，不能只写"利好"]
- 风险：[一个可能推翻判断的因素]

💡 [个人观点：2-3句。有态度，敢说，但要有逻辑支撑]

⚠️ 不构成投资建议，预测仅供参考

## 规则
- 口语化，像交易员在群里聊天，不是写报告
- 有观点，不模棱两可
- 利多预测涨，利空预测跌，确实没影响就标中性
- 数字简写（BTC $65.7K，$316M = 3.16亿美元）
- **禁止空话**：不要用"叙事确定性极强""想象空间巨大""聪明资金已开始布局"等套话，换成具体事实
- **CTA要自然**：不要生硬地喊"转发给朋友"，让互动提问和内容相关`,
    frequency: 'reactive',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_onchain_signal',
    name: '⚡ 链上速报',
    description: '聪明钱异动、资金流入、社交热度飙升等链上事件触发的内容',
    type: 'post',
    category: 'reactive',
    unified_type: 'onchain_signal',
    prompt: `写一条链上信号速报。

## 链上事件数据
{{onchain_data}}

## 市场背景
{{market_data}}

## 输出格式（150-300字）
根据事件类型选标题：
- 聪明钱异动 → 「🧠 聪明钱在做什么？」
- 资金流入 → 「💰 链上资金流向变了」
- BTC/ETH 大波动 → 「📈 大饼/以太 24h 涨跌幅%」
- 社交热度 → 「📱 链上社交热度榜」
- 多类型混合 → 「⚡ 链上异动速报」

### 正文结构
1. 开头一句最有冲击力的事实（数字说话）
2. 2-4个要点，每个一行，简短有力
3. 一句自己的观点或解读（要有态度，不是复述数据）
4. 互动提问

## 禁止
- 不加任何推广链接
- 不推荐具体买卖
- 不要罗列所有数据，挑最有看点的3-5个`,
    frequency: 'reactive',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_price_move',
    name: '🚨 价格异动',
    description: 'BTC/ETH价格剧烈波动时的快讯',
    type: 'post',
    category: 'reactive',
    unified_type: 'price_move',
    prompt: `写一条价格异动快讯。

## 触发信号
{{news}}

## 当前行情
{{market_data}}

## 输出格式（150-300字）
🚨 [代币] [涨/跌] X%

[一句话最冲击的事实]

📊 [2-3个要点：关键点位、资金面/情绪面、历史对比]

💡 [个人观点2-3句，有态度]

❓ [互动提问]

⚠️ 不构成投资建议`,
    frequency: 'reactive',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_whale_move',
    name: '🐋 巨鲸速报',
    description: '巨鲸大额异动速报',
    type: 'post',
    category: 'reactive',
    unified_type: 'whale_move',
    prompt: `写一条巨鲸异动速报。

## 巨鲸动态
{{news}}

## 市场背景
{{market_data}}

## 输出格式（150-250字）
🐋 [一句话概括巨鲸在做什么]

[2-3个要点：交易规模、可能意图、市场影响]

💡 [个人观点]

❓ [互动提问]

⚠️ 不构成投资建议

## 禁止
- 不给具体合约地址
- 不喊买卖`,
    frequency: 'reactive',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_extreme_fear',
    name: '😱 情绪分析',
    description: '恐惧贪婪指数极端值时的市场情绪分析',
    type: 'post',
    category: 'reactive',
    unified_type: 'extreme_fear',
    prompt: `写一条市场情绪分析。

## 当前状态
{{market_data}}

## 最新新闻
{{news_summary}}

## 输出格式（150-250字）
😱 市场极度恐惧 / 🤑 市场极度贪婪

[一句话定调]

[2-3段分析：历史上这种情绪意味什么、当前市场异同、逆向思维可能性]

💡 [个人观点]

❓ [互动提问]

⚠️ 不构成投资建议

## 禁止
- 不喊抄底/逃顶`,
    frequency: 'reactive',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_chart_analysis',
    name: '📈 盘面分析',
    description: 'K线技术分析+支撑压力位+盈亏比建议',
    type: 'post',
    category: 'on_demand',
    prompt: `你是一个技术分析师，为币安广场写盘面分析。

## 分析标的
{{topic}}

## 数据
{{market_data}}

## 输出格式
📊 [代币] 技术分析 | [日期]

📉 关键位置
- 压力位: $X (原因)
- 支撑位: $X (原因)
- 当前位置: 距压力位 X%, 距支撑位 X%

📈 形态判断
[2-3句技术面分析]

💰 盈亏比评估
- 做多盈亏比: X:X
- 做空盈亏比: X:X

🎯 操作建议
[明确建议，多/空/观望，带具体理由]

## 规则
- 200-300字
- 压力/支撑位要有依据（前高前低/均线/整数关口）
- 盈亏比要用具体数字
- 不用"让我们看看"等AI味句子`,
    frequency: 'on_demand',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_airdrop_tutorial',
    name: '🪂 空投教程',
    description: '项目背景+交互步骤+风险提示',
    type: 'post',
    category: 'on_demand',
    unified_type: 'airdrop_tutorial',
    prompt: `你是一个资深链上玩家，写一份简明的 Web3 项目空投/交互教程。

## 重要约束
- "交互"是指与 Web3 智能合约/DeFi协议/DApp 进行链上操作（如 swap、bridge、stake、mint、provide liquidity）
- "空投"是指项目方向早期用户发放代币奖励
- 不要写交易所买卖操作，不要写 K 线分析，不要写交易策略
- 如果 topic 不是一个 Web3 项目（如 BTC、ETH、行情分析），直接拒绝并回复"该主题不适合空投教程模板"

## 项目
{{topic}}

## 输出格式
🪂 [项目名] 空投交互教程

📦 项目简介
[1-2句：做什么的、所在链、融资情况、为什么值得关注]

🛠 交互步骤（按操作顺序）
1. [准备钱包：推荐用哪个钱包、切换到哪条链]
2. [核心交互1：如 swap/bridge/stake，给具体网址和操作]
3. [核心交互2：如提供流动性/mint NFT]
4. [可选进阶操作]

💰 预估成本
- Gas费用：[根据所在链估算]
- 交互资金：[最少需要多少资金]

⚠️ 风险提示
[智能合约风险、资金损失风险等]

## 规则
- 300-500字
- 步骤要具体可操作（给网址、给合约地址或说明在哪找）
- 如果没有可靠信息，宁可说"请自行查证最新交互方式"，不要编造
- 必须包含风险提示`,
    frequency: 'on_demand',
    requires_disclaimer: true
  },
  {
    id: 'tpl_macro_analysis',
    name: '🏛️ 宏观解读',
    description: '美联储/CPI/就业等宏观数据对加密市场的影响',
    type: 'post',
    category: 'on_demand',
    unified_type: 'macro_analysis',
    prompt: `你是一个宏观分析师，解读经济数据对加密市场的影响。

## 事件
{{topic}}

## 数据
{{market_data}}

## 输出格式
🏛️ 宏观速递 | [事件名]

📊 数据速览
[核心数据点，用数字说话]

🔍 市场解读
[2-3段分析，每段一个论点]
- 对BTC的影响: ...
- 对ETH的影响: ...
- 资金流向预判: ...

💡 操作建议
[明确的观点，不要模棱两可]

## 规则
- 300-500字
- 用通俗语言解释专业概念
- 要有明确的操作建议
- 不用AI味句子`,
    frequency: 'on_demand',
    needs_market_data: true,
    requires_disclaimer: true
  },
  {
    id: 'tpl_morning_brief_REMOVED',  // Removed 2026-06-24: low engagement
  }
];

// ========== AI 调用 ==========

/**
 * 调用 AI 生成内容
 * @param {string} prompt - user prompt
 * @param {Object} config - { provider, api_key, model, base_url }
 * @param {string|null} systemPrompt - 可选的 system prompt（来自统一模板源）
 * @returns {string} 生成的内容
 */
export async function generateContent(prompt, config = {}, systemPrompt = null) {
  const provider = config.provider || 'openai';
  const apiKey = config.api_key;
  const model = config.model || 'gpt-4o-mini';
  const baseUrl = config.base_url || 'https://api.openai.com';

  if (!apiKey) {
    throw new Error('AI API key not configured');
  }

  // 智谱 GLM 需要生成 JWT token
  let authToken = apiKey;
  if (baseUrl.includes('bigmodel.cn') && apiKey.includes('.')) {
    const crypto = await import('crypto');
    const [id, secret] = apiKey.split('.');
    const header = Buffer.from(JSON.stringify({alg:'HS256',sign_type:'SIGN'})).toString('base64url');
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({api_key:id,exp:now+3600000,timestamp:now})).toString('base64url');
    const sign = crypto.createHmac('sha256', secret).update(header+'.'+payload).digest('base64url');
    authToken = header+'.'+payload+'.'+sign;
  }

  // 智谱 GLM: base_url = https://open.bigmodel.cn/api/paas/v4
  // 智谱 GLM 编码套餐: base_url = https://open.bigmodel.cn/api/coding/paas/v4
  // OpenAI 兼容: base_url = https://api.openai.com/v1
  let url;
  if (baseUrl.includes('bigmodel.cn')) {
    // 尊重 base_url 中的路径（支持 /coding/ 套餐）
    if (baseUrl.includes('/coding/')) {
      url = new URL('/api/coding/paas/v4/chat/completions', baseUrl);
    } else {
      url = new URL('/api/paas/v4/chat/completions', baseUrl);
    }
  } else {
    url = new URL('/v1/chat/completions', baseUrl);
  }
  
  const sysContent = systemPrompt || '你是一个有5年实战经验的加密交易员，在币安广场写帖子。你的帖子需要吸引人点进来并读完。\n\n直接输出内容，不要加任何前言、解释或markdown代码块。\n\n## 写作铁律（违反任何一条都会导致帖子无人看）\n\n### 内容层\n- **干货优先**：每篇至少包含一个具体项目名、数据点或链上指标。空话=废话\n- **禁止套话**：不要用"叙事确定性极强""想象空间巨大""聪明资金已布局""迟早爆发"——这些都是废话模板\n- **相关性**：分析必须和新闻主题相关。新闻讲体育+加密就去分析体育赛道项目，不要跑题到BTC大盘\n- **预测要有理由**：不只说"看涨"，要说为什么（技术面/资金面/情绪面的具体依据）\n\n### 风格层\n- 口语化，像真实交易员在群里聊天，不是写报告\n- 有明确观点，不模棱两可，敢说多空\n- 禁止AI腔：不要"让我们看看""值得注意的是""总的来说""不可否认""毋庸置疑"\n- 自然口语：可用"说实话""说白了""讲真"，但不要每篇都用\n- 价格格式：BTC $65,703 或 $65.7K，ETH $1,719 或 $1.72K\n- 资金量简写：$316M = 3.16亿美元\n\n### 结构层\n- 标题要具体有信息量，不要标题党（"炸裂""捡钱"=无人点）\n- 可以用问句或反直觉事实做标题\n- 互动提问要和内容相关，不要生硬CTA';

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: sysContent },
      { role: 'user', content: prompt }
    ],
    max_tokens: 4096,
    temperature: 0.8
  });

  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices?.[0]?.message?.content) {
            resolve(json.choices[0].message.content.trim());
          } else if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
          } else {
            reject(new Error('Unexpected AI response: ' + data.substring(0, 200)));
          }
        } catch (e) {
          reject(new Error('Parse error: ' + data.substring(0, 200)));
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('AI request timeout')); });
    req.write(body);
    req.end();
  });
}

// ========== 市场数据获取 ==========

/**
 * 获取市场数据（注入到模板）
 */
export async function fetchMarketData() {
  const data = {
    timestamp: new Date().toISOString(),
    prices: {},
    fear_greed: null,
    news: []
  };

  // BTC/ETH 等价格（CoinGecko 免费 API）
  try {
    const priceData = await httpGet('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple,dogecoin&vs_currencies=usd&include_24hr_change=true');
    const prices = JSON.parse(priceData);
    data.prices = {
      BTC: { price: prices.bitcoin?.usd, change_24h: prices.bitcoin?.usd_24h_change?.toFixed(2) },
      ETH: { price: prices.ethereum?.usd, change_24h: prices.ethereum?.usd_24h_change?.toFixed(2) },
      SOL: { price: prices.solana?.usd, change_24h: prices.solana?.usd_24h_change?.toFixed(2) },
      BNB: { price: prices.binancecoin?.usd, change_24h: prices.binancecoin?.usd_24h_change?.toFixed(2) },
    };
  } catch (e) {
    data.prices._error = e.message;
  }

  // 恐惧贪婪指数
  try {
    const fgData = await httpGet('https://api.alternative.me/fng/?limit=1');
    const fg = JSON.parse(fgData);
    data.fear_greed = {
      value: fg.data?.[0]?.value,
      classification: fg.data?.[0]?.value_classification
    };
  } catch (e) {
    data.fear_greed = { _error: e.message };
  }

  return data;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ========== 内容生成主函数 ==========

/**
 * 根据模板+数据生成内容
 * @param {Object} template - 模板对象
 * @param {Object} userConfig - 用户配置 { footer, topics, ai_config }
 * @param {Object} params - 额外参数 { topic, news }
 * @returns {Object} { content, options?, topics? }
 */
export async function generateFromTemplate(template, userConfig = {}, params = {}) {
  // 1. 收集数据
  let marketDataStr = '';
  if (template.needs_market_data) {
    try {
      const md = await fetchMarketData();
      marketDataStr = formatMarketData(md);
    } catch (e) {
      marketDataStr = '(市场数据获取失败，请基于常识编写)';
    }
  }

  // 2. 组装 prompt — 优先使用统一模板源
  let systemPrompt = null;
  let userPrompt = null;

  if (template.unified_type && UNIFIED_TEMPLATES[template.unified_type]) {
    // 使用 templates.mjs 统一模板构建 prompt
    const tplData = {
      title: params.news || params.topic || '',
      desc: params.news || '',
      news: params.news || '',
      newsList: params.news || '',
      newsCtx: params.news_summary || '',
      topic: params.topic || '',
      marketCtx: marketDataStr,
      onchainData: params.onchain_data || '(无链上事件数据)',
      text: params.news || '',
      source: '',
      // fear_greed 相关
      value: undefined,
      classification: '',
    };

    // 解析恐惧贪婪指数
    if (marketDataStr.includes('恐惧贪婪指数:')) {
      const fgMatch = marketDataStr.match(/恐惧贪婪指数:\s*(\d+)\s*\(([^)]+)\)/);
      if (fgMatch) {
        tplData.value = parseInt(fgMatch[1]);
        tplData.classification = fgMatch[2];
      }
    }

    const unified = buildUnifiedPrompt(template.unified_type, tplData);
    systemPrompt = unified.system;
    userPrompt = unified.user;
  }

  // fallback: 使用旧的内联 prompt
  if (!userPrompt) {
    userPrompt = template.prompt
      .replace('{{market_data}}', marketDataStr)
      .replace('{{topic}}', params.topic || 'BTC当前走势')
      .replace('{{news}}', params.news || '')
      .replace('{{news_summary}}', params.news_summary || '')
      .replace('{{onchain_data}}', params.onchain_data || '(无链上事件数据)');
  }

  // 添加用户自定义规则到 userPrompt
  if (userConfig.footer) {
    userPrompt += `\n\n## 固定结尾（每篇都要加）\n${userConfig.footer}`;
  }
  if (userConfig.topics?.length) {
    userPrompt += `\n\n## 话题标签\n自动加上: ${userConfig.topics.join(' ')}`;
  }
  if (userConfig.style_rules) {
    userPrompt += `\n\n## 额外风格要求\n${userConfig.style_rules}`;
  }

  // 4. 调 AI 生成（统一模板用 system+user 两部分，旧模板只有 user 部分）
  const rawContent = await generateContent(userPrompt, userConfig.ai_config, systemPrompt);

  // 5. 合规过滤
  let content = rawContent;
  content = applyComplianceFilter(content, template);

  // 5.5 价格校验/修正 — 防止 AI 生成时丢失或编造价格数字
  if (marketDataStr) {
    content = fixMarketPrices(content, marketDataStr);
  }

  // 5.6 预判次数注入（仅对含"影响预判"的新闻类帖子）
  if (content.includes('影响预判')) {
    const counterPath = paths.predictionCounter;
    try {
      const counter = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
      counter.count += 1;
      fs.writeFileSync(counterPath, JSON.stringify(counter));
      content = content.replace(
        '🎯 影响预判',
        `🎯 第${counter.count}次预判`
      );
    } catch {}
  }

  // 6. 后处理
  if (template.type === 'poll') {
    // 投票帖：解析 JSON
    try {
      const parsed = JSON.parse(content.replace(/```json\n?|```/g, '').trim());
      return {
        type: 'poll',
        content: applyComplianceFilter(parsed.content, template),
        options: parsed.options,
        topics: parsed.topics || userConfig.topics || []
      };
    } catch {
      // JSON解析失败，fallback
      return {
        type: 'post',
        content: applyComplianceFilter(content, template),
        topics: userConfig.topics || []
      };
    }
  }

  return {
    type: 'post',
    content,
    topics: userConfig.topics || []
  };
}

/**
 * 合规过滤器
 * 1. 禁止词检测
 * 2. 合约地址检测
 * 3. 免责声明自动尾缀
 */
function applyComplianceFilter(content, template) {
  // 禁止词列表
  const bannedPhrases = [
    '保本', '保收益', '稳赚', '包赚', '必涨', '必跌', '零风险',
    '稳操胜券', '百分百', '100%', '翻倍', '财富自由',
    '加我微信', '加我QQ', '私聊', '场外交易',
  ];

  let filtered = content;
  const warnings = [];

  // 检测禁止词
  for (const phrase of bannedPhrases) {
    if (filtered.includes(phrase)) {
      warnings.push(`⚠️ 合规拦截: 包含禁止词 "${phrase}"`);
      // 替换为安全表达
      filtered = filtered.replaceAll(phrase, '[已过滤]');
    }
  }

  // 检测合约地址（0x 开头 40位十六进制）
  const contractRegex = /0x[a-fA-F0-9]{40}/g;
  if (contractRegex.test(filtered)) {
    warnings.push('⚠️ 合规拦截: 包含合约地址');
    filtered = filtered.replace(contractRegex, '[合约地址已移除]');
  }

  // 自动添加免责声明（如果模板要求且内容中还没有）
  if (template.requires_disclaimer || template.type === 'post') {
    const hasDisclaimer = filtered.includes('不构成投资建议') || filtered.includes('NFA') || filtered.includes('DYOR');
    if (!hasDisclaimer) {
      filtered += '\n\n⚠️ 不构成投资建议，据此投资，责任自负。DYOR。';
    }
  }

  if (warnings.length > 0) {
    console.log(`[合规过滤] ${warnings.join('; ')}`);
  }

  return filtered;
}

/**
 * 价格校验/修正
 * AI 生成内容时可能丢失或编造价格数字，此函数从 marketDataStr 中
 * 解析真实价格，检查 content 中的价格是否偏差过大，如果是则替换。
 */
function fixMarketPrices(content, marketDataStr) {
  // 从市场数据字符串中解析真实价格
  // 格式: "BTC: $64,157 (📉-0.17%)" 或 "BTC: $104,244.50 (📈1.2%)"
  const priceMap = {};
  const lines = marketDataStr.split('\n');
  for (const line of lines) {
    // 匹配 "SYM: $数字" 格式
    const m = line.match(/^(BTC|ETH|SOL|BNB):\s*\$([\d,]+(?:\.\d+)?)/);
    if (m) {
      priceMap[m[1]] = parseFloat(m[2].replace(/,/g, ''));
    }
  }

  if (Object.keys(priceMap).length === 0) return content;

  let fixed = content;
  const corrections = [];

  for (const [sym, realPrice] of Object.entries(priceMap)) {
    const realPriceStr = realPrice.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const realPriceInt = Math.round(realPrice);

    // 中文别名
    const aliases = sym === 'BTC' ? ['BTC', '比特币', '大饼'] :
                    sym === 'ETH' ? ['ETH', '以太坊', '以太'] :
                    sym === 'SOL' ? ['SOL', '索拉纳'] :
                    sym === 'BNB' ? ['BNB'] : [sym];

    // 构建 alias 匹配正则
    const aliasPattern = aliases.join('|');

    // 模式1: "BTC在 4,244.14" 或 "BTC 4,244.14" — 关键词后跟价格（无$符号）
    const regex1 = new RegExp(`(${aliasPattern})([^\\d$]{0,10})([\\d,]+(?:\\.\\d+)?)`, 'g');
    fixed = fixed.replace(regex1, (match, kw, gap, numStr) => {
      const num = parseFloat(numStr.replace(/,/g, ''));
      if (!num || num < 1) return match;
      // 检查偏差是否超过10%
      const deviation = Math.abs(num - realPrice) / realPrice;
      if (deviation > 0.1) {
        // 保留原始格式风格（有逗号）
        corrections.push(`${sym}: ${numStr} → ${realPriceStr}`);
        return `${kw}${gap}${realPriceStr}`;
      }
      return match;
    });

    // 模式2: "$4,244.14" 前面有关键词 — 带$符号的价格
    const regex2 = new RegExp(`(${aliasPattern})([^$]{0,15})\$([\\d,]+(?:\\.\\d+)?)`, 'g');
    fixed = fixed.replace(regex2, (match, kw, gap, numStr) => {
      const num = parseFloat(numStr.replace(/,/g, ''));
      if (!num || num < 1) return match;
      const deviation = Math.abs(num - realPrice) / realPrice;
      if (deviation > 0.1) {
        corrections.push(`${sym}: $${numStr} → $${realPriceStr}`);
        return `${kw}${gap}$${realPriceStr}`;
      }
      return match;
    });

    // 模式3: "$数字" 后面有关键词 — 例如 "$4,244的BTC"
    const regex3 = new RegExp(`\$([\\d,]+(?:\\.\\d+)?)([^]{0,8})(${aliasPattern})`, 'g');
    fixed = fixed.replace(regex3, (match, numStr, gap, kw) => {
      const num = parseFloat(numStr.replace(/,/g, ''));
      if (!num || num < 1) return match;
      const deviation = Math.abs(num - realPrice) / realPrice;
      if (deviation > 0.1) {
        corrections.push(`${sym}: $${numStr} → $${realPriceStr}`);
        return `$${realPriceStr}${gap}${kw}`;
      }
      return match;
    });
  }

  if (corrections.length > 0) {
    console.log(`[价格修正] ${corrections.join('; ')}`);
  }

  return fixed;
}

function formatMarketData(md) {
  const lines = ['当前市场数据:'];
  for (const [sym, info] of Object.entries(md.prices)) {
    if (sym.startsWith('_')) continue;
    const arrow = parseFloat(info.change_24h) >= 0 ? '📈' : '📉';
    lines.push(`${sym}: $${info.price?.toLocaleString()} (${arrow}${info.change_24h}%)`);
  }
  if (md.fear_greed?.value) {
    lines.push(`恐惧贪婪指数: ${md.fear_greed.value} (${md.fear_greed.classification})`);
  }
  lines.push(`时间: ${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}
