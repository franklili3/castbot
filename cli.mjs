#!/usr/bin/env node
/**
 * Lilibtc Bot CLI - 币安广场自动发布代理  (v1.0.8)
 *
 * 用法:
 *   lilibtc-bot login --key bsq_xxx      # 绑定 API Key（sk-xxxxx 或 bsq_xxxxx）
 *   lilibtc-bot set-binance-key <key>    # 设置币安广场发帖 OpenAPI Key（仅本地）
 *   lilibtc-bot start                    # 启动代理（前台，继承当前 shell env）
 *   HTTPS_PROXY=http://127.0.0.1:1081 \
 *     lilibtc-bot start --daemon         # 后台运行（必须显式带 HTTPS_PROXY，
 *                                          # daemon 不读 ~/.bashrc）
 *   lilibtc-bot status                   # 查看状态
 *   lilibtc-bot stop                     # 停止后台代理
 *   lilibtc-bot update                   # 自更新：主源 api.lilibtc.com，不可达时
 *                                          # 自动回退 npm；--npm 强制走 npm。
 *                                          # 更新后按原启动模式重启 daemon
 *   lilibtc-bot history [n]              # 查看最近 n 条执行记录（默认20）
 *   lilibtc-bot states                   # 查看任务执行统计
 *   lilibtc-bot setting [key] [value]    # 查看/修改配置
 *   lilibtc-bot analytics <sub>          # 运行数据分析
 */

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, chmodSync, renameSync, copyFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import net from 'net';
import zlib from 'zlib';
import { fetch as undiciFetch, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import ProcessDetector from './process-detector.mjs';

// 让 update / login 等命令也读 HTTPS_PROXY/HTTP_PROXY 环境变量。
// 之前只有 start --daemon 通过 agentEnv 注入；CLI 直连命令（如 update）走原生 https.get，
// 不读 env，墙内用户会出现 getaddrinfo ENOTFOUND。
// EnvHttpProxyAgent 自动读 HTTPS_PROXY/HTTP_PROXY/NO_PROXY（大小写都认）。
const _PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy
  || process.env.HTTP_PROXY || process.env.http_proxy;
if (_PROXY_URL) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {}
}

// cli.mjs 与 agent.mjs 在同一 npm 包目录下（npm install 后位于
// ~/.nvm/versions/node/v22.21.1/lib/node_modules/<package>/）。优先用 import.meta.url
// 自适应实际安装位置，避免 npm 包名变更再次踩坑。
const CLI_FILE = fileURLToPath(import.meta.url);
const PKG_DIR = dirname(CLI_FILE);
// 兜底：若 import.meta.url 解析失败（极少见），退回历史路径并使用实际包名。
const FALLBACK_PKG_DIR = join(homedir(), '.nvm/versions/node/v22.21.1/lib/node_modules/lilibtc-bot');
const AGENT_DIR = existsSync(join(PKG_DIR, 'agent.mjs')) ? PKG_DIR : FALLBACK_PKG_DIR;

// 用户数据目录：与 npm 包目录分离。npm 重装只换 AGENT_DIR 下的 cli.mjs / agent.mjs，
// config / pid / logs 留在 ~/.lilibtc-bot/ 下不丢。
// binance-api-key / lockfile / daemon.json 一直就在这里。
const USER_DATA_DIR = join(homedir(), '.lilibtc-bot');
const CONFIG_FILE = join(USER_DATA_DIR, 'config.json');
const PID_FILE = join(USER_DATA_DIR, 'agent.pid');
const LOG_DIR = join(USER_DATA_DIR, 'publisher', 'logs');

// 历史路径迁移：旧版 config.json 落在 npm 包目录（AGENT_DIR）或更早的 .cryptoqclaw 品牌下，
// 新版首次启动按优先级搬到 USER_DATA_DIR，避免要求用户重新 login。
// 来源（按时间倒序）：AGENT_DIR/config.json → .cryptoqclaw/.../config.json
const LEGACY_STATE_DIR = join(homedir(), '.cryptoqclaw/npm-global/lib/node_modules/.cryptoqclaw');
const LEGACY_CONFIG_SOURCES = [
  join(AGENT_DIR, 'config.json'),
  join(LEGACY_STATE_DIR, 'config.json'),
];
if (!existsSync(CONFIG_FILE)) {
  for (const src of LEGACY_CONFIG_SOURCES) {
    if (!existsSync(src)) continue;
    try {
      if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });
      renameSync(src, CONFIG_FILE);
      const srcPid = join(dirname(src), 'agent.pid');
      if (existsSync(srcPid)) { try { renameSync(srcPid, PID_FILE); } catch {} }
      break;
    } catch {}
  }
}
const LOCK_FILE = join(homedir(), '.lilibtc-bot', 'publisher.lock');
// 币安广场 OpenAPI Key 本地存储。与 agent.mjs getApiKey() 读取路径必须保持一致。
const BINANCE_KEY_FILE = join(homedir(), '.lilibtc-bot', 'binance-api-key');

// daemon 状态文件：cmdStart 写入，cmdStop 清理，cmdUpdate 读取以决定重启模式。
const DAEMON_DIR = join(homedir(), '.lilibtc-bot', 'publisher');
const DAEMON_FILE = join(DAEMON_DIR, 'daemon.json');

// 本地网页管理面板：cmdStart 时同时 spawn web-server.mjs（独立进程）。
// web-token：32 字节随机，URL ?token=xxx 自动登录；权限 600 防本机其他用户偷读
// web-server.pid：web 子进程 PID，cmdStop 联动清理
// web-port：实际监听端口（默认 8421，冲突时 +1 试探），status/help 提示用户
const WEB_TOKEN_FILE = join(homedir(), '.lilibtc-bot', 'web-token');
const WEB_PID_FILE = join(homedir(), '.lilibtc-bot', 'web-server.pid');
const WEB_PORT_FILE = join(homedir(), '.lilibtc-bot', 'web-port');
const WEB_SERVER_FILE = join(AGENT_DIR, 'web-server.mjs');
const WEB_PORT_DEFAULT = 8421;
const WEB_PORT_MAX = 8430;

