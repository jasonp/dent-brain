/**
 * Builds the daily digest markdown page that Layer 1 writes to the brain
 * and Layer 2 (the cloud /schedule routine) reads back.
 *
 * Filing convention:
 *   inbox/<work-email-slug>/<YYYY-MM-DD>.md
 *
 * The page is the queue between collector + enricher. Layer 2 reads
 * unprocessed digests, walks each entry, and updates entity timelines.
 * On completion, Layer 2 sets `processed: true` in frontmatter so we
 * don't re-process.
 *
 * Three sections per digest:
 *   ## Signatures pending — DocuSign etc. that need user action
 *   ## Triage — real human emails (the bulk of what Layer 2 acts on)
 *   ## Noise — stripped automated mail (kept for audit, not enriched)
 */

import type { CollectedEmail } from './types.ts';

export function digestSlug(workEmail: string, date: string): string {
  const emailSlug = workEmail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `inbox/${emailSlug}/${date}`;
}

function escape(s: string): string {
  // Avoid breaking markdown by stripping pipe/bracket-y chars inside table cells / titles.
  return (s ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function formatTime(iso: string): string {
  // "2026-05-08T14:32:00.000Z" → "14:32 UTC"
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}Z` : iso.slice(0, 16);
}

function formatEntry(e: CollectedEmail): string {
  const direction = e.isOutbound ? '→' : '←';
  const time = formatTime(e.date);
  const who = e.fromName ? `${e.fromName} <${e.fromEmail}>` : e.fromEmail;
  const recipients = e.recipients.length > 3
    ? `${e.recipients.slice(0, 3).join(', ')} (+${e.recipients.length - 3} more)`
    : e.recipients.join(', ');
  const lines: string[] = [];
  lines.push(`- **${time}** ${direction} ${escape(who)}`);
  lines.push(`  - **Subject:** ${escape(e.subject) || '(no subject)'}`);
  lines.push(`  - **${e.isOutbound ? 'To' : 'From → to'}:** ${escape(recipients)}`);
  if (e.snippet) lines.push(`  - **Snippet:** ${escape(e.snippet).slice(0, 250)}`);
  lines.push(`  - **Link:** [Open in Gmail](${e.gmailLink})`);
  lines.push(`  - **Source:** \`gmail/${e.messageId}\``);
  return lines.join('\n');
}

/**
 * Render a collapsed mail-merge: one entry for N outbound messages that share a
 * subject but went to different people. The individual Gmail links are all
 * preserved — nothing is dropped, it just stops costing N nearly-identical
 * blocks of Layer 2's context to say "you invited these people to the thing".
 */
