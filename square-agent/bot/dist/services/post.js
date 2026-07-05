import db from '../db/schema.js';
export function createPost(userId, content, topics, templateName) {
    const stmt = db.prepare(`
    INSERT INTO posts (user_id, content, topics, template_name, status)
    VALUES (?, ?, ?, ?, 'draft')
  `);
    const result = stmt.run(userId, content, topics ? topics.join(',') : null, templateName || null);
    return getPostById(result.lastInsertRowid);
}
export function getDraftPosts(userId) {
    return db.prepare("SELECT * FROM posts WHERE user_id = ? AND status = 'draft' ORDER BY created_at DESC").all(userId);
}
export function getTodayPosts(userId) {
    // Use Shanghai timezone (UTC+8)
    return db.prepare("SELECT * FROM posts WHERE user_id = ? AND date(created_at, '+8 hours') = date('now', '+8 hours') ORDER BY created_at DESC").all(userId);
}
export function getAllPosts(userId, limit = 20) {
    return db.prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}
export function getPostStats(userId) {
    const total = db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ?').get(userId).c;
    const approved = db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND status = 'approved'").get(userId).c;
    const published = db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND status = 'published'").get(userId).c;
    const rejected = db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND status = 'rejected'").get(userId).c;
    const today = db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND date(created_at, '+8 hours') = date('now', '+8 hours')").get(userId).c;
    return { total, approved, published, rejected, today };
}
export function getTodayUsedTemplateNames(userId) {
    const rows = db.prepare("SELECT DISTINCT template_name FROM posts WHERE user_id = ? AND date(created_at, '+8 hours') = date('now', '+8 hours') AND template_name IS NOT NULL AND status NOT IN ('rejected')").all(userId);
    return rows.map(r => r.template_name);
}
export function approvePost(postId) {
    db.prepare("UPDATE posts SET status = 'approved', scheduled_at = CURRENT_TIMESTAMP WHERE id = ?").run(postId);
}
export function markPublished(postId, binancePostId) {
    db.prepare("UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, binance_post_id = ? WHERE id = ?")
        .run(binancePostId || null, postId);
}
export function rejectPost(postId) {
    db.prepare("UPDATE posts SET status = 'rejected' WHERE id = ?").run(postId);
}
export function getPostById(postId) {
    return db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
}
