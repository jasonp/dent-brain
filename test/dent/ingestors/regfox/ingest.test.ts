/**
 * Integration tests for the RegFox ingest orchestrator — DB-backed
 * (single-brain Stage C rebuild of the deleted git-fixture version).
 *
 * No network, no git: ingestOne writes through the db-writer straight
 * into PGLite (source 'dent'). Cases per Q1=B with name-match guard rail:
 *   1. New email + new name → creates a new stub in the DB.
 *   2. Existing email match → appends to that page (no new stub).
 *   3. Existing slug, no email match → pending-review page gets a row.
 *   + idempotent re-ingest, skip, discount clause, emails:-list matching.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, setDefaultTimeout } from 'bun:test';
import { PGLiteEngine } from '../../../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../../../helpers/reset-pglite.ts';
import { runDentMigrations } from '../../../../src/dent/migrate.ts';
import { ingestOne } from '../../../../src/dent/ingestors/regfox/ingest.ts';
import type { RegfoxRegistrant } from '../../../../src/dent/ingestors/regfox/types.ts';
import { DENT_SOURCE_ID, readPageMarkdown } from '../../../../src/dent/db-writer/page-io.ts';
import { upsertDentSource } from '../../db-writer/_helpers.ts';

setDefaultTimeout(30_000);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await upsertDentSource(engine);
  // resetPgliteState truncates config (incl. dent_version), so the dent
  // migrations (v4 = regfox_ingest_state) re-apply idempotently per test.
  await runDentMigrations(engine);
});

const baseRegistrant = (overrides: Partial<RegfoxRegistrant> = {}): RegfoxRegistrant => ({
  id: 12345,
  formId: 1440,
  formName: 'Test Conf 2026',
  orderEmail: 'alice@example.com',
  status: 'completed',
  total: '500.00',
  currency: 'USD',
  dateCreated: '2026-04-22T15:00:00Z',
  billing: { firstName: 'Alice', lastName: 'Example' },
  ...overrides,
});

describe('ingestOne — DB-backed end-to-end', () => {
  test('case 1: new email + new name → creates stub on source dent, returns "created"', async () => {
    const outcome = await ingestOne(engine, baseRegistrant());
    expect(outcome).toBe('created');

    // The stub page exists in the DB on source 'dent'.
    const page = await engine.getPage('entities/people/alice-example', { sourceId: DENT_SOURCE_ID });
    expect(page).not.toBeNull();
    expect(page?.compiled_truth ?? '').toContain('Registered for Test Conf 2026');
    expect(page?.compiled_truth ?? '').toContain('$500.00 USD');

    // Canonical rendering carries the stub frontmatter + Timeline section.
    const md = await readPageMarkdown(engine, 'entities/people/alice-example');
    expect(md).not.toBeNull();
    expect(md!.markdown).toContain('email: alice@example.com');
    expect(md!.markdown).toContain('regfox_registrant_id: 12345');
    expect(md!.markdown).toContain('## Timeline');

    // And there is NO page on 'default' — writes are dent-scoped only.
    expect(await engine.getPage('entities/people/alice-example', { sourceId: 'default' })).toBeNull();
  });

  test('case 2: existing entity matched by email → appends, returns "appended"', async () => {
    // Pre-create the entity at a NON-name-derived slug to prove the email
    // lookup wins over the name-derived slug-existence check.
    await engine.putPage('entities/people/already-here', {
      type: 'person',
      title: 'Already Here',
      compiled_truth: '# Already Here\n\nExisting page.\n',
      frontmatter: { email: 'alice@example.com', type: 'person', title: 'Already Here' },
    }, { sourceId: DENT_SOURCE_ID });

    const outcome = await ingestOne(engine, baseRegistrant());
    expect(outcome).toBe('appended');

    // Append happened to the email-matched slug, NOT a new alice-example.
    expect(await engine.getPage('entities/people/alice-example')).toBeNull();
    const matched = await engine.getPage('entities/people/already-here', { sourceId: DENT_SOURCE_ID });
    expect(`${matched?.compiled_truth ?? ''}${matched?.timeline ?? ''}`).toContain('Registered for Test Conf 2026');
  });

  test('case 2 (idempotent re-ingest): same registrant twice → second pass appends via email match, no duplicate stub', async () => {
    expect(await ingestOne(engine, baseRegistrant())).toBe('created');
    // The stub now carries email: alice@example.com → re-ingest email-matches
    // and appends to the same page instead of creating a duplicate.
    expect(await ingestOne(engine, baseRegistrant())).toBe('appended');

    const pages = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE slug LIKE 'entities/people/alice-example%' AND deleted_at IS NULL`,
    );
    expect(pages.length).toBe(1);
  });

  test('case 3: name-derived slug exists with no email match → pending review', async () => {
    // Pre-create a page at the same slug Alice would land on, but with no email.
    await engine.putPage('entities/people/alice-example', {
      type: 'person',
      title: 'A Different Alice Example',
      compiled_truth: '# A Different Alice Example\n\nNo email on this page.\n',
      frontmatter: { type: 'person', title: 'A Different Alice Example' },
    }, { sourceId: DENT_SOURCE_ID });

    const outcome = await ingestOne(engine, baseRegistrant());
    expect(outcome).toBe('pending_review');

    // No bullet was appended to the existing page (could be wrong attribution).
    const existing = await engine.getPage('entities/people/alice-example', { sourceId: DENT_SOURCE_ID });
    expect(existing?.compiled_truth ?? '').not.toContain('Registered for Test Conf 2026');

    // The pending-review page got a checklist row, on source 'dent'.
    const pending = await readPageMarkdown(engine, '_ingest/pending_regfox');
    expect(pending).not.toBeNull();
    expect(pending!.markdown).toContain('regfox-id:12345');
    expect(pending!.markdown).toContain('alice@example.com');
    expect(pending!.markdown).toContain('Alice Example');
  });

  test('case 3 (idempotent): same registrant queued twice does not duplicate the pending row', async () => {
    await engine.putPage('entities/people/alice-example', {
      type: 'person',
      title: 'Other Alice',
      compiled_truth: '# Other Alice\n',
      frontmatter: { type: 'person', title: 'Other Alice' },
    }, { sourceId: DENT_SOURCE_ID });

    await ingestOne(engine, baseRegistrant());
    await ingestOne(engine, baseRegistrant());

    const pending = await readPageMarkdown(engine, '_ingest/pending_regfox');
    const rowCount = pending!.markdown.split('\n').filter((l) => l.includes('regfox-id:12345')).length;
    expect(rowCount).toBe(1);
  });

  test('skip: registrant with neither email nor name', async () => {
    const outcome = await ingestOne(engine, baseRegistrant({
      orderEmail: undefined,
      billing: {},
    }));
    expect(outcome).toBe('skipped');
  });

  test('case 1 with discount code: bullet includes discount clause', async () => {
    await ingestOne(engine, baseRegistrant({ fieldData: { coupon_code: 'EARLYBIRD' } }));
    const page = await engine.getPage('entities/people/alice-example', { sourceId: DENT_SOURCE_ID });
    expect(page?.compiled_truth ?? '').toContain('with discount code EARLYBIRD');
  });

  test('case 2 array shape: page with emails: list matches by any address in the list', async () => {
    await engine.putPage('entities/people/multi-email-person', {
      type: 'person',
      title: 'Multi Email Person',
      compiled_truth: '# Multi Email Person\n\nPage with multiple known emails.\n',
      frontmatter: {
        type: 'person',
        title: 'Multi Email Person',
        email: 'primary@example.com',
        emails: ['primary@example.com', 'secondary@example.com', 'tertiary@example.com'],
      },
    }, { sourceId: DENT_SOURCE_ID });

    // Registrant uses one of the SECONDARY emails — should still email-match.
    const outcome = await ingestOne(engine, baseRegistrant({ orderEmail: 'secondary@example.com' }));
    expect(outcome).toBe('appended');

    expect(await engine.getPage('entities/people/alice-example')).toBeNull();
    const matched = await engine.getPage('entities/people/multi-email-person', { sourceId: DENT_SOURCE_ID });
    expect(`${matched?.compiled_truth ?? ''}${matched?.timeline ?? ''}`).toContain('Registered for Test Conf 2026');
  });

  test('case 2 array shape: case-insensitive within the emails: list', async () => {
    await engine.putPage('entities/people/casey-example', {
      type: 'person',
      title: 'Casey Example',
      compiled_truth: '# Casey Example\n',
      frontmatter: {
        type: 'person',
        title: 'Casey Example',
        emails: ['Casey@Example.com'], // mixed case in the list
      },
    }, { sourceId: DENT_SOURCE_ID });

    const outcome = await ingestOne(engine, baseRegistrant({ orderEmail: 'casey@example.com' }));
    expect(outcome).toBe('appended');
  });

  // ── Broadened name-collision resolution (v2): confidently merge returning
  // attendees whose new email didn't exact-match, and RECORD the new email.
  test('name-match: shared custom domain → appended + new email recorded', async () => {
    await engine.putPage('entities/people/dana-corey', {
      type: 'person', title: 'Dana Corey',
      compiled_truth: '# Dana Corey\n\n## Timeline\n\n- **2020-01-01** | prior.\n',
      frontmatter: { type: 'person', title: 'Dana Corey', email: 'dana@acme-eng.io' },
    }, { sourceId: DENT_SOURCE_ID });

    // New registration with a DIFFERENT address on the SAME custom domain.
    const outcome = await ingestOne(engine, baseRegistrant({
      orderEmail: 'd.corey@acme-eng.io',
      billing: { firstName: 'Dana', lastName: 'Corey' },
    }));
    expect(outcome).toBe('appended');

    const md = await readPageMarkdown(engine, 'entities/people/dana-corey');
    expect(md!.markdown).toContain('Registered for Test Conf 2026'); // bullet landed
    expect(md!.markdown).toContain('d.corey@acme-eng.io');           // email recorded → next time email-matches
    // No stray name-derived stub was created.
    expect(await engine.getPage('entities/people/dana-corey-1')).toBeNull();
  });

  test('name-match: surname-as-domain → appended', async () => {
    await engine.putPage('entities/people/pat-quillfeather', {
      type: 'person', title: 'Pat Quillfeather',
      compiled_truth: '# Pat Quillfeather\n\n## Timeline\n\n- **2020-01-01** | prior.\n',
      frontmatter: { type: 'person', title: 'Pat Quillfeather' }, // no email on file
    }, { sourceId: DENT_SOURCE_ID });

    const outcome = await ingestOne(engine, baseRegistrant({
      orderEmail: 'pat@quillfeather.io',
      billing: { firstName: 'Pat', lastName: 'Quillfeather' },
    }));
    expect(outcome).toBe('appended');
  });

  test('name-match: a known same-name variant (-2) suppresses the name signal → pending', async () => {
    await engine.putPage('entities/people/pat-quillfeather', {
      type: 'person', title: 'Pat Quillfeather',
      compiled_truth: '# Pat Quillfeather\n',
      frontmatter: { type: 'person', title: 'Pat Quillfeather' },
    }, { sourceId: DENT_SOURCE_ID });
    await engine.putPage('entities/people/pat-quillfeather-2', {
      type: 'person', title: 'Pat Quillfeather',
      compiled_truth: '# Pat Quillfeather (2)\n',
      frontmatter: { type: 'person', title: 'Pat Quillfeather' },
    }, { sourceId: DENT_SOURCE_ID });

    const outcome = await ingestOne(engine, baseRegistrant({
      orderEmail: 'pat@quillfeather.io',
      billing: { firstName: 'Pat', lastName: 'Quillfeather' },
    }));
    expect(outcome).toBe('pending_review');
  });
});
