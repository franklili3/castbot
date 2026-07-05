/**
 * Binance Square Cloud API (better-sqlite3版 - 持久化存储)
 * 端口: 5577
 */

import express from 'express';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import paths from '../../src/paths.mjs';

const app = express();
const PORT = process.env.PORT || 5577;
app.use(express.json());

// ========== 静态文件 (install.sh等) ==========
const publicDir = path.join(import.meta.dirname, '..', 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

app.get('/install.sh', (req, res) => {
  const filePath = path.join(publicDir, 'install.sh');
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('install.sh not found');
  }
  res.setHeader('Content-Type', 'text/x-shellscript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(filePath);
});

app.get('/downloads/square-agent-publisher.tgz', (req, res) => {
  const tgzPath = path.join(publicDir, 'square-agent-publisher.tgz');
  if (!fs.existsSync(tgzPath)) {
    return res.status(404).send('Package not found');
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.download(tgzPath, 'square-agent-publisher.tgz');
});

// Legacy route redirect
app.get('/downloads/binance-square-agent.tgz', (req, res) => {
  const tgzPath = path.join(publicDir, 'square-agent-publisher.tgz');
  if (!fs.existsSync(tgzPath)) {
    return res.status(404).send('Package not found');
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.download(tgzPath, 'square-agent-publisher.tgz');
});

// ========== 数据库 (better-sqlite3 - 持久化) ==========

const DB_DIR = paths.serverDbDir;
const DB_PATH = paths.serverDb;
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// better-sqlite3 自动持久化，saveDB 保留为空函数兼容旧代码
function saveDB() {}

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT,
    api_key TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'basic',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    params TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    result TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TEXT DEFAULT (datetime('now')),
    scheduled_at TEXT,
    started_at TEXT,
    completed_at TEXT
  )
`);

// 兼容旧库：补加 retry_count / max_retries 列
try { db.exec('ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN max_retries INTEGER DEFAULT 3'); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    success INTEGER NOT NULL,
    error TEXT,
    steps TEXT,
    duration_ms INTEGER,
    reported_at TEXT DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    hostname TEXT,
    platform TEXT,
    status TEXT DEFAULT 'offline',
    last_heartbeat TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    success INTEGER NOT NULL,
    month TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// 初始化测试用户
const existing = db.prepare("SELECT * FROM users WHERE api_key = ?").get('sk_test_dev_00000000');
if (!existing) {
  db.prepare("INSERT INTO users (id, email, name, api_key, plan) VALUES ('user_test', 'test@example.com', 'Test User', 'sk_test_dev_00000000', 'pro')").run();
}

// ========== 工具函数 ==========

function queryOne(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function queryAll(sql, params = []) {
  return db.prepare(sql).all(...params);
}

async function authMiddleware(req, res, next) {
  // 先尝试 Bearer token (server DB api_key)
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const user = queryOne('SELECT * FROM users WHERE api_key = ? AND status = ?', [auth.replace('Bearer ', ''), 'active']);
    if (user) { req.user = user; return next(); }
  }

  // 再尝试 X-Agent-Token (bot DB via HTTP API)
  const agentToken = req.headers['x-agent-token'];
  if (agentToken) {
    const data = await botApi(`/api/user/by-token?token=${encodeURIComponent(agentToken)}`);
    if (data && data.user && data.user.status === 'active') {
      req.user = { id: data.user.id, telegram_id: data.user.telegram_id, style: data.user.style };
      return next();
    }
  }

  return res.status(401).json({ error: 'Missing or invalid API key' });
}

// ========== Agent 端点 ==========

app.get('/api/agent/verify', async (req, res) => {
  // Check server DB first
  let user = queryOne('SELECT * FROM users WHERE api_key = ? AND status = ?', [req.query.key, 'active']);
  
  // Also check bot DB via HTTP API
  if (!user) {
    try {
      const data = await botApi(`/api/user/by-token?token=${encodeURIComponent(req.query.key)}`);
      if (data && data.user && data.user.status === 'active') {
        user = { id: data.user.telegram_username || `tg_${data.user.id}`, plan: 'pro' };
      }
    } catch (e) {
      console.error('Bot DB lookup failed:', e.message);
    }
  }
  
  if (!user) return res.status(401).json({ error: 'Invalid key' });
  res.json({ user_id: user.id, plan: user.plan, server_url: `http://${req.hostname}:${PORT}` });
});

