/**
 * 操作码序列生成器
 * 
 * 根据任务类型，从UI配置生成操作码序列
 * 云端生成ops，下发到Agent执行
 * 
 * 操作码定义见 square-agent-publisher/opcodes.mjs
 */

// 操作码常量（和 opcodes.mjs 保持一致）
const OP = {
  NAVIGATE:     0x01,
  CLICK_COORDS: 0x02,
  CLICK_GLOBAL: 0x03,
  PASTE_TEXT:   0x04,
  TYPE_TEXT:    0x05,
  PRESS_KEY:    0x06,
  RUN_JS:       0x07,
  SLEEP:        0x08,
  EXPAND_EDITOR:     0x10,
  FOCUS_EDITOR:      0x11,
  INPUT_CONTENT:     0x12,
  SCROLL_TOP:        0x13,
  ADD_TOPICS:        0x14,
  OPEN_MORE_MENU:    0x20,
  CREATE_POLL:       0x21,
  FILL_POLL_OPTION:  0x22,
  VERIFY_POLL_INPUTS:0x23,
  FIND_PUBLISH_BTN:  0x30,
  CLICK_PUBLISH:     0x31,
  CHECK_FOCUS:       0x40,
  VERIFY_CONTENT:    0x41,
  CHECK_PM_EXISTS:   0x42,
  FIND_COMMENT_BOX:  0x50,
  SUBMIT_COMMENT:    0x51,
};

// 延迟参数（毫秒）— 这些是基准值，实际执行时 humanize 会加 ±30% 抖动
const D = {
  PAGE_LOAD: 5000,
  EDITOR_EXPAND: 1000,
  AFTER_FOCUS: 500,
  AFTER_PASTE: 2000,
  AFTER_TYPE: 1000,
  AFTER_MENU: 3000,
  AFTER_POLL_CREATE: 2000,
  AFTER_OPTION_FILL: 1000,
  AFTER_TOPIC_TYPE: 2000,
  AFTER_TOPIC_ENTER: 500,
  AFTER_SCROLL: 500,
  AFTER_PUBLISH: 5000,
  AFTER_COMMENT_FOCUS: 500,
};

/**
 * 拟人化延迟：在 ops 的 d 字段中加入抖动标记
 * Agent 端的 humanSleep 会自动加 ±30% 抖动
 */

/**
 * 根据任务类型生成操作码序列
 * @param {string} type - post | poll | comment | stats
 * @param {Object} uiConfig - 当前UI配置
 * @returns {Array} ops序列 [{k, p?, d?}, ...]
 */
export function generateOps(type, uiConfig = {}) {
  const cfg = uiConfig.actions || {};
  const sel = uiConfig.selectors || {};
  const delays = { ...D, ...(uiConfig.delays || {}) };
  const chrome = uiConfig.chrome || { screen_y: 30, ui_height: 121 };

  switch (type) {
    case 'post':
      return generatePostOps(cfg, delays);
    case 'poll':
      return generatePollOps(cfg, delays);
    case 'comment':
      return generateCommentOps(delays);
    default:
      return [];
  }
}

function generatePostOps(cfg, delays) {
  const expandCoords = cfg.expand_editor?.coords || [500, 170];
  const moreCoords = cfg.click_more_button?.global_coords || [531, 590];
  const publishX = cfg.click_publish?.viewport_x || 903;
  const publishOffsetY = cfg.click_publish?.y_offset_center || 16;

  return [
    // 导航到广场
    { k: OP.NAVIGATE, p: ['https://www.binance.com/zh-CN/square'], d: delays.PAGE_LOAD },
    
    // 展开编辑器
    { k: OP.EXPAND_EDITOR, p: expandCoords, d: delays.EDITOR_EXPAND },
    
    // Focus ProseMirror
    { k: OP.FOCUS_EDITOR, d: delays.AFTER_FOCUS },
    
    // 检查PM
    { k: OP.CHECK_PM_EXISTS },
    
    // 输入内容
    { k: OP.INPUT_CONTENT, d: delays.AFTER_PASTE },
    
    // 验证内容
    { k: OP.VERIFY_CONTENT },
    
    // 添加话题
    { k: OP.ADD_TOPICS, p: [delays.AFTER_TOPIC_TYPE, delays.AFTER_TOPIC_ENTER] },
    
    // 滚到顶部
    { k: OP.SCROLL_TOP, d: delays.AFTER_SCROLL },
    
    // 查找发文按钮
    { k: OP.FIND_PUBLISH_BTN, p: ['发文', 800, 950, 50, 100] },
    
    // 点击发文
    { k: OP.CLICK_PUBLISH, p: [publishX, publishOffsetY], d: delays.AFTER_PUBLISH },
  ];
}

function generatePollOps(cfg, delays) {
  const expandCoords = cfg.expand_editor?.coords || [500, 170];
  const moreCoords = cfg.click_more_button?.global_coords || [531, 590];
  const pollBaseY = cfg.click_poll_option?.base_viewport_y || 429;
  const pollStepY = cfg.click_poll_option?.y_step || 52;
  const pollX = cfg.click_poll_option?.viewport_x || 480;

  return [
    // 导航+展开
    { k: OP.NAVIGATE, p: ['https://www.binance.com/zh-CN/square'], d: delays.PAGE_LOAD },
    { k: OP.EXPAND_EDITOR, p: expandCoords, d: delays.EDITOR_EXPAND },
    { k: OP.FOCUS_EDITOR, d: delays.AFTER_FOCUS },
    { k: OP.CHECK_PM_EXISTS },
    
    // 输入短内容
    { k: OP.INPUT_CONTENT, d: delays.AFTER_PASTE },
    
    // 滚到顶部 + 点更多
    { k: OP.SCROLL_TOP, d: delays.AFTER_SCROLL },
    { k: OP.OPEN_MORE_MENU, p: moreCoords, d: delays.AFTER_MENU },
    
    // 创建投票
    { k: OP.CREATE_POLL, p: ['创建投票', 400, 700], d: delays.AFTER_POLL_CREATE },
    
    // 验证投票input
    { k: OP.VERIFY_POLL_INPUTS, p: [400, 530, 100] },
    
    // 填选项1
    { k: OP.FILL_POLL_OPTION, p: [0, pollBaseY, pollStepY, pollX], d: delays.AFTER_OPTION_FILL },
    
    // 填选项2
    { k: OP.FILL_POLL_OPTION, p: [1, pollBaseY, pollStepY, pollX], d: delays.AFTER_OPTION_FILL },
    
    // 查找发文按钮
    { k: OP.FIND_PUBLISH_BTN, p: ['发文', 800, 950, 50, 100] },
    
    // 点击发文
    { k: OP.CLICK_PUBLISH, p: [903, 16], d: delays.AFTER_PUBLISH },
  ];
}

function generateCommentOps(delays) {
  return [
    // 导航到帖子（URL从task.content取）
    { k: OP.NAVIGATE, p: ['__POST_URL__'], d: delays.PAGE_LOAD },
    
    // 找评论框
    { k: OP.FIND_COMMENT_BOX, d: delays.AFTER_COMMENT_FOCUS },
    
    // 输入评论
    { k: OP.INPUT_CONTENT, d: delays.AFTER_TYPE },
    
    // 提交
    { k: OP.SUBMIT_COMMENT },
  ];
}
