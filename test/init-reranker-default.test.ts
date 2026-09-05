/**
 * v0.48.2 — init's reranker-default write against the live bundle default.
 * The key under test is whichever key that default needs: upstream's is
 * VOYAGE_API_KEY (voyage:rerank-2.5), this fork's is COHERE_API_KEY
 * (cohere:rerank-v3.5). The embedding picks stay voyage/openai either way —
 * the point of the table is that the reranker default is INDEPENDENT of the
 * embedding provider.
 *
 * Truth table (stub engine records setConfig calls):
 *   COHERE key present, any keyed embedding pick   → NO write (bundle default resolves to it)
 *   no key, keyed pick (openai/voyage)             → search.reranker.enabled=false
 *   no key, keyless (resolvedModel undefined)      → NO write (recovery re-init contract)
 *   zeroentropyai:* pick, no Cohere key            → search.reranker.enabled=false
 *   existing explicit reranker choice              → NO write (never-clobber)
 */
import { describe, expect, test } from 'bun:test';
import { _exports_for_test } from '../src/commands/init.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import * as fs from 'fs';
import * as path from 'path';

const { writeNewInstallRerankerDefault } = _exports_for_test;

function stubEngine(existing: Record<string, string> = {}): { engine: any; writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  const engine = {
    async getConfig(key: string): Promise<string | null> {
      return existing[key] ?? null;
    },
    async setConfig(key: string, value: string): Promise<void> {
      writes.push([key, value]);
    },
  };
  return { engine, writes };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = orig;
  }
}

describe('writeNewInstallRerankerDefault (v0.48.2)', () => {
  test('COHERE key present + voyage embedding pick → no write', async () => {
    await withEnv({ COHERE_API_KEY: 'co-test' }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'voyage:voyage-4'));
      expect(writes).toEqual([]);
    });
  });

  test('COHERE key present + openai embedding pick → still no write (the default is provider-independent)', async () => {
    await withEnv({ COHERE_API_KEY: 'co-test' }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'openai:text-embedding-3-small'));
      expect(writes).toEqual([]);
    });
  });

  test('no key + keyed embedding pick → explicit search.reranker.enabled=false', async () => {
    await withEnv({ COHERE_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'openai:text-embedding-3-small'));
      expect(writes).toEqual([['search.reranker.enabled', 'false']]);
    });
  });

  test('no key + keyless install → no write (recovery re-init must find virgin config)', async () => {
    await withEnv({ COHERE_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, undefined));
      expect(writes).toEqual([]);
    });
  });

  test('zeroentropyai pick without the default reranker key → enabled=false (its hosted reranker dies 2026-09-04)', async () => {
    await withEnv({ COHERE_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'zeroentropyai:zembed-1'));
      expect(writes).toEqual([['search.reranker.enabled', 'false']]);
    });
  });

  test('a Cohere key that lives only in the DB config plane counts (re-init is not locked into enabled=false)', async () => {
    await withEnv({ COHERE_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, writes } = stubEngine({ cohere_api_key: 'co-db-plane' });
      await quiet(() => writeNewInstallRerankerDefault(engine, 'openai:text-embedding-3-small'));
      expect(writes).toEqual([]);
    });
  });

  test('never-clobber: an existing explicit reranker row blocks every write', async () => {
    await withEnv({ COHERE_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const a = stubEngine({ 'search.reranker.model': 'voyage:rerank-2.5-lite' });
      await quiet(() => writeNewInstallRerankerDefault(a.engine, 'openai:text-embedding-3-small'));
      expect(a.writes).toEqual([]);
      const b = stubEngine({ 'search.reranker.enabled': 'true' });
      await quiet(() => writeNewInstallRerankerDefault(b.engine, 'openai:text-embedding-3-small'));
      expect(b.writes).toEqual([]);
    });
  });

  test('a cohere key on the FILE plane only (config.json) → no write', async () => {
    const home = emptyHome();
    fs.mkdirSync(path.join(home, '.gbrain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gbrain', 'config.json'), JSON.stringify({ cohere_api_key: 'co-file' }));
    await withEnv({ COHERE_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_HOME: home }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'openai:text-embedding-3-small'));
      expect(writes).toEqual([]);
    });
  });
});
