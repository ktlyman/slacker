# CLAUDE.md

## Project Overview

Slack listener, historical importer, and RAG-like agent query interface. Captures
Slack messages in real-time via Socket Mode, bulk-imports channel history, stores
everything in SQLite with FTS5 full-text search, and exposes an HTTP API for
AI agents to query Slack context.

## Commands

- `npm start` — run main entry point
- `node bin/cli.js listen` — start real-time Slack listener (Socket Mode)
- `node bin/cli.js import` — bulk-import historical messages
- `node bin/cli.js serve` — start HTTP query API on port 3141
- `node bin/cli.js all` — import + listen + serve in sequence
- `npx github:LaymanAI/linter .` — lint this CLAUDE.md file

## Architecture

```
bin/cli.js          CLI entry point (Commander.js, 7 subcommands)
src/index.js        Library re-exports
src/listener/       Real-time Slack Socket Mode listener (@slack/bolt)
src/history/        Bulk historical message importer (@slack/web-api)
src/agent/query.js  SlackAgent class — search, context, thread, ask
src/agent/server.js Express HTTP API wrapping SlackAgent
src/storage/db.js   SQLite layer — schema, FTS5, upsert/query helpers
```

## Code Conventions

- Language: JavaScript (ESM — `"type": "module"` in package.json)
- MUST use `import`/`export` syntax, never `require()`
- Node.js built-ins MUST use the `node:` prefix (e.g., `import path from 'node:path'`)
- Database access MUST go through `src/storage/db.js` helpers. MUST NOT write raw SQL outside that file; instead, add new helpers to `src/storage/db.js` and import them
- Environment variables SHOULD be loaded via `dotenv/config` in the CLI entry point only

## Environment Variables

- `SLACK_BOT_TOKEN` — Bot OAuth token (required for all Slack operations)
- `SLACK_APP_TOKEN` — App-level token with `connections:write` scope (required for Socket Mode)
- `SLACK_SIGNING_SECRET` — Signing secret for request verification
- `DATABASE_PATH` — SQLite database file path (default: `slack-agent.db` in working directory)

Credentials MUST NOT be committed. Use a `.env` file locally (already in `.gitignore`).

## Database

SQLite with WAL mode and FTS5. Schema is auto-migrated on first `getDb()` call.
Tables: `channels`, `users`, `messages`, `import_cursors`, `messages_fts` (virtual).
Triggers keep FTS in sync on INSERT/DELETE automatically.

## HTTP API

Runs on port 3141 (configurable via `-p` flag). Key endpoints:
- `POST /ask` — natural language query
- `POST /search` — full-text search with filters
- `GET /recent/:channel` — recent channel messages
- `GET /thread/:channel/:threadTs` — full thread
- `GET /health` — health check