function formatMergedEntry(group: CollectedEmail[]): string {
  const first = group[0];
  const recipients = Array.from(new Set(group.flatMap((e) => e.recipients)));
  const shown = recipients.length > 12
    ? `${recipients.slice(0, 12).join(', ')} (+${recipients.length - 12} more)`
    : recipients.join(', ');
  const lines: string[] = [];
  lines.push(`- **${formatTime(first.date)}** → **${group.length}× same send** (mail-merge)`);
  lines.push(`  - **Subject:** ${escape(first.subject) || '(no subject)'}`);
  lines.push(`  - **To:** ${escape(shown)}`);
  if (first.snippet) lines.push(`  - **Snippet:** ${escape(first.snippet).slice(0, 250)}`);
  lines.push(`  - **Links:** ${group.map((e, i) => `[${i + 1}](${e.gmailLink})`).join(' ')}`);
  lines.push(`  - **Source:** ${group.map((e) => `\`gmail/${e.messageId}\``).join(' ')}`);
  return lines.join('\n');
}

/**
 * Minimum number of same-subject outbound sends before we treat them as a
 * mail-merge. Two is ordinary conversation ("Re: lunch" sent twice); three or
 * more with differing recipients is a blast.
 */
const MAIL_MERGE_MIN = 3;

/**
 * Collapse outbound mail-merge sends into single entries, leaving everything
 * else untouched. Returns rendered markdown blocks in chronological order.
 *
 * The discriminator is subject + differing recipients. A thread where you
 * replied three times to the SAME group keeps identical recipient sets and is
 * deliberately left expanded — those are three distinct things you said.
 */
function renderEntries(entries: CollectedEmail[]): { blocks: string[]; merged: number; mergedGroups: number } {
  const groups = new Map<string, CollectedEmail[]>();
  const singles: CollectedEmail[] = [];

  for (const e of entries) {
    const key = escape(e.subject).toLowerCase();
    // An empty subject is not evidence of a blast — without it there is nothing
    // tying these messages together, so never let them group with each other.
    if (!e.isOutbound || !key) {
      singles.push(e);
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  const rendered: Array<{ date: string; block: string }> = singles.map((e) => ({ date: e.date, block: formatEntry(e) }));
  let merged = 0;
  let mergedGroups = 0;

  for (const group of groups.values()) {
    const recipientSets = new Set(group.map((e) => [...e.recipients].sort().join('|')));
    if (group.length >= MAIL_MERGE_MIN && recipientSets.size > 1) {
      const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
      rendered.push({ date: sorted[0].date, block: formatMergedEntry(sorted) });
      merged += sorted.length;
      mergedGroups++;
    } else {
      for (const e of group) rendered.push({ date: e.date, block: formatEntry(e) });
    }
  }

  rendered.sort((a, b) => a.date.localeCompare(b.date));
  return { blocks: rendered.map((r) => r.block), merged, mergedGroups };
}

export interface DigestPage {
  slug: string;
  content: string;
  counts: { signatures: number; triage: number; noise: number };
}

export function buildDigest(workEmail: string, date: string, emails: CollectedEmail[]): DigestPage {
  const slug = digestSlug(workEmail, date);
  const signatures: CollectedEmail[] = [];
  const triage: CollectedEmail[] = [];
  const noise: CollectedEmail[] = [];

  for (const e of emails) {
    // Bulk joins noise: both are machine-generated, kept for audit, not enriched.
    if (e.isNoise || e.isBulk) noise.push(e);
    else if (e.isSignature) signatures.push(e);
    else triage.push(e);
  }

  // Chronological within each section.
  const byDate = (a: CollectedEmail, b: CollectedEmail) => a.date.localeCompare(b.date);
  signatures.sort(byDate);
  triage.sort(byDate);
  noise.sort(byDate);

  const triageRender = renderEntries(triage);

  const fm = [
    '---',
    `title: Inbox digest — ${workEmail} — ${date}`,
    `slug: ${slug}`,
    'type: inbox-digest',
    'created_via: email-sync',
    `work_email: ${workEmail}`,
    `digest_date: ${date}`,
    `total_emails: ${emails.length}`,
    `signatures: ${signatures.length}`,
    `triage: ${triage.length}`,
    `noise: ${noise.length}`,
    `merged_sends: ${triageRender.merged}`,
    'processed: false',
    `updated: ${new Date().toISOString()}`,
    '---',
  ].join('\n');

  const body: string[] = [];
  body.push(`# Inbox digest — ${workEmail} — ${date}`);
  body.push('');
  const mergeNote = triageRender.merged > 0
    ? ` ${triageRender.merged} outbound mail-merge sends collapsed into ${triageRender.mergedGroups} ${triageRender.mergedGroups === 1 ? 'entry' : 'entries'}.`
    : '';
  body.push(`Auto-generated by email-sync. ${triage.length} triage, ${signatures.length} signatures, ${noise.length} noise.${mergeNote}`);
  body.push('');
  body.push('Layer 2 (`/dent-process-inbox`) reads the **Triage** section to update entity timelines. Signatures are surfaced for human action. Noise is kept for audit only.');
  body.push('');

  body.push('## Signatures');
  if (signatures.length === 0) {
    body.push('');
    body.push('_None._');
  } else {
    body.push('');
    for (const e of signatures) body.push(formatEntry(e));
  }
  body.push('');

  body.push('## Triage');
  if (triageRender.blocks.length === 0) {
    body.push('');
    body.push('_None._');
  } else {
    body.push('');
    for (const block of triageRender.blocks) body.push(block);
  }
  body.push('');

  body.push('## Noise');
  if (noise.length === 0) {
    body.push('');
    body.push('_None._');
  } else {
    body.push('');
    for (const e of noise) body.push(formatEntry(e));
  }
  body.push('');

  return {
    slug,
    content: `${fm}\n\n${body.join('\n')}`,
    counts: { signatures: signatures.length, triage: triage.length, noise: noise.length },
  };
}
