// jurisdiction.mjs — 辖区路由
//
// 按发布账号的注册地/目标受众区分内容版本
// 例如：国内平台屏蔽加密交易建议，海外平台正常发布

const JURISDICTIONS = {
  CN: {
    name: '中国大陆',
    // 额外禁止词（国内平台特有）
    extraBlockWords: [
      '交易所注册', '返佣', '邀请码', '注册链接',
      '场外交易', 'OTC', '洗钱',
    ],
    // 必须移除的内容
    stripPatterns: [
      /📚 深度研究[^\n]*/g,    // 移除外链（国内平台对外链限流）
      /🔬 算法专利[^\n]*/g,
    ],
    // 强制风险提示（国内更严格）
    disclaimer: '⚠️ 本文仅为技术分享，不构成任何投资建议。虚拟货币交易在中国大陆受到严格监管，请遵守当地法律法规。',
  },
  GLOBAL: {
    name: '全球/海外',
    extraBlockWords: [],
    stripPatterns: [],
    disclaimer: null, // 用 risk-disclaimer.mjs 的默认逻辑
  },
};

// 根据平台和辖区处理内容
export function applyJurisdiction(content, platform = 'binance', jurisdiction = 'GLOBAL') {
  const rules = JURISDICTIONS[jurisdiction] || JURISDICTIONS.GLOBAL;
  let result = content;

  // 移除辖区禁止内容
  for (const pattern of rules.stripPatterns) {
    result = result.replace(pattern, '').replace(/\n{3,}/g, '\n\n');
  }

  // 检查辖区额外禁止词
  const violations = [];
  for (const word of rules.extraBlockWords) {
    if (result.toLowerCase().includes(word.toLowerCase())) {
      violations.push(word);
    }
  }

  // 强制辖区风险提示
  if (rules.disclaimer && !result.includes(rules.disclaimer.substring(0, 20))) {
    result = result.replace(/⚠️[^\n]*不构成[^\n]*/g, '').trimEnd();
    result += '\n\n' + rules.disclaimer;
  }

  return {
    content: result,
    violations,
    jurisdiction: rules.name,
  };
}

// 获取平台对应的默认辖区
export function getPlatformJurisdiction(platform) {
  // 币安广场 = 全球平台
  if (platform === 'binance') return 'GLOBAL';
  // X/Twitter = 全球平台
  if (platform === 'x' || platform === 'twitter') return 'GLOBAL';
  // Telegram = 全球平台
  if (platform === 'telegram') return 'GLOBAL';
  // 未来：微信公众号/微博 = CN
  return 'GLOBAL';
}
