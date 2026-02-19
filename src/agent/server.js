import express from 'express';
import { SlackAgent } from './query.js';

/**
 * Start an HTTP server that exposes the SlackAgent query interface as a
 * REST API.  This lets any agent, script, or tool query Slack data over
 * HTTP — similar to querying a RAG database or Gemini with NotebookLM.
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
 */
export function startServer(opts = {}) {
  const port = opts.port ?? process.env.AGENT_API_PORT ?? 3141;
  const agent = new SlackAgent(opts);
  const app = express();

  app.use(express.json());

  // ── Health ──────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ ok: true, ...agent.stats() });
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
    res.json(agent.stats());
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Agent query API listening on http://localhost:${port}`);
      console.log('Endpoints: POST /ask, POST /search, GET /channels, GET /users, GET /recent/:ch, GET /thread/:ch/:ts, GET /stats');
      resolve(server);
    });
  });
}
