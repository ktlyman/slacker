import { WebClient } from '@slack/web-api';
import { getDb, upsertChannel, upsertUser, upsertMessage } from '../storage/db.js';

const RATE_LIMIT_PAUSE_MS = 1200;      // Slack tier-3 rate limit ≈ 50 req/min
const PAGE_SIZE = 200;                  // max messages per conversations.history call

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Import historical data from Slack into the local SQLite database.
 *
 * Steps:
 *  1. Sync all users
 *  2. Sync all channels the bot can see
 *  3. For each channel (or a specified subset), page through message
 *     history and store every message + thread reply.
 *
 * Supports incremental imports: tracks the latest timestamp per channel
 * so subsequent runs only fetch new messages.
 */
export async function importHistory(opts = {}) {
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  const db = getDb(opts.dbPath);

  const log = opts.log ?? console.log;

  // ── 1. Sync users ──────────────────────────────────────────
  log('Syncing users...');
  let userCount = 0;
  for await (const page of client.paginate('users.list', { limit: 200 })) {
    for (const u of page.members ?? []) {
      upsertUser(db, u);
      userCount++;
    }
    await sleep(RATE_LIMIT_PAUSE_MS);
  }
  log(`  ${userCount} users synced`);

  // ── 2. Sync channels ──────────────────────────────────────
  log('Syncing channels...');
  const channels = [];
  for await (const page of client.paginate('conversations.list', {
    types: 'public_channel,private_channel',
    limit: 200,
    exclude_archived: false,
  })) {
    for (const ch of page.channels ?? []) {
      upsertChannel(db, ch);
      channels.push(ch);
    }
    await sleep(RATE_LIMIT_PAUSE_MS);
  }
  log(`  ${channels.length} channels synced`);

  // ── 3. Filter channels if requested ────────────────────────
  let targetChannels = channels;
  if (opts.channels?.length) {
    const set = new Set(opts.channels.map(c => c.toLowerCase()));
    targetChannels = channels.filter(
      ch => set.has(ch.id) || set.has(ch.name?.toLowerCase())
    );
    log(`  Filtering to ${targetChannels.length} requested channels`);
  }

  // ── 4. Import messages per channel ─────────────────────────
  const insertMsg = db.transaction((messages, channelId) => {
    for (const msg of messages) {
      upsertMessage(db, msg, channelId);
    }
  });

  for (const ch of targetChannels) {
    log(`Importing #${ch.name} (${ch.id})...`);

    // Check cursor for incremental import
    const cursor = db.prepare(
      'SELECT latest_ts FROM import_cursors WHERE channel_id = ?'
    ).get(ch.id);
    const oldest = cursor?.latest_ts ?? undefined;

    let msgCount = 0;
    let newestTs = oldest ?? '0';
    let pageCursor;

    // Join the channel first (bot needs to be a member to read history)
    try {
      await client.conversations.join({ channel: ch.id });
    } catch {
      // Already a member, or can't join private channel — continue anyway
    }

    // Page through history
    do {
      try {
        const result = await client.conversations.history({
          channel: ch.id,
          limit: PAGE_SIZE,
          oldest,
          cursor: pageCursor,
        });

        const messages = result.messages ?? [];
        insertMsg(messages, ch.id);
        msgCount += messages.length;

        // Track newest timestamp
        for (const m of messages) {
          if (m.ts > newestTs) newestTs = m.ts;
        }

        // Fetch thread replies for messages that have them
        for (const m of messages) {
          if ((m.reply_count ?? 0) > 0 && m.thread_ts) {
            await importThread(client, db, ch.id, m.thread_ts);
            await sleep(RATE_LIMIT_PAUSE_MS);
          }
        }

        pageCursor = result.response_metadata?.next_cursor;
        if (pageCursor) await sleep(RATE_LIMIT_PAUSE_MS);
      } catch (err) {
        if (err.data?.error === 'ratelimited') {
          const wait = (err.data?.retryAfter ?? 10) * 1000;
          log(`  Rate limited — pausing ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
        if (err.data?.error === 'not_in_channel' || err.data?.error === 'channel_not_found') {
          log(`  Skipping #${ch.name}: ${err.data.error}`);
          break;
        }
        throw err;
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

    log(`  ${msgCount} messages imported from #${ch.name}`);
  }

  log('Import complete.');
  return { userCount, channelCount: targetChannels.length };
}

/**
 * Import all replies in a thread.
 */
async function importThread(client, db, channelId, threadTs) {
  let cursor;
  do {
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
    if (cursor) await sleep(RATE_LIMIT_PAUSE_MS);
  } while (cursor);
}
