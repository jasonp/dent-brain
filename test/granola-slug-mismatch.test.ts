/**
 * Regression — granola-sync generated SLUG_MISMATCH-prone slugs.
 *
 * The 2026-06 incident: a Granola meeting titled
 *   "Dent speaker lineup — Julia fireside chat, AI talk strategy, and
 *    diversity outreach with Stewart"
 * kebab'd to an 80-char titleSlug whose truncation landed on a hyphen
 * boundary, producing `…-diversity-outreach-` (trailing dash). gbrain's
 * `slugifySegment` strips that trailing dash on import, so the path-derived
 * slug no longer matched the frontmatter `slug:` → SLUG_MISMATCH, which
 * hard-blocked EVERY sync for 17 days.
 *
 * The fix re-strips trailing hyphens AFTER the .slice(0, 80) in kebab()
 * (translator.ts) and the attendee-stub slugifier (sync.ts). This pins the
 * invariant: every slug granola-sync emits must already be canonical, i.e.
 * `slugifyPath(slug + '.md') === slug`, so re-import never mismatches.
 */

import { describe, test, expect } from 'bun:test';
import { translateMeeting } from '../tools/granola-sync/translator.ts';
import type { Note } from '../tools/granola-sync/types.ts';
import { slugifyPath } from '../src/core/sync.ts';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'not_test_slug',
    object: 'note',
    title: null,
    owner: { name: null, email: 'owner@example.com' },
    created_at: '2026-05-15T17:00:00Z',
    updated_at: '2026-05-15T17:00:00Z',
    web_url: 'https://granola.example/n/test',
    calendar_event: null,
    attendees: [],
    folder_membership: [],
    summary_text: '',
    summary_markdown: '',
    transcript: [{ speaker: { source: 'microphone' }, text: 'hi' }] as Note['transcript'],
    ...overrides,
  };
}

/** The slug a file at `<slug>.md` resolves to on import. No mismatch ⇔ equal. */
function pathDerived(slug: string): string {
  return slugifyPath(`${slug}.md`);
}

describe('granola-sync slug generation — SLUG_MISMATCH regression', () => {
  const INCIDENT_TITLE =
    'Dent speaker lineup — Julia fireside chat, AI talk strategy, and diversity outreach with Stewart';

  test('the exact incident title no longer yields a trailing-dash slug', () => {
    const t = translateMeeting(makeNote({ title: INCIDENT_TITLE }));
    expect(t.meetingSlug.endsWith('-')).toBe(false);
    expect(t.meetingSlug).toBe(pathDerived(t.meetingSlug)); // no SLUG_MISMATCH
    expect(t.transcriptSlug).not.toBeNull();
    expect(t.transcriptSlug!.endsWith('-')).toBe(false);
    expect(t.transcriptSlug!).toBe(pathDerived(t.transcriptSlug!));
  });

  test('meeting and transcript slugs are byte-for-byte canonical', () => {
    // A spread of titles, including ones engineered to truncate on a hyphen
    // boundary at char 80 and ones with trailing punctuation/whitespace.
    const titles = [
      INCIDENT_TITLE,
      'a'.repeat(78) + ' b c',                       // space → hyphen right at the boundary
      'word-'.repeat(30),                            // many hyphens, truncates mid-pattern
      'Trailing punctuation outreach —',             // em-dash + space tail
      'Mixed CASE With Spaces   ',                    // trailing whitespace
    ];
    for (const title of titles) {
      const t = translateMeeting(makeNote({ title, id: `not_${title.length}` }));
      expect(t.meetingSlug).toBe(pathDerived(t.meetingSlug));
      expect(t.meetingSlug.endsWith('-')).toBe(false);
      if (t.transcriptSlug) {
        expect(t.transcriptSlug).toBe(pathDerived(t.transcriptSlug));
        expect(t.transcriptSlug.endsWith('-')).toBe(false);
      }
    }
  });

  test('frontmatter slug + meeting_page reference both use the canonical slug', () => {
    // translateMeeting embeds `slug: <meetingSlug>` and `meeting_page:
    // <meetingSlug>` in its output; if meetingSlug is canonical, neither can
    // drift on re-import.
    const t = translateMeeting(makeNote({ title: INCIDENT_TITLE }));
    expect(t.meetingContent).toContain(`slug: ${t.meetingSlug}`);
    if (t.transcriptContent) {
      expect(t.transcriptContent).toContain(`meeting_page: ${t.meetingSlug}`);
    }
  });
});