app.post('/api/agent/register', async (req, res) => {
  const { token, hostname, platform } = req.body || {};
  if (!token) return res.status(400).json({ error: '缺少 token' });

  // 从 bot DB 查找用户 (via HTTP API)
  let user = null;
  const userData = await botApi(`/api/user/by-token?token=${encodeURIComponent(token)}`);
  if (userData && userData.user && userData.user.status === 'active') {
    const u = userData.user;
    user = { id: u.id, telegram_id: u.telegram_id, username: u.telegram_username, binance_uid: u.binance_uid, style: u.style };
  }

  if (!user) return res.status(401).json({ error: '无效 token' });

  // 创建或更新 agent 记录
  const agentId = `agent_${Date.now().toString(36)}`;
  // 存到 server DB
  const existing = queryOne('SELECT id FROM agents WHERE id = ?', [agentId]);
  if (!existing) {
    db.prepare('INSERT OR REPLACE INTO agents (id, user_id, hostname, platform, status, last_heartbeat) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))').run(...[agentId, user.id, hostname || 'unknown', platform || 'darwin', 'online']);
    saveDB();
  }

  console.log(`  📱 Agent registered: ${agentId} (user: ${user.username}, uid: ${user.binance_uid})`);
  res.json({
    agentId,
    user: { id: user.id, binance_uid: user.binance_uid || '', style: user.style || 'balanced' }
  });
});

app.post('/api/agent/heartbeat', (req, res) => {
  const { agentId } = req.body || {};
  if (!agentId) return res.status(400).json({ error: '缺少 agentId' });
  db.prepare('UPDATE agents SET last_heartbeat = datetime(\'now\'), status = ? WHERE id = ?').run(...['online', agentId]);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/agent/log', (req, res) => {
  const { agentId, postId, log } = req.body || {};
  // Just acknowledge, we don't need to store logs for now
  console.log(`  📋 Agent log: #${postId || '?'} ${log?.status || ''} ${log?.error || ''}`);
  res.json({ ok: true });
});

app.get('/api/agent/poll', authMiddleware, (req, res) => {
  const task = queryOne(`
    SELECT * FROM tasks 
    WHERE user_id = ? AND status = 'pending'
    AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
    ORDER BY created_at ASC LIMIT 1
  `, [req.user.id]);
  
  if (!task) return res.json({ task: null });
  
  db.prepare("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?").run(...[task.id]);
  saveDB();
  
  console.log(`  → Task ${task.id} dispatched (retry #${task.retry_count || 0})`);
  
  const params = JSON.parse(task.params);
  
  // 云端生成操作码序列，Agent只执行不解码
  const ops = generateOps(task.type);
  
  // 评论任务替换导航URL
  if (task.type === 'comment' && params.post_url) {
    const navOp = ops.find(o => o.p?.[0] === '__POST_URL__');
    if (navOp) navOp.p[0] = params.post_url;
  }
  
  res.json({
    task: {
      id: task.id,
      type: task.type,
      ops,
      content: params.content,
      topics: params.topics,
      options: params.options
    }
  });
});

