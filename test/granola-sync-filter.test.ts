import { describe, expect, test } from 'bun:test';
import { filter, includeFolders } from '../tools/granola-sync/recipe/filter.example.ts';
import type { Note } from '../tools/granola-sync/types.ts';

/**
 * Pins the v0.39 example user filter's behavior. Two purposes:
 *   1. Smoke-test that the example exports the new contract (`filter(note)`).
 *   2. Catch regressions if someone edits the example without thinking through
 *      what teammates relying on the default would see.
 *
 * Teammates' real filters live in `~/.dent-brain/granola-sync/user/filter.ts`
 * and are not covered here — by design, those are bespoke and per-user.
 */

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'not_test_1',
    object: 'note',
    title: null,
    owner: { name: null, email: 'owner@example.com' },
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    web_url: 'https://granola.example/n/test',
    calendar_event: null,
    attendees: [],
    folder_membership: [],
    summary_text: '',
    summary_markdown: '',
    transcript: null,
    ...overrides,
  };
}

describe('granola-sync example filter — v0.39 default behavior', () => {
  test('exports includeFolders (the reconcile capture set) as a non-empty string[]', () => {
    expect(Array.isArray(includeFolders)).toBe(true);
    expect(includeFolders.length).toBeGreaterThan(0);
    expect(includeFolders.every((f) => typeof f === 'string' && f.length > 0)).toBe(true);
  });

  test('drops note with no signal whatsoever', () => {
    const r = filter(makeNote({ title: 'Lunch' }));
    expect(r.keep).toBe(false);
  });

  test('keeps note in the "Dent" Granola folder', () => {
    const r = filter(makeNote({
      title: 'Q3 planning',
      folder_membership: [{ id: 'f1', object: 'folder', name: 'Dent', parent_folder_id: null }],
    }));
    expect(r.keep).toBe(true);
    if (r.keep) expect(r.reason).toContain('Dent');
  });

  test('keeps note with "dent" as a whole word in title (not "evident" or "dental")', () => {
    expect(filter(makeNote({ title: 'Sync with the Dent team' })).keep).toBe(true);
    expect(filter(makeNote({ title: 'Dental cleaning at 2pm' })).keep).toBe(false);
    expect(filter(makeNote({ title: 'Evident progress on Q3' })).keep).toBe(false);
  });

  test('keeps note with org-domain attendee', () => {
    const r = filter(makeNote({
      title: 'External chat',
      attendees: [{ email: 'jeff@dentthefuture.com', name: 'Jeff' }],
    }));
    expect(r.keep).toBe(true);
    if (r.keep) expect(r.reason).toContain('org-domain');
  });

  test('keeps note where transcript body mentions "dent"', () => {
    const r = filter(makeNote({
      title: 'Random catchup',
      transcript: [{
        speaker: { source: 'microphone' },
        text: 'Yeah Dent is what we were just discussing',
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-05-01T00:00:05Z',
      }],
    }));
    expect(r.keep).toBe(true);
  });

  test('returns a reason string for every verdict', () => {
    expect(typeof filter(makeNote()).reason).toBe('string');
    expect(typeof filter(makeNote({ title: 'Dent sync' })).reason).toBe('string');
  });
});
