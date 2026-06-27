#!/usr/bin/env bun
/**
 * One-time OAuth provisioning for the gws-sync server ingestor.
 *
 * Reuses the existing "Dent Brain" Google OAuth app (the same client_id/secret
 * email-sync already uses, read from ~/.dent-brain/email-sync/config.json) and
 * mints a refresh token scoped for READ-ONLY Drive metadata + Sheets. Unlike
 * email-sync's oauth-flow (which saves tokens to a local file for a local
 * daemon), this prints the three values to set as Railway secrets, because
 * gws-sync runs server-side.
 *
 * Sign in as the Workspace account whose Docs/Sheets you want mapped
 * (jason@dentthefuture.com). The account must be a test user on the OAuth app
 * (email-sync's team already is).
 *
 * Usage:
 *   bun run scripts/dent/gws-sync-oauth.ts
 *   bun run scripts/dent/gws-sync-oauth.ts --client-id <ID> --client-secret <SECRET>
 */

import { createServer } from 'http';
import { spawn, execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Metadata-only Drive scope (cannot read file content) + read-only Sheets (we
// request structure only, never cell values). Mirror DriveClient's guarantees.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

function loadCreds(argv: string[]): { clientId: string; clientSecret: string } {
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--client-id') clientId = argv[++i];
    else if (argv[i] === '--client-secret') clientSecret = argv[++i];
  }
  if (clientId && clientSecret) return { clientId, clientSecret };
  // Fall back to email-sync's shared app credentials.
  const cfgPath = join(homedir(), '.dent-brain', 'email-sync', 'config.json');
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { googleClientId?: string; googleClientSecret?: string };
    if (cfg.googleClientId && cfg.googleClientSecret) {
      return { clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret };
    }
  } catch {
    /* fall through to error */
  }
  console.error(
    `Could not find OAuth client credentials.\n` +
      `Pass --client-id/--client-secret, or ensure ${cfgPath} has googleClientId + googleClientSecret.`,
  );
  process.exit(1);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  const { clientId, clientSecret } = loadCreds(process.argv.slice(2));

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (typeof addr !== 'object' || addr == null) throw new Error('failed to bind loopback server');
  const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // force a fresh refresh_token

  const codePromise = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (error || !code) {
        res.statusCode = 400;
        res.end(`<html><body style="font-family:system-ui;padding:2rem"><h2>OAuth error</h2><p>${error ?? 'missing code'}</p></body></html>`);
        reject(new Error(error ?? 'missing code'));
        return;
      }
      res.end('<html><body style="font-family:system-ui;padding:2rem"><h2>gws-sync connected ✓</h2><p>Close this tab and return to your terminal.</p></body></html>');
      resolve(code);
    });
  });

  console.log(`\nSign in as the Workspace account whose Docs/Sheets to map (jason@dentthefuture.com).`);
  console.log(`Opening your browser...\n  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  const code = await codePromise.finally(() => server.close());

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { refresh_token?: string; scope?: string };
  if (!data.refresh_token) {
    throw new Error(
      'Google returned no refresh_token. Revoke the prior grant at https://myaccount.google.com/permissions and re-run.',
    );
  }

  console.log(`\n✓ Refresh token minted. Scopes: ${data.scope}`);

  const setRailway = process.argv.includes('--set-railway');
  if (setRailway) {
    // Set all three in one call → a single redeploy. Token never printed.
    try {
      execFileSync(
        'railway',
        [
          'variables',
          '--set', `GWS_SYNC_GOOGLE_CLIENT_ID=${clientId}`,
          '--set', `GWS_SYNC_GOOGLE_CLIENT_SECRET=${clientSecret}`,
          '--set', `GWS_SYNC_GOOGLE_REFRESH_TOKEN=${data.refresh_token}`,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
      console.log(`✓ Set GWS_SYNC_GOOGLE_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN on the linked Railway service.\n`);
    } catch (e) {
      console.error(`✗ railway variables --set failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  Set them manually (token is sensitive):`);
      console.error(`  railway variables --set GWS_SYNC_GOOGLE_REFRESH_TOKEN='<token>' (re-run to recover the value)`);
      process.exit(1);
    }
  } else {
    console.log(`\nSet these three Railway secrets (values are sensitive — do not commit):\n`);
    console.log(`  railway variables --set GWS_SYNC_GOOGLE_CLIENT_ID='${clientId}'`);
    console.log(`  railway variables --set GWS_SYNC_GOOGLE_CLIENT_SECRET='${clientSecret}'`);
    console.log(`  railway variables --set GWS_SYNC_GOOGLE_REFRESH_TOKEN='${data.refresh_token}'`);
    console.log(`\n(Re-run with --set-railway to apply these automatically.)`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
