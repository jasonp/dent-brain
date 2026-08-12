/**
 * v0.49.4.0 — the stale-signature gate (PGLite).
 *
 * `invalidateStaleSignatureEmbeddings` joins `pages` against every row of
 * `content_chunks`, so it costs a full scan of the largest table in the brain
 * regardless of whether anything is actually stale. embed-cron calls it every
 * 90 minutes. Measured on a production brain over 13.2 days: 173 runs, 5.1 GB
 * read, **61 rows invalidated** — 42% of every disk read on the instance spent
 * proving there was no work to do.
 *
 * `hasStaleSignaturePages` is the cheap page-only probe that now gates it.
 * The contract this file pins:
 *
 *   - R-1 (CRITICAL, drift guard): the gate and the sweep agree on EVERY
 *     state. A gate that answers false while the sweep would have invalidated
 *     rows silently strands them in the old embedding space forever — the
 *     failure would be invisible, because stale chunks keep serving results.
 *   - R-2 (GRANDFATHER): a NULL signature is never stale, so a brain that has
 *     never stamped one always gates false.
 *   - R-3: sourceId scoping matches between gate and sweep.
 *   - R-4: embedStaleForSource does not call the sweep when the gate is false,
 *     and does call it when the gate is true.
 *
 * Canonical PGLite block (CLAUDE.md R3+R4).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;
let colDim: number;

const CURRENT = 'openai:text-embedding-3-large:1280';
const PRIOR = 'zeroentropy:zroberta-large:1024';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
  );
  colDim = Number(rows[0]?.dim);
});

/** Seed a page with one EMBEDDED chunk and a given signature (null = legacy). */
async function seedEmbedded(slug: string, signature: string | null, sourceId?: string): Promise<void> {
  const scope = sourceId ? { sourceId } : undefined;
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` }, scope);
  const chunks: ChunkInput[] = [
    { chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined },
  ];
  await engine.upsertChunks(slug, chunks, scope);
  await engine.executeRaw(
    `UPDATE content_chunks
        SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[$1::int]), ',') || ']')::vector
      WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = $3)`,
    [colDim, slug, sourceId ?? 'default'],
  );
  if (signature !== null) {
    await engine.setPageEmbeddingSignature(slug, { sourceId, signature });
  }
}

describe('stale-signature gate', () => {
  test('R-2 GRANDFATHER: a brain that never stamped a signature gates false', async () => {
    await seedEmbedded('legacy-a', null);
    await seedEmbedded('legacy-b', null);
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT })).toBe(false);
  });

  test('empty brain gates false', async () => {
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT })).toBe(false);
  });

  test('all pages on the current signature gate false', async () => {
    await seedEmbedded('fresh-a', CURRENT);
    await seedEmbedded('fresh-b', CURRENT);
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT })).toBe(false);
  });

  test('a single drifted page gates true', async () => {
    await seedEmbedded('fresh', CURRENT);
    await seedEmbedded('drifted', PRIOR);
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT })).toBe(true);
  });

  test('R-1 drift guard: gate agrees with the sweep across every state', async () => {
    // Each case seeds a fresh brain, asks the gate, then runs the sweep and
    // checks the two answers are consistent. If these ever disagree, the gate
    // is hiding real work — the whole point of pinning it.
    const cases: Array<{ name: string; seed: () => Promise<void> }> = [
      { name: 'empty', seed: async () => {} },
      { name: 'all grandfathered', seed: async () => { await seedEmbedded('a', null); } },
      { name: 'all current', seed: async () => { await seedEmbedded('a', CURRENT); } },
      { name: 'one drifted', seed: async () => { await seedEmbedded('a', PRIOR); } },
      {
        name: 'mixed: drifted + current + grandfathered',
        seed: async () => {
          await seedEmbedded('a', PRIOR);
          await seedEmbedded('b', CURRENT);
          await seedEmbedded('c', null);
        },
      },
    ];

    for (const c of cases) {
      await resetPgliteState(engine);
      await c.seed();
      const gate = await engine.hasStaleSignaturePages({ signature: CURRENT });
      const swept = await engine.invalidateStaleSignatureEmbeddings({ signature: CURRENT });
      expect(gate, `${c.name}: gate said ${gate}, sweep invalidated ${swept}`).toBe(swept > 0);
    }
  });

  test('R-3: gate is sourceId-scoped the same way the sweep is', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await seedEmbedded('clean', CURRENT); // default source, up to date
    await seedEmbedded('drifted', PRIOR, 'other'); // other source, stale

    expect(await engine.hasStaleSignaturePages({ signature: CURRENT, sourceId: 'default' })).toBe(false);
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT, sourceId: 'other' })).toBe(true);
    // Unscoped sees the drifted page in the other source.
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT })).toBe(true);

    // And the sweep scopes identically.
    expect(await engine.invalidateStaleSignatureEmbeddings({ signature: CURRENT, sourceId: 'default' })).toBe(0);
    expect(await engine.invalidateStaleSignatureEmbeddings({ signature: CURRENT, sourceId: 'other' })).toBe(1);
  });

  test('gate is idempotent after a sweep clears the drift', async () => {
    await seedEmbedded('drifted', PRIOR);
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT })).toBe(true);
    await engine.invalidateStaleSignatureEmbeddings({ signature: CURRENT });
    // The page keeps its OLD signature — the sweep only NULLs the vector — so
    // the gate stays true until the re-embed restamps it. That is correct: the
    // chunk is still unembedded and still needs the work.
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT })).toBe(true);
    // Re-stamping (what the embed loop does on success) closes it out.
    await engine.setPageEmbeddingSignature('drifted', { signature: CURRENT });
    expect(await engine.hasStaleSignaturePages({ signature: CURRENT })).toBe(false);
  });
});

describe('embedStaleForSource honors the gate', () => {
  /** Wrap the real engine, counting sweep calls without changing behavior. */
  function countingSweep(): { engine: BrainEngine; sweeps: () => number } {
    let sweeps = 0;
    const proxy = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'invalidateStaleSignatureEmbeddings') {
          return async (opts: { signature: string; sourceId?: string }) => {
            sweeps++;
            return target.invalidateStaleSignatureEmbeddings(opts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as BrainEngine;
    return { engine: proxy, sweeps: () => sweeps };
  }

  test('R-4: does NOT sweep when nothing is stale', async () => {
    await seedEmbedded('fresh', CURRENT);
    const { engine: proxied, sweeps } = countingSweep();
    await embedStaleForSource(proxied, 'default', {
      embeddingSignature: CURRENT,
      embedFn: async (texts) => texts.map(() => new Float32Array(colDim)),
    });
    expect(sweeps()).toBe(0);
  });

  test('R-4: DOES sweep when a page has drifted', async () => {
    await seedEmbedded('drifted', PRIOR);
    const { engine: proxied, sweeps } = countingSweep();
    await embedStaleForSource(proxied, 'default', {
      embeddingSignature: CURRENT,
      embedFn: async (texts) => texts.map(() => new Float32Array(colDim)),
    });
    expect(sweeps()).toBe(1);
  });

  test('R-4: no signature supplied → neither gate nor sweep runs', async () => {
    await seedEmbedded('drifted', PRIOR);
    const { engine: proxied, sweeps } = countingSweep();
    await embedStaleForSource(proxied, 'default', {
      embedFn: async (texts) => texts.map(() => new Float32Array(colDim)),
    });
    expect(sweeps()).toBe(0);
  });
});
