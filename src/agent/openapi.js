/**
 * OpenAPI 3.1 specification for the Slacker Agent API.
 * Served at GET /openapi.json by the HTTP server.
 */
export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Slacker Agent API',
    version: '1.0.0',
    description: 'REST API for querying Slack data stored in SQLite. Supports full-text search, thread retrieval, channel browsing, real-time SSE streaming, and AI-agent-friendly compound queries.',
  },
  servers: [{ url: 'http://localhost:3141' }],
  paths: {
    '/health': {
      get: { summary: 'Health check and DB stats', operationId: 'getHealth', responses: { 200: { description: 'OK' } } },
    },
    '/ask': {
      post: {
        summary: 'Natural language query (compound search + context)',
        operationId: 'postAsk',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, topK: { type: 'integer', default: 5 }, contextWindow: { type: 'integer', default: 6 }, channel: { type: 'string' }, user: { type: 'string' } } } } } },
        responses: { 200: { description: 'Search results with context' }, 400: { description: 'Missing question' } },
      },
    },
    '/search': {
      post: {
        summary: 'Full-text search with filters',
        operationId: 'postSearch',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', default: 25 }, channel: { type: 'string' }, user: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } } } } } },
        responses: { 200: { description: 'Search results' }, 400: { description: 'Missing query' } },
      },
    },
    '/channels': { get: { summary: 'List all channels', operationId: 'getChannels', responses: { 200: { description: 'Channel list' } } } },
    '/users': { get: { summary: 'List all users', operationId: 'getUsers', responses: { 200: { description: 'User list' } } } },
    '/stats': { get: { summary: 'Database statistics', operationId: 'getStats', responses: { 200: { description: 'Stats' } } } },
    '/team': { get: { summary: 'Workspace info', operationId: 'getTeam', responses: { 200: { description: 'Team info' } } } },
    '/recent/{channel}': {
      get: {
        summary: 'Recent messages in a channel',
        operationId: 'getRecent',
        parameters: [
          { name: 'channel', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: { 200: { description: 'Messages' } },
      },
    },
    '/thread/{channel}/{threadTs}': {
      get: {
        summary: 'Full thread',
        operationId: 'getThread',
        parameters: [
          { name: 'channel', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'threadTs', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Thread messages' } },
      },
    },
    '/context/{channel}/{ts}': {
      get: {
        summary: 'Messages surrounding a timestamp',
        operationId: 'getContext',
        parameters: [
          { name: 'channel', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ts', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'window', in: 'query', schema: { type: 'integer', default: 10 } },
        ],
        responses: { 200: { description: 'Context messages' } },
      },
    },
    '/user/{userId}': {
      get: {
        summary: 'Messages by user',
        operationId: 'getUserMessages',
        parameters: [
          { name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'channel', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'User messages' } },
      },
    },
    '/digest/{channel}': {
      get: {
        summary: 'Channel activity digest over a time window',
        operationId: 'getDigest',
        parameters: [
          { name: 'channel', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'hours', in: 'query', schema: { type: 'integer', default: 24 } },
        ],
        responses: { 200: { description: 'Activity digest with top posters and hourly breakdown' } },
      },
    },
    '/events': {
      get: {
        summary: 'SSE stream of live messages (requires listener)',
        operationId: 'getEvents',
        parameters: [{ name: 'channel', in: 'query', schema: { type: 'string' }, description: 'Filter to channel ID' }],
        responses: { 200: { description: 'text/event-stream' }, 503: { description: 'No listener running' } },
      },
    },
    '/channels/rich': { get: { summary: 'Channels with message counts (frontend)', operationId: 'getChannelsRich', responses: { 200: { description: 'Rich channel list' } } } },
    '/users/rich': { get: { summary: 'Users with avatars (frontend)', operationId: 'getUsersRich', responses: { 200: { description: 'Rich user list' } } } },
    '/recent/{channel}/rich': {
      get: {
        summary: 'Recent messages with avatars and reactions (frontend)',
        operationId: 'getRecentRich',
        parameters: [
          { name: 'channel', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
        ],
        responses: { 200: { description: 'Rich messages' } },
      },
    },
    '/thread/{channel}/{threadTs}/rich': {
      get: {
        summary: 'Thread with avatars and reactions (frontend)',
        operationId: 'getThreadRich',
        parameters: [
          { name: 'channel', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'threadTs', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Rich thread' } },
      },
    },
    '/pins/{channel}': {
      get: {
        summary: 'Pinned messages for a channel',
        operationId: 'getPins',
        parameters: [{ name: 'channel', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Pins' } },
      },
    },
    '/bookmarks/{channel}': {
      get: {
        summary: 'Bookmarks for a channel',
        operationId: 'getBookmarks',
        parameters: [{ name: 'channel', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Bookmarks' } },
      },
    },
    '/workspace/summary': {
      get: {
        summary: 'Workspace-wide aggregate statistics',
        operationId: 'getWorkspaceSummary',
        responses: { 200: { description: 'Summary with per-channel activity and daily volume' } },
      },
    },
    '/unfurls/{channel}': {
      get: {
        summary: 'URL unfurls (link previews) from a channel',
        operationId: 'getUnfurls',
        parameters: [
          { name: 'channel', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: { 200: { description: 'Unfurl list' } },
      },
    },
    '/presence/{user}': {
      get: {
        summary: 'User presence / online status (requires live Slack client)',
        operationId: 'getPresence',
        parameters: [{ name: 'user', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Presence info' }, 503: { description: 'No live client' } },
      },
    },
    '/openapi.json': { get: { summary: 'This OpenAPI specification', operationId: 'getOpenApiSpec', responses: { 200: { description: 'OpenAPI 3.1 JSON' } } } },
  },
};
