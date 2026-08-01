/**
 * `resolveEmbedStatementTimeout` — the transaction-scoped ceiling applied to
 * the embedding upsert in `postgres-engine.upsertChunks`.
 *
 * Two things are being pinned here.
 *
 * 1. INJECTION SAFETY. A Postgres GUC cannot be parameterized, so this value is
 *    interpolated directly into `SET LOCAL statement_timeout = '<value>'`. The
 *    validator is the only thing standing between an environment variable and
 *    raw SQL, so a malformed value MUST fall back to the default rather than
 *    reach the server.
 *
 * 2. THE DEFAULT IS ABOVE THE POOLER CEILING. Supabase's transaction pooler
 *    caps pooled connections at 2 minutes and ignores the startup parameter
 *    the client requests. A default at or below 2min would silently reproduce
 *    the bug this function exists to fix: large PDF-derived pages time out
 *    mid-upsert, keep their previous-model vectors, and the run still reports
 *    success.
 */

import { describe, test, expect } from 'bun:test';
import { resolveEmbedStatementTimeout } from '../src/core/db.ts';
import { withEnv } from './helpers/with-env.ts';

describe('resolveEmbedStatementTimeout', () => {
  test('defaults to 10min when unset', async () => {
    await withEnv({ GBRAIN_EMBED_STATEMENT_TIMEOUT: undefined }, async () => {
      expect(resolveEmbedStatementTimeout()).toBe('10min');
    });
  });

  test('default exceeds the pooler ceiling that caused the bug', async () => {
    // Supabase's transaction pooler enforces 2min. A default at or under that
    // makes this whole function a no-op for the pages that actually fail.
    await withEnv({ GBRAIN_EMBED_STATEMENT_TIMEOUT: undefined }, async () => {
      const v = resolveEmbedStatementTimeout();
      const m = v.match(/^(\d+)\s*(ms|s|min|h)?$/i);
      expect(m).not.toBeNull();
      const n = parseInt(m![1], 10);
      const unit = (m![2] ?? 'ms').toLowerCase();
      const ms = unit === 'h' ? n * 3600_000 : unit === 'min' ? n * 60_000 : unit === 's' ? n * 1000 : n;
      expect(ms).toBeGreaterThan(120_000);
    });
  });

  test.each([
    ['20min', '20min'],
    ['900s', '900s'],
    ['1h', '1h'],
    ['500ms', '500ms'],
    ['300', '300'],
  ])('accepts well-formed override %s', async (input, expected) => {
    await withEnv({ GBRAIN_EMBED_STATEMENT_TIMEOUT: input }, async () => {
      expect(resolveEmbedStatementTimeout()).toBe(expected);
    });
  });

  test.each([
    ["10min'; DROP TABLE content_chunks; --"],
    ['10min; SELECT 1'],
    ["' OR '1'='1"],
    ['not-a-duration'],
    ['10 minutes'],
    [''],
    ['   '],
  ])('rejects malformed/hostile value %s and falls back to the default', async (input) => {
    await withEnv({ GBRAIN_EMBED_STATEMENT_TIMEOUT: input }, async () => {
      // Falling back is the safe outcome: the interpolated string is always a
      // literal this module produced, never operator- or attacker-supplied text.
      expect(resolveEmbedStatementTimeout()).toBe('10min');
    });
  });

  test('never returns a value containing a quote or semicolon', async () => {
    for (const hostile of ["1min'", '1min;', "';--", '1min"']) {
      await withEnv({ GBRAIN_EMBED_STATEMENT_TIMEOUT: hostile }, async () => {
        const out = resolveEmbedStatementTimeout();
        expect(out).not.toContain("'");
        expect(out).not.toContain(';');
        expect(out).not.toContain('"');
      });
    }
  });
});