// 自更新（v1.0.25+）：主源 npm registry（中国大陆可达性最好，可配 npmmirror 镜像），
// 回退源 GitHub Releases（需代理，--github 强制）。
// 旧 server 通道（version.json + 逐文件）保留给存量排障：设
// LILIBTC_UPDATE_BASE=https://api.lilibtc.com/cli 即切回 server 通道。
const GITHUB_REPO = 'franklili3/lilibtc-bot';
const GITHUB_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const UPDATE_BASE = process.env.LILIBTC_UPDATE_BASE || '';
// npm 回退更新源：主源不可达（如 GitHub 访问受限）时自动切换，
// 默认走 npm；`update --github` 强制走 GitHub（有代理用户）。国内建议 LILIBTC_NPM_REGISTRY=https://registry.npmmirror.com 加速。
// npm tarball 随包分发全部运行文件（含 humanize.mjs / process-detector.mjs）。
const NPM_PACKAGE = 'lilibtc-bot';
const NPM_REGISTRY = (process.env.LILIBTC_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const CLI_VERSION = '1.0.25';

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const cmdArgs = argv.slice(1);

// ========== 工具函数 ==========

function getConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getPid() {
  try {
    return parseInt(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断 lockfile 中的 PID 是否真的是另一个 lilibtc-bot（或旧名 cryptoqclaw/square-agent）实例。
 * 单纯 process.kill(pid,0) 只能确认 PID 存活，但 OS 回收 PID 后会复用给无关进程，
 * 导致 lockfile 误判为「另一实例正在运行」。
 * 使用跨平台进程检测验证是否是 agent.mjs 进程。
 *
 * 返回: 'alive-agent' | 'alive-other' | 'dead' | 'unknown'
 */
async function checkLockOwner(pid) {
  return await ProcessDetector.checkLockOwner(pid);
}

/**
 * 启动前清理过期 lockfile。
 * - dead / alive-other(PID 复用) / 内容非法 → 删 lockfile，返回 { cleaned: true }
 * - alive-agent（真有另一实例）→ 返回 { blocked: true, pid }
 * - 无 lockfile → 返回 {}
 */
async function cleanupStaleLock() {
  if (!existsSync(LOCK_FILE)) return {};
  let pidStr;
  try { pidStr = readFileSync(LOCK_FILE, 'utf8').trim(); } catch { return {}; }
  const pid = parseInt(pidStr, 10);
  if (!pidStr || !pid || Number.isNaN(pid)) {
    try { unlinkSync(LOCK_FILE); } catch {}
    console.log('🧹 清理无效 lockfile（内容非法）');
    return { cleaned: true };
  }
  const state = await checkLockOwner(pid);
  if (state === 'alive-agent') {
    return { blocked: true, pid };
  }
  const reason = state === 'alive-other'
    ? `PID ${pid} 已被无关进程占用（PID 复用）`
    : `PID ${pid} 已退出`;
  console.log(`🧹 清理过期 lockfile（${reason}）`);
  try { unlinkSync(LOCK_FILE); } catch {}
  return { cleaned: true };
}

function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

async function httpRequest(method, urlPath, body) {
  const config = getConfig();
  const baseUrl = ((process.env.LILIBTC_SERVER_URL || process.env.SQUARE_SERVER_URL) || config?.serverUrl || 'https://api.lilibtc.com').replace(/\/$/, '');
  const url = new URL(urlPath, baseUrl).toString();
  const postData = body ? JSON.stringify(body) : null;
  const headers = { 'Authorization': `Bearer ${config?.apiKey || ''}` };
  if (postData) headers['Content-Type'] = 'application/json';

  // 走 undici fetch + 顶部 setGlobalDispatcher(EnvHttpProxyAgent)，自动读 HTTPS_PROXY。
  // 原生 https 模块不读 env 代理，墙内 login/verify 直连必超时。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await undiciFetch(url, { method, headers, body: postData, signal: controller.signal });
    clearTimeout(timer);
    const data = await res.text();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: `HTTP ${res.status}: ${data}` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  }
}

function checkDependencies() {
  let chrome = false, peekaboo = false;
  try { if (process.platform === 'darwin') execSync('osascript -e \'tell application "Google Chrome" to return name\'', { timeout: 5000 }); chrome = true; } catch {}
  try { if (process.platform === 'darwin') execSync('which peekaboo', { timeout: 5000 }); peekaboo = true; } catch {}
  return { chrome, peekaboo, ok: chrome && (process.platform !== 'darwin' || peekaboo) };
}

// ========== 自更新辅助 ==========

/**
 * 解析 semver 字符串为 [major, minor, patch] 整数数组。
 * 非法输入返回 [0,0,0]。
 * 仅支持纯 semver（"1.2.3"），忽略预发布后缀（-beta 等）。
 */
function parseSemver(v) {
  if (!v || typeof v !== 'string') return [0, 0, 0];
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * 比较两个 semver。
 * 返回: 正数 a>b, 负数 a<b, 0 相等。
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** GET 文本（用于拉取 version.json / cli.mjs / GitHub Releases API）。返回 {ok, data, status}。
 *  走 undici fetch + EnvHttpProxyAgent（若设了 HTTPS_PROXY/HTTP_PROXY 自动走代理）。
 *  redirect: 'follow' 自动跟随 302（Caddy/CF 重定向），重定向也走同一 dispatcher。 */
async function fetchText(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, { signal: controller.signal, redirect: 'follow', headers });
    const data = res.ok ? await res.text() : '';
    if (res.ok) return { ok: true, data, status: res.status };
    return { ok: false, status: res.status };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: '请求超时' };
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 写入目标文件（含备份、可选 node --check 语法检查、保留权限、确保父目录）。
 * fetchAndReplace（api 通道）与 npm tarball 更新共用这套落盘逻辑。
 */
function applyContent(targetPath, data, { checkMjs = false, backup = true } = {}) {
  if (checkMjs) {
    // 临时文件必须以 .mjs 结尾，否则 Node ESM loader 报 ERR_UNKNOWN_FILE_EXTENSION
    const tmp = `${targetPath}.update_tmp_${Date.now()}.mjs`;
    try {
      writeFileSync(tmp, data);
      try {
        execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
      } catch (e) {
        throw new Error(`syntax check failed: ${e.stderr?.toString() || e.message}`);
      }
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  }
  if (backup && existsSync(targetPath)) {
    const ts2 = new Date().toISOString().replace(/[:.]/g, '');
    try { copyFileSync(targetPath, `${targetPath}.bak_${ts2}`); } catch {}
  }
  // 确保子目录存在（web/index.html 需要 mkdir web/）
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let originalMode = 0o644;
  try { originalMode = statSync(targetPath).mode & 0o777; } catch {}
  writeFileSync(targetPath, data);
  try { chmodSync(targetPath, originalMode); } catch {}
  return { ok: true };
}

/**
 * cmdUpdate 辅助：下载远程文件覆盖本地（含备份、可选语法检查）。
 * - 远程 404：返回 { skipped:true, reason:'not in remote' }，用于 1.0.16→1.0.17 过渡期
 *
 * 用于 cmdUpdate 拉新 cli.mjs / web-server.mjs / web/index.html（api 通道）。
 */
async function fetchAndReplace(url, targetPath, { checkMjs = false, backup = true } = {}) {
  const r = await fetchText(url, { timeoutMs: 30000 });
  if (!r.ok || !r.data) {
    if (r.status === 404) return { skipped: true, reason: 'not in remote' };
    throw new Error(`download ${url} failed: ${r.error || `HTTP ${r.status}`}`);
  }
  return applyContent(targetPath, r.data, { checkMjs, backup });
}

/** GET 二进制（npm tarball）。返回 {ok, data(Buffer), status} 或 {ok:false, error/status}。 */
async function fetchBuffer(url, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, status: res.status };
    const ab = await res.arrayBuffer();
    return { ok: true, data: Buffer.from(ab), status: res.status };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: '请求超时' };
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 最小 tar 解析：从 tgz Buffer 中提取 wantedPaths 指定的文件，返回 { 'package/xxx': 内容 }。
 * 零依赖实现（zlib.gunzipSync + 手读 512B tar header），只支持常规文件——
 * npm registry 的 tarball 是标准 ustar 格式且我们目标文件名都 <100 字节，够用。
 * 解析异常（坏包/截断）抛错，由调用方兜底。
 */
function extractTarFiles(tgzBuf, wantedPaths) {
  const buf = zlib.gunzipSync(tgzBuf);
  const wanted = new Set(wantedPaths);
  const out = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    if (!name) break; // 全零结束块
    // size 字段：offset 124 起 12 字节八进制
    const sizeField = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField || '0', 8) || 0;
    // typeflag offset 156：'0'/NUL = 常规文件，'5' = 目录，'L' 等 GNU 扩展忽略
    const type = header[156];
    const dataStart = off + 512;
    if ((type === 0 || type === 0x30) && wanted.has(name)) {
      out[name] = buf.subarray(dataStart, dataStart + size).toString('utf8');
    }
    off = dataStart + Math.ceil(size / 512) * 512; // 数据区 512 对齐
  }
  return out;
}

/** 读 daemon.json。返回 {pid, mode, startedAt, args} 或 null。 */
function readDaemon() {
  try {
    return JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 写 daemon.json。 */
function writeDaemon(info) {
  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(DAEMON_FILE, JSON.stringify(info, null, 2));
}

/** 清理 daemon.json（若存在）。 */
function clearDaemon() {
  try { if (existsSync(DAEMON_FILE)) unlinkSync(DAEMON_FILE); } catch {}
}

/**
 * 判断 daemon.json 记录的进程是否仍在运行。
 * 比 cmdStatus 里 isRunning(pid) 多一层：还要校验 cmdline 是否真为 agent.mjs
 * （PID 复用风险，与 cleanupStaleLock 同思路）。
 */
function isDaemonAlive() {
  const d = readDaemon();
  if (!d || !d.pid) return { alive: false, info: d };
  try {
    process.kill(d.pid, 0);
  } catch {
    return { alive: false, info: d };
  }
  if (process.platform === 'linux') {
    try {
      const cmdline = readFileSync(`/proc/${d.pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!cmdline.includes('agent.mjs')) return { alive: false, info: d, stale: true };
    } catch {}
  }
  return { alive: true, info: d };
}

// ========== 命令 ==========

// ----- 本地网页管理面板辅助 -----

/**
 * 生成 32 字节随机十六进制 token，用于 web 鉴权。
 * crypto.randomBytes 是同步且阻塞的，但 32 字节极快。
 */
function generateWebToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 异步端口探测：从 start 到 max 依次尝试在 127.0.0.1 listen，找到一个空闲端口 resolve。
 * 用于 web-server 默认 8421 被占用时自动 +1 试探。
 */
function findFreePort(start, max) {
  return new Promise(resolve => {
    const tryAt = (p) => {
      if (p > max) return resolve(null);
      const s = net.createServer();
      s.once('error', () => tryAt(p + 1));
      s.once('listening', () => {
        s.close(() => resolve(p));
      });
      s.listen(p, '127.0.0.1');
    };
    tryAt(start);
  });
}

/**
 * 跨平台打开浏览器。失败忽略（仅打印 URL）。
 */
function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { timeout: 3000, stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'win32') {
      execSync(`cmd /c start "" "${url}"`, { timeout: 3000, stdio: 'ignore' });
      return true;
    }
    // linux / others
    execSync(`xdg-open "${url}" 2>/dev/null || x-www-browser "${url}" 2>/dev/null`, { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * spawn web-server.mjs 作为独立子进程（detached + unref），写入 PID/PORT。
 * 由 cmdStart 调用，与 agent.mjs 互不依赖。
 *
 * 返回 { ok, pid, port, url, token } 或 { ok:false, error }。
 */
async function spawnWebServer() {
  if (!existsSync(WEB_SERVER_FILE)) {
    return { ok: false, error: `web-server.mjs 未安装。请再运行一次 \`lilibtc-bot update\` 以获取网页面板资源（从 1.0.16 升级到 1.0.17 需跑两次 update）` };
  }

  // 复用已有 token（避免每次重启 URL 变），无则生成新的
  let token;
  try {
    if (existsSync(WEB_TOKEN_FILE)) {
      token = readFileSync(WEB_TOKEN_FILE, 'utf8').trim();
    }
  } catch {}
  if (!token || token.length !== 64) {
    token = generateWebToken();
    if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });
    writeFileSync(WEB_TOKEN_FILE, token);
    try { chmodSync(WEB_TOKEN_FILE, 0o600); } catch {}
  }

  const port = await findFreePort(WEB_PORT_DEFAULT, WEB_PORT_MAX);
  if (!port) {
    return { ok: false, error: `端口 ${WEB_PORT_DEFAULT}-${WEB_PORT_MAX} 均被占用` };
  }

  const child = spawn(process.execPath, [WEB_SERVER_FILE], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEB_TOKEN: token,
      WEB_PORT: String(port),
    },
  });
  child.unref();

  if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });
  writeFileSync(WEB_PID_FILE, child.pid.toString());
  writeFileSync(WEB_PORT_FILE, String(port));

  const url = `http://127.0.0.1:${port}/?token=${token}`;
  return { ok: true, pid: child.pid, port, url, token };
}

