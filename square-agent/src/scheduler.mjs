// scheduler.mjs — 智能发布调度引擎
//
// 替代固定间隔，实现：
// 1. 间隔随机化（避免被识别为机器行为）
// 2. 窗口避让（避开低流量时段）
// 3. 内容去重增强（标题相似度检查）
// 4. 每日上限动态调整

// ============ 配置 ============
const BASE_INTERVAL_MS = 5 * 60 * 1000;   // 基础间隔 5 分钟
const MAX_INTERVAL_MS = 15 * 60 * 1000;    // 最大间隔 15 分钟
const MIN_INTERVAL_MS = 3 * 60 * 1000;     // 最小间隔 3 分钟（极端情况）

// 低流量时段：凌晨不避让（实测 2-5 点浏览量与白天一致）
const LOW_TRAFFIC_HOURS = [];
const LOW_TRAFFIC_TZ_OFFSET = 8; // Asia/Shanghai

// 每日上限
const DAILY_LIMIT_DEFAULT = 100;
const DAILY_LIMIT_MIN = 20;

// 相似度阈值（标题前 60 字）
const SIMILARITY_THRESHOLD = 0.6;

// ============ 状态 ============
const recentTitles = [];     // 最近发布的标题（用于相似度检查）
const dailyCount = {};       // YYYY-MM-DD → count

// ============ 工具函数 ============

/**
 * 获取当前 CST 小时
 */
function getCSTHour(date = new Date()) {
  return (date.getUTCHours() + LOW_TRAFFIC_TZ_OFFSET) % 24;
}

/**
 * 获取今日日期 key
 */
function getTodayKey(date = new Date()) {
  const cst = new Date(date.getTime() + LOW_TRAFFIC_TZ_OFFSET * 3600 * 1000);
  return cst.toISOString().slice(0, 10);
}

/**
 * 检查当前是否在低流量时段
 */
export function isLowTrafficHour(date = new Date()) {
  return LOW_TRAFFIC_HOURS.includes(getCSTHour(date));
}

/**
 * 计算下一个可发帖时间
 */
export function getNextAvailableTime(date = new Date()) {
  const hour = getCSTHour(date);
  if (!LOW_TRAFFIC_HOURS.includes(hour)) return date;

  // 找到 6:00 AM CST
  const next = new Date(date);
  const currentUTCHour = date.getUTCHours();
  // 6 AM CST = 22:00 UTC (前一天)
  // 如果现在 UTC 是 18:00 (CST 2:00)，下一个可用是 UTC 22:00
  const targetUTCHour = (6 - LOW_TRAFFIC_TZ_OFFSET + 24) % 24; // 22
  let dayOffset = 0;
  if (currentUTCHour >= targetUTCHour) {
    // 已经过了今天的 22:00 UTC，但要检查是否在低流量段
    // 低流量 2-5 CST = 18-21 UTC，如果在这范围内，等 22 UTC
    if (currentUTCHour < 22) {
      // 还在低流量段，等今天 22 UTC
    } else {
      // UTC 22-23 → CST 6-7，已经过了低流量
      return date;
    }
  }
  next.setUTCHours(targetUTCHour, 0, 0, 0);
  if (next <= date) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

// ============ 核心调度函数 ============

/**
 * 计算下一次发帖的等待时间
 * 替代固定 POST_INTERVAL_MS
 */
export function getPostInterval(date = new Date()) {
  // 1. 低流量时段：不发了，等到 6 点
  if (isLowTrafficHour(date)) {
    const next = getNextAvailableTime(date);
    const wait = next.getTime() - date.getTime();
    return {
      delay: wait,
      reason: `low_traffic_sleep_${Math.round(wait / 60000)}min`,
    };
  }

  // 2. 正常时段：随机化间隔
  // 使用正态分布偏好，集中在 BASE 附近
  const noise = (Math.random() + Math.random() + Math.random()) / 3; // 0-1 偏向 0.5
  const interval = MIN_INTERVAL_MS + noise * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);

  return {
    delay: Math.round(interval),
    reason: `random_${Math.round(interval / 1000)}s`,
  };
}

/**
 * 标题相似度检查（简单的 Jaccard 相似度）
 */
function tokenize(text) {
  return new Set(
    text.substring(0, 60)
      .replace(/[^\p{L}\p{N}]/gu, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
}

export function checkSimilarity(newTitle) {
  const newTokens = tokenize(newTitle);
  if (newTokens.size < 2) return { similar: false };

  for (const { title, time } of recentTitles) {
    // 只检查 24 小时内的
    if (Date.now() - time > 24 * 60 * 60 * 1000) continue;

    const oldTokens = tokenize(title);
    if (oldTokens.size < 2) continue;

    // Jaccard 相似度
    const intersection = [...newTokens].filter(t => oldTokens.has(t)).length;
    const union = new Set([...newTokens, ...oldTokens]).size;
    const similarity = intersection / union;

    if (similarity >= SIMILARITY_THRESHOLD) {
      return { similar: true, similarity, matchedTitle: title };
    }
  }

  return { similar: false };
}

/**
 * 记录已发布的标题
 */
export function recordTitle(title) {
  recentTitles.push({ title, time: Date.now() });
  // 清理超过 48 小时的记录
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  while (recentTitles.length > 0 && recentTitles[0].time < cutoff) {
    recentTitles.shift();
  }
}

/**
 * 获取今日已发布数量
 */
export function getDailyCount(date = new Date()) {
  const key = getTodayKey(date);
  return dailyCount[key] || 0;
}

/**
 * 增加今日计数
 */
export function incrementDailyCount(date = new Date()) {
  const key = getTodayKey(date);
  dailyCount[key] = (dailyCount[key] || 0) + 1;
  return dailyCount[key];
}

/**
 * 检查是否还能发帖
 */
export function canPostMore(date = new Date()) {
  const count = getDailyCount(date);
  return count < DAILY_LIMIT_DEFAULT;
}

/**
 * 获取剩余配额
 */
export function getRemainingQuota(date = new Date()) {
  return Math.max(0, DAILY_LIMIT_DEFAULT - getDailyCount(date));
}

/**
 * 综合调度检查：在发帖前调用
 * @returns {object} { allowed, reason, delay }
 */
export function checkSchedule(date = new Date()) {
  // 1. 低流量时段
  if (isLowTrafficHour(date)) {
    const next = getNextAvailableTime(date);
    const wait = next.getTime() - date.getTime();
    return {
      allowed: false,
      reason: `🌙 低流量时段(CST ${getCSTHour(date)}:00)，等待 ${Math.round(wait / 60000)} 分钟到 6:00`,
      delay: wait,
      sleepUntil: next.toISOString(),
    };
  }

  // 2. 每日上限
  if (!canPostMore(date)) {
    return {
      allowed: false,
      reason: `📊 今日已达上限 ${DAILY_LIMIT_DEFAULT} 篇`,
      delay: null,
    };
  }

  // 3. 正常
  const interval = getPostInterval(date);
  return {
    allowed: true,
    reason: interval.reason,
    delay: interval.delay,
    remaining: getRemainingQuota(date),
  };
}

/**
 * 清理过期的每日计数
 */
export function cleanupDailyCount() {
  const today = getTodayKey();
  for (const key of Object.keys(dailyCount)) {
    if (key !== today) delete dailyCount[key];
  }
}
