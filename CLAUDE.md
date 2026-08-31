# CLAUDE.md

GBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable engines: PGLite (embedded Postgres via WASM, zero-config default) or Postgres + pgvector + hybrid search on Supabase. `gbrain init` defaults to PGLite. GStack teaches agents how to code; GBrain teaches them everything else — brain ops, signal detection, ingestion, enrichment, cron, reports, identity, access.

## Rules

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Reference map (read on demand)

- `docs/reference/runtime-conventions.md` — which Claude surface (Code Desktop vs Cowork) hosts which skill, and why
- `docs/reference/ingestors.md` — granola-sync + email-sync (laptop daemons) + gws-sync (server-side, metadata-only) quick reference
- `docs/architecture/KEY_FILES.md` — canonical per-file index (current-state, CI-guarded). The older `docs/reference/key-files.md` is a frozen pre-v0.44 snapshot; prefer KEY_FILES.md.
- `docs/reference/testing.md` — full testing handbook (file taxonomy, isolation lint, canonical PGLite block, `withEnv`, inventory)
- `docs/reference/release-ops.md` — version locations, migration policy, CHANGELOG voice, GH Actions SHA pinning, community PR waves, E2E DB lifecycle, bulk progress reporting
- `docs/reference/version-history.md` — commands added per release (CHANGELOG.md is authoritative)
- `docs/architecture/brains-and-sources.md` — brain/source topology
- `docs/CHANGELOG_VOICE.md` — CHANGELOG formatting
- `docs/progress-events.md` — progress JSON event schema
- `docs/dent-brain/DEPLOY.md` — Railway + Supabase deploy steps and the canonical server env-var table (`DENT_BRAIN_*`, `GWS_SYNC_*`)
- `skills/RESOLVER.md` — skill routing table

## Two organizational axes

- **Brain** = which DB. Personal is `host`; mount team brains via `gbrain mounts add`. Routing: `--brain`, `GBRAIN_BRAIN_ID`, `.gbrain-mount`.
- **Source** = which repo inside the DB (wiki/gstack/openclaw/essays). Slugs scope per source. Routing: `--source`, `GBRAIN_SOURCE`, `.gbrain-source`.

Both use the same 6-tier resolution. See `docs/architecture/brains-and-sources.md` and `skills/conventions/brain-routing.md`.

## Architecture

Contract-first: `src/core/operations.ts` defines the shared operations; CLI and MCP server are generated from it. Engine factory (`src/core/engine-factory.ts`) dynamically imports `'pglite'` or `'postgres'`. Skills are fat markdown files, tool-agnostic.
Contract-first: `src/core/operations.ts` defines 100+ shared operations (including `volunteer_context` — push-based context, see `docs/guides/push-context.md` — and the seven frozen MEMORY_VERBS `recall`/`remember`/`entity`/`synthesize`/`forget`/`context_pack`/`delta` — the last two are v0.45.7 ambient-recall boundary verbs (budget-packed pack + "what changed since"), all seven stamp `protocol_version: 1`, servable alone via `gbrain serve --surface verbs`, see `docs/protocol/MEMORY_VERBS_v1.md` + `docs/guides/ambient-recall.md`). CLI and MCP
server are both generated from this single source. Engine factory (`src/core/engine-factory.ts`)
dynamically imports the configured engine (`'pglite'` or `'postgres'`). Skills are fat
markdown files (tool-agnostic, work with both CLI and plugin contexts).

Explore via `ls src/core/`, `ls src/commands/`, `ls src/mcp/` — names are descriptive; read files for detail. Do not maintain a file inventory in this doc; it goes stale fast.

**Cross-cutting invariants (must-never-violate, regardless of which file you touch).**
These used to be buried across the per-file index; they live here so they always load.
Per-file detail is in `docs/architecture/KEY_FILES.md`.

- **Trust is fail-closed.** `OperationContext.remote` is REQUIRED on the type. Anything not
  strictly `false` is treated as remote/untrusted (`ctx.remote === false` for trusted-only
  sites; `ctx.remote !== false` for untrust-unless-explicit-false). Don't default it falsy.
- **Source isolation.** Every read-side op routes through `sourceScopeOpts(ctx)`; precedence
  is federated array (`ctx.auth.allowedSources`) > scalar (`ctx.sourceId`) > nothing. Don't
  hand-roll source filtering — a missed thread is a cross-source data leak. Corollary
  (unscoped-check/scoped-write): `engine.getPage` with no opts matches ANY source while
  `putPage` defaults to `'default'` — an existence check + write pair must scope the read
  to the write's source (`getPage(slug, { sourceId: x ?? 'default' })`). Guarded by
  `scripts/check-getpage-scoped-write.mjs` (opt-out marker
  `gbrain-allow-unscoped-getpage` for read-only first-match sites).
- **Long-flag reads go through `readFlagValue` / `readFlagValues`**
  (`src/core/cli-flag-value.ts`). Never hand-roll argv scanning in a CLI_ONLY command: every
  hand-rolled spelling has matched only the space-separated form and silently DROPPED the
  equals-joined one, so the command fell through to ambient defaults — for `sync --source=`
  that meant writing pages and taking the per-source lock under a source the operator never
  named. `readFlagValue` is first-occurrence-wins; a repeatable flag needs `readFlagValues`
  or every value after the first vanishes. Keep `cli-flag-value.ts` dependency-free and free
  of literal flag tokens: `scripts/generate-flag-registry.ts` follows imports and scrapes
  source text, so a flag token there writes false-permissive rows into
  `cli-flag-registry.generated.ts`. Guarded by `test/cli-flag-idiom-guard.test.ts` (source-text,
  with an allowlist of the sites the sweep has not reached yet) + `test/cli-flag-validation.test.ts`
  — `bun run verify` runs NEITHER, so run them explicitly after touching flag parsing.
