# Where we are — 2026-05-03 snapshot

A working notes file Jason can re-read to pick this back up. Not meant
for public distribution — written quickly, captures the state of an
in-progress conversation, names internal decisions. Move to
`~/.dent-brain/` or delete when no longer useful.

> **Underscore-prefixed** so it sorts to the top of the directory listing
> and signals "working notes, not a delivered artifact."

---

## The open question we paused on

**"Do we actually need the dent-specific custom layer, or could we use stock gbrain?"**

This is the foundational question. Everything else is gated on resolving it. The honest answer depends on actual usage pattern, not theoretical architecture.

### Three paths

1. **Stock gbrain only.** Strip out `markdown_append_to_page`, `markdown_replace_page`, `detect_entities`, all `/dent-*` skills. Use upstream skills (`enrich`, `meeting-ingestion`, etc.). Writes go to Postgres. Markdown round-trip is manual (`gbrain export` + git commit). Works for single-user use; eventual consistency for multi-user.
2. **Stock gbrain + a cron.** Same as 1, plus a Railway cron that runs `gbrain export` + `git push` every hour (or whatever cadence). Markdown round-trips automatically but with ~1hr lag. Cheaper than 3 in custom code.
3. **What we built.** Custom MCP ops (`markdown_append_to_page`, `markdown_replace_page`) that write directly to disk → commit → push → re-index in seconds. ~150 LOC of glue + 6 dent-specific skills. Real-time multi-writer convergence. Today's state.

### Which path matches reality?

The decision turns on **how fast does Steve need to see Jason's writes (and vice versa) in his own Cowork session?**

- **Days/weeks:** path 1.
- **Hours:** path 2.
- **Seconds-to-minutes:** path 3.

PLAN v2.0 assumed seconds-to-minutes without explicit validation. Worth gut-checking against actual workflow before committing further.

If you're not sure: path 2 is the lowest-risk middle ground. Strip the dent-specific layer, set up a cron, accept the lag. Add path-3 layer back if/when latency actually bites.

---

## What's currently shipped (master @ public, v0.31.0)

| Phase | Version | Status | What |
|---|---|---|---|
| 1 | v0.26.0 | merged + deployed | `markdown_append_to_page` + `markdown_replace_page` MCP ops; boot-time clone of `dent-brain-data`; integration tests; gate test passed. |
| 2 | v0.27.0 | merged + deployed | Dent migration v3 dropped `evidence` table; 4 evidence ops removed; 3 skills retargeted to write through the new ops; mandated section scaffolds removed; 13 new contract-test assertions. |
| 3 | v0.28.0 | merged + deployed | TEAMMATE_GUIDE.md (clone + hand-edit workflow); `/dent-onboard-teammate` Phase 9. |
| 4 | v0.28.0 | merged + deployed | Server-side scheduled `git pull --ff-only` + `performSync` every 5 min via `src/dent/markdown-writer/cron.ts`; verified end-to-end (push at 00:51:20 → indexed at 00:53:27 = ~2min). |
| 2.5 | v0.29.0 | merged | First plugin build script (freeform `~/.claude/skills/dent-*` install). Worked for Code mode, NOT Cowork. |
| 2.5b | v0.30.0 | merged | Plugin build now produces a real Claude Code marketplace at `plugin/dist/`. `claude plugin install dent-brain@dent-brain` works. Still didn't help Cowork (Cowork pulls from GitHub, not local paths). |
| 2.5c | v0.31.0 | merged | Top-level `.claude-plugin/marketplace.json` + committed `plugin/marketplace/`. `bun run setup` interactive bootstrap for forks. `/dent-setup` and `/dent-add-ingestor` skills. `docs/dent-brain/SETUP.md`. Slash command name fix. Plugin name parameterized. |
| privacy | (unversioned commit) | merged | Dent-internal docs moved to `~/.dent-brain/` private archive. Real names scrubbed from public files. CREDIT.md keeps Steve Broback as author attribution (intentional, like Garry Tan for upstream gbrain). |

