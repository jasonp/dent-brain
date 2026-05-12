---
name: {{prefix}}-process-inbox
version: 0.1.0
description: |
  Layer 2 of the email pipeline. Reads unprocessed inbox digest pages
  written by the email-sync collector, walks each Triage entry, finds
  or resolves the other party (the non-self person on the email),
  appends a timeline bullet to that entity's page, then marks the
  digest `processed: true`.

  **Runtime: Cowork scheduled routine** (daily, Sonnet). Runs server-side
  on Anthropic's infrastructure so it fires regardless of whether the
  teammate's laptop is awake or the Desktop app is open. Calls dent-brain
  MCP for page operations and fm-mcp for FileMaker entity resolution —
  both reachable from Cowork. See `docs/reference/runtime-conventions.md`
  for the Code-Desktop-vs-Cowork surface convention.

  The brain is the queue: Layer 1 (laptop daemon) writes digests at
  `inbox/<email-slug>/<YYYY-MM-DD>.md`; this skill reads them, enriches,
  and stamps them processed. If a run is missed for several days, the
  next run catches up automatically by processing every unprocessed
  digest in chronological order.
triggers:
  - "dent-process-inbox"
  - "process inbox"
  - "ingest emails"
  - "enrich email digests"
tools:
  - query
  - get_page
  - list_pages
  - markdown_append_to_page
  - markdown_replace_page
  - detect_entities
  - fm_find_records
  - fm_get_record
mutating: true
writes_pages: true
writes_to:
  - entities/people/
  - entities/companies/
  - inbox/
---

# /dent-process-inbox

Daily enricher for the email pipeline. Reads the digest pages produced
by `tools/email-sync/collect.ts` (Layer 1) and translates each
**Triage** entry into a timeline bullet on the relevant entity's page.
Marks digests processed via frontmatter so re-runs don't double-write.

> **Read first:** `skills/_brain-filing-rules.md` (entity slug shape +
> filing conventions) and `skills/conventions/quality.md` (citation rules).
> The bullet format below MUST include a `[Source: gmail/<message-id>]`
> marker — this is the idempotency key. Never strip it.

## When this fires

Registered as a Claude Code Desktop scheduled task on Sonnet, daily at
off-peak hours (default 03:00 local). The skill body lives at
`~/.dent-brain/skills/process-inbox.md` after install; the scheduled
task's instructions are simply "Read that file and follow the
instructions exactly." On each run:

1. Find every digest page where `processed: false` in frontmatter.
2. Process them oldest-first, one at a time.
3. If the run hits a per-run cap (50 digests), stop and let the next
   run pick up. This keeps cost bounded if the laptop has been off for
   a long time.

Manual invocation is fine too — useful when debugging or when you want
to force a re-process after fixing an entity slug.

## Read order

You receive no arguments — discover everything via the brain.

1. `query` for inbox digests:
   ```
   query(query: "type:inbox-digest processed:false", limit: 50)
   ```
   If the query op doesn't support frontmatter filters directly, fall
   back to `list_pages` with prefix `inbox/` and filter client-side on
   the `processed` field of each page's frontmatter (read via
   `get_page`).

2. Sort digests by `digest_date` ascending. Process oldest first so
   bullets land on entity timelines in chronological order.

## Iron rule: process strictly serially

**Do NOT parallelize tool calls.** The dent-brain MCP enforces a 30
writes/min per-token rate limit — any concurrent salvo of
`markdown_append_to_page` calls will trip it and abort the whole run
mid-flight, leaving partial writes and an unstamped digest. This is
not advisory.

Concrete shape: walk Triage entries one at a time. For each entry,
finish every step (resolve, get_page existing target, scan for source
marker, append, log) before starting the next entry. Never batch
multiple `markdown_append_to_page` calls into a single turn. If the
model is tempted to "parallelize for efficiency" — DON'T. The cost is
a failed run.

The 30/min cap is generous enough that a serial run of 50 digests ×
~20 bullets each finishes well inside the budget. Latency budget is
fine; correctness budget is not.

## Per-digest processing

For each unprocessed digest:

1. **Read it.** `get_page(slug: "inbox/<email-slug>/<YYYY-MM-DD>")`.
   The body has three sections; you only act on `## Triage`. Ignore
   `## Signatures` (that's a human-action queue) and `## Noise` (audit
   only).

2. **Parse the Triage section.** Each entry is a structured bullet
   list. Extract for each:
   - the timestamp (the `**HH:MMZ**` heading)
   - the direction marker (`→` outbound, `←` inbound)
   - the **From** display + bare email
   - the **To** / **From → to** recipients list
   - the **Subject**
   - the **Snippet** (used for tie-breaking on entity resolution, never as
     a primary signal)
   - the **Source** marker — the `gmail/<message-id>` value goes into the
     bullet's idempotency tag verbatim
   - the **Link** — preserve the existing Gmail URL exactly, do not
     rebuild it

3. **Pick the "other party"** — the entity the bullet should land on.

   - For **inbound** (`←`): the other party is the **sender**.
   - For **outbound** (`→`): the other party is each non-self recipient.
     A single email may produce bullets on multiple entity pages.
   - The teammate's own page is NEVER the target. Their participation
     is implicit (it's their email account that's syncing).

