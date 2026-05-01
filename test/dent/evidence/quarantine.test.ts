/**
 * Phase 1 evidence: quarantine_batch test cases per PLAN.md.
 *
 * Coverage:
 *   - quarantine round-trip (set → un-set restores active state)
 *   - reason recorded in metadata.quarantine_reason
 *   - dry_run reports affected count without writing
 *   - re-quarantining an already-quarantined batch is a no-op (affected=0)
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
const BATCH = 'cccccccc-dddd-eeee-ffff-000000000000';
const BATCH2 = 'aaaaaaaa-1111-2222-3333-444444444444';

let engine: PGLiteEngine;

beforeAll(async () => {
  ({ engine } = await setupEvidenceEngine());
  await seedEntityPages(engine, [STEVE]);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await truncateEvidence(engine);
});

describe('quarantine_batch', () => {
  const append = findOp('append_evidence');
  const quarantine = findOp('quarantine_batch');
  const get = findOp('get_evidence');

  async function seedBatch(ctx: ReturnType<typeof makeCtx>, batch_id: string, n: number) {
    // Use batch_id in content + source_ref so distinct batches produce distinct
    // content_hashes (otherwise idempotency dedup would collapse them).
    for (let i = 0; i < n; i++) {
      await append.handler(ctx, {
        content: `batch ${batch_id} row ${i}`,
        entity_refs: [STEVE],
        source_type: 'observation',
        source_ref: `${batch_id}/r${i}`,
        batch_id,
      });
    }
  }

  test('quarantine then un-quarantine round trip', async () => {
    const ctx = makeCtx(engine);
    await seedBatch(ctx, BATCH, 3);

    const q = (await quarantine.handler(ctx, { batch_id: BATCH })) as { affected: number };
    expect(q.affected).toBe(3);

    let active = (await get.handler(ctx, { entity_ref: STEVE })) as { count: number };
    expect(active.count).toBe(0);

    const u = (await quarantine.handler(ctx, { batch_id: BATCH, un_quarantine: true })) as {
      affected: number;
      un_quarantined: boolean;
    };
    expect(u.affected).toBe(3);
    expect(u.un_quarantined).toBe(true);

    active = (await get.handler(ctx, { entity_ref: STEVE })) as { count: number };
    expect(active.count).toBe(3);
  });

  test('reason recorded in metadata.quarantine_reason', async () => {
    const ctx = makeCtx(engine);
    await seedBatch(ctx, BATCH, 2);

    await quarantine.handler(ctx, { batch_id: BATCH, reason: 'classifier rule v2 was wrong' });

    const rows = await engine.executeRaw<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM evidence WHERE batch_id = $1`,
      [BATCH],
    );
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.metadata.quarantine_reason).toBe('classifier rule v2 was wrong');
    }
  });

  test('un-quarantine clears quarantine_reason from metadata', async () => {
    const ctx = makeCtx(engine);
    await seedBatch(ctx, BATCH, 1);

    await quarantine.handler(ctx, { batch_id: BATCH, reason: 'temporary' });
    await quarantine.handler(ctx, { batch_id: BATCH, un_quarantine: true });

    const rows = await engine.executeRaw<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM evidence WHERE batch_id = $1`,
      [BATCH],
    );
    expect(rows[0].metadata).not.toHaveProperty('quarantine_reason');
  });

  test('dry_run reports affected without writing', async () => {
    const ctx = makeCtx(engine);
    await seedBatch(ctx, BATCH, 4);

    const dryCtx = makeCtx(engine, /* dryRun */ true);
    const r = (await quarantine.handler(dryCtx, { batch_id: BATCH })) as {
      dry_run: boolean;
      would_affect: number;
    };
    expect(r.dry_run).toBe(true);
    expect(r.would_affect).toBe(4);

    // Confirm nothing was actually quarantined.
    const active = (await get.handler(ctx, { entity_ref: STEVE })) as { count: number };
    expect(active.count).toBe(4);
  });

  test('re-quarantining already-quarantined batch is no-op', async () => {
    const ctx = makeCtx(engine);
    await seedBatch(ctx, BATCH, 2);

    await quarantine.handler(ctx, { batch_id: BATCH });
    const second = (await quarantine.handler(ctx, { batch_id: BATCH })) as { affected: number };
    expect(second.affected).toBe(0);
  });

  test('quarantine of one batch does not affect another batch', async () => {
    const ctx = makeCtx(engine);
    await seedBatch(ctx, BATCH, 2);
    await seedBatch(ctx, BATCH2, 2);

    await quarantine.handler(ctx, { batch_id: BATCH });

    const active = (await get.handler(ctx, { entity_ref: STEVE })) as { count: number };
    expect(active.count).toBe(2); // BATCH2 still active

    const all = (await get.handler(ctx, {
      entity_ref: STEVE,
      include_quarantined: true,
    })) as { count: number };
    expect(all.count).toBe(4);
  });
});
