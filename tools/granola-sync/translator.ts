/**
 * Pure translator: GranolaDocument + transcript segments → meeting page +
 * transcript page + per-attendee timeline bullet.
 *
 * No side effects. The orchestrator (sync.ts) takes the plan and dispatches
 * MCP calls.
 */

import type { GranolaDocument, GranolaTranscriptSegment } from './types.ts';

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
  /** Lowercased attendee emails (sans the teammate themselves). Caller uses
   *  these to email-match against existing entity pages and emit timeline
   *  bullets / create new stubs. */
  attendeeEmails: string[];
  /** Display names keyed by lowercased email — best effort from calendar event. */
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

function isoDateOf(raw: string | undefined): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

function timeOf(raw: string | undefined): string {
  if (!raw) return '00:00:00';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '00:00:00';
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function attendeeList(doc: GranolaDocument): { emails: string[]; names: Record<string, string> } {
  const ev = doc.google_calendar_event;
  const seen = new Set<string>();
  const emails: string[] = [];
  const names: Record<string, string> = {};
  const add = (email: string | undefined, name?: string) => {
    if (!email) return;
    const e = email.trim().toLowerCase();
    if (!e || seen.has(e)) return;
    seen.add(e);
    emails.push(e);
    if (name) names[e] = name.trim();
  };
  for (const a of ev?.attendees ?? []) add(a.email, a.displayName);
  add(ev?.creator?.email, ev?.creator?.displayName);
  add(ev?.organizer?.email);
  return { emails, names };
}

function quote(s: string): string {
  // Wrap a string in JSON-style quotes if it contains characters YAML cares about.
  if (/[:#\n]/.test(s) || /^\s|\s$/.test(s) || /^[!&*?{}|>'"%@`]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

export function translateMeeting(
  doc: GranolaDocument,
  transcript: GranolaTranscriptSegment[] | undefined,
): TranslatedMeeting {
  const isoDate = isoDateOf(doc.created_at);
  const titleSlug = kebab(doc.title || `granola-${doc.id.slice(0, 8)}`);
  const meetingSlug = `meetings/${isoDate}-${titleSlug}`;
  // Transcripts go into a dedicated sub-namespace, not as a `--transcript`
  // suffix. gbrain's `slugifySegment` collapses consecutive hyphens, so a
  // suffix-with-double-dash file would always SLUG_MISMATCH on re-import
  // (path-derived slug single-dashes; frontmatter double-dashed). The
  // sub-namespace also matches `gbrain.yml`'s existing `meetings/transcripts/`
  // db_only tier — transcripts stop bloating the dent-brain-data git history.
  const transcriptSlug = transcript && transcript.length > 0
    ? `meetings/transcripts/${isoDate}-${titleSlug}`
    : null;
  const sourceRef = `granola/${doc.id}`;
  const { emails, names } = attendeeList(doc);

  const ev = doc.google_calendar_event;
  const eventTitle = doc.title || ev?.summary || `Untitled meeting (Granola ${doc.id.slice(0, 8)})`;
  const startISO = ev?.start?.dateTime ?? ev?.start?.date;
  const endISO = ev?.end?.dateTime ?? ev?.end?.date;

  // ---------- Meeting page ----------
  const fmLines = [
    '---',
    `title: ${quote(eventTitle)}`,
    `slug: ${meetingSlug}`,
    'type: meeting',
    'created_via: granola-sync',
    `granola_document_id: ${doc.id}`,
    `meeting_date: ${isoDate}`,
  ];
  if (startISO) fmLines.push(`meeting_start: ${quote(String(startISO))}`);
  if (endISO) fmLines.push(`meeting_end: ${quote(String(endISO))}`);
  if (ev?.location) fmLines.push(`meeting_location: ${quote(ev.location)}`);
  if (ev?.htmlLink) fmLines.push(`calendar_url: ${quote(ev.htmlLink)}`);
  if (emails.length > 0) {
    fmLines.push('attendees:');
    for (const e of emails) fmLines.push(`  - ${e}`);
  }
  fmLines.push('---');
  const fm = fmLines.join('\n');

  const bodyParts: string[] = [];
  bodyParts.push(`# ${eventTitle}`);
  bodyParts.push('');
  bodyParts.push(`Meeting on ${isoDate}${startISO ? ` at ${startISO}` : ''}. [Source: ${sourceRef}]`);
  bodyParts.push('');

  if (doc.summary && doc.summary.trim().length > 0) {
    bodyParts.push('## Summary');
    bodyParts.push('');
    bodyParts.push(doc.summary.trim());
    bodyParts.push('');
  }

  if (doc.notes_markdown && doc.notes_markdown.trim().length > 0) {
    bodyParts.push('## Notes');
    bodyParts.push('');
    bodyParts.push(doc.notes_markdown.trim());
    bodyParts.push('');
  }

  if (Array.isArray(doc.chapters) && doc.chapters.length > 0) {
    bodyParts.push('## Chapters');
    bodyParts.push('');
    for (const ch of doc.chapters) {
      if (!ch?.title) continue;
      const t = ch.start_timestamp ? ` (${timeOf(ch.start_timestamp)})` : '';
      bodyParts.push(`- **${ch.title}**${t}${ch.summary ? `: ${ch.summary}` : ''}`);
    }
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
    bodyParts.push(`Diarized transcript (mic vs system audio): \`${transcriptSlug}\``);
    bodyParts.push('');
  }

  const meetingContent = `${fm}\n${bodyParts.join('\n')}`;

  // ---------- Transcript page ----------
  let transcriptContent: string | null = null;
  if (transcriptSlug && transcript) {
    const trFmLines = [
      '---',
      `title: ${quote(`${eventTitle} — Raw transcript`)}`,
      `slug: ${transcriptSlug}`,
      'type: transcript',
      'created_via: granola-sync',
      `granola_document_id: ${doc.id}`,
      `meeting_date: ${isoDate}`,
      `meeting_page: ${meetingSlug}`,
      `segment_count: ${transcript.length}`,
      '---',
    ];
    const trBodyParts: string[] = [];
    trBodyParts.push(`# ${eventTitle} — Raw transcript`);
    trBodyParts.push('');
    trBodyParts.push(`Captured by Granola during the ${isoDate} meeting. ${transcript.length} segments. [Source: ${sourceRef}]`);
    trBodyParts.push('');
    trBodyParts.push('See [the meeting page](' + meetingSlug + ') for summary, notes, and attendees.');
    trBodyParts.push('');
    trBodyParts.push('## Transcript');
    trBodyParts.push('');
    trBodyParts.push('```');
    // Compute a meeting-relative time using the first segment as t=0.
    const first = transcript[0];
    const baseMs = first?.start_timestamp ? new Date(first.start_timestamp).getTime() : NaN;
    for (const seg of transcript) {
      let stamp = '';
      if (Number.isFinite(baseMs) && seg.start_timestamp) {
        const diffMs = new Date(seg.start_timestamp).getTime() - baseMs;
        if (Number.isFinite(diffMs) && diffMs >= 0) {
          const total = Math.floor(diffMs / 1000);
          const h = String(Math.floor(total / 3600)).padStart(2, '0');
          const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
          const s = String(total % 60).padStart(2, '0');
          stamp = `[${h}:${m}:${s}] `;
        }
      }
      const tag = seg.source === 'system_audio' ? '(remote)' : seg.source === 'microphone' ? '(local)' : `(${seg.source ?? '?'})`;
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