/**
 * 停止 web-server 子进程（cmdStop 联动调用）。
 */
function stopWebServer() {
  let pid = null;
  try { pid = parseInt(readFileSync(WEB_PID_FILE, 'utf8'), 10); } catch {}
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  try { if (existsSync(WEB_PID_FILE)) unlinkSync(WEB_PID_FILE); } catch {}
  // 注意：token 和 port 文件不清，下次 start 复用同一 URL，避免用户重复复制
}

/**
 * 查询 web-server 状态（cmdStatus 调用）。
 */
function getWebStatus() {
  let pid = null, port = null;
  try { pid = parseInt(readFileSync(WEB_PID_FILE, 'utf8'), 10); } catch {}
  try { port = parseInt(readFileSync(WEB_PORT_FILE, 'utf8'), 10); } catch {}
  const running = pid && isRunning(pid);
  return { running, pid, port };
}

async function cmdLogin() {
  const keyArg = cmdArgs.find(a => a.startsWith('--key='));
  const keyIdx = cmdArgs.indexOf('--key');
  const apiKey = keyArg ? keyArg.split('=')[1] : (keyIdx >= 0 ? cmdArgs[keyIdx + 1] : null);

  if (!apiKey) {
    console.error('❌ 用法: lilibtc-bot login --key <sk-xxxxx 或 bsq_xxxxx>');
    process.exit(1);
  }

  if (!apiKey.startsWith('sk-') && !apiKey.startsWith('bsq_')) {
    console.error('❌ API Key 格式错误，应以 sk- 或 bsq_ 开头');
    process.exit(1);
  }

  console.log('🔐 验证 API Key...');
  const result = await httpRequest('GET', `/api/agent/verify?key=${apiKey}`);

  if (!result.ok) {
    console.error('❌ API Key 验证失败:', result.error);
    process.exit(1);
  }

  const data = JSON.parse(result.data);
  // 公网默认 https；server 返回的 server_url 可能是 http://hostname:5577（旧版兼容字段），不可信
  const finalServerUrl = (process.env.LILIBTC_SERVER_URL || process.env.SQUARE_SERVER_URL) || 'https://api.lilibtc.com';
  saveConfig({
    apiKey,
    userId: data.user_id,
    plan: data.plan,
    serverUrl: finalServerUrl,
    loggedInAt: new Date().toISOString()
  });

  console.log('✅ 登录成功！');
  console.log(`   用户: ${data.user_id}`);
  console.log(`   套餐: ${data.plan}`);
  console.log(`   服务器: ${finalServerUrl}`);
  console.log('\n运行 `lilibtc-bot start` 开始。');
}

