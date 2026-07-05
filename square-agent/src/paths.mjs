// paths.mjs — SquareAgent 中央路径解析模块
//
// 三级解析算法（按优先级）：
//   1. process.env[envVar]            （显式 env 覆盖，最高优先级）
//   2. 新位置 (~/.square-agent/...)   （迁移完成后的正式位置）
//   3. 旧位置（写死的旧路径）          （fallback，触发时打印一次性迁移提示到 stderr）
//
// 新位置不存在、旧位置存在时：返回旧位置并向 stderr 打印一次性提示。
// 两者都不存在时：返回新位置（让消费者就地创建，避免污染旧路径）。
//
// 目标：消除散落在 25+ 处的硬编码路径，让 git pull / 换机器 / Docker 部署都不再依赖 ~/clawd/...

import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HOME = homedir();
const DATA_ROOT = process.env.SQUARE_AGENT_DATA_DIR || join(HOME, '.square-agent');
// paths.mjs 位于 <repo>/src/paths.mjs，向上两层即仓库根。
const REPO_ROOT = process.env.SQUARE_AGENT_REPO_DIR
  || dirname(dirname(fileURLToPath(import.meta.url)));

const _warned = new Set();
function warnLegacy(label, legacy, neo) {
  const key = `${label}::${legacy}`;
  if (_warned.has(key)) return;
  _warned.add(key);
  process.stderr.write(
    `[paths] ${label}: using legacy path ${legacy}\n`
    + `[paths]   → migrate to ${neo} (run: node scripts/migrate-to-data-dir.mjs)\n`
  );
}

/**
 * 按三级优先级解析路径。
 * @param {string} label       用于迁移提示的可读标识
 * @param {object} opts
 * @param {string} [opts.envVar]   env 变量名（最高优先级）
 * @param {string} opts.newPath    新位置
 * @param {string} [opts.legacy]   旧位置（fallback；存在则用，但打印警告）
 * @returns {string}
 */
function resolve(label, { envVar, newPath, legacy }) {
  if (envVar && process.env[envVar]) return process.env[envVar];
  if (existsSync(newPath)) return newPath;
  if (legacy && existsSync(legacy)) {
    warnLegacy(label, legacy, newPath);
    return legacy;
  }
  return newPath;
}

