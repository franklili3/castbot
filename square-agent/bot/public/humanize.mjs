/**
 * 发布频率限制模块
 *
 * v0.3.0 精简版 — 浏览器自动化相关（坐标抖动、打字节奏、夜间静默）已随
 * Chrome/AppleScript 一起移除。仅保留与 API 发布仍有意义的日发上限。
 */

// ========== 发布频率限制 ==========

const DAILY_LIMITS = {
  max_posts: 100,
  min_post_interval: 5 * 60 * 1000,   // 基础间隔 5 min
  max_random_extra: 5 * 60 * 1000,     // 随机额外 0-5 min → 总间隔 5-10 min
};

/**
 * 生成随机等待时间（5-10 分钟）
 */
export function generateWaitMs() {
  return DAILY_LIMITS.min_post_interval + Math.floor(Math.random() * DAILY_LIMITS.max_random_extra);
}

/**
 * 检查当前是否允许发布。
 * @param {{ts: number, waitMs: number}[]} todayPosts - 发布记录数组
 * @returns {{ allowed: boolean, reason?: string, waitMs?: number }}
 */
export function checkPublishLimit(todayPosts = []) {
  const now = Date.now();
  const oneDayAgo = now - 86400000;

  const todayCount = todayPosts.filter(p => p.ts > oneDayAgo).length;
  if (todayCount >= DAILY_LIMITS.max_posts) {
    return { allowed: false, reason: `今天已发${todayCount}条，达到日上限${DAILY_LIMITS.max_posts}` };
  }

  const lastPost = todayPosts[todayPosts.length - 1];
  if (lastPost) {
    const elapsed = now - lastPost.ts;
    if (elapsed < lastPost.waitMs) {
      const remaining = Math.ceil((lastPost.waitMs - elapsed) / 60000);
      return { allowed: false, reason: `距上次发帖${Math.floor(elapsed / 60000)}分钟，需等约${remaining}分钟`, waitMs: lastPost.waitMs - elapsed };
    }
  }

  return { allowed: true };
}

export { DAILY_LIMITS };
