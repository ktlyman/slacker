import { WebClient } from '@slack/web-api';
import {
  getDb, upsertChannel, upsertUser, upsertMessage,
  upsertPin, upsertBookmark, upsertFile,
  upsertUserGroup, upsertStar, upsertEmoji, upsertTeam,
  isMetadataFresh, touchMetadataCursor,
} from '../storage/db.js';

const RATE_LIMIT_PAUSE_MS = 1200;      // Slack tier-3 rate limit ≈ 50 req/min
const PAGE_SIZE = 200;                  // max messages per conversations.history call
const DEFAULT_CONCURRENCY = 3;          // parallel channel imports

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Simple token-bucket rate limiter shared across all concurrent workers.
 * Ensures we don't exceed ~50 req/min regardless of concurrency.
 */
function createRateLimiter(intervalMs) {
  let next = Date.now();
  return async function acquire() {
    const now = Date.now();
    if (now < next) {
      await sleep(next - now);
    }
    next = Math.max(Date.now(), next) + intervalMs;
  };
}

/**
 * Run an array of async tasks with bounded concurrency.
 */
async function parallelMap(items, concurrency, fn) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Import historical data from Slack into the local SQLite database.
 *
 * Steps:
 *  1. Sync all users
 *  2. Sync all channels the bot/user can see
 *  3. For each channel (or a specified subset), page through message
 *     history and store every message + thread reply.
 *
 * Supports incremental imports: tracks the latest timestamp per channel
 * so subsequent runs only fetch new messages.
 *
 * Channels are imported in parallel (default 3 at a time) with a shared
 * rate limiter so Slack's per-token rate limit is respected.
 *
 * @param {object} opts
 * @param {import('@slack/web-api').WebClient} [opts.client] — pre-configured WebClient (falls back to SLACK_BOT_TOKEN)
 * @param {string} [opts.authMode] — 'bot', 'user', or 'session'
 * @param {string} [opts.dbPath]
 * @param {string[]} [opts.channels]
 * @param {number} [opts.concurrency] — parallel channel imports (default 3)
 * @param {boolean} [opts.includeDms] — include DMs and group DMs
 * @param {boolean} [opts.joinPublic] — join unjoined public channels before importing
 * @param {Function} [opts.log]
 */
export async function importHistory(opts = {}) {
  const client = opts.client ?? new WebClient(process.env.SLACK_BOT_TOKEN);
  const db = getDb(opts.dbPath);
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const log = opts.log ?? console.log;
  const throttle = createRateLimiter(RATE_LIMIT_PAUSE_MS);

  // ── 1. Sync team info ────────────────────────────────────
  log('Syncing team info...');
  await importTeam(client, db, log, throttle);

  // ── 2. Sync users ──────────────────────────────────────────
  log('Syncing users...');
  let userCount = 0;
  for await (const page of client.paginate('users.list', { limit: 200 })) {
    for (const u of page.members ?? []) {
      upsertUser(db, u);
      userCount++;
    }
    await throttle();
  }
  log(`  ${userCount} users synced`);

  // ── 3. Sync channels ──────────────────────────────────────
  log('Syncing channels...');
  const channelTypes = opts.includeDms
    ? 'public_channel,private_channel,im,mpim'
    : 'public_channel,private_channel';
  const channels = [];
  for await (const page of client.paginate('conversations.list', {
    types: channelTypes,
    limit: 200,
    exclude_archived: false,
  })) {
    for (const ch of page.channels ?? []) {
      upsertChannel(db, ch);
      channels.push(ch);
    }
    await throttle();
  }
  log(`  ${channels.length} channels synced`);

  // ── 4. Filter channels if requested ────────────────────────
  let targetChannels = channels;
  if (opts.channels?.length) {
    const set = new Set(opts.channels.map(c => c.toLowerCase()));
    targetChannels = channels.filter(
      ch => set.has(ch.id) || set.has(ch.name?.toLowerCase())
    );
    log(`  Filtering to ${targetChannels.length} requested channels`);
  }

  // ── 5. Import messages per channel (parallel) ──────────────
  // Split into channels that need a full import vs incremental check.
  // Channels with an existing cursor only need a quick check for new messages.
  const hasCursor = new Set(
    db.prepare('SELECT channel_id FROM import_cursors').all().map(r => r.channel_id)
  );
  const freshChannels = targetChannels.filter(ch => !hasCursor.has(ch.id));
  const incrementalChannels = targetChannels.filter(ch => hasCursor.has(ch.id));

  if (freshChannels.length) {
    log(`Importing ${freshChannels.length} new channels (concurrency: ${concurrency})...`);
    await parallelMap(freshChannels, concurrency, async (ch) => {
      await importChannel(client, db, ch, { ...opts, log, throttle });
    });
  }

  if (incrementalChannels.length) {
    // Incremental channels: higher concurrency since most return 0 messages
    const incrConcurrency = Math.min(incrementalChannels.length, concurrency * 3);
    log(`Checking ${incrementalChannels.length} channels for new messages (concurrency: ${incrConcurrency})...`);
    await parallelMap(incrementalChannels, incrConcurrency, async (ch) => {
      await importChannel(client, db, ch, { ...opts, log, throttle });
    });
  }

  // ── 6. Import workspace-level data ─────────────────────────
  log('Importing workspace data (emoji, user groups, files, stars)...');
  await importEmoji(client, db, log, throttle);
  await importUserGroups(client, db, log, throttle);
  await importFiles(client, db, log, throttle);
  await importStars(client, db, log, throttle);

  // ── 7. Import per-channel pins & bookmarks ─────────────────
  // Uses higher concurrency since most channels will be skipped (freshness check)
  const metaConcurrency = Math.min(targetChannels.length, concurrency * 3);
  log(`Syncing pins & bookmarks for ${targetChannels.length} channels...`);
  await parallelMap(targetChannels, metaConcurrency, async (ch) => {
    await importPins(client, db, ch.id, log, throttle);
    await importBookmarks(client, db, ch.id, log, throttle);
  });

  log('Import complete.');
  return { userCount, channelCount: targetChannels.length };
}