export const paths = {
  // ===== 根 =====
  dataRoot: DATA_ROOT,
  repoRoot: REPO_ROOT,

  // ===== Server (源: ~/.square-agent-server/) =====
  serverDbDir: join(DATA_ROOT, 'server'),
  serverDb: resolve('serverDb', {
    envVar: 'SQUARE_AGENT_SERVER_DB',
    newPath: join(DATA_ROOT, 'server', 'data.db'),
    legacy: join(HOME, '.square-agent-server', 'data.db'),
  }),
  serverUiConfig: resolve('serverUiConfig', {
    newPath: join(DATA_ROOT, 'server', 'ui-config.json'),
    legacy: join(HOME, '.square-agent-server', 'ui-config.json'),
  }),
  serverLog: join(DATA_ROOT, 'server-logs', 'server.log'),

  // ===== Publisher (源: ~/.square-agent-publisher/) =====
  publisherDir: resolve('publisherDir', {
    envVar: 'SQUARE_AGENT_PUBLISHER_DIR',
    newPath: join(DATA_ROOT, 'publisher'),
    legacy: join(HOME, '.square-agent-publisher'),
  }),
  publisherLogDir: resolve('publisherLogDir', {
    newPath: join(DATA_ROOT, 'publisher', 'logs'),
    legacy: join(HOME, '.square-agent-publisher', 'logs'),
  }),
  healthLog: resolve('healthLog', {
    newPath: join(DATA_ROOT, 'publisher', 'logs', 'health.jsonl'),
    legacy: join(HOME, '.square-agent-publisher', 'logs', 'health.jsonl'),
  }),

  // ===== Bot (源: <repo>/bot/data/) =====
  botDbDir: join(DATA_ROOT, 'bot'),
  botDb: resolve('botDb', {
    envVar: 'DATABASE_PATH',
    newPath: join(DATA_ROOT, 'bot', 'square-agent.db'),
    legacy: join(REPO_ROOT, 'bot', 'data', 'square-agent.db'),
  }),
  binsquareDb: resolve('binsquareDb', {
    newPath: join(DATA_ROOT, 'bot', 'binsquare.db'),
    legacy: join(REPO_ROOT, 'bot', 'data', 'binsquare.db'),
  }),
  botAgentLogsDir: resolve('botAgentLogsDir', {
    newPath: join(DATA_ROOT, 'bot', 'agent-logs'),
    legacy: join(REPO_ROOT, 'bot', 'data', 'agent-logs'),
  }),
  botNotificationsDir: resolve('botNotificationsDir', {
    newPath: join(DATA_ROOT, 'bot', 'notifications'),
    legacy: join(REPO_ROOT, 'bot', 'data', 'notifications'),
  }),
  botLog: join(DATA_ROOT, 'bot', 'bot.log'),
  botEnvFile: join(REPO_ROOT, 'bot', '.env'),

  // ===== News Pipeline (源: <repo>/news-pipeline/data/) =====
  newsDataDir: resolve('newsDataDir', {
    envVar: 'SQUARE_AGENT_NEWS_DATA_DIR',
    newPath: join(DATA_ROOT, 'news-pipeline'),
    legacy: join(REPO_ROOT, 'news-pipeline', 'data'),
  }),

  // ===== 历史 ~/clawd/data/ 下的小状态文件 =====
  predictionCounter: resolve('predictionCounter', {
    newPath: join(DATA_ROOT, 'prediction-counter.json'),
    legacy: join(HOME, 'clawd', 'data', 'prediction-counter.json'),
  }),
  tgPendingDir: resolve('tgPendingDir', {
    newPath: join(DATA_ROOT, 'tg-pending'),
    legacy: join(HOME, 'clawd', 'data', 'tg-pending'),
  }),
  analyticsDir: resolve('analyticsDir', {
    newPath: join(DATA_ROOT, 'analytics'),
    legacy: join(HOME, 'clawd', 'data', 'binance-content', 'analytics'),
  }),

  // ===== 合并后的统一 .env =====
  envFile: resolve('envFile', {
    newPath: join(DATA_ROOT, '.env'),
    legacy: join(HOME, 'clawd', 'data', '.env'),
  }),

  // ===== 临时文件 =====
  tmpRoot: process.env.SQUARE_AGENT_TMP_DIR || join(DATA_ROOT, 'tmp'),

  // ===== 仓库内静态资源（不入 ~/.square-agent/）=====
  mlDataDir: join(REPO_ROOT, 'data'),

  // ===== 源码模块路径（动态 import 用）=====
  registryMjs: resolve('registryMjs', {
    newPath: join(REPO_ROOT, 'src', 'connectors', 'registry.mjs'),
    legacy: join(HOME, 'clawd', 'square-agent', 'src', 'connectors', 'registry.mjs'),
  }),
  healthMonitorMjs: join(REPO_ROOT, 'src', 'health-monitor.mjs'),

  // ===== Copy Trading 数据 =====
  copyTradingDir: resolve('copyTradingDir', {
    envVar: 'SQUARE_AGENT_COPY_TRADING_DIR',
    newPath: join(DATA_ROOT, 'copy-trading'),
    legacy: join(HOME, 'clawd', 'data', 'binance-content', 'copy-trading'),
  }),

  // ===== 外部共享文件（路径不变）=====
  binanceOpenApiKey: join(HOME, '.config', 'binance-square', 'openapi-key'),
  xTokenFile: join(HOME, 'clawd', 'x-publisher', 'x-token.json'),
};

/**
 * 创建临时文件路径（不写文件，仅返回路径），并确保目录存在。
 * @param {string} prefix
 * @returns {string}
 */
export function tmpFile(prefix) {
  if (!existsSync(paths.tmpRoot)) {
    try { mkdirSync(paths.tmpRoot, { recursive: true, mode: 0o755 }); } catch {}
  }
  return join(paths.tmpRoot, `${prefix}-${Date.now()}`);
}

export default paths;
