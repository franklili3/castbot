import db from '../db/schema.js';

export interface Post {
  id: number;
  user_id: number;
  content: string;
  status: string;
  template_name: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  binance_post_id: string | null;
  views: number;
  likes: number;
  comments: number;
  created_at: string;
}

export function createPost(userId: number, content: string, topics?: string[], templateName?: string): Post {
  const stmt = db.prepare(`
    INSERT INTO posts (user_id, content, topics, template_name, status)
    VALUES (?, ?, ?, ?, 'draft')
  `);
  const result = stmt.run(userId, content, topics ? topics.join(',') : null, templateName || null);
  return getPostById(result.lastInsertRowid as number)!;
}

export function getDraftPosts(userId: number): Post[] {
  return db.prepare("SELECT * FROM posts WHERE user_id = ? AND status = 'draft' ORDER BY created_at DESC").all(userId) as Post[];
}

export function getTodayPosts(userId: number): Post[] {
  // Use Shanghai timezone (UTC+8)
  return db.prepare("SELECT * FROM posts WHERE user_id = ? AND date(created_at, '+8 hours') = date('now', '+8 hours') ORDER BY created_at DESC").all(userId) as Post[];
}

export function getAllPosts(userId: number, limit: number = 20): Post[] {
  return db.prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as Post[];
}

export function getPostStats(userId: number): Record<string, number> {
  const total = (db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ?').get(userId) as any).c;
  const approved = (db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND status = 'approved'").get(userId) as any).c;
  const published = (db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND status = 'published'").get(userId) as any).c;
  const rejected = (db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND status = 'rejected'").get(userId) as any).c;
  const today = (db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND date(created_at, '+8 hours') = date('now', '+8 hours')").get(userId) as any).c;
  return { total, approved, published, rejected, today };
}

export function getTodayUsedTemplateNames(userId: number): string[] {
  const rows = db.prepare("SELECT DISTINCT template_name FROM posts WHERE user_id = ? AND date(created_at, '+8 hours') = date('now', '+8 hours') AND template_name IS NOT NULL").all(userId) as any[];
  return rows.map(r => r.template_name);
}

export function approvePost(postId: number): void {
  db.prepare("UPDATE posts SET status = 'approved', scheduled_at = CURRENT_TIMESTAMP WHERE id = ?").run(postId);
}

export function markPublished(postId: number, binancePostId?: string): void {
  db.prepare("UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, binance_post_id = ? WHERE id = ?")
    .run(binancePostId || null, postId);
}

export function rejectPost(postId: number): void {
  db.prepare("UPDATE posts SET status = 'rejected' WHERE id = ?").run(postId);
}

export function getPostById(postId: number): Post | undefined {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as Post | undefined;
}