**Repo flipped to public** by Jason on 2026-05-03 after the privacy scrub.

---

## What we never tested end-to-end

**The v2.0 thesis test via Cowork.** All four phases above were verified server-side. The Cowork plugin install + `/dent-append-evidence` round-trip was never actually executed by a user.

To run when ready (~5 min):

1. Open Cowork, fully Cmd+Q first if Claude Desktop is already running.
2. Relaunch Claude Desktop, open a fresh Cowork chat.
3. Ask Cowork: *"Add a custom marketplace from `github:jasonp/dent-brain` and install the `dent-brain` plugin."*
4. Cowork's `cowork-plugin-management` skill should walk through it. Cmd+Q + relaunch + new chat after install.
5. Try `/` autocomplete — should show `/dent-append-evidence`, `/dent-enrich`, `/dent-resolve-entity`, `/dent-onboard-teammate`, `/dent-setup`, `/dent-add-ingestor`.
6. Run: `/dent-append-evidence remember that the founder confirmed the 2026 conference dates in our 1:1`
7. Verify in shell:
   ```bash
   cd ~/gh/dent-brain-data && git fetch origin master && git log origin/master --pretty="%h %an %s" -3
   ```
   Top row should be a commit by `dent-brain-server <noreply@dentthefuture.com>`.

If that round-trips: v2.0 thesis is validated end-to-end. The custom layer demonstrably works.

If it fails: the failure mode + Cowork's error message tell us what's actually wrong (could be Cowork-side plugin install UX, could be skill prose issue, could be MCP connector token mismatch).

---

## What's stashed for later

### Phase 5.1: RegFox polling ingestor

Plan stashed at `~/.dent-brain/PLAN_phase5.1_regfox.md`. Read this before resuming. Highlights:

- Polling not webhooks (cleaner: no HMAC, no inbound HTTP route, natural idempotency via cursor).
- Cursor: `greaterThanId` per-form in a new `regfox_ingest_state` Postgres table (dent migration v4).
- Email-based dedup against FileMaker via a NEW server-side FM read client. **This expands the trust model:** dent-brain server gets a service-level FM credential (READ-ONLY privilege set, separate from per-user stdio).
- Stub frontmatter rich (filemaker_record_id, regfox_registrant_id, regfox_form_id, email, created_via, updated).
- Bullet content includes price + discount code (best-effort path search; configurable env var override).
- Conservative skip-on-no-FM-match → write to `<data-repo>/_ingest/pending_regfox.md` for human review.
- ~1,400 LOC total (FM client is reusable substrate for future ingestors: Gmail, Granola, etc.).

**Blocking on Steve:** new FM service account `mcp_ingestor` with READ-ONLY privilege set + the People-layout email field schema. Until those land, can write 80% of the code against fixtures.

**Whether to ship Phase 5.1 at all** depends on the foundational question above. If we keep the dent-specific layer, RegFox ingestor is the natural next step. If we strip down to stock gbrain, the equivalent would be a `meeting-ingestion`-style skill that an agent-driven cron triggers, calling `put_page` against the brain — different shape entirely.

### Dropbox A55 folder

Found at `~/Library/CloudStorage/Dropbox/A00 Dent/DENT/A50 - A59 Marketing/A55 Claude CRM`.

2.4 MB total, 308 files, 86 folders. Mix of: 95 markdown files, 116 PDFs, 34 CSVs, 31 XLSX, 9 .eml emails. Top-level subdirs: `Attendees/`, `Customers/`, `Geography/`, `Mailchimp/`, `MailerLite Campaigns/`, `Meeting Transcripts/`, `Outreach/`, `Payments/`, `Priorities/`, `Profiles/`, `Projects/`, `Sales Pipelines/`, `Dent 2026 SF26 CRM/`. Plus `INDEX.json` (120KB) and `CONTEXT.json` (15KB) suggesting a prior agent-driven setup.

