import { WebClient } from '@slack/web-api';

/**
 * Create a WebClient configured for the resolved auth mode.
 *
 * - Bot and user modes: token is passed directly.
 * - Session mode: the xoxd- cookie value is sent as a Cookie header on every
 *   request, which is required for xoxc- tokens to authenticate.
 *
 * @param {{ mode: string, token: string, extras: object }} auth
 *   — config object returned by resolveAuth()
 * @returns {WebClient}
 */
export function createClient(auth) {
  const opts = {};

  if (auth.mode === 'session') {
    opts.headers = {
      Cookie: `d=${auth.extras.cookieD}`,
    };
  }

  return new WebClient(auth.token, opts);
}
