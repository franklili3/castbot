// health-monitor.mjs — 账号健康度监控
//
// 定期检测：
// 1. 币安广场 API 可用性（发测试请求）
// 2. 发布成功率统计
// 3. 连续失败告警
// 4. 互动数据追踪（需要 AppleScript 抓取或 API）

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import paths from './paths.mjs';

const LOG_DIR = paths.publisherLogDir;
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const HEALTH_LOG = paths.healthLog;

// ============ 状态 ============
const stats = {
  publishAttempts: 0,
  publishSuccess: 0,
  publishFail: 0,
  consecutiveFails: 0,
  lastSuccessTime: null,
  lastFailTime: null,
  lastFailError: null,
  hourlyStats: {}, // hourKey → { attempts, success, fail }
};

// ============ 核心函数 ============

/**
 * 记录发布结果
 */
export function recordPublish(success, error = null) {
  stats.publishAttempts++;
  const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH

  if (!stats.hourlyStats[hourKey]) {
    stats.hourlyStats[hourKey] = { attempts: 0, success: 0, fail: 0 };
  }
  stats.hourlyStats[hourKey].attempts++;

  if (success) {
    stats.publishSuccess++;
    stats.consecutiveFails = 0;
    stats.lastSuccessTime = new Date().toISOString();
    stats.hourlyStats[hourKey].success++;
  } else {
    stats.publishFail++;
    stats.consecutiveFails++;
    stats.lastFailTime = new Date().toISOString();
    stats.lastFailError = error;
    stats.hourlyStats[hourKey].fail++;
  }

  // 写入日志
  appendFileSync(HEALTH_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    success,
    error,
    consecutiveFails: stats.consecutiveFails,
  }) + '\n');
}

/**
 * 获取健康状态摘要
 */
export function getHealthStatus() {
  const successRate = stats.publishAttempts > 0
    ? (stats.publishSuccess / stats.publishAttempts * 100).toFixed(1)
    : '100.0';

  return {
    healthy: stats.consecutiveFails < 5,
    successRate: `${successRate}%`,
    totalAttempts: stats.publishAttempts,
    totalSuccess: stats.publishSuccess,
    totalFail: stats.publishFail,
    consecutiveFails: stats.consecutiveFails,
    lastSuccess: stats.lastSuccessTime,
    lastFail: stats.lastFailTime,
    lastError: stats.lastFailError,
    hourlyBreakdown: Object.entries(stats.hourlyStats).slice(-24),
  };
}

/**
 * 获取当前小时统计
 */
export function getCurrentHourStats() {
  const hourKey = new Date().toISOString().slice(0, 13);
  return stats.hourlyStats[hourKey] || { attempts: 0, success: 0, fail: 0 };
}

/**
 * 检查是否需要告警
 * @returns {object} { alert, level, message }
 */
export function checkAlerts() {
  // 连续失败 ≥5 次：红色告警
  if (stats.consecutiveFails >= 5) {
    return {
      alert: true,
      level: 'critical',
      message: `🚨 连续 ${stats.consecutiveFails} 次发布失败！最后错误: ${stats.lastFailError}`,
    };
  }

  // 连续失败 3 次：黄色预警
  if (stats.consecutiveFails >= 3) {
    return {
      alert: true,
      level: 'warning',
      message: `⚠️ 连续 ${stats.consecutiveFails} 次发布失败: ${stats.lastFailError}`,
    };
  }

  // 成功率低于 80%（至少 10 次尝试）
  if (stats.publishAttempts >= 10) {
    const rate = stats.publishSuccess / stats.publishAttempts;
    if (rate < 0.8) {
      return {
        alert: true,
        level: 'warning',
        message: `⚠️ 发布成功率偏低: ${(rate * 100).toFixed(1)}% (${stats.publishSuccess}/${stats.publishAttempts})`,
      };
    }
  }

  return { alert: false, level: null, message: null };
}

/**
 * 生成健康报告（可发送到 TG）
 */
export function generateHealthReport() {
  const h = getHealthStatus();
  const alert = checkAlerts();
  const hour = getCurrentHourStats();

  const lines = [
    '📊 账号健康报告',
    '',
    `状态: ${h.healthy ? '✅ 正常' : '🔴 异常'}`,
    `成功率: ${h.successRate} (${h.totalSuccess}/${h.totalAttempts})`,
    `连续失败: ${h.consecutiveFails}`,
    `最近成功: ${h.lastSuccess || '无'}`,
    `当前小时: ${hour.success}/${hour.attempts} 成功`,
  ];

  if (alert.alert) {
    lines.push('', alert.message);
  }

  return lines.join('\n');
}
