# CLAUDE.md

## Project Overview

Slack listener, historical importer, and RAG-like agent query interface. Captures
Slack messages in real-time (Socket Mode or polling), bulk-imports channel history,
stores everything in SQLite with FTS5 full-text search, and exposes an HTTP API for
AI agents to query Slack context. Supports three authentication modes: bot token,
user token, and session token.

## Commands

- `npm start` — run main entry point
- `node bin/cli.js serve` — import history, start listener, and serve query API (all-in-one)
- `node bin/cli.js import` — bulk-import historical messages only
- `node bin/cli.js listen` — start Slack listener only (Socket Mode or polling)
- `npx github:LaymanAI/linter .` — lint this CLAUDE.md file

## Architecture

```
bin/cli.js              CLI entry point (Commander.js, 6 subcommands)
src/index.js            Library re-exports
src/auth/resolve.js     Detect auth mode from env vars (bot/user/session)
src/auth/client.js      Create WebClient for any auth mode
src/listener/index.js   Real-time Socket Mode listener (bot mode only)
src/listener/poller.js  Polling-based listener (user/session modes)
src/history/            Bulk historical message importer (@slack/web-api)
src/agent/query.js      SlackAgent class — search, context, thread, ask
src/agent/server.js     Express HTTP API wrapping SlackAgent
src/storage/db.js       SQLite layer — schema, FTS5, upsert/query helpers
```

## Code Conventions

- Language: JavaScript (ESM — `"type": "module"` in package.json)
- MUST use `import`/`export` syntax, never `require()`
- Node.js built-ins MUST use the `node:` prefix (e.g., `import path from 'node:path'`)
- Database access MUST go through `src/storage/db.js` helpers. MUST NOT write raw SQL outside that file; instead, add new helpers to `src/storage/db.js` and import them
- Environment variables SHOULD be loaded via `dotenv/config` in the CLI entry point only

## Authentication Modes

Auth mode is auto-detected from environment variables (priority: bot > user > session).

**Bot mode** — full-featured, requires a Slack app installed by an admin:
- `SLACK_BOT_TOKEN` — Bot OAuth token (xoxb-)
- `SLACK_APP_TOKEN` — App-level token with `connections:write` scope (xapp-)
- `SLACK_SIGNING_SECRET` — Signing secret for request verification

**User token mode** — no admin approval needed on most workspaces:
- `SLACK_USER_TOKEN` — User OAuth token (xoxp-)

**Session token mode** — no app needed, uses browser cookies:
- `SLACK_COOKIE_TOKEN` — Session token extracted from browser (xoxc-)
- `SLACK_COOKIE_D` — Session cookie `d` value (xoxd-)

Additional shared variable:
- `DATABASE_PATH` — SQLite database file path (default: `slack-agent.db` in working directory)

Credentials MUST NOT be committed. Use a `.env` file locally (already in `.gitignore`).

## Database

SQLite with WAL mode and FTS5. Schema is auto-migrated on first `getDb()` call.
Tables: `channels`, `users`, `messages`, `import_cursors`, `poll_cursors`, `messages_fts` (virtual),
`pins`, `bookmarks`, `files`, `user_groups`, `stars`, `emoji`, `team`.
Triggers keep FTS in sync on INSERT/DELETE automatically.

The importer pulls all available Slack data: messages, threads, user profiles (with title,
email, timezone, status, avatar), pins, bookmarks, file metadata, user groups, starred items,
custom emoji, and team info. Use `--include-dms` to also import DMs and group DMs.

## HTTP API

Runs on port 3141 (configurable via `-p` flag). Key endpoints:
- `POST /ask` — natural language query
- `POST /search` — full-text search with filters
- `GET /recent/:channel` — recent channel messages
- `GET /thread/:channel/:threadTs` — full thread
- `GET /health` — health check
