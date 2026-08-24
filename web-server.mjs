#!/usr/bin/env node
/**
 * Lilibtc Bot 本地网页管理面板 - HTTP 服务入口
 *
 * 由 cli.mjs cmdStart 以独立子进程 spawn（detached + unref）。
 * - 绑 127.0.0.1，绝不出公网
 * - 鉴权：所有 /api/* 路由必须带 Authorization: Bearer <WEB_TOKEN>
 * - WEB_TOKEN / WEB_PORT 由 cli.mjs 通过 env 传入
 *
 * 路由见 ROUTES 表。
 */

import http from 'http';
import { execSync, spawn } from 'child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, unlinkSync, chmodSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import https from 'https';
import { ProxyAgent, fetch } from 'undici';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = __dirname;
const AGENT_FILE = join(PKG_DIR, 'agent.mjs');

// 用户数据目录（与 cli.mjs 完全一致，避免漂移）
const USER_DATA_DIR = join(homedir(), '.lilibtc-bot');
const CONFIG_FILE = join(USER_DATA_DIR, 'config.json');
const PID_FILE = join(USER_DATA_DIR, 'agent.pid');
const BINANCE_KEY_FILE = join(USER_DATA_DIR, 'binance-api-key');
const LOCK_FILE = join(USER_DATA_DIR, 'publisher.lock');
const DAEMON_DIR = join(USER_DATA_DIR, 'publisher');
const DAEMON_FILE = join(DAEMON_DIR, 'daemon.json');
const LOG_DIR = join(DAEMON_DIR, 'logs');
const INDEX_FILE = join(PKG_DIR, 'web', 'index.html');

const TOKEN = process.env.WEB_TOKEN;
const PORT = parseInt(process.env.WEB_PORT || '8421', 10);
const HOST = '127.0.0.1';

if (!TOKEN) {
  console.error('❌ web-server: 缺少 WEB_TOKEN 环境变量（应由 cli.mjs 注入）');
  process.exit(1);
}

// ========== 工具 ==========

function getConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}
function saveConfig(c) {
  if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}
function maskKey(v) {
  if (!v) return '';
  if (v.length <= 10) return v.slice(0, 2) + '...' + v.slice(-2);
  return v.slice(0, 6) + '...' + v.slice(-4);
}
function getPid() {
  try { return parseInt(readFileSync(PID_FILE, 'utf8')); } catch { return null; }
}
function isRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function checkDependencies() {
  let chrome = false, peekaboo = false;
  try { if (process.platform === 'darwin') execSync('osascript -e \'tell application "Google Chrome" to return name\'', { timeout: 5000 }); chrome = true; } catch {}
  try { if (process.platform === 'darwin') execSync('which peekaboo', { timeout: 5000 }); peekaboo = true; } catch {}
  return { chrome, peekaboo };
}

