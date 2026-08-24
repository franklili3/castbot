#!/usr/bin/env node
/**
 * CryptoQClaw Agent — 跨平台纯 API 发布器
 *
 * 不再依赖 Chrome/AppleScript/CDP。通过币安广场 OpenAPI 直接发帖
 * （文本 + 图片 + 长文）。支持 Linux / Windows(WSL) / macOS。
 *
 * 版本号统一由同目录 package.json 的 version 字段维护（CLI 工具与
 * publisher 引擎共用一个版本，避免历史遗留的双版本号困惑）。
 */

import { execSync, spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync, renameSync, watch } from 'fs';
import { hostname, homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
// 速率限制（日上限+最短间隔）已迁至 server 端 /api/content/pending；agent 只保留熔断保护。
// Proxy: Node 原生 fetch 不读 HTTPS_PROXY 环境变量（长期 known issue），必须显式注入 undici
// ProxyAgent。用动态 import 避免无 proxy 时加载 undici（undici 8.x 需要 Node 22+）。
//
// 热重载：用户在 web 面板改了 config.proxy 后，fs.watch 触发 applyProxyFromConfig 重新
// setGlobalDispatcher——agent 不需要 stop/start。config.proxy 优先于 env，因为 env 是
// cli.mjs 启动时注入的快照，运行时不变；用户改的是 config.json。
const PROXY_CONFIG_FILE = join(homedir(), '.lilibtc-bot', 'config.json');
let _currentProxyUrl = undefined;  // 记录当前在用的代理 URL，避免重复 setGlobalDispatcher（首次必须设）

async function applyProxyFromConfig() {
  let url = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
  try {
    if (existsSync(PROXY_CONFIG_FILE)) {
      const cfg = JSON.parse(readFileSync(PROXY_CONFIG_FILE, 'utf8'));
      if (cfg && typeof cfg === 'object' && 'proxy' in cfg) {
        // config.proxy 显式存在（含空字符串）→ 覆盖 env
        if (typeof cfg.proxy === 'string') url = cfg.proxy;
      }
    }
  } catch (e) {
    console.warn(`⚠️ 读 config.proxy 失败: ${e.message}（沿用 env HTTPS_PROXY）`);
  }

  if (url === _currentProxyUrl) return;  // 没变就不重设
  _currentProxyUrl = url;

  try {
    const { ProxyAgent, Agent, setGlobalDispatcher } = await import('undici');
    if (url) {
      setGlobalDispatcher(new ProxyAgent(url));
      console.log(`🔗 代理已生效: ${url}（undici ProxyAgent 全局注入）`);
    } else {
      setGlobalDispatcher(new Agent());
      console.log(`🔗 代理已清除（直连模式，undici Agent）`);
    }
  } catch (e) {
    console.warn(`⚠️ 代理注入失败 (url=${url || '空'}): ${e.message}. 原生 fetch 将直连，可能失败。`);
  }
}

await applyProxyFromConfig();

// fs.watch config.json：debounce 200ms（Windows 上一次 writeFileSync 可能触发 2 次 event）
let _proxyReloadTimer = null;
try {
  watch(PROXY_CONFIG_FILE, () => {
    if (_proxyReloadTimer) clearTimeout(_proxyReloadTimer);
    _proxyReloadTimer = setTimeout(() => {
      _proxyReloadTimer = null;
      applyProxyFromConfig().catch(e => console.warn(`⚠️ 代理热重载失败: ${e.message}`));
    }, 200);
  });
} catch (e) {
  // config.json 还没创建（用户没登录过）— 启动时不报错，env 路径已兜底
  console.warn(`⚠️ 无法 watch ${PROXY_CONFIG_FILE}: ${e.message}（首次保存代理后请重启 agent）`);
}

// ============ 配置 ============
const SERVER_URL = process.env.SERVER_URL || process.env.LILIBTC_SERVER_URL || 'https://api.lilibtc.com';
const API_KEY = process.env.API_KEY || '';  // §2.1 不硬编码；production 由 EnvironmentFile(.env) 提供
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30000');
const AGENT_TOKEN = process.env.CRYPTOQCLAW_AGENT_TOKEN || process.env.AGENT_TOKEN;

if (!AGENT_TOKEN) {
  console.error('❌ 请设置 CRYPTOQCLAW_AGENT_TOKEN（兼容旧 AGENT_TOKEN）');
  console.error('   运行: CRYPTOQCLAW_AGENT_TOKEN=bsq_xxxxx node agent.mjs');
  process.exit(1);
}

// ============ 币安广场 OpenAPI ============
const API_ENDPOINT = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi';
const API_ENDPOINT_V2 = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi';
const MAX_IMAGES = 4;

/**
 * 读取 OpenAPI Key（仅本地，不从服务器获取）
 * 顺序：env BINANCE_SQUARE_OPENAPI_KEY → ~/.lilibtc-bot/binance-api-key → ~/.cryptoqclaw/binance-api-key（旧路径回退）
 */
function getApiKey() {
  const env = process.env.BINANCE_SQUARE_OPENAPI_KEY || process.env.BINANCE_SQUARE_API_KEY;
  if (env?.trim()) return env.trim();
  for (const configFile of [
    join(homedir(), '.lilibtc-bot', 'binance-api-key'),
    join(homedir(), '.cryptoqclaw', 'binance-api-key'),
  ]) {
    if (existsSync(configFile)) {
      const v = readFileSync(configFile, 'utf8').trim();
      if (v) return v;
    }
  }
  return null;
}

/**
 * 去除 markdown 标题符号（## / ### 等），币安广场 API 会把 # 开头当作 hashtag 计数
 * 保留 #BTC 等真实话题标签（后面紧跟字母/中文）
 */
function stripMdHeaders(content) {
  return content.replace(/^#{1,6}\s+(?=[^#\s])/gm, '');
}

/**
 * 标签补全：根据帖子内容+topics生成币种和新闻类别标签
 * 币种标签：从内容提取 $TICKER / #TICKER
 * 类别标签：从 post.topics 提取（如 地缘政治、ETF、SEC 等）
 * 20% 概率不加额外标签
 */
function ensureTags(content, topics = []) {
  // 统计已有的 cashtag 和 hashtag
  const existingCash = (content.match(/\$[A-Za-z]{2,10}/g) || []).map(s => s.toUpperCase());
  const existingHash = (content.match(/#[A-Za-z\u4e00-\u9fff]+/g) || []).length;
  const hashSlots = Math.max(0, 3 - existingHash);
  if (hashSlots === 0) return content;

  // 从内容中提取币种
  const coinsFound = new Set();
  existingCash.forEach(c => coinsFound.add(c.slice(1)));
  const KNOWN_COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TON'];
  for (const coin of KNOWN_COINS) {
    const re = new RegExp(`\\b${coin}\\b`, 'i');
    if (re.test(content)) coinsFound.add(coin);
  }
  if (/比特币/.test(content)) coinsFound.add('BTC');
  if (/以太坊|以太幣/.test(content)) coinsFound.add('ETH');
  if (/币安币/.test(content)) coinsFound.add('BNB');
  if (/索拉纳/.test(content)) coinsFound.add('SOL');

  // 构建标签候选
  const candidates = [];
  // 币种标签
  for (const coin of coinsFound) {
    if (!existingCash.includes('$' + coin)) candidates.push('$' + coin);
    if (!new RegExp('#' + coin + '\\b', 'i').test(content)) candidates.push('#' + coin);
  }
  // 新闻类别标签（从 topics）
  for (const t of topics) {
    // topics 里币种大写代码跳过（已上面处理过）
    if (/^[A-Z]{2,5}$/.test(t)) continue;
    // 中文类别标签，加 # 前缀
    const tag = '#' + t;
    if (!content.includes(tag)) candidates.push(tag);
  }

  if (candidates.length === 0) return content;

  // 20% 概率不加额外标签
  if (Math.random() < 0.2) return content;

  // 随机选 min(hashSlots, 2-3) 个
  const pickCount = Math.min(hashSlots, 2 + Math.floor(Math.random() * 2), candidates.length);
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, pickCount);

  if (picked.length === 0) return content;
  if (content.includes('⚠️')) {
    return content.replace(/⚠️([^]*)$/, picked.join(' ') + '\n\n⚠️$1');
  }
  return content + '\n\n' + picked.join(' ');
}

/**
 * hashtag 硬裁到币安限额内（默认 3 个）。
 * 防御性兜底：stripMdHeaders 已去 ## 标题、ensureTags 控新增数量，
 * 但内容自带超额 #标签时仍触发 220094 整篇被拒——发布前裁掉多余的。
 * hashtag 口径与 ensureTags 一致：# 后跟字母/中文。
 */
function capHashtags(content, max = 3) {
  const tagRe = /#[A-Za-z一-鿿]+/g;
  if ((content.match(tagRe) || []).length <= max) return content;
  let kept = 0;
  const trimmed = content.replace(tagRe, (m) => (kept++ < max ? m : ''));
  return trimmed.replace(/ {2,}/g, ' ').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * image_urls 解析成数组：兼容 JSON 数组字符串 / 单 URL 字符串 / 已是数组。
 * （DB 里旧数据是单 URL 字符串；Phase 2 后会是 JSON 数组字符串）
 */
function parseImageUrls(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try { return JSON.parse(s).filter(Boolean); } catch { return []; }
    }
    return s ? [s] : [];
  }
  return [];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 上传单张图片到币安广场 S3
 *
 * 【技术流程】
 * 1. 下载图片：从 URL 下载到本地临时目录（支持超时控制）
 * 2. 获取 Presigned URL：调用币安 API 获取 AWS S3 上传地址
 * 3. 上传到 S3：PUT presigned URL，直接上传图片数据
 * 4. 轮询状态：每 2 秒检查一次，最多 10 次（20 秒）
 *
 * 【错误处理】
 * - 下载失败：返回 null（主流程会跳过该图片，尝试下一张）
 * - API 失败：返回 null（code !== '000000'）
 * - 上传超时：返回 null（S3 上传超时）
 * - 处理失败：返回 null（status = 2 表示处理失败）
 *
 * 【资源管理】
 * - 临时文件：下载后存放在 ~/.lilibtc-bot/tmp/
 * - 清理策略：finally 块确保删除临时文件
 * - 权限设置：tmp 目录 755，避免权限问题
 *
 * @param {string} imageUrl - 图片 URL（支持 http/https）
 * @param {string} apiKey - 币安广场 OpenAPI Key
 * @returns {Promise<string|null>} S3 图片 URL（成功）/ null（失败）
 */
async function uploadSingleImage(imageUrl, apiKey) {
  // 临时目录：支持环境变量覆盖（便于测试）
  const tmpRoot = (process.env.CRYPTOQCLAW_TMP_DIR || process.env.SQUARE_AGENT_TMP_DIR) || join(homedir(), '.lilibtc-bot', 'tmp');
  if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true, mode: 0o755 });

  // 提取文件扩展名（用于 Content-Type 判断）
  const ext = imageUrl.split('?')[0].split('.').pop().toLowerCase();
  const tmpPath = join(tmpRoot, `sa-img-${Date.now()}.${ext || 'jpg'}`);

  try {
    // 1. 下载图片到本地（curl -sL：静默模式 + 跟随重定向）
    execSync(`curl -sL --max-time 15 -o "${tmpPath}" "${imageUrl}"`, { timeout: 20000 });
    if (!existsSync(tmpPath)) return null;

    // 2. 获取 presigned URL（币安 API 返回 AWS S3 上传地址）
    const imageName = tmpPath.split('/').pop();
    const ct = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';

    const preRes = await fetch(`${API_ENDPOINT_V2}/image/presignedUrl`, {
      method: 'POST',
      headers: { 'X-Square-OpenAPI-Key': apiKey, 'Content-Type': 'application/json', clienttype: 'binanceSkill' },
      body: JSON.stringify({ imageName }),
    });
    const preJson = await preRes.json();
    if (String(preJson.code) !== '000000') return null;  // API 失败

    const { presignedUrl, fileTicket } = preJson.data;

    // 3. 上传到 S3（PUT presigned URL，直接上传二进制数据）
    const imgBuf = readFileSync(tmpPath);
    await fetch(presignedUrl, { method: 'PUT', headers: { 'Content-Type': ct }, body: imgBuf });

    // 4. 轮询处理状态（币安需要时间处理图片，最多等 20 秒）
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const sRes = await fetch(`${API_ENDPOINT_V2}/image/imageStatus`, {
        method: 'POST',
        headers: { 'X-Square-OpenAPI-Key': apiKey, 'Content-Type': 'application/json', clienttype: 'binanceSkill' },
        body: JSON.stringify({ fileTicket }),
      });
      const sJson = await sRes.json();
      // status = 1 表示成功，返回 imageUrl
      if (String(sJson.code) === '000000' && sJson.data?.status === 1) {
        return sJson.data.imageUrl;
      }
      // status = 2 表示失败，停止轮询
      if (String(sJson.code) === '000000' && sJson.data?.status === 2) break;
    }
    return null;  // 超时或失败
  } catch {
    return null;  // 任何异常都返回 null
  } finally {
    // 清理临时文件（跨平台：unlinkSync 在 Win/Linux/macOS 都有，execSync rm -f 在 Windows 不存在）
    try { unlinkSync(tmpPath); } catch {}
  }
}

