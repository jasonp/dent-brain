/**
 * Pure translator: Granola Note → meeting page + transcript page + per-attendee
 * timeline bullet. No side effects. The orchestrator (sync.ts) takes the plan
 * and dispatches MCP calls.
 */

import type { Note } from './types.ts';

export interface TranslatedMeeting {
  /** Meeting page slug, e.g. `meetings/2026-04-14-jason-and-amitai-call`. */
  meetingSlug: string;
  /** Transcript page slug (sibling of the meeting page). Null if no transcript. */
  transcriptSlug: string | null;
  /** Meeting page full content (frontmatter + body). */
  meetingContent: string;
  /** Transcript page full content (or null if no transcript was available). */
  transcriptContent: string | null;
  /** ISO date used in bullets + frontmatter. */
  isoDate: string;
  /** Stable provenance ref present in every bullet/page. */
  sourceRef: string;
  /** Lowercased attendee emails. */
  attendeeEmails: string[];
  /** Display names keyed by lowercased email. */
  attendeeNames: Record<string, string>;
  /** The single bullet to land on each matched attendee's `## Timeline`. */
  attendeeBullet: string;
}

function kebab(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isoDateOf(raw: string | undefined | null): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

function attendeeList(note: Note): { emails: string[]; names: Record<string, string> } {
  const seen = new Set<string>();
  const emails: string[] = [];
  const names: Record<string, string> = {};
  const add = (email: string | undefined | null, name?: string | null) => {
    if (!email) return;
    const e = email.trim().toLowerCase();
    if (!e || seen.has(e)) return;
    seen.add(e);
    emails.push(e);
    if (name) names[e] = name.trim();
  };
  // Prefer `attendees` (carries names); fall back to calendar invitees (email-only) + organiser.
  for (const a of note.attendees ?? []) add(a.email, a.name ?? undefined);
  for (const i of note.calendar_event?.invitees ?? []) add(i.email);
  add(note.calendar_event?.organiser);
  return { emails, names };
}

function quote(s: string): string {
  if (/[:#\n]/.test(s) || /^\s|\s$/.test(s) || /^[!&*?{}|>'"%@`]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function speakerTag(seg: { speaker: { source: string; diarization_label?: string } }): string {
  if (seg.speaker.diarization_label) return `(${seg.speaker.diarization_label})`;
  // macOS API uses `speaker` where the legacy cache used `system_audio`. Display as `(remote)`
  // to keep the human reading the transcript oriented on which side of the call spoke.
  if (seg.speaker.source === 'speaker') return '(remote)';
  if (seg.speaker.source === 'microphone') return '(local)';
  return `(${seg.speaker.source ?? '?'})`;
}

export function translateMeeting(note: Note): TranslatedMeeting {
  const ev = note.calendar_event;
  const eventStart = ev?.scheduled_start_time ?? null;
  const isoDate = isoDateOf(eventStart ?? note.created_at);
  const eventTitle = note.title || ev?.event_title || `Untitled meeting (Granola ${note.id.slice(4, 12)})`;
  const titleSlug = kebab(eventTitle || `granola-${note.id.slice(4, 12)}`);
  const meetingSlug = `meetings/${isoDate}-${titleSlug}`;
  // Transcripts go into a dedicated sub-namespace so the path-derived slug
  // matches the frontmatter slug (gbrain's slugifySegment collapses consecutive
  // hyphens — a `--transcript` suffix would SLUG_MISMATCH on re-import).
  const transcriptSlug = note.transcript && note.transcript.length > 0
    ? `meetings/transcripts/${isoDate}-${titleSlug}`
    : null;
  const sourceRef = `granola/${note.id}`;
  const { emails, names } = attendeeList(note);

  // ---------- Meeting page ----------
  const fmLines = [
    '---',
    `title: ${quote(eventTitle)}`,
    `slug: ${meetingSlug}`,
    'type: meeting',
    'created_via: granola-sync',
    `granola_document_id: ${note.id}`,
    `meeting_date: ${isoDate}`,
  ];
  if (ev?.scheduled_start_time) fmLines.push(`meeting_start: ${quote(ev.scheduled_start_time)}`);
  if (ev?.scheduled_end_time) fmLines.push(`meeting_end: ${quote(ev.scheduled_end_time)}`);
  if (note.web_url) fmLines.push(`granola_url: ${quote(note.web_url)}`);
  if (emails.length > 0) {
    fmLines.push('attendees:');
    for (const e of emails) fmLines.push(`  - ${e}`);
  }
  fmLines.push('---');
  const fm = fmLines.join('\n');

  const bodyParts: string[] = [];
  bodyParts.push(`# ${eventTitle}`);
  bodyParts.push('');
  bodyParts.push(`Meeting on ${isoDate}${eventStart ? ` at ${eventStart}` : ''}. [Source: ${sourceRef}]`);
  bodyParts.push('');

  if (note.summary_text && note.summary_text.trim().length > 0) {
    bodyParts.push('## Summary');
    bodyParts.push('');
    bodyParts.push(note.summary_text.trim());
    bodyParts.push('');
  }

  if (note.summary_markdown && note.summary_markdown.trim().length > 0) {
    bodyParts.push('## Notes');
    bodyParts.push('');
    bodyParts.push(note.summary_markdown.trim());
    bodyParts.push('');
  }

  if (emails.length > 0) {
    bodyParts.push('## Attendees');
    bodyParts.push('');
    for (const e of emails) {
      const n = names[e];
      bodyParts.push(`- ${n ? `**${n}** ` : ''}<${e}>`);
    }
    bodyParts.push('');
  }

  if (transcriptSlug) {
    bodyParts.push('## Raw transcript');
    bodyParts.push('');
    bodyParts.push(`Diarized transcript: \`${transcriptSlug}\``);
    bodyParts.push('');
  }

  const meetingContent = `${fm}\n${bodyParts.join('\n')}`;

  // ---------- Transcript page ----------
  let transcriptContent: string | null = null;
  if (transcriptSlug && note.transcript) {
    const segments = note.transcript;
    const trFmLines = [
      '---',
      `title: ${quote(`${eventTitle} — Raw transcript`)}`,
      `slug: ${transcriptSlug}`,
      'type: transcript',
      'created_via: granola-sync',
      `granola_document_id: ${note.id}`,
      `meeting_date: ${isoDate}`,
      `meeting_page: ${meetingSlug}`,
      `segment_count: ${segments.length}`,
      '---',
    ];
    const trBodyParts: string[] = [];
    trBodyParts.push(`# ${eventTitle} — Raw transcript`);
    trBodyParts.push('');
    trBodyParts.push(`Captured by Granola during the ${isoDate} meeting. ${segments.length} segments. [Source: ${sourceRef}]`);
    trBodyParts.push('');
    trBodyParts.push('See [the meeting page](' + meetingSlug + ') for summary, notes, and attendees.');
    trBodyParts.push('');
    trBodyParts.push('## Transcript');
    trBodyParts.push('');
    trBodyParts.push('```');
    // Relative timestamps from the first segment.
    const first = segments[0];
    const baseMs = first?.start_time ? new Date(first.start_time).getTime() : NaN;
    for (const seg of segments) {
      let stamp = '';
      if (Number.isFinite(baseMs) && seg.start_time) {
        const diffMs = new Date(seg.start_time).getTime() - baseMs;
        if (Number.isFinite(diffMs) && diffMs >= 0) {
          const total = Math.floor(diffMs / 1000);
          const h = String(Math.floor(total / 3600)).padStart(2, '0');
          const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
          const s = String(total % 60).padStart(2, '0');
          stamp = `[${h}:${m}:${s}] `;
        }
      }
      const tag = speakerTag(seg);
      const text = (seg.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      trBodyParts.push(`${stamp}${tag} ${text}`);
    }
    trBodyParts.push('```');
    trBodyParts.push('');
    transcriptContent = `${trFmLines.join('\n')}\n${trBodyParts.join('\n')}`;
  }

  // ---------- Per-attendee bullet ----------
  const attendeeBullet = `- **${isoDate}** | Attended meeting: [${eventTitle}](${meetingSlug}). [Source: ${sourceRef}]`;

  return {
    meetingSlug,
    transcriptSlug,
    meetingContent,
    transcriptContent,
    isoDate,
    sourceRef,
    attendeeEmails: emails,
    attendeeNames: names,
    attendeeBullet,
  };
}
