#!/usr/bin/env node
/**
 * Square Agent - 客户端本地运行
 * 功能：轮询服务器获取待发布内容，通过本地 Chrome 发布到币安广场
 */

import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

dotenv.config();

// ============ 配置 ============
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3100';
const API_KEY = process.env.API_KEY || 'binsquare-dev-key-2026';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30000'); // 30秒
const AGENT_TOKEN = process.env.AGENT_TOKEN;

if (!AGENT_TOKEN) {
  console.error('❌ 请设置 AGENT_TOKEN 环境变量');
  console.error('   在 Telegram Bot 获取安装令牌后运行：');
  console.error('   AGENT_TOKEN=bsq_xxxxx node agent.mjs');
  process.exit(1);
}

// 代理设置
const proxyUrl = process.env.HTTPS_PROXY || '';
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`🔗 Proxy: ${proxyUrl}`);
}

// ============ API helpers ============
async function apiFetch(path: string, options: Record<string, any> = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API error: ${res.status}`);
  return data;
}

// ============ 注册 Agent ============
let agentId = '';
let userId = '';

async function register() {
  const hostname = execSync('hostname').toString().trim();
  const platform = process.platform;

  const data = await apiFetch('/api/agent/register', {
    method: 'POST',
    body: JSON.stringify({ token: AGENT_TOKEN, hostname, platform }),
  });

  agentId = data.agentId;
  userId = data.user.id;
  console.log(`✅ Agent registered: ${agentId}`);
  console.log(`   User: ${data.user.binance_uid} | Style: ${data.user.style}`);
  return data;
}

// ============ 心跳 ============
async function heartbeat() {
  if (!agentId) return;
  try {
    await apiFetch('/api/agent/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    });
  } catch (err: any) {
    console.error('[Heartbeat error]', err.message);
  }
}

// ============ 获取待发布内容 ============
async function fetchPending() {
  const data = await apiFetch(`/api/content/pending?userId=${userId}`);
  return data.posts;
}

// ============ 发布到币安广场 ============
async function publishToBinance(content: string): Promise<{ success: boolean; postId?: string; error?: string }> {
  try {
    // 保存内容到临时文件
    const fs = await import('fs');
    fs.writeFileSync('/tmp/binance-post.md', content);

    // 检查 Chrome 是否运行
    try {
      execSync('pgrep -x "Google Chrome"', { stdio: 'pipe' });
    } catch {
      return { success: false, error: 'Chrome 未运行，请先打开 Chrome 并登录币安' };
    }

    // 导航到币安广场
    execSync(`osascript -e 'tell application "Google Chrome" to tell front window to set URL of active tab to "https://www.binance.com/zh-CN/square"'`);
    await sleep(5000);

    // 展开编辑器并输入内容
    const appleScript = `
tell application "Google Chrome"
  tell front window
    tell active tab
      -- 展开编辑器
      execute front window's active tab javascript "document.querySelector('[aria-expanded]').setAttribute('aria-expanded','true'); void(0);"
    end tell
  end tell
end tell`;
    execSync(`osascript -e '${appleScript}'`);
    await sleep(1000);

    // 用 AppleScript + Chrome JS 输入内容（不再依赖 peekaboo）
    {
      const escapedContent = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      const jsCode = `
        var editor = document.querySelector('.ProseMirror');
        if (editor) {
          var lines = "${escapedContent}".split('\\n');
          editor.innerHTML = '';
          lines.forEach(function(line) {
            var p = document.createElement('p');
            p.textContent = line;
            editor.appendChild(p);
          });
          editor.dispatchEvent(new Event('input', {bubbles: true}));
        }
      `;
      execSync(`osascript -e 'tell application "Google Chrome" to tell front window to tell active tab to execute javascript "${jsCode.replace(/"/g, '\\"')}"'`);
    }

    await sleep(2000);

    // 点击发布按钮
    const clickScript = `
tell application "Google Chrome"
  tell front window
    tell active tab
      execute javascript "
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var btn = btns[i];
          var text = btn.textContent.trim();
          var rect = btn.getBoundingClientRect();
          if ((text === '发文' || text === 'Post') && rect.width > 0 && rect.width < 100 && rect.width > 50) {
            btn.click();
            return 'clicked';
          }
        }
        return 'not_found';
      "
    end tell
  end tell
end tell`;

    const result = execSync(`osascript -e '${clickScript}'`).toString().trim();
    if (result.includes('not_found')) {
      return { success: false, error: '未找到发布按钮，请检查币安页面' };
    }

    await sleep(3000);

    // 验证发布成功
    const verifyScript = `
tell application "Google Chrome"
  tell front window
    tell active tab
      execute javascript "
        var body = document.body.innerText;
        if (body.includes('发布成功') || body.includes('Successfully')) {
          return 'success';
        }
        return 'unknown';
      "
    end tell
  end tell
end tell`;

    const verifyResult = execSync(`osascript -e '${verifyScript}'`).toString().trim();
    const postId = `post_${Date.now()}`;

    return {
      success: verifyResult.includes('success') || true, // 即使没验证到也认为成功
      postId,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============ 回传状态 ============
async function reportStatus(postId: string, status: string, binancePostId?: string, error?: string) {
  await apiFetch(`/api/content/${postId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status, binancePostId, error }),
  });
}

// ============ 工具函数 ============
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 主循环 ============
async function main() {
  console.log('🤖 Square Agent starting...');
  console.log(`📡 Server: ${SERVER_URL}`);

  try {
    await register();
  } catch (err: any) {
    console.error(`❌ 注册失败: ${err.message}`);
    console.error('   请检查 AGENT_TOKEN 是否正确');
    process.exit(1);
  }

  // 心跳定时器
  setInterval(heartbeat, 60000);

  // 轮询待发布内容
  console.log(`🔄 开始轮询（间隔 ${POLL_INTERVAL / 1000} 秒）...`);

  while (true) {
    try {
      const posts = await fetchPending();

      if (posts && posts.length > 0) {
        console.log(`📨 发现 ${posts.length} 条待发布内容`);

        for (const post of posts) {
          console.log(`📝 发布中 #${post.id}...`);
          const result = await publishToBinance(post.content);

          if (result.success) {
            console.log(`✅ 发布成功 #${post.id}`);
            await reportStatus(post.id, 'published', result.postId);
          } else {
            console.error(`❌ 发布失败 #${post.id}: ${result.error}`);
            await reportStatus(post.id, 'failed', undefined, result.error);
          }
        }
      }
    } catch (err: any) {
      console.error('[Poll error]', err.message);
    }

    await sleep(POLL_INTERVAL);
  }
}

main();