function json(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      buf += chunk;
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ========== Handler ==========

async function handleState(req, res) {
  const config = getConfig();
  const pid = getPid();
  const running = isRunning(pid);
  const deps = checkDependencies();

  // 今日日志最近 5 条
  const today = new Date().toISOString().slice(0, 10);
  const logFile = join(LOG_DIR, `${today}.jsonl`);
  const recentLogs = [];
  if (existsSync(logFile)) {
    try {
      const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      for (const l of lines.slice(-5)) {
        try { recentLogs.push(JSON.parse(l)); } catch {}
      }
    } catch {}
  }

  const masked = config ? {
    ...config,
    apiKey: config.apiKey ? maskKey(config.apiKey) : '',
  } : null;

  return json(res, 200, {
    config: masked,
    agent: { running, pid: running ? pid : null },
    deps,
    todayLogCount: recentLogs.length,
    recentLogs,
  });
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const apiKey = body.apiKey;
  if (!apiKey || typeof apiKey !== 'string') {
    return json(res, 400, { error: '缺少 apiKey' });
  }
  if (!apiKey.startsWith('sk-') && !apiKey.startsWith('bsq_')) {
    return json(res, 400, { error: 'API Key 格式错误，应以 sk- 或 bsq_ 开头' });
  }

  // 复用 cli.mjs cmdLogin 的 verify 链路
  const baseUrl = (process.env.LILIBTC_SERVER_URL || process.env.SQUARE_SERVER_URL || getConfig()?.serverUrl || 'https://api.lilibtc.com').replace(/\/$/, '');
  const verifyUrl = `${baseUrl}/api/agent/verify?key=${encodeURIComponent(apiKey)}`;

  const result = await new Promise(resolve => {
    const r = baseUrl.startsWith('http://') ? http : https;
    const req2 = r.get(verifyUrl, { timeout: 10000 }, resp => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve({ ok: true, data: JSON.parse(data) }); }
          catch { resolve({ ok: false, error: `响应解析失败: ${data.slice(0, 200)}` }); }
        } else {
          resolve({ ok: false, error: `HTTP ${resp.statusCode}: ${data.slice(0, 200)}` });
        }
      });
    });
    req2.on('error', e => resolve({ ok: false, error: e.message }));
    req2.on('timeout', () => { req2.destroy(); resolve({ ok: false, error: '请求超时' }); });
  });

  if (!result.ok) {
    return json(res, 400, { error: `API Key 验证失败: ${result.error}` });
  }

  const data = result.data;
  const finalServerUrl = (process.env.LILIBTC_SERVER_URL || process.env.SQUARE_SERVER_URL) || baseUrl;
  saveConfig({
    apiKey,
    userId: data.user_id,
    plan: data.plan,
    serverUrl: finalServerUrl,
    loggedInAt: new Date().toISOString(),
  });

  return json(res, 200, {
    ok: true,
    config: { userId: data.user_id, plan: data.plan, serverUrl: finalServerUrl },
  });
}

async function handleGetBinanceKey(req, res) {
  // 与 agent getApiKey 顺序一致：新路径 → 旧路径 fallback
  let v = '';
  if (existsSync(BINANCE_KEY_FILE)) {
    v = readFileSync(BINANCE_KEY_FILE, 'utf8').trim();
  } else {
    const legacy = join(homedir(), '.cryptoqclaw', 'binance-api-key');
    if (existsSync(legacy)) v = readFileSync(legacy, 'utf8').trim();
  }
  return json(res, 200, { key: v ? maskKey(v) : null });
}

async function handleSetBinanceKey(req, res) {
  const body = await readBody(req);
  const key = body.key;
  if (!key || typeof key !== 'string') return json(res, 400, { error: '缺少 key' });
  if (key.length < 32 || key.length > 128) {
    return json(res, 400, { error: `Key 长度异常 (${key.length} 字符)，通常为 32-128` });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    return json(res, 400, { error: 'Key 含非法字符（仅允许字母/数字/下划线/连字符）' });
  }
  if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });
  writeFileSync(BINANCE_KEY_FILE, key + '\n');
  try { chmodSync(BINANCE_KEY_FILE, 0o600); } catch {}
  return json(res, 200, { ok: true, key: maskKey(key) });
}

async function handleClearBinanceKey(req, res) {
  if (!existsSync(BINANCE_KEY_FILE)) return json(res, 200, { ok: true, cleared: false });
  try { unlinkSync(BINANCE_KEY_FILE); } catch (e) { return json(res, 500, { error: e.message }); }
  return json(res, 200, { ok: true, cleared: true });
}

