/**
 * Coverage for the `cohere_api_key` file-plane → gateway-env seam added when
 * Cohere replaced zerank-2 as the default reranker.
 *
 * This exists because the exact same seam has already broken once: v0.37's
 * fix wave (CDX2-5+6) found that `zeroentropy_api_key` was settable but never
 * mapped into the gateway env, so ZE — the default provider at the time — got
 * a key the embed pipeline could not see. The failure is silent: config looks
 * right, the reranker just quietly fails open and search gets worse with no
 * error. These tests pin the mapping so the Cohere cutover can't repeat it.
 *
 * Also pins 1280 as a valid width for openai:text-embedding-3-large. That one
 * assertion is what makes the ZeroEntropy migration cheap: brains on ZE-era
 * zembed-1/1280 re-embed in place at their existing width instead of paying
 * for a vector column change plus an HNSW rebuild. `dims_options` is enforced
 * by embedding-dim-check, so dropping 1280 from the list would silently make
 * that migration path illegal.
 */

import { describe, test, expect } from 'bun:test';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { resolveSchemaEmbeddingDim } from '../src/core/embedding-dim-check.ts';
import { withEnv } from './helpers/with-env.ts';

describe('cohere_api_key file-plane plumbing', () => {
  test('maps cohere_api_key onto COHERE_API_KEY in the gateway env', async () => {
    // Clear the ambient key first. `process.env` wins over the config field by
    // design (see the next test), so on any machine that exports a real
    // COHERE_API_KEY this assertion read the developer's shell instead of the
    // seam under test and failed — green in CI, red locally, for a reason that
    // has nothing to do with the mapping. Pinning the env makes the test
    // measure the file-plane → gateway-env hop and nothing else.
    await withEnv({ COHERE_API_KEY: undefined }, () => {
      const cfg = buildGatewayConfig({
        engine: 'pglite',
        cohere_api_key: 'test-cohere-key',
      } as any);
      // Guard against the v0.37 ZE bug class: the key must actually land in the
      // env dict the recipe reads, not just exist on GBrainConfig.
      expect(cfg.env?.COHERE_API_KEY).toBe('test-cohere-key');
    });
  });

  test('omits COHERE_API_KEY when the config field is absent', () => {
    const cfg = buildGatewayConfig({ engine: 'pglite' } as any);
    // Only assert we didn't invent one. A real COHERE_API_KEY in the ambient
    // process env legitimately flows through (process.env wins by design), so
    // this must not assert undefined unconditionally.
    if (!process.env.COHERE_API_KEY) {
      expect(cfg.env?.COHERE_API_KEY).toBeUndefined();
    }
  });

  test('process env wins over the config-file key', async () => {
    // Documented precedence in buildGatewayConfig: `{...envFromConfig, ...process.env}`.
    await withEnv({ COHERE_API_KEY: 'from-process-env' }, async () => {
      const cfg = buildGatewayConfig({
        engine: 'pglite',
        cohere_api_key: 'from-config-file',
      } as any);
      expect(cfg.env?.COHERE_API_KEY).toBe('from-process-env');
    });
  });
});

describe('openai text-embedding-3-large accepts 1280 (ZE migration width)', () => {
  test('1280 validates — the no-schema-change migration path', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1280,
    });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.dim).toBe(1280);
  });

  test('1536 (fresh-install default) still validates', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
    });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.dim).toBe(1536);
  });

  test('a width outside dims_options is still rejected', () => {
    // Proves the list is genuinely enforced — otherwise the 1280 test above
    // would pass for any value and pin nothing.
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 999,
    });
    expect(got.ok).toBe(false);
  });
});
