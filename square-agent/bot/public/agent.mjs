#!/usr/bin/env node
/**
 * Square Agent v0.3.0
 *
 * 跨平台纯 API 发布器 — 不再依赖 Chrome/AppleScript/CDP。
 * 通过币安广场 OpenAPI 直接发帖（文本 + 图片 + 长文）。
 * 支持 Linux / Windows(WSL) / macOS。
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { hostname, homedir } from 'os';
import { join } from 'path';
import { checkPublishLimit, generateWaitMs } from './humanize.mjs';

// ============ 配置 ============
const SERVER_URL = process.env.SERVER_URL || 'https://api.square-agent.com';
const API_KEY = process.env.API_KEY || 'binsquare-dev-key-2026';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30000');
const AGENT_TOKEN = process.env.AGENT_TOKEN;

if (!AGENT_TOKEN) {
  console.error('❌ 请设置 AGENT_TOKEN');
  console.error('   运行: AGENT_TOKEN=bsq_xxxxx node agent.mjs');
  process.exit(1);
}

// ============ 币安广场 OpenAPI ============
const API_ENDPOINT = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi';
const API_ENDPOINT_V2 = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi';
const MAX_IMAGES = 4;

/**
 * 读取 OpenAPI Key（仅本地，不从服务器获取）
 * 顺序：env BINANCE_SQUARE_OPENAPI_KEY → ~/.square-agent/binance-api-key
 */
function getApiKey() {
  const env = process.env.BINANCE_SQUARE_OPENAPI_KEY || process.env.BINANCE_SQUARE_API_KEY;
  if (env?.trim()) return env.trim();
  const configFile = join(homedir(), '.square-agent', 'binance-api-key');
  if (existsSync(configFile)) {
    const v = readFileSync(configFile, 'utf8').trim();
    if (v) return v;
  }
  return null;
}

/**
 * 标签补全：确保 $BTC $ETH #BTC #ETH 存在，⚠️ 前插入
 */
function ensureTags(content) {
  const tags = [];
  if (!/\$BTC\b/i.test(content)) tags.push('$BTC');
  if (!/\$ETH\b/i.test(content)) tags.push('$ETH');
  if (!/#BTC\b/i.test(content)) tags.push('#BTC');
  if (!/#ETH\b/i.test(content)) tags.push('#ETH');
  if (tags.length === 0) return content;
  if (content.includes('⚠️')) {
    return content.replace(/⚠️([^]*)$/, tags.join(' ') + '\n\n⚠️$1');
  }
  return content + '\n\n' + tags.join(' ');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 上传单张图片：下载到 tmp → presigned URL → S3 PUT → 轮询 imageStatus
 */
async function uploadSingleImage(imageUrl, apiKey) {
  const tmpRoot = process.env.SQUARE_AGENT_TMP_DIR || join(homedir(), '.square-agent', 'tmp');
  if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true, mode: 0o755 });

  const ext = imageUrl.split('?')[0].split('.').pop().toLowerCase();
  const tmpPath = join(tmpRoot, `sa-img-${Date.now()}.${ext || 'jpg'}`);
  try {
    execSync(`curl -sL --max-time 15 -o "${tmpPath}" "${imageUrl}"`, { timeout: 20000 });
    if (!existsSync(tmpPath)) return null;

    const imageName = tmpPath.split('/').pop();
    const ct = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';

    // 1. Presigned URL
    const preRes = await fetch(`${API_ENDPOINT_V2}/image/presignedUrl`, {
      method: 'POST',
      headers: { 'X-Square-OpenAPI-Key': apiKey, 'Content-Type': 'application/json', clienttype: 'binanceSkill' },
      body: JSON.stringify({ imageName }),
    });
    const preJson = await preRes.json();
    if (String(preJson.code) !== '000000') return null;

    const { presignedUrl, fileTicket } = preJson.data;

    // 2. Upload to S3
    const imgBuf = readFileSync(tmpPath);
    await fetch(presignedUrl, { method: 'PUT', headers: { 'Content-Type': ct }, body: imgBuf });

    // 3. Poll status
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const sRes = await fetch(`${API_ENDPOINT_V2}/image/imageStatus`, {
        method: 'POST',
        headers: { 'X-Square-OpenAPI-Key': apiKey, 'Content-Type': 'application/json', clienttype: 'binanceSkill' },
        body: JSON.stringify({ fileTicket }),
      });
      const sJson = await sRes.json();
      if (String(sJson.code) === '000000' && sJson.data?.status === 1) {
        return sJson.data.imageUrl;
      }
      if (String(sJson.code) === '000000' && sJson.data?.status === 2) break;
    }
    return null;
  } catch {
    return null;
  } finally {
    try { execSync(`rm -f "${tmpPath}"`, { timeout: 2000 }); } catch {}
  }
}