async function handleStart(req, res) {
  const config = getConfig();
  if (!config?.apiKey) {
    return json(res, 400, { error: '尚未登录，请先在「登录」Tab 输入 API Key' });
  }
  const pid = getPid();
  if (isRunning(pid)) {
    return json(res, 200, { ok: true, alreadyRunning: true, pid });
  }

  // 复用 cli.mjs cmdStart daemon 分支：spawn agent.mjs detached
  const token = process.env.LILIBTC_BOT_TOKEN || process.env.CRYPTOQCLAW_AGENT_TOKEN || process.env.AGENT_TOKEN || config.agentToken || config.apiKey;
  const env = {
    ...process.env,
    AGENT_TOKEN: token,
    SERVER_URL: process.env.SERVER_URL || config.serverUrl || 'https://api.lilibtc.com',
    API_KEY: process.env.API_KEY || config.apiKey || '',
  };
  // 代理：config.proxy 覆盖 process.env（网页设置的优先于 shell env）
  // 大陆用户访问 binance.com 必须走代理，detached 进程不读 ~/.bashrc，必须显式注入
  if (config.proxy && typeof config.proxy === 'string') {
    env.HTTPS_PROXY = config.proxy;
    env.HTTP_PROXY = config.proxy;
  }
  // web 自己也是 detached，不能让 agent 继承 web 的 stdio（agent 有自己的 log 文件）
  const child = spawn(process.execPath, [AGENT_FILE], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  writeFileSync(PID_FILE, child.pid.toString());
  writeDaemon({
    pid: child.pid,
    mode: 'daemon',
    startedAt: new Date().toISOString(),
    args: ['start', '--daemon'],
    triggeredBy: 'web',
  });
  return json(res, 200, { ok: true, pid: child.pid });
}

async function handleStop(req, res) {
  const pid = getPid();
  let stopped = false;
  if (pid && isRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); stopped = true; } catch {}
    try { unlinkSync(PID_FILE); } catch {}
  } else {
    // 兜底：扫一遍进程列表
    try {
      const pids = execSync('pgrep -f "(lilibtc-bot|cryptoqclaw|square-agent).*agent.mjs"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      pids.forEach(p => { try { process.kill(parseInt(p), 'SIGTERM'); } catch {} });
      stopped = pids.length > 0;
    } catch {}
    try { unlinkSync(PID_FILE); } catch {}
  }
  if (existsSync(LOCK_FILE)) { try { unlinkSync(LOCK_FILE); } catch {} }
  clearDaemon();
  return json(res, 200, { ok: true, stopped });
}

async function handleLogs(req, res, url) {
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 1000);
  const file = join(LOG_DIR, `${date}.jsonl`);
  if (!existsSync(file)) return json(res, 200, { date, entries: [] });
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const entries = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try { entries.push(JSON.parse(lines[i])); } catch {}
    }
    return json(res, 200, { date, entries });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

async function handleLogDates(req, res) {
  if (!existsSync(LOG_DIR)) return json(res, 200, { dates: [] });
  try {
    const dates = readdirSync(LOG_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => f.replace('.jsonl', ''))
      .sort()
      .reverse();
    return json(res, 200, { dates });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

async function handleGetConfig(req, res) {
  const config = getConfig();
  if (!config) return json(res, 200, { config: null, effectiveProxy: effectiveProxy() });
  return json(res, 200, {
    config: { ...config, apiKey: config.apiKey ? maskKey(config.apiKey) : '' },
    effectiveProxy: effectiveProxy(config.proxy),
  });
}

// agent 实际用的代理：config.proxy（网页设置）优先，否则读启动时继承的 env HTTPS_PROXY
function effectiveProxy(configProxy) {
  if (configProxy) return configProxy;
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
}

async function handleSetConfig(req, res) {
  const body = await readBody(req);
  const { key, value } = body;
  if (!key) return json(res, 400, { error: '缺少 key' });
  const config = getConfig();
  if (!config) return json(res, 400, { error: '尚未登录' });
  let parsed = value;
  try { parsed = JSON.parse(value); } catch {}
  config[key] = parsed;
  saveConfig(config);
  return json(res, 200, { ok: true, key, value: parsed });
}

/**
 * 设置代理 URL。校验格式后写 config.proxy。
 * 接受：'http://127.0.0.1:1081' / 'http://127.0.0.1:7897' 等。
 * 传 null / '' 清除。
 */
async function handleSetProxy(req, res) {
  const body = await readBody(req);
  let proxy = body.proxy;
  const config = getConfig();
  if (!config) return json(res, 400, { error: '尚未登录' });

  if (proxy === null || proxy === '' || proxy === undefined) {
    delete config.proxy;
    saveConfig(config);
    return json(res, 200, { ok: true, proxy: null });
  }
  if (typeof proxy !== 'string') return json(res, 400, { error: 'proxy 必须是字符串' });
  proxy = proxy.trim();
  // 规范化：用户填 "127.0.0.1:1081" 或 "1081" 都补成 "http://127.0.0.1:PORT"
  if (/^\d+$/.test(proxy)) proxy = `http://127.0.0.1:${proxy}`;
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(proxy)) proxy = `http://${proxy}`;
  // 校验
  try {
    const u = new URL(proxy);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return json(res, 400, { error: '协议必须是 http(s)://' });
    }
  } catch {
    return json(res, 400, { error: '代理 URL 格式错误' });
  }
  config.proxy = proxy;
  saveConfig(config);
  return json(res, 200, { ok: true, proxy });
}