app.post('/api/agent/report', authMiddleware, (req, res) => {
  const { task_id, success, error, steps, duration_ms } = req.body;

  if (success) {
    // 成功：标记完成
    db.prepare("UPDATE tasks SET status = 'done', result = ?, completed_at = datetime('now') WHERE id = ? AND user_id = ?").run(...[JSON.stringify({ success, error, steps: steps?.length || 0, duration_ms }), task_id, req.user.id]);
  } else {
    // 失败：检查重试次数
    const task = queryOne('SELECT retry_count, max_retries FROM tasks WHERE id = ? AND user_id = ?', [task_id, req.user.id]);
    const retryCount = (task?.retry_count || 0) + 1;
    const maxRetries = task?.max_retries ?? 3;

    if (retryCount < maxRetries) {
      // 重试：状态改回 pending，累加 retry_count，延迟调度避免立即拉取
      const backoffSeconds = Math.min(30 * retryCount, 120); // 30s, 60s, 90s, ...
      const scheduledAt = new Date(Date.now() + backoffSeconds * 1000).toISOString().replace('T', ' ').split('.')[0];
      db.prepare("UPDATE tasks SET status = 'pending', result = ?, retry_count = ?, started_at = NULL, scheduled_at = ? WHERE id = ? AND user_id = ?").run(...[JSON.stringify({ success, error, steps: steps?.length || 0, duration_ms, retry_attempt: retryCount }), retryCount, scheduledAt, task_id, req.user.id]);
      console.log(`  ↻ Task ${task_id} failed, retrying in ${backoffSeconds}s (${retryCount}/${maxRetries})`);
    } else {
      // 超过重试上限：标记失败
      db.prepare("UPDATE tasks SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ? AND user_id = ?").run(...[JSON.stringify({ success, error, steps: steps?.length || 0, duration_ms, retries_exhausted: true }), task_id, req.user.id]);
      console.log(`  ✗ Task ${task_id} failed permanently after ${retryCount} retries`);
    }
  }
  
  db.prepare("INSERT INTO reports (task_id, user_id, success, error, steps, duration_ms) VALUES (?,?,?,?,?,?)").run(...[task_id, req.user.id, success ? 1 : 0, error || null, JSON.stringify(steps), duration_ms || 0]);
  const task = queryOne("SELECT type FROM tasks WHERE id = ?", [task_id]);
  if (task) {
    const month = new Date().toISOString().substring(0, 7);
    db.prepare("INSERT INTO usage (user_id, action, success, month) VALUES (?,?,?,?)").run(...[req.user.id, task.type, success ? 1 : 0, month]);
  }
  
  saveDB();
  res.json({ ok: true });
});

// ========== 管理端点 ==========

