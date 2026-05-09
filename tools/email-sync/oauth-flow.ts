#!/usr/bin/env bun
/**
 * One-time interactive OAuth dance for the email-sync collector.
 *
 * Called from install.sh exactly once during setup. After this completes,
 * the headless collector reads ~/.dent-brain/email-sync/google-tokens.json
 * and refreshes the access token on its own.
 *
 * Flow:
 *   1. Spin up a localhost HTTP server on a random free port.
 *   2. Build the Google authorization URL with that port as redirect_uri.
 *   3. Open the user's default browser.
 *   4. User clicks "allow" (after the "this app isn't verified" warning,
 *      which is expected because the OAuth app is in test mode).
 *   5. Google redirects the browser to localhost:PORT/callback?code=XYZ.
 *   6. Exchange code for access_token + refresh_token.
 *   7. Save to disk (chmod 0600).
 *
 * Usage:
 *   bun run tools/email-sync/oauth-flow.ts \
 *     --client-id <ID> \
 *     --client-secret <SECRET> \
 *     --tokens-path ~/.dent-brain/email-sync/google-tokens.json
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { saveTokensToDisk, type GoogleTokens } from './google-client.ts';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

interface FlowOpts {
  clientId: string;
  clientSecret: string;
  tokensPath: string;
}

function parseArgs(argv: string[]): FlowOpts {
  const opts: Partial<FlowOpts> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--client-id') { opts.clientId = v; i++; }
    else if (k === '--client-secret') { opts.clientSecret = v; i++; }
    else if (k === '--tokens-path') { opts.tokensPath = v; i++; }
  }
  if (!opts.clientId || !opts.clientSecret || !opts.tokensPath) {
    console.error('Usage: oauth-flow.ts --client-id <ID> --client-secret <SECRET> --tokens-path <PATH>');
    process.exit(1);
  }
  return opts as FlowOpts;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' :
              process.platform === 'win32' ? 'start' :
              'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

export async function runOAuthFlow(opts: FlowOpts): Promise<GoogleTokens> {
  // 1. Spin up loopback server on a random port.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (typeof addr !== 'object' || addr == null) throw new Error('failed to bind loopback server');
  const port = addr.port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 2. Build auth URL.
  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', opts.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  // `prompt=consent` forces Google to issue a fresh refresh_token even on
  // re-runs. Without it, re-running the flow returns no refresh_token if the
  // user previously consented (and we'd silently lose offline access).
  authUrl.searchParams.set('prompt', 'consent');

  // 3. Wait for the callback.
  const codePromise = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (error) {
        res.statusCode = 400;
        res.end(`<html><body style="font-family:system-ui;padding:2rem"><h2>OAuth error</h2><p>${error}</p><p>You can close this tab.</p></body></html>`);
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end('<html><body>missing code</body></html>');
        reject(new Error('missing code'));
        return;
      }
      res.end('<html><body style="font-family:system-ui;padding:2rem"><h2>Google connected ✓</h2><p>You can close this tab and return to your terminal.</p></body></html>');
      resolve(code);
    });
  });

  console.log(`\nOpening your browser for Google OAuth...`);
  console.log(`If it doesn't open automatically, visit:\n  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());
  console.log(`Waiting for you to complete the consent flow in your browser...\n`);

  const code = await codePromise.finally(() => server.close());

  // 4. Exchange code for tokens.
  const body = new URLSearchParams({
    code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${err}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    token_type: 'Bearer';
  };
  if (!data.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. This usually means you previously authorized this app — revoke the prior grant at https://myaccount.google.com/permissions and re-run the flow.',
    );
  }
  const tokens: GoogleTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope,
    token_type: 'Bearer',
  };
  saveTokensToDisk(opts.tokensPath, tokens);
  return tokens;
}

// CLI entry — called from install.sh.
if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  runOAuthFlow(opts).then(
    () => {
      console.log(`✓ Tokens saved to ${opts.tokensPath} (chmod 0600)`);
      process.exit(0);
    },
    (err) => {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
