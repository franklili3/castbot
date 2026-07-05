import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from './db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// API Key 验证中间件
const API_KEY = process.env.API_KEY || 'binsquare-dev-key-2026';
app.use((req: any, res: any, next: any) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (req.path.startsWith('/api/') && key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
});

// ============ Agent 注册 ============
app.post('/api/agent/register', (req: any, res: any) => {
  const { token, hostname, platform } = req.body;

  // token 是用户在 Telegram Bot 获取的安装令牌
  const user = db.prepare('SELECT * FROM users WHERE agent_token = ?').get(token) as any;
  if (!user) {
    return res.status(404).json({ error: 'Invalid token' });
  }

  // 注册 agent
  const agentId = `agent_${user.id}_${Date.now()}`;
  db.prepare(`
    INSERT OR REPLACE INTO agents (id, user_id, hostname, platform, status, last_heartbeat)
    VALUES (?, ?, ?, ?, 'online', CURRENT_TIMESTAMP)
  `).run(agentId, user.id, hostname || 'unknown', platform || 'unknown');

  res.json({
    ok: true,
    agentId,
    user: {
      id: user.id,
      telegram_id: user.telegram_id,
      binance_uid: user.binance_uid,
      style: user.style,
      frequency: user.frequency,
      content_types: user.content_types,
    },
  });
  console.log(`[Agent registered] ${agentId} for user ${user.telegram_username || user.telegram_id}`);
});

// ============ Agent 心跳 ============
app.post('/api/agent/heartbeat', (req: any, res: any) => {
  const { agentId } = req.body;
  db.prepare("UPDATE agents SET last_heartbeat = CURRENT_TIMESTAMP, status = 'online' WHERE id = ?")
    .run(agentId);
  res.json({ ok: true });
});

// ============ 获取待发布内容 ============
app.get('/api/content/pending', (req: any, res: any) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const posts = db.prepare(`
    SELECT p.*, u.style, u.binance_uid
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.user_id = ? AND p.status = 'approved'
    ORDER BY p.scheduled_at ASC
  `).all(userId);

  // Parse topics from comma-separated string to array
  const parsed = posts.map((p: any) => ({
    ...p,
    topics: p.topics ? p.topics.split(',').filter(Boolean) : [],
  }));

  res.json({ posts: parsed });
});

// ============ 更新发布状态 ============
app.post('/api/content/:postId/status', (req: any, res: any) => {
  const { postId } = req.params;
  const { status, binancePostId, error } = req.body;

  if (status === 'published') {
    db.prepare("UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, binance_post_id = ? WHERE id = ?")
      .run(binancePostId || null, postId);
  } else if (status === 'failed') {
    db.prepare("UPDATE posts SET status = 'failed' WHERE id = ?").run(postId);
    console.error(`[Publish failed] post #${postId}: ${error}`);
  }

  res.json({ ok: true });
});

// ============ 按 token 查用户（供 server.mjs 调用）============
app.get('/api/user/by-token', (req: any, res: any) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token required' });
  const user = db.prepare('SELECT id, telegram_id, telegram_username, binance_uid, style, status, agent_token, review_mode, language, coins FROM users WHERE agent_token = ?').get(token);
  if (!user) return res.json({ user: null });
  res.json({ user });
});

// ============ 插入帖子（供 server.mjs 调用）============
app.post('/api/content/insert', (req: any, res: any) => {
  const { userId, content, topics, status = 'approved' } = req.body;
  if (!userId || !content) return res.status(400).json({ error: 'userId and content required' });
  const topicStr = Array.isArray(topics) ? topics.join(',') : (topics || '');
  const result = db.prepare(
    "INSERT INTO posts (user_id, content, topics, status, scheduled_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(userId, content, topicStr, status);
  const newId = result.lastInsertRowid;
  console.log(`  📝 Post inserted: #${newId} (status: ${status})`);
  res.json({ ok: true, id: newId });
});

// ============ Agent 状态查询 ============
app.get('/api/agents', (req: any, res: any) => {
  const agents = db.prepare(`
    SELECT a.*, u.telegram_username, u.binance_uid
    FROM agents a
    JOIN users u ON a.user_id = u.id
  `).all();
  res.json({ agents });
});

// ============ Stats ============
app.get('/api/stats', (req: any, res: any) => {
  const totalUsers = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
  const activeUsers = (db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'active'").get() as any).count;
  const totalPosts = (db.prepare('SELECT COUNT(*) as count FROM posts').get() as any).count;
  const publishedPosts = (db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'published'").get() as any).count;
  const onlineAgents = (db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'online'").get() as any).count;

  res.json({ totalUsers, activeUsers, totalPosts, publishedPosts, onlineAgents });
});

// ============ 静态文件：安装脚本 + Agent ============
const publicDir = path.join(__dirname, '..', 'public');
app.use('/download', express.static(publicDir));

// /install.sh → 重定向到下载
app.get('/install.sh', (req: any, res: any) => {
  res.sendFile(path.join(publicDir, 'install.sh'));
});

// /download/agent → 下载 agent
app.get('/download/agent', (req: any, res: any) => {
  res.sendFile(path.join(publicDir, 'agent.mjs'));
});

// /api/agent/version → 版本信息（agent 自动更新用）
app.get('/api/agent/version', (req: any, res: any) => {
  const agentPath = path.join(publicDir, 'agent.mjs');
  try {
    const stat = fs.statSync(agentPath);
    const content = fs.readFileSync(agentPath, 'utf8');
    const versionMatch = content.match(/Agent v([\d.]+)/);
    res.json({
      version: versionMatch ? versionMatch[1] : 'unknown',
      size: stat.size,
      updated: stat.mtime.toISOString(),
    });
  } catch {
    res.status(404).json({ error: 'agent not found' });
  }
});

// ============ Agent 日志上传 ============
app.post('/api/agent/log', (req: any, res: any) => {
  const { agentId, postId, log } = req.body;
  if (!log) return res.status(400).json({ error: 'no log' });
  const logDir = path.join(publicDir, '..', 'data', 'agent-logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${postId || 'unknown'}-${Date.now()}.json`);
  fs.writeFileSync(logFile, JSON.stringify({ agentId, postId, log, ts: new Date().toISOString() }, null, 2));
  console.log(`[Agent log] post #${postId || '?'}: ${typeof log === 'string' ? log.substring(0, 200) : JSON.stringify(log).substring(0, 200)}`);
  res.json({ ok: true });
});

const PORT = process.env.API_PORT || 3100;
app.listen(PORT, () => {
  console.log(`🚀 API server running on port ${PORT}`);
});
