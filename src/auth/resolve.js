/**
 * Detect which authentication mode to use based on available environment
 * variables.
 *
 * Modes are checked in priority order:
 *   1. bot     — SLACK_BOT_TOKEN + SLACK_APP_TOKEN (+ SLACK_SIGNING_SECRET)
 *   2. user    — SLACK_USER_TOKEN (xoxp- prefix)
 *   3. session — SLACK_COOKIE_TOKEN (xoxc-) + SLACK_COOKIE_D (xoxd-)
 *
 * @returns {{ mode: 'bot'|'user'|'session', token: string, extras: object }}
 * @throws {Error} if no valid credentials are found
 */
export function resolveAuth() {
  // Bot mode: requires bot token + app token for Socket Mode
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    return {
      mode: 'bot',
      token: process.env.SLACK_BOT_TOKEN,
      extras: {
        appToken: process.env.SLACK_APP_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
      },
    };
  }

  // User token mode: standard OAuth, no admin approval on most workspaces
  if (process.env.SLACK_USER_TOKEN) {
    return {
      mode: 'user',
      token: process.env.SLACK_USER_TOKEN,
      extras: {},
    };
  }

  // Session token mode: browser cookie approach, no app needed
  if (process.env.SLACK_COOKIE_TOKEN && process.env.SLACK_COOKIE_D) {
    return {
      mode: 'session',
      token: process.env.SLACK_COOKIE_TOKEN,
      extras: {
        cookieD: process.env.SLACK_COOKIE_D,
      },
    };
  }

  throw new Error(
    'No Slack credentials found. Configure one of the following:\n\n' +
    '  Bot mode (full-featured — requires Slack app with Socket Mode):\n' +
    '    SLACK_BOT_TOKEN       xoxb-...\n' +
    '    SLACK_APP_TOKEN       xapp-...\n' +
    '    SLACK_SIGNING_SECRET  ...\n\n' +
    '  User token mode (no admin approval needed):\n' +
    '    SLACK_USER_TOKEN      xoxp-...\n\n' +
    '  Session token mode (no app needed — browser cookie approach):\n' +
    '    SLACK_COOKIE_TOKEN    xoxc-...\n' +
    '    SLACK_COOKIE_D        xoxd-...\n'
  );
}
