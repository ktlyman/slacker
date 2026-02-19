# slack-agent

Slack listener, historical importer, and RAG-like agent query interface.

Captures Slack messages in real-time, imports history, stores everything in a
local SQLite database with full-text search, and exposes a simple API that any
AI agent can use to retrieve relevant Slack context — similar to querying a RAG
database or Gemini with NotebookLM.

## Architecture

```
Slack workspace
  │
  ├──▶ Listener (Socket Mode)  ──▶ SQLite (FTS5)
  │      real-time messages           │
  │                                   │
  ├──▶ History Importer         ──▶   │  (incremental)
  │      bulk channel history         │
  │                                   ▼
  │                              Agent Query API
  │                              POST /ask   ← "What broke prod?"
  │                              POST /search
  │                              GET  /recent/:channel
  │                              GET  /thread/:ch/:ts
  └──────────────────────────────GET  /stats
```

## Slack App Setup

1. Go to https://api.slack.com/apps and create a new app
2. Enable **Socket Mode** (Settings → Socket Mode → toggle on)
   - Create an app-level token with `connections:write` scope → save as `SLACK_APP_TOKEN`
3. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `channels:history`
   - `channels:read`
   - `channels:join`
   - `groups:history` (for private channels)
   - `groups:read`
   - `im:history` (for DMs, optional)
   - `reactions:read`
   - `users:read`
4. Under **Event Subscriptions**, subscribe to these bot events:
   - `message.channels`
   - `message.groups`
   - `reaction_added`
   - `reaction_removed`
   - `channel_created`
   - `channel_rename`
   - `member_joined_channel`
5. Install the app to your workspace
6. Copy the **Bot User OAuth Token** → save as `SLACK_BOT_TOKEN`
7. Copy the **Signing Secret** (Basic Information page) → save as `SLACK_SIGNING_SECRET`

## Installation

```bash
cd slack-agent
cp .env.example .env
# Edit .env with your Slack credentials
npm install
```

## Usage

### Import history + start listener + serve API (all-in-one)

```bash
npm start        # or: node bin/cli.js all
```

### Individual commands

```bash
# Import historical messages from all channels
node bin/cli.js import

# Import only specific channels
node bin/cli.js import -c general engineering

# Start the real-time listener
node bin/cli.js listen

# Start listener + query API together
node bin/cli.js listen --with-api

# Start only the query API server
node bin/cli.js serve

# Query from the command line
node bin/cli.js query "deployment issues last week"
node bin/cli.js query "authentication bug" --channel engineering

# Show database stats
node bin/cli.js stats

# List imported channels
node bin/cli.js channels
```

## Agent Query API

The HTTP API runs on port 3141 by default. All endpoints return JSON.

### POST /ask (recommended for agents)

The primary endpoint. Accepts a natural-language question, returns relevant
messages plus surrounding context — ready for an LLM to consume.

```bash
curl -X POST http://localhost:3141/ask \
  -H 'Content-Type: application/json' \
  -d '{"question": "What decisions were made about the new API?"}'
```

Response:
```json
{
  "query": "What decisions were made about the new API?",
  "hits": [
    {
      "ts": "1708300000.000100",
      "channel": "engineering",
      "user": "Alice",
      "text": "We decided to go with REST over GraphQL for the public API",
      "permalink": "https://myteam.slack.com/archives/C123/p1708300000000100"
    }
  ],
  "context": {
    "C123:1708300000.000100": {
      "type": "context",
      "channel": "engineering",
      "messages": [ ... ]
    }
  },
  "stats": { "messages": 15420, "channels": 23, "users": 87, "threads": 2104 }
}
```

### POST /search

Full-text search with optional filters.

```bash
curl -X POST http://localhost:3141/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "database migration", "channel": "ops", "limit": 10}'
```

### GET /recent/:channel

```bash
curl http://localhost:3141/recent/general?limit=20
```

### GET /thread/:channel/:threadTs

```bash
curl http://localhost:3141/thread/engineering/1708300000.000100
```

### GET /context/:channel/:ts

```bash
curl http://localhost:3141/context/general/1708300000.000100?window=10
```

### GET /user/:userId

```bash
curl http://localhost:3141/user/U12345?limit=20&channel=engineering
```

### GET /channels, /users, /stats

```bash
curl http://localhost:3141/channels
curl http://localhost:3141/users
curl http://localhost:3141/stats
```

## Using from code (as a library)

```javascript
import { SlackAgent, importHistory, startListener, startServer } from './src/index.js';

// Direct programmatic queries (no HTTP server needed)
const agent = new SlackAgent();

const answer = agent.ask('What broke production last week?');
console.log(answer.hits);

const recent = agent.recent('#ops', 20);
const thread = agent.thread('#engineering', '1708300000.000100');
const results = agent.search('deployment pipeline', { channel: 'ops' });
```

## Database

All data is stored in a single SQLite file (`slack-agent.db` by default).
Uses FTS5 for full-text search with Porter stemming and Unicode support.

Tables: `messages`, `channels`, `users`, `import_cursors`
Virtual table: `messages_fts` (auto-synced via triggers)

The database file can be backed up, copied, or shared as-is.
