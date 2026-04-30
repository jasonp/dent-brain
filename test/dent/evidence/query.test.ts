/**
 * Phase 1 evidence: get_evidence test cases per PLAN.md.
 *
 * Coverage:
 *   - reverse-chronological order (newer rows first)
 *   - quarantined records excluded by default
 *   - include_quarantined flag returns them
 *   - limit cap (200)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import {
  setupEvidenceEngine,
  truncateEvidence,
  seedEntityPages,
  makeCtx,
  findOp,
} from './_helpers.ts';

const STEVE = 'entities/people/steve-broback';
const JASON = 'entities/people/jason-preston';

let engine: PGLiteEngine;

beforeAll(async () => {
  ({ engine } = await setupEvidenceEngine());
  await seedEntityPages(engine, [STEVE, JASON]);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await truncateEvidence(engine);
});

describe('get_evidence', () => {
  const append = findOp('append_evidence');
  const get = findOp('get_evidence');

  test('reverse-chron: newest rows first', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    // Insert 3 records with explicit observed_at ordering, then verify order.
    await append.handler(ctx, {
      content: 'first',
      entity_refs: [STEVE],
      source_type: 'observation',
      observed_at: '2026-04-29T10:00:00Z',
    });
    // Tiny delay so appended_at differs (PGLite resolves to microseconds).
    await new Promise((r) => setTimeout(r, 5));
    await append.handler(ctx, {
      content: 'second',
      entity_refs: [STEVE],
      source_type: 'observation',
      observed_at: '2026-04-29T10:00:01Z',
    });
    await new Promise((r) => setTimeout(r, 5));
    await append.handler(ctx, {
      content: 'third',
      entity_refs: [STEVE],
      source_type: 'observation',
      observed_at: '2026-04-29T10:00:02Z',
    });

    const result = (await get.handler(ctx, { entity_ref: STEVE })) as {
      evidence: Array<{ content: string }>;
      count: number;
    };
    expect(result.count).toBe(3);
    expect(result.evidence.map((r) => r.content)).toEqual(['third', 'second', 'first']);
  });

  test('quarantined records excluded by default', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    const batch_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await append.handler(ctx, {
      content: 'doomed',
      entity_refs: [STEVE],
      source_type: 'observation',
      batch_id,
    });
    await append.handler(ctx, {
      content: 'survivor',
      entity_refs: [STEVE],
      source_type: 'observation',
    });
    // Quarantine the batched row.
    await findOp('quarantine_batch').handler(ctx, { batch_id });

    const result = (await get.handler(ctx, { entity_ref: STEVE })) as {
      evidence: Array<{ content: string }>;
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.evidence[0].content).toBe('survivor');
  });

  test('include_quarantined: returns soft-deleted rows', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    const batch_id = '11111111-2222-3333-4444-555555555555';
    await append.handler(ctx, {
      content: 'doomed',
      entity_refs: [STEVE],
      source_type: 'observation',
      batch_id,
    });
    await findOp('quarantine_batch').handler(ctx, { batch_id });

    const result = (await get.handler(ctx, { entity_ref: STEVE, include_quarantined: true })) as {
      evidence: Array<{ content: string; quarantined_at: string | null }>;
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.evidence[0].quarantined_at).not.toBeNull();
  });

  test('only entries referencing the requested entity returned', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    await append.handler(ctx, {
      content: 'about steve',
      entity_refs: [STEVE],
      source_type: 'observation',
    });
    await append.handler(ctx, {
      content: 'about jason',
      entity_refs: [JASON],
      source_type: 'observation',
    });
    await append.handler(ctx, {
      content: 'about both',
      entity_refs: [STEVE, JASON],
      source_type: 'observation',
    });

    const result = (await get.handler(ctx, { entity_ref: STEVE })) as {
      count: number;
      evidence: Array<{ content: string }>;
    };
    expect(result.count).toBe(2);
    const contents = result.evidence.map((r) => r.content).sort();
    expect(contents).toEqual(['about both', 'about steve']);
  });

  test('limit cap clamps at 200', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    const result = (await get.handler(ctx, { entity_ref: STEVE, limit: 99999 })) as { limit: number };
    expect(result.limit).toBe(200);
  });

  test('limit floor clamps at 1', async () => {
    const ctx = makeCtx(engine, 'jason-test');
    const result = (await get.handler(ctx, { entity_ref: STEVE, limit: 0 })) as { limit: number };
    expect(result.limit).toBe(1);
  });
});
