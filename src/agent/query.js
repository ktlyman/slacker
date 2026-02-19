import {
  getDb, searchMessages, getContext, getThread,
  getRecent, getStats, listChannels, getMessagesByUser,
} from '../storage/db.js';

/**
 * SlackAgent — a RAG-like query interface for Slack data.
 *
 * Designed to be used by AI agents, tools, or scripts that need
 * contextual information from Slack without hitting the Slack API directly.
 * All queries run against the local SQLite database populated by the
 * listener and/or history importer.
 *
 * Usage:
 *   const agent = new SlackAgent();
 *   const results = agent.search('deployment pipeline broken');
 *   const thread  = agent.thread('#ops', '1708300000.000100');
 */
export class SlackAgent {
  constructor(opts = {}) {
    this.db = getDb(opts.dbPath);
  }

  // ── Core search ─────────────────────────────────────────────

  /**
   * Full-text search across all stored messages.
   * Accepts natural language or keywords — FTS5 handles stemming.
   *
   * @param {string} query - search terms
   * @param {object} opts
   * @param {number} opts.limit - max results (default 25)
   * @param {string} opts.channel - filter to a specific channel name or ID
   * @param {string} opts.user - filter to a specific user ID
   * @param {string} opts.before - only messages before this Slack ts
   * @param {string} opts.after - only messages after this Slack ts
   * @returns {Array} matching messages with user/channel metadata
   */
  search(query, opts = {}) {
    const channelId = opts.channel ? this._resolveChannel(opts.channel) : undefined;
    return searchMessages(this.db, query, {
      limit: opts.limit,
      channelId,
      userId: opts.user,
      before: opts.before,
      after: opts.after,
    });
  }

  // ── Context retrieval ───────────────────────────────────────

  /**
   * Get messages surrounding a specific message for conversational context.
   *
   * @param {string} channel - channel name or ID
   * @param {string} ts - Slack message timestamp
   * @param {number} window - number of surrounding messages (default 10)
   */
  context(channel, ts, window = 10) {
    const channelId = this._resolveChannel(channel);
    return getContext(this.db, channelId, ts, window);
  }

  /**
   * Get all messages in a thread.
   *
   * @param {string} channel - channel name or ID
   * @param {string} threadTs - the parent message's ts
   */
  thread(channel, threadTs) {
    const channelId = this._resolveChannel(channel);
    return getThread(this.db, channelId, threadTs);
  }

  /**
   * Get the N most recent messages from a channel.
   *
   * @param {string} channel - channel name or ID
   * @param {number} limit - max results (default 50)
   */
  recent(channel, limit = 50) {
    const channelId = this._resolveChannel(channel);
    return getRecent(this.db, channelId, limit);
  }

  // ── User queries ────────────────────────────────────────────

  /**
   * Get messages posted by a specific user.
   *
   * @param {string} userQuery - user ID, display name, or username
   * @param {object} opts
   */
  userMessages(userQuery, opts = {}) {
    const userId = this._resolveUser(userQuery);
    const channelId = opts.channel ? this._resolveChannel(opts.channel) : undefined;
    return getMessagesByUser(this.db, userId, { channelId, limit: opts.limit });
  }

  // ── Metadata ────────────────────────────────────────────────

  /** Get summary stats (message count, channels, users, threads). */
  stats() {
    return getStats(this.db);
  }

  /** List all channels in the database. */
  channels() {
    return listChannels(this.db);
  }

  /** List all users in the database. */
  users() {
    return this.db.prepare(
      'SELECT id, name, real_name, display_name, is_bot FROM users ORDER BY name'
    ).all();
  }

  // ── Compound queries (agent-friendly) ───────────────────────

  /**
   * "Ask" the Slack corpus a question. Returns a structured response with
   * the most relevant messages, plus surrounding context for the top hits.
   * Designed to be consumed directly by an LLM agent.
   *
   * @param {string} question - natural language question
   * @param {object} opts
   * @param {number} opts.topK - number of top results (default 5)
   * @param {number} opts.contextWindow - surrounding messages per hit (default 6)
   * @returns {{ hits: Array, context: Object, stats: Object }}
   */
  ask(question, opts = {}) {
    const topK = opts.topK ?? 5;
    const contextWindow = opts.contextWindow ?? 6;

    const hits = this.search(question, { limit: topK, ...opts });
    const contextMap = {};

    for (const hit of hits) {
      const key = `${hit.channel_id}:${hit.thread_ts || hit.ts}`;
      if (contextMap[key]) continue; // already fetched context for this thread

      if (hit.thread_ts) {
        // It's a thread reply — fetch full thread
        contextMap[key] = {
          type: 'thread',
          channel: hit.channel_name,
          messages: getThread(this.db, hit.channel_id, hit.thread_ts),
        };
      } else {
        // Top-level message — fetch surrounding context
        contextMap[key] = {
          type: 'context',
          channel: hit.channel_name,
          messages: getContext(this.db, hit.channel_id, hit.ts, contextWindow),
        };
      }
    }

    return {
      query: question,
      hits: hits.map(h => ({
        ts: h.ts,
        channel: h.channel_name,
        user: h.user_display_name || h.user_real_name || h.user_name,
        text: h.text,
        thread_ts: h.thread_ts,
        permalink: h.permalink,
      })),
      context: contextMap,
      stats: getStats(this.db),
    };
  }

  // ── Private helpers ─────────────────────────────────────────

  _resolveChannel(query) {
    if (!query) return undefined;
    // Strip leading # if present
    const clean = query.replace(/^#/, '');
    // Try by ID first
    const byId = this.db.prepare('SELECT id FROM channels WHERE id = ?').get(clean);
    if (byId) return byId.id;
    // Then by name (case-insensitive)
    const byName = this.db.prepare('SELECT id FROM channels WHERE LOWER(name) = LOWER(?)').get(clean);
    return byName?.id ?? clean; // fall back to raw value
  }

  _resolveUser(query) {
    if (!query) return undefined;
    const byId = this.db.prepare('SELECT id FROM users WHERE id = ?').get(query);
    if (byId) return byId.id;
    const byName = this.db.prepare(
      'SELECT id FROM users WHERE LOWER(name) = LOWER(?) OR LOWER(display_name) = LOWER(?) OR LOWER(real_name) = LOWER(?)'
    ).get(query, query, query);
    return byName?.id ?? query;
  }
}
