import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SlackAgent } from './query.js';
import { openApiSpec } from './openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Start an HTTP server that exposes the SlackAgent query interface as a
 * REST API.  This lets any agent, script, or tool query Slack data over
 * HTTP — similar to querying a RAG database or Gemini with NotebookLM.
 *
 * Also serves a lightweight Slack-clone web frontend from src/frontend/.
 *
 * Endpoints:
 *   POST /ask          — natural language query (compound search + context)
 *   POST /search       — full-text search
 *   GET  /channels     — list channels
 *   GET  /users        — list users
 *   GET  /recent/:ch   — recent messages in a channel
 *   GET  /thread/:ch/:ts — full thread
 *   GET  /context/:ch/:ts — messages surrounding a timestamp
 *   GET  /user/:id     — messages by user
 *   GET  /stats        — database stats
 *   GET  /team         — workspace info
 *   GET  /channels/rich — channels with counts (frontend)
 *   GET  /users/rich   — users with avatars (frontend)
 *   GET  /recent/:ch/rich — messages with avatars (frontend)
 *   GET  /thread/:ch/:ts/rich — thread with avatars (frontend)
 *   GET  /pins/:ch     — pins for a channel
 *   GET  /bookmarks/:ch — bookmarks for a channel
 *   GET  /digest/:ch     — channel activity digest
 *   GET  /workspace/summary — workspace-wide aggregate stats
 *   GET  /unfurls/:ch   — URL unfurls from a channel
 *   GET  /presence/:user — user presence (requires live Slack client)
 *   GET  /events        — SSE stream of live messages (requires listener)
 *   GET  /openapi.json  — OpenAPI 3.1 spec
 */
export function startServer(opts = {}) {
  const port = opts.port ?? process.env.AGENT_API_PORT ?? 3141;
  const agent = new SlackAgent(opts);
  const messageBus = opts.messageBus ?? null;
  const slackClient = opts.client ?? null;
  const app = express();

  app.use(express.json());

  // ── Static frontend ──────────────────────────────────────────
  app.use(express.static(path.join(__dirname, '..', 'frontend')));

  // ── Health ──────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ ok: true, ...agent.stats() });
  });

  // ── OpenAPI spec ──────────────────────────────────────────
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });

  // ── Ask (compound query — best for agents) ─────────────────
  app.post('/ask', (req, res) => {
    const { question, topK, contextWindow, channel, user } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    try {
      const result = agent.ask(question, { topK, contextWindow, channel, user });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Search ──────────────────────────────────────────────────
  app.post('/search', (req, res) => {
    const { query, limit, channel, user, before, after } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    try {
      const results = agent.search(query, { limit, channel, user, before, after });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Channels ────────────────────────────────────────────────
  app.get('/channels', (_req, res) => {
    res.json({ channels: agent.channels() });
  });

  // ── Users ───────────────────────────────────────────────────
  app.get('/users', (_req, res) => {
    res.json({ users: agent.users() });
  });

  // ── Recent messages in a channel ────────────────────────────
  app.get('/recent/:channel', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    try {
      const messages = agent.recent(req.params.channel, limit);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Thread ──────────────────────────────────────────────────
  app.get('/thread/:channel/:threadTs', (req, res) => {
    try {
      const messages = agent.thread(req.params.channel, req.params.threadTs);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Context around a message ────────────────────────────────
  app.get('/context/:channel/:ts', (req, res) => {
    const window = parseInt(req.query.window) || 10;
    try {
      const messages = agent.context(req.params.channel, req.params.ts, window);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Messages by user ───────────────────────────────────────
  app.get('/user/:userId', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const channel = req.query.channel;
    try {
      const messages = agent.userMessages(req.params.userId, { channel, limit });
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Stats ───────────────────────────────────────────────────
  app.get('/stats', (_req, res) => {
    res.json({ stats: agent.stats() });
  });

  // ── Team info ───────────────────────────────────────────────
  app.get('/team', (_req, res) => {
    res.json({ team: agent.teamInfo() });
  });

  // ── Rich channels (with message counts, for frontend) ──────
  app.get('/channels/rich', (_req, res) => {
    res.json({ channels: agent.channelsRich() });
  });

  // ── Rich users (with avatars, for frontend) ────────────────
  app.get('/users/rich', (_req, res) => {
    res.json({ users: agent.usersRich() });
  });

  // ── Rich recent messages (with avatars, reactions) ─────────
  app.get('/recent/:channel/rich', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    try {
      const messages = agent.recentRich(req.params.channel, limit);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Rich thread (with avatars, reactions) ──────────────────
  app.get('/thread/:channel/:threadTs/rich', (req, res) => {
    try {
      const messages = agent.threadRich(req.params.channel, req.params.threadTs);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pins for a channel ────────────────────────────────────
  app.get('/pins/:channel', (req, res) => {
    try {
      const pins = agent.pinsForChannel(req.params.channel);
      res.json({ pins });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Bookmarks for a channel ───────────────────────────────
  app.get('/bookmarks/:channel', (req, res) => {
    try {
      const bookmarks = agent.bookmarksForChannel(req.params.channel);
      res.json({ bookmarks });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Channel activity digest ──────────────────────────────
  app.get('/digest/:channel', (req, res) => {
    const hours = parseInt(req.query.hours) || 24;
    try {
      const digest = agent.digest(req.params.channel, { hours });
      res.json({ digest });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Workspace summary ────────────────────────────────────
  app.get('/workspace/summary', (_req, res) => {
    try {
      const summary = agent.workspaceSummary();
      res.json({ summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── URL unfurls for a channel ──────────────────────────
  app.get('/unfurls/:channel', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    try {
      const unfurls = agent.unfurls(req.params.channel, { limit });
      res.json({ unfurls });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── User presence (requires live Slack client) ─────────
  app.get('/presence/:user', async (req, res) => {
    if (!slackClient) {
      return res.status(503).json({ error: 'Presence not available (no live Slack client)' });
    }
    try {
      const userId = req.params.user;
      const result = await slackClient.users.getPresence({ user: userId });
      res.json({
        user_id: userId,
        presence: result.presence,
        online: result.online ?? (result.presence === 'active'),
        last_activity: result.last_activity ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Server-Sent Events for live messages ─────────────────
  app.get('/events', (req, res) => {
    if (!messageBus) {
      return res.status(503).json({ error: 'Live events not available (no listener running)' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();
    res.write(':ok\n\n');

    const channelFilter = req.query.channel ?? null;

    const onMessage = (msg) => {
      if (channelFilter && msg.channelId !== channelFilter) return;
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    };

    messageBus.on('message', onMessage);
    req.on('close', () => {
      messageBus.off('message', onMessage);
    });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Slacker UI: http://localhost:${port}`);
      console.log(`Agent API:  http://localhost:${port}/health`);
      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n✖ Port ${port} is already in use.`);
        console.error(`  Kill the existing process: lsof -ti :${port} | xargs kill`);
        console.error(`  Or use a different port: --port <number>\n`);
      }
      reject(err);
    });
  });
}
