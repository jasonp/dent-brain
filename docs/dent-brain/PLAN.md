# Dent Brain MVP — design plan

**Status:** Phase 0, 0.5, 1, 2 complete. Substrate at gbrain v0.25.0
(merged 2026-05-01). Phase 3 reshaped to skill-only `/dent-enrich`.
Plugin/tool repo: `github.com/jasonp/dent-brain` (Jason's account, OSS-shape).
Data repo: `github.com/dentthefuture/dent-brain-data` (private, Dent-owned).
FM MCP author: Steve Broback (vendored at `plugin/fm-mcp/`).
First user: Steve Broback. Mode: intrapreneurship.

> **Audit trail:** retired decisions, prior changelog versions (v0.9 → v1.7),
> design archaeology, and old phase specs live in `PLAN_AUDIT_TRAIL.md`. This
> file is the active design surface only.

---

## Where we are now (v1.8, 2026-05-01)

Phase 0, 0.5, 1, 2 complete. Production Supabase live with `dent_version=1`.
Substrate just upgraded gbrain v0.16.0 → v0.25.0 (39 upstream commits absorbed,
3496 unit tests green). Phase 3 reshaped from "build a server-side materializer"
to "fork gbrain's `enrich` skill with FM-injection + FM-wins + merge-on-rerun"
— Cowork-side, subscription-funded, 1-2 day phase instead of 1-2 weeks.

**Option B retrofit (DONE 2026-05-01):** `src/dent/server/http-mcp.ts` deleted
in favor of upstream's `src/mcp/http-transport.ts` (v0.22.7). `evidence.author`
column dropped via dent migration v2 (per-row attribution now comes from the
`mcp_request_log` join). The 4 dent ops were refactored to plain
`OperationContext` and registered alongside upstream's operations array via the
new `src/dent/serve.ts` entry. Railway redeployed (`bun run src/dent/serve.ts`),
`/health` 200, `dent_version=2`, 4 dent ops live. Next: Phase 3 implementation.

**Withdrawn this revision (v1.8):** the entire materializer pipeline — A1 (queue
+ debounce), A8 (prompt versioning), A10 (snapshot table), CQ2 (structural
validator), CQ3 (flag-fact fuzzy match), CQ7 (cost watchdog), the five-section
page structure contract, mechanical-corroboration hardening path, the
`/dent-flag-fact` skill + `correction_log` table. With FM-as-truth and free-form
LLM synthesis, none of these earn their keep.

> Full v1.8 narrative + all prior changelog entries (v0.9 → v1.7) live in
> `PLAN_AUDIT_TRAIL.md`.

---

## Eng-Review Decisions (active subset)

These are binding for the build phase. Withdrawn decisions (A1, A8, A10,
CQ2, CQ3, CQ7) are archived in `PLAN_AUDIT_TRAIL.md` with original specs
and v1.8 retirement notes.

### Architecture

**A2. Evidence schema: GIN index on `entity_refs`.** `CREATE INDEX
evidence_entity_refs_gin ON evidence USING GIN (entity_refs)`. Non-negotiable
for query performance.

**A3. Audit log fields spec.** Every MCP call writes: `(timestamp, user_id,
tool_name, args_redacted, result_code, latency_ms, session_id, cost_usd)`.
Bearer tokens and PII redacted from args. *Now satisfied by upstream's
`mcp_request_log` (v4 schema) wired in via the v0.22.7 HTTP transport.*

**A4. Plugin update mechanism.** Ship `/update-dent-brain` convenience skill
that re-fetches the plugin bundle from `jasonp/dent-brain` at a pinned
version. Document in `INSTALL.md`.

**A5. Entity disambiguation: name-first with FM escalation.** Name-based
matching is the default. Escalation rule: if `fm_find_records` on the
`People` layout returns 2+ records with identical `Full_Name` but different
`PK_People_ID`, require email match from observation context. If no email
available, flag for Steve manual resolve via `/resolve-entity` skill.
Secondary emails per FM person are handled by the Data API — email is a
lookup key, `PK_People_ID` is identity.

**A6. Signal-detector feasibility (RESOLVED — Phase 6 reshape).** The 1-hour
spike confirmed Cowork's deferred-tools model kills passive per-message
invocation. Phase 6 reshaped to amplification inside `/dent-append-evidence`
+ session-start digest (v1) instead. See Phase 6 section below.

**A7. Plugin install path — verified in v1.1.** Jason successfully installed
Steve's FM MCP locally, and Cowork surfaces `claude_desktop_config.json`-
registered MCPs alongside HTTP connectors. De-risk complete. Remaining
verification: confirm two different users' FM credentials (different
`mcp_<user>` accounts) work simultaneously in the same Cowork shared
session — done during Jeff onboarding (post-MVP).

