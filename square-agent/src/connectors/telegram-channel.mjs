// telegram-channel.mjs — Telegram Channel Connector
//
// 使用 Telegram Bot API 发帖到 Channel
// 适合作为备用发布渠道和长文分发

import { BaseConnector } from './base.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import paths from '../paths.mjs';

const TG_API_BASE = 'https://api.telegram.org';
const MAX_TEXT = 4096;

export class TelegramChannelConnector extends BaseConnector {
  constructor(config = {}) {
    super(config);
    this.name = 'Telegram Channel';
    this.platform = 'telegram';
    this.capabilities = {
      text: true,
      image: true,
      video: false,
      poll: true,
      longArticle: true,
      delete: true,
      stats: false, // Channel stats 需要 user token，Bot API 不支持
    };
    this.botToken = config.botToken || this._readToken();
    this.channelId = config.channelId || process.env.TELEGRAM_CHANNEL_ID || '';
  }

  _readToken() {
    // 优先用统一 .env (~/.square-agent/.env)，再 fallback 到仓库内 bot/.env
    for (const envFile of [paths.envFile, paths.botEnvFile]) {
      if (existsSync(envFile)) {
        const m = readFileSync(envFile, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
        if (m) return m[1].trim();
      }
    }
    return process.env.TELEGRAM_BOT_TOKEN || '';
  }

  async publish(content, options = {}) {
    if (!this.botToken || !this.channelId) {
      return { success: false, error: 'Bot token 或 Channel ID 未配置' };
    }

    let text = content;
    if (text.length > MAX_TEXT) {
      text = text.substring(0, MAX_TEXT - 3) + '...';
    }

    const body = {
      chat_id: this.channelId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: !options.preview,
    };

    try {
      // 有图片：sendPhoto + caption
      if (options.images?.length > 0) {
        return await this._sendPhoto(options.images[0], text);
      }

      // 纯文本
      const res = await fetch(`${TG_API_BASE}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.ok) {
        const messageId = String(data.result.message_id);
        return {
          success: true,
          postId: messageId,
          postUrl: this.channelId.startsWith('@')
            ? `https://t.me/${this.channelId.substring(1)}/${messageId}`
            : null,
        };
      }

      return { success: false, error: data.description || 'Telegram API error' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _sendPhoto(imageUrl, caption) {
    try {
      const res = await fetch(`${TG_API_BASE}/bot${this.botToken}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.channelId,
          photo: imageUrl,
          caption: caption?.substring(0, 1024),
          parse_mode: 'HTML',
        }),
      });
      const data = await res.json();
      if (data.ok) {
        return { success: true, postId: String(data.result.message_id), postUrl: null };
      }
      return { success: false, error: data.description };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async delete(postId) {
    if (!postId) return { success: false, error: 'missing postId' };
    try {
      const res = await fetch(`${TG_API_BASE}/bot${this.botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.channelId, message_id: parseInt(postId) }),
      });
      const data = await res.json();
      return { success: data.ok };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async checkHealth() {
    if (!this.botToken) return { healthy: false, issues: ['Bot token 未配置'], warnings: [] };
    try {
      const res = await fetch(`${TG_API_BASE}/bot${this.botToken}/getMe`);
      const data = await res.json();
      if (!data.ok) {
        return { healthy: false, issues: [`Bot API: ${data.description}`], warnings: [] };
      }
      return { healthy: true, issues: [], warnings: [] };
    } catch (e) {
      return { healthy: false, issues: [e.message], warnings: [] };
    }
  }
}