async function uploadImages(imageUrls, apiKey) {
  const uploaded = [];
  for (const url of (imageUrls || []).slice(0, MAX_IMAGES)) {
    const r = await uploadSingleImage(url, apiKey);
    if (r) uploaded.push(r);
  }
  return uploaded.length > 0 ? uploaded : undefined;
}

/**
 * 纯 API 发布 — 复用 src/connectors/binance-square.mjs 的验证逻辑
 */
async function publishViaApi(post) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { success: false, error: '未配置币安广场 OpenAPI Key', steps: [] };
  }

  const t0 = Date.now();
  const steps = [];
  const content = ensureTags(post.content || '');
  const contentType = post.title ? 2 : 1;
  const body = { contentType, bodyTextOnly: content };
  if (post.title) body.title = post.title;

  // 图片上传
  if (post.images?.length) {
    const imgList = await uploadImages(post.images, apiKey);
    if (imgList) body.imageList = imgList;
    steps.push({ step: 'upload_images', ok: true, detail: `${imgList?.length || 0} images` });
  }

  // 发布（最多重试 5 次）
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${API_ENDPOINT}/content/add`, {
        method: 'POST',
        headers: {
          'X-Square-OpenAPI-Key': apiKey,
          'Content-Type': 'application/json',
          clienttype: 'binanceSkill',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 504) {
        steps.push({ step: 'publish', ok: true, detail: '504 timeout but likely posted' });
        return { success: true, postId: null, postUrl: null, steps, duration_ms: Date.now() - t0 };
      }

      const json = await res.json();
      if (String(json.code) === '000000') {
        const postId = String(json.data?.id || '');
        const postUrl = postId ? `https://www.binance.com/square/post/${postId}` : null;
        steps.push({ step: 'publish', ok: true, detail: `postId=${postId}` });
        return { success: true, postId, postUrl, steps, duration_ms: Date.now() - t0 };
      }

      // 可重试错误码
      if (String(json.code) === '10004' && attempt < 5) {
        steps.push({ step: `publish_retry_${attempt}`, ok: false, detail: `${json.code}: ${json.message || ''}` });
        await sleep(3000 * attempt);
        continue;
      }
      steps.push({ step: 'publish', ok: false, detail: `${json.code}: ${json.message || 'unknown'}` });
      return { success: false, error: `${json.code}: ${json.message || 'unknown'}`, steps, duration_ms: Date.now() - t0 };
    } catch (e) {
      if (attempt < 5) {
        steps.push({ step: `publish_retry_${attempt}`, ok: false, detail: e.message });
        await sleep(3000 * attempt);
        continue;
      }
      return { success: false, error: e.message, steps, duration_ms: Date.now() - t0 };
    }
  }
  return { success: false, error: 'max retries exceeded', steps, duration_ms: Date.now() - t0 };
}

// ============ 日志 ============
const LOG_DIR = process.env.SQUARE_AGENT_PUBLISHER_LOG_DIR
  || join(homedir(), '.square-agent', 'publisher', 'logs');

function writeLog(task, result) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logFile = join(LOG_DIR, `${new Date().toISOString().split('T')[0]}.jsonl`);
  const entry = {
    ts: new Date().toISOString(),
    task_id: task.id,
    type: task.type,
    success: result.success,
    error: result.error,
    duration_ms: result.duration_ms,
    steps: result.steps?.length || 0,
  };
  appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

// ============ 服务器 API ============
async function api(path, options = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API ${res.status}`);
  return data;
}

// ============ 注册 / 心跳 / 拉取 / 回传 ============
let agentId = '';
let userId = '';
const publishTimestamps = []; // 发布时间戳（内存维护，用于速率限制）

async function register() {
  const data = await api('/api/agent/register', {
    method: 'POST',
    body: JSON.stringify({ token: AGENT_TOKEN, hostname: hostname(), platform: process.platform }),
  });
  agentId = data.agentId;
  userId = data.user.id;
  console.log(`✅ 已连接 | 币安 UID: ${data.user.binance_uid} | 风格: ${data.user.style}`);
}

async function heartbeat() {
  if (!agentId) return;
  try { await api('/api/agent/heartbeat', { method: 'POST', body: JSON.stringify({ agentId }) }); } catch {}
}

async function fetchPending() {
  return (await api(`/api/content/pending?userId=${userId}`)).posts;
}

async function reportStatus(postId, status, binancePostId, error, steps) {
  await api(`/api/content/${postId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status, binancePostId, error }),
  });
  try {
    await api('/api/agent/log', {
      method: 'POST',
      body: JSON.stringify({ agentId, postId, log: { status, error: error || null, steps } }),
    });
  } catch {}
}