**Bulk import would be Phase 5.2** — a heterogeneous content set, each type (transcripts, CSVs, emails, PDFs) needing its own translator. Larger and more design-heavy than RegFox. Stock gbrain has `archive-crawler` and `media-ingest` skills that handle some of this — worth comparing what they'd produce against what we'd want.

### Cowork plugin install verification

Pending Jason actually running the steps in §"What we never tested end-to-end" above.

---

## File-system map of where the bodies are

```
~/gh/dent-brain/                    public, master at v0.31.0
  scripts/
    setup.ts                        bun run setup — interactive fork bootstrap
    build-plugin.ts                 bun run build:plugin — regenerates marketplace
  src/dent/                         the custom layer (~1,500 LOC)
  skills/dent/                      6 skills (setup, append-evidence, enrich, resolve-entity, onboard-teammate, add-ingestor)
  plugin/marketplace/               committed Cowork-installable plugin
  .claude-plugin/marketplace.json   top-level marketplace declaration
  docs/dent-brain/
    SETUP.md                        admin walkthrough (10 steps + TL;DR)
    DEPLOY.md                       Supabase + Railway specifics
    TEAMMATE_GUIDE.md               mode 2 hand-edit clone path
    UPSTREAM_NOTES.md               gbrain quirks we know about

~/.dent-brain/                      private archive (Dent-internal, never ships)
  DENT_BRAIN.md                     overview that used to live in repo root
  PLAN.md                           v1.x eng-cleared MVP plan
  PLAN_AUDIT_TRAIL.md               v1→v2 supersedes audit
  PLAN_v2_MARKDOWN_CANONICAL.md     the v2 pivot doc
  PLAN_phase5.1_regfox.md           the RegFox ingestor design (stashed)
  TESTS_phase0_auth_surfaces.md     Phase 0 debug log
  reference/                        FileMaker schema screenshots
  design-history/                   pre-MVP exploration docs (v0.7-1.1)

~/gh/dent-brain-data/               separate private repo
  entities/people/founder.md        seed entity (renamed from steve-broback in privacy scrub)
  entities/people/test-phase1.md    artifact from Phase 1 gate test
  ...
```

---

## Decisions still open / pending

1. **Foundational: do we keep the custom layer?** (Path 1 / 2 / 3 above.) Resolved by gut-checking actual cross-teammate latency requirement. NEEDS JASON.
2. **If we keep the custom layer:** Cowork plugin install verification. Run the 7-step test in §"What we never tested end-to-end." NEEDS JASON.
3. **Phase 5.1 RegFox:** depends on (1). If yes, also blocked on Steve creating `mcp_ingestor` FM service account + sharing People-layout email field schema.
4. **Phase 5.2 Dropbox A55 bulk import:** depends on (1) and on whether stock gbrain's `archive-crawler` + `media-ingest` already cover enough.
5. **(Lower priority) Upstream PR for `markdown_append_to_page`:** Jason said no for now, declined.

---

## How to resume

1. Read this file first. The 3-path framework in §"Three paths" is the load-bearing decision.
2. Read `~/.dent-brain/PLAN_v2_MARKDOWN_CANONICAL.md` for the original architecture context.
3. Decide on path 1, 2, or 3 based on actual cross-teammate latency need.
4. If path 3: run the Cowork plugin install verification. Then RegFox ingestor (Phase 5.1).
5. If path 2: write a `gbrain export + git push` cron, strip out the dent-specific MCP ops, deprecate the dent-specific skills (let teammates use upstream `enrich`, `meeting-ingestion`, etc.). ~1 day of work to undo.
6. If path 1: same as 2 but no cron. Even less code.

---

*Generated 2026-05-03 by the Claude Code session that built v0.26 → v0.31. Saved as a checkpoint when Jason said "I have trouble keeping all this in my head" and asked to pause.*
