import {
  getDb, upsertMessage, upsertChannel, upsertUser,
  getPollCursor, setPollCursor,
} from '../storage/db.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;       // 30 seconds
const CHANNEL_SYNC_INTERVAL_MS = 10 * 60_000;  // 10 minutes
const RATE_LIMIT_PAUSE_MS = 1200;              // Slack tier-3 ≈ 50 req/min
const PAGE_SIZE = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Start a polling-based Slack listener.
 *
 * Used when Socket Mode is unavailable (user token or session token modes).
 * Periodically calls conversations.history on each joined channel to discover
 * new messages, and syncs users/channels on a slower cadence.
 *
 * @param {object} opts
 * @param {import('@slack/web-api').WebClient} opts.client — pre-configured WebClient
 * @param {string}  [opts.dbPath]
 * @param {number}  [opts.pollInterval] — ms between poll cycles (default 30000)
 * @param {Function} [opts.onMessage]   — callback for each new message
 * @returns {Promise<{ stop: Function }>}
 */
export async function startPoller(opts = {}) {
  const { client } = opts;
  if (!client) throw new Error('startPoller requires opts.client (a WebClient instance)');

  const db = getDb(opts.dbPath);
  const pollInterval = opts.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  const log = opts.log ?? console.log;

  let running = true;
  let lastChannelSync = 0;

  // Channels the user/session has access to (refreshed periodically)
  let channelList = [];

  // ── Sync helpers ──────────────────────────────────────────

  async function syncChannels() {
    const channels = [];
    try {
      for await (const page of client.paginate('conversations.list', {
        types: 'public_channel,private_channel',
        limit: 200,
        exclude_archived: true,
      })) {
        for (const ch of page.channels ?? []) {
          // Only track channels the user is a member of (user/session tokens
          // cannot join channels programmatically)
          if (ch.is_member) {
            upsertChannel(db, ch);
            channels.push(ch);
          }
        }
        await sleep(RATE_LIMIT_PAUSE_MS);
      }
    } catch (err) {
      log(`[poller] Warning: channel sync failed: ${err.message}`);
    }
    channelList = channels;
    lastChannelSync = Date.now();
    return channels;
  }

  async function syncUsers() {
    try {
      for await (const page of client.paginate('users.list', { limit: 200 })) {
        for (const u of page.members ?? []) {
          upsertUser(db, u);
        }
        await sleep(RATE_LIMIT_PAUSE_MS);
      }
    } catch (err) {
      log(`[poller] Warning: user sync failed: ${err.message}`);
    }
  }

  // ── Per-channel polling ───────────────────────────────────

  async function pollChannel(ch) {
    let oldest = getPollCursor(db, ch.id);

    // First time seeing this channel — start from now rather than backfilling.
    // Historical data should be imported via the `import` command.
    if (oldest === '0') {
      const nowTs = String(Date.now() / 1000);
      setPollCursor(db, ch.id, nowTs);
      return;
    }

    let newestTs = oldest;
    let pageCursor;

    do {
      try {
        const result = await client.conversations.history({
          channel: ch.id,
          limit: PAGE_SIZE,
          oldest,
          cursor: pageCursor,
        });

        const messages = result.messages ?? [];
        for (const msg of messages) {
          upsertMessage(db, msg, ch.id);
          if (msg.ts > newestTs) newestTs = msg.ts;

          // Fire callback for genuinely new messages
          if (opts.onMessage && msg.ts > oldest) {
            opts.onMessage({
              type: 'new',
              channelId: ch.id,
              ts: msg.ts,
              user: msg.user,
              text: msg.text,
            });
          }

          // Fetch thread replies for threaded messages
          if ((msg.reply_count ?? 0) > 0 && msg.thread_ts) {
            await pollThread(ch.id, msg.thread_ts, oldest);
          }
        }

        pageCursor = result.response_metadata?.next_cursor;
        if (pageCursor) await sleep(RATE_LIMIT_PAUSE_MS);
      } catch (err) {
        if (err.data?.error === 'ratelimited') {
          const wait = (err.data?.retryAfter ?? 10) * 1000;
          log(`[poller] Rate limited — pausing ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
        if (err.data?.error === 'invalid_auth' || err.data?.error === 'token_revoked') {
          log('[poller] Authentication failed. Your token may have expired. Please refresh your credentials.');
          running = false;
          return;
        }
        if (err.data?.error === 'not_in_channel' || err.data?.error === 'channel_not_found') {
          break;
        }
        log(`[poller] Error polling #${ch.name}: ${err.message}`);
        break;
      }
    } while (pageCursor);

    if (newestTs > oldest) {
      setPollCursor(db, ch.id, newestTs);
    }
  }

  async function pollThread(channelId, threadTs, sinceTs) {
    let cursor;
    try {
      do {
        const result = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: PAGE_SIZE,
          oldest: sinceTs,
          cursor,
        });
        for (const msg of result.messages ?? []) {
          upsertMessage(db, msg, channelId);
        }
        cursor = result.response_metadata?.next_cursor;
        if (cursor) await sleep(RATE_LIMIT_PAUSE_MS);
      } while (cursor);
    } catch {
      // Non-critical: thread fetch failure should not stop the poll cycle
    }
  }

  // ── Initial sync ──────────────────────────────────────────

  log('[poller] Initial channel + user sync...');
  await syncChannels();
  await syncUsers();
  log(`[poller] Tracking ${channelList.length} channels`);

  if (channelList.length > 30) {
    log(`[poller] Warning: ${channelList.length} channels — consider increasing --poll-interval to avoid rate limits`);
  }

  // ── Poll loop ─────────────────────────────────────────────

  async function pollCycle() {
    while (running) {
      // Periodically refresh channels and users
      if (Date.now() - lastChannelSync > CHANNEL_SYNC_INTERVAL_MS) {
        await syncChannels();
        await syncUsers();
        log(`[poller] Refreshed: ${channelList.length} channels`);
      }

      for (const ch of channelList) {
        if (!running) break;
        await pollChannel(ch);
      }

      if (running) await sleep(pollInterval);
    }
  }

  // Start the poll loop (non-blocking)
  const loopPromise = pollCycle();

  log(`[poller] Polling every ${pollInterval / 1000}s`);

  return {
    stop: () => {
      running = false;
      return loopPromise;
    },
  };
}