app.post('/api/tasks', authMiddleware, (req, res) => {
  const { type, content, topics, options, post_url, comment, range, scheduled_at } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  
  const month = new Date().toISOString().substring(0, 7);
  const usageRows = queryAll("SELECT COUNT(*) as cnt FROM usage WHERE user_id = ? AND month = ? AND action IN ('post','poll','comment')", [req.user.id, month]);
  const usageCount = usageRows[0]?.cnt || 0;
  const limits = { basic: 30, pro: 999, enterprise: 99999 };
  const limit = limits[req.user.plan] || 30;
  
  if (usageCount >= limit) return res.status(429).json({ error: 'Monthly limit reached', limit, used: usageCount });
  
  const id = `task_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
  const params = JSON.stringify({ content, topics, options, post_url, comment, range });
  
  db.prepare("INSERT INTO tasks (id, user_id, type, params, scheduled_at) VALUES (?,?,?,?,?)").run(...[id, req.user.id, type, params, scheduled_at || null]);
  saveDB();
  
  res.json({ ok: true, task_id: id });
});

app.get('/api/tasks', authMiddleware, (req, res) => {
  const { status, limit } = req.query;
  let sql = 'SELECT * FROM tasks WHERE user_id = ?';
  const params = [req.user.id];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit) || 50);
  res.json({ tasks: queryAll(sql, params) });
});

app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(...[req.params.id, req.user.id]);
  saveDB();
  res.json({ ok: true });
});

app.get('/api/billing/usage', authMiddleware, (req, res) => {
  const month = req.query.month || new Date().toISOString().substring(0, 7);
  const usage = queryAll(`
    SELECT action, COUNT(*) as total, SUM(success) as success_count
    FROM usage WHERE user_id = ? AND month = ? GROUP BY action
  `, [req.user.id, month]);
  const limits = { basic: 30, pro: 999, enterprise: 99999 };
  res.json({ month, plan: req.user.plan, limit: limits[req.user.plan] || 30, usage });
});

// 管理员创建用户
app.post('/api/admin/users', (req, res) => {
  const { id, email, name, plan, api_key } = req.body;
  const userId = id || `user_${Date.now()}`;
  const apiKey = api_key || `sk_${crypto.randomUUID().replace(/-/g, '')}`;
  try {
    db.prepare("INSERT INTO users (id, email, name, api_key, plan) VALUES (?,?,?,?,?)").run(...[userId, email, name, apiKey, plan || 'basic']);
    saveDB();
    res.json({ ok: true, user_id: userId, api_key: apiKey });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// ========== 内容生成模块 ==========

import { BUILTIN_TEMPLATES, generateFromTemplate, generateContent, fetchMarketData } from './content-engine.mjs';
import { generateOps } from './ops-generator.mjs';

// 建内容相关表
db.exec(`CREATE TABLE IF NOT EXISTS content_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  prompt TEXT NOT NULL,
  frequency TEXT DEFAULT 'on_demand',
  default_time TEXT,
  needs_market_data INTEGER DEFAULT 0,
  user_footer TEXT,
  user_topics TEXT,
  style_rules TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS content_schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  timezone TEXT DEFAULT 'Asia/Shanghai',
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS ai_config (
  user_id TEXT PRIMARY KEY,
  provider TEXT DEFAULT 'openai',
  api_key TEXT NOT NULL,
  model TEXT DEFAULT 'gpt-4o-mini',
  base_url TEXT DEFAULT 'https://api.openai.com',
  updated_at TEXT DEFAULT (datetime('now'))
)`);

saveDB();

/**
 * GET /api/templates
 * 获取可用模板列表（内置+用户自定义）
 */
app.get('/api/templates', authMiddleware, (req, res) => {
  const custom = queryAll('SELECT * FROM content_templates WHERE user_id = ?', [req.user.id]);
  res.json({ 
    builtin: BUILTIN_TEMPLATES,
    custom
  });
});

/**
 * POST /api/templates
 * 创建自定义模板
 * Body: { name, type, prompt, frequency?, default_time?, footer?, topics?, style_rules? }
 */
app.post('/api/templates', authMiddleware, (req, res) => {
  const { name, type, prompt, frequency, default_time, footer, topics, style_rules } = req.body;
  if (!name || !type || !prompt) return res.status(400).json({ error: 'name, type, prompt required' });
  
  const id = `tpl_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
  db.prepare(`INSERT INTO content_templates 
    (id, user_id, name, type, category, prompt, frequency, default_time, user_footer, user_topics, style_rules) 
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...[id, req.user.id, name, type, 'custom', prompt, frequency || 'on_demand', 
     default_time || null, footer || null, 
     topics ? JSON.stringify(topics) : null, style_rules || null]);
  saveDB();
  res.json({ ok: true, template_id: id });
});

/**
 * POST /api/ai/config
 * 配置 AI（用户自己的 API Key 或你提供的）
 * Body: { provider, api_key, model?, base_url? }
 */
app.post('/api/ai/config', authMiddleware, (req, res) => {
  const { provider, api_key, model, base_url } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key required' });
  
  db.prepare(`INSERT OR REPLACE INTO ai_config (user_id, provider, api_key, model, base_url, updated_at) 
    VALUES (?,?,?,?,?,datetime('now'))`).run(...[req.user.id, provider || 'openai', api_key, model || 'gpt-4o-mini', base_url || 'https://api.openai.com']);
  saveDB();
  res.json({ ok: true });
});

/**
 * POST /api/content/generate
 * 生成内容（预览/直接下发任务）
 * Body: { template_id, topic?, news?, auto_publish?: false }
 */
app.post('/api/content/generate', authMiddleware, async (req, res) => {
  console.log(`  [content/generate] template=${req.body.template_id} user=${req.user.id}`);
  const { template_id, topic, news, auto_publish } = req.body;
  
  // 找模板
  let template = BUILTIN_TEMPLATES.find(t => t.id === template_id);
  if (!template) {
    const custom = queryOne('SELECT * FROM content_templates WHERE id = ? AND user_id = ?', [template_id, req.user.id]);
    if (!custom) return res.status(404).json({ error: 'Template not found' });
    template = {
      ...custom,
      needs_market_data: !!custom.needs_market_data
    };
  }
  
  // 获取 AI 配置
  const aiConfig = queryOne('SELECT * FROM ai_config WHERE user_id = ?', [req.user.id]);
  if (!aiConfig) return res.status(400).json({ error: 'AI not configured. POST /api/ai/config first' });
  
  const userConfig = {
    footer: template.user_footer,
    topics: template.user_topics ? JSON.parse(template.user_topics) : undefined,
    style_rules: template.style_rules,
    ai_config: {
      provider: aiConfig.provider,
      api_key: aiConfig.api_key,
      model: aiConfig.model,
      base_url: aiConfig.base_url
    }
  };
  
  try {
    const result = await generateFromTemplate(template, userConfig, { topic, news });
    
    // poll 类型：格式化为纯文本
    if (result.type === 'poll' && result.options) {
      const optionLines = result.options.map((opt, i) => `${i === 0 ? '🅰️' : '🅱️'} ${opt}`).join('\n');
      result.content = `${result.content}\n\n${optionLines}\n\n👉 评论区告诉我你选哪个`;
      result.type = 'post'; // 转为普通帖子
    }
    
    // 自动发布？
    if (auto_publish !== false) {
      const taskId = `task_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
      const params = JSON.stringify({ content: result.content, topics: result.topics });
      
      db.prepare('INSERT INTO tasks (id, user_id, type, params) VALUES (?,?,?,?)').run(...[taskId, req.user.id, 'post', params]);
      saveDB();
      
      res.json({ ok: true, content: result, task_id: taskId, message: 'Generated and queued for publishing' });
    } else {
      res.json({ ok: true, content: result, message: 'Preview only - not queued' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Generation failed: ' + e.message });
  }
});

// Bot 内部调用认证：支持 agent_token
async function botAuthMiddleware(req, res, next) {
  const token = req.headers['x-agent-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  // 从 bot DB 查找用户 (via HTTP API)
  const data = await botApi(`/api/user/by-token?token=${encodeURIComponent(token)}`);
  if (data && data.user && data.user.status === 'active') {
    req.user = { id: data.user.id, telegram_id: data.user.telegram_id };
    return next();
  }
  return res.status(401).json({ error: 'Invalid token' });
}

/**
 * POST /api/schedules
 * 设置内容排期（定时生成+自动发布）
 * Body: { template_id, cron_expr, timezone?, footer?, topics? }
 */
app.post('/api/schedules', botAuthMiddleware, (req, res) => {
  const { template_id, cron_expr, timezone, footer, topics } = req.body;
  if (!template_id || !cron_expr) return res.status(400).json({ error: 'template_id and cron_expr required' });
  
  // 更新模板的 footer/topics
  if (footer || topics) {
    db.prepare('UPDATE content_templates SET user_footer = ?, user_topics = ? WHERE id = ? AND user_id = ?').run(...[footer || null, topics ? JSON.stringify(topics) : null, template_id, req.user.id]);
  }
  
  const id = `sched_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
  db.prepare('INSERT INTO content_schedules (id, user_id, template_id, cron_expr, timezone) VALUES (?,?,?,?,?)').run(...[id, req.user.id, template_id, cron_expr, timezone || 'Asia/Shanghai']);
  saveDB();
  
  res.json({ ok: true, schedule_id: id, message: `Scheduled: ${cron_expr} (${timezone || 'Asia/Shanghai'})` });
});

/**
 * GET /api/schedules
 * 查看排期列表
 */
app.get('/api/schedules', botAuthMiddleware, (req, res) => {
  const schedules = queryAll('SELECT * FROM content_schedules WHERE user_id = ?', [req.user.id]);
  res.json({ schedules });
});

/**
 * DELETE /api/schedules/:id
 */
app.delete('/api/schedules/:id', botAuthMiddleware, (req, res) => {
  db.prepare('DELETE FROM content_schedules WHERE id = ? AND user_id = ?').run(...[req.params.id, req.user.id]);
  saveDB();
  res.json({ ok: true });
});

/**
 * GET /api/market
 * 获取市场数据（调试用）
 */
app.get('/api/market', async (req, res) => {
  try {
    const data = await fetchMarketData();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== UI配置下发 ==========
// 云端管理UI操作参数，币安改版时只需更新此配置
// Agent启动时拉取最新配置，无需更新代码

import { readFileSync } from 'fs';
const uiConfig = JSON.parse(readFileSync(new URL('../config/ui-config.json', import.meta.url), 'utf8'));
let liveUIConfig = { ...uiConfig };

// Agent拉取UI配置
db.exec(`CREATE TABLE IF NOT EXISTS ui_config_history (
  version TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);
saveDB();

/**
 * GET /api/agent/ui-config
 * Agent拉取最新UI操作配置
 */
app.get('/api/agent/ui-config', authMiddleware, (req, res) => {
  res.json(liveUIConfig);
});

/**
 * POST /api/admin/ui-config
 * 管理员更新UI配置（币安改版后使用）
 * Body: { config: {...} } 或直接发送完整JSON
 */
app.post('/api/admin/ui-config', (req, res) => {
  // TODO: 管理员认证
  const newConfig = req.body.config || req.body;
  if (!newConfig.version || !newConfig.actions) {
    return res.status(400).json({ error: 'Invalid config: needs version and actions' });
  }
  
  // 保存历史版本
  db.prepare('INSERT OR REPLACE INTO ui_config_history (version, config) VALUES (?,?)').run(...[newConfig.version, JSON.stringify(newConfig)]);
  // 写入文件供下次启动使用
  const customPath = path.join(DB_DIR, 'ui-config.json');
  fs.writeFileSync(customPath, JSON.stringify(newConfig, null, 2));
  
  // 热更新当前内存
  Object.assign(liveUIConfig, newConfig);
  saveDB();
  
  res.json({ ok: true, version: newConfig.version, message: 'UI config updated - agents will get new config on next poll' });
});

/**
 * GET /api/admin/ui-config/history
 * 查看配置版本历史
 */
app.get('/api/admin/ui-config/history', (req, res) => {
  const history = queryAll('SELECT version, created_at FROM ui_config_history ORDER BY created_at DESC');
  res.json({ history });
});

// ========== 启动 ==========

// ============ Bot DB 代理：通过 HTTP API 操作 bot 的 SQLite ============
// 不再用 sql.js 直接读写 bot DB 文件（会导致 WAL 损坏）
const BOT_API_URL = process.env.BOT_API_URL || 'http://127.0.0.1:3100';

async function botApi(path, options = {}) {
  try {
    const res = await fetch(`${BOT_API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.BOT_API_KEY || 'binsquare-dev-key-2026',
        ...options.headers,
      },
    });
    return await res.json();
  } catch (e) {
    console.error(`Bot API error (${path}):`, e.message);
    return null;
  }
}

app.get('/api/content/pending', async (req, res) => {
  const userId = req.query.userId || 3;
  const data = await botApi(`/api/content/pending?userId=${userId}`);
  res.json(data || { posts: [] });
});

app.post('/api/content/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, binancePostId, error } = req.body;
  const data = await botApi(`/api/content/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status, binancePostId, error }),
  });
  if (data) {
    console.log(`  📝 Post #${id} → ${status} (via bot API)`);
  } else {
    try {
      const notifyDir = paths.botNotificationsDir;
      if (!fs.existsSync(notifyDir)) fs.mkdirSync(notifyDir, { recursive: true });
      fs.writeFileSync(path.join(notifyDir, `${id}.json`), JSON.stringify({ postId: id, status, binancePostId: binancePostId || null, time: new Date().toISOString() }));
    } catch {}
  }
  res.json({ ok: true });
});

app.get('/api/agent/version', (req, res) => {
  res.json({ version: '1.0.0', minAgent: '0.2.0' });
});

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SquareAgent Server on :${PORT}`);
  console.log('');
  console.log('Agent:  GET /api/agent/verify | GET /api/agent/poll | POST /api/agent/report');
  console.log('Manage: POST /api/tasks | GET /api/tasks | DELETE /api/tasks/:id');
  console.log('Billing: GET /api/billing/usage');
  console.log('Admin:  POST /api/admin/users');
  console.log('');
  console.log('Content: POST /api/templates | POST /api/content/generate | POST /api/schedules');
  console.log('AI Config: POST /api/ai/config');
  console.log('Market: GET /api/market');
  console.log('UI Config: GET /api/agent/ui-config | POST /api/admin/ui-config');
  console.log('');
  console.log('Test API Key: sk_test_dev_00000000');
});

// ============ 定时调度器 ============
// 每分钟检查 content_schedules，到期时生成内容写入 bot DB
// (BUILTIN_TEMPLATES and generateFromTemplate already imported at top)

// 解析简单 cron 表达式（分 时 日 月 周）→ 判断当前时间是否匹配
function matchesCron(expr, now) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  const checks = [
    { v: now.getMinutes(), p: m },
    { v: now.getHours(), p: h },
    { v: now.getDate(), p: dom },
    { v: now.getMonth() + 1, p: mon },
    { v: now.getDay(), p: dow },
  ];
  return checks.every(({ v, p }) => p === '*' || p.split(',').map(Number).includes(v));
}

// 写入内容到 bot DB（通过 bot HTTP API，不直接操作 DB 文件）
async function writePostToBotDB(userId, content, topics, status = 'approved') {
  const topicStr = Array.isArray(topics) ? topics.join(',') : (topics || '');
  const data = await botApi('/api/content/insert', {
    method: 'POST',
    body: JSON.stringify({ userId, content, topics: topicStr, status }),
  });
  if (data && data.ok) {
    console.log(`  📝 Post inserted: #${data.id} (status: ${status})`);
    return data.id;
  }
  console.error('writePostToBotDB failed: bot API unavailable');
  return null;
}

