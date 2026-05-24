# granola-sync recipe — `user/filter.ts` contract

This file is read by the **local Claude** the teammate runs on their laptop during `/dent-extensions setup granola-sync`. It is the contract between the daemon (canonical, shipped by the plugin) and the user filter (bespoke, generated per teammate).

`RECIPE_VERSION = 1`. Bump only when this contract changes.

## The contract

`~/.dent-brain/granola-sync/user/filter.ts` must export:

```typescript
import type { Note, FilterResult } from '../types.ts';

export const RECIPE_VERSION = 1;

export function filter(note: Note): FilterResult {
  // ... your logic
  return { keep: true, reason: 'why' };
  // or
  return { keep: false, reason: 'why' };
}
```

The daemon imports this module at startup. The filter is called once per Granola note (after cursor + dedup, before any MCP writes). `keep: true` files the meeting into the **shared** brain — visible to every teammate who can read it. `keep: false` drops it silently.

`reason` is logged in dry-run and verbose runs so the teammate can audit decisions. Write reasons humans can read at a glance — "folder:Dent", "title kw 'dent'", "excluded by therapist domain". They are not seen by the brain.

## Iron rules

1. **Pure function.** No network, no fs, no env reads, no side effects. Deterministic on the input.
2. **Privacy bias: exclude by default.** When ambiguous, return `keep: false`. A false-negative drops one meeting; a false-positive publishes someone's private call to the team.
3. **Exclusion wins over inclusion.** If you have both include and exclude rules, check excludes first and return `keep: false` as soon as one matches.
4. **No third-party logging.** Don't `console.log` PII from the note. The daemon already logs `note.title` for kept items at INFO; verbose mode logs both keep and skip with title — that's all the audit trail anyone needs.

## What's in `Note`

See `../types.ts` for the full shape. Fields the filter typically uses:

- `note.title` — the meeting title.
- `note.folder_membership: Folder[]` — Granola folders the user filed it into. Each has a `name`.
- `note.attendees: User[]` — `{ name, email }`. Names are often null.
- `note.calendar_event` — `{ event_title, invitees, organiser, scheduled_start_time, scheduled_end_time }`. `invitees: { email }[]`, `organiser: string | null`.
- `note.summary_text`, `note.summary_markdown` — Granola's auto-summary. Treat as untrusted free text; whole-word matching beats substring.
- `note.transcript` — diarized segments with `text`. Optional; often present for completed meetings, absent for in-progress ones.
- `note.created_at` — ISO timestamp.

## Common patterns to compose

### Include by Granola folder (strongest signal)

Users curate folders by hand, so folder membership is the most reliable include signal:

```typescript
const folders = (note.folder_membership ?? []).map(f => f.name.toLowerCase());
if (folders.includes('dent')) return { keep: true, reason: 'folder: Dent' };
```

### Include by attendee domain

```typescript
const emails = [
  ...(note.attendees ?? []).map(a => a.email),
  ...(note.calendar_event?.invitees ?? []).map(i => i.email),
  note.calendar_event?.organiser,
].filter((e): e is string => !!e).map(e => e.toLowerCase());

if (emails.some(e => e.endsWith('@example.com'))) {
  return { keep: true, reason: 'teammate attended' };
}
```

### Include by whole-word title/body keyword

Avoid substring matching — "dent" would match "evident" and "dental":

```typescript
function wholeWord(haystack: string, kw: string): boolean {
  return new RegExp(`\\b${kw}\\b`, 'i').test(haystack);
}

if (wholeWord(note.title ?? '', 'dent')) return { keep: true, reason: 'title: dent' };
```

### Exclude personal folders

```typescript
const PERSONAL_FOLDERS = ['family', 'therapy', '1:1 with partner'];
const folders = (note.folder_membership ?? []).map(f => f.name.toLowerCase());
for (const p of PERSONAL_FOLDERS) {
  if (folders.includes(p)) return { keep: false, reason: `excluded: folder ${p}` };
}
```

### Exclude personal-domain attendees

If a family member's email appears, drop the meeting even if it has other org signal:

```typescript
const PERSONAL_DOMAINS = ['spouse.example.com', 'family.example'];
if (emails.some(e => PERSONAL_DOMAINS.some(d => e.endsWith(`@${d}`)))) {
  return { keep: false, reason: 'excluded: personal attendee' };
}
```

## Skeleton

The setup skill should generate roughly this shape, customizing the constants:

```typescript
import type { Note, FilterResult } from '../types.ts';

export const RECIPE_VERSION = 1;

// ─── Customize these ────────────────────────────────────────────────────
const ORG_FOLDERS   = ['Dent'];
const ORG_DOMAINS   = ['example.com'];
const ORG_KEYWORDS  = ['dent'];

const EXCLUDE_FOLDERS  = [/* personal Granola folders */];
const EXCLUDE_DOMAINS  = [/* personal-contact email domains */];
const EXCLUDE_KEYWORDS = [/* titles to always skip, e.g. "therapy" */];
// ────────────────────────────────────────────────────────────────────────

export function filter(note: Note): FilterResult {
  // ... excludes first, then includes
}
```

Always run `dent-extensions preview granola-sync` after writing user/filter.ts and before arming. Preview is the verification gate.

## When this contract changes

If a future version of the daemon needs additional fields from the filter (e.g. an `extract(note)` companion, or per-attendee veto), `SUPPORTED_RECIPE_VERSION` in `sync.ts` will be bumped and a migration note will land in `skills/migrations/`. The daemon WARNs on version mismatch but does not refuse to run — your old filter keeps working until you re-run setup.
