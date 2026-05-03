/**
 * Integration tests for the RegFox ingest orchestrator.
 *
 * Mocks the API client (no network), uses real PGLite + a real bare/clone
 * git fixture (same pattern as test/dent/markdown-writer/_helpers.ts) so
 * the full path — Postgres lookup + markdown_*-style writes + cursor
 * persistence — runs end-to-end.
 *
 * Three cases tested per Q1=B with name-match guard rail:
 *   1. New email + new name → creates a new stub, appends the bullet.
 *   2. Existing email match → appends to that page (no new stub).
 *   3. Existing slug, no email match → pending review file gets a row.
 */

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ingestOne } from '../../../../src/dent/ingestors/regfox/ingest.ts';
import type { RegfoxRegistrant } from '../../../../src/dent/ingestors/regfox/types.ts';
import { setupMarkdownWriter, type MdWriterFixture } from '../../markdown-writer/_helpers.ts';
import { runDentMigrations } from '../../../../src/dent/migrate.ts';

setDefaultTimeout(30_000);

let fx: MdWriterFixture;

beforeEach(async () => {
  fx = await setupMarkdownWriter();
  // Apply dent migrations (v3 already there from setup; v4 = regfox_ingest_state).
  await runDentMigrations(fx.engine);
});

afterEach(async () => {
  await fx.cleanup();
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

describe('ingestOne — end-to-end against real fixtures', () => {
  test('case 1: new email + new name → creates stub, returns "created"', async () => {
    const outcome = await ingestOne(fx.engine, baseRegistrant());
    expect(outcome).toBe('created');

    // The stub page exists in Postgres.
    const page = await fx.engine.getPage('entities/people/alice-example');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth ?? '').toContain('Registered for Test Conf 2026');
    expect(page?.compiled_truth ?? '').toContain('$500.00 USD');

    // The markdown file landed on disk.
    const filePath = join(fx.cloneRepo, 'entities/people/alice-example.md');
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('email: alice@example.com');
    expect(content).toContain('regfox_registrant_id: 12345');
    expect(content).toContain('## Timeline');
  });

  test('case 2: existing entity matched by email → appends, returns "appended"', async () => {
    // Pre-create the entity at a NON-name-derived slug to prove the email
    // lookup wins over the name-derived slug-existence check.
    await fx.engine.putPage('entities/people/already-here', {
      type: 'person',
      title: 'Already Here',
      compiled_truth: '# Already Here\n\nExisting page.\n',
      frontmatter: { email: 'alice@example.com', type: 'person', title: 'Already Here' },
    });

    const outcome = await ingestOne(fx.engine, baseRegistrant());
    expect(outcome).toBe('appended');

    // Append happened to the email-matched slug, NOT a new alice-example.
    const aliceNew = await fx.engine.getPage('entities/people/alice-example');
    expect(aliceNew).toBeNull();
    const matched = await fx.engine.getPage('entities/people/already-here');
    expect(matched?.compiled_truth ?? '').toContain('Registered for Test Conf 2026');
  });

  test('case 3: name-derived slug exists with no email match → pending review', async () => {
    // Pre-create a page at the same slug Alice would land on, but with no email.
    await fx.engine.putPage('entities/people/alice-example', {
      type: 'person',
      title: 'A Different Alice Example',
      compiled_truth: '# A Different Alice Example\n\nNo email on this page.\n',
      frontmatter: { type: 'person', title: 'A Different Alice Example' },
    });

    const outcome = await ingestOne(fx.engine, baseRegistrant());
    expect(outcome).toBe('pending_review');

    // No bullet was appended to the existing page (correct — could be wrong attribution).
    const existing = await fx.engine.getPage('entities/people/alice-example');
    expect(existing?.compiled_truth ?? '').not.toContain('Registered for Test Conf 2026');

    // The pending-review file got a checklist row.
    const pendingPath = join(fx.cloneRepo, '_ingest', 'pending_regfox.md');
    expect(existsSync(pendingPath)).toBe(true);
    const content = readFileSync(pendingPath, 'utf-8');
    expect(content).toContain('regfox-id:12345');
    expect(content).toContain('alice@example.com');
    expect(content).toContain('Alice Example');
  });

  test('case 3 (idempotent): same registrant queued twice does not duplicate the row', async () => {
    await fx.engine.putPage('entities/people/alice-example', {
      type: 'person',
      title: 'Other Alice',
      compiled_truth: '# Other Alice\n',
      frontmatter: { type: 'person', title: 'Other Alice' },
    });

    await ingestOne(fx.engine, baseRegistrant());
    await ingestOne(fx.engine, baseRegistrant());

    const pendingPath = join(fx.cloneRepo, '_ingest', 'pending_regfox.md');
    const content = readFileSync(pendingPath, 'utf-8');
    const rowCount = content.split('\n').filter((l) => l.includes('regfox-id:12345')).length;
    expect(rowCount).toBe(1);
  });

  test('skip: registrant with neither email nor name', async () => {
    const outcome = await ingestOne(fx.engine, baseRegistrant({
      orderEmail: undefined,
      billing: {},
    }));
    expect(outcome).toBe('skipped');
  });

  test('case 1 with discount code: bullet includes discount clause', async () => {
    await ingestOne(fx.engine, baseRegistrant({ fieldData: { coupon_code: 'EARLYBIRD' } }));
    const page = await fx.engine.getPage('entities/people/alice-example');
    expect(page?.compiled_truth ?? '').toContain('with discount code EARLYBIRD');
  });
});