/**
 * 设置币安广场 OpenAPI Key（发帖用，仅本地存储）。
 * 写入 ~/.lilibtc-bot/binance-api-key，权限 600。
 * publisher agent.mjs getApiKey() 读取同一路径。
 *
 * 与 `login --key` 区别：login 是 :3100 server 的 bot API key（认证用）；
 * 本命令是发帖到 binance.com 的 OpenAPI Key。两者独立。
 */
function maskKey(v) {
  if (!v) return '(空)';
  if (v.length <= 10) return v.slice(0, 2) + '...' + v.slice(-2);
  return v.slice(0, 6) + '...' + v.slice(-4);
}

async function cmdSetBinanceKey() {
  // --show: 只读打码显示当前 key
  if (cmdArgs.includes('--show')) {
    if (!existsSync(BINANCE_KEY_FILE)) {
      console.log('⚪ 尚未设置币安广场 OpenAPI Key。');
      console.log('   运行: lilibtc-bot set-binance-key <key>');
      return;
    }
    const v = readFileSync(BINANCE_KEY_FILE, 'utf8').trim();
    console.log(`🔐 当前币安广场 OpenAPI Key: ${maskKey(v)}`);
    console.log(`   路径: ${BINANCE_KEY_FILE}`);
    return;
  }

  // --clear: 删除
  if (cmdArgs.includes('--clear')) {
    if (!existsSync(BINANCE_KEY_FILE)) {
      console.log('⚪ Key 文件不存在，无需清理。');
      return;
    }
    try {
      unlinkSync(BINANCE_KEY_FILE);
      console.log('✅ 已删除币安广场 OpenAPI Key。');
    } catch (e) {
      console.error('❌ 删除失败:', e.message);
      process.exit(1);
    }
    return;
  }

  // 写入：支持 `set-binance-key <key>`、`set-binance-key --key <key>`、`set-binance-key --key=<key>`
  const eqArg = cmdArgs.find(a => a.startsWith('--key='));
  const flagIdx = cmdArgs.indexOf('--key');
  const key = eqArg ? eqArg.split('=')[1]
    : (flagIdx >= 0 ? cmdArgs[flagIdx + 1]
       : cmdArgs.find(a => !a.startsWith('--')));

  if (!key) {
    console.error('❌ 用法: lilibtc-bot set-binance-key <key>');
    console.error('   或:   lilibtc-bot set-binance-key --key <key>');
    console.error('');
    console.error('选项:');
    console.error('   --show    显示当前 key 的打码版本');
    console.error('   --clear   删除 key 文件');
    process.exit(1);
  }

  // 校验：长度 32-128，字符集 [A-Za-z0-9_-]
  if (key.length < 32 || key.length > 128) {
    console.error(`❌ Key 长度异常 (${key.length} 字符)。币安广场 OpenAPI Key 通常为 32-128 字符。`);
    process.exit(1);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    console.error('❌ Key 含非法字符。仅允许字母、数字、下划线、连字符。');
    process.exit(1);
  }

  // 提示覆盖
  if (existsSync(BINANCE_KEY_FILE)) {
    const old = readFileSync(BINANCE_KEY_FILE, 'utf8').trim();
    if (old && old !== key) {
      console.log(`⚠️  将覆盖现有 key: ${maskKey(old)} → ${maskKey(key)}`);
    }
  }

  // 写入：确保目录存在 + 权限 600
  const dir = join(homedir(), '.lilibtc-bot');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(BINANCE_KEY_FILE, key + '\n');
  try { chmodSync(BINANCE_KEY_FILE, 0o600); } catch {} // Windows 上无效，忽略

  console.log('✅ 币安广场 OpenAPI Key 已保存。');
  console.log(`   ${maskKey(key)}`);
  console.log(`   路径: ${BINANCE_KEY_FILE} (权限 600)`);
  console.log('');
  console.log('   运行 `lilibtc-bot start` 后，publisher 会自动读取该 key 发帖。');
}

async function cmdStart() {
  const config = getConfig();
  if (!config?.apiKey) {
    console.error('❌ 尚未登录。请先运行: lilibtc-bot login --key <sk-xxxxx 或 bsq_xxxxx>');
    process.exit(1);
  }

  // 注意：cmdLogin 把 token 存为 config.apiKey（与 server verify/register 共用同一个
  // bsq_xxx token），不是 agentToken。这里回退到 config.apiKey 才能取到登录态。
  const agentToken = process.env.LILIBTC_BOT_TOKEN || process.env.CRYPTOQCLAW_AGENT_TOKEN || process.env.AGENT_TOKEN || config?.agentToken || config?.apiKey;
  if (!agentToken) {
    console.error('❌ 请先运行: lilibtc-bot login --key <sk-xxxxx 或 bsq_xxxxx>');
    process.exit(1);
  }

  // 启动本地网页管理面板（前台 / daemon 都起；与 agent 互不依赖）
  // spawnWebServer 失败不阻断 agent 启动
  let webInfo = null;
  try {
    webInfo = await spawnWebServer();
  } catch (e) {
    console.warn(`⚠️  网页面板启动异常: ${e.message}（不影响代理）`);
  }
  if (webInfo?.ok) {
    console.log(`🌐 网页管理面板: ${webInfo.url}`);
    const opened = openBrowser(webInfo.url);
    if (!opened) console.log('   浏览器未自动打开，请手动复制 URL 到浏览器');
  } else if (webInfo?.error) {
    console.warn(`⚠️  网页面板: ${webInfo.error}`);
  }

  // 准备 agent env（agent.mjs 读这些）
  const agentEnv = {
    ...process.env,
    AGENT_TOKEN: agentToken,
    SERVER_URL: process.env.SERVER_URL || config?.serverUrl || 'https://api.lilibtc.com',
    API_KEY: process.env.API_KEY || config?.apiKey || '',
  };
  // 代理：config.proxy 优先于 shell env。
  // 大陆用户访问 binance.com 必须走代理；daemon 模式不读 ~/.bashrc，
  // 由 config.proxy（网页设置）注入，比让用户每次手动 HTTPS_PROXY=xxx 友好。
  if (config?.proxy && typeof config.proxy === 'string') {
    agentEnv.HTTPS_PROXY = config.proxy;
    agentEnv.HTTP_PROXY = config.proxy;
  }

  const isDaemon = cmdArgs.includes('--daemon');

  if (isDaemon) {
    // daemon 模式：直接 spawn agent.mjs（detached），不再通过 cli.mjs start 二次 spawn
    // （早期版本 spawn cli.mjs start 是为了复用前台 env 准备逻辑，现在改成显式拼 env）
    const child = spawn(process.execPath, [`${AGENT_DIR}/agent.mjs`], {
      detached: true,
      stdio: 'ignore',
      env: agentEnv,
    });
    child.unref();
    writeFileSync(PID_FILE, child.pid.toString());
    writeDaemon({
      pid: child.pid,
      mode: 'daemon',
      startedAt: new Date().toISOString(),
      args: process.argv.slice(2)
    });
    console.log(`✅ 代理已在后台启动 (PID ${child.pid})`);
    console.log('   使用 `lilibtc-bot stop` 停止');
    console.log('   使用 `lilibtc-bot status` 查看状态');
    return;
  }

  console.log('🤖 Lilibtc Bot 启动中...');
  console.log(`   用户: ${config.userId}`);
  console.log(`   服务器: ${config.serverUrl}`);
  console.log('   按 Ctrl+C 停止');
  console.log('─'.repeat(50));

  // 启动 agent.mjs 前先清理过期 lockfile，避免残留导致误报「另一实例正在运行」
  const lockState = await cleanupStaleLock();
  if (lockState.blocked) {
    console.error(`❌ 另一实例正在运行 (PID ${lockState.pid})，请先运行: lilibtc-bot stop`);
    process.exit(1);
  }

  writeFileSync(PID_FILE, process.pid.toString());
  writeDaemon({
    pid: process.pid,
    mode: 'foreground',
    startedAt: new Date().toISOString(),
    args: process.argv.slice(2)
  });

  const deps = checkDependencies();
  console.log(`   Chrome: ${deps.chrome ? '✅' : '❌'}`);
  console.log(`   Peekaboo: ${deps.peekaboo ? '✅' : '❌'}`);
  console.log('');

  try {
    execSync(`node ${AGENT_DIR}/agent.mjs`, { stdio: 'inherit', timeout: 3600000, env: agentEnv });
  } catch (e) {
    if (e.killed) console.log('代理已停止');
    else console.error('代理错误:', e.message);
  } finally {
    // 前台模式退出时同步停 web（daemon 模式由 cmdStop 联动处理）
    stopWebServer();
  }
}