**A9. FM-Dent Brain conflict resolution: FM wins, with staleness surfacing.**
The `/dent-enrich` prompt gets a "FM-as-truth" rule: FM is authoritative
for owned fields (name, email, current employer, registrations, payments,
tags). If Dent Brain evidence is newer than FM's `ModificationTimestamp`
AND conflicts with FM, the synthesized page reflects FM but notes the
discrepancy inline. Steve manually updates FM when the conflict is real
staleness. *(Reshaped from the v1.0 "## Conflicts section" pattern; v1.8
removed the section structure.)*

### Code Quality

**CQ1. Entity detection as a standalone service.** Single module
`src/entity-detection/` with one public API: `detectEntities(text, context)
→ {matches: [{slug, fm_id, confidence, rule}], unknowns: [string]}`. Used
by `/append-evidence`, Dropbox importer, and FM-linking pass. No duplication.

**CQ4. FM MCP client wrapper.** All FM calls from Dent Brain skills go
through `src/federation/fm-client.ts` — logs latency, errors, call counts
per session. Required for P1 performance monitoring.

**CQ5. Error taxonomy.** Documented in Phase 1 in
`~/gh/dent-brain-data/docs/ERROR_TAXONOMY.md` (private repo). Active codes:
`evidence_not_found`, `evidence_entity_unknown`, `entity_not_found`,
`fm_unreachable`, `rate_limited`. *Note: `auth_invalid` was removed in the
Option B retrofit (2026-05-01) — no more author column. `materializer_failed`
also retired with the materializer pipeline.*

**CQ6. Classifier strategy: rules-first with LLM fallback.** Filename +
folder location rules catch ~80% of files. Unmatched files → Claude
classification call. Classifier output always includes the rule that
matched (or "llm-fallback"), making tuning debuggable.

### Performance

**P1. FM fan-out cache (conditional).** If Phase 0.5 latency timing reveals
>5s on UC2/UC4 fan-out queries, add session-scoped in-memory cache keyed by
`(fm_table, fm_record_id)`, 60s TTL. Not MVP unless needed.

**P2. Signal-detector hot path.** Trigger list (entity names + FM tags +
DENT_SCHEMA triggers) fetched once per `/dent-append-evidence` invocation.
Server endpoint returns versioned list; client checks version. Never
per-message.

**P3. Git archive (v1): only-changed-entities filter.** When git archive
lands in v1, filter commits to entities modified since last snapshot.
Avoid empty commits.

---

## Problem Statement

v0.7 was architecturally sound but sized for an 11-phase build before any
team member touched the system. Steve Broback is available to alpha now.
The primary risk is **team adoption**, not architecture — the plan needs
to get a real user doing real work as fast as possible. MVP keeps the core
value prop of v0.7 (compiled entity pages, not raw timelines) and cuts
the parts that don't need to exist before Steve validates the shape.

**On hallucination risk (v1.8 update):** with FM-as-truth and free-form
LLM synthesis on the Dent Brain side, Steve's correction loop is hand-edit
+ `quarantine_batch`. The skill's merge-on-rerun preserves edits between
synthesis runs. No formal claim contract; we trust the LLM and accept that
the value of compiled entity pages outweighs the residual risk of imperfect
synthesis on the unstructured-evidence side.

## Demand Evidence

- Steve is the first confirmed test user and will do real Dent work against
  the MVP.
- The Dent team already maintains a shared Dropbox folder. The historical
  corpus is the real test of the ingest + entity-detection pipeline.
- The core team already works in Claude Cowork daily.
- Jason's OpenClaw Dent agent is an existing cron-scheduled consumer;
  service-token access against the same MCP endpoint is a solved shape.

## Status Quo

Dent's knowledge currently lives in:
- A shared Dropbox folder that the team appends to but nobody queries as
  a corpus.
- Gmail threads scoped to each team member's inbox with no shared view.
- Meeting notes in Granola, per-user, non-shared.
- Team memory distributed across six heads.

The cost of the status quo is visible every time the team asks "did we
already pitch X?", "what did Mike say last month?", or "who's been talking
to LeadingAgile."

## Target User & Narrowest Wedge

**Target user for MVP:** Steve Broback. One person. Admin-tier access.
Someone who already cares enough about Dent operations to tolerate rough
edges and give useful feedback.

