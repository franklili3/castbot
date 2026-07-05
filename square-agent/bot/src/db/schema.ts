import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(os.homedir(), '.square-agent', 'bot', 'square-agent.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id BIGINT UNIQUE NOT NULL,
    telegram_username TEXT,
    binance_uid TEXT,
    nickname TEXT,
    style TEXT DEFAULT 'balanced',
    frequency INTEGER DEFAULT 100,
    content_types TEXT DEFAULT 'short',
    enabled_templates TEXT DEFAULT '☀️ 每日早报,🌙 晚间复盘,📈 盘面分析,📊 资金费率热力图,📐 交易理念,📰 新闻解读,⚡ 链上速报,🚨 价格异动,🐋 巨鲸速报,😱 情绪分析,📊 深度分析,💬 热点短评,🪂 空投教程,🏛️ 宏观解读,涨跌预测,仓位调查,关键位博弈,互动话题,行情剧变',
    status TEXT DEFAULT 'active',
    agent_token TEXT UNIQUE,
    approved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    topics TEXT,
    status TEXT DEFAULT 'draft',
    scheduled_at DATETIME,
    published_at DATETIME,
    binance_post_id TEXT,
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    hostname TEXT,
    platform TEXT,
    status TEXT DEFAULT 'offline',
    last_heartbeat DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date DATE NOT NULL,
    followers INTEGER DEFAULT 0,
    followers_delta INTEGER DEFAULT 0,
    total_views INTEGER DEFAULT 0,
    total_likes INTEGER DEFAULT 0,
    posts_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, date)
  );
`);

// 为已有数据库添加 enabled_templates 列
const columns = db.prepare("PRAGMA table_info(users)").all() as any[];
if (!columns.find(c => c.name === 'enabled_templates')) {
  db.exec("ALTER TABLE users ADD COLUMN enabled_templates TEXT DEFAULT '☀️ 每日早报,🌙 晚间复盘,📈 盘面分析,📊 资金费率热力图,📐 交易理念,📰 新闻解读,⚡ 链上速报,🚨 价格异动,🐋 巨鲸速报,😱 情绪分析,📊 深度分析,💬 热点短评,🪂 空投教程,🏛️ 宏观解读,涨跌预测,仓位调查,关键位博弈,互动话题,行情剧变'");
}

// 为已有数据库添加 template_name 列
const postColumns = db.prepare("PRAGMA table_info(posts)").all() as any[];
if (!postColumns.find(c => c.name === 'template_name')) {
  db.exec('ALTER TABLE posts ADD COLUMN template_name TEXT');
}

// 为已有数据库添加 review_mode 列
if (!columns.find(c => c.name === 'review_mode')) {
  db.exec("ALTER TABLE users ADD COLUMN review_mode TEXT DEFAULT 'manual'");
}

export default db;
