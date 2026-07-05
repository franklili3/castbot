// approval-flow.mjs — 多角色审批状态机
//
// 状态流：draft → compliance_ok → editor_ok → published
// 可配置流程：
//   auto:       draft → published (跳过所有审核)
//   review:     draft → editor_ok → published (TG 按钮确认)
//   multi-step: draft → compliance_ok → editor_ok → published (完整流程)
//
// 在 news-pipeline 生成内容后调用，在 publisher 发帖前检查

export const APPROVAL_STAGES = {
  DRAFT: 'draft',                 // 刚生成
  COMPLIANCE_OK: 'compliance_ok', // 合规预审通过
  EDITOR_OK: 'editor_ok',         // 运营/交易员确认
  PUBLISHED: 'published',         // 已发布
  REJECTED: 'rejected',           // 被拒绝
};

export const FLOW_MODES = {
  AUTO: 'auto',           // 全自动：合规过滤后直接发布
  REVIEW: 'review',       // 人工审核：TG 按钮确认后发布
  MULTI_STEP: 'multi-step', // 多级审核：合规预审 → 运营编辑 → 发布
};

// 内容类型 → 默认流程
const TYPE_FLOW_MAP = {
  breaking_news: FLOW_MODES.AUTO,     // 突发新闻：快，自动发
  price_move: FLOW_MODES.AUTO,        // 价格异动：快，自动发
  deep_analysis: FLOW_MODES.REVIEW,   // 深度分析：需人工确认
  opinion: FLOW_MODES.MULTI_STEP,     // 观点帖：需多级审核
  series: FLOW_MODES.REVIEW,          // 系列内容：需确认
};

/**
 * 获取内容类型对应的审批流程
 */
export function getFlowMode(contentType = 'breaking_news', globalMode = 'auto') {
  // 全局模式优先
  if (globalMode === 'multi-step') return FLOW_MODES.MULTI_STEP;
  if (globalMode === 'review') return FLOW_MODES.REVIEW;
  
  // 按内容类型
  return TYPE_FLOW_MAP[contentType] || FLOW_MODES.AUTO;
}

/**
 * 判断内容是否可以发布
 * @param {string} currentStage - 当前审批阶段
 * @param {string} flowMode - 审批流程模式
 */
export function canPublish(currentStage, flowMode) {
  switch (flowMode) {
    case FLOW_MODES.AUTO:
      // 自动模式：合规通过即可（compliance_filter 已在 pipeline 中完成）
      return true;
    case FLOW_MODES.REVIEW:
      return currentStage === APPROVAL_STAGES.EDITOR_OK;
    case FLOW_MODES.MULTI_STEP:
      return currentStage === APPROVAL_STAGES.EDITOR_OK;
    default:
      return true;
  }
}

/**
 * 审批阶段中文描述
 */
export const STAGE_LABELS = {
  draft: '📝 待审核',
  compliance_ok: '🛡️ 合规通过',
  editor_ok: '✅ 审核通过',
  published: '📤 已发布',
  rejected: '🚫 已拒绝',
};

/**
 * 构建审批通知文本（用于 TG 通知）
 */
export function buildApprovalNotification(content, stage, flowMode) {
  const label = STAGE_LABELS[stage] || stage;
  const preview = content.split('\n')[0].substring(0, 60);
  
  if (flowMode === FLOW_MODES.AUTO) {
    return null; // 自动模式不发审核通知
  }
  
  return [
    `📋 ${label}`,
    `流程: ${flowMode}`,
    `预览: ${preview}...`,
  ].join('\n');
}