async function cmdStatus() {
  const config = getConfig();

  console.log('📊 Lilibtc Bot 状态');
  console.log('─'.repeat(30));

  if (!config) {
    console.log('  ⚪ 未配置。请先运行: lilibtc-bot login --key <sk-xxxxx 或 bsq_xxxxx>');
  } else {
    console.log(`  用户:    ${config.userId || '-'}`);
    console.log(`  套餐:    ${config.plan || '-'}`);
    console.log(`  服务器:  ${config.serverUrl || '-'}`);
    console.log(`  登录时间: ${config.loggedInAt || '-'}`);
  }

  const pid = getPid();
  if (pid && isRunning(pid)) {
    console.log(`  代理:   🟢 运行中 (PID ${pid})`);
  } else {
    console.log('  代理:   ⚪ 已停止');
  }

  // 网页管理面板状态
  const web = getWebStatus();
  if (web.running) {
    console.log(`  网页:   🌐 运行中 (PID ${web.pid}, 端口 ${web.port})`);
    // token URL 太长，只打印一次（首次 start 时已打印过；这里仅在 status 里给端口提示）
    console.log(`          http://127.0.0.1:${web.port}/?token=***（token 在 ~/.lilibtc-bot/web-token）`);
  } else {
    console.log('  网页:   ⚪ 未运行（启动代理时自动开启）');
  }

  const deps = checkDependencies();
  console.log(`  Chrome:  ${deps.chrome ? '✅' : '❌'}`);
  console.log(`  Peekaboo: ${deps.peekaboo ? '✅' : '❌'}`);

  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(LOG_DIR, `${today}.jsonl`);
    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, 'utf8').trim().split('\n');
      console.log(`\n  今日日志 (${lines.length} 条，最近 5 条):`);
      lines.slice(-5).forEach(l => {
        try {
          const e = JSON.parse(l);
          const icon = e.success ? '✅' : '❌';
          console.log(`    ${icon} #${e.task_id} ${e.type || ''} ${e.duration_ms || 0}ms`);
        } catch {
          console.log(`    ${l}`);
        }
      });
    }
  } catch {}

  try {
    const statsFile = join(LOG_DIR, 'daily-stats.json');
    if (existsSync(statsFile)) {
      const stats = JSON.parse(readFileSync(statsFile, 'utf8'));
      console.log(`\n  每日统计: ${stats.posts} 篇帖子, ${stats.comments} 条评论, ${stats.follows} 次关注`);
    }
  } catch {}
}

async function cmdStop() {
  const pid = getPid();
  let stopped = false;
  if (pid && isRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`✅ 代理已停止 (原 PID ${pid})`);
      stopped = true;
    } catch {
      console.log('⚠️ 无法停止代理');
    }
    try { unlinkSync(PID_FILE); } catch {}
  } else {
    try {
      const pids = execSync('pgrep -f "(lilibtc-bot|cryptoqclaw|square-agent).*agent.mjs"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      pids.forEach(p => { try { process.kill(parseInt(p), 'SIGTERM'); } catch {} });
      console.log(`✅ 代理已停止 (PID: ${pids.join(', ')})`);
      stopped = pids.length > 0;
    } catch {
      console.log('⚠️ 代理未在运行');
    }
    try { unlinkSync(PID_FILE); } catch {}
  }
  // 无论 PID 是否在跑，都清理 lockfile（防残留）
  if (existsSync(LOCK_FILE)) {
    try { unlinkSync(LOCK_FILE); console.log('🧹 已清理 lockfile'); } catch {}
  }
  // 同步清理 daemon.json（cmdStart 写入，cmdUpdate 读它决定重启模式）
  clearDaemon();
  // 联动停 web-server 子进程（避免代理已停但网页面板还在跑）
  stopWebServer();
}

async function cmdHistory() {
  const limit = parseInt(cmdArgs[0]) || 20;

  if (!existsSync(LOG_DIR)) {
    console.log('未找到日志。');
    return;
  }

  const files = readdirSync(LOG_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse();

  const entries = [];
  for (const f of files) {
    if (entries.length >= limit) break;
    try {
      const lines = readFileSync(join(LOG_DIR, f), 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try { entries.push(JSON.parse(lines[i])); } catch {}
      }
    } catch {}
  }

  if (entries.length === 0) {
    console.log('暂无历史记录。');
    return;
  }

  console.log(`📋 最近 ${entries.length} 条执行记录:`);
  console.log('─'.repeat(70));
  console.log('  时间                 任务   类型      状态  耗时');
  console.log('─'.repeat(70));
  entries.forEach(e => {
    const icon = e.success ? '✅' : '❌';
    const time = e.ts ? new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) : '-';
    const taskId = String(e.task_id || '-').padEnd(5);
    const type = (e.type || '-').padEnd(9);
    const dur = `${e.duration_ms || 0}ms`.padEnd(8);
    console.log(`  ${time}  #${taskId} ${type} ${icon}   ${dur}`);
  });
}

