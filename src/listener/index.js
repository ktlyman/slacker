import pkg from '@slack/bolt';
const { App } = pkg;
import { getDb, upsertMessage, upsertChannel, upsertUser } from '../storage/db.js';

/**
 * Start the real-time Slack listener using Socket Mode.
 *
 * Listens for:
 *  - message events (new messages, edits, deletes)
 *  - reaction_added / reaction_removed
 *  - channel_created / channel_rename
 *  - member_joined_channel (triggers user sync)
 *
 * Every captured event is persisted to the local SQLite database so the
 * agent query layer always has fresh data.
 */
export async function startListener(opts = {}) {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    throw new Error(
      'startListener requires bot mode credentials (SLACK_BOT_TOKEN + SLACK_APP_TOKEN). ' +
      'For user token or session token modes, use startPoller instead.'
    );
  }

  const db = getDb(opts.dbPath);

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
  });

  // ── Messages ────────────────────────────────────────────────
  app.message(async ({ message, client }) => {
    // Subtypes like message_deleted, message_changed, etc.
    if (message.subtype === 'message_deleted') return;

    // If it's an edit, unwrap the inner message
    const msg = message.subtype === 'message_changed' ? message.message : message;
    const channelId = message.channel;

    // Ensure we have the user cached
    if (msg.user) {
      try {
        const info = await client.users.info({ user: msg.user });
        if (info.ok) upsertUser(db, info.user);
      } catch { /* non-critical */ }
    }

    upsertMessage(db, msg, channelId);

    if (opts.onMessage) {
      opts.onMessage({
        type: message.subtype === 'message_changed' ? 'edited' : 'new',
        channelId,
        ts: msg.ts,
        user: msg.user,
        text: msg.text,
      });
    }
  });

  // ── Reactions ───────────────────────────────────────────────
  app.event('reaction_added', async ({ event, client }) => {
    // Re-fetch the message to update reactions list
    try {
      const result = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        inclusive: true,
        limit: 1,
      });
      if (result.ok && result.messages?.[0]) {
        upsertMessage(db, result.messages[0], event.item.channel);
      }
    } catch { /* non-critical */ }
  });

  app.event('reaction_removed', async ({ event, client }) => {
    try {
      const result = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        inclusive: true,
        limit: 1,
      });
      if (result.ok && result.messages?.[0]) {
        upsertMessage(db, result.messages[0], event.item.channel);
      }
    } catch { /* non-critical */ }
  });

  // ── Channel events ──────────────────────────────────────────
  app.event('channel_created', async ({ event }) => {
    upsertChannel(db, event.channel);
  });

  app.event('channel_rename', async ({ event }) => {
    upsertChannel(db, event.channel);
  });

  // ── Member join → sync user info ───────────────────────────
  app.event('member_joined_channel', async ({ event, client }) => {
    try {
      const info = await client.users.info({ user: event.user });
      if (info.ok) upsertUser(db, info.user);
    } catch { /* non-critical */ }
  });

  // ── Start ───────────────────────────────────────────────────
  await app.start();
  console.log('Slack listener running (Socket Mode)');
  return app;
}
