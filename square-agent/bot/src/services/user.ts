import db from '../db/schema.js';

export interface User {
  id: number;
  telegram_id: number;
  telegram_username: string | null;
  binance_uid: string | null;
  nickname: string | null;
  style: string;
  frequency: number;
  content_types: string;
  enabled_templates: string;
  review_mode: string;
  language: string;
  coins: string;
  status: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export function findByTelegramId(telegramId: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as User | undefined;
}

export function findById(id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function createUser(telegramId: number, username: string | null): User {
  const stmt = db.prepare(`
    INSERT INTO users (telegram_id, telegram_username, status)
    VALUES (?, ?, 'pending')
  `);
  const result = stmt.run(telegramId, username);
  return findById(result.lastInsertRowid as number)!;
}

export function updateBinanceUid(telegramId: number, uid: string): void {
  db.prepare('UPDATE users SET binance_uid = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
    .run(uid, telegramId);
}

export function updateStyle(telegramId: number, style: string): void {
  db.prepare('UPDATE users SET style = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
    .run(style, telegramId);
}

export function updateFrequency(telegramId: number, frequency: number): void {
  db.prepare('UPDATE users SET frequency = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
    .run(frequency, telegramId);
}

export function updateContentTypes(telegramId: number, types: string): void {
  db.prepare('UPDATE users SET content_types = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
    .run(types, telegramId);
}

export function updateEnabledTemplates(telegramId: number, templates: string): void {
  db.prepare('UPDATE users SET enabled_templates = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
    .run(templates, telegramId);
}

export function updateReviewMode(telegramId: number, mode: string): void {
  db.prepare('UPDATE users SET review_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
    .run(mode, telegramId);
}

export function updateLanguage(telegramId: number, language: string): void {
  db.prepare('UPDATE users SET language = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
    .run(language, telegramId);
}

export function updateCoins(telegramId: number, coins: string): void {
  db.prepare('UPDATE users SET coins = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
    .run(coins, telegramId);
}

export function approveUser(telegramId: number): string {
  const token = `bsq_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
  db.prepare("UPDATE users SET status = 'active', agent_token = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?")
    .run(token, telegramId);
  return token;
}

export function getPendingUsers(): User[] {
  return db.prepare("SELECT * FROM users WHERE status = 'pending'").all() as User[];
}

export function getActiveUsers(): User[] {
  return db.prepare("SELECT * FROM users WHERE status = 'active'").all() as User[];
}

export function deleteUser(telegramId: number): boolean {
  const user = findByTelegramId(telegramId);
  if (!user) return false;
  // Delete posts first (FK), then agents, then user
  db.prepare('DELETE FROM posts WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM agents WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  return true;
}
