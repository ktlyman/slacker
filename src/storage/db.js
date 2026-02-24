import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

let _db = null;
let _dbPath = null;

/**
 * Expand leading ~ to the user's home directory (shell doesn't do this for env vars).
 */
function expandHome(p) {
  if (p && p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Open (or return the cached) SQLite database and ensure all tables exist.
 * Path resolution priority: explicit dbPath arg > DATABASE_PATH env > ./slack-agent.db
 */
export function getDb(dbPath) {
  const raw = dbPath || process.env.DATABASE_PATH || './slack-agent.db';
  const resolved = path.resolve(expandHome(raw));

  if (_db) {
    // Warn if called with a different path than the one already open
    if (_dbPath !== resolved) {
      console.warn(`[db] Warning: getDb() called with "${resolved}" but already open at "${_dbPath}". Using existing connection.`);
    }
    return _db;
  }

  _dbPath = resolved;
  console.error(`[db] Opening database: ${resolved}`);
  _db = new Database(resolved);

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');

  migrate(_db);
  return _db;
}

/**
 * Return the path of the currently open database (or null).
 */
export function getDbPath() {
  return _dbPath;
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
      title         TEXT DEFAULT '',
      email         TEXT DEFAULT '',
      timezone      TEXT DEFAULT '',
      status_text   TEXT DEFAULT '',
      status_emoji  TEXT DEFAULT '',
      avatar_url    TEXT DEFAULT '',
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

    -----------------------------------------------------------------
    -- Polling cursor tracking (separate from import cursors)
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS poll_cursors (
      channel_id    TEXT PRIMARY KEY,
      latest_ts     TEXT NOT NULL DEFAULT '0',
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -- Tracks when per-channel metadata (pins, bookmarks) was last synced
    CREATE TABLE IF NOT EXISTS metadata_cursors (
      channel_id    TEXT NOT NULL,
      data_type     TEXT NOT NULL,   -- 'pins' or 'bookmarks'
      updated_at    TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, data_type)
    );

    -----------------------------------------------------------------
    -- Pins
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS pins (
      channel_id    TEXT NOT NULL,
      message_ts    TEXT NOT NULL,
      pinned_by     TEXT,
      pinned_at     TEXT,
      PRIMARY KEY (channel_id, message_ts)
    );

    -----------------------------------------------------------------
    -- Bookmarks
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS bookmarks (
      id            TEXT PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      title         TEXT,
      type          TEXT,
      link          TEXT,
      emoji         TEXT DEFAULT '',
      created_by    TEXT,
      created_at    INTEGER,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -----------------------------------------------------------------
    -- Files metadata (not the file contents)
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS files (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      title         TEXT,
      mimetype      TEXT,
      filetype      TEXT,
      size          INTEGER DEFAULT 0,
      user_id       TEXT,
      url_private   TEXT,
      permalink     TEXT,
      channels      TEXT,          -- JSON array of channel IDs
      created_at    INTEGER,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -----------------------------------------------------------------
    -- User groups (@engineering, @oncall, etc.)
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS user_groups (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      handle        TEXT,
      description   TEXT DEFAULT '',
      user_ids      TEXT,          -- JSON array of user IDs
      channel_ids   TEXT,          -- JSON array of default channel IDs
      is_active     INTEGER DEFAULT 1,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -----------------------------------------------------------------
    -- Stars (user's starred items)
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS stars (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      type          TEXT NOT NULL,   -- 'message', 'file', 'channel'
      channel_id    TEXT DEFAULT '',
      message_ts    TEXT DEFAULT '',
      file_id       TEXT DEFAULT '',
      created_at    INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_stars_unique
      ON stars(type, channel_id, message_ts, file_id);

    -----------------------------------------------------------------
    -- Custom emoji
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS emoji (
      name          TEXT PRIMARY KEY,
      url           TEXT,
      is_alias      INTEGER DEFAULT 0,
      alias_for     TEXT DEFAULT '',
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -----------------------------------------------------------------
    -- Team / workspace info
    -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS team (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      domain        TEXT,
      url           TEXT,
      icon_url      TEXT DEFAULT '',
      updated_at    TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Additive migrations for existing databases ──────────────
  // ALTER TABLE ... ADD COLUMN is safe to repeat — SQLite errors if the
  // column already exists, so we catch and ignore each one.
  const addColumns = [
    ['users', 'title',        'TEXT DEFAULT \'\''],
    ['users', 'email',        'TEXT DEFAULT \'\''],
    ['users', 'timezone',     'TEXT DEFAULT \'\''],
    ['users', 'status_text',  'TEXT DEFAULT \'\''],
    ['users', 'status_emoji', 'TEXT DEFAULT \'\''],
    ['users', 'avatar_url',   'TEXT DEFAULT \'\''],
    // Channel DM tracking columns
    ['channels', 'is_im',           'INTEGER DEFAULT 0'],
    ['channels', 'is_mpim',         'INTEGER DEFAULT 0'],
    ['channels', 'dm_user_id',      'TEXT'],
    // Message enrichment columns
    ['messages', 'subtype',          'TEXT'],
    ['messages', 'edited_at',        'TEXT'],
    ['messages', 'blocks',           'TEXT'],
    ['messages', 'bot_id',           'TEXT'],
    ['messages', 'bot_profile_name', 'TEXT'],
  ];
  for (const [table, col, type] of addColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    } catch {
      // Column already exists — ignore
    }
  }

  // ── Backfill DM flags from channel naming patterns ──────────
  // IMs have D-prefixed IDs and either no name or name == id
  // MPIMs have mpdm- prefixed names
  try {
    db.exec(`
      UPDATE channels SET is_im = 1
      WHERE id LIKE 'D%' AND (name IS NULL OR name = id) AND is_im = 0;

      UPDATE channels SET is_mpim = 1
      WHERE name LIKE 'mpdm-%' AND is_mpim = 0;
    `);
    // For IMs without a dm_user_id, pick the most active poster in the DM
    // (will be properly set to the correct partner on next import from Slack)
    db.exec(`
      UPDATE channels SET dm_user_id = (
        SELECT user_id FROM messages
        WHERE channel_id = channels.id AND user_id IS NOT NULL
        GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1
      ) WHERE is_im = 1 AND dm_user_id IS NULL;
    `);
  } catch {
    // Backfill is best-effort — ignore errors
  }
}

// ── Upsert helpers ──────────────────────────────────────────────

export function upsertChannel(db, ch) {
  db.prepare(`
    INSERT INTO channels (id, name, is_private, topic, purpose,
                          is_im, is_mpim, dm_user_id, updated_at)
    VALUES (@id, @name, @is_private, @topic, @purpose,
            @is_im, @is_mpim, @dm_user_id, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      is_private = excluded.is_private,
      topic = excluded.topic,
      purpose = excluded.purpose,
      is_im = excluded.is_im,
      is_mpim = excluded.is_mpim,
      dm_user_id = excluded.dm_user_id,
      updated_at = datetime('now')
  `).run({
    id: ch.id,
    name: ch.name ?? null,
    is_private: ch.is_private ? 1 : 0,
    topic: ch.topic?.value ?? '',
    purpose: ch.purpose?.value ?? '',
    is_im: ch.is_im ? 1 : 0,
    is_mpim: ch.is_mpim ? 1 : 0,
    dm_user_id: ch.user ?? null,
  });
}

export function upsertUser(db, u) {
  const p = u.profile ?? {};
  db.prepare(`
    INSERT INTO users (id, name, real_name, display_name, is_bot,
                       title, email, timezone, status_text, status_emoji,
                       avatar_url, updated_at)
    VALUES (@id, @name, @real_name, @display_name, @is_bot,
            @title, @email, @timezone, @status_text, @status_emoji,
            @avatar_url, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      real_name = excluded.real_name,
      display_name = excluded.display_name,
      is_bot = excluded.is_bot,
      title = excluded.title,
      email = excluded.email,
      timezone = excluded.timezone,
      status_text = excluded.status_text,
      status_emoji = excluded.status_emoji,
      avatar_url = excluded.avatar_url,
      updated_at = datetime('now')
  `).run({
    id: u.id,
    name: u.name ?? '',
    real_name: u.real_name ?? p.real_name ?? '',
    display_name: p.display_name ?? '',
    is_bot: u.is_bot ? 1 : 0,
    title: p.title ?? '',
    email: p.email ?? '',
    timezone: u.tz ?? '',
    status_text: p.status_text ?? '',
    status_emoji: p.status_emoji ?? '',
    avatar_url: p.image_192 ?? p.image_72 ?? '',
  });
}

export function upsertMessage(db, msg, channelId) {
  db.prepare(`
    INSERT INTO messages (ts, channel_id, user_id, text, thread_ts, reply_count,
                          reactions, attachments, permalink, raw,
                          subtype, edited_at, blocks, bot_id, bot_profile_name)
    VALUES (@ts, @channel_id, @user_id, @text, @thread_ts, @reply_count,
            @reactions, @attachments, @permalink, @raw,
            @subtype, @edited_at, @blocks, @bot_id, @bot_profile_name)
    ON CONFLICT(channel_id, ts) DO UPDATE SET
      text             = excluded.text,
      reply_count      = excluded.reply_count,
      reactions        = excluded.reactions,
      attachments      = excluded.attachments,
      permalink        = excluded.permalink,
      raw              = excluded.raw,
      subtype          = excluded.subtype,
      edited_at        = excluded.edited_at,
      blocks           = excluded.blocks,
      bot_id           = excluded.bot_id,
      bot_profile_name = excluded.bot_profile_name
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
    subtype: msg.subtype ?? null,
    edited_at: msg.edited?.ts ?? null,
    blocks: msg.blocks ? JSON.stringify(msg.blocks) : null,
    bot_id: msg.bot_id ?? null,
    bot_profile_name: msg.bot_profile?.name ?? null,
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
           m.subtype, m.edited_at, m.bot_id, m.bot_profile_name,
           u.display_name AS user_display_name,
           u.real_name    AS user_real_name,
           u.name         AS user_name,
           c.name         AS channel_name,
           c.topic        AS channel_topic,
           c.purpose      AS channel_purpose,
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
           m.subtype, m.edited_at,
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
           m.subtype, m.edited_at,
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
           m.subtype, m.edited_at,
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
  return db.prepare('SELECT id, name, is_private, topic, purpose, is_im, is_mpim, dm_user_id FROM channels ORDER BY name').all();
}

/**
 * Get messages by a specific user, optionally filtered to a channel.
 */
export function getMessagesByUser(db, userId, { channelId, limit = 50 } = {}) {
  let sql = `
    SELECT m.ts, m.channel_id, m.text, m.thread_ts,
           m.subtype, m.edited_at, m.bot_id, m.bot_profile_name,
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

// ── Upsert helpers for extended data ───────────────────────────

export function upsertPin(db, channelId, item) {
  const ts = item.message?.ts ?? item.created;
  if (!ts) return;
  db.prepare(`
    INSERT INTO pins (channel_id, message_ts, pinned_by, pinned_at)
    VALUES (@channel_id, @message_ts, @pinned_by, @pinned_at)
    ON CONFLICT(channel_id, message_ts) DO UPDATE SET
      pinned_by = excluded.pinned_by,
      pinned_at = excluded.pinned_at
  `).run({
    channel_id: channelId,
    message_ts: ts,
    pinned_by: item.created_by ?? null,
    pinned_at: item.created ? String(item.created) : null,
  });
}

export function upsertBookmark(db, channelId, bm) {
  db.prepare(`
    INSERT INTO bookmarks (id, channel_id, title, type, link, emoji, created_by, created_at, updated_at)
    VALUES (@id, @channel_id, @title, @type, @link, @emoji, @created_by, @created_at, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      link = excluded.link,
      emoji = excluded.emoji,
      updated_at = datetime('now')
  `).run({
    id: bm.id,
    channel_id: channelId,
    title: bm.title ?? '',
    type: bm.type ?? 'link',
    link: bm.link ?? '',
    emoji: bm.emoji ?? '',
    created_by: bm.created_by ?? null,
    created_at: bm.date_created ?? null,
  });
}

export function upsertFile(db, f) {
  db.prepare(`
    INSERT INTO files (id, name, title, mimetype, filetype, size, user_id,
                       url_private, permalink, channels, created_at, updated_at)
    VALUES (@id, @name, @title, @mimetype, @filetype, @size, @user_id,
            @url_private, @permalink, @channels, @created_at, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      title = excluded.title,
      size = excluded.size,
      permalink = excluded.permalink,
      channels = excluded.channels,
      updated_at = datetime('now')
  `).run({
    id: f.id,
    name: f.name ?? '',
    title: f.title ?? '',
    mimetype: f.mimetype ?? '',
    filetype: f.filetype ?? '',
    size: f.size ?? 0,
    user_id: f.user ?? null,
    url_private: f.url_private ?? '',
    permalink: f.permalink ?? '',
    channels: JSON.stringify([...(f.channels ?? []), ...(f.groups ?? []), ...(f.ims ?? [])]),
    created_at: f.created ?? null,
  });
}

export function upsertUserGroup(db, ug) {
  db.prepare(`
    INSERT INTO user_groups (id, name, handle, description, user_ids, channel_ids, is_active, updated_at)
    VALUES (@id, @name, @handle, @description, @user_ids, @channel_ids, @is_active, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      handle = excluded.handle,
      description = excluded.description,
      user_ids = excluded.user_ids,
      channel_ids = excluded.channel_ids,
      is_active = excluded.is_active,
      updated_at = datetime('now')
  `).run({
    id: ug.id,
    name: ug.name ?? '',
    handle: ug.handle ?? '',
    description: ug.description ?? '',
    user_ids: JSON.stringify(ug.users ?? []),
    channel_ids: JSON.stringify(ug.prefs?.channels ?? []),
    is_active: ug.date_delete === 0 ? 1 : 0,
  });
}

export function upsertStar(db, item) {
  const type = item.type ?? 'message';
  db.prepare(`
    INSERT INTO stars (type, channel_id, message_ts, file_id, created_at)
    VALUES (@type, @channel_id, @message_ts, @file_id, @created_at)
    ON CONFLICT(type, channel_id, message_ts, file_id) DO NOTHING
  `).run({
    type,
    channel_id: item.channel ?? item.message?.channel ?? '',
    message_ts: item.message?.ts ?? '',
    file_id: item.file?.id ?? '',
    created_at: item.date_create ?? null,
  });
}

export function upsertEmoji(db, name, value) {
  const isAlias = value.startsWith('alias:');
  db.prepare(`
    INSERT INTO emoji (name, url, is_alias, alias_for, updated_at)
    VALUES (@name, @url, @is_alias, @alias_for, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      url = excluded.url,
      is_alias = excluded.is_alias,
      alias_for = excluded.alias_for,
      updated_at = datetime('now')
  `).run({
    name,
    url: isAlias ? '' : value,
    is_alias: isAlias ? 1 : 0,
    alias_for: isAlias ? value.replace('alias:', '') : '',
  });
}

export function upsertTeam(db, t) {
  db.prepare(`
    INSERT INTO team (id, name, domain, url, icon_url, updated_at)
    VALUES (@id, @name, @domain, @url, @icon_url, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      domain = excluded.domain,
      url = excluded.url,
      icon_url = excluded.icon_url,
      updated_at = datetime('now')
  `).run({
    id: t.id,
    name: t.name ?? '',
    domain: t.domain ?? '',
    url: t.url ?? '',
    icon_url: t.icon?.image_230 ?? t.icon?.image_132 ?? '',
  });
}

// ── Poll cursor helpers ────────────────────────────────────────

/**
 * Get the latest message timestamp seen by the poller for a channel.
 * Returns '0' if no cursor exists (meaning: no prior polling).
 */
export function getPollCursor(db, channelId) {
  const row = db.prepare(
    'SELECT latest_ts FROM poll_cursors WHERE channel_id = ?'
  ).get(channelId);
  return row?.latest_ts ?? '0';
}

/**
 * Update the polling cursor for a channel to a new latest timestamp.
 * Only advances forward — never moves the cursor backward.
 */
export function setPollCursor(db, channelId, latestTs) {
  db.prepare(`
    INSERT INTO poll_cursors (channel_id, latest_ts, updated_at)
    VALUES (@channel_id, @latest_ts, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      latest_ts = CASE
        WHEN excluded.latest_ts > poll_cursors.latest_ts
        THEN excluded.latest_ts
        ELSE poll_cursors.latest_ts
      END,
      updated_at = datetime('now')
  `).run({ channel_id: channelId, latest_ts: latestTs });
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; _dbPath = null; }
}

/**
 * Check if a metadata sync (pins/bookmarks) for a channel is still fresh.
 * Returns true if it was synced within `maxAgeMinutes` ago.
 */
export function isMetadataFresh(db, channelId, dataType, maxAgeMinutes = 60) {
  const row = db.prepare(`
    SELECT updated_at FROM metadata_cursors
    WHERE channel_id = @channelId AND data_type = @dataType
      AND updated_at > datetime('now', @age)
  `).get({ channelId, dataType, age: `-${maxAgeMinutes} minutes` });
  return !!row;
}

/**
 * Mark a metadata type (pins/bookmarks) as freshly synced for a channel.
 */
export function touchMetadataCursor(db, channelId, dataType) {
  db.prepare(`
    INSERT INTO metadata_cursors (channel_id, data_type, updated_at)
    VALUES (@channelId, @dataType, datetime('now'))
    ON CONFLICT(channel_id, data_type) DO UPDATE SET updated_at = datetime('now')
  `).run({ channelId, dataType });
}

// ── Rich query helpers (for frontend) ───────────────────────────

/**
 * Get recent messages with full user metadata (avatars, reactions).
 * Filters out thread replies — only top-level and parent messages shown.
 * Includes thread preview data (last reply ts, reply participant info).
 */
export function getRecentRich(db, channelId, limit = 50) {
  return db.prepare(`
    SELECT m.ts, m.channel_id, m.user_id, m.text, m.thread_ts, m.reply_count,
           m.reactions, m.attachments,
           m.subtype, m.edited_at, m.blocks, m.bot_id, m.bot_profile_name,
           u.display_name AS user_display_name,
           u.real_name AS user_real_name,
           u.name AS user_name,
           u.avatar_url AS user_avatar_url,
           u.is_bot AS user_is_bot,
           tp.last_reply_ts,
           tp.reply_users
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN (
      SELECT r.thread_ts AS parent_ts,
             MAX(r.ts) AS last_reply_ts,
             GROUP_CONCAT(DISTINCT r.user_id) AS reply_users
      FROM messages r
      WHERE r.channel_id = @channelId
        AND r.thread_ts IS NOT NULL
        AND r.thread_ts != r.ts
      GROUP BY r.thread_ts
    ) tp ON tp.parent_ts = m.ts
    WHERE m.channel_id = @channelId
      AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
    ORDER BY m.ts DESC
    LIMIT @limit
  `).all({ channelId, limit });
}

/**
 * Get full thread with user metadata.
 */
export function getThreadRich(db, channelId, threadTs) {
  return db.prepare(`
    SELECT m.ts, m.channel_id, m.user_id, m.text, m.thread_ts, m.reply_count,
           m.reactions, m.attachments,
           m.subtype, m.edited_at, m.blocks, m.bot_id, m.bot_profile_name,
           u.display_name AS user_display_name,
           u.real_name AS user_real_name,
           u.name AS user_name,
           u.avatar_url AS user_avatar_url,
           u.is_bot AS user_is_bot
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = @channelId
      AND (m.thread_ts = @threadTs OR m.ts = @threadTs)
    ORDER BY m.ts ASC
  `).all({ channelId, threadTs });
}

/**
 * List all users with full profile data.
 */
export function listUsersRich(db) {
  return db.prepare(`
    SELECT id, name, real_name, display_name, is_bot,
           title, email, timezone, status_text, status_emoji, avatar_url
    FROM users ORDER BY name
  `).all();
}

/**
 * List channels with message counts and latest activity, sorted by recency.
 */
export function listChannelsRich(db) {
  return db.prepare(`
    SELECT c.id, c.name, c.is_private, c.topic, c.purpose,
           c.is_im, c.is_mpim, c.dm_user_id,
           dm_u.display_name AS dm_user_display_name,
           dm_u.real_name    AS dm_user_real_name,
           dm_u.name         AS dm_user_name,
           dm_u.avatar_url   AS dm_user_avatar_url,
           COUNT(m.ts) AS message_count,
           MAX(m.ts) AS latest_message_ts
    FROM channels c
    LEFT JOIN messages m ON m.channel_id = c.id
    LEFT JOIN users dm_u ON dm_u.id = c.dm_user_id
    GROUP BY c.id
    ORDER BY latest_message_ts DESC NULLS LAST
  `).all();
}

/**
 * Get pins for a channel, joined with message text and user.
 */
export function getPinsForChannel(db, channelId) {
  return db.prepare(`
    SELECT p.message_ts, p.pinned_by, p.pinned_at,
           m.text, m.user_id,
           u.display_name AS user_display_name,
           u.name AS user_name
    FROM pins p
    LEFT JOIN messages m ON m.channel_id = p.channel_id AND m.ts = p.message_ts
    LEFT JOIN users u ON u.id = m.user_id
    WHERE p.channel_id = @channelId
    ORDER BY p.pinned_at DESC
  `).all({ channelId });
}

/**
 * Get bookmarks for a channel with creator info.
 */
export function getBookmarksForChannel(db, channelId) {
  return db.prepare(`
    SELECT b.id, b.title, b.type, b.link, b.emoji,
           b.created_by, b.created_at,
           u.display_name AS creator_display_name,
           u.name AS creator_name
    FROM bookmarks b
    LEFT JOIN users u ON u.id = b.created_by
    WHERE b.channel_id = @channelId
    ORDER BY b.created_at DESC
  `).all({ channelId });
}

/**
 * Get team/workspace info.
 */
export function getTeamInfo(db) {
  return db.prepare('SELECT * FROM team LIMIT 1').get() ?? null;
}

/**
 * Resolve a channel query (name or ID) to a channel ID.
 * Tries exact ID match first, then case-insensitive name match.
 * Falls back to the raw query value if no match is found.
 */
export function resolveChannelId(db, query) {
  if (!query) return undefined;
  const clean = query.replace(/^#/, '');
  const byId = db.prepare('SELECT id FROM channels WHERE id = ?').get(clean);
  if (byId) return byId.id;
  const byName = db.prepare('SELECT id FROM channels WHERE LOWER(name) = LOWER(?)').get(clean);
  return byName?.id ?? clean;
}

/**
 * Resolve a user query (ID, name, display_name, or real_name) to a user ID.
 * Falls back to the raw query value if no match is found.
 */
export function resolveUserId(db, query) {
  if (!query) return undefined;
  const byId = db.prepare('SELECT id FROM users WHERE id = ?').get(query);
  if (byId) return byId.id;
  const byName = db.prepare(
    'SELECT id FROM users WHERE LOWER(name) = LOWER(?) OR LOWER(display_name) = LOWER(?) OR LOWER(real_name) = LOWER(?)'
  ).get(query, query, query);
  return byName?.id ?? query;
}

/**
 * List all users (basic fields).
 */
export function listUsers(db) {
  return db.prepare(
    'SELECT id, name, real_name, display_name, is_bot FROM users ORDER BY name'
  ).all();
}

/**
 * Get a workspace-wide summary with aggregate statistics.
 * Includes per-channel activity, daily message volume, and bot/human breakdown.
 */
export function getWorkspaceSummary(db) {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_messages,
      COUNT(DISTINCT channel_id) AS active_channels,
      COUNT(DISTINCT user_id) AS active_users,
      COUNT(DISTINCT CASE WHEN thread_ts IS NULL OR thread_ts = ts THEN ts END) AS total_threads
    FROM messages
  `).get();

  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const channelCount = db.prepare('SELECT COUNT(*) AS count FROM channels').get().count;
  const botCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_bot = 1').get().count;

  const channelActivity = db.prepare(`
    SELECT c.id, c.name, c.topic, c.purpose,
           COUNT(m.ts) AS message_count,
           COUNT(DISTINCT m.user_id) AS unique_posters,
           MAX(m.ts) AS latest_message_ts
    FROM channels c
    LEFT JOIN messages m ON m.channel_id = c.id
    GROUP BY c.id
    ORDER BY message_count DESC
  `).all();

  // Messages per day over the last 30 days
  const cutoff30d = String((Date.now() / 1000) - (30 * 86400));
  const dailyActivity = db.prepare(`
    SELECT
      date(CAST(ts AS REAL), 'unixepoch') AS day,
      COUNT(*) AS count
    FROM messages
    WHERE ts > @cutoff
    GROUP BY day
    ORDER BY day ASC
  `).all({ cutoff: cutoff30d });

  return {
    total_messages: totals.total_messages,
    total_channels: channelCount,
    total_users: userCount,
    total_bots: botCount,
    total_humans: userCount - botCount,
    active_channels: totals.active_channels,
    active_users: totals.active_users,
    total_threads: totals.total_threads,
    channels: channelActivity,
    daily_activity: dailyActivity,
  };
}

/**
 * Extract URL unfurls from message attachments in a channel.
 * Returns structured unfurl data: url, title, description, image, service.
 */
export function getUnfurls(db, channelId, { limit = 50 } = {}) {
  const rows = db.prepare(`
    SELECT m.ts, m.channel_id, m.user_id, m.text, m.attachments,
           u.display_name AS user_display_name,
           u.name AS user_name,
           c.name AS channel_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN channels c ON c.id = m.channel_id
    WHERE m.channel_id = @channelId
      AND m.attachments IS NOT NULL
      AND m.attachments != '[]'
    ORDER BY m.ts DESC
    LIMIT @limit
  `).all({ channelId, limit });

  const unfurls = [];
  for (const row of rows) {
    try {
      const attachments = JSON.parse(row.attachments);
      for (const att of attachments) {
        if (att.from_url || att.original_url) {
          unfurls.push({
            message_ts: row.ts,
            channel_name: row.channel_name,
            user: row.user_display_name || row.user_name,
            url: att.from_url || att.original_url,
            title: att.title || null,
            description: att.text || att.fallback || null,
            service_name: att.service_name || null,
            service_icon: att.service_icon || null,
            image_url: att.image_url || att.thumb_url || null,
            color: att.color || null,
          });
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return unfurls;
}

/**
 * Get an activity digest for a channel over a time window.
 * Returns message counts, unique users, threads started, top posters,
 * and messages bucketed by hour.
 */
export function getChannelDigest(db, channelId, { hours = 24 } = {}) {
  const cutoffTs = String((Date.now() / 1000) - (hours * 3600));

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_messages,
      COUNT(DISTINCT user_id) AS unique_users,
      COUNT(DISTINCT CASE WHEN thread_ts IS NULL OR thread_ts = ts THEN ts END) AS threads_started
    FROM messages
    WHERE channel_id = @channelId AND ts > @cutoffTs
  `).get({ channelId, cutoffTs });

  const topPosters = db.prepare(`
    SELECT m.user_id,
           COALESCE(u.display_name, u.real_name, u.name, m.user_id) AS user_name,
           COUNT(*) AS message_count
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = @channelId AND m.ts > @cutoffTs
    GROUP BY m.user_id
    ORDER BY message_count DESC
    LIMIT 10
  `).all({ channelId, cutoffTs });

  const messagesByHour = db.prepare(`
    SELECT
      CAST((CAST(ts AS REAL) - CAST(@cutoffTs AS REAL)) / 3600 AS INTEGER) AS hour_bucket,
      COUNT(*) AS count
    FROM messages
    WHERE channel_id = @channelId AND ts > @cutoffTs
    GROUP BY hour_bucket
    ORDER BY hour_bucket ASC
  `).all({ channelId, cutoffTs });

  return {
    channel_id: channelId,
    hours,
    ...totals,
    top_posters: topPosters,
    messages_by_hour: messagesByHour,
  };
}
