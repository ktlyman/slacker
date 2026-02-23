#!/usr/bin/env node

import 'dotenv/config';
import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { startListener } from '../src/listener/index.js';
import { startPoller } from '../src/listener/poller.js';
import { importHistory } from '../src/history/index.js';
import { SlackAgent } from '../src/agent/query.js';
import { startServer } from '../src/agent/server.js';
import { startMcpServer } from '../src/agent/mcp.js';
import { closeDb } from '../src/storage/db.js';
import { resolveAuth } from '../src/auth/resolve.js';
import { createClient } from '../src/auth/client.js';

const program = new Command();

program
  .name('slack-agent')
  .description('Slack listener, history importer, and agent query interface')
  .version('1.0.0');

// ── listen ────────────────────────────────────────────────────
program
  .command('listen')
  .description('Start the real-time Slack message listener')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('--with-api', 'also start the agent query HTTP API')
  .option('-p, --port <number>', 'API port (default 3141)', parseInt)
  .option('--poll-interval <ms>', 'polling interval in ms for user/session modes (default 30000)', parseInt)
  .action(async (opts) => {
    const auth = resolveAuth();
    const client = createClient(auth);
    console.log(`Auth mode: ${auth.mode}`);

    const messageBus = new EventEmitter();

    const onMessage = (m) => {
      const tag = m.type === 'edited' ? '(edited)' : '';
      console.log(`[${m.channelId}] ${m.user}: ${m.text} ${tag}`);
      messageBus.emit('message', m);
    };

    if (auth.mode === 'bot') {
      await startListener({ dbPath: opts.db, onMessage });
    } else {
      await startPoller({
        client,
        dbPath: opts.db,
        pollInterval: opts.pollInterval,
        onMessage,
      });
    }

    if (opts.withApi) {
      await startServer({ dbPath: opts.db, port: opts.port, messageBus, client });
    }
  });

// ── import ────────────────────────────────────────────────────
program
  .command('import')
  .description('Import historical messages from Slack')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-c, --channels <names...>', 'specific channel names or IDs to import')
  .option('--include-dms', 'also import DMs and group DMs')
  .option('--join-public', 'join unjoined public channels to import their history')
  .action(async (opts) => {
    const auth = resolveAuth();
    const client = createClient(auth);
    console.log(`Auth mode: ${auth.mode}`);

    await importHistory({
      client,
      authMode: auth.mode,
      dbPath: opts.db,
      channels: opts.channels,
      includeDms: opts.includeDms,
      joinPublic: opts.joinPublic,
    });
    closeDb();
  });

// ── serve (all-in-one: import → listen → API) ────────────────
program
  .command('serve')
  .description('Import history, start listener, and serve the query API')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-p, --port <number>', 'API port (default 3141)', parseInt)
  .option('-c, --channels <names...>', 'specific channel names or IDs to import')
  .option('--include-dms', 'also import DMs and group DMs')
  .option('--join-public', 'join unjoined public channels to import their history')
  .option('--poll-interval <ms>', 'polling interval in ms for user/session modes (default 30000)', parseInt)
  .option('--skip-import', 'skip the initial history import and go straight to listen + API')
  .action(async (opts) => {
    const auth = resolveAuth();
    const client = createClient(auth);
    console.log(`Auth mode: ${auth.mode}`);

    // Shared event bus for SSE — listener emits, server streams to clients
    const messageBus = new EventEmitter();

    // Start the API + frontend first so the UI is available immediately
    console.log('Step 1/3: Starting query API + frontend...');
    await startServer({ dbPath: opts.db, port: opts.port, messageBus, client });

    // Start the listener second so live messages are captured during import
    console.log('\nStep 2/3: Starting listener...');
    const onMessage = (m) => {
      console.log(`[live] #${m.channelId} ${m.user}: ${m.text}`);
      messageBus.emit('message', m);
    };

    if (auth.mode === 'bot') {
      await startListener({ dbPath: opts.db, onMessage });
    } else {
      await startPoller({
        client,
        dbPath: opts.db,
        pollInterval: opts.pollInterval,
        onMessage,
      });
    }

    if (!opts.skipImport) {
      console.log('\nStep 3/3: Importing history (runs in background)...');
      // Don't await — let it run while the UI is already serving
      importHistory({
        client,
        authMode: auth.mode,
        dbPath: opts.db,
        channels: opts.channels,
        includeDms: opts.includeDms,
        joinPublic: opts.joinPublic,
      }).then(() => {
        console.log('\nHistory import finished.');
      }).catch((err) => {
        console.error('\nHistory import failed:', err.message);
      });
    } else {
      console.log('\nStep 3/3: Skipping import (--skip-import)');
    }
  });

// ── mcp ──────────────────────────────────────────────────────
program
  .command('mcp')
  .description('Start MCP server for Claude Code and other MCP clients (stdio)')
  .option('-d, --db <path>', 'path to SQLite database')
  .action(async (opts) => {
    await startMcpServer({ dbPath: opts.db });
  });

// ── query (interactive CLI) ──────────────────────────────────
program
  .command('query <question>')
  .description('Ask a question against stored Slack data (CLI mode)')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-k, --top-k <number>', 'number of top results', parseInt, 5)
  .option('-c, --channel <name>', 'filter to a channel')
  .option('-u, --user <id>', 'filter to a user')
  .option('--json', 'output as JSON')
  .action((question, opts) => {
    const agent = new SlackAgent({ dbPath: opts.db });
    const result = agent.ask(question, {
      topK: opts.topK,
      channel: opts.channel,
      user: opts.user,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n=== Search Results ===\n');
      for (const hit of result.hits) {
        const user = hit.user || 'unknown';
        const ch = hit.channel || '?';
        console.log(`#${ch} | ${user}: ${hit.text}`);
        if (hit.permalink) console.log(`  ${hit.permalink}`);
        console.log();
      }
      console.log(`--- ${result.hits.length} hits | ${Object.keys(result.context).length} context blocks ---`);
      console.log(`DB: ${result.stats.messages} messages, ${result.stats.channels} channels, ${result.stats.users} users\n`);
    }
    closeDb();
  });

// ── stats ─────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show database statistics')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('--json', 'output as JSON')
  .action((opts) => {
    const agent = new SlackAgent({ dbPath: opts.db });
    const stats = agent.stats();

    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log('\nSlack Agent Database Stats');
      console.log(`  Messages:  ${stats.messages}`);
      console.log(`  Channels:  ${stats.channels}`);
      console.log(`  Users:     ${stats.users}`);
      console.log(`  Threads:   ${stats.threads}`);
      console.log();
    }
    closeDb();
  });

// ── channels ──────────────────────────────────────────────────
program
  .command('channels')
  .description('List all imported channels')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('--json', 'output as JSON')
  .action((opts) => {
    const agent = new SlackAgent({ dbPath: opts.db });
    const channels = agent.channels();

    if (opts.json) {
      console.log(JSON.stringify(channels, null, 2));
    } else {
      for (const ch of channels) {
        const vis = ch.is_private ? '🔒' : ' #';
        console.log(`${vis} ${ch.name} (${ch.id})${ch.topic ? ' — ' + ch.topic : ''}`);
      }
      console.log(`\n${channels.length} channels total`);
    }
    closeDb();
  });

program.parse();
