/**
 * Google OAuth client for the email-sync collector.
 *
 * Direct Gmail API access using a refresh token persisted on the teammate's
 * laptop. No broker (no ClawVisor, no Hermes) — we own the OAuth app in
 * Google Cloud (test mode, manual user whitelist). See install.sh for the
 * one-time interactive OAuth dance that populates the tokens file.
 *
 * The collector calls listMessages → getMessage repeatedly. The client
 * self-refreshes the access token on demand (Google access tokens expire
 * every ~1h; refresh tokens last indefinitely until revoked).
 *
 * Token file layout (`~/.dent-brain/email-sync/google-tokens.json`, chmod 0600):
 *   {
 *     "access_token": "...",
 *     "refresh_token": "...",
 *     "expires_at": 1715200000000,   // unix ms
 *     "scope": "https://www.googleapis.com/auth/gmail.readonly ...",
 *     "token_type": "Bearer"
 *   }
 */

import { writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  token_type: 'Bearer';
}

export interface GoogleClientOptions {
  /** Path to the tokens file. */
  tokensPath: string;
  /** OAuth Client ID (Desktop app). */
  clientId: string;
  /** OAuth Client Secret. For Desktop apps Google publishes this as part of
   *  the installed-app credential — not a real secret in the threat-model
   *  sense, but still kept in config for symmetry with web/server flows. */
  clientSecret: string;
  /** Optional fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

/** Minimal subset of a Gmail message we need from the API. */
export interface GmailMessage {
  id: string;
  threadId: string;
  /** Gmail's `internalDate` is unix ms as a string. */
  internalDate: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
  };
  /** Server-side computed snippet, ~150 chars. */
  snippet?: string;
  labelIds?: string[];
}

export class GoogleClientError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
    this.name = 'GoogleClientError';
  }
}

export class GoogleClient {
  private tokens: GoogleTokens | null = null;
  private fetchImpl: typeof fetch;

  constructor(private opts: GoogleClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Probe the API. Throws if auth or transport is wrong. */
  async health(): Promise<{ emailAddress: string }> {
    const res = await this.authedFetch(`${GMAIL_BASE}/users/me/profile`);
    if (!res.ok) {
      throw new GoogleClientError(
        res.status,
        await res.text(),
        `Gmail profile probe failed: ${res.status}`,
      );
    }
    const data = (await res.json()) as { emailAddress: string };
    return data;
  }

  /**
   * List Gmail message ids matching a query, paginated.
   * Mirrors Gmail's users.messages.list shape.
   *
   * @param query Gmail search syntax, e.g.
   *   `(from:steve@example.com OR to:steve@example.com) newer_than:3d`
   * @param maxResults Per-page cap. Gmail caps at 500.
   */
  async listMessages(
    query: string,
    maxResults: number = 100,
  ): Promise<{ ids: Array<{ id: string; threadId: string }> }> {
    const all: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${GMAIL_BASE}/users/me/messages`);
      url.searchParams.set('q', query);
      url.searchParams.set('maxResults', String(maxResults));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await this.authedFetch(url.toString());
      if (!res.ok) {
        const body = await res.text();
        throw new GoogleClientError(res.status, body, `Gmail list failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string };
      if (Array.isArray(json.messages)) all.push(...json.messages);
      pageToken = json.nextPageToken;
      if (all.length >= 5000) break; // hard runaway cap
    } while (pageToken);
    return { ids: all };
  }

  /**
   * Fetch a single message. Use `format: 'metadata'` to get just the headers
   * we care about (cheaper, smaller); `full` for the snippet too.
   */
  async getMessage(id: string, format: 'metadata' | 'full' = 'metadata'): Promise<GmailMessage> {
    const url = new URL(`${GMAIL_BASE}/users/me/messages/${encodeURIComponent(id)}`);
    url.searchParams.set('format', format);
    if (format === 'metadata') {
      for (const h of ['From', 'To', 'Cc', 'Bcc', 'Date', 'Subject']) {
        url.searchParams.append('metadataHeaders', h);
      }
    }
    const res = await this.authedFetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new GoogleClientError(res.status, body, `Gmail get(${id}) failed: ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as GmailMessage;
  }

  // --- internal ---

  private async authedFetch(url: string): Promise<Response> {
    const tokens = await this.getValidTokens();
    return this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json',
      },
    });
  }

  private async getValidTokens(): Promise<GoogleTokens> {
    if (!this.tokens) this.tokens = loadTokensFromDisk(this.opts.tokensPath);
    // 60s buffer so a token that's about to expire mid-request is refreshed first.
    if (Date.now() < this.tokens.expires_at - 60_000) return this.tokens;
    this.tokens = await this.refresh(this.tokens);
    saveTokensToDisk(this.opts.tokensPath, this.tokens);
    return this.tokens;
  }

  private async refresh(t: GoogleTokens): Promise<GoogleTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new GoogleClientError(res.status, errBody, `Token refresh failed: ${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number; scope: string };
    return {
      ...t,
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
      scope: data.scope ?? t.scope,
    };
  }
}

// --- token persistence ---

export function loadTokensFromDisk(path: string): GoogleTokens {
  if (!existsSync(path)) {
    throw new Error(
      `Google OAuth tokens not found at ${path}. Run \`dent-extensions install email-sync\` to complete the one-time OAuth dance.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as GoogleTokens;
}

export function saveTokensToDisk(path: string, tokens: GoogleTokens): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2));
  chmodSync(path, 0o600);
}

// --- header helpers (kept from the old clawvisor-client; useful for collect.ts) ---

/** Read a Gmail header by name (case-insensitive). */
export function header(msg: GmailMessage, name: string): string {
  const want = name.toLowerCase();
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === want);
  return h?.value ?? '';
}

/** Parse a Gmail "Name <email@domain>" header into name + bare email. */
export function parseAddress(raw: string): { name: string | null; email: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { name: null, email: '' };
  const m = /^(.+?)\s*<([^>]+)>$/.exec(trimmed);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '') || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: trimmed.toLowerCase() };
}

/** Parse a header that may contain multiple comma-separated addresses. */
export function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/,(?![^<]*>)/) // split on commas not inside <...>
    .map((p) => parseAddress(p).email)
    .filter((e) => e.length > 0);
}
