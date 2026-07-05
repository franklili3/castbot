// compliance/index.mjs — 合规过滤入口
//
// pipeline 后处理：内容生成后 → 合规过滤 → 发布
//
// 流程：禁用词检查 → 自动替换 → 风险提示注入 → 辖区路由

import { checkContent, autoReplace } from './banned-words.mjs';
import { hasDisclaimer, injectDisclaimer, detectDisclaimerType } from './risk-disclaimer.mjs';
import { applyJurisdiction, getPlatformJurisdiction } from './jurisdiction.mjs';

/**
 * 合规过滤主函数
 * @param {string} content - 原始内容
 * @param {object} options - { platform, jurisdiction, strict }
 * @returns {object} { content, passed, violations, actions }
 */
export function complianceFilter(content, options = {}) {
  const {
    platform = 'binance',
    jurisdiction = null,
    strict = true,
  } = options;

  const actions = [];
  const violations = [];

  // 1. 禁用词检查
  const check = checkContent(content);
  
  if (check.blocked.length > 0) {
    violations.push({ level: 'block', words: check.blocked });
    
    if (strict) {
      // 严格模式：直接拒绝
      return {
        content,
        passed: false,
        violations,
        actions: [`🚫 拒绝发布：包含绝对禁止词 ${check.blocked.join(', ')}`],
      };
    }
  }

  // 2. 自动替换条件禁止词
  const { text: replacedText, replaced } = autoReplace(content);
  if (replaced.length > 0) {
    actions.push(`🔄 自动替换：${replaced.join(' | ')}`);
    violations.push({ level: 'warn', words: replaced.map(r => r.split(' → ')[0]) });
  }

  // 3. 风险提示注入
  let finalContent = replacedText;
  if (!hasDisclaimer(finalContent)) {
    const type = detectDisclaimerType(finalContent);
    finalContent = injectDisclaimer(finalContent, type);
    actions.push(`📋 注入风险提示 (${type})`);
  }

  // 4. 辖区路由
  const juris = jurisdiction || getPlatformJurisdiction(platform);
  const jurisResult = applyJurisdiction(finalContent, platform, juris);
  finalContent = jurisResult.content;
  if (jurisResult.violations.length > 0) {
    violations.push({ level: 'jurisdiction', words: jurisResult.violations });
    actions.push(`⚠️ 辖区(${juris})违规词：${jurisResult.violations.join(', ')}`);
  }

  return {
    content: finalContent,
    passed: violations.filter(v => v.level === 'block').length === 0,
    violations,
    actions,
  };
}

export { checkContent, autoReplace, hasDisclaimer, injectDisclaimer, applyJurisdiction };