async function cmdStates() {
  if (!existsSync(LOG_DIR)) {
    console.log('未找到日志。');
    return;
  }

  const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).sort();

  let total = 0, success = 0, failed = 0;
  let totalDuration = 0;
  const byType = {};
  const byDate = {};

  for (const f of files) {
    try {
      const lines = readFileSync(join(LOG_DIR, f), 'utf8').trim().split('\n');
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          total++;
          if (e.success) success++; else failed++;
          totalDuration += e.duration_ms || 0;
          const type = e.type || '未知';
          byType[type] = (byType[type] || 0) + 1;
          const date = f.replace('.jsonl', '');
          byDate[date] = (byDate[date] || 0) + 1;
        } catch {}
      }
    } catch {}
  }

  console.log('📈 任务执行统计');
  console.log('─'.repeat(40));
  console.log(`  总计:     ${total}`);
  console.log(`  成功:     ${success} (${total ? ((success / total) * 100).toFixed(1) : 0}%)`);
  console.log(`  失败:     ${failed}`);
  console.log(`  平均耗时: ${total ? Math.round(totalDuration / total) : 0}ms`);
  console.log(`  总耗时:   ${Math.round(totalDuration / 1000)}s`);

  if (Object.keys(byType).length > 0) {
    console.log('\n  按类型:');
    Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
      console.log(`    ${type.padEnd(12)} ${count}`);
    });
  }

  const recentDates = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);
  if (recentDates.length > 0) {
    console.log('\n  最近 7 天:');
    recentDates.forEach(([date, count]) => {
      const bar = '█'.repeat(Math.min(count, 30));
      console.log(`    ${date}  ${bar} ${count}`);
    });
  }
}

async function cmdSetting() {
  const config = getConfig();

  if (!config) {
    console.log('⚠️ 未找到配置。请先运行: lilibtc-bot login --key <sk-xxxxx 或 bsq_xxxxx>');
    return;
  }

  const key = cmdArgs[0];
  const value = cmdArgs[1];

  if (!key) {
    console.log('⚙️  当前配置');
    console.log('─'.repeat(30));
    Object.entries(config).forEach(([k, v]) => {
      if (k === 'apiKey') {
        const masked = v.slice(0, 6) + '...' + v.slice(-4);
        console.log(`  ${k}: ${masked}`);
      } else {
        console.log(`  ${k}: ${v}`);
      }
    });
    return;
  }

  if (!value) {
    if (config[key] !== undefined) {
      console.log(`  ${key}: ${key === 'apiKey' ? config[key].slice(0, 6) + '...' + config[key].slice(-4) : config[key]}`);
    } else {
      console.log(`  ⚠️ 未知配置项: ${key}`);
      console.log(`  可用项: ${Object.keys(config).join(', ')}`);
    }
    return;
  }

  let parsed = value;
  try { parsed = JSON.parse(value); } catch {}
  config[key] = parsed;
  saveConfig(config);
  console.log(`✅ ${key} = ${value}`);
}

async function cmdAnalytics() {
  const subcmd = cmdArgs[0] || 'all';
  if (subcmd === 'stats' || subcmd === 'all') {
    console.log('\n=== 每日统计 ===');
    try { execSync(`node ${AGENT_DIR}/analytics/daily-stats.mjs`, { stdio: 'inherit' }); } catch {}
  }
  if (subcmd === 'hot-topics' || subcmd === 'all') {
    console.log('\n=== 热点报告 ===');
    try { execSync(`node ${AGENT_DIR}/analytics/hot-topics.mjs`, { stdio: 'inherit' }); } catch {}
  }
  if (subcmd === 'engagement' || subcmd === 'all') {
    console.log('\n=== 互动分析 ===');
    try { execSync(`node ${AGENT_DIR}/analytics/engagement-analysis.mjs`, { stdio: 'inherit' }); } catch {}
  }
  if (subcmd === 'scrape' || subcmd === 'all') {
    console.log('\n=== 创作者中心数据抓取 ===');
    try { execSync(`node ${AGENT_DIR}/analytics/scrape-creator-center.mjs`, { stdio: 'inherit' }); } catch {}
  }
  if (subcmd === 'weekly' || subcmd === 'all') {
    console.log('\n=== 周度报告 ===');
    try { execSync(`node ${AGENT_DIR}/analytics/weekly-report.mjs`, { stdio: 'inherit' }); } catch {}
  }
}

/**
 * lilibtc-bot update —— 自更新（1.0.24+ 三源）。
 *
 * 更新源（sourceMode）:
 *   npm:   GET {NPM_REGISTRY}/{NPM_PACKAGE}/latest —— 主源（v1.0.25+，大陆可达性最好），
 *          tarball 解包一次性更新全部运行文件；--npm 仍被接受（即默认）
 *   github: GET api.github.com .../releases/latest —— 回退源（需代理），--github 强制；
 *          下载 release 资产 lilibtc-bot-v{VERSION}.tgz 解包更新
 *   api:   GET {UPDATE_BASE}/version.json —— 存量排障通道，仅在设了
 *          LILIBTC_UPDATE_BASE 时启用；逐文件下载（cli/agent/web-server/web/index.html）
 *
 * 流程:
 *   1. 拉远端版本（主源失败→npm 回退），比对 semver
 *   2. 远程 <= 本地 → 提示「已是最新」
 *   3. 远程 > 本地：
 *      a. github/npm: 下载 tarball 解包（cli.mjs / agent.mjs / humanize.mjs /
 *         process-detector.mjs / web-server.mjs / web/index.html）
 *         api: 逐文件下载
 *      b. node --check 验证语法 → 备份 → 覆盖（保留权限）
 *      c. 读 daemon.json：daemon 在跑 → stop + 按原模式重启
 *         前台模式无法自动 fork，提示用户手动重启
 *      d. 显示结果
 *
 * 退出码: 0 成功（含「已是最新」），1 失败。
 */
