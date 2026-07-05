// risk-disclaimer.mjs — 风险提示自动注入
//
// 根据内容类型自动追加不同的风险提示

const DISCLAIMERS = {
  // 含交易观点的内容（影响预判、价格分析）
  prediction: '⚠️ 不构成投资建议，预测仅供参考，DYOR',
  
  // 链上数据类
  onchain: '⚠️ 链上数据仅供参考，不构成投资建议',
  
  // 新闻解读类
  news: '⚠️ 不构成投资建议',
  
  // 投票互动类
  poll: '⚠️ 投票结果不构成投资建议',
  
  // 通用
  default: '⚠️ 不构成投资建议',
};

// 检查内容是否已有风险提示
export function hasDisclaimer(text) {
  return /不构成投资建议|DYOR|投资有风险|仅供参考/.test(text);
}

// 注入风险提示（如果还没有）
export function injectDisclaimer(text, type = 'default') {
  if (hasDisclaimer(text)) return text;

  const disclaimer = DISCLAIMERS[type] || DISCLAIMERS.default;
  
  // 插入到最后一行之前（通常是互动提问之前）
  const lines = text.trimEnd().split('\n');
  
  // 找到最后一个非空行
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx--;
  
  // 如果最后一行是互动提问（❓），插在它前面
  if (lines[lastIdx]?.includes('❓')) {
    lines.splice(lastIdx, 0, '', disclaimer, '');
  } else {
    lines.push('', disclaimer);
  }

  return lines.join('\n');
}

// 获取适用的免责声明类型
export function detectDisclaimerType(content) {
  if (content.includes('影响预判') || content.includes('预测涨') || content.includes('预测跌')) {
    return 'prediction';
  }
  if (content.includes('链上') || content.includes('巨鲸') || content.includes(' Whale')) {
    return 'onchain';
  }
  if (content.includes('📰') || content.includes('新闻') || content.includes('快讯')) {
    return 'news';
  }
  if (content.includes('投票') || content.includes('Poll')) {
    return 'poll';
  }
  return 'default';
}
