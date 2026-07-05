#!/usr/bin/env node
// migrate-to-data-dir.mjs — 把散落的运行时数据迁移到统一的 ~/.square-agent/
//
// 设计要点：
//   - **copyFileSync** 而非 renameSync（永不删原文件，安全；迁移期可回滚）
//   - **幂等**：目标已存在则跳过
//   - **跳过 node_modules/**（npm install 重建）
//   - **不删旧目录**：本脚本只负责复制；旧目录删除是 Phase 4 手动步骤
//   - 末尾打印 Copied / Skipped / Failed 三档 summary
//
// 用法：
//   node scripts/migrate-to-data-dir.mjs
//   node scripts/migrate-to-data-dir.mjs --force   # 覆盖已存在目标

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HOME = homedir();
const DATA_ROOT = process.env.SQUARE_AGENT_DATA_DIR || join(HOME, '.square-agent');
const REPO_ROOT = process.env.SQUARE_AGENT_REPO_DIR
  || dirname(dirname(fileURLToPath(import.meta.url)));
const FORCE = process.argv.includes('--force');

const stats = { copied: 0, skipped: 0, failed: 0, failedList: [] };

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** 递归复制目录，跳过 node_modules / .DS_Store。返回 true 表示至少复制了一个文件。 */
function copyDir(src, dst) {
  let copiedAny = false;
  for (const name of readdirSync(src)) {
    if (name === '.DS_Store' || name === 'node_modules') continue;
    const s = join(src, name);
    const d = join(dst, name);
    let st;
    try { st = lstatSync(s); } catch { continue; }
    if (st.isDirectory()) {
      ensureDir(d);
      if (copyDir(s, d)) copiedAny = true;
    } else if (st.isSymbolicLink()) {
      // 跳过符号链接（避免循环）
      continue;
    } else {
      if (existsSync(d) && !FORCE) {
        stats.skipped++;
        continue;
      }
      try {
        copyFileSync(s, d);
        stats.copied++;
        copiedAny = true;
        console.log(`  COPY  ${s} → ${d}`);
      } catch (e) {
        stats.failed++;
        stats.failedList.push(`${s}: ${e.message}`);
        console.error(`  FAIL  ${s}: ${e.message}`);
      }
    }
  }
  return copiedAny;
}

/** 单文件复制（幂等）。 */
function copyOne(src, dst, label) {
  if (!existsSync(src)) {
    console.log(`  SKIP  [${label}] source missing: ${src}`);
    stats.skipped++;
    return;
  }
  ensureDir(dirname(dst));
  if (existsSync(dst) && !FORCE) {
    console.log(`  SKIP  [${label}] target exists: ${dst}`);
    stats.skipped++;
    return;
  }
  try {
    copyFileSync(src, dst);
    stats.copied++;
    console.log(`  COPY  [${label}] ${src} → ${dst}`);
  } catch (e) {
    stats.failed++;
    stats.failedList.push(`${src}: ${e.message}`);
    console.error(`  FAIL  [${label}] ${src}: ${e.message}`);
  }
}

/** 目录复制（幂等）。 */
function copyOneDir(src, dst, label) {
  if (!existsSync(src)) {
    console.log(`  SKIP  [${label}] source missing: ${src}`);
    stats.skipped++;
    return;
  }
  ensureDir(dst);
  console.log(`  → [${label}] ${src} → ${dst}`);
  copyDir(src, dst);
}

console.log(`\n📦 Migrating to ${DATA_ROOT}\n`);
console.log(`   repo:   ${REPO_ROOT}`);
console.log(`   force:  ${FORCE}\n`);

// 1. ~/.square-agent-server/ → ~/.square-agent/server/
copyOneDir(join(HOME, '.square-agent-server'), join(DATA_ROOT, 'server'), 'server');

// 2. ~/.square-agent-publisher/ → ~/.square-agent/publisher/  (skip node_modules)
copyOneDir(join(HOME, '.square-agent-publisher'), join(DATA_ROOT, 'publisher'), 'publisher');

// 3. <repo>/bot/data/ → ~/.square-agent/bot/
copyOneDir(join(REPO_ROOT, 'bot', 'data'), join(DATA_ROOT, 'bot'), 'bot-data');

// 4. <repo>/bot/bot.log → ~/.square-agent/bot/bot.log
copyOne(join(REPO_ROOT, 'bot', 'bot.log'), join(DATA_ROOT, 'bot', 'bot.log'), 'bot-log');

// 5. <repo>/news-pipeline/data/ → ~/.square-agent/news-pipeline/
copyOneDir(join(REPO_ROOT, 'news-pipeline', 'data'), join(DATA_ROOT, 'news-pipeline'), 'news-data');

// 6. <repo>/server/server.log → ~/.square-agent/server-logs/server.log
copyOne(join(REPO_ROOT, 'server', 'server.log'), join(DATA_ROOT, 'server-logs', 'server.log'), 'server-log');

// 7. <repo>/analytics/*.log → ~/.square-agent/analytics-logs/
if (existsSync(join(REPO_ROOT, 'analytics'))) {
  for (const f of readdirSync(join(REPO_ROOT, 'analytics'))) {
    if (!f.endsWith('.log')) continue;
    copyOne(
      join(REPO_ROOT, 'analytics', f),
      join(DATA_ROOT, 'analytics-logs', f),
      'analytics-log',
    );
  }
}

// 8. ~/clawd/data/prediction-counter.json → ~/.square-agent/prediction-counter.json
copyOne(
  join(HOME, 'clawd', 'data', 'prediction-counter.json'),
  join(DATA_ROOT, 'prediction-counter.json'),
  'prediction-counter',
);

// 9. ~/clawd/data/tg-pending/ → ~/.square-agent/tg-pending/
copyOneDir(join(HOME, 'clawd', 'data', 'tg-pending'), join(DATA_ROOT, 'tg-pending'), 'tg-pending');

// 10. ~/clawd/data/binance-content/analytics/ → ~/.square-agent/analytics/
copyOneDir(
  join(HOME, 'clawd', 'data', 'binance-content', 'analytics'),
  join(DATA_ROOT, 'analytics'),
  'analytics',
);

// 11. ~/clawd/data/.env → ~/.square-agent/.env
copyOne(join(HOME, 'clawd', 'data', '.env'), join(DATA_ROOT, '.env'), 'env');

// 12. tmp 目录
ensureDir(join(DATA_ROOT, 'tmp'));
console.log(`  → tmp dir ensured: ${join(DATA_ROOT, 'tmp')}\n`);

// Summary
console.log('—'.repeat(60));
console.log(`Summary:  ${stats.copied} copied | ${stats.skipped} skipped | ${stats.failed} failed`);
if (stats.failed > 0) {
  console.log('\nFailed files:');
  for (const line of stats.failedList) console.log('  - ' + line);
  process.exit(1);
}
console.log('\n✅ Done. 旧目录保持原样；确认服务从新路径正常工作后，再手动删除：');
console.log(`   rm -rf ~/.square-agent-server/ ~/.square-agent-publisher/`);
console.log(`   rm -rf ${join(REPO_ROOT, 'bot', 'data')}/`);
console.log(`   rm -rf ${join(REPO_ROOT, 'news-pipeline', 'data')}/`);
