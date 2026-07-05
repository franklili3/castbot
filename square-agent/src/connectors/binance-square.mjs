// binance-square.mjs — 币安广场 Connector
//
// 从现有 publisher agent.mjs 的 postToSquare 迁移
// 支持纯文本 + 图片发帖

import { BaseConnector } from './base.mjs';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import paths, { tmpFile } from '../paths.mjs';

const API_ENDPOINT = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi';
const API_ENDPOINT_V2 = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi';
const MAX_TEXT = 2000;
const MAX_IMAGES = 4;

export class BinanceSquareConnector extends BaseConnector {
  constructor(config = {}) {
    super(config);
    this.name = '币安广场';
    this.platform = 'binance';
    this.capabilities = {
      text: true,
      image: true,
      video: false,
      poll: false,
      longArticle: true,
      delete: false,
      stats: false, // 需 AppleScript 抓取
    };
    this.apiKey = config.apiKey || this._readApiKey();
    this.proxyDispatcher = config.proxyDispatcher || null;
  }

  _readApiKey() {
    const env = process.env.BINANCE_SQUARE_OPENAPI_KEY || process.env.BINANCE_SQUARE_API_KEY;
    if (env?.trim()) return env.trim();
    const configFile = paths.binanceOpenApiKey;
    if (existsSync(configFile)) return readFileSync(configFile, 'utf8').trim();
    const envFile = paths.envFile;
    if (existsSync(envFile)) {
      const m = readFileSync(envFile, 'utf8').match(/^BINANCE_SQUARE_(?:OPENAPI_)?API_KEY=(.+)$/m);
      if (m) return m[1].trim();
    }
    return null;
  }

  async publish(content, options = {}) {
    if (!this.apiKey) {
      return { success: false, error: 'BINANCE_SQUARE_API_KEY 未配置' };
    }

    // 确保标签
    let text = this._ensureTags(content);

    // 上传图片（如有）
    let imageList = undefined;
    if (options.images?.length > 0) {
      imageList = await this._uploadImages(options.images);
    }

    // 长文模式
    const contentType = options.title ? 2 : 1;
    const body = { contentType, bodyTextOnly: text };
    if (options.title) body.title = options.title;
    if (imageList?.length > 0) body.imageList = imageList;

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(`${API_ENDPOINT}/content/add`, {
          method: 'POST',
          headers: {
            'X-Square-OpenAPI-Key': this.apiKey,
            'Content-Type': 'application/json',
            'clienttype': 'binanceSkill',
          },
          body: JSON.stringify(body),
          ...(this.proxyDispatcher ? { dispatcher: this.proxyDispatcher } : {}),
        });

        if (res.status === 504) {
          return { success: true, postId: null, postUrl: null, note: 'timeout but likely posted' };
        }

        const json = await res.json();
        if (String(json.code) === '000000') {
          const postId = String(json.data?.id || '');
          const postUrl = postId ? `https://www.binance.com/square/post/${postId}` : null;
          return { success: true, postId, postUrl };
        }

        // Retryable errors
        if (['10004'].includes(String(json.code)) && attempt < 5) {
          await new Promise(r => setTimeout(r, 3000 * attempt));
          continue;
        }

        return { success: false, error: `${json.code}: ${json.message || 'unknown'}` };
      } catch (e) {
        if (attempt < 5) {
          await new Promise(r => setTimeout(r, 3000 * attempt));
          continue;
        }
        return { success: false, error: e.message };
      }
    }

    return { success: false, error: 'max retries exceeded' };
  }

  _ensureTags(content) {
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

  async _uploadImages(imageUrls) {
    const uploaded = [];
    for (const url of imageUrls.slice(0, MAX_IMAGES)) {
      const result = await this._uploadSingleImage(url);
      if (result) uploaded.push(result);
    }
    return uploaded.length > 0 ? uploaded : undefined;
  }

  async _uploadSingleImage(imageUrl) {
    try {
      if (!existsSync(paths.tmpRoot)) mkdirSync(paths.tmpRoot, { recursive: true, mode: 0o755 });
      const tmpPath = tmpFile('sa-img') + '.' + imageUrl.split('?')[0].split('.').pop().toLowerCase();
      execSync(`curl -sL --max-time 15 -o "${tmpPath}" "${imageUrl}"`, { timeout: 20000 });
      if (!existsSync(tmpPath)) return null;

      const imageName = tmpPath.split('/').pop();
      const ext = imageName.split('.').pop();
      const ct = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';

      // 1. Presigned URL
      const preRes = await fetch(`${API_ENDPOINT_V2}/image/presignedUrl`, {
        method: 'POST',
        headers: { 'X-Square-OpenAPI-Key': this.apiKey, 'Content-Type': 'application/json', 'clienttype': 'binanceSkill' },
        body: JSON.stringify({ imageName }),
        ...(this.proxyDispatcher ? { dispatcher: this.proxyDispatcher } : {}),
      });
      const preJson = await preRes.json();
      if (String(preJson.code) !== '000000') return null;

      const { presignedUrl, fileTicket } = preJson.data;

      // 2. Upload to S3
      const imgBuf = readFileSync(tmpPath);
      await fetch(presignedUrl, { method: 'PUT', headers: { 'Content-Type': ct }, body: imgBuf });

      // 3. Poll
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const sRes = await fetch(`${API_ENDPOINT_V2}/image/imageStatus`, {
          method: 'POST',
          headers: { 'X-Square-OpenAPI-Key': this.apiKey, 'Content-Type': 'application/json', 'clienttype': 'binanceSkill' },
          body: JSON.stringify({ fileTicket }),
          ...(this.proxyDispatcher ? { dispatcher: this.proxyDispatcher } : {}),
        });
        const sJson = await sRes.json();
        if (String(sJson.code) === '000000' && sJson.data?.status === 1) {
          execSync(`rm -f "${tmpPath}"`);
          return sJson.data.imageUrl;
        }
        if (String(sJson.code) === '000000' && sJson.data?.status === 2) break;
      }
      execSync(`rm -f "${tmpPath}"`);
      return null;
    } catch {
      return null;
    }
  }

  async checkHealth() {
    if (!this.apiKey) return { healthy: false, issues: ['API Key 未配置'], warnings: [] };
    // 币安广场 API 没有 health 端点，能发帖就是健康
    return { healthy: true, issues: [], warnings: [] };
  }
}