// 获取用户的 AI 配置
function getUserAIConfig(userId) {
  const row = queryOne('SELECT * FROM ai_config WHERE user_id = ?', [userId]);
  if (row) return row;
  return {
    provider: 'zhipu',
    api_key: process.env.AI_API_KEY || '',
    model: process.env.DEFAULT_LLM_MODEL || 'glm-4-flash-250414',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
  };
}

// 执行一个调度任务
async function runScheduleJob(schedule, retryCount = 0) {
  console.log(`⏰ Running schedule: ${schedule.id} (template: ${schedule.template_id})${retryCount > 0 ? ` [retry ${retryCount}]` : ''}`);
  try {
    let template = BUILTIN_TEMPLATES.find(t => t.id === schedule.template_id);
    if (!template) {
      template = queryOne('SELECT * FROM content_templates WHERE id = ?', [schedule.template_id]);
      if (!template) {
        console.error(`  ❌ Template not found: ${schedule.template_id}`);
        return;
      }
    }

    const aiConfig = getUserAIConfig(schedule.user_id);
    const userConfig = { ai_config: aiConfig };

    let marketData = null;
    if (template.needs_market_data) {
      try { marketData = await fetchMarketData(); } catch {}
    }

    const result = await generateFromTemplate(template, userConfig, { marketData });
    if (!result || !result.content) {
      console.error(`  ❌ Content generation failed for schedule ${schedule.id}`);
      throw new Error('Content generation returned empty');
    }

    // poll 类型：格式化为纯文本（币安API不支持投票组件）
    let postContent = result.content;
    let postTopics = result.topics || template.topics;
    if (result.type === 'poll' && result.options) {
      // 把 options 拼到正文末尾
      const optionLines = result.options.map((opt, i) => `${i === 0 ? '🅰️' : '🅱️'} ${opt}`).join('\n');
      postContent = `${result.content}\n\n${optionLines}\n\n👉 评论区告诉我你选哪个`;
      postTopics = Array.isArray(result.topics) ? result.topics.join(',') : (result.topics || 'BTC');
    }

    const postId = await writePostToBotDB(schedule.user_id, postContent, postTopics, 'approved');

    db.prepare("UPDATE content_schedules SET last_run = datetime('now') WHERE id = ?").run(...[schedule.id]);
    saveDB();

    console.log(`  ✅ Schedule ${schedule.id} done, post #${postId}`);
  } catch (e) {
    console.error(`  ❌ Schedule ${schedule.id} error:`, e.message);
    // 重试：最多 2 次，间隔 60 秒
    if (retryCount < 2) {
      console.log(`  🔄 Retrying ${schedule.id} in 60s (attempt ${retryCount + 2}/3)...`);
      setTimeout(() => runScheduleJob(schedule, retryCount + 1).catch(err => console.error(`  ❌ Retry failed: ${err.message}`)), 60000);
    }
  }
}