async function uploadImages(imageUrls, apiKey) {
  const uploaded = [];
  for (const url of (imageUrls || [])) {
    if (uploaded.length >= MAX_IMAGES) break;   // 凑满 4 张成功就停
    const r = await uploadSingleImage(url, apiKey);
    if (r) uploaded.push(r);                      // 失败自动跳过，试下一张候选（冗余兜底）
  }
  return uploaded.length > 0 ? uploaded : undefined;
}

/**
 * 纯 API 发布到币安广场 — 通过 OpenAPI 直接发帖
 *
 * 【关键优势】
 * - 跨平台支持：Linux/Windows/macOS，无需 Chrome 浏览器
 * - 高性能：纯 HTTP 请求，比浏览器自动化快 10 倍+
 * - 稳定性：不依赖浏览器状态，无 CDP/AppleScript 故障点
 * - 资源效率：内存占用 <50MB，CPU 占用极低
 *
 * 【发布流程】
 * 1. 内容预处理：去除 Markdown 标题符号、补全标签、裁剪 hashtag
 * 2. 图片上传：下载到 tmp → 获取 presigned URL → 上传到 AWS S3 → 轮询状态
 * 3. API 发布：调用币安 OpenAPI content/add 接口
 * 4. 错误重试：支持 5 次重试，图片失败时自动降级为纯文本
 *
 * 【错误码处理】
 * - 000000: 成功，返回 postId 和 postUrl
 * - 10004: 临时错误（网络/服务端），可重试
 * - 10002: 图片上传失败，自动去图重试纯文本
 * - 220009: 日发帖额度耗尽，通知 bot 并停止发布
 * - 504: 超时但很可能发布成功（币安 API 常见问题）
 *
 * 【技术细节】
 * - contentType: 1=纯文本, 2=长文（带 title）
 * - hashtag 限制：默认 3 个，超过会被币安拒绝（220094）
 * - 图片限制：最多 4 张，格式支持 jpg/png/gif/webp
 * - 重试策略：指数退避（3s/6s/9s/12s/15s）
 *
 * @param {Object} post - 待发布的帖子对象
 * @param {string} post.content - 帖子内容（支持 Markdown）
 * @param {string[]} post.topics - 话题标签（如 ['BTC', 'ETF']）
 * @param {string} post.title - 可选的长文标题
 * @param {string} post.image_urls - 图片 URL（JSON 数组字符串或单 URL）
 * @returns {Promise<Object>} 发布结果
 * @returns {boolean} returns.success - 是否成功
 * @returns {string|null} returns.postId - 币安广场帖子 ID
 * @returns {string|null} returns.postUrl - 帖子 URL
 * @returns {Object[]} returns.steps - 执行步骤记录（用于调试）
 * @returns {number} returns.duration_ms - 总耗时（毫秒）
 * @returns {string|null} returns.error - 错误信息（失败时）
 */
