import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SlackAgent } from './query.js';

/**
 * Start an MCP (Model Context Protocol) server over stdio.
 *
 * Exposes all SlackAgent query methods as MCP tools so that Claude Code,
 * Cursor, and other MCP-compatible clients can search and browse Slack
 * data natively — no HTTP needed.
 *
 * Usage in .claude/settings.json:
 *   {
 *     "mcpServers": {
 *       "slack": {
 *         "command": "node",
 *         "args": ["bin/cli.js", "mcp"],
 *         "env": { "DATABASE_PATH": "/path/to/slack-agent.db" }
 *       }
 *     }
 *   }
 */
export async function startMcpServer(opts = {}) {
  // MCP uses stdout for JSON-RPC protocol messages — redirect all
  // application logging to stderr so it doesn't corrupt the protocol.
  console.log = console.error;

  const agent = new SlackAgent(opts);
  const server = new McpServer({
    name: 'slack-agent',
    version: '1.0.0',
  });

  /** Register an MCP tool that wraps a SlackAgent call. */
  function tool(name, description, schema, fn) {
    server.tool(name, description, schema, async (params) => {
      try {
        const result = fn(params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    });
  }

  tool('slack_search',
    'Search Slack messages using full-text search. Supports filtering by channel, user, and date range.',
    {
      query: z.string().describe('Search terms (natural language or keywords)'),
      channel: z.string().optional().describe('Filter to channel name or ID'),
      user: z.string().optional().describe('Filter to user ID or name'),
      limit: z.number().optional().describe('Max results (default 25)'),
      before: z.string().optional().describe('Only messages before this Slack timestamp'),
      after: z.string().optional().describe('Only messages after this Slack timestamp'),
    },
    ({ query, channel, user, limit, before, after }) =>
      agent.search(query, { channel, user, limit, before, after })
  );

  tool('slack_ask',
    'Ask a question against the Slack corpus. Returns the most relevant messages plus surrounding context. Best for AI agents that need contextual answers.',
    {
      question: z.string().describe('Natural language question'),
      channel: z.string().optional().describe('Filter to channel name or ID'),
      user: z.string().optional().describe('Filter to user ID or name'),
      topK: z.number().optional().describe('Number of top results (default 5)'),
    },
    ({ question, channel, user, topK }) =>
      agent.ask(question, { channel, user, topK })
  );

  tool('slack_recent',
    'Get the most recent messages from a Slack channel.',
    {
      channel: z.string().describe('Channel name or ID'),
      limit: z.number().optional().describe('Max messages (default 50)'),
    },
    ({ channel, limit }) => agent.recent(channel, limit)
  );

  tool('slack_thread',
    'Get all messages in a Slack thread.',
    {
      channel: z.string().describe('Channel name or ID'),
      threadTs: z.string().describe('Parent message timestamp (thread_ts)'),
    },
    ({ channel, threadTs }) => agent.thread(channel, threadTs)
  );

  tool('slack_context',
    'Get messages surrounding a specific message for conversational context.',
    {
      channel: z.string().describe('Channel name or ID'),
      ts: z.string().describe('Message timestamp to center on'),
      window: z.number().optional().describe('Number of surrounding messages (default 10)'),
    },
    ({ channel, ts, window }) => agent.context(channel, ts, window)
  );

  tool('slack_user_messages',
    'Get messages posted by a specific user.',
    {
      user: z.string().describe('User ID, display name, or username'),
      channel: z.string().optional().describe('Filter to channel name or ID'),
      limit: z.number().optional().describe('Max messages (default 50)'),
    },
    ({ user, channel, limit }) => agent.userMessages(user, { channel, limit })
  );

  tool('slack_channels',
    'List all Slack channels in the database.',
    {},
    () => agent.channels()
  );

  tool('slack_users',
    'List all Slack users in the database.',
    {},
    () => agent.users()
  );

  tool('slack_stats',
    'Get database statistics: message count, channel count, user count, thread count.',
    {},
    () => agent.stats()
  );

  tool('slack_team',
    'Get workspace/team info (name, domain, icon).',
    {},
    () => agent.teamInfo()
  );

  tool('slack_pins',
    'Get pinned messages for a Slack channel.',
    { channel: z.string().describe('Channel name or ID') },
    ({ channel }) => agent.pinsForChannel(channel)
  );

  tool('slack_bookmarks',
    'Get bookmarks for a Slack channel.',
    { channel: z.string().describe('Channel name or ID') },
    ({ channel }) => agent.bookmarksForChannel(channel)
  );

  tool('slack_digest',
    'Get an activity digest for a Slack channel. Returns message counts, active users, top posters, and hourly activity over a time window.',
    {
      channel: z.string().describe('Channel name or ID'),
      hours: z.number().optional().describe('Time window in hours (default 24)'),
    },
    ({ channel, hours }) => agent.digest(channel, { hours })
  );

  tool('slack_workspace_summary',
    'Get a workspace-wide summary with aggregate statistics. Returns total messages, channels, users (broken down by bots vs humans), per-channel activity, and daily message volume over the last 30 days.',
    {},
    () => agent.workspaceSummary()
  );

  tool('slack_unfurls',
    'Get URL unfurls (link previews) from message attachments in a channel. Returns structured unfurl data including URL, title, description, image, and service name.',
    {
      channel: z.string().describe('Channel name or ID'),
      limit: z.number().optional().describe('Max messages to scan for unfurls (default 50)'),
    },
    ({ channel, limit }) => agent.unfurls(channel, { limit })
  );

  // ── Connect stdio transport ───────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