// 调度器主循环 — 每分钟检查
// 记录上次检查的分钟，避免同一分钟重复触发
let lastCheckedMinute = -1;
setInterval(() => {
  try {
    const now = new Date();
    // 用 Asia/Shanghai 时区
    const shanghaiOffset = 8 * 60;
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const shanghaiTime = new Date(utcMs + shanghaiOffset * 60000);

    // 用「年月日时分」作为唯一标识，同一分钟只检查一次
    const minuteKey = shanghaiTime.getFullYear() * 1000000 + (shanghaiTime.getMonth()+1) * 10000 + shanghaiTime.getDate() * 100 + shanghaiTime.getHours() * 100 + shanghaiTime.getMinutes();
    if (minuteKey === lastCheckedMinute) return;
    lastCheckedMinute = minuteKey;

    const schedules = queryAll('SELECT * FROM content_schedules WHERE enabled = 1');
    for (const sched of schedules) {
      if (sched.last_run) {
        const lastRun = new Date(sched.last_run + 'Z');
        if (Date.now() - lastRun.getTime() < 300000) continue;
      }
      if (matchesCron(sched.cron_expr, shanghaiTime)) {
        runScheduleJob(sched).catch(e => console.error('Schedule job error:', e.message));
      }
    }
  } catch (e) {
    console.error('Scheduler error:', e.message);
  }
}, 60000);