async function publishViaApi(post) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { success: false, error: '未配置币安广场 OpenAPI Key', steps: [] };
  }

  const t0 = Date.now();
  const steps = [];

  // 内容预处理：去除 Markdown 标题 + 补全标签 + 裁剪 hashtag
  const content = capHashtags(ensureTags(stripMdHeaders(post.content || ''), post.topics || []));

  // contentType 决定是否为长文（2=带 title 的长文, 1=普通帖子）
  const contentType = post.title ? 2 : 1;
  const body = { contentType, bodyTextOnly: content };
  if (post.title) body.title = post.title;

  // 图片上传流程
  const _imgs = parseImageUrls(post.image_urls);
  if (_imgs.length) {
    const imgList = await uploadImages(_imgs, apiKey);
    if (imgList) body.imageList = imgList;
    steps.push({ step: 'upload_images', ok: true, detail: `${imgList?.length || 0} images` });
  }

  // 发布主逻辑：最多重试 5 次
  // 策略：
  // - 10004 错误：指数退避重试（3s/6s/9s/12s/15s）
  // - 图片相关错误：自动去图重试一次纯文本（避免整篇被拒）
  // - 504 超时：视为成功（币安 API 常见问题，实际已发布）
  let textOnlyRetry = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${API_ENDPOINT}/content/add`, {
        method: 'POST',
        headers: {
          'X-Square-OpenAPI-Key': apiKey,      // OpenAPI 认证（从币安创作者中心获取）
          'Content-Type': 'application/json',
          clienttype: 'binanceSkill',          // 客户端类型（固定值）
        },
        body: JSON.stringify(body),
      });

      // 504 Gateway Timeout：币安 API 常见问题，实际已发布成功
      if (res.status === 504) {
        steps.push({ step: 'publish', ok: true, detail: '504 timeout but likely posted' });
        return { success: true, postId: null, postUrl: null, steps, duration_ms: Date.now() - t0 };
      }

      const json = await res.json();

      // 000000 = 成功，返回帖子 ID 和 URL
      if (String(json.code) === '000000') {
        const postId = String(json.data?.id || '');
        const postUrl = postId ? `https://www.binance.com/square/post/${postId}` : null;
        steps.push({ step: 'publish', ok: true, detail: `postId=${postId}` });
        return { success: true, postId, postUrl, steps, duration_ms: Date.now() - t0 };
      }

      // 10004 = 临时错误（网络/服务端），可重试
      if (String(json.code) === '10004' && attempt < 5) {
        steps.push({ step: `publish_retry_${attempt}`, ok: false, detail: `${json.code}: ${json.message || ''}` });
        await sleep(3000 * attempt);  // 指数退避
        continue;
      }

      // 图片相关失败（10002 / Upload failed）→ 去图重试一次纯文本
      // 避免因图片问题导致整篇优质内容被拒
      const _imgErr = String(json.code) === '10002' || /upload/i.test(json.message || '');
      if (_imgErr && body.imageList && !textOnlyRetry) {
        textOnlyRetry = true;
        steps.push({ step: 'drop_images_retry', ok: false, detail: `${json.code}: ${json.message || ''}` });
        delete body.imageList;
        await sleep(2000);
        continue;
      }

      // 其他错误：标记失败并返回错误信息
      steps.push({ step: 'publish', ok: false, detail: `${json.code}: ${json.message || 'unknown'}` });
      return { success: false, error: `${json.code}: ${json.message || 'unknown'}`, steps, duration_ms: Date.now() - t0 };
    } catch (e) {
      // 网络异常：重试
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
// 与 cli.mjs LOG_DIR 保持一致（~/.lilibtc-bot/publisher/logs）。
// v1.0.16 之前 agent 写在 ~/.cryptoqclaw/publisher/logs，首次启动迁移老目录。
const LOG_DIR = (process.env.CRYPTOQCLAW_PUBLISHER_LOG_DIR || process.env.SQUARE_AGENT_PUBLISHER_LOG_DIR)
  || join(homedir(), '.lilibtc-bot', 'publisher', 'logs');
{
  const legacyLogDir = join(homedir(), '.cryptoqclaw', 'publisher', 'logs');
  if (!existsSync(LOG_DIR) && existsSync(legacyLogDir)) {
    try {
      mkdirSync(join(homedir(), '.lilibtc-bot', 'publisher'), { recursive: true });
      renameSync(legacyLogDir, LOG_DIR);
    } catch {}
  }
}

function writeLog(task, result) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logFile = join(LOG_DIR, `${new Date().toISOString().split('T')[0]}.jsonl`);
  const entry = {
    ts: new Date().toISOString(),
    task_id: task.id,
    type: task.type,
    success: result.success,
    error: result.error,
    post_url: result.postUrl,
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
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [2000, 5000, 10000];
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${SERVER_URL}${path}`, {
        ...options,
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
          ...(options.headers || {}),
        },
      });
      // 先读 text 再 JSON.parse：CF 源站不可达时返回 HTML 错误页（522 等），
      // 直接 await res.json() 会抛 SyntaxError 掩盖真实 HTTP 状态码。
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch {
        const hint = [520, 521, 522, 523, 524].includes(res.status)
          ? '（CF 5xx：源站不可达，检查 VPS 443 入向 / 服务是否挂了）'
          : '';
        throw new Error(`HTTP ${res.status}${hint} 非 JSON 响应：${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(data.error || `API ${res.status}`);
      return data;
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }
  throw lastError;
}

// ============ 注册 / 心跳 / 拉取 / 回传 ============
let agentId = '';
let userId = '';

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
// 注意：必须用 fileURLToPath，不能用 new URL().pathname。Windows 上 file: URL 的
// pathname 是 /C:/Users/... 形式，readFileSync 在某些 Node 版本/盘符下会解析失败
// → package.json 读不到 → 版本号 fallback 成 0.0.0-unknown（用户实际遇到的 bug）。
const AGENT_PATH = fileURLToPath(import.meta.url);

// 版本号：从同目录 package.json 动态读取（CLI 工具与 publisher 引擎共用）。
// agent.mjs 与 package.json 在 tgz 内同目录，npm-global install 后也保持同目录。
const PKG_PATH = join(resolve(AGENT_PATH, '..'), 'package.json');
let PUBLISHER_VERSION = '1.0.14';
try {
  PUBLISHER_VERSION = JSON.parse(readFileSync(PKG_PATH, 'utf8')).version || PUBLISHER_VERSION;
} catch {
  // package.json 不可读时降级，不阻塞启动（banner 仍会打印，便于诊断）
}

// v1.0.25+ 更新主通道：npm registry（中国大陆可达性最好）。
// LILIBTC_UPDATE_CHANNEL=github 切 GitHub Releases（需代理）。
// 旧 server 通道（/api/agent/version + /download/agent）保留给存量排障：
// 设 LILIBTC_UPDATE_BASE（如 https://api.lilibtc.com）即切回 server 通道。
const GITHUB_REPO = 'franklili3/lilibtc-bot';
const UPDATE_BASE_OVERRIDE = process.env.LILIBTC_UPDATE_BASE || '';
const UPDATE_CHANNEL = (process.env.LILIBTC_UPDATE_CHANNEL || 'npm').toLowerCase();
const NPM_REGISTRY = (process.env.LILIBTC_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const NPM_PACKAGE = 'lilibtc-bot';

async function checkUpdate() {
  try {
    if (UPDATE_BASE_OVERRIDE) {
      const res = await fetch(`${SERVER_URL}/api/agent/version`, { headers: { 'X-API-Key': API_KEY } });
      if (!res.ok) return null;
      return await res.json(); // { version, hash, size }
    }
    if (UPDATE_CHANNEL === 'github') {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'User-Agent': 'lilibtc-bot', 'Accept': 'application/vnd.github+json' },
      });
      if (!res.ok) return null;
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/, '');
      if (!version) return null;
      const asset = (rel.assets || []).find(a => a.name === `lilibtc-bot-v${version}.tgz`);
      if (!asset?.browser_download_url) return null;
      return { version, tarballUrl: asset.browser_download_url };
    }
    // 默认 npm 通道：registry 元数据比对版本，实际升级委托 cli.mjs update
    const res = await fetch(`${NPM_REGISTRY}/${NPM_PACKAGE}/latest`);
    if (!res.ok) return null;
    const meta = await res.json();
    if (!meta?.version) return null;
    return { version: meta.version };
  } catch {
    return null;
  }
}

