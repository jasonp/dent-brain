# PLAN audit trail — withdrawn decisions, prior changelogs, design history

This is the archive companion to `PLAN.md`. The active design lives in `PLAN.md`;
everything that was once load-bearing but no longer is — withdrawn decisions,
historical changelog entries, deprecated phase specs, session-level
reflections — lives here so a future reader can answer "why didn't we build X?"
without spelunking the git history.

When you change `PLAN.md` to retire a decision or section, move the original
content here verbatim under the appropriate heading, with a one-line note
recording when and why it was retired.

---

## Withdrawn Eng-Review Decisions

These were binding decisions in PLAN v1.0 / v1.1 that v1.8 (the
substrate-merge + Phase 3 reshape) retired. The original specs are preserved
here so a future reader can re-evaluate if circumstances change.

### A1. Materializer concurrency: pg-boss + 30s debounce

**Original (v1.0):** Use `pg-boss` (Postgres-native job queue, Layer 1).
Schedule rebuild with entity-slug as dedup key; new `append_evidence` on the
same entity within 30s resets the timer. One rebuild per burst. No Redis,
no custom queue.

**Withdrawn 2026-05-01 (v1.8).** No materializer; `/dent-enrich` is
Cowork-side, user-triggered, subscription-funded. No queue needed. If a
future server-side synthesis pipeline is built, gbrain's Minions queue
(adopted upstream post-v1.7) is the canonical replacement — supports
`idempotency_key` and `delay` natively.

### A8. Prompt versioning + `materializer_prompts` table

**Original (v1.0):** Semver'd prompt templates stored in Postgres
(`materializer_prompts` table). Every synthesized page stamped with
`prompt_version` in frontmatter. `rebuild_entity --older-than-prompt vN`
sweeps pages to bring them current. Correction log groups findings by
prompt version for tuning.

**Withdrawn 2026-05-01 (v1.8).** Prompt lives in
`skills/dent/enrich/SKILL.md`, versioned via git. No `materializer_prompts`
table. Sweep semantics: re-running `/dent-enrich` against an entity
incorporates the latest prompt naturally; no `--older-than-prompt` flag.

### A10. Last-good snapshots in `entity_snapshots`

**Original (v1.0):** Before each rebuild, copy current entity page markdown
to `entity_snapshots` table. Keep last 5 versions per entity.
`rebuild_entity --revert <slug>` restores prior. Combined with A8 prompt
versioning, provides both entity-level revert and project-wide prompt pin.

**Withdrawn 2026-05-01 (v1.8).** `dent-brain-data` is a git repo;
`git log` IS the snapshot history. `git revert <commit>` is the revert
mechanism. Skill's merge-on-rerun preserves hand-edits between enrich runs.

### CQ2. Materializer structural validator (CRITICAL)

**Original (v1.0):** Every synthesized claim under `## Confirmed facts`,
`## Working inferences`, `## Open questions` must match `[src: ...]`
regex. Malformed output is rejected; re-prompt up to 3 times. On 3rd
failure, fall back to timeline-only page with `materializer_failed: true`
flag. Non-negotiable test coverage.

**Withdrawn 2026-05-01 (v1.8).** Free-form synthesis, no five-section
contract, no validator. We trust the LLM and FM-as-truth. The five-section
structure was the contract this validator enforced; with the structure
gone, the validator has nothing to validate.

### CQ3. `/flag-fact` fuzzy matching cascade

**Original (v1.0):** Match attempts in order: exact → substring → embedding
similarity (>0.8). Log match mode in correction log so tuning can see
which mode was used. Non-match UX: "couldn't find that claim, did you
mean X or Y?"

**Withdrawn 2026-05-01 (v1.8).** No `/flag-fact` operation. Steve's
correction is hand-edit + `quarantine_batch` (Phase 1).

### CQ7. Materializer cost watchdog $50/week

**Original (v1.0):** Simple is right for one user. Track per-rebuild cost
in `audit_log.cost_usd`. Weekly rollup with Slack alert if crossed. Build
incremental synthesis in v1 only if alert fires.

**Withdrawn 2026-05-01 (v1.8).** No API spend on synthesis
(subscription-funded). Watchdog idea revives only if v1 introduces
server-side synthesis.

---

## Withdrawn Phase 3 spec — server-side materializer

The original Phase 3 plan from v1.0 (replaced by skill-only
`/dent-enrich` in v1.8). Preserved here in case a future revision wants
to re-evaluate building a server-side synthesis pipeline.

### Phase 3 — Materializer (LLM synthesis with guardrails) [WITHDRAWN]

- Synthesis prompt produces confirmed facts, working inferences, open
  questions, conflicts, evidence timeline.
- **Mandatory source-tag backlinks** on every synthesized claim.
  Structural validator (CQ2) rejects malformed output, re-prompts up to
  3x, falls back to timeline-only with `materializer_failed: true` flag.
- Prompt templates in `materializer_prompts` table (A8). Every page
  stamped with `prompt_version` in frontmatter.
- Conflict detection: mechanical scan for opposing claims + LLM pass for
  semantic contradictions.
