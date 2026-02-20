#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { startListener } from '../src/listener/index.js';
import { startPoller } from '../src/listener/poller.js';
import { importHistory } from '../src/history/index.js';
import { SlackAgent } from '../src/agent/query.js';
import { startServer } from '../src/agent/server.js';
import { getDb, closeDb } from '../src/storage/db.js';
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
    console.log(`Auth mode: ${auth.mode}`);

    const onMessage = (m) => {
      const tag = m.type === 'edited' ? '(edited)' : '';
      console.log(`[${m.channelId}] ${m.user}: ${m.text} ${tag}`);
    };

    if (auth.mode === 'bot') {
      await startListener({ dbPath: opts.db, onMessage });
    } else {
      const client = createClient(auth);
      await startPoller({
        client,
        dbPath: opts.db,
        pollInterval: opts.pollInterval,
        onMessage,
      });
    }

    if (opts.withApi) {
      await startServer({ dbPath: opts.db, port: opts.port });
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

// ── serve ─────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start the agent query HTTP API (no listener)')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-p, --port <number>', 'port (default 3141)', parseInt)
  .action(async (opts) => {
    await startServer({ dbPath: opts.db, port: opts.port });
  });

// ── query (interactive CLI) ──────────────────────────────────
program
  .command('query <question>')
  .description('Ask a question against stored Slack data (CLI mode)')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-k, --top-k <number>', 'number of top results', parseInt, 5)
  .option('-c, --channel <name>', 'filter to a channel')
  .option('-u, --user <id>', 'filter to a user')
  .action((question, opts) => {
    const agent = new SlackAgent({ dbPath: opts.db });
    const result = agent.ask(question, {
      topK: opts.topK,
      channel: opts.channel,
      user: opts.user,
    });
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
    closeDb();
  });

// ── stats ─────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show database statistics')
  .option('-d, --db <path>', 'path to SQLite database')
  .action((opts) => {
    const db = getDb(opts.db);
    const agent = new SlackAgent({ dbPath: opts.db });
    const stats = agent.stats();
    console.log('\nSlack Agent Database Stats');
    console.log(`  Messages:  ${stats.messages}`);
    console.log(`  Channels:  ${stats.channels}`);
    console.log(`  Users:     ${stats.users}`);
    console.log(`  Threads:   ${stats.threads}`);
    console.log();
    closeDb();
  });

// ── channels ──────────────────────────────────────────────────
program
  .command('channels')
  .description('List all imported channels')
  .option('-d, --db <path>', 'path to SQLite database')
  .action((opts) => {
    const agent = new SlackAgent({ dbPath: opts.db });
    const channels = agent.channels();
    for (const ch of channels) {
      const vis = ch.is_private ? '🔒' : ' #';
      console.log(`${vis} ${ch.name} (${ch.id})${ch.topic ? ' — ' + ch.topic : ''}`);
    }
    console.log(`\n${channels.length} channels total`);
    closeDb();
  });

// ── all (listen + import + serve) ────────────────────────────
program
  .command('all')
  .description('Import history, start listener, and serve the query API')
  .option('-d, --db <path>', 'path to SQLite database')
  .option('-p, --port <number>', 'API port (default 3141)', parseInt)
  .option('-c, --channels <names...>', 'specific channel names or IDs to import')
  .option('--include-dms', 'also import DMs and group DMs')
  .option('--join-public', 'join unjoined public channels to import their history')
  .option('--poll-interval <ms>', 'polling interval in ms for user/session modes (default 30000)', parseInt)
  .action(async (opts) => {
    const auth = resolveAuth();
    const client = createClient(auth);
    console.log(`Auth mode: ${auth.mode}`);

    console.log('Step 1/3: Importing history...');
    await importHistory({
      client,
      authMode: auth.mode,
      dbPath: opts.db,
      channels: opts.channels,
      includeDms: opts.includeDms,
      joinPublic: opts.joinPublic,
    });

    console.log('\nStep 2/3: Starting listener...');
    const onMessage = (m) => {
      console.log(`[live] #${m.channelId} ${m.user}: ${m.text}`);
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

    console.log('\nStep 3/3: Starting query API...');
    await startServer({ dbPath: opts.db, port: opts.port });
  });

program.parse();