// ============ 自动更新 ============
const AGENT_PATH = new URL(import.meta.url).pathname;

async function checkUpdate() {
  try {
    const res = await fetch(`${SERVER_URL}/api/agent/version`, { headers: { 'X-API-Key': API_KEY } });
    if (!res.ok) return null;
    return await res.json(); // { version, hash, size }
  } catch {
    return null;
  }
}

async function selfUpdate() {
  const info = await checkUpdate();
  if (!info) return false;
  // 服务端不返回 size 时跳过（避免 NaN 比较误触发自我覆盖）
  if (!info.size) return false;
  const stat = existsSync(AGENT_PATH) ? readFileSync(AGENT_PATH).length : 0;
  if (Math.abs(info.size - stat) < 10) return false;
  console.log(`🔄 发现新版本 (remote: ${info.size}B, local: ${stat}B), 更新中...`);
  const res = await fetch(`${SERVER_URL}/download/agent`);
  if (!res.ok) return false;
  const newCode = await res.text();
  writeFileSync(AGENT_PATH, newCode);
  console.log(`✅ 已更新 (${newCode.length} bytes), 重启中...`);
  process.exit(0);
}

// ============ 主循环 ============
async function main() {
  console.log('🤖 Square Agent v0.3.0 (API-only)');
  console.log(`📡 Server: ${SERVER_URL}`);

  // 检查 API Key（无 Key 直接退出）
  if (!getApiKey()) {
    console.error('❌ 未检测到币安广场 OpenAPI Key');
    console.error('   请配置: echo "YOUR_KEY" > ~/.square-agent/binance-api-key');
    console.error('   或设置环境变量: export BINANCE_SQUARE_OPENAPI_KEY=YOUR_KEY');
    console.error('   获取地址: https://www.binance.com/zh-CN/square/creator-center/home → 创建 API');
    process.exit(1);
  }

  await selfUpdate();

  try {
    await register();
  } catch (err) {
    console.error(`❌ 注册失败: ${err.message}`);
    process.exit(1);
  }

  setInterval(heartbeat, 60000);
  console.log(`🔄 轮询中 (间隔 ${POLL_INTERVAL / 1000}s)...\n`);

  let pollCount = 0;
  while (true) {
    pollCount++;
    try {
      const posts = await fetchPending();
      if (posts && posts.length > 0) {
        console.log(`\n[${ts()}] 📨 收到 ${posts.length} 条待发布内容`);
        for (const post of posts) {
          // 速率限制：每日上限 / 每小时上限 / 最短间隔
          const limit = checkPublishLimit(publishTimestamps);
          if (!limit.allowed) {
            console.log(`[${ts()}] ⏸️ ${limit.reason}（待发 ${posts.length} 篇）`);
            break;
          }
          console.log(`[${ts()}] 📝 发布中 #${post.id} (${post.type || 'post'})...`);
          const result = await publishViaApi(post);
          if (result.success) {
            publishTimestamps.push({ ts: Date.now(), waitMs: generateWaitMs() });
            console.log(`[${ts()}] ✅ #${post.id} 发布成功 (${result.duration_ms}ms${result.postUrl ? ' ' + result.postUrl : ''})`);
            await reportStatus(post.id, 'published', result.postId, null, result.steps);
          } else {
            console.error(`[${ts()}] ❌ #${post.id} 发布失败: ${result.error}`);
            await reportStatus(post.id, 'failed', undefined, result.error, result.steps);
          }
          writeLog(post, result);
        }
      } else {
        if (pollCount % 20 === 0) {
          console.log(`[${ts()}] 💓 idle (${pollCount} polls)`);
        }
      }
    } catch (err) {
      console.error(`[${ts()}] ⚠️ Error: ${err.message}`);
    }
    await sleep(POLL_INTERVAL);
  }
}

main();
