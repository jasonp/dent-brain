import { describe, expect, test } from 'bun:test';
import { meetingSlugOf, translateMeeting } from '../tools/granola-sync/translator.ts';
import type { Note } from '../tools/granola-sync/types.ts';

/**
 * Brain-existence dedup keys on the stable granola_document_id (identity), not
 * the slug — so a Granola rename can't fork a second page. meetingSlugOf is now
 * the FALLBACK slug: the write target for a brand-new note that has no existing
 * page to reuse. It must still equal the slug translateMeeting derives, or a
 * first-time write and any same-run reference would disagree. These pin
 * meetingSlugOf and that fallback-slug parity invariant.
 */

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'not_abcd1234',
    object: 'note',
    title: 'Weekly Dent Team Sync',
    owner: { name: null, email: 'owner@example.com' },
    created_at: '2026-06-19T18:30:32.008Z',
    updated_at: '2026-06-19T18:30:32.008Z',
    web_url: 'https://granola.example/n/test',
    calendar_event: null,
    attendees: [],
    folder_membership: [],
    summary_text: 'notes',
    summary_markdown: null,
    transcript: null,
    ...overrides,
  };
}

describe('meetingSlugOf', () => {
  test('derives meetings/<date>-<kebab-title> from title + created_at', () => {
    expect(meetingSlugOf(makeNote())).toBe('meetings/2026-06-19-weekly-dent-team-sync');
  });

  test('works on a bare list summary (no calendar_event field present)', () => {
    const summary = { id: 'not_x', title: 'Cold Sales Process Meet', created_at: '2026-06-10T09:00:00Z' };
    expect(meetingSlugOf(summary)).toBe('meetings/2026-06-10-cold-sales-process-meet');
  });

  test('the pre-check slug (summary) equals the ingest slug (full note) for the common case', () => {
    // Same title + created_at, no calendar_event override → must match exactly,
    // or the reconcile existence check would never see its own writes.
    const note = makeNote();
    const summary = { id: note.id, title: note.title, created_at: note.created_at };
    expect(meetingSlugOf(summary)).toBe(translateMeeting(note).meetingSlug);
  });

  test('falls back to a stable id-based slug when the title is null', () => {
    const slug = meetingSlugOf(makeNote({ title: null }));
    expect(slug).toBe('meetings/2026-06-19-untitled-meeting-granola-abcd1234');
  });
});

describe('translateMeeting transcript slug stays paired with the meeting slug', () => {
  test('transcript slug is the meeting slug under the transcripts/ namespace', () => {
    const t = translateMeeting(makeNote({
      transcript: [{ speaker: { source: 'microphone' }, text: 'hi', start_time: 'a', end_time: 'b' }],
    }));
    expect(t.meetingSlug).toBe('meetings/2026-06-19-weekly-dent-team-sync');
    expect(t.transcriptSlug).toBe('meetings/transcripts/2026-06-19-weekly-dent-team-sync');
  });
});

describe('translateMeeting honors a caller-supplied canonicalSlug', () => {
  // When the note is already in the brain (identity match), the reconcile loop
  // passes the EXISTING page's slug so a Granola rename updates in place instead
  // of forking a new page. The override must cascade everywhere the fallback
  // slug would have flowed: meeting slug, transcript slug, frontmatter
  // meeting_page, and the per-attendee bullet link.
  const canonicalSlug = 'meetings/2026-06-19-original-title-before-rename';

  test('canonicalSlug overrides the title-derived fallback as the meeting slug', () => {
    // The note now has a renamed title that WOULD derive a different slug; the
    // override must win, so the two must differ AND the override must be used.
    const note = makeNote({ title: 'Renamed In Granola' });
    expect(meetingSlugOf(note)).toBe('meetings/2026-06-19-renamed-in-granola');
    const t = translateMeeting(note, { canonicalSlug });
    expect(t.meetingSlug).toBe(canonicalSlug);
  });

  test('the override cascades to the transcript slug under transcripts/', () => {
    const t = translateMeeting(
      makeNote({
        transcript: [{ speaker: { source: 'microphone' }, text: 'hi', start_time: 'a', end_time: 'b' }],
      }),
      { canonicalSlug },
    );
    expect(t.transcriptSlug).toBe('meetings/transcripts/2026-06-19-original-title-before-rename');
  });

  test('the override cascades to the meeting_page frontmatter on the transcript page', () => {
    const t = translateMeeting(
      makeNote({
        transcript: [{ speaker: { source: 'microphone' }, text: 'hi', start_time: 'a', end_time: 'b' }],
      }),
      { canonicalSlug },
    );
    expect(t.transcriptContent).toContain(`meeting_page: ${canonicalSlug}`);
    expect(t.transcriptContent).toContain(`slug: meetings/transcripts/2026-06-19-original-title-before-rename`);
  });

  test('the override cascades to the meeting page slug frontmatter and the attendee bullet link', () => {
    const t = translateMeeting(makeNote({ title: 'Renamed In Granola' }), { canonicalSlug });
    expect(t.meetingContent).toContain(`slug: ${canonicalSlug}`);
    expect(t.attendeeBullet).toContain(`(${canonicalSlug})`);
  });
});
