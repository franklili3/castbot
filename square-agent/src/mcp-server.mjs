#!/usr/bin/env node
// mcp-server.mjs — SquareAgent MCP Server (stdio)
//
// 把 SquareAgent 核心能力暴露为 MCP 工具
// 供 OpenClaw / Claude / 其他 AI Agent 调用
//
// 工具列表:
//   publish_post   — 发布帖子
//   generate_content — 生成内容
//   get_stats      — 获取统计
//   check_health   — 健康检查
//   list_pending   — 待发布列表

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import paths from './paths.mjs';

const SERVER_URL = process.env.SQUARE_SERVER || 'http://127.0.0.1:5577';

// ============ MCP Protocol ============

const TOOLS = [
  {
    name: 'publish_post',
    description: '发布帖子到币安广场/X/Telegram',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '帖子内容' },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['binance', 'x', 'telegram'] },
          description: '发布平台列表，默认 ["binance"]',
        },
        images: { type: 'array', items: { type: 'string' }, description: '图片URL列表' },
      },
      required: ['content'],
    },
  },
  {
    name: 'generate_content',
    description: 'AI 生成加密货币内容',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '内容主题' },
        template: {
          type: 'string',
          enum: ['breaking_news', 'price_move', 'hot_comment', 'deep_analysis'],
          description: '内容模板',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'get_stats',
    description: '获取发布统计和互动数据',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '统计天数', default: 1 },
      },
    },
  },
  {
    name: 'check_health',
    description: '检查账号和系统健康状态',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_pending',
    description: '列出待发布的帖子',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ============ 工具实现 ============

async function publishPost(args) {
  const platforms = args.platforms || ['binance'];
  try {
    const { publishToAll } = await import(paths.registryMjs);
    const { results, summary } = await publishToAll(args.content, platforms, {
      images: args.images,
    });

    const lines = [
      `📊 ${summary.success}/${summary.total} 平台发布成功`,
    ];
    for (const [p, r] of Object.entries(results)) {
      lines.push(`  ${r.success ? '✅' : '❌'} ${p}: ${r.postUrl || r.error || 'OK'}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ 发布失败: ${e.message}` }], isError: true };
  }
}

async function generateContent(args) {
  try {
    const res = await fetch(`${SERVER_URL}/api/content/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: args.topic, template: args.template }),
    });
    const data = await res.json();
    if (data.content) {
      return { content: [{ type: 'text', text: data.content }] };
    }
    return { content: [{ type: 'text', text: `生成失败: ${data.error || '未知'}` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
  }
}

async function getStats(args) {
  try {
    const res = await fetch(`${SERVER_URL}/api/billing/usage?days=${args.days || 1}`);
    const data = await res.json();
    const lines = [
      `📊 统计 (最近 ${args.days || 1} 天)`,
      `发布: ${data.posts || 'N/A'}`,
      `浏览: ${data.views || 'N/A'}`,
      `点赞: ${data.likes || 'N/A'}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
  }
}

async function checkHealth(args) {
  try {
    const { generateHealthReport } = await import(paths.healthMonitorMjs);
    return { content: [{ type: 'text', text: generateHealthReport() }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
  }
}

async function listPending(args) {
  try {
    const res = await fetch(`${SERVER_URL}/api/content/pending`);
    const data = await res.json();
    const posts = data?.posts || [];
    if (posts.length === 0) {
      return { content: [{ type: 'text', text: '✅ 无待发布内容' }] };
    }
    const lines = [`📨 ${posts.length} 条待发布:`];
    for (const p of posts) {
      lines.push(`  #${p.id}: ${(p.content || '').substring(0, 60)}...`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
  }
}

const TOOL_HANDLERS = {
  publish_post: publishPost,
  generate_content: generateContent,
  get_stats: getStats,
  check_health: checkHealth,
  list_pending: listPending,
};

// ============ MCP stdio 通信 ============

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'square-agent', version: '1.0.0' },
        },
      });
    } else if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: TOOLS },
      });
    } else if (msg.method === 'tools/call') {
      const handler = TOOL_HANDLERS[msg.params.name];
      if (handler) {
        handler(msg.params.arguments || {}).then(result => {
          send({ jsonrpc: '2.0', id: msg.id, result });
        }).catch(e => {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: e.message },
          });
        });
      } else {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Unknown tool: ${msg.params.name}` },
        });
      }
    }
  } catch (e) {
    // Ignore parse errors
  }
});

console.error('SquareAgent MCP Server running (stdio)');
