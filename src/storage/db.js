import Database from 'better-sqlite3';
import path from 'node:path';

let _db = null;

/**
 * Open (or return the cached) SQLite database and ensure all tables exist.
 */
export function getDb(dbPath) {
  if (_db) return _db;

  const resolved = path.resolve(dbPath || process.env.DATABASE_PATH || './slack-agent.db');
  _db = new Database(resolved);

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');

  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    -----------------------------------------------------------------
    -- Core tables
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS channels (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      is_private    INTEGER DEFAULT 0,
      topic         TEXT,
      purpose       TEXT,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      real_name     TEXT,
      display_name  TEXT,
      is_bot        INTEGER DEFAULT 0,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      ts            TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      user_id       TEXT,
      text          TEXT,
      thread_ts     TEXT,
      reply_count   INTEGER DEFAULT 0,
      reactions     TEXT,          -- JSON array
      attachments   TEXT,          -- JSON array
      permalink     TEXT,
      raw           TEXT,          -- full JSON payload
      imported_at   TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, ts)
    );

    -- Index for thread lookups
    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(channel_id, thread_ts) WHERE thread_ts IS NOT NULL;

    -- Index for user lookups
    CREATE INDEX IF NOT EXISTS idx_messages_user
      ON messages(user_id);

    -- Index for chronological queries
    CREATE INDEX IF NOT EXISTS idx_messages_time
      ON messages(ts);

    -----------------------------------------------------------------
    -- Full-text search virtual table (FTS5)
    -----------------------------------------------------------------
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      user_name,
      channel_name,
      content = 'messages',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    );

    -----------------------------------------------------------------
    -- Triggers to keep FTS in sync
    -----------------------------------------------------------------
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, user_name, channel_name)
      VALUES (
        new.rowid,
        new.text,
        COALESCE((SELECT display_name FROM users WHERE id = new.user_id),
                 (SELECT name FROM users WHERE id = new.user_id), ''),
        COALESCE((SELECT name FROM channels WHERE id = new.channel_id), '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, user_name, channel_name)
      VALUES ('delete', old.rowid, old.text,
        COALESCE((SELECT display_name FROM users WHERE id = old.user_id),
                 (SELECT name FROM users WHERE id = old.user_id), ''),
        COALESCE((SELECT name FROM channels WHERE id = old.channel_id), '')
      );
    END;

    -----------------------------------------------------------------
    -- Import tracking
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS import_cursors (
      channel_id    TEXT PRIMARY KEY,
      oldest_ts     TEXT,
      latest_ts     TEXT,
      updated_at    TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ── Upsert helpers ──────────────────────────────────────────────

export function upsertChannel(db, ch) {
  db.prepare(`
    INSERT INTO channels (id, name, is_private, topic, purpose, updated_at)
    VALUES (@id, @name, @is_private, @topic, @purpose, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      is_private = excluded.is_private,
      topic = excluded.topic,
      purpose = excluded.purpose,
      updated_at = datetime('now')
  `).run({
    id: ch.id,
    name: ch.name ?? ch.id,
    is_private: ch.is_private ? 1 : 0,
    topic: ch.topic?.value ?? '',
    purpose: ch.purpose?.value ?? '',
  });
}

export function upsertUser(db, u) {
  db.prepare(`
    INSERT INTO users (id, name, real_name, display_name, is_bot, updated_at)
    VALUES (@id, @name, @real_name, @display_name, @is_bot, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      real_name = excluded.real_name,
      display_name = excluded.display_name,
      is_bot = excluded.is_bot,
      updated_at = datetime('now')
  `).run({
    id: u.id,
    name: u.name ?? '',
    real_name: u.real_name ?? u.profile?.real_name ?? '',
    display_name: u.profile?.display_name ?? '',
    is_bot: u.is_bot ? 1 : 0,
  });
}

export function upsertMessage(db, msg, channelId) {
  db.prepare(`
    INSERT INTO messages (ts, channel_id, user_id, text, thread_ts, reply_count,
                          reactions, attachments, permalink, raw)
    VALUES (@ts, @channel_id, @user_id, @text, @thread_ts, @reply_count,
            @reactions, @attachments, @permalink, @raw)
    ON CONFLICT(channel_id, ts) DO UPDATE SET
      text        = excluded.text,
      reply_count = excluded.reply_count,
      reactions   = excluded.reactions,
      attachments = excluded.attachments,
      permalink   = excluded.permalink,
      raw         = excluded.raw
  `).run({
    ts: msg.ts,
    channel_id: channelId,
    user_id: msg.user ?? msg.bot_id ?? null,
    text: msg.text ?? '',
    thread_ts: msg.thread_ts ?? null,
    reply_count: msg.reply_count ?? 0,
    reactions: msg.reactions ? JSON.stringify(msg.reactions) : null,
    attachments: msg.attachments ? JSON.stringify(msg.attachments) : null,
    permalink: msg.permalink ?? null,
    raw: JSON.stringify(msg),
  });
}

// ── Query helpers ───────────────────────────────────────────────

/**
 * Full-text search across all stored messages.
 * Returns messages with user and channel names attached.
 */
export function searchMessages(db, query, { limit = 25, channelId, userId, before, after } = {}) {
  let where = `messages_fts MATCH @query`;
  const params = { query, limit };

  if (channelId) { where += ` AND m.channel_id = @channelId`; params.channelId = channelId; }
  if (userId)    { where += ` AND m.user_id = @userId`;       params.userId = userId; }
  if (before)    { where += ` AND m.ts < @before`;            params.before = before; }
  if (after)     { where += ` AND m.ts > @after`;             params.after = after; }

  return db.prepare(`
    SELECT m.ts, m.channel_id, m.user_id, m.text, m.thread_ts,
           m.reply_count, m.reactions, m.permalink,
           u.display_name AS user_display_name,
           u.real_name    AS user_real_name,
           u.name         AS user_name,
           c.name         AS channel_name,
           rank
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    LEFT JOIN users u    ON u.id = m.user_id
    LEFT JOIN channels c ON c.id = m.channel_id
    WHERE ${where}
    ORDER BY rank
    LIMIT @limit
  `).all(params);
}

/**
 * Get messages surrounding a specific timestamp for context.
 */
export function getContext(db, channelId, ts, windowSize = 10) {
  return db.prepare(`
    SELECT m.ts, m.user_id, m.text, m.thread_ts,
           u.display_name AS user_display_name,
           u.name AS user_name,
           c.name AS channel_name
    FROM messages m
    LEFT JOIN users u    ON u.id = m.user_id
    LEFT JOIN channels c ON c.id = m.channel_id
    WHERE m.channel_id = @channelId
      AND m.ts BETWEEN
        (SELECT ts FROM messages WHERE channel_id = @channelId AND ts <= @ts ORDER BY ts DESC LIMIT 1 OFFSET @half)
        AND
        (SELECT ts FROM messages WHERE channel_id = @channelId AND ts >= @ts ORDER BY ts ASC  LIMIT 1 OFFSET @half)
    ORDER BY m.ts ASC
  `).all({ channelId, ts, half: Math.floor(windowSize / 2) });
}

/**
 * Retrieve a full thread by its thread_ts.
 */
export function getThread(db, channelId, threadTs) {
  return db.prepare(`
    SELECT m.ts, m.user_id, m.text, m.thread_ts,
           u.display_name AS user_display_name,
           u.name AS user_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = @channelId
      AND (m.thread_ts = @threadTs OR m.ts = @threadTs)
    ORDER BY m.ts ASC
  `).all({ channelId, threadTs });
}

/**
 * Get recent messages from a channel.
 */
export function getRecent(db, channelId, limit = 50) {
  return db.prepare(`
    SELECT m.ts, m.user_id, m.text, m.thread_ts, m.reply_count,
           u.display_name AS user_display_name,
           u.name AS user_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = @channelId
    ORDER BY m.ts DESC
    LIMIT @limit
  `).all({ channelId, limit });
}

/**
 * Get summary stats for the database.
 */
export function getStats(db) {
  const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const channels = db.prepare('SELECT COUNT(*) as count FROM channels').get().count;
  const users    = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const threads  = db.prepare('SELECT COUNT(DISTINCT thread_ts) as count FROM messages WHERE thread_ts IS NOT NULL').get().count;
  return { messages, channels, users, threads };
}

/**
 * List all stored channels.
 */
export function listChannels(db) {
  return db.prepare('SELECT id, name, is_private, topic, purpose FROM channels ORDER BY name').all();
}

/**
 * Get messages by a specific user, optionally filtered to a channel.
 */
export function getMessagesByUser(db, userId, { channelId, limit = 50 } = {}) {
  let sql = `
    SELECT m.ts, m.channel_id, m.text, m.thread_ts,
           c.name AS channel_name,
           u.display_name AS user_display_name
    FROM messages m
    LEFT JOIN channels c ON c.id = m.channel_id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.user_id = @userId
  `;
  const params = { userId, limit };
  if (channelId) { sql += ` AND m.channel_id = @channelId`; params.channelId = channelId; }
  sql += ` ORDER BY m.ts DESC LIMIT @limit`;
  return db.prepare(sql).all(params);
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
