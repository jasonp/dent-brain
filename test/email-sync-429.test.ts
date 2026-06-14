import { describe, expect, test } from 'bun:test';
import {
  GoogleClient,
  GoogleClientError,
  parseRetryAfter,
  classifyProbeFailure,
} from '../tools/email-sync/google-client.ts';
import { shouldReauth } from '../tools/email-sync/install.ts';

/**
 * Pins the v0.46 429-handling fix: a transient Gmail rate-limit must be
 * classified as `rate_limit` (transient, do-not-re-auth), never conflated with
 * a genuine auth failure — the v0.45 bug that forced spurious OAuth re-consent.
 */

describe('parseRetryAfter', () => {
  test('extracts the ISO timestamp from a Gmail 429 body', () => {
    const body = JSON.stringify({
      error: { code: 429, message: 'User-rate limit exceeded.  Retry after 2026-06-12T19:16:46.648Z' },
    });
    expect(parseRetryAfter(body)).toBe('2026-06-12T19:16:46.648Z');
  });
  test('returns null when no retry-after is present', () => {
    expect(parseRetryAfter('{"error":{"code":403,"message":"access_denied"}}')).toBeNull();
  });
  test('tolerates empty / garbage input', () => {
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not json at all')).toBeNull();
  });
});

describe('classifyProbeFailure', () => {
  test('401 / invalid_grant → auth', () => {
    expect(classifyProbeFailure(401, '')).toBe('auth');
    expect(classifyProbeFailure(400, '{"error":"invalid_grant"}')).toBe('auth');
  });
  test('429 / RESOURCE_EXHAUSTED / rateLimitExceeded → rate_limit', () => {
    expect(classifyProbeFailure(429, '')).toBe('rate_limit');
    expect(classifyProbeFailure(200, '{"status":"RESOURCE_EXHAUSTED"}')).toBe('rate_limit');
    expect(classifyProbeFailure(403, '{"reason":"rateLimitExceeded"}')).toBe('rate_limit');
  });
  test('403 / access_denied → config', () => {
    expect(classifyProbeFailure(403, '')).toBe('config');
    expect(classifyProbeFailure(400, 'access_denied')).toBe('config');
  });
  test('anything else → network', () => {
    expect(classifyProbeFailure(500, '')).toBe('network');
    expect(classifyProbeFailure(0, 'fetch failed')).toBe('network');
  });
  test('precedence: rate-limit signal in a 403 body classifies as rate_limit, not config', () => {
    // A 403 whose body says rateLimitExceeded is Gmail's per-user throttle, not
    // a test-user/Desktop-app misconfig. Must not send the operator down the
    // config path.
    expect(classifyProbeFailure(403, '{"reason":"rateLimitExceeded"}')).toBe('rate_limit');
  });
});

describe('shouldReauth — the v0.45 regression guard', () => {
  const me = 'me@dentthefuture.com';
  test('valid tokens for the right account → no re-auth', () => {
    expect(shouldReauth({ ok: true, email: me }, me)).toBe(false);
  });
  test('valid tokens for the WRONG account → re-auth', () => {
    expect(shouldReauth({ ok: true, email: 'other@x.com' }, me)).toBe(true);
  });
  test('429 rate-limit → NEVER re-auth (the core bug)', () => {
    expect(shouldReauth({ ok: false, kind: 'rate_limit', message: '429' }, me)).toBe(false);
  });
  test('network blip → no re-auth, keep tokens', () => {
    expect(shouldReauth({ ok: false, kind: 'network', message: 'fetch failed' }, me)).toBe(false);
  });
  test('genuine auth failure → re-auth', () => {
    expect(shouldReauth({ ok: false, kind: 'auth', message: 'invalid_grant' }, me)).toBe(true);
  });
  test('config / 403 → re-auth (operator must fix the app/test-user list)', () => {
    expect(shouldReauth({ ok: false, kind: 'config', message: '403' }, me)).toBe(true);
  });
});

describe('GoogleClient.health() error shape (via injected fetch, no network)', () => {
  function fakeFetch(status: number, body: string): typeof fetch {
    return (async () =>
      new Response(body, { status })) as unknown as typeof fetch;
  }
  // health() calls getValidTokens() → loadTokensFromDisk first; give it a client
  // whose tokens are already in memory by stubbing the token load via a temp file.
  // Simpler: drive a 429 and assert the thrown error carries status + retryAfter.
  test('429 throws GoogleClientError with status 429 and a parseable retryAfter', async () => {
    const body = JSON.stringify({
      error: { code: 429, message: 'User-rate limit exceeded.  Retry after 2026-06-12T19:16:46.648Z' },
    });
    const gc = new GoogleClient({
      tokensPath: '/dev/null',
      clientId: 'x',
      clientSecret: 'y',
      fetchImpl: fakeFetch(429, body),
    });
    // Inject in-memory tokens so getValidTokens() skips disk + refresh.
    (gc as unknown as { tokens: unknown }).tokens = {
      access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000,
      scope: 's', token_type: 'Bearer',
    };
    let err: unknown;
    try { await gc.health(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GoogleClientError);
    const ge = err as GoogleClientError;
    expect(ge.status).toBe(429);
    expect(classifyProbeFailure(ge.status, ge.body)).toBe('rate_limit');
    expect(ge.retryAfter).toBe('2026-06-12T19:16:46.648Z');
  });
});