/**
 * Derive a display label for any channel type.
 * DMs (im) have no name — use the other user's ID. Group DMs (mpim) have a name.
 */
function channelLabel(ch) {
  if (ch.name) return `#${ch.name}`;
  if (ch.user) return `DM:${ch.user}`;
  return ch.id;
}

/**
 * Import a single channel's message history.
 */
async function importChannel(client, db, ch, opts) {
  const { log, throttle } = opts;
  const label = channelLabel(ch);

  // Check cursor for incremental import
  const cursor = db.prepare(
    'SELECT latest_ts FROM import_cursors WHERE channel_id = ?'
  ).get(ch.id);
  const oldest = cursor?.latest_ts ?? undefined;
  const isIncremental = !!cursor;

  let msgCount = 0;
  let newestTs = oldest ?? '0';
  let pageCursor;

  // Join the channel if needed. Bot mode always joins. User/session modes
  // join only when --join-public is set and the channel is public.
  const shouldJoin = opts.authMode === 'bot'
    || (opts.joinPublic && !ch.is_private && !ch.is_member);
  if (shouldJoin) {
    try {
      await throttle();
      await client.conversations.join({ channel: ch.id });
    } catch {
      // Already a member, or can't join — continue anyway
    }
  }

  // Page through history
  do {
    try {
      await throttle();
      const result = await client.conversations.history({
        channel: ch.id,
        limit: PAGE_SIZE,
        oldest,
        cursor: pageCursor,
      });

      const messages = result.messages ?? [];
      // Run DB writes in a transaction for this batch
      db.transaction(() => {
        for (const msg of messages) {
          upsertMessage(db, msg, ch.id);
        }
      })();
      msgCount += messages.length;

      // Track newest timestamp
      for (const m of messages) {
        if (m.ts > newestTs) newestTs = m.ts;
      }

      // Fetch thread replies for messages that have them
      for (const m of messages) {
        if ((m.reply_count ?? 0) > 0 && m.thread_ts) {
          await importThread(client, db, ch.id, m.thread_ts, log, throttle);
        }
      }

      pageCursor = result.response_metadata?.next_cursor;
    } catch (err) {
      if (err.data?.error === 'ratelimited') {
        const wait = (err.data?.retryAfter ?? 10) * 1000;
        log(`  Rate limited on ${label} — pausing ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (err.data?.error === 'not_in_channel' || err.data?.error === 'channel_not_found') {
        log(`  Skipping ${label}: ${err.data.error}`);
        break;
      }
      if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        log(`  Timeout on ${label} (${err.code}) — skipping to next channel`);
        break;
      }
      log(`  Error on ${label}: ${err.message} — skipping`);
      break;
    }
  } while (pageCursor);

  // Update cursor
  db.prepare(`
    INSERT INTO import_cursors (channel_id, latest_ts, updated_at)
    VALUES (@channel_id, @latest_ts, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      latest_ts = excluded.latest_ts,
      updated_at = datetime('now')
  `).run({ channel_id: ch.id, latest_ts: newestTs });

  // Only log if we actually imported something (skip noise for 0-message incremental checks)
  if (msgCount > 0 || !isIncremental) {
    log(`  ${msgCount} messages imported from ${label}`);
  }
}

/**
 * Import all replies in a thread.
 */
async function importThread(client, db, channelId, threadTs, log, throttle) {
  let cursor;
  try {
    do {
      await throttle();
      const result = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: PAGE_SIZE,
        cursor,
      });
      for (const msg of result.messages ?? []) {
        upsertMessage(db, msg, channelId);
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  } catch (err) {
    (log ?? console.log)(`  Thread ${threadTs} failed: ${err.code ?? err.message} — skipping`);
  }
}

// ── Workspace-level importers ───────────────────────────────────

/**
 * Import team/workspace info.
 */
async function importTeam(client, db, log, throttle) {
  try {
    await throttle();
    const result = await client.team.info();
    if (result.team) {
      upsertTeam(db, result.team);
      log(`  Team "${result.team.name}" synced`);
    }
  } catch (err) {
    log(`  Team info failed: ${err.message} — skipping`);
  }
}

/**
 * Import all custom emoji.
 */
async function importEmoji(client, db, log, throttle) {
  try {
    await throttle();
    const result = await client.emoji.list();
    const emoji = result.emoji ?? {};
    const names = Object.keys(emoji);
    db.transaction(() => {
      for (const name of names) {
        upsertEmoji(db, name, emoji[name]);
      }
    })();
    log(`  ${names.length} emoji synced`);
  } catch (err) {
    log(`  Emoji import failed: ${err.message} — skipping`);
  }
}

/**
 * Import user groups (@mentions).
 */
async function importUserGroups(client, db, log, throttle) {
  try {
    await throttle();
    const result = await client.usergroups.list({ include_users: true });
    const groups = result.usergroups ?? [];
    db.transaction(() => {
      for (const ug of groups) {
        upsertUserGroup(db, ug);
      }
    })();
    log(`  ${groups.length} user groups synced`);
  } catch (err) {
    log(`  User groups import failed: ${err.message} — skipping`);
  }
}

/**
 * Import file metadata (paginated).
 */
async function importFiles(client, db, log, throttle) {
  let page = 1;
  let totalFiles = 0;
  try {
    while (true) {
      await throttle();
      const result = await client.files.list({ count: 100, page });
      const files = result.files ?? [];
      if (files.length === 0) break;
      db.transaction(() => {
        for (const f of files) {
          upsertFile(db, f);
        }
      })();
      totalFiles += files.length;
      const paging = result.paging;
      if (!paging || page >= paging.pages) break;
      page++;
    }
    log(`  ${totalFiles} files synced`);
  } catch (err) {
    log(`  Files import failed (page ${page}): ${err.message} — skipping`);
  }
}

/**
 * Import starred items (paginated).
 */
async function importStars(client, db, log, throttle) {
  let page = 1;
  let totalStars = 0;
  try {
    while (true) {
      await throttle();
      const result = await client.stars.list({ count: 100, page });
      const items = result.items ?? [];
      if (items.length === 0) break;
      db.transaction(() => {
        for (const item of items) {
          upsertStar(db, item);
        }
      })();
      totalStars += items.length;
      const paging = result.paging;
      if (!paging || page >= paging.pages) break;
      page++;
    }
    log(`  ${totalStars} stars synced`);
  } catch (err) {
    log(`  Stars import failed: ${err.message} — skipping`);
  }
}

// ── Per-channel importers ───────────────────────────────────────

/**
 * Import pins for a single channel.
 */
async function importPins(client, db, channelId, log, throttle) {
  // Skip if recently synced (within 60 min)
  if (isMetadataFresh(db, channelId, 'pins')) return;

  try {
    await throttle();
    const result = await client.pins.list({ channel: channelId });
    const items = result.items ?? [];
    if (items.length > 0) {
      db.transaction(() => {
        for (const item of items) {
          upsertPin(db, channelId, item);
        }
      })();
    }
    touchMetadataCursor(db, channelId, 'pins');
  } catch (err) {
    // DMs and some channels don't support pins — skip silently for common errors
    if (err.data?.error === 'channel_not_found' || err.data?.error === 'not_in_channel') {
      touchMetadataCursor(db, channelId, 'pins'); // Don't retry unsupported channels
      return;
    }
    log(`  Pins for ${channelId}: ${err.message} — skipping`);
  }
}

/**
 * Import bookmarks for a single channel.
 */
async function importBookmarks(client, db, channelId, log, throttle) {
  // Skip if recently synced (within 60 min)
  if (isMetadataFresh(db, channelId, 'bookmarks')) return;

  try {
    await throttle();
    const result = await client.bookmarks.list({ channel_id: channelId });
    const bookmarks = result.bookmarks ?? [];
    if (bookmarks.length > 0) {
      db.transaction(() => {
        for (const bm of bookmarks) {
          upsertBookmark(db, channelId, bm);
        }
      })();
    }
    touchMetadataCursor(db, channelId, 'bookmarks');
  } catch (err) {
    // Bookmarks API may not be available for all channel types
    if (err.data?.error === 'channel_not_found' || err.data?.error === 'not_in_channel'
      || err.data?.error === 'not_allowed_for_channel_type') {
      touchMetadataCursor(db, channelId, 'bookmarks'); // Don't retry unsupported channels
      return;
    }
    log(`  Bookmarks for ${channelId}: ${err.message} — skipping`);
  }
}