console.log('⏰ Scheduler started (checking every 60s)');

// ============ 行情异动监控 ============
// 每 60 秒检查 BTC/ETH 价格，1h 波动 > 3% 时自动生成快讯
let lastPriceCheck = { prices: {}, timestamp: 0 };

setInterval(async () => {
  try {
    const md = await fetchMarketData();
    const now = Date.now();

    // 检查每个币种
    for (const [sym, info] of Object.entries(md.prices)) {
      if (!info.price || sym.startsWith('_')) continue;
      const change24h = parseFloat(info.change_24h);

      // 方法1：24h 涨跌幅 > 5% 触发
      if (Math.abs(change24h) >= 5) {
        // 检查最近 30 分钟是否已经触发过
        const lastAlertKey = `alert_${sym}_${Math.floor(now / 1800000)}`;
        if (!globalThis[lastAlertKey]) {
          globalThis[lastAlertKey] = true;
          console.log(`🚨 行情异动: ${sym} 24h ${change24h}%`);

          // 找到 tpl_breaking_news 模板
          const tpl = BUILTIN_TEMPLATES.find(t => t.id === 'tpl_breaking_news');
          if (!tpl) continue;

          // 为所有启用调度的用户生成
          const users = queryAll('SELECT DISTINCT user_id FROM content_schedules WHERE enabled = 1');
          for (const u of users) {
            const aiConfig = getUserAIConfig(u.user_id);
            try {
              const result = await generateFromTemplate(tpl, aiConfig, { marketData: md });
              if (result?.content) {
                const postId = await writePostToBotDB(u.user_id, result.content, result.topics || [sym], 'approved');
                console.log(`  📝 异动快讯已创建: #${postId} (${sym} ${change24h}%)`);
              }
            } catch (e) {
              console.error(`  ❌ 异动快讯生成失败: ${e.message}`);
            }
          }
        }
      }
    }

    lastPriceCheck = { prices: md.prices, timestamp: now };
  } catch (e) {
    // 静默失败，不影响主流程
  }
}, 60000);