**Narrowest wedge:** Steve can (a) search and read compiled entity pages
built from the Dropbox historical import, (b) in his Cowork sessions, get
proactive suggestions to `/dent-append-evidence` on new observations, and
(c) re-run `/dent-enrich` when a page feels stale — the skill merges new
evidence with his hand-edits without clobbering them. The test: after one
week of use, does Steve ask "when can Jeff get on this?"

## Constraints

- Zero terminal for non-technical installs.
- Cowork as primary interface. Scheduled tasks caveat is accepted.
- gbrain as substrate, not fork target. All MVP code sits as layers above
  gbrain (under `src/dent/`, `skills/dent/`, `plugin/`). Upstream pulls
  from `garrytan/gbrain` stay clean.
- @dentthefuture.com identities only.
- Monthly cost ≤ 0 for MVP infra (Railway + Supabase + existing Dropbox/
  Granola/email).

## Premises

1. **The evidence-log-first architecture is correct.** Append-only evidence
   records with typed entity views solve the multi-writer, imports-blow-up-
   mutable-designs, compiled-truth-hides-uncertainty problems.
2. **Compiled truth ships in MVP via `/dent-enrich`.** Cowork-side, agent-
   orchestrated, on Claude subscription. FM is truth for owned fields;
   evidence is truth for unstructured observations. (Updated v1.8.)
3. **Steve is enough to validate MVP.** One real user doing real Dent work
   is worth more than 11 phases of machinery.
4. **`/dent-append-evidence` is core.** Asking users to remember to invoke
   a skill is a losing pattern. The skill's amplification scan (Phase 6)
   makes one explicit invocation a multi-append opportunity.
5. **Bulk Dropbox import must happen before MVP ships to Steve.** An empty
   brain is not testable.

---

## FileMaker Federation

The Dent team has an existing FileMaker database (`DentCRM2025` on
`sea-17.fmsdb.com`) that is the canonical source of structured CRM data.
Steve Broback built a custom Node.js MCP server (~395 lines, stdio
transport, 7 tools) that connects via the FileMaker Data API. The server
lives at `_reference/FMP Connector/FileMaker MCP/` in this project and is
adopted into the plugin bundle at `plugin/fm-mcp/`.

### Steve's MCP server — tools (7)

- `fm_ping` — auth sanity check
- `fm_list_layouts` — enumerate layouts visible to the calling account
- `fm_get_layout_fields` — field names, types, related-table structure
- `fm_list_scripts` — list scripts (does NOT execute)
- `fm_find_records` — compound find with FM native syntax
- `fm_get_record` — fetch one record by `recordId`
- `fm_create_record` — only write tool today; audit fields auto-populate
  (`CreatedBy`, `CreationTimestamp`, `ModificationTimestamp`, `ModifiedBy`,
  `PrimaryKey`)

47 layouts enumerated and organized: People/Contacts Core, Campaigns/
Outreach, Registrations, External Data Sources, Admin/System.

### Per-user FM auth

Each team member gets their own FM account with the `MCP Read And Edit
Records` privilege set: `mcp_steve`, `mcp_jason`, `mcp_jeff`, etc. Each
account's password is stored in that user's `claude_desktop_config.json`
(`FM_PASSWORD` env var). Every FM query/write is audited under the calling
account. **FM's `CreatedBy`, `ModifiedBy`, and modification timestamps
become the per-user provenance layer Dent Brain gets for free.**

### Transport: stdio, not HTTP

Steve's server uses `StdioServerTransport`. It runs locally on each team
member's Mac as a subprocess of Claude Desktop, wired in via
`claude_desktop_config.json`. Claude Desktop surfaces the `fm_*` tools in
both solo chats and Cowork sessions.

This means Dent Brain's architecture is hybrid:
- **Dent Brain = shared state** (Postgres evidence, audit log) → centralized
  HTTP service on Railway.
- **FM MCP = per-user auth, no shared state** → local stdio, installed
  per-Mac.

### What lives where

| Data | Authoritative source |
|---|---|
| Person identity (name, email, LinkedIn, company, address, comm prefs) | **FileMaker — `People` table** |
| Tags / topical interests per person | **FileMaker — `Tags` + `Tags People`** |
| Conference registration history | **FileMaker — `Event Registration`, `Past Registrations`, `Past Conf People`** |
| Hotel registrations + room nights | **FileMaker — `Hotel Registrations`, `NightStays`** |
| Payments / purchases | **FileMaker — `HR Purchases`, `RHR Purchases`, `Purchase MP`** |
| Outbound communications log | **FileMaker — `Communication Items`, `Email Items`, `Email Stats`** |
| Historical CRM notes | **FileMaker — `Notes Q`, `Sticky Notes`** |
| Meeting notes, email threads, observations | **Dent Brain — evidence log** |
| Synthesized entity pages (free-form, FM-aware) | **Dent Brain — `pages` table + dent-brain-data git repo** |
| Speaker pipeline narrative, session planning, retros | **Dent Brain — namespace pages** |