- FM-conflict handling (A9): materializer prompt includes "contradict-FM"
  rule; surfaces Dent Brain evidence newer than FM ModificationTimestamp
  with warning flag.
- **Last-good snapshot** (A10): before each rebuild, copy current
  markdown to `entity_snapshots`. Keep 5 versions.
- `rebuild_entity` implements synthesis. Queued via pg-boss with 30s
  debounce (A1).
- Correction log table: `flag_fact` writes `(entity, claim,
  claim_match_mode, reason, user, timestamp, prompt_version)` for weekly
  review.
- Tests: 8 test files covering validator, synthesis, conflict detection,
  flag-fact, rollback, fm-conflict, empty-evidence, queue debounce.
- Gate: 20 test evidence records across 3 entities, run `rebuild_entity`,
  inspect synthesized pages, flag bad facts, see them demoted on next
  rebuild, test `--revert` on one entity.

**Why retired (v1.8):** gbrain's existing `skills/enrich/SKILL.md`
already does tiered LLM synthesis with State + timeline + citations +
backlinks, agent-orchestrated and on the user's Claude subscription.
Forking it as `skills/dent/enrich/SKILL.md` with three modifications —
FM injection, FM-wins prompt rule, merge-on-rerun — is a 1-2 day phase
instead of 1-2 weeks of custom server code, and it's free at runtime.

---

## Five-section page structure contract [WITHDRAWN]

**Original (v1.0):** Every entity page produced by the materializer has
exactly five sections in this order:

```
## Confirmed facts
## Working inferences
## Open questions
## Conflicts
## Evidence timeline
```

Each claim under the first four sections ends with `[src: <evidence_id>]`
or `[src: <id1>, <id2>, ...]`. Validator (CQ2) enforces the contract.

The structure was load-bearing for two reasons:
1. **Authority surface migration boundary.** Mechanical-corroboration
   hardening would replace the `## Confirmed facts` section with
   structured-claim extraction (≥2 sources required). Other sections
   stay LLM-synthesized.
2. **FM-conflict surfacing.** `## Conflicts` was where A9's "FM says X,
   evidence says Y" bubbles up; without a dedicated section, the
   conflict gets buried in prose.

**Withdrawn 2026-05-01 (v1.8).** With FM-as-truth + free-form synthesis,
no migration boundary is needed (mechanical corroboration is also
withdrawn) and FM-conflict notes go inline. The only structural rule
in the v1.8 prompt is "page ends with a short reverse-chronological
evidence trail so the reader can verify provenance."

---

## Mechanical confirmed-facts extraction [WITHDRAWN]

**Original (v0.7 → v1.0 hardening path):** Post-MVP, replace LLM-synthesized
"Confirmed facts" section with structured-claim extraction:
- Each claim is `(predicate, object, subject)` extracted from evidence
- Confirmed only if ≥2 evidence records corroborate
- LLM is removed from the authority surface
- Working inferences / Open questions / Conflicts stay LLM

Path was driven by `/flag-fact` rate data: if Steve flagged >5 per 100
synthesized claims, accelerate this work.

**Withdrawn 2026-05-01 (v1.8).** Five-section structure removed; no
authority surface to migrate to mechanical extraction. FM is truth;
LLM-synthesized prose is fine for the Dent Brain side.

---

## Withdrawn success criteria

These were in v1.7 success criteria; v1.8 retired them.

- ~~**#9. Hallucination rate tolerable.** `/flag-fact` calls by Steve
  < 5 per 100 synthesized claims read. Above that threshold, accelerate
  mechanical-corroboration hardening.~~ Replaced by qualitative criterion.
- ~~**#10. Every synthesized claim on every entity page has at least
  one source-tag backlink.** Zero tolerance for bare prose in compiled
  sections.~~ Withdrawn — no five-section contract.
- ~~**#11. `rebuild_entity` is reproducible enough that a second rebuild
  on unchanged evidence produces substantively identical compiled
  sections (exact prose may differ; facts and inferences must not).
  Formal determinism is the post-MVP mechanical rubric's job.~~ Replaced
  by merge-on-rerun semantics.

---

## Historical changelog (v1.8 → v0.9)

Full changelog entries from prior PLAN versions. The active PLAN.md keeps
only a short "where we are now" summary; the detailed narrative for each
revision lives here. Entries are listed in reverse chronological order.

### v1.8 (2026-05-01, substrate upgrade v0.16→v0.25 + Phase 3 reshape + Option B DRY retrofit)

Two big shifts landed in one session: (1) we adopted 39 commits of upstream
substrate evolution, and (2) we redesigned Phase 3 around what gbrain now
ships natively, dropping a large chunk of bespoke Dent-Brain code.

**Substrate upgrade (v0.16.0 → v0.25.0).** `bun run sync:upstream` merged
39 upstream commits. Notable substrate adds that touch our work surface:

