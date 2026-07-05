import db from '../db/schema.js';
export function findByTelegramId(telegramId) {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}
export function findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function createUser(telegramId, username) {
    const stmt = db.prepare(`
    INSERT INTO users (telegram_id, telegram_username, status)
    VALUES (?, ?, 'pending')
  `);
    const result = stmt.run(telegramId, username);
    return findById(result.lastInsertRowid);
}
export function updateBinanceUid(telegramId, uid) {
    db.prepare('UPDATE users SET binance_uid = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
        .run(uid, telegramId);
}
export function updateStyle(telegramId, style) {
    db.prepare('UPDATE users SET style = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
        .run(style, telegramId);
}
export function updateFrequency(telegramId, frequency) {
    db.prepare('UPDATE users SET frequency = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
        .run(frequency, telegramId);
}
export function updateContentTypes(telegramId, types) {
    db.prepare('UPDATE users SET content_types = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
        .run(types, telegramId);
}
export function updateEnabledTemplates(telegramId, templates) {
    db.prepare('UPDATE users SET enabled_templates = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
        .run(templates, telegramId);
}
export function approveUser(telegramId) {
    const token = `bsq_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
    db.prepare("UPDATE users SET status = 'active', agent_token = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?")
        .run(token, telegramId);
    return token;
}
export function getPendingUsers() {
    return db.prepare("SELECT * FROM users WHERE status = 'pending'").all();
}
export function getActiveUsers() {
    return db.prepare("SELECT * FROM users WHERE status = 'active'").all();
}
export function deleteUser(telegramId) {
    const user = findByTelegramId(telegramId);
    if (!user)
        return false;
    // Delete posts first (FK), then agents, then user
    db.prepare('DELETE FROM posts WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM agents WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return true;
}