/**
 * 测试代理可达性。用 ProxyAgent 拉一个 binance 公开 endpoint。
 * 用 query.proxy（用户输入测试）或 config.proxy（已保存的）。
 */
async function handleProxyTest(req, res, url) {
  const proxy = url.searchParams.get('proxy') || getConfig()?.proxy;
  if (!proxy) return json(res, 400, { error: '未提供代理 URL' });
  try {
    const t0 = Date.now();
    const r = await fetch('https://api.binance.com/api/v3/ping', {
      dispatcher: new ProxyAgent(proxy),
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - t0;
    if (r.ok) return json(res, 200, { ok: true, ms, status: r.status });
    return json(res, 200, { ok: false, ms, status: r.status, error: `HTTP ${r.status}` });
  } catch (e) {
    return json(res, 200, { ok: false, error: e.message || String(e) });
  }
}

function writeDaemon(info) {
  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(DAEMON_FILE, JSON.stringify(info, null, 2));
}
function clearDaemon() {
  try { if (existsSync(DAEMON_FILE)) unlinkSync(DAEMON_FILE); } catch {}
}

// ========== 鉴权 ==========

function isAuthed(req, url) {
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${TOKEN}`) return true;
  if (url.searchParams.get('token') === TOKEN) return true;
  return false;
}

// ========== 静态首页 ==========

function serveIndex(req, res) {
  if (!existsSync(INDEX_FILE)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('web/index.html not found');
  }
  const html = readFileSync(INDEX_FILE, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

// ========== Server ==========

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // 首页（无需鉴权，但页面 JS 会要求 token）
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return serveIndex(req, res);
  }

  // 健康检查（无需鉴权）
  if (method === 'GET' && path === '/api/ping') {
    return json(res, 200, { ok: true, ts: Date.now() });
  }

  // /api/* 鉴权
  if (path.startsWith('/api/')) {
    if (!isAuthed(req, url)) {
      return json(res, 401, { error: '未授权' });
    }
  }

  try {
    if (path === '/api/state' && method === 'GET') return await handleState(req, res);
    if (path === '/api/login' && method === 'POST') return await handleLogin(req, res);
    if (path === '/api/binance-key' && method === 'GET') return await handleGetBinanceKey(req, res);
    if (path === '/api/binance-key' && method === 'POST') return await handleSetBinanceKey(req, res);
    if (path === '/api/binance-key' && method === 'DELETE') return await handleClearBinanceKey(req, res);
    if (path === '/api/start' && method === 'POST') return await handleStart(req, res);
    if (path === '/api/stop' && method === 'POST') return await handleStop(req, res);
    if (path === '/api/logs' && method === 'GET') return await handleLogs(req, res, url);
    if (path === '/api/logs/dates' && method === 'GET') return await handleLogDates(req, res);
    if (path === '/api/config' && method === 'GET') return await handleGetConfig(req, res);
    if (path === '/api/config' && method === 'POST') return await handleSetConfig(req, res);
    if (path === '/api/proxy' && method === 'POST') return await handleSetProxy(req, res);
    if (path === '/api/proxy/test' && method === 'GET') return await handleProxyTest(req, res, url);
    return json(res, 404, { error: `Not found: ${method} ${path}` });
  } catch (e) {
    return json(res, 500, { error: e.message || 'Internal error' });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用`);
  } else {
    console.error('❌ server error:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`🌐 web-server: http://${HOST}:${PORT}`);
});

// 优雅退出（cli.mjs stop 会 SIGTERM）
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