- **v0.22.7 — built-in HTTP transport with bearer auth**
  (`src/mcp/http-transport.ts`, `src/mcp/dispatch.ts`,
  `src/mcp/rate-limit.ts`). Reuses `access_tokens` table we already use,
  ships CORS / rate limiting / body caps / mcp_request_log audit (v4) /
  SQL-level last_used_at debounce / DB-probing /health endpoint.
  **Obsoletes our 322-line `src/dent/server/http-mcp.ts`.** Triggers
  Option B retrofit (below).
- **v0.23.0 — gbrain dream synthesizes conversations into brain pages.**
  Adds `dream_verdicts` table (Haiku-judged worth-processing cache),
  8-phase cycle, `OperationContext.allowedSlugPrefixes` for
  trusted-workspace subagent writes. Transcript-driven, not entity-driven
  — doesn't directly replace our `/dent-enrich`, but the patterns are
  reusable for any future server-side materializer.
- **v0.18.0 — multi-source brains (one DB, many repos).** Adds
  `pages.source_id`, composite `UNIQUE(source_id, slug)`, `sources` CLI,
  6-priority source resolver. `/dent-enrich` writes pages with explicit
  `source_id = 'dent'`.
- **v0.18.1 / v0.18.2 — RLS hardening + migration hardening.** Plugged a
  publicly-readable hole on `access_tokens` and 9 other public tables;
  added pre-flight idle-in-transaction lock detection, server-enforced
  `SET LOCAL statement_timeout = 600s`,
  `BrainEngine.withReservedConnection()`.
- **v0.21.0 — Code Cathedral II.** Call-graph edges, two-pass retrieval,
  parent-scope chunking. Affects retrieval against synthesized pages;
  transparent to our code.
- **v0.22.x — minions worker hardening.** RSS watchdog, supervisor,
  autopilot backpressure, parallel sync, storage tiering, frontmatter
  inference.

**Conflicts resolved during merge:**
- `package.json`: kept `bin: {dbrain, gbrain}` alias + our `sync:upstream`
  script. Bumped version 0.16.0 → 0.25.0 to track substrate baseline.
  **Reverted `name: dbrain → gbrain`** so upstream's
  `test/public-exports.test.ts` (which imports `gbrain` / `gbrain/engine`
  / etc. as a self-import contract) resolves. Internal package identity
  is `gbrain`; CLI binary is `dbrain` with a `gbrain` alias.
- `CLAUDE.md`: kept our Dent-trimmed version.
- `.gitignore`: additive merge of both sides.
- `bun.lock`: regenerated via `bun install`.

**Test guard tightened.** `scripts/sync-from-upstream.sh` now passes
`--timeout=60000` to `bun test` to match the package.json `test` script
— pre-merge it ran raw `bun test` and would have hidden 34 PGLite-setup
hook timeouts when the migration count grew. `llms.txt` + `llms-full.txt`
regenerated by `bun run build:llms`.

**Test result post-merge:** 3496 pass / 0 fail / 293 skip across 233 files.

**Phase 3 reshape — Option B retrofit + skill-only `/dent-enrich`:**