async function cmdUpdate() {
  const forceGithub = cmdArgs.includes('--github');
  const localVersion = CLI_VERSION;
  const thisFile = process.argv[1]; // 当前 cli.mjs 绝对路径（npm 全局软链解引用后）

  // 源优先级（v1.0.25+，中国大陆优先）：npm(默认) > --github 显式 > LILIBTC_UPDATE_BASE(api, 存量排障)
  let sourceMode = forceGithub ? 'github' : (UPDATE_BASE ? 'api' : 'npm');
  const sourceLabel = sourceMode === 'npm' ? `${NPM_REGISTRY} (${NPM_PACKAGE})`
    : sourceMode === 'api' ? `${UPDATE_BASE}（server 通道）`
    : `GitHub Releases (${GITHUB_REPO})`;

  console.log('🔄 检查更新...');
  console.log(`   当前版本: ${localVersion}`);
  console.log(`   更新源:   ${sourceLabel}`);

  // 1. 拉取远端版本：主源 npm（默认）；github 为 --github 显式回退；api 仅存量排障
  let remoteInfo = null;      // { version, changelog? }
  let tarballUrl = null;      // github/npm 模式：tgz 下载地址

  if (sourceMode === 'github') {
    const gRes = await fetchText(GITHUB_RELEASE_API, {
      timeoutMs: 10000,
      headers: { 'User-Agent': 'lilibtc-bot', 'Accept': 'application/vnd.github+json' },
    });
    if (gRes.ok) {
      let rel;
      try {
        rel = JSON.parse(gRes.data);
      } catch (e) {
        console.error('❌ GitHub Release 元数据解析失败:', e.message);
        process.exit(1);
      }
      const version = String(rel.tag_name || '').replace(/^v/, '');
      if (!version) {
        console.error('❌ Release 缺少 tag_name 字段');
        process.exit(1);
      }
      const asset = (rel.assets || []).find(a => a.name === `lilibtc-bot-v${version}.tgz`);
      if (!asset?.browser_download_url) {
        console.error(`❌ Release 缺少资产 lilibtc-bot-v${version}.tgz`);
        process.exit(1);
      }
      remoteInfo = { version, changelog: rel.body || `GitHub Release ${rel.tag_name}` };
      tarballUrl = asset.browser_download_url;
    } else {
      console.log(`⚠️  GitHub 主源不可达（${gRes.error || `HTTP ${gRes.status}`}），切换 npm 回退源...`);
      sourceMode = 'npm';
    }
  } else if (sourceMode === 'api') {
    const vRes = await fetchText(`${UPDATE_BASE}/version.json`, { timeoutMs: 10000 });
    if (vRes.ok) {
      try {
        remoteInfo = JSON.parse(vRes.data);
      } catch (e) {
        console.error('❌ version.json 解析失败:', e.message);
        process.exit(1);
      }
      if (!remoteInfo.version) {
        console.error('❌ version.json 缺少 version 字段');
        process.exit(1);
      }
    } else {
      console.log(`⚠️  server 通道不可达（${vRes.error || `HTTP ${vRes.status}`}），切换 npm 回退源...`);
      sourceMode = 'npm';
    }
  }

  if (sourceMode === 'npm') {
    const nRes = await fetchText(`${NPM_REGISTRY}/${NPM_PACKAGE}/latest`, { timeoutMs: 15000 });
    if (!nRes.ok) {
      console.error(`❌ npm 源不可达: ${nRes.error || `HTTP ${nRes.status}`}`);
      console.error('   排查: 大陆网络建议 LILIBTC_NPM_REGISTRY=https://registry.npmmirror.com；');
      console.error('        有代理可改用 lilibtc-bot update --github 走 GitHub Releases。');
      process.exit(1);
    }
    let npmMeta;
    try {
      npmMeta = JSON.parse(nRes.data);
    } catch (e) {
      console.error('❌ npm 元数据解析失败:', e.message);
      process.exit(1);
    }
    if (!npmMeta.version || !npmMeta.dist?.tarball) {
      console.error('❌ npm 元数据缺少 version 或 dist.tarball 字段');
      process.exit(1);
    }
    remoteInfo = { version: npmMeta.version, changelog: `npm ${npmMeta.name}@${npmMeta.version}` };
    tarballUrl = npmMeta.dist.tarball;
  }

  const remoteVersion = String(remoteInfo.version).replace(/^v/, '');
  console.log(`   远程版本: ${remoteVersion}（${sourceMode}）`);

  // 2. 比对
  const cmp = compareSemver(remoteVersion, localVersion);
  if (cmp <= 0) {
    console.log('✅ 已是最新版本，无需更新。');
    return;
  }

  if (remoteInfo.changelog) {
    console.log(`\n   更新内容:\n${String(remoteInfo.changelog).split('\n').map(l => '     ' + l).join('\n')}\n`);
  }

  // 3. 下载并应用：github/npm 解包 tarball 一次性更新（含依赖，更完整）；api 逐文件拉取
  if (sourceMode === 'github' || sourceMode === 'npm') {
    console.log(`⬇️  下载 ${sourceMode} tarball...`);
    const tgzRes = await fetchBuffer(tarballUrl, { timeoutMs: 60000 });
    if (!tgzRes.ok || !tgzRes.data) {
      console.error(`❌ tarball 下载失败: ${tgzRes.error || `HTTP ${tgzRes.status}`}`);
      process.exit(1);
    }
    const wanted = [
      'package/cli.mjs',
      'package/agent.mjs',
      'package/humanize.mjs',         // agent.mjs 依赖，api 通道不分发
      'package/process-detector.mjs', // cli/agent 依赖，api 通道不分发
      'package/web-server.mjs',
      'package/web/index.html',
    ];
    let files;
    try {
      files = extractTarFiles(tgzRes.data, wanted);
    } catch (e) {
      console.error('❌ tarball 解包失败:', e.message);
      process.exit(1);
    }
    if (!files['package/cli.mjs']) {
      console.error('❌ tarball 内缺少 package/cli.mjs');
      process.exit(1);
    }
    // cli.mjs 先行：语法检查 + 备份 + 覆盖自身
    try {
      applyContent(thisFile, files['package/cli.mjs'], { checkMjs: true });
      console.log(`✅ 已更新: ${thisFile}`);
    } catch (e) {
      console.error('❌ cli.mjs 更新失败:', e.message);
      process.exit(1);
    }
    // 其余运行文件 → AGENT_DIR（humanize/process-detector 是 npm 回退顺带补齐的缺口）
    for (const p of wanted.slice(1)) {
      const content = files[p];
      if (!content) { console.log(`⚠️  tarball 无 ${p}，跳过`); continue; }
      const rel = p.replace(/^package\//, '');
      const target = join(AGENT_DIR, rel);
      try {
        applyContent(target, content, { checkMjs: rel.endsWith('.mjs') });
        console.log(`✅ 已更新: ${target}`);
      } catch (e) {
        console.warn(`⚠️  ${rel} 更新失败: ${e.message}`);
      }
    }
  } else {
    console.log('⬇️  下载新版本...');
    const cRes = await fetchText(`${UPDATE_BASE}/cli.mjs`, { timeoutMs: 30000 });
    if (!cRes.ok || !cRes.data) {
      console.error(`❌ 下载失败: ${cRes.error || `HTTP ${cRes.status}`}`);
      process.exit(1);
    }
    const newSource = cRes.data;

    // 语法检查（写入临时文件后 node --check；.mjs 后缀防 ESM loader 报错）
    const tmpFile = `${thisFile}.update_tmp_${Date.now()}.mjs`;
    try {
      writeFileSync(tmpFile, newSource);
      try {
        execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
      } catch (e) {
        console.error('❌ 新版本语法检查失败，已中止更新:');
        console.error(e.stderr ? e.stderr.toString() : e.message);
        try { unlinkSync(tmpFile); } catch {}
        process.exit(1);
      }
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }

    // 备份 + 覆盖（用 fs API，跨平台，避免依赖 Unix 的 cp/stat）
    const ts = new Date().toISOString().replace(/[:.]/g, '');
    const backupFile = `${thisFile}.bak_${ts}`;
    let originalMode = 0o755;
    try {
      originalMode = statSync(thisFile).mode & 0o777;
    } catch {}
    try {
      copyFileSync(thisFile, backupFile);
      console.log(`   已备份: ${backupFile}`);
    } catch (e) {
      console.error('❌ 备份失败:', e.message);
      process.exit(1);
    }
    writeFileSync(thisFile, newSource);
    try { chmodSync(thisFile, originalMode); } catch {}
    console.log(`✅ 已更新: ${thisFile}`);

    // 同步附属资源（1.0.17+ 引入）：web-server.mjs + web/index.html + agent.mjs
    // 旧 server 可能没部署，404 时跳过（不影响 cli 工作）
    console.log('⬇️  检查附属资源...');
    try {
      const wsRes = await fetchAndReplace(`${UPDATE_BASE}/web-server.mjs`, join(AGENT_DIR, 'web-server.mjs'), { checkMjs: true });
      if (wsRes.ok) console.log(`✅ 已更新: ${join(AGENT_DIR, 'web-server.mjs')}`);
      else if (wsRes.skipped) console.log('⚠️  远端无 web-server.mjs（旧版本 server），跳过。请稍后再跑一次 update。');
    } catch (e) {
      console.warn(`⚠️  web-server.mjs 更新失败: ${e.message}`);
    }
    try {
      const htmlRes = await fetchAndReplace(`${UPDATE_BASE}/web/index.html`, join(AGENT_DIR, 'web', 'index.html'));
      if (htmlRes.ok) console.log(`✅ 已更新: ${join(AGENT_DIR, 'web', 'index.html')}`);
      else if (htmlRes.skipped) console.log('⚠️  远端无 web/index.html，跳过');
    } catch (e) {
      console.warn(`⚠️  web/index.html 更新失败: ${e.message}`);
    }
    // agent.mjs 是 cmdStart spawn 的发布器主程序。1.0.22+ 加入自更新通道。
    // 旧 server (≤1.0.21) 没有 /cli/agent.mjs，404 跳过；下次发版后就能更新到。
    try {
      const aRes = await fetchAndReplace(`${UPDATE_BASE}/agent.mjs`, join(AGENT_DIR, 'agent.mjs'), { checkMjs: true });
      if (aRes.ok) console.log(`✅ 已更新: ${join(AGENT_DIR, 'agent.mjs')}`);
      else if (aRes.skipped) console.log('⚠️  远端无 agent.mjs（server ≤1.0.21），跳过。下次 server 发版后再跑 update 即可。');
    } catch (e) {
      console.warn(`⚠️  agent.mjs 更新失败: ${e.message}（daemon 重启仍会用旧版本）`);
    }
  }

  // 6. daemon 重启
  const { alive, info } = isDaemonAlive();
  if (!alive) {
    console.log('ℹ️  代理未在运行，无需重启。');
    clearDaemon();
    return;
  }
  console.log(`\n🔌 停止当前代理 (PID ${info.pid})...`);
  // 复用 stop 逻辑：直接 SIGTERM + 清文件
  try { process.kill(info.pid, 'SIGTERM'); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  try { if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE); } catch {}
  clearDaemon();
  // 等进程退出
  for (let i = 0; i < 20; i++) {
    try { process.kill(info.pid, 0); await new Promise(r => setTimeout(r, 200)); }
    catch { break; }
  }

  if (info.mode === 'daemon') {
    console.log('🚀 以 daemon 模式重启...');
    const child = spawn(process.execPath, [thisFile, 'start', '--daemon'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    writeFileSync(PID_FILE, child.pid.toString());
    writeDaemon({
      pid: child.pid,
      mode: 'daemon',
      startedAt: new Date().toISOString(),
      args: ['start', '--daemon']
    });
    console.log(`✅ 已重启 (PID ${child.pid})`);
  } else {
    console.log('⚠️  原本是前台模式运行，无法自动 fork。');
    console.log('   请手动执行: lilibtc-bot start');
  }
}

function cmdHelp() {
  console.log(`
Lilibtc Bot - 币安广场自动发布代理

用法: lilibtc-bot <命令> [选项]

命令:
  login --key <密钥>   使用 API Key 登录 (sk-xxxxx 或 bsq_xxxxx)
                       两种写法都行：--key bsq_xxx 或 --key=bsq_xxx
  set-binance-key <k>  设置币安广场发帖 OpenAPI Key（仅本地存储，权限 600）
                       也可用: set-binance-key --key <k>  或  --key=<k>
                       set-binance-key --show    查看当前 key（打码）
                       set-binance-key --clear   删除 key
  start [--daemon]     启动代理（前台或后台）
                       启动时会同时启动本地网页管理面板（绑 127.0.0.1，自动打开浏览器），
                       可在浏览器中完成登录、设币安 Key、查状态、查日志、启停代理。
                       面板 URL 形如 http://127.0.0.1:8421/?token=xxx，仅本机可访问。
                       ⚠ 后台模式不会自动加载 shell 的代理设置，必须显式带 HTTPS_PROXY：
                         Linux / macOS:  HTTPS_PROXY=http://127.0.0.1:1081 lilibtc-bot start --daemon
                         Windows PS:     $env:HTTPS_PROXY="http://127.0.0.1:7897"; lilibtc-bot start --daemon
                         Windows CMD:    set HTTPS_PROXY=http://127.0.0.1:7897 && lilibtc-bot start --daemon
                       （端口换成你自己代理的端口；前台模式继承当前 shell env，无需重复设置）
                       ⚠ Windows PowerShell/CMD 不支持 "VAR=value cmd" 前缀语法，
                       照搬 Linux 写法会报「无法识别为 cmdlet」错误。
  stop                 停止后台代理
  status               查看代理状态、依赖、最近日志
  update               自更新到最新版本（主源 npm，国内建议 LILIBTC_NPM_REGISTRY=
                       https://registry.npmmirror.com 加速；--github 走 GitHub Releases（需代理）；
                       排障可设 LILIBTC_UPDATE_BASE 切回 server 通道），
                       按 daemon.json 记录的原启动模式重启代理
  setting [key] [val]  查看/修改配置
  history [n]          查看最近 n 条执行记录（默认20）
  states               查看任务执行统计
  version              显示版本信息
  analytics <子命令>   运行数据分析
                stats       - 每日操作统计
                hot-topics  - 早间热点报告
                engagement  - 互动分析报告
                scrape      - 抓取币安创作者中心数据
                weekly      - 周度互动报告
                all         - 运行所有分析
  help                 显示此帮助
`);
}

// ========== 入口 ==========

function cmdVersion() {
  console.log(`lilibtc-bot v${CLI_VERSION}`);
}

switch (command) {
  case 'login': await cmdLogin(); break;
  case 'set-binance-key': await cmdSetBinanceKey(); break;
  case 'start': await cmdStart(); break;
  case 'stop': await cmdStop(); break;
  case 'status': await cmdStatus(); break;
  case 'update': await cmdUpdate(); break;
  case 'setting': await cmdSetting(); break;
  case 'history': await cmdHistory(); break;
  case 'states': await cmdStates(); break;
  case 'analytics': await cmdAnalytics(); break;
  case 'version': cmdVersion(); break;
  case '--version': cmdVersion(); break;
  case '-v': cmdVersion(); break;
  case 'help': cmdHelp(); break;
  default:
    console.log(`未知命令: ${command}`);
    cmdHelp();
}
