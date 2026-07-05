// banned-words.mjs — 加密金融内容禁用词库
// 
// 分三级：绝对禁止 / 条件禁止（需加风险提示） / 平台特有

export const BANNED_LEVELS = {
  BLOCK: 'block',      // 绝对禁止，内容直接拒绝发布
  WARN: 'warn',        // 条件禁止，替换 + 注入风险提示
  SOFT: 'soft',        // 软性提醒，仅记录日志
};

// 绝对禁止词（违反各国金融广告法）
const BLOCK_WORDS = [
  // 收益承诺
  '保本', '保收益', '稳赚', '必涨', '必跌', '翻倍', '百倍', '千倍',
  '零风险', '无风险', '百分百', '100%盈利', '保证盈利', '稳赢',
  '暴富', '发财', '财富自由', '一夜暴富',
  // 内幕信息
  '内部消息', '内幕', ' insider', '未公开信息', '独家秘籍',
  // 欺诈诱导
  '免费领', '空投领取', '点击领取', '限时领取',
  '加微信', '加群', '私聊领取', '扫码领',
];

// 条件禁止词（需要追加风险提示或替换表述）
const WARN_WORDS = [
  // 荐币类
  '强烈推荐买入', '强烈建议买入', '赶紧买', '梭哈', 'all in',
  '目标价', '看到多少', '涨到', '跌到',
  // 跟单类
  '跟单', '带单', '代操盘', '代投',
  // 止损/止盈位（具体数字 = 变相荐币）
  '止损位', '止盈位',
];

// 币安广场平台特有限制
const BINANCE_SOFT_WORDS = [
  '合约', '杠杆', '做空', '做多', '开多', '开空',
  '永续合约', '交割合约', '期权',
  // 这些不是禁止词，但如果密度过高可能触发审核
];

export function checkContent(text) {
  const findings = {
    blocked: [],
    warned: [],
    soft: [],
    passed: true,
  };

  const lowerText = text.toLowerCase();

  // 检查绝对禁止词
  for (const word of BLOCK_WORDS) {
    if (lowerText.includes(word.toLowerCase())) {
      findings.blocked.push(word);
    }
  }

  // 检查条件禁止词
  for (const word of WARN_WORDS) {
    if (lowerText.includes(word.toLowerCase())) {
      findings.warned.push(word);
    }
  }

  // 检查软性词（仅记录）
  for (const word of BINANCE_SOFT_WORDS) {
    if (lowerText.includes(word.toLowerCase())) {
      findings.soft.push(word);
    }
  }

  findings.passed = findings.blocked.length === 0;
  return findings;
}

// 替换禁用词为安全表述
const REPLACEMENTS = {
  '保本': '控制风险',
  '保收益': '管理预期',
  '稳赚': '有较大概率',
  '翻倍': '有上涨空间',
  '暴富': '获得收益',
  '零风险': '低风险',
  '无风险': '低风险',
  '百分百': '大概率',
  '保证盈利': '有盈利可能',
  '稳赢': '有优势',
  '强烈推荐买入': '值得关注',
  '强烈建议买入': '可以考虑',
  '赶紧买': '可以关注',
  '梭哈': '适度配置',
  'all in': '适度配置',
};

export function autoReplace(text) {
  let result = text;
  const replaced = [];

  for (const [bad, good] of Object.entries(REPLACEMENTS)) {
    const regex = new RegExp(bad, 'gi');
    if (regex.test(result)) {
      result = result.replace(regex, good);
      replaced.push(`${bad} → ${good}`);
    }
  }

  return { text: result, replaced };
}