console.log('🚨 Price alert monitor started (checking every 60s, trigger at 24h change >= 5%)');

// ============ 发布时间优化 API ============
// 基于互动分析数据自动调整 cron 时间
app.post('/api/optimize/schedule', botAuthMiddleware, async (req, res) => {
  try {
    const analyticsDir = paths.analyticsDir;
    const today = new Date().toISOString().slice(0, 10);
  const summaryFile = path.join(analyticsDir, `engagement-summary-${today}.json`);

    if (!fs.existsSync(summaryFile)) {
      return res.json({ ok: false, message: 'No analytics data found for today' });
    }

    const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
    const postTypes = summary.postTypes || {};
    const adjustments = [];

    // 对比各类型平均浏览量，推荐最优发布时间
    const schedules = queryAll('SELECT * FROM content_schedules WHERE user_id = ? AND enabled = 1', [req.user.id]);

    for (const sched of schedules) {
      const tpl = BUILTIN_TEMPLATES.find(t => t.id === sched.template_id);
      if (!tpl) continue;

      // 找对应类型的数据
      const typeNameMap = {
        'tpl_morning_brief': '早报',
        'tpl_evening_recap': '复盘',
        'tpl_deep_analysis': '深度分析',
        'tpl_poll_post': '投票',
        'tpl_breaking_news': '异动快讯',
      };
      const typeName = typeNameMap[sched.template_id];
      const typeData = postTypes[typeName];

      if (typeData && typeData.count > 0 && typeData.views > 0) {
        const avgViews = typeData.views / typeData.count;
        const avgEngagement = typeData.engagement || 0;

        // 如果该类型表现好，增加频率或保持
        if (avgViews > 200 && avgEngagement > 2) {
          adjustments.push({ schedule_id: sched.id, template: sched.template_id, action: 'keep', reason: `${typeName}表现良好（平均${Math.round(avgViews)}浏览）` });
        }
        // 如果表现差，建议调整
        if (avgViews < 50 && typeData.count >= 2) {
          adjustments.push({ schedule_id: sched.id, template: sched.template_id, action: 'consider_disabling', reason: `${typeName}表现较差（平均${Math.round(avgViews)}浏览），考虑调整时间或禁用` });
        }
      }
    }

    res.json({ ok: true, adjustments, summary: { posts: summary.posts, totalOps: summary.totalOps } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

console.log('📊 Optimize schedule API: POST /api/optimize/schedule');
