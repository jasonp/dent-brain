/**
 * v0.46.1.0 — get_page_by_identity op.
 *
 * Looks up a page by a stable frontmatter field (e.g. granola_document_id)
 * independent of its slug, so ingestors dedup on an external id that survives
 * upstream renames. This test pins the three properties the op MUST hold:
 *   1. Source isolation — a federated `allowedSources` grant can never read an
 *      identity match in a source it wasn't granted (the same cross-source
 *      leak class #1393 closed for get_page).
 *   2. Fence privacy — a remote/untrusted reader gets takes/facts fences
 *      stripped from the returned body, exactly like get_page.
 *   3. Miss + slug-reuse contract — `{ exists: false }` on no match;
 *      `{ exists: true, slug }` returns the canonical slug regardless of the
 *      page's current title.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
const get_page_by_identity = operations.find(o => o.name === 'get_page_by_identity')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  // beta-only page carrying external id G-beta.
  await engine.putPage('meetings/2026-06-01-beta-call', {
    type: 'meeting', title: 'Beta call', compiled_truth: 'beta body', frontmatter: { granola_document_id: 'G-beta' },
  }, { sourceId: 'beta' });
  // alpha page carrying external id G-alpha, with a takes fence in the body.
  const body = ['alpha body', TAKES_FENCE_BEGIN, '| holder | claim |', TAKES_FENCE_END, 'tail'].join('\n');
  await engine.putPage('meetings/2026-06-01-alpha-call', {
    type: 'meeting', title: 'Alpha call', compiled_truth: body, frontmatter: { granola_document_id: 'G-alpha' },
  }, { sourceId: 'alpha' });
});

describe('source isolation', () => {
  test('grant [alpha] cannot read a beta-only identity match', async () => {
    const ctx = ctxOf({ auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha'] } as any });
    const res: any = await get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: 'G-beta' });
    expect(res.exists).toBe(false);
  });

  test('grant [alpha, beta] can read the beta identity match (canonical slug)', async () => {
    const ctx = ctxOf({ auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha', 'beta'] } as any });
    const res: any = await get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: 'G-beta' });
    expect(res.exists).toBe(true);
    expect(res.slug).toBe('meetings/2026-06-01-beta-call');
  });
});

describe('fence privacy', () => {
  test('remote reader gets the takes fence stripped from the returned body', async () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha'] } as any });
    const res: any = await get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: 'G-alpha' });
    expect(res.exists).toBe(true);
    expect(res.compiled_truth).not.toContain(TAKES_FENCE_BEGIN);
  });

  test('local trusted reader (remote=false) keeps the fence', async () => {
    const ctx = ctxOf({ remote: false, sourceId: 'alpha' });
    const res: any = await get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: 'G-alpha' });
    expect(res.exists).toBe(true);
    expect(res.compiled_truth).toContain(TAKES_FENCE_BEGIN);
  });
});

describe('miss contract', () => {
  test('unknown identity returns { exists: false }', async () => {
    const ctx = ctxOf({ remote: false });
    const res: any = await get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: 'G-nope' });
    expect(res).toEqual({ exists: false });
  });
});

describe('type disambiguation (a meeting and its transcript share one identity)', () => {
  // granola-sync stamps the SAME granola_document_id on the meeting page AND the
  // transcript page. Without the type filter the lookup returns whichever has the
  // lower id; the daemon needs the MEETING deterministically.
  beforeEach(async () => {
    await engine.putPage('meetings/2026-06-02-shared', {
      type: 'meeting', title: 'Shared meeting', compiled_truth: 'm', frontmatter: { granola_document_id: 'G-shared' },
    }, { sourceId: 'alpha' });
    await engine.putPage('meetings/transcripts/2026-06-02-shared', {
      type: 'transcript', title: 'Shared transcript', compiled_truth: 't', frontmatter: { granola_document_id: 'G-shared' },
    }, { sourceId: 'alpha' });
  });

  test("type: 'meeting' returns the meeting page, not the transcript", async () => {
    const ctx = ctxOf({ remote: false, sourceId: 'alpha' });
    const res: any = await get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: 'G-shared', type: 'meeting' });
    expect(res.exists).toBe(true);
    expect(res.slug).toBe('meetings/2026-06-02-shared');
  });

  test("type: 'transcript' returns the transcript page", async () => {
    const ctx = ctxOf({ remote: false, sourceId: 'alpha' });
    const res: any = await get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: 'G-shared', type: 'transcript' });
    expect(res.exists).toBe(true);
    expect(res.slug).toBe('meetings/transcripts/2026-06-02-shared');
  });
});

describe('empty-input guard (fail closed)', () => {
  test('empty value throws instead of matching arbitrary rows', async () => {
    const ctx = ctxOf({ remote: false, sourceId: 'alpha' });
    await expect(get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: '' })).rejects.toBeInstanceOf(OperationError);
    await expect(get_page_by_identity.handler(ctx, { key: 'granola_document_id', value: '   ' })).rejects.toBeInstanceOf(OperationError);
  });

  test('empty key throws', async () => {
    const ctx = ctxOf({ remote: false, sourceId: 'alpha' });
    await expect(get_page_by_identity.handler(ctx, { key: '', value: 'G-shared' })).rejects.toBeInstanceOf(OperationError);
  });
});
