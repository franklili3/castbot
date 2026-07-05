#!/usr/bin/env node
// square-cli.mjs — SquareAgent CLI 工具
//
// 用法：
//   square-cli publish --text "内容" [--platform binance,x,telegram]
//   square-cli generate --topic "BTC价格分析" [--template breaking_news]
//   square-cli stats [--days 7]
//   square-cli health
//   square-cli pending

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import paths from './paths.mjs';

const SERVER_URL = process.env.SQUARE_SERVER || 'http://127.0.0.1:5577';
const API_KEY = process.env.SQUARE_API_KEY || (() => {
  const envFile = paths.envFile;
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^BINANCE_SQUARE_OPENAPI_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  return '';
})();

// ============ HTTP helpers ============
async function apiGet(path) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: { 'x-api-key': API_KEY },
  });
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ============ 命令处理 ============

async function cmdPublish(args) {
  const text = args.text || args._[0];
  if (!text) {
    console.error('❌ 缺少内容：使用 --text "内容" 或直接传文本');
    process.exit(1);
  }

  const platforms = (args.platform || 'binance').split(',');
  
  // 通过 Connector registry 分发
  const { publishToAll } = await import(paths.registryMjs);
  
  console.log(`📤 发布到 ${platforms.length} 个平台: ${platforms.join(', ')}`);
  const { results, summary } = await publishToAll(text, platforms, {
    images: args.image ? [args.image] : undefined,
  });

  for (const [platform, result] of Object.entries(results)) {
    if (result.success) {
      console.log(`  ✅ ${platform}: ${result.postUrl || result.postId || 'OK'}`);
    } else {
      console.log(`  ❌ ${platform}: ${result.error}`);
    }
  }

  console.log(`\n📊 ${summary.success}/${summary.total} 成功`);
}

async function cmdGenerate(args) {
  const topic = args.topic || args._[0];
  if (!topic) {
    console.error('❌ 缺少主题：使用 --topic "主题"');
    process.exit(1);
  }

  console.log(`🤖 生成内容: ${topic}`);
  const result = await apiPost('/api/content/generate', {
    prompt: topic,
    template: args.template || 'breaking_news',
  });

  if (result.content) {
    console.log('\n' + result.content);
    if (args.copy) {
      console.log('\n💡 使用 --publish 直接发布');
    }
  } else {
    console.error('❌ 生成失败:', result.error || '未知错误');
  }
}

async function cmdStats(args) {
  const days = args.days || 1;
  console.log(`📊 最近 ${days} 天统计\n`);

  const data = await apiGet(`/api/billing/usage?days=${days}`);
  if (data) {
    console.log(`发布: ${data.posts || 0}`);
    console.log(`浏览: ${data.views || 'N/A'}`);
    console.log(`点赞: ${data.likes || 'N/A'}`);
  } else {
    console.log('（无法获取数据）');
  }
}

async function cmdHealth() {
  const { generateHealthReport } = await import(paths.healthMonitorMjs);
  console.log(generateHealthReport());
}

async function cmdPending() {
  const data = await apiGet('/api/content/pending');
  if (data?.posts?.length > 0) {
    console.log(`📨 ${data.posts.length} 条待发布:\n`);
    for (const post of data.posts) {
      const preview = (post.content || '').substring(0, 60);
      console.log(`  #${post.id}: ${preview}...`);
    }
  } else {
    console.log('✅ 无待发布内容');
  }
}

// ============ 参数解析 ============
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ============ 入口 ============
const args = parseArgs(process.argv);
const command = args._[0] || '';
args._ = args._.slice(1);

switch (command) {
  case 'publish': await cmdPublish(args); break;
  case 'generate': await cmdGenerate(args); break;
  case 'stats': await cmdStats(args); break;
  case 'health': await cmdHealth(); break;
  case 'pending': await cmdPending(); break;
  default:
    console.log(`SquareAgent CLI

用法:
  square-cli publish --text "内容" [--platform binance,x]
  square-cli generate --topic "主题" [--template breaking_news]
  square-cli stats [--days 7]
  square-cli health
  square-cli pending
`);
}
