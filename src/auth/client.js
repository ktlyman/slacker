import fs from 'node:fs';
import path from 'node:path';
import { WebClient, LogLevel } from '@slack/web-api';

/**
 * Create a WebClient configured for the resolved auth mode.
 *
 * - Bot and user modes: token is passed directly.
 * - Session mode: the xoxd- cookie value is sent as a Cookie header on every
 *   request, which is required for xoxc- tokens to authenticate.
 *
 * Set SLACK_LOG_LEVEL=DEBUG in .env for verbose HTTP request logging.
 * Debug output is written to slack-debug.log in the working directory
 * (not to the terminal).
 *
 * @param {{ mode: string, token: string, extras: object }} auth
 *   — config object returned by resolveAuth()
 * @returns {WebClient}
 */
export function createClient(auth) {
  const logLevelEnv = process.env.SLACK_LOG_LEVEL?.toUpperCase();
  const logLevel = LogLevel[logLevelEnv] ?? LogLevel.WARN;

  const opts = {
    logLevel,
    timeout: 30_000, // 30 s per-request timeout — prevents indefinite hangs
  };

  // When debug logging is enabled, write to a file instead of stdout
  if (logLevel === LogLevel.DEBUG) {
    const logPath = path.resolve(process.env.SLACK_LOG_FILE ?? 'slack-debug.log');
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    const fileLogger = {
      debug: (...args) => stream.write(`[DEBUG] ${new Date().toISOString()} ${args.join(' ')}\n`),
      info:  (...args) => stream.write(`[INFO]  ${new Date().toISOString()} ${args.join(' ')}\n`),
      warn:  (...args) => stream.write(`[WARN]  ${new Date().toISOString()} ${args.join(' ')}\n`),
      error: (...args) => stream.write(`[ERROR] ${new Date().toISOString()} ${args.join(' ')}\n`),
      getLevel: () => logLevel,
      setLevel: () => {},
      setName: () => {},
    };
    opts.logger = fileLogger;
    console.log(`Slack debug logging to ${logPath}`);
  }

  if (auth.mode === 'session') {
    opts.headers = {
      Cookie: `d=${auth.extras.cookieD}`,
    };
  }

  return new WebClient(auth.token, opts);
}