- **JSONB: never `JSON.stringify` into a `::jsonb` cast.** postgres.js double-encodes it (a jsonb
  string scalar); PGLite hides the bug. This bites BOTH spellings — the template form
  (`${JSON.stringify(x)}::jsonb`) AND the positional form (`executeRaw(\`…$N::jsonb\`, [JSON.stringify(x)])`,
  the #2339 class that aborted every sync). Fix: pass a raw object to `engine.executeRaw` / use
  `executeRawJsonb` / `sql.json()`; or for the positional path bind through `$N::text::jsonb` (binds as
  text, the cast parses it). Guarded by `scripts/check-jsonb-pattern.sh` (template grep) +
  `scripts/check-jsonb-params.mjs` (positional AST scanner); the real backstop is the DATABASE_URL-gated
  e2e parity tests, since PGLite can't surface the bug. Full rule in `docs/ENGINES.md`.
- **Engine-live paths avoid runtime dynamic `import()` for helper dependencies.** In
  `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, and
  `src/core/migrate.ts`, dependencies previously reached through runtime dynamic
  imports use static top-level imports. Besides the snapshot loader's lazy
  `require()` cluster in `pglite-engine.ts:tryLoadSnapshot` (fs/crypto/
  migrate/pglite-schema + one gateway shape lookup — lazy so production
  builds without the test-fixture path don't eager-load; the guard now
  matches `require()` calls too), the only dynamic-`import()` exceptions
  are the four `ai/gateway.ts` lookups in both engines'
  `initSchema()` and `_upsertChunksOnce()` methods; each remains lazy inside a
  local `try/catch` because the gateway has a large provider/config closure and,
  more importantly, eager evaluation would occur before the catch and could
  turn a recoverable default/config-row fallback into a module-load failure.
  Every exception carries `engine-dynamic-import-ok` on the import line.
  `scripts/check-engine-dynamic-import.sh` enforces the rule. For history, use
  `git log -G'await[[:space:]]+import\\('`, not `git log -S`: a dynamic-to-static
  rewrite can preserve the searched token while changing its context.
- **Engine parity.** `src/core/postgres-engine.ts` and `src/core/pglite-engine.ts` move in
  lockstep — a new method/SQL shape lands in BOTH, pinned by `test/e2e/engine-parity.test.ts`.
  Forward-referenced columns/indexes go in the bootstrap probe set (guarded by
  `test/schema-bootstrap-coverage.test.ts`).
- **Contract-first.** `src/core/operations.ts` is the single source; CLI + MCP are generated
  from it. Every op carries `scope: 'read'|'write'|'admin'` + optional `localOnly`. HTTP
  dispatch enforces scope/localOnly before the handler runs.
- **Migrations.** Schema DDL lives in the `MIGRATIONS` array in `src/core/migrate.ts`.
  `CREATE INDEX CONCURRENTLY` needs `transaction: false` (pre-drop invalid remnants on
  Postgres; plain `CREATE INDEX` on PGLite via `sqlFor.pglite`).
- **Multi-source.** Slug uniqueness is `(source_id, slug)`, not slug. Key batch ops and
  reverse-writes on the composite key; `validateSourceId` before any `source_id` path join.
- **One canonical chat-pricing table.** All paid-cloud chat/completion prices live ONCE in
  `src/core/model-pricing.ts` (`CANONICAL_PRICING` + `canonicalLookup`). Every other table
  (`anthropic-pricing.ts`'s `ANTHROPIC_PRICING`, `takes-quality-eval/pricing.ts`'s
  `MODEL_PRICING`, the contradictions/cross-modal/skillopt cost views) is a DERIVED view, never
  a hand-copied duplicate — so cross-table price drift is structurally impossible. Update a
  price in `model-pricing.ts` only; each consumer keeps its own key allowlist + miss policy
  (fail-closed vs warn-only vs null), not its own numbers. Pinned by `test/model-pricing.test.ts`
  (drift guard asserts each view equals canonical). Embeddings price separately in
  `embedding-pricing.ts` (different unit).
- **Module-size ratchet.** `scripts/module-size-limits.tsv` pins per-file line ceilings
  (`check:module-size` in verify): growth over a ceiling, >50 lines of stale slack after a
  shrink, a row for a deleted file, and any UNLISTED src file over 1,500 lines all fail.
  Raise a ceiling only via a reviewer-visible TSV edit in the same commit; lower it in the
  same commit as any peel. migrate.ts is `region-exempt` (the MIGRATIONS array grows freely;
  the runner logic around it is ratcheted).
- **Peeled façades keep their surface.** operations.ts (`src/core/ops/*`), doctor.ts
  (`src/commands/doctor/*`), sync.ts (`src/core/sync-*`), skillpack.ts
  (`src/commands/skillpack/*`), and both engines
  (`src/core/{postgres,pglite}-engine/*`) are façades re-exporting everything they always
  exported — import sites and published package exports never chase the peel. New code goes
  in the module dirs, not back into the façades. Engine modules take narrow explicit deps
  (never an engine-shaped bag); doctor source-text guards read `test/helpers/doctor-source.ts`,
  and the flag-registry generator's `facadeExpansion` keeps peeled flag text in each command's
  scan surface.
- **Coverage is measured, honestly.** CI merges per-lane lcov (`scripts/merge-lcov.ts`) into
  a PR-corpus report on every run (advisory until the diff gate graduates via
  `COVERAGE_GATE_ENFORCE`) and a nightly fullCorpus number incl. the full e2e glob. bun
  facts: unique `--coverage-dir` per process (reuse overwrites lcov.info), line records only
  (JSC omits function names), no subprocess coverage (cli.ts is exempt as a documented
  undercount), never-loaded files are a count+list, never fake all-files math.


## Commands & Skills

`gbrain --help` / `gbrain --tools-json` is the source of truth. Read `skills/RESOLVER.md` before brain ops; cross-cutting rules live in `skills/conventions/`, `skills/_brain-filing-rules.md`, `skills/_output-rules.md`.
CLAUDE.md is the always-loaded orientation + dispatcher. Detailed reference loads
on demand — read the linked doc before working in that area. (Same two-layer
pattern gbrain ships for its own skills: thin router in `skills/RESOLVER.md`, fat
detail on demand.)

| When you're working on... | Read first |
|---|---|
| any file in `src/` (what it does + its invariants) | `docs/architecture/KEY_FILES.md` — find the file's entry |
| search / ranking / hybrid / retrieval | `docs/architecture/RETRIEVAL.md` + the `search/*` entries in `KEY_FILES.md` |
| search modes / cost knobs | `docs/guides/search-modes.md` |
| embedding spend gates / cost gate / `spend.posture` / off switches | `docs/operations/spend-controls.md` |
| push-based context (volunteer/watch/reflex window) | `docs/guides/push-context.md` |
| checkpoint compaction / compiled context files (`gbrain compile-context`) | `docs/guides/checkpoint-compaction.md` + `docs/guides/ambient-recall.md` |
| schema packs / page types / extraction | `docs/architecture/schema-packs.md`, `type-taxonomy.md`, `lens-packs.md` |
| thin-client / remote MCP / cross-modal | `docs/architecture/thin-client.md` |
| memory verbs / MCP tool surface (`--surface`) / conformance | `docs/protocol/MEMORY_VERBS_v1.md` + the `verbs*`/`surface.ts`/`protocol.ts` entries in `KEY_FILES.md` |
| the CLI surface (commands + flags) | `gbrain --help` / `gbrain --tools-json`, plus the relevant `KEY_FILES.md` entry |
| running or writing tests | `docs/TESTING.md` |
| bulk-command progress wiring | `docs/progress-events.md` |
| eval methodology / metrics | `docs/eval/` |
| brains vs sources / topology | `docs/architecture/brains-and-sources.md`, `topologies.md` |
| skill routing | `skills/RESOLVER.md` |
| agent bootstrap (paste-in install, hooks, `gbrain bootstrap`, sweep, keyless) | `docs/guides/bootstrap.md` + `docs/designs/AGENT_BOOTSTRAP_PLAN.md` + the KEY_FILES bootstrap cluster |
| shipping a release / CHANGELOG / PR conventions | `docs/RELEASING.md` (ship IRON RULES stay inline below) |

The per-file index (`## Key files`), the thin-client routing seam, and the testing
discipline used to live inline here. They moved to the docs above so this file
stays small enough to load every session. Nothing was lost — the pre-move content
is in git, and the docs carry every load-bearing invariant (compressed to
current-state).

## Maintaining CLAUDE.md and the reference docs

CLAUDE.md grew to ~592KB / ~147k tokens once the per-file index became append-only
(one `**vX.Y.Z:**` clause per release per file). That is the exact anti-pattern
gbrain exists to fix. The rules that keep it from recurring:

- **CLAUDE.md is orientation, not the implementation spec.** It carries the North
  Star, the two axes, architecture + cross-cutting invariants, the resolver, and
  the inline IRON RULES. Per-file/per-command/per-test detail lives in the
  reference docs and loads on demand.
- **Reference docs (`KEY_FILES.md`, `thin-client.md`, `TESTING.md`) describe
  CURRENT behavior only.** Release history goes in `CHANGELOG.md` + git. Do NOT
  append `**vX.Y.Z (#NNN):**` clauses, codex/review tags, or "pre-fix/then/was-now"
  narration. When a file's behavior changes, UPDATE its entry to the new truth.
- **CI is the enforcement, not this prose.** `scripts/check-key-files-current-state.sh`
  (in `bun run verify`) fails on the bolded-release-clause marker in the reference
  docs AND on a CLAUDE.md size cap. A written rule caused this disease; a guard
  cures it.
- **After any CLAUDE.md or reference-doc edit, run `bun run build:llms`** — the
  llms bundle inlines/links these (config in `scripts/llms-config.ts`); the
  freshness + budget test (`bun test test/build-llms.test.ts`) fails CI otherwise.

## Search Mode (v0.32.3)

GBrain ships three named search modes that bundle the search-lite knobs from
PR #897 into a single config key. Pick one at install time; the rest of the
project resolves through `src/core/search/mode.ts`.

| Knob                          | `conservative` | `balanced` | `tokenmax`     |
|-------------------------------|----------------|------------|----------------|
| `cache.enabled`               | true           | true       | true           |
| `cache.similarity_threshold`  | 0.92           | 0.92       | 0.92           |
| `cache.ttl_seconds`           | 3600           | 3600       | 3600           |
| `intentWeighting`             | true           | true       | true           |
| `tokenBudget`                 | **4000**       | **12000**  | **off**        |
| `expansion` (LLM multi-query) | false          | false      | **true**       |
| `relationalRetrieval`         | false          | **true**   | **true**       |
| `searchLimit` default         | 10             | 25         | 50             |

**Cost anchors (downstream agent input cost — gbrain itself is rounding error).**
The corner-to-corner spread is 25x once you pair mode with downstream model.
Chunks ~400 tokens avg. Per-query cost @ 10K queries/month (typical
single-user volume), full search payload, no cache savings:

| Mode \ Downstream | Haiku 4.5 (\$1/M) | Sonnet 4.6 (\$3/M) | Opus 4.7 (\$5/M) |
|---|---|---|---|
| conservative (~4K) | **\$40/mo** | \$120/mo | \$200/mo |
| balanced (~10K) | \$100/mo | \$300/mo | \$500/mo |
| tokenmax (~20K) | \$200/mo | \$600/mo | **\$1,000/mo** |

Scales linearly: multiply by 10 for 100K/mo (heavy power user / multi-user
fleet); divide by 10 for 1K/mo (light usage). Natural pairings span ~4x.
Mismatches (tokenmax+Haiku, conservative+Opus) waste capacity differently
— too-big payload overwhelms a cheap model; too-small payload starves an
expensive one.

tokenmax adds ~\$1.50 per 1K queries in Haiku expansion calls on top of
the matrix (\$15/mo @ 10K). Cache hits cut all numbers ~50%. **The matrix
has three verbatim homes: this section, the `gbrain init` picker copy
(`src/commands/init-mode-picker.ts`), and `INSTALL_FOR_AGENTS.md` Step
3.5** — update all three when refreshing.

**Per-query math vs real-world spend.** The matrix above is what an
isolated benchmark would measure. Real agent loops with disciplined
Anthropic prompt caching see 50-80% discount on top (cache hits skip
downstream entirely). The realistic-scale anchor in
`docs/eval/SEARCH_MODE_METHODOLOGY.md` walks the natural pairings at
single-power-user volume (~860 turns/mo): tokenmax+Opus ~\$700/mo,
balanced+Sonnet ~\$430/mo, conservative+Haiku ~\$170/mo. Setups WITHOUT
cache-aware prompt layout (frequent prefix churn) see the per-query
matrix dominate — mode + model choice matters more there.

**Resolution chain** (matches the v0.31.12 model-tier pattern at
`src/core/model-config.ts:resolveModel`):

    per-call SearchOpts → per-key config (search.cache.enabled, …) →
      MODE_BUNDLES[search.mode] → MODE_BUNDLES.balanced (fallback)

Mode resolution lives in **bare `hybridSearch`** (NOT just the cached wrapper)
per `[CDX-5+6]` in `~/.claude/plans/lets-take-a-look-validated-parrot.md` — so
`gbrain eval replay` and `gbrain eval longmemeval` test the same mode-affected
behavior as the production `query` op.

**Cache-key contamination hotfix `[CDX-4]`:** migration v56 added a
`knobs_hash` column to `query_cache`. The lookup filter is now
`WHERE source_id = $ AND knobs_hash = $ AND embedding similarity < $` so a
tokenmax write (expansion=on, limit=50) can't be served to a conservative
read.

**v0.36.3.0 knobs_hash v=2 → v=3.** The hash now folds the active
embedding column name + provider into the cache key, so a query routed
through `embedding_voyage` (1024d Voyage) can't be served a cache row
written against `embedding` (1536d OpenAI). Existing v=2 rows become
unreachable on first re-query (one-time miss spike on upgrade);
`mode.ts:KNOBS_HASH_VERSION` is the single source of truth.

**v0.42.34.0 knobs_hash v=9 → v=10.** Folds the `relationalRetrieval` knob +
depth into the cache key so a relational-on result set can't be served to a
relational-off lookup (same contamination class as graph_signals). One-time
miss spike on upgrade.

**Relational retrieval (v0.42.34.0).** `relationalRetrieval` (on for
balanced/tokenmax) adds a fourth recall arm: a relational query ("who invested
in X", "what connects A and B") resolves its seed entity and walks the typed-edge
graph (`src/core/search/relational-recall.ts` + `relational-intent.ts`,
`engine.relationalFanout`), injecting edge-derived answers into RRF. Within-source,
deterministic, mentions-excluded by default, pure no-op for non-relational queries.
The `query` op's `relational` flag forces it on/off per call.

**Three CLI surfaces:**

    gbrain search modes              # what is running, with per-knob attribution
    gbrain search modes --reset      # clear search.* overrides (mode bundle wins)
    gbrain search stats [--days N]   # cache hit rate, intent mix, budget drops
    gbrain search tune [--apply]     # data-driven recommendations

The install picker fires inside `gbrain init` AFTER `engine.initSchema()`
(non-TTY auto-selects). The upgrade banner fires once via `runPostUpgrade`
in `src/commands/upgrade.ts`, gated by `search.mode_upgrade_notice_shown`.

## Eval discipline (v0.32.3)

Every metric printed by any `gbrain eval *` or `gbrain search stats` command
resolves through `src/core/eval/metric-glossary.ts` so industry terms
(`P@k`, `nDCG@k`, `MRR`, `Jaccard@k`) carry a plain-English line in human
output and a `_meta.metric_glossary` block in JSON output (one block per
response per `[CDX-25]`, NOT sibling `_gloss` fields).

The full methodology — datasets, sample selection, pre-registered
expectations, threats to validity, paired-bootstrap + Bonferroni p-value
discipline `[CDX-14]` — lives in `docs/eval/SEARCH_MODE_METHODOLOGY.md`.
Auto-regenerated `docs/eval/METRIC_GLOSSARY.md` is CI-guarded against
drift (`scripts/check-eval-glossary-fresh.sh`).

Per-run records land at `<repo>/.gbrain-evals/eval-results.jsonl` per
`[CDX-23]`. The user's personal `~/.gbrain` brain is NEVER touched —
audit trail lives in the source repo's git history.

## Skills

Read the skill files in `skills/` before doing brain operations. GBrain ships 50+ skills
(the current list lives in `skills/manifest.json`) organized by `skills/RESOLVER.md`
(`AGENTS.md` is also accepted as of v0.19):

**Original 8 (conformance-migrated):** ingest (thin router), query, maintain, enrich,
briefing, migrate, setup, publish.

**Brain skills (ported from an upstream agent fork):** signal-detector, brain-ops, idea-ingest, media-ingest,
meeting-ingestion, citation-fixer, repo-architecture, skill-creator, daily-task-manager.

**Operational + identity:** daily-task-prep, cross-modal-review, cron-scheduler, reports,
testing, soul-audit, webhook-transforms, data-research, minion-orchestrator. As of
v0.20.4, `minion-orchestrator` is the single unified skill for both lanes of background
work (shell jobs via `gbrain jobs submit shell`, LLM subagents via `gbrain agent run`) ...
the prior `gbrain-jobs` skill was merged in, Preconditions are shared, and trigger
routing is narrowed to what the skill actually covers.

**Skillify loop (v0.19):** skillify (the markdown orchestration), skillpack-check
(agent-readable health report).

**Brain-resident skillpacks + advisor (v0.42.47.0, #2180):** A brain repo can carry its
own publishable skillpack (`brain_resident: true` in `skillpack.json` + `schema_pack`);
`gbrain skillpack init-brain-pack` scaffolds one with a 5-section machine-parseable README.
Connecting harnesses discover it on `gbrain sources add` (Topology A advisory, bounded nag
via `nag-state.ts`) and over MCP via the source-scoped `list_brain_skillpack` op +
`get_skill --source_id` (gated by `mcp.publish_skills`). The bundled `gbrain-advisor` skill
+ `gbrain advisor` op compute a ranked, read-only list of high-leverage actions from brain
state (8 collectors in `src/core/advisor/`); `--json`+exit codes for CI/cron, local-only
`--apply <id>` behind confirm, exposed over MCP behind `mcp.publish_advisor` (default off,
read-only on remote). Thin-client binary install stays deferred to PR2 `build_skillpack`.

**Routing-table compression (v0.32.3.0):** `skills/functional-area-resolver/` —
two-layer dispatch pattern for shrinking large AGENTS.md / RESOLVER.md files
(>=12KB) without losing routing accuracy. Replaces one row per skill with one
entry per functional area, where each area declares its sub-skills in a
`(dispatcher for: ...)` clause. The static-prompt analog of hierarchical agent
routing (AnyTool [arXiv:2402.04253](https://arxiv.org/abs/2402.04253), RAG-MCP
[arXiv:2505.03275](https://arxiv.org/html/2505.03275v1), Anthropic Agent Skills
progressive disclosure). Empirically validated across Opus 4.7 / Sonnet 4.6 /
Haiku 4.5: +13 to +17pp over the verbose baseline at 48% the size (25KB → 13KB
on a real fork). The `(dispatcher for: ...)` clause is the load-bearing signal
— strip it and lenient accuracy collapses to 41.7% on Sonnet (the
`resolver-of-resolvers` ablation case). A/B eval surface lives at
`evals/functional-area-resolver/` (outside `skills/` deliberately so the
skillpack bundler doesn't ship eval infrastructure to downstream installs):
gateway-routed TypeScript harness, 20 training + 5 held-out fixtures, strict +
lenient scoring, three committed cross-model receipts in `baseline-runs/`.
Receipt header binds (model, prompt_template_hash, fixtures_hash, harness_sha,
ts) so future contributors can verify reproduction. Companion `rescore.mjs`
re-scores existing JSONL with lenient tolerance for zero API cost. Reproduce
with `cd evals/functional-area-resolver && node harness.mjs --model
{opus|sonnet|haiku}` (~$0.30–1.70 per model). Nine v0.33.x follow-up TODOs
filed for held-out corpus growth, cross-vendor verification, hierarchical
area-of-areas, embedding-based pre-router, and the run-1 vs run-2
prompt-design ablation methodology.

**Operational health (v0.19.1):** smoke-test (8 post-restart health checks with auto-fix
for Bun, CLI, DB, worker, Zod CJS, gateway, API key, brain repo; user-extensible via
`~/.gbrain/smoke-tests.d/*.sh`).

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.

## Bulk-action progress reporting

All bulk commands (doctor, embed, import, export, sync, extract, migrate,
repair-jsonb, orphans, check-backlinks, lint, integrity auto, eval, files
sync, and apply-migrations) stream progress through the shared reporter
at `src/core/progress.ts`. Agents get heartbeats within 1 second of every
iteration regardless of how slow the underlying work is.

Rules:
- Progress always writes to **stderr**. Stdout stays clean for data output
  (`--json` payloads, final summaries, JSON action events from `extract`).
- Non-TTY default: plain one-line-per-event human text. JSON requires the
  explicit `--progress-json` flag.
- Global flags (`--quiet`, `--progress-json`, `--progress-interval=<ms>`)
  are parsed by `src/core/cli-options.ts` BEFORE command dispatch.
- Phase names are machine-stable `snake_case.dot.path` (e.g.
  `doctor.db_checks`, `sync.imports`). Documented in
  `docs/progress-events.md`; additive changes only.
- `scripts/check-progress-to-stdout.sh` is a CI guard that fails the build
  if any new code writes `\r` progress to stdout. Wired into `bun run test`.
- Minion handlers pass `job.updateProgress` as the `onProgress` callback
  to core functions (DB-backed primary progress channel); stderr from
  `jobs work` stays coarse for daemon liveness only.

When wiring a new bulk command: `import { createProgress } from '../core/progress.ts'`
and `import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts'`.
Create a reporter with `createProgress(cliOptsToProgressOptions(getCliOptions()))`,
`start(phase, total?)` before the loop, `tick()` inside it, `finish()` after.
For single long-running queries, use `startHeartbeat(reporter, note)` with a
try/finally to guarantee cleanup. Never call `process.stdout.write('\r...')`
in bulk paths, the CI guard will fail the build.

## Capturing test output (NEVER pipe through `tail` / `head`)

**Iron rule:** when running `bun test`, `bun run test:e2e`, `bun run typecheck`,
or any other test/check command, redirect to a file FIRST, then `tail` the file
separately:

```bash
# RIGHT — full output preserved, real exit code visible
bun test > /tmp/ship_units.txt 2>&1
echo "EXIT=$?"
tail -50 /tmp/ship_units.txt
grep -E '(fail\)|✗|error:' /tmp/ship_units.txt | head -30
```

```bash
# WRONG — exit code is `tail`'s (always 0), failures truncated, ship gates fail open
bun test 2>&1 | tail -10
```

The pipe form silently breaks /ship Step T1 (test failure ownership triage) and
the test verification gate (Step 16) because:
- `$?` after a pipe is the LAST command's exit code (`tail` → 0), not bun's
- bun prints failure details before the summary line, so `tail -N` drops them
- Step T1 needs the full failure list to classify in-branch vs pre-existing

This bit us during v0.26.2 ship: `bun test 2>&1 | tail -10` reported "3911 pass / 23 fail"
but no failure details survived, forcing a 23-minute re-run to triage.

Apply the same pattern to any long-running command whose exit code matters:
`bun run typecheck`, `bun run ci:local`, migration runs, eval suites, etc.
For background tasks (`run_in_background: true`), the harness captures the exit
file separately — use it via the bg task's `<id>.exit` file, not the streamed
output.

## Sync resumability + lock tuning (v0.42.x, #1794)

`gbrain sync` is resumable and converges under pool exhaustion + repeated kills.
Progress banks into the append-only `op_checkpoint_paths` table (one row per drained
path, written via the direct session pool so it survives `EMAXCONNSESSION`); a killed
run resumes from the checkpoint and `last_commit` only advances on true completion. The
per-source lock heartbeats through the direct pool and refuses to steal a live,
recently-refreshed holder. Six env knobs tune it (all env-only, incident-time escape
hatches — no config-dashboard surface by design):

| Env var | Default | What it does |
|---|---|---|
| `GBRAIN_SYNC_CHECKPOINT_EVERY` | 1000 | Flush the checkpoint every N drained files. |
| `GBRAIN_SYNC_CHECKPOINT_SECONDS` | 10 | Also flush every N seconds (whichever comes first) — bounds worst-case loss regardless of throughput. Flush also fires after the first file. |
| `GBRAIN_SYNC_MAX_CHECKPOINT_FAILURES` | 3 | Consecutive failed flushes (each already retried ~12s) before the run aborts with `reason: 'checkpoint_unavailable'` instead of importing work it can never bank. |
| `GBRAIN_SYNC_YIELD_EVERY` | 64 | Yield the event loop (`setTimeout(0)`, NOT `setImmediate` — Bun starves the timers phase under a tight setImmediate loop) every N files so the lock-refresh `setInterval` heartbeat fires mid-import. |
| `GBRAIN_LOCK_STEAL_GRACE_SECONDS` | derived (~600 at 30min TTL) | A holder that refreshed within this window is NOT stolen even if its TTL lapsed (starved-but-alive). Dead holders stop refreshing, age past the grace, and become stealable; TTL stays the backstop. |
| `GBRAIN_SYNC_STALL_ABORT_SECONDS` | 900 | Progress-aware stall watchdog (#1950): if the import drain makes no forward progress (keyed on file-import progress, NOT the lock heartbeat) for N seconds, abort the run and release the per-source lock so the next `gbrain sync` resumes from the checkpoint. Reports `reason: 'stall_timeout'`. Observed BETWEEN files; a hang inside one file's import isn't interrupted until it returns (the wall-clock hard deadline is that backstop). 0 disables. |

## Pace Mode (DB-contention-aware backfill pacing)

A naive `gbrain embed --stale` / large `sync` can saturate a PgBouncer
transaction-mode pooler and starve the minion supervisor's lock renewals
(`lock-renewal-failed` → dead jobs). Pacing is the native, composable fix — it
replaces external SIGSTOP/SIGCONT wrapper scripts. **Opt-in: default mode `off`.**

The composable primitive is `src/core/db-pacer.ts` (`createDbPacer`):
- **Concurrency cap is the real lever** (caps simultaneous in-flight DB writes =
  pooler slots held). Embed paths set their worker count to `maxConcurrency`
  (single pool, no permit); `sync` uses the shared `acquire()` **permit** because
  each parallel worker owns a separate engine (one budget must span pools).
- **In-band signal** (`observe(ms)` EWMA from the work's own queries — never
  blind the way an out-of-band probe pool was). **No probe loop, no
  `probeLatency` engine method.**
- **Cooperative `pace()` sleep** on `setTimeout` (keeps the lock heartbeat
  firing), jittered to avoid a thundering-herd resume. `acquire()`/`pace()` throw
  `AbortError` on cancel; everything else is fail-open (a pacer bug never kills a
  backfill, never throws an unhandledRejection).

Named bundles resolve through `src/core/pace-mode.ts` (`resolvePaceMode`), mirror
of the search-mode pattern but with **env ABOVE config** (incident escape hatch):

    per-call flag → GBRAIN_PACE_* env → config (pace.*) → PACE_BUNDLES[mode] → off

| Knob | off | gentle | balanced | aggressive |
|---|---|---|---|---|
| `maxConcurrency` | (off) | 4 | 8 | 16 |
| `paceAtMs` (EWMA → sleep) | — | 250 | 500 | 1000 |
| `maxSleepMs` (jittered cap) | — | 2000 | 1500 | 1000 |

**Surfaces.** `gbrain embed --stale --pace[=mode]` (bare `--pace` = balanced),
`--pace-max-concurrency=N`. `--background` carries explicit pace OVERRIDES (not
the resolved bundle) into the `embed` job payload; the handler re-resolves
env>config>bundle at execution so `GBRAIN_PACE_*` still wins (CX5). Config-level
`pace.mode` paces EVERY `runEmbedCore` caller (cycle embed, embed-catch-up,
sync-auto-embed) and the prod `embed-backfill` job automatically. `sync` reads
env/config. PGLite / mode `off` → no-op pacer.

**Correctness fixes pacing bundles** (longer paced runs widen these): CLI
`embed --stale` single-flights via the SAME per-source lock key as the
`embed-backfill` handler (`src/core/embed-backfill-lock.ts`; all-source runs lock
every source in sorted order) so a hand-run backfill and a queued job can't race
the NULL→non-NULL upsert (`TODOS:2299`); a **bounded** end-of-run keyset re-entry
(max 3 + forward-progress, paced runs only) catches rows inserted behind the
cursor (`TODOS:2301`); and the embed wall-clock budget timer is re-armed around
`pace()` sleeps so paced time doesn't burn the work budget.

`EmbedResult.pacing` carries the end-of-run telemetry (cap, samples, EWMA, slept
ms, max waiters) for `--json`; a one-line summary prints to stderr.

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Testing — command tiers

| Command | Scope | When |
|---|---|---|
| `bun run test` | Parallel unit fast loop (4-shard), then `*.serial.test.ts`. Excludes slow + e2e. **~23–32 min** (~10,700 tests; two runs measured 2026-08-11/12 at 1,394s and 1,915s). | Not an inner edit loop any more — run targeted files while iterating, this before pushing. |
| `bun run verify` | `check:privacy && check:jsonb && check:progress && check:wasm && typecheck`. ~12s. | Before pushing. |
| `bun run test:full` | verify + test + test:slow + smart e2e. | Pre-PR sanity. |
| `bun run test:slow` | `*.slow.test.ts` only. | Touching slow-path code. |
| `bun run test:serial` | `*.serial.test.ts` at `--max-concurrency=1`. | Debugging quarantined files. |
| `bun run test:e2e` | Real Postgres. Requires Docker + `DATABASE_URL`. | Pre-ship / nightly. |
Every release advances the version in **every file in the table below at
once**. Keep these in sync. `/ship` enforces this via Step 12's idempotency check (VERSION vs
package.json drift), but the canonical list lives here so future runs and
the auto-update agent know where to look.

`gstack-version-bump write` only touches `VERSION` and `package.json`; the other
five are manual. Run `bun run verify` after any bump — `check:bootstrap-tag` and
`check:bootstrap-templates` fail on stamped surfaces that lag the version.

**Version format is mandatory: `MAJOR.MINOR.PATCH.MICRO` (four numeric
segments, dot-separated, no leading `v`).** Every new release MUST use the
4-segment form. The `.MICRO` slot is the dot-suffix follow-up channel: when
a release ships its commit subject ahead of its VERSION bump (e.g. PR #795
landing as `v0.31.4` without bumping the file), the corrective ship lands
as `0.31.4.1` rather than churning the patch number to `0.31.5`. Suffixes
like `-fixwave` are still allowed as needed (`0.31.1.1-fixwave`), but the
four numeric segments are required first. Historical 3-segment versions
(`0.31.3`, `0.22.1`) remain valid in `git log` and migration filenames
(`skills/migrations/v0.21.0.md`); do NOT rewrite them. Going forward only.

**Required (every release must update every row):**

| File | What lives there | Format |
|---|---|---|
| `VERSION` | The single source of truth. Read first by `/ship`, the binary, and CI version-gate. | Bare 4-segment string `MAJOR.MINOR.PATCH.MICRO` (e.g. `0.31.4.1`), no leading `v`. |
| `package.json` | Bun/npm package version. `gbrain --version` reads it via the compiled binary's bundled package metadata. CI version-gate cross-checks this against `VERSION` and fails if they drift. | `"version": "0.31.4.1"` |
| `CHANGELOG.md` | Top entry header `## [0.31.4.1] - YYYY-MM-DD` plus the "To take advantage of v0.31.4.1" block. | Standard Keep-a-Changelog header. |
| `TODOS.md` | Any TODO entries that mention "follow-up from vX.Y.Z.W" use the version of the release that filed them. Update only when filing NEW follow-up TODOs. | Inline `vX.Y.Z.W` references in TODO bodies. |
| `CLAUDE.md` | The Key Files section's per-file annotations carry `vX.Y.Z.W (#NNN)` tags noting which release introduced a behavior. Update whenever a wave's annotations get folded in. | Inline `vX.Y.Z.W (#NNN, contributed by @user)` references. |
| `openclaw.plugin.json` | OpenClaw plugin manifest (v0.45.6.0, #4033). Hand-maintained; `test/openclaw-plugin-manifest.test.ts` fails the suite if it drifts from `package.json`. Merges from master auto-resolve it to master's version — re-bump it with the trio. | `"version": "0.50.0.2"` |
| `.codex-plugin/plugin.json` + `.claude-plugin/plugin.json` | Codex + Claude Code plugin manifests. Hand-maintained; `test/codex-plugin-manifest.test.ts` fails the suite when either drifts from `package.json` (the bump is now a FIVE-file lockstep: VERSION, package.json, openclaw.plugin.json, and both plugin manifests). Merges from master auto-resolve them to master's version — re-bump with the version set. **Currently drifted post-merge: both still read `0.46.18.0` and need bumping to `0.50.0.2` before `test/codex-plugin-manifest.test.ts` will pass.** | `"version": "0.50.0.2"` |
| `BOOTSTRAP_FOR_AGENTS.md` | Runbook stamp on line 1. `scripts/check-bootstrap-tag.sh` (in `bun run verify` + CI) fails when it drifts from `VERSION`; refresh it in the same commit as the bump. | `<!-- gbrain-runbook-stamp: 0.50.0.2 -->` |
| `templates/bootstrap/template-repo/` | Vendored template tree with an embedded version stamp. Auto-derived, but NOT by `bun install`: run `bun run scripts/generate-template-repo.ts --out templates/bootstrap/template-repo` after the bump; `scripts/check-bootstrap-templates.sh` fails CI on drift. | `<!-- gbrain-template-stamp: X.Y.Z.W -->` in generated files. |

File taxonomy: `*.test.ts` (parallel), `*.slow.test.ts` (cold-path), `*.serial.test.ts` (cross-file-state quarantine), `test/e2e/*.test.ts` (real Postgres). See `docs/reference/testing.md` for isolation lint (R1–R4), canonical PGLite block, `withEnv` pattern, and the full inventory.

**Runtime reality check (2026-08-11).** The `~85s` this table carried for `bun run test`
was badly stale — an actual run is **~23 minutes** (1,394s parallel across 8 shards, then
67 serial files). Budget for that: pipe to a file and run it in the background rather than
blocking on it, and iterate with targeted `bun test <file>` instead. If you need a number
to plan around, `verify` (~12s) and a single test file (~3s) are the fast gates; the full
suite is a pre-push gate, not an inner-loop one.

Auto-derived files that also drift on a version bump (regenerate, don't hand-edit):
- `plugin/` + `plugin-variants/` — the committed codex/claude plugin skill
  tree AND the persona variant trees (gbrain-coding, gbrain-daily) embed a
  `gbrain-plugin-tree-stamp: X.Y.Z.W` (the variants' generated plugin
  manifests carry the version too), so every version bump drifts them.
  Regenerate after the bump — but **NEVER with `--out plugin` on this fork.**
  The generator wipes its output dir, and `plugin/` also holds fork-owned paths
  (`plugin/manifest.json`, `plugin/marketplace/`, `plugin/fm-mcp/`) that
  `bun run build:plugin` layers on top; `--out plugin` deletes them (measured:
  50 tracked files, including the hand-maintained `manifest.json`). Generate to
  a tmpdir and copy back only what the generator owns — `README.md` + `skills/`
  — exactly the set `PLUGIN_TREE_EXCLUDES` in `scripts/check-plugin-tree.sh`
  compares:

  ```bash
  TMP=$(mktemp -d) && bun run scripts/generate-plugin-tree.ts \
    --out "$TMP/plugin" --variants-out "$TMP/plugin-variants"
  cp "$TMP/plugin/README.md" plugin/README.md
  rm -rf plugin/skills && cp -R "$TMP/plugin/skills" plugin/skills
  rm -rf plugin-variants && cp -R "$TMP/plugin-variants" plugin-variants
  rm -rf "$TMP"
  ```

  `plugin-variants/` IS entirely generator-owned, so it copies wholesale. Run
  `build:plugin` AFTER this, never before — it writes `plugin/marketplace/`.
  (Guarded by `scripts/check-plugin-tree.sh` in `bun run verify`; the release
  `publish-codex-plugin` job also drift-gates it before publishing.)
- `bun.lock` — root-package version is auto-pinned from `package.json`. After
  bumping `package.json`, run `bun install` to refresh the lockfile.
- `llms-full.txt` / `llms.txt` — auto-generated documentation bundles. **Any
  CLAUDE.md edit MUST be followed by `bun run build:llms` in the same commit
  (or a follow-up commit before push).** The committed bundles are checked
  against fresh generator output by `test/build-llms.test.ts`, which runs in
  CI shard 1. If you edited CLAUDE.md and didn't regenerate, CI will fail.
  This has bitten the wave 3 times — every CLAUDE.md edit gets a `bun run
  build:llms` chaser, no exceptions. (The `verify` gate doesn't run this
  test; only the full unit suite does. So `bun run typecheck` clean is NOT
  enough to know you can push after a CLAUDE.md edit.)

### Iron rule: capturing test output

**Never pipe `bun test` / `bun run test:e2e` / `bun run typecheck` through `tail` or `head`.** The pipe form returns `tail`'s exit code (always 0) and drops failure detail before the summary, breaking /ship gates.

```bash
# RIGHT
bun test > /tmp/units.txt 2>&1
echo "EXIT=$?"
tail -50 /tmp/units.txt
```

```bash
# WRONG
bun test 2>&1 | tail -10
```

### E2E DB lifecycle

You own spin-up and tear-down of `gbrain-test-pg`. Don't leave containers running, don't skip E2E, don't ask permission — short lifecycle (~30s startup, sub-minute tests, instant teardown), high gate value. Full steps in `docs/reference/release-ops.md`.

**Sourcing API keys:** `source ~/.zshrc 2>/dev/null || true` before running tests so `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` load. Tier 2 tests silently skip without them.

## Bulk-action progress reporting

All bulk commands stream through `src/core/progress.ts` — heartbeats within 1s. Progress writes to **stderr** only (stdout stays clean for `--json`). Phase names are stable `snake_case.dot.path`. See `docs/reference/release-ops.md` and `docs/progress-events.md`.

## Pre-ship requirements

**CI is the gate, not your laptop.** Push the branch and require green on the `Test` and
`E2E Tests` workflows for the SHA you intend to merge. Locally, run `bun run verify` (~12s)
plus the test files your diff touches. Do NOT run the full `bun test` or `bun run test:e2e`
locally as a ship gate.

Why (measured 2026-08-12): CI runs the same unit suite in **7–9 min** across a 10-shard matrix
on dedicated runners, and E2E in ~3 min. The same suite locally takes **23–32 min** — 4 shards
contending for 14 cores — and the local E2E harness needs a hand-rolled Postgres cluster. That
is ~40 minutes per ship to re-derive an answer CI already has, and it made batching work into
bigger PRs look necessary when it isn't. `docs/reference/testing.md` has said it all along:
*"CI is the ground truth for 'did everything pass.'"*

Three caveats worth knowing:

- **CI does not build the Dockerfile.** No job in `.github/workflows/test.yml` runs `docker build`,
  so a change that breaks the production image passes every check and fails at deploy. This is not
  hypothetical: v0.50.0.0 added a `postinstall` hook that the fork's Dockerfile could not resolve,
  and a fully green board shipped an image that would not build. Treat green CI as evidence about
  the code, not about the container. After touching `Dockerfile`, `.dockerignore`, `package.json`
  lifecycle hooks, or `scripts/`, build it yourself (`docker info` first — the OrbStack daemon is
  usually off). Tracked as a P2 in TODOS.md.

- **Local and CI shard differently** — CI buckets by FNV-1a hash across 10 shards, local uses
  round-robin across 4. Cross-file contamination can therefore appear in one and not the other
  (v0.49.4.0: a gateway-singleton leak killed a local shard while CI stayed green because the
  two files never shared a process). A green CI is the merge gate; a local failure is still a
  real bug worth chasing, not noise to dismiss.
- **Env-sensitive tests fail locally and pass in CI** — anything reading an ambient API key.
  Fix the test's isolation rather than concluding the suite is flaky.

Run the full local suite when you are deliberately hunting a cross-file or environment problem.
Not on every ship.

Before any ship, read **[docs/RELEASING.md](docs/RELEASING.md)** in full. It carries the
full release + contributor process: pre-ship test requirements (`bun run ci:local` / the
E2E lifecycle), the CHANGELOG voice + release-summary template, the "To take advantage of
vX" self-repair block, version migrations, the GitHub Actions SHA refresh, PR conventions,
and the community-PR-wave process. **Use `/ship` — never hand-roll a release.** Every
community wave runs `bun run wave-security-scan <base>..<head>` (RELEASING.md step 5) before
ship — the repeatable mechanical sweep (obfuscation/eval, gitleaks with the test/skills
allowlist stripped, committed `admin/dist` changes as alarms; new endpoints/spawns/env/deps
as context).

**Also required: deploy-drift check.** Run `bun run check:prod-version` at the start of every /ship. The script reads `./VERSION` and hits the production MCP server's initialize handshake; if production reports a lower version than main, the script exits 1. Deploys are automatic as of v0.49.0.0 (see below), so a failure here means the last deploy did not land — check the Actions run before shipping on top of it. Shipping more changes over an un-deployed fix compounds the problem and is exactly how we hit the May 8 → May 12 zombie-reaper recurrence.

## Post-ship requirements (production deploy)

**Deploys are automatic.** `.github/workflows/deploy.yml` runs on every push to `main`: it deploys with `railway up --detach --service dent-brain` using the `RAILWAY_TOKEN` project secret, then polls `/health` until production reports the version in `./VERSION`, failing loudly if it never flips. Railway's native GitHub integration cannot be used here — the repo and the paid Railway app live under different GitHub accounts, so the service's `source.repo` is permanently null — and this workflow bypasses that entirely.

Watch the Actions run rather than deploying by hand. If it fails (expired token, boot failure), the emergency fallback is `railway up --detach` from the repo root — **not** `railway redeploy`, which redeploys the existing image instead of building the new commit. Confirm with `bun run check:prod-version`.

Changing a Railway environment variable also triggers a redeploy on its own; wait for that to settle before deploying again.

## Post-ship requirements (MANDATORY)

After EVERY /ship, run /document-release. Not optional. If /ship's Step 8.5 ran it automatically that counts; otherwise run it manually. Files that MUST be checked: README.md, CLAUDE.md, CHANGELOG.md, TODOS.md, docs/.

## Version locations

Version format is MAJOR.MINOR.PATCH.MICRO (e.g. `0.43.0.1`). The version moves in seven files together: `VERSION`, `package.json`, `CHANGELOG.md`, `openclaw.plugin.json`, `BOOTSTRAP_FOR_AGENTS.md` (line-1 runbook stamp), `TODOS.md` (when filing new follow-ups), `CLAUDE.md` (when folding annotations). Auto-derived (must be regenerated before /ship pushes the version commit): `bun.lock` (via `bun install`), `llms-full.txt` / `llms.txt` (via `bun run build:llms`), `templates/bootstrap/template-repo/` (via `bun run scripts/generate-template-repo.ts --out templates/bootstrap/template-repo`), and the Cowork plugin marketplace bundle — `.claude-plugin/marketplace.json`, `plugin/marketplace/.claude-plugin/plugin.json`, `plugin/marketplace/manifest.lock.json`, `plugin/marketplace/README.md`, `plugin/marketplace/install-local.sh`, and the rendered skill copies under `plugin/marketplace/.claude/skills/` (all via `bun run build:plugin`). **If you skip `build:plugin`, Claude Desktop's plugin UI shows the previous version forever** — the MCP server reports the new version via the initialize handshake, but the plugin metadata stays stale. Do NOT bump historical files (`skills/migrations/v*.md`, migration test files, code comments). See `docs/reference/release-ops.md` for full table and the /ship + CI version-gate semantics.

## CHANGELOG voice

Follow `docs/CHANGELOG_VOICE.md`: release-summary in GStack/Garry voice (headline + lead + numbers + what-this-means), "To take advantage of v[version]" self-repair block, then `### Itemized changes`. v0.12.0 and v0.13.0 are canonical examples.

## Migration policy

Create `skills/migrations/v[version].md` only when existing users must act post-upgrade (new setup step, schema change, changed defaults, deprecated commands, new background processes). Skip for bug fixes, docs, transparent perf, optional new features. **Key test:** will an existing user's brain work worse after upgrading and doing nothing? If yes, write a migration.

**Canonical, not advisory:** if shipping requires "in your AGENTS.md, add..." or "in your cron, rewrite...", the migration orchestrator should do that edit, not the user. Exception: host-specific code (RCE surface) — emit a TODO to `~/.gbrain/migrations/pending-host-work.jsonl`. See `docs/reference/release-ops.md`.

## Privacy rule: scrub real names from public docs

**Never reference real people, companies, funds, or private agent names in any public-facing artifact** (CHANGELOG, README, docs/, skills/, PR titles+bodies, commit messages, checked-in code comments).

Use generic placeholders: `your agent fork` / `agent-fork`, `alice-example` / `a-founder`, `acme-example` / `widget-co`, `fund-a`/`fund-b`/`fund-c`, `acme-seed` / `widget-series-a`, `meetings/2026-04-03`, `you` (never a proper name).

**Never say `Wintermute` in any public artifact.** Use `your OpenClaw` for reader-facing copy; `Garry's OpenClaw` for first-person origin-story copy.

Household-brand companies (Stripe, Brex, OpenAI, GitHub) in illustrative API examples are fine — public entities, not contacts.

**Test:** "Would this reveal private info about the user's contacts/investments/portfolio if a stranger read it?" If yes, replace with placeholders.

## Responsible-disclosure rule: don't broadcast attack surface in release notes

**When a release fixes a security gap or a user-impacting bug, describe the fix
functionally. Do not enumerate the attack surface, quantify the exposure window,
or highlight the most sensitive records by name in public-facing artifacts.**

Public-facing artifacts include: `CHANGELOG.md`, `README.md`, `docs/`, PR titles
and bodies, commit messages, GitHub issue titles and comments, release pages,
tweets, blog posts.

**Don't write:**
- "10 tables were publicly readable by the anon key for months, including X, Y, Z"
- "X and Y are the most sensitive ones"
- "N tables exposed. Fix: enable RLS on these specific tables: ..."

**Do write:**
- "Security hardening pass. Fresh installs secure by default. Existing brains
  brought to the same bar automatically on upgrade."
- "If `gbrain doctor` still flags anything after upgrade, the message names each
  table and gives the exact fix."

Why: anyone reading the release page before they've upgraded now has a directed
probe list for unpatched installs. The source code ships the specifics anyway
(`src/schema.sql`, `src/core/migrate.ts`, test fixtures) — reverse engineers can
get them. But the release page is a broadcast channel. Don't hand attackers a
curated list with a banner.

**The test:** if a reader with no prior context could read the release note and
walk away knowing "gbrain at version X has table Y readable by anon key until
they patch," the note is too specific. Rewrite until that's no longer possible.

**What IS fine in public artifacts:**
- The mechanism of the fix ("the check now scans every public table instead of
  a hardcoded allowlist").
- User-facing operator ergonomics (the escape-hatch SQL template, the upgrade
  commands, the breaking-change flag).
- Credit to contributors.
- Generic framing of severity ("security posture tightening pass") without
  quantification.

**What stays in private artifacts (plan files, private memories, internal docs):**
- Specific table names, record counts, exposure duration.
- Which records stand out as highest-risk.
- Detailed before/after tables in the "numbers that matter" format.

If the CEO/Eng review of a plan produces a detailed exposure table, keep it in
the plan file under `~/.claude/plans/` or `~/.gstack/projects/`. Don't copy it
into the CHANGELOG or PR body.

Applies retroactively: if you see a prior CHANGELOG entry naming attack-surface
specifics, scrub it as a small cleanup commit, the same way a stale Wintermute
reference gets swept.

## GitHub Actions SHA pinning

All actions in `.github/workflows/` pin commit SHAs. Before /ship or /review, check for drift — see the script in `docs/reference/release-ops.md`.

## PR descriptions cover the whole branch

PR title + body describes EVERYTHING in `<base>..<head>`, not just the last commit. Walk `git log --oneline <base>..<head>` first. Group by feature area (schema/code/tests/docs), not chronologically.

## Community PR wave process

Never merge external PRs directly. Categorize → dedupe → cherry-pick or re-implement onto a collector branch → test the wave with full E2E → close originals with context and `Co-Authored-By:` attribution → ship as one PR. AskUserQuestion before accepting commits that touch voice/tone/promo material. See `docs/reference/release-ops.md`.

## Skill routing

When a user request matches an available skill, ALWAYS invoke it via the Skill tool FIRST. Do not answer directly or use other tools first.

**NEVER hand-roll ship operations** — invoke /ship and let it handle VERSION bump, CHANGELOG, document-release, pre-landing review, test coverage audit, adversarial review, commits, push, and PR. Branch names containing a version (e.g. `v0.5-live-sync`) drive the bump.

Routing:
- product ideas / "worth building" / brainstorming → office-hours
- bugs, errors, "why broken", 500s → investigate
- ship / deploy / push / create PR / "commit and ship" → ship
- QA / find bugs / test the site → qa
- code review / "check my diff" → review
- post-ship doc sync → document-release
- weekly retro → retro
- design system / brand → design-consultation
- visual audit / design polish → design-review
- architecture review → plan-eng-review
- checkpoint / save / resume → checkpoint
- code quality / health → health
