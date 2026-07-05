import dotenv from 'dotenv';
dotenv.config();
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import db from './db/schema.js';
import * as userService from './services/user.js';
import * as postService from './services/post.js';
import { generateContent, SHORT_TEMPLATE_NAMES, POLL_TEMPLATE_NAMES, SERVER_SHORT_TEMPLATE_NAMES, PROMO_TEMPLATE_NAMES } from './services/content.js';
const TOKEN = process.env.SQUARE_AGENT_BOT_TOKEN;
const PROXY = process.env.HTTPS_PROXY || '';
const API = `https://api.telegram.org/bot${TOKEN}`;
// 内部 HTTP 请求（不走代理，用于调用本地 server）
import http from 'http';
function localFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: options.method || 'GET', headers: options.headers || {} }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, json: () => JSON.parse(body), status: res.statusCode }));
        });
        req.on('error', reject);
        if (options.body)
            req.write(options.body);
        req.end();
    });
}
let lastUpdateId = 0;
// ============ API helpers ============
async function tgApi(method, body) {
    const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!data.ok)
        throw new Error(`TG API error: ${data.description}`);
    return data.result;
}
async function sendMessage(chatId, text, extra) {
    return tgApi('sendMessage', { chat_id: chatId, text, ...extra });
}
async function editMessage(chatId, messageId, text, extra) {
    return tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
}
async function answerCallback(callbackQueryId, text) {
    return tgApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
}
async function sendMessageWithKeyboard(chatId, text, keyboard) {
    return tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: JSON.stringify(keyboard) });
}
async function editMessageWithKeyboard(chatId, messageId, text, keyboard) {
    return tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', reply_markup: JSON.stringify(keyboard) });
}
// ============ Handlers ============
async function handleStart(chatId, from) {
    const tgId = from.id;
    let user = userService.findByTelegramId(tgId);
    if (!user) {
        user = userService.createUser(tgId, from.username || null);
        console.log(`[New user] ${from.username || tgId}`);
    }
    if (user.status === 'pending' && !user.binance_uid) {
        // Generate token and set waiting_uid state
        const token = `bsq_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
        db.prepare("UPDATE users SET agent_token = ?, status = 'active', style = '__waiting_uid__' WHERE telegram_id = ?")
            .run(token, user.telegram_id);
        await sendMessage(chatId, `👋 欢迎使用 SquareAgent Bot！\n\n` +
            `我是币安广场自动运营助手。\n` +
            `你只需要做交易，我帮你搞定内容。\n\n` +
            `首先，请输入你的 *币安 UID*：\n` +
            `(在币安 App → 个人中心可以找到)`);
        return;
    }
    // User already active
    await sendMessage(chatId, `👋 欢迎回来！\n\n` +
        `📊 /preview - 查看今日内容预览\n` +
        `⚙️ /settings - 偏好设置\n` +
        `📈 /stats - 查看数据\n` +
        `📝 /history - 发布历史\n` +
        `🆘 /help - 帮助`);
}
async function handleText(chatId, from, text) {
    const tgId = from.id;
    const user = userService.findByTelegramId(tgId);
    if (!user)
        return;
    // Waiting for UID
    if (user.style === '__waiting_uid__') {
        const uid = text.trim();
        if (!/^\d{8,}$/.test(uid)) {
            await sendMessage(chatId, '❌ 币安 UID 应该是一串数字，请重新输入：');
            return;
        }
        userService.updateBinanceUid(user.telegram_id, uid);
        userService.updateStyle(user.telegram_id, 'balanced');
        await sendMessageWithKeyboard(chatId, `✅ 币安 UID 已记录：${uid}\n\n选择你的内容风格：`, {
            inline_keyboard: [
                [{ text: '🔥 激进型', callback_data: 'style_aggressive' }, { text: '⚖️ 稳健型', callback_data: 'style_balanced' }],
                [{ text: '📊 量化型', callback_data: 'style_quantitative' }],
            ]
        });
        return;
    }
}
async function handleCallback(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const from = callbackQuery.from;
    const msgId = callbackQuery.message.message_id;
    const tgId = from.id;
    const typeLabels = { short: '📝 短贴', poll: '📊 投票贴', promo: '📢 推广贴' };
    const user = userService.findByTelegramId(tgId);
    if (!user) {
        await answerCallback(callbackQuery.id, '❌ 请先 /start');
        return;
    }
    // Style selection
    const styleMatch = data.match(/^style_(.+)$/);
    if (styleMatch) {
        const style = styleMatch[1];
        userService.updateStyle(user.telegram_id, style);
        const names = { aggressive: '🔥 激进型', balanced: '⚖️ 稳健型', quantitative: '📊 量化型' };
        await answerCallback(callbackQuery.id, '✅ 已选择');
        // Generate agent token
        const token = db.prepare('SELECT agent_token FROM users WHERE telegram_id = ?').get(user.telegram_id);
        await editMessage(chatId, msgId, `✅ 内容风格：${names[style] || style}\n\n` +
            `🎉 账号已就绪！\n\n` +
            `开始使用：\n` +
            `• /preview - 生成第一篇内容\n` +
            `• /settings - 调整偏好设置\n\n` +
            `🚀 安装 Agent（在 Mac 终端运行）：\n` +
            `\`\`\`\ncurl -sL https://api.square-agent.com/install.sh | AGENT_TOKEN=${token?.agent_token || '请用 /token 获取'} bash\n\`\`\`\n\n` +
            `⚠️ 确保 Chrome 已打开并登录币安`);
        return;
    }
    // Approve post
    const approveMatch = data.match(/^approve_(\d+)$/);
    if (approveMatch) {
        const postId = parseInt(approveMatch[1]);
        const post = postService.getPostById(postId);
        if (!post) {
            await answerCallback(callbackQuery.id, '❌ 不存在');
            return;
        }
        postService.approvePost(postId);
        await answerCallback(callbackQuery.id, '✅ 已批准');
        await editMessage(chatId, msgId, `✅ 已批准发布！\n\n${post.content}\n\n📅 等待自动发布...`);
        return;
    }
    // Regenerate
    const regenMatch = data.match(/^regenerate_(\d+)$/);
    if (regenMatch) {
        const postId = parseInt(regenMatch[1]);
        postService.rejectPost(postId);
        const contentTypes = user.content_types.split(',').filter(Boolean);
        const contentType = contentTypes[Math.floor(Math.random() * contentTypes.length)];
        const enabledTplNames = (user.enabled_templates || '').split(',').filter(Boolean);
        // 排除今天已用过的模板
        const usedNames = postService.getTodayUsedTemplateNames(user.id);
        const excludeUsed = enabledTplNames.filter(n => !usedNames.includes(n));
        if (excludeUsed.length === 0) {
            await answerCallback(callbackQuery.id, '⚠️ 模板已用完');
            await sendMessage(chatId, '⚠️ 今天所有模板都已用过啦，明天再来吧！');
            return;
        }
        const newContent = await generateContent(user.style, contentType, undefined, excludeUsed, { baseUrl: 'http://127.0.0.1:5577', token: user.agent_token });
        const newPost = postService.createPost(user.id, newContent.content, newContent.topics, newContent.templateName);
        await answerCallback(callbackQuery.id, '🔄 已重新生成');
        await sendMessageWithKeyboard(chatId, `📝 内容预览 (#${newPost.id}) [${typeLabels[contentType] || contentType} | ${newContent.templateName}]\n\n${newContent.content}\n\n---\n选择操作：`, {
            inline_keyboard: [
                [{ text: '✅ 批准发布', callback_data: `approve_${newPost.id}` }, { text: '🔄 重新生成', callback_data: `regenerate_${newPost.id}` }],
                [{ text: '🗑️ 丢弃', callback_data: `reject_${newPost.id}` }],
            ]
        });
        return;
    }
    // Reject
    const rejectMatch = data.match(/^reject_(\d+)$/);
    if (rejectMatch) {
        postService.rejectPost(parseInt(rejectMatch[1]));
        await answerCallback(callbackQuery.id, '🗑️ 已丢弃');
        await editMessage(chatId, msgId, '🗑️ 内容已丢弃。需要新的可以用 /preview 生成。');
        return;
    }
    // ============ Content-pipeline / news-telegram 回调处理 ============
    // cp_pub:<id> — content-pipeline 帖子发布
    if (data.startsWith('cp_pub:')) {
        const postId = parseInt(data.split(':')[1]);
        const post = postService.getPostById(postId);
        if (!post) {
            // 可能是文件引用（cp_pub:file:filename）
            await answerCallback(callbackQuery.id, '❌ 帖子不存在（DB可能已恢复）');
            await sendMessage(chatId, '❌ 找不到这篇帖子，可能数据库已恢复。请重新生成。');
            return;
        }
        // 标记为 approved，让 publisher agent 自动拉取
        postService.approvePost(postId);
        await answerCallback(callbackQuery.id, '✅ 已批准');
        await editMessage(chatId, msgId, `✅ 已加入发布队列！\n帖子ID: #${postId}\n\nPublisher Agent 会自动发布到币安广场。`);
        console.log(`[cp_pub] Post #${postId} approved`);
        return;
    }
    // cp_del:<id> — content-pipeline 帖子丢弃
    if (data.startsWith('cp_del:')) {
        const postId = parseInt(data.split(':')[1]);
        try {
            postService.rejectPost(postId);
        }
        catch { }
        await answerCallback(callbackQuery.id, '🗑️ 已丢弃');
        await editMessage(chatId, msgId, '🗑️ 已丢弃。');
        return;
    }
    // tn_pub:<id> — telegram-notify 发送的内容（存于 tg-pending/）
    if (data.startsWith('tn_pub:')) {
        const newsId = data.split(':').slice(1).join(':');
        const fs = await import('fs');
        const pendingPath = `/Users/mac/clawd/data/tg-pending/${newsId}.json`;
        try {
            if (!fs.existsSync(pendingPath)) {
                await answerCallback(callbackQuery.id, '❌ 过期');
                await sendMessage(chatId, '❌ 找不到这条内容（可能已过期）');
                return;
            }
            const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
            const { execSync: execSyncAsync } = await import('child_process');
            // 写入 bot DB 为 approved
            const botDb = '/Users/mac/clawd/square-agent-bot/data/square-agent.db';
            const escaped = pending.message.replace(/'/g, "''");
            execSyncAsync(`sqlite3 "${botDb}" "INSERT INTO posts (user_id, content, topics, status, scheduled_at) VALUES (${user.id}, '${escaped}', 'BTC,加密分析', 'approved', datetime('now'))"`);
            const newId = execSyncAsync(`sqlite3 "${botDb}" "SELECT max(id) FROM posts"`).toString().trim();
            fs.unlinkSync(pendingPath);
            await answerCallback(callbackQuery.id, '✅ 已加入队列');
            await editMessage(chatId, msgId, `✅ 已加入发布队列！\n帖子ID: #${newId}\n\nPublisher Agent 会自动发布到币安广场。`);
        }
        catch (e) {
            await answerCallback(callbackQuery.id, '❌ 错误');
            await sendMessage(chatId, `❌ 发布失败: ${e.message.substring(0, 100)}`);
        }
        return;
    }
    // tn_del:<id>
    if (data.startsWith('tn_del:')) {
        const newsId = data.split(':').slice(1).join(':');
        const fs = await import('fs');
        try {
            fs.unlinkSync(`/Users/mac/clawd/data/tg-pending/${newsId}.json`);
        }
        catch { }
        await answerCallback(callbackQuery.id, '🗑️ 已丢弃');
        await editMessage(chatId, msgId, '🗑 已丢弃。');
        return;
    }
    // pub:<id> — news-pipeline 解读新闻发布
    if (data.startsWith('pub:')) {
        const newsId = data.split(':')[1];
        const { execSync: execSync2 } = await import('child_process');
        try {
            // 先查 interpreted-news.json，查不到再查 pipeline-state.json（永久保存）
            const interpretedPath = '/Users/mac/clawd/square-agent/news-pipeline/data/interpreted-news.json';
            const statePath = '/Users/mac/clawd/square-agent/news-pipeline/data/pipeline-state.json';
            const fs2 = await import('fs');
            let content = null;
            // 1. 查 interpreted-news.json
            if (fs2.existsSync(interpretedPath)) {
                const interpreted = JSON.parse(fs2.readFileSync(interpretedPath, 'utf8'));
                const item = interpreted.find((n) => n.id === newsId);
                if (item?.interpretedContent)
                    content = item.interpretedContent;
            }
            // 2. fallback: 查 pipeline-state.json
            if (!content && fs2.existsSync(statePath)) {
                const state = JSON.parse(fs2.readFileSync(statePath, 'utf8'));
                const item = (state.outputs || []).find((o) => o.id === newsId);
                if (item?.interpretedContent)
                    content = item.interpretedContent;
            }
            if (!content) {
                await answerCallback(callbackQuery.id, '❌ 找不到');
                await sendMessage(chatId, '❌ 找不到这条新闻（可能已过期）');
                return;
            }
            // 写入 bot DB
            const botDb = '/Users/mac/clawd/square-agent-bot/data/square-agent.db';
            const escaped = content.replace(/'/g, "''");
            execSync2(`sqlite3 "${botDb}" "INSERT INTO posts (user_id, content, topics, status, scheduled_at) VALUES (${user.id}, '${escaped}', 'BTC,加密分析', 'approved', datetime('now'))"`);
            const newId = execSync2(`sqlite3 "${botDb}" "SELECT max(id) FROM posts"`).toString().trim();
            await answerCallback(callbackQuery.id, '✅ 已加入队列');
            await editMessage(chatId, msgId, `✅ 已加入发布队列！\n帖子ID: #${newId}\n\nPublisher Agent 会自动发布到币安广场。`);
        }
        catch (e) {
            await answerCallback(callbackQuery.id, '❌ 错误');
            await sendMessage(chatId, `❌ 发布失败: ${e.message.substring(0, 100)}`);
        }
        return;
    }
    // del:<id>
    if (data.startsWith('del:')) {
        await answerCallback(callbackQuery.id, '🗑️ 已丢弃');
        await editMessage(chatId, msgId, '🗑 已丢弃。');
        return;
    }
    // Settings
    if (data === 'settings_style') {
        await answerCallback(callbackQuery.id);
        await sendMessageWithKeyboard(chatId, '选择你的内容风格：', {
            inline_keyboard: [
                [{ text: '🔥 激进型', callback_data: 'style_aggressive' }, { text: '⚖️ 稳健型', callback_data: 'style_balanced' }],
                [{ text: '📊 量化型', callback_data: 'style_quantitative' }],
            ]
        });
        return;
    }
    if (data === 'settings_frequency') {
        await answerCallback(callbackQuery.id);
        await sendMessageWithKeyboard(chatId, '选择每日发布频率：', {
            inline_keyboard: [
                [{ text: '1 篇/天', callback_data: 'freq_1' }, { text: '2 篇/天', callback_data: 'freq_2' }],
                [{ text: '3 篇/天', callback_data: 'freq_3' }],
            ]
        });
        return;
    }
    if (data === 'settings_content_types') {
        await answerCallback(callbackQuery.id);
        const currentTypes = (user.content_types || '').split(',');
        const makeButtons = () => {
            const btns = [];
            const allTypes = ['short', 'poll'];
            for (let i = 0; i < allTypes.length; i += 2) {
                const row = [];
                for (let j = i; j < Math.min(i + 2, allTypes.length); j++) {
                    const t = allTypes[j];
                    const checked = currentTypes.includes(t) ? ' ✅' : '';
                    row.push({ text: (typeLabels[t] || t) + checked, callback_data: `toggle_type_${t}` });
                }
                btns.push(row);
            }
            btns.push([{ text: '✅ 确认', callback_data: 'save_content_types' }]);
            return btns;
        };
        await sendMessageWithKeyboard(chatId, '选择要启用的内容类型（点选切换，可多选）：', {
            inline_keyboard: makeButtons()
        });
        return;
    }
    const toggleTypeMatch = data.match(/^toggle_type_(.+)$/);
    if (toggleTypeMatch) {
        const toggledType = toggleTypeMatch[1];
        let currentTypes = (user.content_types || '').split(',').filter(Boolean);
        if (currentTypes.includes(toggledType)) {
            currentTypes = currentTypes.filter(t => t !== toggledType);
        }
        else {
            currentTypes.push(toggledType);
        }
        // Update user's content_types temporarily (for toggle UX)
        user.content_types = currentTypes.join(',');
        userService.updateContentTypes(user.telegram_id, user.content_types);
        const allTypes = ['short', 'poll'];
        const makeButtons = () => {
            const btns = [];
            for (let i = 0; i < allTypes.length; i += 2) {
                const row = [];
                for (let j = i; j < Math.min(i + 2, allTypes.length); j++) {
                    const t = allTypes[j];
                    const checked = currentTypes.includes(t) ? ' ✅' : '';
                    row.push({ text: (typeLabels[t] || t) + checked, callback_data: `toggle_type_${t}` });
                }
                btns.push(row);
            }
            btns.push([{ text: '✅ 确认', callback_data: 'save_content_types' }]);
            return btns;
        };
        await answerCallback(callbackQuery.id, `${currentTypes.includes(toggledType) ? '已启用' : '已关闭'} ${typeLabels[toggledType] || toggledType}`);
        await editMessageWithKeyboard(chatId, msgId, '选择要启用的内容类型（点选切换，可多选）：', {
            inline_keyboard: makeButtons()
        });
        return;
    }
    if (data === 'save_content_types') {
        const currentTypes = (user.content_types || '').split(',').filter(Boolean);
        if (currentTypes.length === 0) {
            await answerCallback(callbackQuery.id, '❌ 至少选择一种内容类型');
            return;
        }
        const labels = currentTypes.map(t => typeLabels[t] || t).join('、');
        await answerCallback(callbackQuery.id, '✅ 已保存');
        await editMessage(chatId, msgId, `✅ 内容类型已更新：${labels}`);
        return;
    }
    // ============ 内容子模板设置 ============
    const makeSubTplButtons = (group, names, currentNames) => {
        const btns = [];
        for (let i = 0; i < names.length; i += 2) {
            const row = [];
            for (let j = i; j < Math.min(i + 2, names.length); j++) {
                const n = names[j];
                const checked = currentNames.includes(n) ? ' ✅' : '';
                row.push({ text: n + checked, callback_data: `t_${group}_${j}` });
            }
            btns.push(row);
        }
        btns.push([{ text: '✅ 确认保存', callback_data: `save_subtpl_${group}` }]);
        return btns;
    };
    if (data === 'settings_local_tpl') {
        await answerCallback(callbackQuery.id);
        const enabledNames = (user.enabled_templates || '').split(',').filter(Boolean);
        const currentNames = SHORT_TEMPLATE_NAMES.filter(n => enabledNames.includes(n));
        await sendMessageWithKeyboard(chatId, '📈 选择要启用的行情短贴模板（仅需行情数据，可多选）：', {
            inline_keyboard: makeSubTplButtons('local', SHORT_TEMPLATE_NAMES, currentNames)
        });
        return;
    }
    if (data === 'settings_news_tpl') {
        await answerCallback(callbackQuery.id);
        const enabledNames = (user.enabled_templates || '').split(',').filter(Boolean);
        const currentNames = SERVER_SHORT_TEMPLATE_NAMES.filter(n => enabledNames.includes(n));
        await sendMessageWithKeyboard(chatId, '📰 选择要启用的新闻短贴模板（需要AI+搜索，可多选）：', {
            inline_keyboard: makeSubTplButtons('news', SERVER_SHORT_TEMPLATE_NAMES, currentNames)
        });
        return;
    }
    if (data === 'settings_poll_tpl') {
        await answerCallback(callbackQuery.id);
        const enabledNames = (user.enabled_templates || '').split(',').filter(Boolean);
        const currentNames = POLL_TEMPLATE_NAMES.filter(n => enabledNames.includes(n));
        await sendMessageWithKeyboard(chatId, '📊 选择要启用的投票贴模板（仅需行情数据，可多选）：', {
            inline_keyboard: makeSubTplButtons('poll', POLL_TEMPLATE_NAMES, currentNames)
        });
        return;
    }
    // 推广贴模板设置
    if (data === 'settings_promo_tpl') {
        await answerCallback(callbackQuery.id);
        const enabledNames = (user.enabled_templates || '').split(',').filter(Boolean);
        const currentNames = PROMO_TEMPLATE_NAMES.filter(n => enabledNames.includes(n));
        await sendMessageWithKeyboard(chatId, '📢 选择要启用的推广贴模板（可多选）：', {
            inline_keyboard: makeSubTplButtons('promo', PROMO_TEMPLATE_NAMES, currentNames)
        });
        return;
    }
    const toggleSubTplMatch = data.match(/^t_(local|news|poll|promo)_(\d+)$/);
    if (toggleSubTplMatch) {
        const group = toggleSubTplMatch[1];
        const idx = parseInt(toggleSubTplMatch[2]);
        const nameMap = { local: SHORT_TEMPLATE_NAMES, news: SERVER_SHORT_TEMPLATE_NAMES, poll: POLL_TEMPLATE_NAMES, promo: PROMO_TEMPLATE_NAMES };
        const allNames = nameMap[group];
        const toggledName = allNames[idx];
        if (!toggledName) {
            await answerCallback(callbackQuery.id, '❌ 错误');
            return;
        }
        let enabledNames = (user.enabled_templates || '').split(',').filter(Boolean);
        if (enabledNames.includes(toggledName)) {
            enabledNames = enabledNames.filter(n => n !== toggledName);
        }
        else {
            enabledNames.push(toggledName);
        }
        user.enabled_templates = enabledNames.join(',');
        userService.updateEnabledTemplates(user.telegram_id, user.enabled_templates);
        const currentNames = allNames.filter(n => enabledNames.includes(n));
        const groupLabels = { local: '📈 行情短贴模板', news: '📰 新闻短贴模板', poll: '📊 投票贴模板', promo: '📢 推广贴模板' };
        await answerCallback(callbackQuery.id, `${enabledNames.includes(toggledName) ? '已启用' : '已关闭'} ${toggledName}`);
        await editMessageWithKeyboard(chatId, msgId, `${groupLabels[group]}（点选切换，可多选）：`, {
            inline_keyboard: makeSubTplButtons(group, allNames, currentNames)
        });
        return;
    }
    const saveSubTplMatch = data.match(/^save_subtpl_(local|news|poll|promo)$/);
    if (saveSubTplMatch) {
        const group = saveSubTplMatch[1];
        const nameMap = { local: SHORT_TEMPLATE_NAMES, news: SERVER_SHORT_TEMPLATE_NAMES, poll: POLL_TEMPLATE_NAMES, promo: PROMO_TEMPLATE_NAMES };
        const groupLabels = { local: '📈 行情短贴模板', news: '📰 新闻短贴模板', poll: '📊 投票贴模板', promo: '📢 推广贴模板' };
        const allNames = nameMap[group];
        const enabledNames = (user.enabled_templates || '').split(',').filter(Boolean);
        const currentNames = allNames.filter(n => enabledNames.includes(n));
        if (currentNames.length === 0) {
            return;
        }
        const groupLabels2 = { local: '📈 行情短贴模板', news: '📰 新闻短贴模板', poll: '📊 投票贴模板', promo: '📢 推广贴模板' };
        await answerCallback(callbackQuery.id, '✅ 已保存');
        await editMessage(chatId, msgId, `✅ ${groupLabels2[group]}已更新：${currentNames.join('、')}`);
        return;
    }
    const freqMatch = data.match(/^freq_(\d+)$/);
    if (freqMatch) {
        const freq = parseInt(freqMatch[1]);
        userService.updateFrequency(user.telegram_id, freq);
        await answerCallback(callbackQuery.id, '✅ 已更新');
        await sendMessage(chatId, `✅ 发布频率已设为 ${freq} 篇/天`);
        return;
    }
    // ============ 新闻管道回调 ============
    // 发布新闻到币安广场
    const pubNewsMatch = data.match(/^pub:(.+)$/);
    if (pubNewsMatch) {
        const newsId = pubNewsMatch[1];
        try {
            const { readFileSync } = await import('fs');
            const { join } = await import('path');
            const { homedir } = await import('os');
            const newsDir = join(homedir(), 'clawd/square-agent/news-pipeline/data');
            // 从 pipeline-state.json 或 interpreted-news.json 中查找
            let newsItem = null;
            try {
                const state = JSON.parse(readFileSync(join(newsDir, 'pipeline-state.json'), 'utf8'));
                newsItem = state.outputs.find((o) => o.id === newsId);
            }
            catch { }
            if (!newsItem) {
                try {
                    const interp = JSON.parse(readFileSync(join(newsDir, 'interpreted-news.json'), 'utf8'));
                    newsItem = interp.find((o) => o.id === newsId);
                }
                catch { }
            }
            if (!newsItem || !newsItem.interpretedContent) {
                await answerCallback(callbackQuery.id, '❌ 找不到这条新闻');
                return;
            }
            await answerCallback(callbackQuery.id, '⏳ 发布中...');
            // 直接创建 post（和 /preview 流程一致），用户可以后续批准发布
            const newPost = postService.createPost(user.id, newsItem.interpretedContent, ['BTC', '加密分析'], '📰 新闻快讯');
            await editMessage(chatId, msgId, `✅ 新闻已保存为帖子 (#${newPost.id})\n\n${newsItem.interpretedContent.slice(0, 200)}...\n\n📅 在 Mac 上运行 Agent 即可自动发布到币安广场。`);
        }
        catch (e) {
            await answerCallback(callbackQuery.id, '❌ 错误');
            await sendMessage(chatId, `❌ 发布异常: ${e.message}`);
        }
        return;
    }
    // 丢弃新闻
    const delNewsMatch = data.match(/^del:(.+)$/);
    if (delNewsMatch) {
        await answerCallback(callbackQuery.id, '🗑️ 已丢弃');
        await editMessage(chatId, msgId, '🗑️ 新闻已丢弃。');
        return;
    }
}
async function handleCommand(chatId, from, command, parts) {
    const tgId = from.id;
    const user = userService.findByTelegramId(tgId);
    switch (command) {
        case 'start':
            await handleStart(chatId, from);
            break;
        case 'token':
            if (!user) {
                await sendMessage(chatId, '❌ 请先 /start 注册');
                return;
            }
            const tokenRow = db.prepare('SELECT agent_token FROM users WHERE telegram_id = ?').get(tgId);
            await sendMessage(chatId, `🔑 你的 Agent 安装令牌：\n\n${tokenRow?.agent_token || '未生成，请联系管理员'}\n\n安装命令：\ncurl -sL https://api.square-agent.com/install.sh | AGENT_TOKEN=${tokenRow?.agent_token} bash`);
            break;
        case 'preview': {
            if (!user || user.status !== 'active') {
                await sendMessage(chatId, '❌ 你的账号还未审核通过，请等待管理员开通。');
                return;
            }
            await sendMessage(chatId, '⏳ 正在生成内容，请稍等...');
            const contentTypes = user.content_types.split(',').filter(Boolean);
            if (contentTypes.length === 0) {
                await sendMessage(chatId, '❌ 请先在 /settings 中设置内容类型');
                return;
            }
            const cmdTypeLabels = { short: '📝 短贴', poll: '📊 投票贴' };
            const contentType = contentTypes[Math.floor(Math.random() * contentTypes.length)];
            const enabledTplNames = (user.enabled_templates || '').split(',').filter(Boolean);
            // 排除今天已用过的模板
            const usedNames = postService.getTodayUsedTemplateNames(user.id);
            const excludeUsed = enabledTplNames.filter(n => !usedNames.includes(n));
            if (excludeUsed.length === 0) {
                await sendMessage(chatId, '⚠️ 今天所有模板都已用过啦，明天再来吧！\n或者去 /settings 启用更多模板。');
                return;
            }
            const content = await generateContent(user.style, contentType, undefined, excludeUsed, { baseUrl: 'http://127.0.0.1:5577', token: user.agent_token });
            const post = postService.createPost(user.id, content.content, content.topics, content.templateName);
            await sendMessageWithKeyboard(chatId, `📝 内容预览 (#${post.id}) [${cmdTypeLabels[contentType] || contentType} | ${content.templateName}]\n\n${content.content}\n\n---\n选择操作：`, {
                inline_keyboard: [
                    [{ text: '✅ 批准发布', callback_data: `approve_${post.id}` }, { text: '🔄 重新生成', callback_data: `regenerate_${post.id}` }],
                    [{ text: '🗑️ 丢弃', callback_data: `reject_${post.id}` }],
                ]
            });
            break;
        }
        case 'settings': {
            if (!user || user.status !== 'active') {
                await sendMessage(chatId, '❌ 你的账号还未审核通过。');
                return;
            }
            const styleNames = { aggressive: '🔥 激进型', balanced: '⚖️ 稳健型', quantitative: '📊 量化型' };
            const cmdTypeLabels = { short: '📝 短贴', poll: '📊 投票贴' };
            const contentTypeDisplay = (user.content_types || '').split(',').filter(Boolean).map(t => cmdTypeLabels[t] || t).join('、') || '未设置';
            const enabledNames = (user.enabled_templates || '').split(',').filter(Boolean);
            const enabledLocalShort = SHORT_TEMPLATE_NAMES.filter(n => enabledNames.includes(n));
            const enabledServerShort = SERVER_SHORT_TEMPLATE_NAMES.filter(n => enabledNames.includes(n));
            const enabledPoll = POLL_TEMPLATE_NAMES.filter(n => enabledNames.includes(n));
            const enabledPromo = PROMO_TEMPLATE_NAMES.filter(n => enabledNames.includes(n));
            const localDisplay = enabledLocalShort.length > 0 ? enabledLocalShort.join('、') : '未设置';
            const newsDisplay = enabledServerShort.length > 0 ? enabledServerShort.join('、') : '未设置';
            const pollDisplay = enabledPoll.length > 0 ? enabledPoll.join('、') : '未设置';
            const promoDisplay = enabledPromo.length > 0 ? enabledPromo.join('、') : '未设置';
            await sendMessageWithKeyboard(chatId, `⚙️ 当前设置\n\n🎨 风格：${styleNames[user.style] || user.style}\n📊 频率：${user.frequency} 篇/天\n📋 内容类型：${contentTypeDisplay}\n📈 行情短贴模板：${localDisplay}\n📰 新闻短贴模板：${newsDisplay}\n📊 投票贴模板：${pollDisplay}\n📢 推广贴模板：${promoDisplay}\n\n修改设置：`, {
                inline_keyboard: [
                    [{ text: '🎨 修改风格', callback_data: 'settings_style' }, { text: '📊 修改频率', callback_data: 'settings_frequency' }],
                    [{ text: '📋 修改内容类型', callback_data: 'settings_content_types' }],
                    [{ text: '📈 修改行情短贴模板', callback_data: 'settings_local_tpl' }, { text: '📰 修改新闻短贴模板', callback_data: 'settings_news_tpl' }],
                    [{ text: '📊 修改投票贴模板', callback_data: 'settings_poll_tpl' }, { text: '📢 修改推广贴模板', callback_data: 'settings_promo_tpl' }],
                ]
            });
            break;
        }
        case 'stats':
            if (!user || user.status !== 'active') {
                await sendMessage(chatId, '❌ 你的账号还未审核通过。');
                return;
            }
            const stats = postService.getPostStats(user.id);
            const todayPosts2 = postService.getTodayPosts(user.id);
            const todayApproved = todayPosts2.filter(p => p.status === 'approved').length;
            const todayRejected = todayPosts2.filter(p => p.status === 'rejected').length;
            const todayPublished = todayPosts2.filter(p => p.status === 'published').length;
            const todayDraft = todayPosts2.filter(p => p.status === 'draft').length;
            await sendMessage(chatId, `📈 数据统计\n\n`
                + `📊 总计：${stats.total} 篇\n`
                + `✅ 已发布：${stats.published} | 📝 草稿：${stats.total - stats.published - stats.approved - stats.rejected} | ⏳ 待发布：${stats.approved} | 🗑️ 已丢弃：${stats.rejected}\n\n`
                + `📅 今日（${stats.today} 篇）\n`
                + `  ✅ 已发布：${todayPublished}\n`
                + `  📝 草稿：${todayDraft}\n`
                + `  ⏳ 待发布：${todayApproved}\n`
                + `  🗑️ 已丢弃：${todayRejected}`);
            break;
        case 'history':
            if (!user)
                return;
            const allPosts = postService.getAllPosts(user.id, 10);
            if (allPosts.length === 0) {
                await sendMessage(chatId, '📭 还没有内容记录。');
                return;
            }
            const emoji2 = { draft: '📝', approved: '⏳', published: '✅', rejected: '🗑️', failed: '❌' };
            const lines2 = allPosts.map(p => {
                const title = p.content.split('\n')[0].substring(0, 35);
                return `${emoji2[p.status] || '❓'} #${p.id} ${title}...`;
            });
            await sendMessage(chatId, `📝 最近内容（${allPosts.length} 条）\n\n${lines2.join('\n')}`);
            break;
        case 'unregister':
            if (!user) {
                await sendMessage(chatId, '❌ 你还没有注册。');
                return;
            }
            const deleted = userService.deleteUser(tgId);
            if (deleted) {
                await sendMessage(chatId, '✅ 已注销账号。\n\n已删除：\n• 你的用户信息\n• 所有帖子记录\n• Agent 注册信息\n\n⚠️ 如果已安装 Agent，请手动执行：\ncurl -sL https://api.square-agent.com/uninstall.sh | bash\n\n如需重新使用，发送 /start 即可。');
            }
            else {
                await sendMessage(chatId, '❌ 注销失败，请联系管理员。');
            }
            break;
        case 'schedule':
            if (!user || user.status !== 'active') {
                await sendMessage(chatId, '❌ 你的账号还未审核通过。');
                return;
            }
            const schedParts = parts || [];
            const subCmd = schedParts[1] || 'list';
            if (subCmd === 'list') {
                try {
                    const schedRes = await localFetch(`http://127.0.0.1:${process.env.SERVER_PORT || 5577}/api/schedules`, {
                        headers: { 'X-Agent-Token': user.agent_token }
                    });
                    const schedData = await schedRes.json();
                    if (!schedData.schedules || schedData.schedules.length === 0) {
                        await sendMessage(chatId, `📅 定时任务\n\n当前没有定时任务\n\n添加任务：\n/schedule add 模板ID cron表达式\n/schedule add tpl_morning_brief \"0 8 * * *\"\n\n可用模板：\n• tpl_morning_brief - 🌅 每日早报\n• tpl_evening_recap - 🌙 晚间复盘\n• tpl_breaking_news - 📰 新闻解读\n• tpl_onchain_signal - ⚡ 链上速报\n• tpl_price_move - 🚨 价格异动\n• tpl_deep_analysis - 📊 深度分析\n• tpl_hot_comment - 💬 热点短评\n• tpl_chart_analysis - 📈 盘面分析\n• tpl_macro_analysis - 🏛️ 宏观解读\n• tpl_promo_post - 📢 推广贴`);
                    }
                    else {
                        const lines = schedData.schedules.map(s => `• ${s.id.slice(0, 12)}... | ${s.template_id} | ${s.cron_expr} | ${s.enabled ? '✅' : '❌'}`);
                        await sendMessage(chatId, `📅 定时任务\n\n${lines.join('\n')}\n\n/schedule remove ID - 删除\n/schedule toggle ID - 启用/禁用`);
                    }
                }
                catch (e) {
                    await sendMessage(chatId, `❌ 获取定时任务失败: ${e.message}`);
                }
            }
            else if (subCmd === 'add') {
                const templateId = schedParts[2];
                const cronExpr = schedParts.slice(3).join(' ');
                if (!templateId || !cronExpr) {
                    await sendMessage(chatId, '用法: /schedule add 模板ID cron表达式\n例: /schedule add tpl_morning_brief "0 8 * * *"');
                    return;
                }
                try {
                    const res = await localFetch(`http://127.0.0.1:${process.env.SERVER_PORT || 5577}/api/schedules`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Agent-Token': user.agent_token },
                        body: JSON.stringify({ template_id: templateId, cron_expr: cronExpr, timezone: 'Asia/Shanghai' })
                    });
                    const data = await res.json();
                    if (data.ok) {
                        await sendMessage(chatId, `✅ 定时任务已添加\n\n模板: ${templateId}\n时间: ${cronExpr}\nID: ${data.schedule_id}`);
                    }
                    else {
                        await sendMessage(chatId, `❌ 添加失败: ${data.error}`);
                    }
                }
                catch (e) {
                    await sendMessage(chatId, `❌ 添加失败: ${e.message}`);
                }
            }
            else if (subCmd === 'remove') {
                const schedId = schedParts[2];
                if (!schedId) {
                    await sendMessage(chatId, '用法: /schedule remove 任务ID');
                    return;
                }
                try {
                    await localFetch(`http://127.0.0.1:${process.env.SERVER_PORT || 5577}/api/schedules/${schedId}`, {
                        method: 'DELETE', headers: { 'X-Agent-Token': user.agent_token }
                    });
                    await sendMessage(chatId, `✅ 已删除定时任务 ${schedId}`);
                }
                catch (e) {
                    await sendMessage(chatId, `❌ 删除失败: ${e.message}`);
                }
            }
            else {
                await sendMessage(chatId, `📅 定时任务管理\n\n/schedule list - 查看所有任务\n/schedule add 模板ID cron - 添加任务\n/schedule remove ID - 删除任务\n\n可用模板：\n• tpl_morning_brief - 🌅 每日早报\n• tpl_evening_recap - 🌙 晚间复盘\n• tpl_breaking_news - 📰 新闻解读\n• tpl_onchain_signal - ⚡ 链上速报\n• tpl_price_move - 🚨 价格异动\n• tpl_deep_analysis - 📊 深度分析\n• tpl_hot_comment - 💬 热点短评\n• tpl_chart_analysis - 📈 盘面分析\n• tpl_macro_analysis - 🏛️ 宏观解读\n• tpl_promo_post - 📢 推广贴`);
            }
            break;
        case 'help':
            await sendMessage(chatId, `🆘 帮助\n\n命令列表：\n/start - 开始使用\n/preview - 生成并预览内容\n/schedule - 管理定时任务\n/settings - 修改偏好设置\n/stats - 查看今日数据\n/history - 查看发布历史\n/unregister - 注销账号并删除数据\n/help - 显示此帮助\n\n💡 使用流程：\n1. /schedule add tpl_morning_brief \"0 8 * * *\" 设置定时\n2. 或 /preview 手动生成内容\n3. 批准后自动发布到币安广场`);
            break;
        case 'admin_pending':
            const pending = userService.getPendingUsers();
            if (pending.length === 0) {
                await sendMessage(chatId, '✅ 没有待审核用户');
                return;
            }
            const pLines = pending.map(u => `• ${u.telegram_username || u.telegram_id} | UID: ${u.binance_uid || '未填'}`);
            await sendMessage(chatId, `⏳ 待审核用户 (${pending.length})\n\n${pLines.join('\n')}\n\n输入 /admin_approve <telegram_id> 开通`);
            break;
        case 'admin_approve':
            // handled separately with args
            await sendMessage(chatId, '用法：/admin_approve <telegram_id>');
            break;
    }
}
// ============ Setup proxy ============
const proxyUrl = process.env.HTTPS_PROXY || '';
if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`🔗 Global proxy: ${proxyUrl}`);
}
// ============ Start ============
(async () => {
    console.log('🤖 SquareAgent Bot starting...');
    console.log(`🔑 Token prefix: ${TOKEN.substring(0, 10)}...`);
    const me = await tgApi('getMe');
    console.log(`✅ Bot connected: @${me.username} (id: ${me.id})`);
    while (true) {
        try {
            const updates = await tgApi('getUpdates', {
                offset: lastUpdateId + 1,
                timeout: 10,
            });
            for (const update of updates) {
                lastUpdateId = update.update_id;
                console.log(`[Update] id=${update.update_id}`);
                try {
                    if (update.message) {
                        const msg = update.message;
                        const chatId = msg.chat.id;
                        if (msg.text?.startsWith('/')) {
                            const parts = msg.text.split(' ');
                            const cmd = parts[0].replace('/', '').split('@')[0];
                            if ((cmd === 'admin_approve' || cmd === 'adminapprove') && parts[1]) {
                                const arg = parts[1].replace('@', '');
                                let targetUser;
                                const tid = parseInt(arg);
                                if (!isNaN(tid)) {
                                    targetUser = userService.findByTelegramId(tid);
                                }
                                else {
                                    const row = db.prepare('SELECT * FROM users WHERE telegram_username = ?').get(arg);
                                    if (row)
                                        targetUser = row;
                                }
                                if (!targetUser) {
                                    await sendMessage(chatId, '❌ 用户不存在。用 /admin_pending 查看待审核用户');
                                }
                                else {
                                    const agentToken = userService.approveUser(targetUser.telegram_id);
                                    try {
                                        await sendMessage(targetUser.telegram_id, `🎉 你的账号已开通！\n\n开始使用：\n• /preview - 生成第一篇内容\n• /settings - 调整偏好设置\n\n🚀 安装 Agent（在 Mac 终端运行）：\n\`\`\`\ncurl -sL https://api.square-agent.com/install.sh | AGENT_TOKEN=${agentToken} bash\n\`\`\`\n\n⚠️ 确保 Chrome 已打开并登录币安\n\n祝你运营顺利 🚀`);
                                    }
                                    catch { }
                                    await sendMessage(chatId, `✅ 已开通 @${targetUser.telegram_username || targetUser.telegram_id}\n🔑 Agent令牌: ${agentToken}`);
                                }
                            }
                            else {
                                await handleCommand(chatId, msg.from, cmd, parts);
                            }
                        }
                        else if (msg.text) {
                            await handleText(chatId, msg.from, msg.text);
                        }
                    }
                    if (update.callback_query) {
                        await handleCallback(update.callback_query);
                    }
                }
                catch (err) {
                    console.error('[Handler error]', err);
                }
            }
        }
        catch (err) {
            if (err.message?.includes('409')) {
                console.error('⚠️ 409 conflict, waiting 40s...');
                await new Promise(r => setTimeout(r, 40000));
            }
            else {
                console.error('[Poll error]', err.message);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
})();
// ============ 发布结果通知 + WAL checkpoint ============
import { readdirSync, unlinkSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import _path from 'path';
const _botDir = _path.dirname(fileURLToPath(import.meta.url));
// tsx 编译: import.meta.url 指向 src/bot.ts → ../data = project/data
const _notifyDir = (() => {
    const c1 = _path.join(_botDir, '../data/notifications');
    const c2 = _path.join(_botDir, 'data/notifications');
    try {
        readdirSync(c1);
        return c1;
    }
    catch { }
    try {
        readdirSync(c2);
        return c2;
    }
    catch { }
    console.error('❌ notifications dir not found');
    return '/tmp/notifications';
})();
console.log(`📬 Notify dir: ${_notifyDir}`);
setInterval(async () => {
    try {
        const files = readdirSync(_notifyDir).filter((f) => f.endsWith('.json'));
        if (files.length === 0)
            return;
        for (const file of files) {
            const filePath = _path.join(_notifyDir, file);
            try {
                const notify = JSON.parse(readFileSync(filePath, 'utf8'));
                const post = db.prepare('SELECT id, user_id, status, substr(content,1,80) as preview FROM posts WHERE id = ?').get(notify.postId);
                if (!post) {
                    unlinkSync(filePath);
                    continue;
                }
                const user = userService.findById(post.user_id);
                if (!user) {
                    unlinkSync(filePath);
                    continue;
                }
                db.prepare('UPDATE posts SET status = ?, published_at = datetime(\'now\'), binance_post_id = ? WHERE id = ?').run(notify.status, notify.binancePostId || null, notify.postId);
                if (notify.status === 'published') {
                    await sendMessage(user.telegram_id, `✅ 发布成功！\n\n📝 帖子 #${notify.postId}\n${post.preview}...\n🕐 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
                }
                else {
                    await sendMessage(user.telegram_id, `❌ 发布失败\n\n📝 帖子 #${notify.postId}\n${post.preview}...\n\n可以 /preview 生成新内容`);
                }
                console.log(`📬 已通知: #${notify.postId} → ${notify.status}`);
                unlinkSync(filePath);
            }
            catch (err) {
                console.error('[Notify file error]', file, err);
                try {
                    unlinkSync(filePath);
                }
                catch { }
            }
        }
    }
    catch (err) {
        console.error('[Notify scan error]', err.message);
    }
}, 5000);
// WAL checkpoint
setInterval(() => {
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    }
    catch { }
}, 5000);
