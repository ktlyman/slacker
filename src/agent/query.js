import {
  getDb, searchMessages, getContext, getThread,
  getRecent, getStats, listChannels, listUsers, getMessagesByUser,
  getRecentRich, getThreadRich, listUsersRich, listChannelsRich,
  getPinsForChannel, getBookmarksForChannel, getTeamInfo,
  getChannelDigest, getWorkspaceSummary, getUnfurls,
  resolveChannelId, resolveUserId,
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
    return listUsers(this.db);
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

  // ── Rich queries (for frontend) ─────────────────────────────

  /** Recent messages with avatars, reactions, attachments. */
  recentRich(channel, limit = 100) {
    const channelId = this._resolveChannel(channel);
    return getRecentRich(this.db, channelId, limit);
  }

  /** Full thread with avatars, reactions, attachments. */
  threadRich(channel, threadTs) {
    const channelId = this._resolveChannel(channel);
    return getThreadRich(this.db, channelId, threadTs);
  }

  /** All users with full profile data. */
  usersRich() {
    return listUsersRich(this.db);
  }

  /** Channels sorted by latest activity with message counts. */
  channelsRich() {
    return listChannelsRich(this.db);
  }

  /** Pins for a channel with message text and user. */
  pinsForChannel(channel) {
    const channelId = this._resolveChannel(channel);
    return getPinsForChannel(this.db, channelId);
  }

  /** Bookmarks for a channel with creator info. */
  bookmarksForChannel(channel) {
    const channelId = this._resolveChannel(channel);
    return getBookmarksForChannel(this.db, channelId);
  }

  /** Team/workspace info. */
  teamInfo() {
    return getTeamInfo(this.db);
  }

  /** Activity digest for a channel over a time window. */
  digest(channel, opts = {}) {
    const channelId = this._resolveChannel(channel);
    return getChannelDigest(this.db, channelId, { hours: opts.hours });
  }

  /** Workspace-wide summary with aggregate stats and per-channel activity. */
  workspaceSummary() {
    return getWorkspaceSummary(this.db);
  }

  /** URL unfurls from message attachments in a channel. */
  unfurls(channel, opts = {}) {
    const channelId = this._resolveChannel(channel);
    return getUnfurls(this.db, channelId, { limit: opts.limit });
  }

  // ── Private helpers ─────────────────────────────────────────

  _resolveChannel(query) {
    return resolveChannelId(this.db, query);
  }

  _resolveUser(query) {
    return resolveUserId(this.db, query);
  }
}
