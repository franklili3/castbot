/**
 * 发布频率限制模块
 *
 * v0.4.0 动态间隔版 — 根据剩余配额和剩余时间精确计算发帖间隔，
 * 确保每天精确发完目标条数（默认 80）。
 *
 * 核心公式：interval = 剩余时间 / 剩余条数 × 随机抖动(±15%)
 * - 落后进度 → 自动缩短间隔（最小 3 分钟）
 * - 超前进度 → 自动拉长间隔
 * - 随机抖动避免机械化等间隔
 */

// ========== 配置 ==========
const _BINANCE_DAILY_LIMIT = parseInt(process.env.BINANCE_DAILY_LIMIT || '100', 10);
const _BINANCE_DAILY_SAFETY_MARGIN = parseInt(process.env.BINANCE_DAILY_SAFETY_MARGIN || '0', 10);

const DAILY_LIMITS = {
  max_posts: Math.max(1, _BINANCE_DAILY_LIMIT - _BINANCE_DAILY_SAFETY_MARGIN),
  min_interval: 3 * 60 * 1000,     // 最短 3 分钟
  max_interval: 120 * 60 * 1000,   // 最长 120 分钟（仅严重落后时触发）
  jitter: 0.15,                     // ±15% 随机抖动
};

/**
 * UTC 时间的「发帖日」边界。Binance API 配额在 UTC 00:00 重置。
 * 返回当前发帖日的 [startMs, endMs]。
 */
function _getDayBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return [start.getTime(), end.getTime()];
}

/**
 * 动态计算下一条发帖的等待时间。
 *
 * 在 agent.mjs 中用法：generateWaitMs 在 push 之前调用，
 * 所以 todayPosts 不含当前帖。remaining = target - todayCount 表示
 * 「含当前帖在内还需发出的条数」，每条分到 remainingMs/remaining 的时间。
 *
 * @param {{ts: number, waitMs?: number}[]} todayPosts - 今日已发帖记录
 * @param {number} [dailyTarget] - 今日目标发帖数（默认 DAILY_LIMITS.max_posts）
 * @param {number} [precomputedTodayCount] - caller 预先算好的今日已发数（来自 DB），
 *   优先于 todayPosts.filter；null/undefined 时回退到 todayPosts。
 *   agent.mjs 在 publisher 主循环里用此参数与 bot DB 同步，避免内存计数与 DB 失同步。
 * @returns {number} 等待毫秒数
 */
export function generateWaitMs(todayPosts = [], dailyTarget, precomputedTodayCount = null) {
  const target = dailyTarget || DAILY_LIMITS.max_posts;
  const [dayStart, dayEnd] = _getDayBounds();
  const now = Date.now();

  const todayCount = (precomputedTodayCount !== null && precomputedTodayCount !== undefined)
    ? precomputedTodayCount
    : todayPosts.filter(p => p.ts >= dayStart && p.ts < dayEnd).length;
  const remaining = Math.max(0, target - todayCount);

  if (remaining === 0) return DAILY_LIMITS.max_interval; // 已发完

  const remainingMs = dayEnd - now;
  if (remainingMs <= 0) return DAILY_LIMITS.min_interval;

  // 基础间隔 = 剩余时间 / 剩余条数
  const baseInterval = remainingMs / remaining;

  // jitter 在剩余条数少时收窄（避免尾部累积偏差导致超时）
  const effectiveJitter = remaining <= 5 ? DAILY_LIMITS.jitter * 0.3 : DAILY_LIMITS.jitter;
  const jitterAmount = (Math.random() * 2 - 1) * effectiveJitter;
  const interval = Math.round(baseInterval * (1 + jitterAmount));

  // 只 clip 下限（避免太短触发 rate limit），不 clip 上限
  return Math.max(interval, DAILY_LIMITS.min_interval);
}

/**
 * 检查当前是否允许发布。
 *
 * 注意：checkPublishLimit 内部仍用 DAILY_LIMITS.max_posts 作为日上限判定。
 * 当 caller 想要 per-user 自定义日上限时，应在 caller 侧先比对 precomputedTodayCount
 * 与目标值，再决定是否调用本函数。本函数主要保证「全局硬上限」和「最短间隔」。
 *
 * @param {{ts: number, waitMs?: number}[]} todayPosts - 发布记录数组
 * @param {number} [precomputedTodayCount] - caller 预先算好的今日已发数（来自 DB），
 *   优先于 todayPosts.filter；null/undefined 时回退到 todayPosts。
 * @returns {{ allowed: boolean, reason?: string, waitMs?: number }}
 */
export function checkPublishLimit(todayPosts = [], precomputedTodayCount = null) {
  const now = Date.now();
  const [dayStart] = _getDayBounds();

  const todayCount = (precomputedTodayCount !== null && precomputedTodayCount !== undefined)
    ? precomputedTodayCount
    : todayPosts.filter(p => p.ts >= dayStart).length;
  if (todayCount >= DAILY_LIMITS.max_posts) {
    return { allowed: false, reason: `今天已发${todayCount}条，达到日上限${DAILY_LIMITS.max_posts}` };
  }

  const lastPost = todayPosts[todayPosts.length - 1];
  if (lastPost) {
    const elapsed = now - lastPost.ts;
    const waitMs = lastPost.waitMs || DAILY_LIMITS.min_interval;
    if (elapsed < waitMs) {
      const remaining = Math.ceil((waitMs - elapsed) / 60000);
      return { allowed: false, reason: `距上次发帖${Math.floor(elapsed / 60000)}分钟，需等约${remaining}分钟`, waitMs: waitMs - elapsed };
    }
  }

  return { allowed: true };
}

export { DAILY_LIMITS };