/** 简易 semver 比较：remote > local 返回 true */
function isNewerVersion(remote, local) {
  const nums = v => String(v).replace(/^v/, '').split('.').map(x => parseInt(x, 10) || 0);
  const a = nums(remote), b = nums(local);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function selfUpdate() {
  const info = await checkUpdate();
  if (!info) return false;
  if (UPDATE_BASE_OVERRIDE) {
    // 旧 server 通道：按文件 size 比对（避免 NaN）
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
  // npm（默认）/ GitHub 通道：semver 比对；有新版时委托同目录 cli.mjs 的 update
  // 命令完成 tarball 下载、node --check、备份、daemon 重启——agent 只负责检测与触发。
  if (!isNewerVersion(info.version, PUBLISHER_VERSION)) return false;
  console.log(`🔄 发现新版本 v${info.version}（当前 v${PUBLISHER_VERSION}），委托 lilibtc-bot update 升级...`);
  const CLI_PATH = join(resolve(AGENT_PATH, '..'), 'cli.mjs');
  if (!existsSync(CLI_PATH)) {
    console.warn('⚠️ 未找到同目录 cli.mjs，请手动运行: lilibtc-bot update');
    return false;
  }
  const updateArgs = [CLI_PATH, 'update'];
  if (UPDATE_CHANNEL === 'github') updateArgs.push('--github');
  const child = spawn(process.execPath, updateArgs, { detached: true, stdio: 'ignore' });
  child.unref();
  process.exit(0);
}

// ============ PID Lockfile（防多实例） ============
const LOCK_FILE = join(homedir(), '.lilibtc-bot', 'publisher.lock');

/**
 * 判断 lockfile 中的 PID 是否真的是另一个 square-agent 实例。
 * 单纯 process.kill(pid,0) 只能确认 PID 存活，但 OS 回收 PID 后会复用给无关进程，
 * 导致 lockfile 误判为「另一实例正在运行」。这里在 Linux 上额外校验 /proc/<pid>/cmdline
 * 是否仍含 agent.mjs，macOS/Windows 无 /proc 时退化为仅检查存活。
 *
 * 返回:
 *   'alive-agent'  —— 是真实的另一 agent.mjs 实例
 *   'alive-other'  —— PID 存活但不是 agent.mjs（PID 复用），lockfile 视为过期
 *   'dead'         —— PID 已退出
 *   'unknown'      —— PID 非法 / 读不到 cmdline（保守视为存活）
 */
function checkLockOwner(pid) {
  if (!pid || Number.isNaN(pid)) return 'unknown';
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { return 'dead'; }
  if (!alive) return 'dead';
  // Linux: 通过 /proc 校验是否为 agent.mjs 进程
  if (process.platform === 'linux') {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (cmdline.includes('agent.mjs')) return 'alive-agent';
      return 'alive-other';
    } catch {
      // /proc 读不到（权限/竞态）——保守视为另一实例，避免重复启动
      return 'alive-agent';
    }
  }
  // macOS/Windows 无 /proc，保守视为另一实例
  return 'alive-agent';
}

function releaseLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pidStr = readFileSync(LOCK_FILE, 'utf8').trim();
      if (String(pidStr) === String(process.pid)) unlinkSync(LOCK_FILE);
    }
  } catch {}
}