1. **Materializer dropped from MVP. `/dent-enrich` ships as a Cowork-side
   skill instead.** Gbrain's existing `skills/enrich/SKILL.md` already does
   tiered LLM synthesis with State + timeline + citations + backlinks,
   agent-orchestrated and on the user's Claude subscription. Forking it
   as `skills/dent/enrich/SKILL.md` with three modifications — FM record
   injection, FM-wins prompt rule, merge-on-rerun — is a 1-2 day phase,
   not a 1-2 week phase. **Withdraws A1 (queue + 30s debounce), A8
   (prompt versioning + sweep), A10 (snapshot table — git history of
   dent-brain-data IS the snapshot/revert mechanism), CQ2 (structural
   validator), CQ3 (flag-fact fuzzy match), CQ7 (cost watchdog — no API
   spend on synthesis since it's subscription-funded).**

2. **Five-section page structure dropped — free-form synthesis with
   FM-as-truth.** No mandatory `## Confirmed facts` / `## Working
   inferences` / `## Open questions` / `## Conflicts` / `## Evidence
   timeline` contract. Page is whatever the LLM produces. Rule 1 of the
   prompt is "FileMaker is the source of truth; if evidence contradicts
   FM, prefer FM and note inline."

3. **`/dent-flag-fact` dropped from MVP entirely.** No mechanism to flag
   synthesized claims because there's no rigid claim contract to flag
   against. Steve's correction is hand-edit + `quarantine_batch`.
   Removes the operation, the `correction_log` table, and the skill from
   the plugin bundle.

**Option B (DRY retrofit, scheduled for next work session).** The user's
"DRY in our extension" signal applied to `src/dent/server/http-mcp.ts`
+ `DentOperationContext.author` field. Decision: **delete the wrapper
and the column.** Net architecture:

- Railway entrypoint becomes `dbrain serve --http --port $PORT`
  (upstream's v0.22.7 transport) instead of running our custom server.
  Inherits CORS, rate limiting, body caps, audit log, last_used_at
  debounce.
- `src/dent/server/` deleted entirely.
- 4 dent operations (`append_evidence`, `get_evidence`,
  `quarantine_batch`, `get_provenance`) registered into the upstream
  `operations` array.
- `DentOperationContext` deleted; handlers use plain `OperationContext`.
- `evidence.author` column dropped via dent migration v2. Per-row author
  attribution comes from `mcp_request_log.token_name` join on
  `(evidence.appended_at, mcp_request_log.created_at)`.
- Phase 1 evidence tests rewritten: 25 → ~22 (drop the `auth_invalid`
  cases, drop the `author === ctx.author` idempotency comparison;
  everything else stays).

This retrofit happens in its own commit chain post-PLAN-v1.8, with its
own /ship cycle and Railway redeploy verification.

**Phase 8 success criterion #9 rewritten.** Was: `/flag-fact` rate
< 5 per 100 synthesized claims (mechanical signal). Now: Steve
qualitatively reports pages useful and not actively misleading;
hand-edits are signal, not failure.

**What stays unchanged from v1.7.** Phase 0, 0.5, 1, 2 are complete.
Production Supabase has dent_version=1. `/dent-append-evidence` (Phase 4)
— still on the roadmap; updated to call `add_timeline_entry` after each
evidence write so the timeline grows even when `/dent-enrich` hasn't run
since. FM federation pattern (lazy reads, no proxy, per-user FM
accounts) — unchanged. Three-surface Claude architecture (Code mode,
Cowork mode, Web) — unchanged. Onboarding skill + dual-registration
pattern — unchanged.

### v1.7 (2026-04-30, Cowork-mode surface gap caught + dual-install fix)

- **v1.5 conclusion was incomplete.** The 2026-04-29 test that "validated"
  Cowork was actually testing Claude Desktop's Code mode, NOT Cowork mode.
  Different registration stores. Cowork's mcp registry comes from
  `~/Library/Application Support/Claude/claude_desktop_config.json`, which
  is **stdio-only** — HTTP-type MCPs (`{type, url, headers}`) get rejected
  on launch with a "not valid MCP server configurations" popup.
- **Caught the day after PLAN v1.6 landed,** when Jason spot-checked Cowork
  before Steve onboarding. Saved Steve from a guaranteed broken first
  install. Empirical run-through recorded in
  `docs/dent-brain/TESTS_phase0_auth_surfaces.md` (round 2) and the
  superseded UPSTREAM_NOTES entries (corrected).
- **Fix: dual-registration with `mcp-remote` stdio bridge for Cowork.**
  Every teammate gets BOTH:
  1. `~/.claude.json` HTTP entry → Code mode + standalone CLI.
  2. `claude_desktop_config.json` stdio entry running
     `npx -y mcp-remote <url> --header "Authorization: Bearer <token>"`
     → Cowork mode + classic Claude Desktop chats.
  Same bearer token authenticates both; one row in `access_tokens` per
  human; per-user audit unchanged. OAuth still not needed.
- **`/dent-onboard-teammate` skill rewritten** to produce a single
  Python-driven shell block that updates BOTH config files atomically,
  validates JSON, and prints the relaunch instructions. No
  `claude mcp add` dependency (Python is universal on macOS; we don't
  require teammates to install the standalone Claude Code CLI).
- **DEPLOY.md §4 updated** with the Cowork bridge requirement so OSS
  forks don't trip the same surface gap.
- **Architectural lock-in:** dbrain's canonical client surface is
  Claude Desktop (Code mode + Cowork mode + classic chats) plus
  optionally the standalone Claude Code CLI for technical users. Web
  Connectors UI remains explicitly out of scope.
- **Lessons captured** in UPSTREAM_NOTES: gbrain's README claim that
  bearer auth works in "Claude Desktop, Cowork, Perplexity" is true ONLY
  for Code-mode / standalone-CLI patterns. Cowork mode requires the
  stdio bridge regardless of how the upstream README phrases it. This
  isn't a gbrain bug; it's the actual Claude Desktop surface architecture.

### v1.6 (2026-04-29 evening, Phase 1 evidence-log core landed)

- **Phase 1 Gate met.** Schema migration applied to production Supabase
  (`dent_version=1`, `evidence` table with GIN(entity_refs) per A2 + four
  supporting indexes). Four operations live and serving on the Railway
  build: `append_evidence`, `get_evidence`, `quarantine_batch`,
  `get_provenance`. Full end-to-end round-trip verified via
  `https://dent-brain.dentthefuture.com/mcp` with the `dent-brain-jason`
  token: append → read → provenance, audit log captured each call,
  evidence row's `author` field reflects the token name (per-user attribution
  works as designed). Gate-test fixtures cleaned up after verification.
- **25 unit tests, all green** (`test/dent/evidence/{append,query,quarantine,
  provenance}.test.ts`). Runs against PGLite in-memory, no DATABASE_URL
  required. Covers happy paths, content-hash idempotency including
  same-content-different-source disambiguation, EVIDENCE_ENTITY_UNKNOWN
  rejection (full + mixed sets), auth_invalid on missing author,
  concurrent-append-doesn't-race (5 parallel appends → 1 row), reverse-chron
  ordering, quarantine round-trip + reason metadata in JSONB, dry-run
  semantics, EVIDENCE_NOT_FOUND on get_provenance with bogus id.
- **CQ5 error taxonomy doc landed in `dent-brain-data` private repo at
  `docs/ERROR_TAXONOMY.md`.** 7 codes documented (6 in use; `entity_not_found`
  reserved for Phase 3+).
- **Architecture decision: Dent migrations run in a parallel runner**
  (`src/dent/migrate.ts`) using `dent_version` config key, never touching
  gbrain's `version`. Keeps upstream merges from `garrytan/gbrain` clean.
  CLI: `bun run scripts/dent-migrate.ts` with `DATABASE_URL` env.
- **`DentOperationContext` extends `OperationContext` with `author` field**
  populated by http-mcp from the verified bearer token's `access_tokens.name`.
  Single confined cast in dent handlers, no gbrain core modification.
  *(Note: Option B retrofit in v1.8 deletes both DentOperationContext and
  the author column. See PLAN.md v1.8 changelog.)*
- **Deploy gotcha caught:** Railway auto-deploy from GitHub was NOT wired
  on the original Phase 0 setup (deploy was via `railway up`). Push to
  master alone doesn't trigger a rebuild; manual `railway up` is required
  until GitHub integration is added in the Railway dashboard. Recorded as
  a P2 followup; not blocking Phase 1.

### v1.5 (2026-04-29, OAuth scrapped after empirical re-test; Phase 0 closes on per-user install instead)

- **OAuth implementation cancelled.** v1.4 conclusion that "Claude Desktop's
  Claude Code feature does NOT read `~/.claude.json` and requires OAuth" was
  empirically wrong. Re-tested 2026-04-29 with the deployed Railway backend:
  registered `dent-brain` via `claude mcp add -t http <url>/mcp -H "Authorization:
  Bearer ..."` from the standalone CLI, then opened Claude Desktop's embedded
  Claude Code mode. The registration was visible in tool listings, and a
  `get_stats` invocation produced an audit row (`op=tools/call latency=213ms
  status=success`) under the same token name the CLI uses. Standalone CLI and
  Claude Desktop's Claude Code mode **share the same `~/.claude.json` config**.
  The 2026-04-27 finding that prompted the OAuth plan was a test quirk, not a
  structural property of the surface. Test record:
  `docs/dent-brain/TESTS_phase0_auth_surfaces.md`. UPSTREAM_NOTES.md updated
  with the corrected finding.
- **Bearer + `claude mcp add` is canonical for the team-use case.** Phase 0
  closeout reshapes from "implement OAuth (~4-5 hours)" to "ship the per-user
  install flow."
- **Web surface explicitly out of scope for MVP.** Claude.ai web Connectors UI
  was not tested. Dent team uses Claude Cowork desktop apps for both directions
  of the dent-brain workflow.
- **Architectural lock-in.** dbrain's canonical client surface is **Claude
  Desktop / Claude Code / Cowork** (all three reading `~/.claude.json`). This
  matters for OSS distribution: forks inherit the same install model — no OAuth
  issuer to deploy, no consent UI to host, no DCR endpoints. Same friction as
  upstream gbrain.
- **Phase 0 substantively complete.** HTTP MCP at Railway works on the surfaces
  that matter. Background ingest (server-side cron via `dbrain jobs work` for
  Gmail / Granola / Dropbox drop folder) remains as planned for v1 and is a
  separate pipeline from MCP auth.
- **Custom domain wired 2026-04-29.** Canonical URL is now
  `https://dent-brain.dentthefuture.com/mcp`. Railway-provided URL keeps
  working in parallel (both routes live). DNS via GoDaddy: CNAME +
  ownership-proof TXT (both required). LetsEncrypt cert auto-provisioned
  by Railway after both records validated.

### v1.4 (2026-04-27, Phase 0 substrate complete; OAuth identified as auth-surface gap)

- **HTTP MCP server live at https://dent-brain-production.up.railway.app/mcp**, deployed via Railway, talking to Supabase Postgres (us-west-2 transaction pooler), 14 gbrain migrations applied, bearer auth + audit log working, end-to-end MCP tool invocations confirmed via curl AND via Claude Code's loaded MCP tools.
- **Phase 0 substrate is DONE.** Bun runtime, gbrain v0.16.0 fork, dbrain rename, plugin manifest, FM MCP vendored, deploy config (Dockerfile + railway.json + .dockerignore), HTTP wrapper at `src/dent/server/http-mcp.ts` (322 lines, MCP SDK's StreamableHTTPServerTransport, bearer auth via gbrain's `access_tokens` table, audit via `mcp_request_log`).
- **Bugs caught and fixed during deploy:** (a) Bun 1.3.11 `--production=false` flag invalid → dropped from Dockerfile; (b) bun.lock out of sync after Jason added @supabase/* deps → resynced; (c) `engine.connect({url})` should be `{database_url}` per gbrain's EngineConfig → fixed; (d) `mcp_request_log` schema doesn't have `error_code` column → INSERT fixed; (e) `postgres.js` defaults to prepared statements which wedge under PgBouncer transaction-mode → set `prepare:false` when DATABASE_URL is port 6543.
- **gbrain bin alias:** added `gbrain` alongside `dbrain` in package.json `bin` block.
- **Architectural finding — three Claude surfaces have different MCP-config paths.** *(This finding was substantively wrong on Cowork; corrected in v1.7. Original misdiagnosis preserved here for the audit trail.)*
- **Phase 0 closeout: implement OAuth 2.1 client credentials.** *(Cancelled in v1.5 after empirical re-test.)*

### v1.3 (2026-04-22, Phase 6 reshape from A6 spike)

Cowork uses a deferred-tools model that makes passive per-message MCP invocation unreliable. Phase 6 reshapes.

- **A6 spike result:** built a throwaway MCP server (`experiments/a6-cowork-hook-spike/`) with a `passive_observer` tool whose description instructed Claude to call it every turn. Installed in Claude Desktop, opened a Cowork session, verified the tool was registered. **Log: zero invocations across a full test conversation.** Root cause: Cowork requires `ToolSearch → select:<tool>` to load a tool's schema before it can be called. The "always call me" instruction lives INSIDE the schema, so Claude never sees the instruction until (or unless) it manually loads the schema.
- **Phase 6 reshape:** replaced the per-message passive observer with two patterns that work WITH Cowork: (1) amplification inside `/dent-append-evidence` — when user explicitly appends evidence, the skill also scans recent session context for OTHER Dent entities mentioned and offers multi-append; (2) session-start digest (`/dent-check`, v1).
- **Removed from MVP:** per-message passive observer MCP tool, session-level signal-detector off toggle, rate limiter, fixture-scenarios tests.

### v1.2.1 (2026-04-22, install model codified)

Decided the install UX for three audiences and spec'd the tool that makes it work.

- Three-audience install model: (1) team members install Cowork plugins + one automated `/dent-setup-filemaker-mcp` run, no local code; (2) admins deploying a new dbrain instance run `bun run dbrain init` — gbrain-style interactive prompts that generate `plugin/manifest.json` + `.env.local` + `NEXT_STEPS.md`; (3) power users — multiple Cowork plugins for multi-org participation OR multiple clones for multi-deploy admins.
- **`dbrain init` promoted to P1 post-MVP (unblocks OSS release).**
- **Single-org-by-default confirmed.** Multi-org is software-supported but NOT the install-time default.

### v1.2 (2026-04-21, namespace + multi-org)

- **CLI namespace separation: `dbrain` (not `gbrain`).** Renamed `package.json`'s `name` and `bin` from `gbrain` → `dbrain`. *(Note: v1.8 reverted the `name` field to `gbrain` for upstream-test compatibility; the `bin` rename + alias is preserved.)*
- **Upstream-merge ergonomics:** `scripts/sync-from-upstream.sh` (`bun run sync:upstream`).
- **Multi-org by design.** Single-tenant per server deploy + skill-prefix at plugin-build time.
- **`plugin/manifest.json` added** with deploy config.

### v1.1.2 (2026-04-21, branch protection deferred)

Tried to apply branch protection to both repos. Blocked: `jasonp/dent-brain` requires GitHub Pro for protection on private repos ($4/mo, declined for now); `dentthefuture/dent-brain-data` requires admin permission which Jason doesn't have. Path forward: discipline-based workflow now; upgrade + properly admin-grant when Steve onboards in Phase 8.

### v1.1.1 (2026-04-21 late evening, in-repo correction)

Substrate-naming fix. Previous revisions had "gstack as substrate" in several places — typo. The substrate is **gbrain** (`github.com/garrytan/gbrain`), not gstack.

### v1.1 (2026-04-21 evening, FM MCP reality check)

- **Steve's custom Node.js MCP server is the canonical FM integration.** Adopted into `jasonp/dent-brain/plugin/fm-mcp/`. Credit preserved.
- **Transport is stdio, not HTTP.** Each team member runs a local copy.
- **Per-user FM audit solved by design.** Each team member creates their own FM account (`mcp_<firstname>`) with the `MCP Read And Edit Records` privilege set.
- **New MVP skill: `/setup-filemaker-mcp`.** Automates the 15-min Terminal-heavy setup.
- **Hybrid architecture confirmed.** Dent Brain MCP stays HTTP/Railway (shared state); FM MCP is local/stdio/per-machine (per-user auth).
- **FM host corrected:** `sea-17.fmsdb.com` (from Steve's server.js), not `se17.fmcdn.com`.

### v1.0 (2026-04-21 morning, FM MCP capabilities validated live)

- **FM MCP is full-featured R+W.** Steve demoed live in his Cowork. Connection authenticated to `DentCRM2025` on `se17.fmcdn.com`, user `mcp_claude`. 47 layouts enumerated and organized.
- **Read ops confirmed:** `fm_get_layouts`, `fm_get_layout_fields`, find records, get record, person lookup by first/last name.
- **Write ops confirmed:** `fm_create_record` works.
- **All 5 canonical use cases confirmed MVP-deliverable.**
- **Write boundary decision: MVP stays READ-ONLY against FM.**
- Eng-review complete (10 architecture + 7 code-quality + 3 performance decisions made).

### v0.9 (2026-04-18)

- FileMaker federation added.
- Branding split: plugin/tool code at `github.com/jasonp/dent-brain`; data repo at `github.com/dentthefuture/dent-brain-data`.
- Canonical use cases section added. 4 of 5 fully MVP-deliverable via federation.
- Intelligence skills reframed as v1 convenience wrappers.
- Markdown stays in GitHub, not FileMaker.
- Phase 0.5 introduced.

---

## "What I noticed about how you think" (v0.7 → v1.0 session reflections)

These were observations the original /office-hours and /plan-eng-review
sessions surfaced about Jason's design instincts. Preserved here for
historical record (the user prized them at the time of writing).

- You wrote v0.7 with "Design is locked. Next step: hand this doc to Claude Code and begin Phase 0 with `/office-hours` to pressure-test." That's a rare move. Most people who write "design is locked" have stopped listening. You baked the pressure-test into the plan. That's taste.

- When I pushed on P2 (materializer trust), you picked the boring-verifiable option without hesitation. Then, when I tried to translate that decision into "defer compiled truth from MVP," you pushed back. You separated the goal (compiled entity pages are the product) from the mechanism (LLM vs mechanical synthesis). You said: accept the LLM for now, harden later, and don't pigeonhole me into shipping a log instead of a brain. That is exactly the right taste distinction. *(Note v1.8: the materializer was withdrawn entirely; FM-as-truth replaced the rigor stance.)*

- You corrected my P1 framing about `/append-evidence` with the real architecture: it's a fallback surface, the primary ingest is automated (Dropbox + Gmail) plus proactive signal-detection from Cowork sessions. That's a significantly better product than what's written in v0.7.

- You named Steve, not Jeff, as the first test user. v0.7 had Jeff. The rewrite to Steve is small but load-bearing: Steve is an admin and a co-owner of the system's success. Jeff is a consumer.

- In v0.9 you came back with the FileMaker schema and the 5 use cases. Two senior moves in one revision. First: surfacing the FM data BEFORE Phase 0 starts. Most teams discover the existing system halfway through and rebuild three weeks of work. You caught it pre-build. Second: the canonical use cases — they're not vague aspirations like "search the brain"; they're specific human queries with specific data shapes.

- The branding split — your repo for the substrate, Dent's repo for the data — shows you thinking past Dent. The framework being portable to other organizations only matters if the substrate code is separable from the org-specific data and config. Splitting the repos at the start enforces that boundary by construction.

- And then you caught me again on use case 4. I had it labeled "needs `/who-knows-whom` skill, v1+." You said: "I don't need a graph traversal. I just need Claude to determine which Dent profiles match the described need." Once you said it, the whole intelligence-skills layer collapsed by one rung. With FM + Dent Brain both in Cowork, Claude IS the intelligence layer.

- For v1.0: you didn't answer the Phase 0.5 open questions by speculating. You opened FileMaker Pro, ran `fm_get_layouts`, pulled Steve's own record, created a sandbox layout (`SB_Claude_Test`), and wrote "hello world" to it via the MCP to confirm write semantics. That's how you de-risk a design.

---

## Eng-review session reports (v1.0 era)

Preserved verbatim because they document the formal process the original
plan went through — useful for future eng-review skill calibration.

### Completion Summary

- **Step 0 (Scope Challenge):** scope accepted as-is (correctly sized, no regression needed)
- **Architecture Review:** 10 decisions made (A1-A10)
- **Code Quality Review:** 7 decisions made (CQ1-CQ7)
- **Test Review:** diagram produced, 43 gaps identified, test commitments added to every phase gate, test plan artifact written to `~/.gstack/projects/dent-brain/jasonpreston-unknown-eng-review-test-plan-20260421-110000.md`
- **Performance Review:** 3 decisions (P1-P3), 3 watch-items inline
- **NOT in scope:** section written (17 items explicitly deferred)
- **What already exists:** section written (6 items reused)
- **Failure modes:** 14 enumerated, **2 critical gaps flagged** (FM unreachable handling, FM record deleted detection)
- **Outside voice:** Ran via Claude subagent (Codex unavailable). 3 blind spots surfaced, 8 secondary concerns, 1 null-hypothesis challenge. All raised as AskUserQuestion. 4 decisions made (null hypothesis declined A; install path spike added B; FM conflict resolution B; rollback A).
- **Parallelization:** 3 lanes, 3 parallel at start, then sequential main critical path
- **Lake Score:** 15/17 recommendations chose complete option (only the null-hypothesis and incremental synthesis were declined — both defensible)

**Unresolved decisions:** 0. All AskUserQuestion responses received.

### GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — (codex unavailable) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 10 arch + 7 CQ + 3 perf decisions; 43 test gaps added to phase gates; 2 critical failure gaps flagged |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — (no UI) | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |
| Outside Voice | `Claude subagent` | Brutal plan challenge | 1 | CLEAR | 3 blind spots, 8 secondary, 1 null-hypothesis; all resolved via AskUserQuestion |

**CROSS-MODEL:** Outside voice caught 2 genuine blind spots my review missed (install-path verification breadth; FM-Dent Brain conflict resolution). Both resolved with user decision.

**UNRESOLVED:** 0.

**VERDICT:** ENG CLEARED — ready to implement. Phase 0 + Lane B (FM MCP install) + Lane C (data repo seed) can launch in parallel. Null hypothesis test declined; proceeding with build as planned.

---

## Original "Approaches Considered" (v0.7 → v0.8 design archaeology)

Preserved because future revisions sometimes want to revisit the approach
matrix. v0.8/v0.9 chose Approach B; nothing v1.x changed that decision.

### Approach A: Ship v0.7 as written, with corrections

Push through all 11 phases before first user contact. Correct the
confirmed-facts synthesis mechanism along the way.

- **Pros:** complete system at end.
- **Cons:** ~3 months of dark work before Jeff/Steve touch anything. High risk that the shape is wrong for actual Dent workflow. Signal-detector pattern not in scope until very late.

### Approach B: Ship narrowest useful wedge to Steve (CHOSEN)

Evidence log + LLM-synthesized compiled entity pages + Dropbox bulk import + signal-detector + `/append-evidence` + `/flag-fact` + non-technical install. No streams, no intelligence skills, no dream cycle, no server-side cron ingest. Steve on it in ~3-4 focused build weeks.

- **Pros:** real user validates real behavior on the actual product. Signal-detector ships as core MVP UX. Correction log from `/flag-fact` directly drives the post-MVP mechanical-corroboration hardening.
- **Cons:** hallucination risk in confirmed-facts is accepted, mitigated by source-tag backlinks + `/flag-fact`. Materializer cost needs monitoring as evidence density grows. Dropbox classification quality is still the primary ingest-failure surface.

*(v1.8 retrospective: most "Cons" of Approach B turned out moot once we
adopted gbrain's enrich skill instead of building a materializer.
Hallucination risk became "Steve hand-edits if needed" — bounded.
Materializer cost is zero (subscription-funded). `/flag-fact` retired.)*

### Approach C: Notion/Airtable substrate

Skip custom evidence log entirely. Use Notion as the data layer; skills read/write Notion API.

- **Pros:** fastest to ship. Free UI for team.
- **Cons:** kills gbrain-substrate thesis and portability story. Tied to Notion's performance ceiling. Migration cost later is high. Not interesting to build.

---

## Original "Cross-Model Perspective" note (v0.9)

> Second opinion not run this session. Jason has already absorbed adversarial review into v0.7 (correctness metrics §17 are explicitly "the metrics the adversarial review demanded"). Ready to build; defer cross-model check to after a working MVP when there's behavior to critique, not just architecture.

*(v1.8 retrospective: deferred indefinitely; never re-opened. With Phase 3
collapsing to a skill, the architecture surface that would benefit from
cross-model review shrank to near-zero.)*

---

## "The Assignment" pre-build instructions (v1.0 → v1.1)

These were action items for Jason between /plan-eng-review and starting
Phase 0. All resolved or deferred through the v1.x changelog.

**(1) Finish Phase 0.5 — install FM MCP in your own Cowork.** *(DONE in v1.1.)*
Steve's MCP installed, `mcp_jason` account works, Cowork surfaces the tools.

**(1b) Original Lane B steps (now superseded):** 30-60 minutes. You've already seen Steve's demo. Now:
- Get the connector details from Steve (vendor, URL, auth pattern).
- Install in your own Cowork with your own credentials.
- Run all 5 canonical use case queries end-to-end against real FM data. Time them. Note any that exceed 5s.
- Write `FILEMAKER_FEDERATION.md` to the `dent-brain-data` repo.

**(2) Watch Steve use his current workflow for 20 minutes.** Sit behind him (or screen-share) while he does real Dent operations work. Note every moment he searches across Dropbox / Gmail / Slack / FM, asks "did we already do X?", manually types context he's already typed before, copy-pastes between tools, gives up and pings someone on Slack.

**Bonus ask:** show Steve two mocked entity pages — one with compiled truth + FM federation header, one timeline-only. Ask which he'd actually open tomorrow. *(Outcome captured implicitly in the v1.0 decision to keep compiled truth in MVP; v1.8 reshapes that to skill-based.)*

**(3) During MVP build, stage the v1 write-scope decision.** Keep a running note of moments where Steve says "I wish I could add this to FM from here" or "can Dent Brain just put this in my Sticky Notes?" Those moments ARE the v1 write-pattern priority list. Don't build any of them in MVP — just capture them.

---

## Original full v0.9 → v1.7 changelog notes

For complete fidelity, the original full PLAN at the moment of the v1.7
commit is preserved in git history at:

```
git show f19d41d:docs/dent-brain/PLAN.md  # PLAN v1.6
git show 45b99e6:docs/dent-brain/PLAN.md  # Phase 1 closeout
git show 72492ea:docs/dent-brain/PLAN.md  # Phase 0 closeout (v1.5)
git show b32ad1d:docs/dent-brain/PLAN.md  # PLAN v1.7 (most recent pre-trim)
```

If anything in this audit trail looks ambiguous, those commits are the
authoritative source for the original wording.