### The federation pattern (lazy reads, no proxy)

We do NOT import FileMaker into Dent Brain. Importing creates a stale-cache
problem: registrations, payments, and tags change in FM constantly.

Instead:
- **Each Dent Brain user installs both MCP connectors in Cowork**: Dent
  Brain (HTTP) + FileMaker (Steve's stdio). Skills call both.
- **Entity pages reference FM IDs.** A person entity page header includes
  `filemaker_record_id: 12345` in frontmatter. `/dent-enrich` reads it
  and fetches the FM record live.
- **Read-time enrichment.** When a skill answers a query about a person,
  it fetches the FM record, combines with Dent Brain's evidence, and
  answers. The user sees one merged view.
- **MVP: read-only against FM.** Capability is verified; v1 reconsiders.

### Write boundary (revisit in v1)

**MVP: read-only.** No Dent Brain writes to any FM layout. v1 will
reconsider with three specific patterns:
1. **Promote-to-FM-People.** One-click "this new person needs a FM People
   record."
2. **Observation scratchpad layout** (`DB_Observations`).
3. **Sticky Notes parity.**

**Not in scope in any version:** writes to `People` core fields,
`Event Registration`, `Past Registrations`, `HR Purchases`, integration-
source layouts.

---

## Canonical Use Cases

These are the queries Steve and the team actually want to make. **UC3 is
fully MVP-deliverable**; the others are v1+ but the architecture must not
preclude them.

### UC1: "What did we tell [attendee] about carrying forward registration?"
Point lookup against a specific person, scoped to a topic. **Status: v1
(after Gmail ingest), not MVP.**

### UC2: "Two paragraphs about Dent community members relevant to someone in Xbox at Microsoft"
Filter People by tags / company / role, surface recent activity. **Status:
fully MVP-deliverable** via federation (Claude in Cowork orchestrates FM
MCP + Dent Brain MCP). The killer use case for fundraising / recruiting.

### UC3: "Summarize the state of the Dent:Blend Austin project"
Entity-page query for a project, materialized from meeting + email evidence.
**Status: fully MVP.** Cleanest validation of `/dent-enrich`'s value.

### UC4: "One of our Denters is in a Hollywood TV series — who should I introduce them to?"
Filter People by Hollywood / TV / film tags, surface their recent context,
let Claude rank fit. **Status: fully MVP-deliverable.**

### UC5: "Initial invite list for our San Diego Comic Con reception"
Compound filter on People — location, tags, past attendance. **Status:
fully MVP-deliverable.**

**What these tell us:**
- **Federation IS the intelligence layer.** With both MCPs installed, Claude
  orchestrates them naturally. Bespoke skills (`/community-match`, etc.)
  become convenience wrappers in v1, not capability adds.
- **The hybrid is the product.** None of the high-value use cases are
  pure-Dent-Brain or pure-FileMaker.
- **UC3 is the safety net.** Pure-Dent-Brain; works regardless of FM
  status.

---

## MVP Scope (v1.8 current)

### IN (ship to Steve)

**Infrastructure**
- Railway deployment using `dbrain serve --http --port $PORT` (upstream's
  v0.22.7 transport) + Supabase (Postgres + pgvector).
- Custom subdomain `dent-brain.dentthefuture.com/mcp` with bearer auth.
- Audit log on every MCP tool call (via upstream's `mcp_request_log`).

**Data**
- Evidence log schema: `(id, source, observed_at, appended_at, content,
  content_hash, entity_refs[], batch_id, quarantined_at, metadata)`. Per-row
  author attribution comes from `mcp_request_log` join. *(Option B retrofit
  drops the `author` column from the original Phase 1 schema.)*
- `dent-brain-data` private repo, initialized with namespace scaffolding
  per `DENT_SCHEMA.md`.
- Seed entity pages for Steve, Jason, Dent itself.

**MCP tools (Dent Brain side)**
- `append_evidence(entity_refs, content, source_type, source_ref?, metadata?)`
- `get_evidence(entity_slug, limit?)`
- `quarantine_batch(batch_id, reason?)`
- `get_provenance(evidence_id)`
- `get_page(slug)` — gbrain native, returns the page including any
  `/dent-enrich`-synthesized content
- `search(query)` — gbrain's existing hybrid RRF
- `whoami()` — gbrain native

**Synthesis (`/dent-enrich`, Cowork-side skill)**
- Forks `skills/enrich/SKILL.md` with FM-injection + FM-wins +
  merge-on-rerun.
- Agent-orchestrated, on Claude subscription. No API spend.
- No queue, no validator, no snapshot table — git history of
  `dent-brain-data` IS the snapshot/revert mechanism.

**FileMaker MCP** — full-featured connector authenticated to `DentCRM2025`.
Read ops only in MVP. Both connectors in each user's Cowork; skills can
call either or both. Dent Brain's server does NOT proxy to FileMaker.

**Ingest**
- `/ingest-dropbox-tree` — bulk import with classification, staged batches,
  `quarantine_batch` for review.
- `/dent-append-evidence` — user-invoked in Cowork, with Phase 6
  amplification scan + Phase 4 timeline-entry write.

**Install**
- Cowork plugin bundle: dual-registration (Code mode HTTP + Cowork stdio
  bridge via `mcp-remote`), FM MCP installer, skills bundle, walkthrough.
- Admin CLI for issuing per-user bearer tokens (`gbrain auth create
  <name>`).

**Steve onboarding**
- Admin token issued.
- Install walkthrough with Jason present.
- First week: Steve uses it for real Dent work, logs friction.

### OUT of MVP (deferred to v1+)

- FM Notes import (Phase 5b), FM daily delta, two-way write to FM.
- Server-side Dropbox cron, Gmail / Granola / RSS ingest.
- Intelligence skills as convenience wrappers (`/recall`, `/community-match`,
  `/who-knows-whom`, `/invite-list`, `/sales-check`, `/prep-speaker`,
  `/session-plan`, `/dent-library`, `/dent-status`, `/evaluate-session`,
  `/marketing-brief`).
- Dream cycle / nightly enrichment, git archive snapshot job, page-level
  ACLs, scraper webhooks, MailerLite, Google Drive, Slack archive.

**Withdrawn entirely (v1.8):** server-side materializer, `rebuild_entity`
op, queue, validator, cost watchdog, `/dent-flag-fact` skill,
`correction_log` table, mechanical-corroboration hardening,
five-section page structure contract. See PLAN_AUDIT_TRAIL.md for
rationale.

---

## Open Questions

1. **FM MCP latency under fan-out.** UC2/UC4 can spawn 10+ FM calls in one
   Cowork turn. Total latency budget: 5s. If we blow this, consider P1
   cache or a Dent Brain proxy tool.
2. **Entity-to-FM linking heuristic.** When `/dent-append-evidence` mentions
   "Mike Cottmeyer," do we auto-link by name+email match (a), suggest and
   confirm (b), or leave unlinked (c)? **MVP default: (b).**
3. **Signal-detector trigger list (used by Phase 6 amplification).** What
   counts as a Dent signal? Seed from DENT_SCHEMA + imported entities + FM
   People + FM Tags; tune with Steve.
4. **Dropbox classification accuracy.** <20% human-correction target. MVP
   must measure on staged import and block ship-to-Steve if classification
   is clearly broken.
5. **`/dent-enrich` synthesis quality.** Track Steve's hand-edit rate from
   day one. >3 pages hand-edited in 2 weeks = signal to tune the prompt.
   (Replaces v1.7's `/flag-fact` rate criterion.)
6. **`/dent-append-evidence` free-text vs structured claims.** Free text
   for MVP is fine. Revisit if synthesis quality needs structured input.
7. **Entity detection on import.** Heuristic: any name appearing in ≥3
   files or any @dentthefuture.com or known-partner email becomes an
   entity. **Cross-reference with FM People before creating** to avoid
   duplicate entities.
8. **v1 write patterns.** Which of the three (promote-to-People, observation
   scratchpad, Sticky Notes parity) does Steve actually want after 2 weeks?
   Ask during end-of-week-2 retro.

---

## Success Criteria (MVP)

MVP is successful if, 2 weeks after ship-to-Steve, all of these are true:

**Adoption**
1. Steve opens Cowork at least 3 times per week and interacts with Dent
   Brain.
2. Steve has triggered `/dent-append-evidence` at least 10 times across
   the two weeks.
3. Steve has queried the brain (search or entity page read) at least 20
   times.
4. **Steve has run at least 3 of the 5 canonical use cases successfully
   and reported each useful.** Required: UC3. Strong recommended: UC2,
   UC4, UC5.
5. **Federation in action:** at least one query Steve runs touches both
   MCPs in a single Cowork turn.

**Correctness**
6. >90% of Steve's `/dent-append-evidence` calls land on the correct
   entity page.
7. Dropbox import produced entity pages for the top 20 expected entities.
8. `/dent-append-evidence` amplification suggestions: >50% accepted or
   ignored-without-annoyance, <50% dismissed as noise.
9. **Synthesis quality acceptable.** Steve qualitatively reports that
   `/dent-enrich`-produced pages are useful and not actively misleading.
   If Steve hand-edits 3+ pages in the 2-week window, that's a signal
   the prompt needs tuning, but the edits themselves are the correction
   loop, not a failure mode.
10. **`/dent-enrich` merge-on-rerun preserves Steve's hand-edits** when
    re-run on a previously enriched page.
11. Zero silent data loss: every evidence record appended is retrievable;
    every `/dent-append-evidence` call either succeeds with an ID returned
    or fails with an explicit error.
12. **Federation links:** at least 10 person entity pages have a confirmed
    `filemaker_record_id`. Steve can ask "what's Mike's company?" and get
    a correct answer from FM via federation.

**Hygiene**
13. Steve can complete the install in under 20 minutes with zero terminal.
14. Jason has not had to write code to fix Steve's environment once setup
    is done.
15. At least one Steve quote worth quoting (good or bad) at the end of
    week 2.

---

## Distribution Plan

- **Plugin/tool repo:** `github.com/jasonp/dent-brain`. Server, plugin
  bundle, skills, install doc.
- **Server:** Railway deployment via `dbrain serve --http`. Auto-deploy
  from GitHub is NOT wired today; pushes to master need a manual
  `railway up --detach`.
- **Data repo:** `github.com/dentthefuture/dent-brain-data`, private,
  Dent-org-owned.
- **Plugin install:** Cowork plugin bundle hosted in `jasonp/dent-brain`
  under `/plugin/`. Dual-registration via `/dent-onboard-teammate` skill.
- **Admin tokens:** issued by Jason via `gbrain auth create <name>`,
  delivered to the user.
- **Service tokens:** issued for OpenClaw agent and (later) server-side
  ingestors.

## Dependencies

- Steve in the room for Phase 0.5 (DONE).
- Supabase project provisioned with pgvector extension (DONE).
- Railway project with custom domain configured (DONE).
- `jasonp/dent-brain` GitHub repo + `dentthefuture/dent-brain-data` private
  repo (DONE).
- Dropbox API token for v1 server-side cron (provisioned).
- Cowork plugin system supports connector URL + bundled skills + multiple
  connectors per session (verified).

---

## Build Plan

**Phase 0 — Substrate and infra (DONE)**, **Phase 0.5 — FileMaker MCP
federation (DONE)**, **Phase 1 — Evidence log core (DONE)**, **Phase 2 —
Namespace + seed entities (DONE)**. Production state:
`https://dent-brain.dentthefuture.com/mcp`, dent_version=2, 4 dent ops
serving via `src/dent/serve.ts`, 24 unit tests green, FM MCP installed
per-user, dent-brain-data repo seeded. Option B retrofit landed 2026-05-01.
*Outstanding: time the 5 UC queries end-to-end and write
`FILEMAKER_FEDERATION.md` to data repo (can run alongside Phase 4).*

**Phase 3 — `/dent-enrich` skill (RESHAPED 2026-05-01, v1.8)**

Fork `skills/enrich/SKILL.md` (gbrain's existing tiered synthesis skill,
agent-orchestrated, subscription-funded) into `skills/dent/enrich/SKILL.md`
with three modifications:

1. **FM injection.** Skill reads `filemaker_record_id` from page
   frontmatter; if present, calls `fm_get_record` via the FM MCP and
   includes the record as authoritative context.
2. **FM-wins prompt rule.** "If FM data and Dent Brain evidence conflict,
   prefer FM. Note the discrepancy inline."
3. **Merge-on-rerun.** Skill reads existing compiled-truth section before
   synthesizing; passes it as "prior synthesis — preserve hand-edits,
   refine with new evidence." Steve's manual edits survive subsequent
   enrich runs.

No new operations. No new tables. No migration. Phase 3 ships purely as a
skill file plus tests.

**Tests in `test/dent/enrich/`:**
- `enrich-fm-injection.test.ts` — FM record fetched + included in
  synthesis context.
- `enrich-fm-wins.test.ts` — synthetic FM-vs-evidence conflict resolves
  to FM with inline note.
- `enrich-merge.test.ts` — hand-edited compiled truth preserved across
  re-run.
- `enrich-empty-evidence.test.ts` — entity with FM record but zero
  evidence renders cleanly.
- `enrich-no-fm.test.ts` — entity without `filemaker_record_id` works
  on evidence alone.

Phase 4 partial bring-forward: `/dent-append-evidence` calls
`add_timeline_entry` on each evidence write so the timeline grows even
when `/dent-enrich` hasn't been run since.

**Gate:** all five enrich tests green. Jason runs `/dent-enrich` against
an entity with hand-edited markdown and observes merge preserves the edit.

> Original Phase 3 spec (server-side materializer with queue / validator /
> snapshot table) is archived in `PLAN_AUDIT_TRAIL.md`.

**Phase 4 — `/dent-append-evidence`, FM linking**
- Entity-detection service (CQ1): `src/entity-detection/` with one public
  API used by `/dent-append-evidence`, Dropbox importer, Phase 6
  amplification.
- `/dent-append-evidence`: calls entity-detection, writes evidence, calls
  `add_timeline_entry`.
- **FM linking (A5):** name-match FM People. 1 match → auto-link. 2+
  matches → email-required (escalate to user). 0 matches → create stub
  entity.
- `/resolve-entity` stub skill for admin disambiguation.
- Tests: `skills/dent-append-evidence.test.ts`, `entity-detection/
  service.test.ts`, plus Phase 6 amplification tests below.
- **Gate:** Jason appends 5 evidence records, sees compiled pages update;
  at least 3 entities have a confirmed FM link in their frontmatter.

**Phase 5 — Dropbox bulk import**
- `/ingest-dropbox-tree` CLI with rules-first-LLM-fallback classifier
  (CQ6), staged batches, quarantine.
- Dry-run mode + staged import + quarantine + fix loop until classification
  <20% human-correction rate.
- **Entity creation cross-references FM People** (CQ1 + A5) before
  creating new pages.
- Tests: classifier, importer, full E2E with 10 fixture files.
- **Gate:** top 20 entities have non-empty pages from real Dropbox content;
  ≥10 FM-linked. Classifier rule-hit rate >80%.

**Phase 5b — FM Notes import (DEFERRED to v1).** `/ingest-filemaker-notes`
CLI: pulls `Notes Q` and `Sticky Notes`, normalizes into evidence, links
to FM People.

**Phase 6 — Signal surfacing (reshaped after A6 spike).** Cowork's
deferred-tools model kills passive per-message invocation. Reshape:
**(MVP)** amplification inside `/dent-append-evidence` — scan the last N
turns of session context for OTHER Dent entities mentioned but
not-yet-appended; surface candidates. **(v1)** session-start digest via
`/dent-check`. **(v1+)** server-side ingest (Gmail, Granola, Dropbox
cron) becomes the proactive surface; Cowork is QUERY + IN-MOMENT capture.
Tests: amplification finds entities → suggests / clean session → no
offer / user accepts → new evidence / user declines all → single record.
Gate: user runs `/dent-append-evidence` with 2 other Dent entities
recently mentioned, sees prompt, can accept/decline each.

**Phase 7 — Plugin bundle + non-technical install.** Skills:
`/dent-append-evidence`, `/dent-enrich`, `/dent-whoami`, `/dent-resolve-entity`,
`/dent-update-dent-brain`, `/dent-setup-filemaker-mcp`,
`/dent-onboard-teammate`. Bundled code: `plugin/fm-mcp/` (Steve's
`server.js`, credit preserved). Admin token issuance via `gbrain auth
create <name>`. The `/dent-setup-filemaker-mcp` skill automates Steve's
15-min Terminal setup: preflight checks → AskUserQuestion for FM
credentials → install server files + npm install → safely edit
`claude_desktop_config.json` (validate JSON) → verify via MCP inspector
→ relaunch instructions. **Gate (timing):** under 15 min total for
first-time team member, zero Terminal.

**Phase 8 — Ship to Steve.** Issue admin token, live install walkthrough
on video, shared feedback doc, weekly `/dent-enrich` quality review,
2-week observation window with daily check-in for the first 3 days,
end-of-week-2 retro on success criteria.

**After MVP (v1 targets):** `dbrain init` (P1, unblocks OSS release),
Phase 5b FM Notes import, Gmail + Granola ingest, FM write patterns
(priority based on Steve's retro), intelligence skills as convenience
wrappers, server-side Dropbox cron, FM daily delta, Jeff onboarding
(then Robin / Andreas / Morgan), RSS streams.
- Server-side Dropbox cron, FM daily delta, RSS streams.
- Jeff onboarding; iterate. Then Robin / Andreas / Morgan.

---

## Install model (three audiences)

### Team members using an existing deployment (MVP audience)
- Install is entirely Cowork-side: dual-registration (HTTP + mcp-remote
  stdio bridge) + FM MCP automated via `/dent-setup-filemaker-mcp`.
- Target: ~10-15 min, zero Terminal.

### Admins deploying a new dbrain instance (Jason for Dent today; future OSS admins)
- `git clone https://github.com/jasonp/dent-brain.git` → `bun install` →
  `bun run dbrain init`.
- `dbrain init` is interactive (P1 post-MVP work). For Dent's alpha, Jason
  hand-filled `plugin/manifest.json`.

### Power users (rare)
- **Person in multiple orgs:** install multiple Cowork plugins (different
  URLs, tokens, prefixes). Skills coexist via namespace.
- **Admin running multiple deployments:** separate clone per deployment,
  `dbrain init` in each.

---

## Reuse inventory (v1.8 post-substrate-merge)

What we don't have to build because gbrain v0.25.0 ships it:

- **gbrain core** — CLI (`dbrain`/`gbrain`), MCP server, 37+ ops, hybrid
  RRF search, embedding pipeline, chunking, import, recipe framework,
  26+ skills.
- **`skills/enrich/SKILL.md`** — tiered LLM synthesis,
  agent-orchestrated, subscription-funded. Forked as `skills/dent/enrich/`.
  **No materializer to build.**
- **`src/mcp/http-transport.ts` (v0.22.7)** — bearer auth, CORS, rate
  limiting, body cap, mcp_request_log audit, last_used_at debounce,
  DB-probing /health. Wrapped by `src/dent/serve.ts` (Railway entrypoint:
  `bun run src/dent/serve.ts`), which merges core + dent operations.
  **No custom http-mcp wrapper to maintain.**
- **`src/mcp/dispatch.ts` + `src/mcp/rate-limit.ts`** — single source of
  truth for MCP dispatch.
- **Minions queue + `subagent` handler** — Postgres-native, `idempotency_key`
  + `delay`, rate-leases keyed `anthropic:messages`, `claude-sonnet-4-6`
  default. Available if a future server-side synthesis pipeline is needed;
  not used in MVP.
- **`mcp_request_log` (v4 schema)** — per-request audit row replaces our
  planned `evidence.author` column.
- **Multi-source brains (v0.18.0)** — `pages.source_id` + `sources` CLI.
  `/dent-enrich` writes pages with `source_id = 'dent'`.
- **`add_link` / `add_timeline_entry` / `put_page`** — page-write
  primitives. No Dent-specific page-write code.
- **FileMaker MCP** — full R+W, 47 layouts, authenticated. Reused in
  place; Dent Brain does NOT proxy.
- **Dropbox SDK** + **zod**.

---

## Critical failure-mode gaps to close

Most active codepaths have test + handling coverage. Two known gaps to
close in Phase 4:

1. **FM unreachable during `/dent-append-evidence` FM-link pass.** Silent
   fallback (unlinked entity) is acceptable UX but needs retry path. Add
   test + handling in Phase 4.
2. **FM record deleted after entity linked.** Stale `filemaker_record_id`
   pointer is silent today. Add `fm-link-health` admin command + alert.
   Add to Phase 0.5 remainder or Phase 4.

---

---

## TODO (post-MVP)

**P2: Apply branch protection to both repos (during Steve onboarding,
Phase 8).**
- `jasonp/dent-brain`: upgrade to GitHub Pro ($4/mo). Apply medium
  protection to master.
- `dentthefuture/dent-brain-data`: get admin permission, apply soft
  protection to main.

**P3 (polish): Sweep `src/cli.ts` to use `package.json:name` dynamically
instead of hardcoded "gbrain" strings.**
- Currently has ~10 hardcoded references. When users type `dbrain --help`
  they see "gbrain" which is wrong but functional. Defer until post-MVP.

**P3 (polish): Sweep PLAN.md inline skill references to use `/dent-`
prefix.** Body of PLAN.md still uses unprefixed names like
`/append-evidence`, `/flag-fact` in some places; should be `/dent-`-prefixed
per multi-org architecture decision. ~15 inline edits, mechanical.
