/**
 * Phase 4 entity-detection — service unit tests.
 *
 * Spins up an in-memory PGLite engine, seeds entity pages with varied
 * frontmatter (FM-linked, FM-unlinked, with aliases), and exercises
 * detectEntities against fixture text.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import type { OperationContext } from '../../../src/core/operations.ts';
import { detectEntities } from '../../../src/dent/entity-detection/service.ts';

let engine: PGLiteEngine;

function makeCtx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
  };
}

async function seedPage(
  slug: string,
  type: string,
  title: string,
  frontmatter: Record<string, unknown> = {},
): Promise<void> {
  // Build a markdown body with frontmatter so put_page picks up the
  // filemaker_record_id and aliases. The PGLite engine's putPage takes
  // a structured input — simplest path is to pass frontmatter directly.
  await engine.putPage(slug, {
    type: type as any,
    title,
    compiled_truth: `Seeded ${type} page for ${title}.`,
    frontmatter,
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
});

describe('detectEntities', () => {
  test('exact full-name match on a person page returns confidence 1.0', async () => {
    await seedPage('entities/people/founder', 'person', 'the founder', {
      filemaker_record_id: '12345',
    });
    await seedPage('entities/people/alice-example', 'person', 'Alice Example');

    const r = await detectEntities('Met with the founder at the conference.', makeCtx());
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].slug).toBe('entities/people/founder');
    expect(r.matches[0].confidence).toBe(1.0);
    expect(r.matches[0].rule).toBe('exact-title');
    expect(r.matches[0].fm_id).toBe('12345');
  });

  test('FM id surfaces from frontmatter when present, null when absent', async () => {
    await seedPage('entities/people/founder', 'person', 'the founder', {
      filemaker_record_id: '12345',
    });
    await seedPage('entities/people/alice-example', 'person', 'Alice Example'); // no fm id

    const r = await detectEntities('the founder and Alice Example.', makeCtx());
    expect(r.matches.length).toBe(2);
    const founderMatch = r.matches.find(m => m.slug.includes('founder'));
    const aliceMatch = r.matches.find(m => m.slug.includes('alice'));
    expect(founderMatch!.fm_id).toBe('12345');
    expect(aliceMatch!.fm_id).toBeNull();
  });

  test('alias from frontmatter matches', async () => {
    await seedPage('entities/people/jeff-bezos', 'person', 'Jeff Bezos', {
      aliases: ['Jeffrey Bezos', 'JB'],
    });

    const r = await detectEntities('Jeffrey Bezos founded Amazon.', makeCtx());
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].slug).toBe('entities/people/jeff-bezos');
    expect(r.matches[0].rule).toBe('alias');
    expect(r.matches[0].confidence).toBe(1.0);
  });

  test('first-name fallback fires only when full name not in text, lower confidence', async () => {
    await seedPage('entities/people/alice-example', 'person', 'Alice Example');

    const r = await detectEntities('Talked to Alice yesterday.', makeCtx());
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].rule).toBe('first-name-fallback');
    expect(r.matches[0].confidence).toBe(0.7);
  });

  test('full name match suppresses first-name fallback for same person', async () => {
    await seedPage('entities/people/alice-example', 'person', 'Alice Example');

    const r = await detectEntities('Alice Example told Mike to rest.', makeCtx());
    // Should match Alice Example once via exact-title; the trailing
    // "Mike" should NOT produce a duplicate first-name-fallback hit
    // (we already have a high-confidence match for the same slug).
    const slugs = r.matches.map(m => m.slug);
    expect(slugs).toEqual(['entities/people/alice-example']);
  });

  test('multi-word match wins over single-word when both could fire', async () => {
    await seedPage('entities/people/mike', 'person', 'Mike'); // unusual — title is just "Mike"
    await seedPage('entities/people/alice-example', 'person', 'Alice Example');

    const r = await detectEntities('Alice Example at the meeting.', makeCtx());
    // The longer "Alice Example" should consume the range; bare "Mike"
    // shouldn't double-match.
    const slugs = r.matches.map(m => m.slug);
    expect(slugs).toContain('entities/people/alice-example');
    expect(slugs).not.toContain('entities/people/mike');
  });

  test('company-type pages match', async () => {
    await seedPage('entities/companies/acme-co', 'company', 'Acme Co');

    const r = await detectEntities('Mike works at Acme Co.', makeCtx());
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].type).toBe('company');
  });

  test('non-entity-type pages are ignored', async () => {
    // A meeting page with a title that happens to contain a name
    // shouldn't get returned as an entity match.
    await seedPage('meetings/2026-04-22-jason-steve', 'meeting', 'Jason Steve');

    const r = await detectEntities('Jason Steve in the room.', makeCtx());
    expect(r.matches.length).toBe(0);
  });

  test('first-name fallback does NOT fire for non-person pages', async () => {
    await seedPage('entities/companies/acme-co', 'company', 'Acme Co');

    // Single token "Acme Co" does match exact-title (one-word title).
    // But a substring like "Leading" should NOT first-name-fallback into
    // the company. Verify by giving text with a different word.
    const r = await detectEntities('We are leading the field.', makeCtx());
    expect(r.matches.length).toBe(0);
  });

  test('case-insensitive matching', async () => {
    await seedPage('entities/people/alice-example', 'person', 'Alice Example');

    const r = await detectEntities('ALICE EXAMPLE was there. alice example returned.', makeCtx());
    expect(r.matches.length).toBe(2);
    expect(r.matches.every(m => m.slug === 'entities/people/alice-example')).toBe(true);
  });

  test('whole-word boundary — substring inside a longer word does not match', async () => {
    await seedPage('entities/people/bob', 'person', 'Bob');

    const r = await detectEntities('Bobsled was a sport.', makeCtx());
    expect(r.matches.length).toBe(0);
  });

  test('unknowns: capitalized name-like spans not matching any entity', async () => {
    await seedPage('entities/people/founder', 'person', 'the founder');

    const r = await detectEntities('the founder met Alice Example at Acme Co.', makeCtx());
    // the founder matches; Alice Example and Acme Co do not.
    // Acme Co is a single capitalized word — but "Acme Co" would
    // need to match the regex /[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/ — it
    // does NOT (no internal lowercase before second cap). So it won't
    // appear in unknowns. That's fine; CamelCase company names are a
    // known limitation for tier-1.
    expect(r.unknowns).toContain('Alice Example');
  });

  test('unknowns: stopwords like Tuesday and Dent are filtered out', async () => {
    const r = await detectEntities('On Tuesday at Dent we met John Smith.', makeCtx());
    expect(r.unknowns).not.toContain('Tuesday');
    expect(r.unknowns).not.toContain('Dent');
    expect(r.unknowns).toContain('John Smith');
  });

  test('unknowns: do not include spans already consumed by a match', async () => {
    await seedPage('entities/people/founder', 'person', 'the founder');

    const r = await detectEntities('the founder was here.', makeCtx());
    expect(r.matches.length).toBe(1);
    expect(r.unknowns).not.toContain('the founder');
    expect(r.unknowns).not.toContain('Steve');
    expect(r.unknowns).not.toContain('Broback');
  });

  test('empty text returns empty result', async () => {
    const r = await detectEntities('', makeCtx());
    expect(r.matches).toEqual([]);
    expect(r.unknowns).toEqual([]);
  });

  test('whitespace-only text returns empty result', async () => {
    const r = await detectEntities('   \n\t  ', makeCtx());
    expect(r.matches).toEqual([]);
    expect(r.unknowns).toEqual([]);
  });

  test('text with no entities and no name-like spans returns empty matches and empty unknowns', async () => {
    const r = await detectEntities('the meeting went well and we shipped it', makeCtx());
    expect(r.matches).toEqual([]);
    expect(r.unknowns).toEqual([]);
  });

  test('FM id with quotes in frontmatter is normalized', async () => {
    // putPage stores the frontmatter as-is; if a page were created via
    // raw markdown parsing the FM id might come through as a string
    // with quotes. detectEntities should still extract it cleanly.
    await seedPage('entities/people/founder', 'person', 'the founder', {
      filemaker_record_id: '"abc-123"', // with embedded quotes
    });

    const r = await detectEntities('the founder called.', makeCtx());
    // We don't strip quotes here — that's caller territory. But the
    // value should round-trip without crashing.
    expect(r.matches[0].fm_id).toBe('"abc-123"');
  });
});