function acquireLock() {
  // 确保 ~/.lilibtc-bot 目录存在
  const dir = join(homedir(), '.lilibtc-bot');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(LOCK_FILE)) {
    const pidStr = readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (pidStr && pid && !Number.isNaN(pid)) {
      const state = checkLockOwner(pid);
      if (state === 'alive-agent') {
        console.error(`❌ 另一实例正在运行 (PID ${pid})，本进程退出。`);
        console.error(`   lockfile: ${LOCK_FILE}`);
        process.exit(2);
      }
      // dead / alive-other（PID 复用）/ unknown 但解析失败 —— 一律接管
      const reason = state === 'alive-other' ? `PID ${pid} 已被无关进程占用（PID 复用）` : `PID ${pid} 已退出`;
      console.log(`⚠️ 发现过期 lockfile (${reason})，接管。`);
      try { unlinkSync(LOCK_FILE); } catch {}
    } else {
      // lockfile 内容非法，直接清理
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
  process.on('SIGINT',  () => { releaseLock(); process.exit(0); });
  process.on('exit', releaseLock);
}

// ============ 封号熔断 ============
const accountHealth = {
  consecutiveFailures: 0,
  circuitBreakUntil: 0,    // timestamp ms
  totalFailures24h: 0,
  failures24hResetAt: 0,
};

/**
 * 检查是否处于熔断状态
 */
function checkCircuitBreaker() {
  const now = Date.now();
  // 24h 失败计数重置
  if (now > accountHealth.failures24hResetAt) {
    accountHealth.totalFailures24h = 0;
    accountHealth.failures24hResetAt = now + 86400000;
  }
  // 熔断期
  if (now < accountHealth.circuitBreakUntil) {
    const waitMin = Math.round((accountHealth.circuitBreakUntil - now) / 60000);
    return { tripped: true, reason: `🔌 熔断中，${waitMin}分钟后恢复`, waitMs: accountHealth.circuitBreakUntil - now };
  }
  return { tripped: false };
}

/**
 * 发布结果反馈给熔断器
 */
function onPublishResult(success, error) {
  if (success) {
    accountHealth.consecutiveFailures = 0;
    return;
  }
  accountHealth.consecutiveFailures++;
  accountHealth.totalFailures24h++;

  const now = Date.now();
  // 连续 3 次失败 → 暂停 2h
  if (accountHealth.consecutiveFailures >= 3) {
    const pauseMs = 2 * 60 * 60 * 1000;
    accountHealth.circuitBreakUntil = now + pauseMs;
    accountHealth.consecutiveFailures = 0;
    console.error(`[${ts()}] 🔌 连续 ${accountHealth.consecutiveFailures} 次失败，触发熔断，暂停 2h`);
    console.error(`   最近错误: ${error || 'unknown'}`);
  }

  // 24h 内累计 10 次失败 → 暂停到次日 8:00 CST
  if (accountHealth.totalFailures24h >= 10) {
    const next8am = new Date(now);
    next8am.setUTCHours(0, 0, 0, 0); // UTC 00:00 = CST 08:00
    const wait = next8am.getTime() - now;
    if (wait > 0) {
      accountHealth.circuitBreakUntil = now + wait;
      console.error(`[${ts()}] 🔌 24h 内累计 ${accountHealth.totalFailures24h} 次失败，暂停到次日 08:00 CST`);
    }
  }
}

// ============ 主循环 ============
async function main() {
  acquireLock();
  console.log(`🤖 Lilibtc-bot v${PUBLISHER_VERSION} (API-only)`);
  console.log(`📡 Server: ${SERVER_URL}`);

  // 检查 API Key（无 Key 直接退出）
  if (!getApiKey()) {
    console.error('❌ 未检测到币安广场 OpenAPI Key');
    console.error('   请配置: lilibtc-bot set-binance-key YOUR_KEY');
    console.error('   或设置环境变量: $env:BINANCE_SQUARE_OPENAPI_KEY="YOUR_KEY"');
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
      // 熔断检查
      const breaker = checkCircuitBreaker();
      if (breaker.tripped) {
        if (pollCount % 20 === 0) console.log(`[${ts()}] ${breaker.reason}`);
        await sleep(Math.min(breaker.waitMs || POLL_INTERVAL, POLL_INTERVAL));
        continue;
      }

      const posts = await fetchPending();
      if (posts && posts.length > 0) {
        console.log(`\n[${ts()}] 📨 收到 ${posts.length} 条待发布内容`);
        for (const post of posts) {
          // 熔断检查（每篇发布前都检查）
          const bk = checkCircuitBreaker();
          if (bk.tripped) {
            console.log(`[${ts()}] ${bk.reason}`);
            break;
          }
          console.log(`[${ts()}] 📝 发布中 #${post.id} (${post.type || 'post'})...`);
          const result = await publishViaApi(post);
          console.log("[debug] steps=" + JSON.stringify(result.steps));
          if (result.success) {
            onPublishResult(true);
            console.log(`[${ts()}] ✅ #${post.id} 发布成功 (${result.duration_ms}ms${result.postUrl ? ' ' + result.postUrl : ''})`);
            await reportStatus(post.id, 'published', result.postId, null, result.steps);
          } else {
            onPublishResult(false, result.error);
            // 检测 Binance 日限额耗尽（220009）
            if (result.error && result.error.includes('220009')) {
              console.error(`[${ts()}] 🛑 Binance 日发帖额度已用完，今日停止发布，UTC 00:00 自动恢复`);
              await reportStatus(post.id, 'failed', undefined, result.error, result.steps);
              // 通知 bot 写 quota_state.exhausted_until，让 pending 在 UTC 00:00 前返回空
              try {
                await api('/api/quota/exhausted', { method: 'POST', body: JSON.stringify({}) });
                console.log(`[${ts()}] 📝 已通知 bot 设置 quota exhausted`);
              } catch (e) {
                console.error(`[${ts()}] ⚠️ 通知 bot 失败: ${e.message}`);
              }
              releaseLock();
              process.exit(0); // 退出让 systemd 重启；重启后 pending 返回空，自然停
            }
            console.error(`[${ts()}] ❌ #${post.id} 发布失败: ${result.error}`);
            await reportStatus(post.id, 'failed', undefined, result.error, result.steps);
          }
          writeLog(post, result);
        }
      } else {
        // idle 时每 20 轮（~10min）打一次心跳
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

// 单测导出（不影响运行时行为；均为已定义的函数/常量）
export {
  publishViaApi,
  checkLockOwner,
  checkCircuitBreaker,
  getApiKey,
  onPublishResult,
  parseImageUrls,
  PUBLISHER_VERSION,
  stripMdHeaders,
  ensureTags,
  capHashtags,
};

// 仅在直接运行时启动主循环；被 import（单测）时不自启动，避免触发 lock / 轮询
if (process.argv[1] && resolve(process.argv[1]) === AGENT_PATH) {
  main();
}