4. **Resolve the other party to an entity slug.**

   a. `query` the brain for the bare email address:
      `query(query: "<other-party-email>", limit: 5)`. If a person or
      company page surfaces with that email in frontmatter, use that slug.

   b. If no email match, query the display name (when present). Take
      a high-confidence match (`exact-title` or `alias` rule from the
      detect_entities semantics) only.

   c. **If no brain match,** call `fm_find_records` against the FM
      People layout for the display name (or the email's local-part
      treated as a name candidate). Apply the **A5 escalation rule**
      from `/dent-append-evidence`:
      - **0 matches** in FM: skip this entry. Add it to a per-run
        `unresolved` list. Do NOT auto-stub from email metadata alone —
        a single email is too thin to seed a person page.
      - **1 match** in FM: create a stub entity page via
        `markdown_replace_page` with `filemaker_record_id` in
        frontmatter, then proceed with the bullet append.
      - **2+ matches** in FM: skip this entry. Don't auto-link to an
        ambiguous candidate. Log to `unresolved`.

   d. For company-shaped emails (no individual sender — e.g.
      `support@acme.com` after the noise filter let it through), prefer
      the **Companies** layout in step (c).

5. **Append the timeline bullet** with `markdown_append_to_page` under
   the `## Timeline` section of the resolved entity page. **One call.
   Await it. Do not pipeline multiple appends across entries.**

   ```text
   - YYYY-MM-DD: emailed re: "<subject>" ([Open in Gmail](<gmail-link>)) [Source: gmail/<message-id>]
   ```

   Bullet shape rules:
   - Date is the email's calendar date (UTC), not today.
   - Subject in straight quotes, escape any embedded quotes.
   - Gmail link preserved verbatim — never rebuild from the message id.
   - The `[Source: gmail/<message-id>]` tag is the idempotency key.
     `markdown_append_to_page` does NOT dedupe these automatically;
     before appending, `get_page` the entity, scan for the same
     `gmail/<message-id>` substring, skip if already present.

6. **Outbound emails to multiple recipients:** loop step 4–5 once per
   non-self recipient. The same `[Source: gmail/<id>]` may appear on
   N entity pages (one per recipient); that's correct.

## After processing the digest

After every Triage entry has been handled (appended, skipped as
unresolved, or skipped as already-present):

1. `markdown_replace_page` the digest with `processed: true` plus a
   processing summary block at the bottom:

   ```markdown
   ## Processing log

   - Run: {ISO timestamp}
   - Triage entries: {N}
   - Bullets appended: {M}
   - Skipped (already processed): {K}
   - Unresolved (no brain or FM match): {U}
     - {if any} list each: `- <email-or-name> — <subject>`
   ```

   The frontmatter `processed: true` flag is the gate that stops the
   next run from re-handling this digest. The processing log is
   audit-only.

2. Move on to the next unprocessed digest.

## After processing all digests — write the unresolved sweep page

If `unresolved` is non-empty, write a single sweep page via
`markdown_replace_page`:

```
slug:    inbox/unresolved/<YYYY-MM-DD>     (today's date, UTC)
content:
---
type: inbox-unresolved
created_via: dent-process-inbox
date: YYYY-MM-DD
count: <N>
---

# Unresolved entries — YYYY-MM-DD

The 3am cron found these emails but couldn't resolve the other party
to a brain entity. They need a human pass with FileMaker access.

To resolve: open this page in Claude Code, where you have FM MCP. For
each bullet below, run `/dent-append-evidence` against it — that skill
applies the A5 escalation rule (0/1/2+ FM matches) properly and
appends the bullet to the right entity if FM has a hit.

## Entries

- {date} {direction} {other-party-display} <{other-party-email}> re: "{subject}" ([Open in Gmail]({gmail-link})) [Source: gmail/{message-id}]
- ...
```

The unresolved page is itself idempotent — re-running this skill on the
same day overwrites it, so a partially-swept page can be regenerated by
re-running the cron.

## Per-run output

After all digests (or hitting the 50 cap):

```text
PROCESS-INBOX SUMMARY
═══════════════════════════════════════════════════════════
  Digests processed: N
  Bullets appended:  M
  Stubs created:     S (linked to FM)
  Skipped (dupes):   K
  Unresolved:        U
─────────────────────────────────────────────────────────
  {if U > 0}
  Unresolved entries (no brain or FM match — review manually):
    - {date} {email-or-name} re: <subject>
═══════════════════════════════════════════════════════════
```

## Anti-patterns

- **Don't read raw email bodies.** Layer 1's whole point is keeping
  email content out of LLM context. The Triage section gives you
  subject + snippet + sender + recipients — that's enough to resolve
  entities. If you find yourself wanting more, the body is in Gmail;
  follow the link.
- **Don't auto-stub from email metadata alone.** A single sender email
  is too thin to seed an entity page. FM is the gate. Without an FM
  match, log to `unresolved` and let the human decide.
- **Don't forget the source marker.** Every bullet needs
  `[Source: gmail/<message-id>]` or re-runs will double-write.
- **Don't process digests out of order.** Oldest-first keeps timeline
  bullets in chronological order on entity pages, which matters when
  the timeline gets read back.
- **Don't process more than 50 digests in one run.** If the user's
  laptop was off for a month, that's potentially 30 digests; cap at 50
  and let the next run catch up. Cost control + context-window safety.
- **Don't run if there are no unprocessed digests.** Exit cleanly with
  `PROCESS-INBOX SUMMARY: 0 digests` — Sonnet runs aren't free.

## Failure modes

- **Digest page malformed (parsing fails on Triage section):**
  log the slug, append a `processing_error: <message>` field to the
  digest's frontmatter, leave `processed: false`, continue to the next
  digest. Don't loop forever on one bad page.
- **`markdown_append_to_page` rate-limited:** the dent-brain MCP server
  enforces 30 writes/min per token. Pace appends — if you catch a 429,
  back off 60 seconds and retry. Don't burn the run on a hot loop.
- **FM MCP unavailable:** skip FM resolution for this run (treat every
  unknown as `unresolved`). Note it in the summary. Try again tomorrow.
