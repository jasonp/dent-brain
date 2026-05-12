# Version history: commands added per release

Per-version command additions, extracted from CLAUDE.md. Authoritative source is CHANGELOG.md; this file is a quick-lookup index by version. `gbrain --help` is the runtime source of truth.

Key commands added in v0.28.1 (LongMemEval in the box):
- `gbrain eval longmemeval <dataset.jsonl>` — run the public LongMemEval benchmark against gbrain hybrid retrieval. Flags: `--limit N`, `--model M`, `--retrieval-only`, `--keyword-only`, `--expansion`, `--top-k K`, `--output FILE`. One in-memory PGLite per benchmark run; `TRUNCATE` between questions over runtime-enumerated `pg_tables` (schema-migration-safe); `~/.gbrain` never opened. `--expansion` defaults OFF (deterministic, no per-query Haiku). Default model resolves through `resolveModel()` 6-tier chain with new `models.eval.longmemeval` config key. `gbrain eval longmemeval --help` works without a configured brain (hermeticity gate).
- Sanitization parity with takes: `INJECTION_PATTERNS` exported from `src/core/think/sanitize.ts`. The benchmark harness re-uses the same pattern set so adding a new injection pattern automatically covers takes AND benchmarks.
- Hand the resulting JSONL to LongMemEval's published `evaluate_qa.py` to score (not bundled — needs OpenAI gpt-4o per their spec). Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval.

Key commands added in v0.26.5 (destructive-guard, end-to-end):
- `gbrain sources archive <id>` — soft-delete a source. Hides from search via the new `sources.archived` column + cascading visibility filter. Preserves data for 72h. (PR #595 cherry-pick.)
- `gbrain sources restore <id> [--no-federate]` — un-archive a soft-deleted source. Re-federates by default.
- `gbrain sources archived [--json]` — list soft-deleted sources with their TTL.
- `gbrain sources purge [<id>] [--confirm-destructive]` — permanent delete; with no id, purges all sources whose TTL expired.
- `gbrain sources remove <id> [--confirm-destructive] [--dry-run]` — `--yes` alone no longer enough on populated sources. Boxed impact preview before destruction.
- `gbrain pages purge-deleted [--older-than HOURS|Nd] [--dry-run] [--json]` — operator escape hatch for page-level soft-delete cleanup. Mirror of `gbrain sources purge`. The autopilot cycle's new `purge` phase calls the same library function automatically every run.
- MCP `delete_page` op semantically shifts from hard-delete to soft-delete. New ops: `restore_page` (`scope: write`), `purge_deleted_pages` (`scope: admin`, `localOnly: true`).
- `get_page` and `list_pages` extended with `include_deleted: boolean` (default false).
- New autopilot cycle phase `purge` (9th, runs after `orphans`). `gbrain dream --phase purge` runs only the purge sweep.
- Index strategy note: the partial index `pages_deleted_at_purge_idx ON pages (deleted_at) WHERE deleted_at IS NOT NULL` supports the autopilot purge query. Search filters (`WHERE deleted_at IS NULL`) do NOT need their own index — soft-deleted cardinality stays low and Postgres won't use the partial index for the negative predicate. Don't add a regular `(deleted_at)` index without measuring.
- Schema migration v34 (`destructive_guard_columns`) adds `pages.deleted_at` + the partial purge index; promotes `archived` from `sources.config` JSONB to real columns; backfills any pre-v0.26.5 JSONB shape.

Key commands added in v0.25.0:
- `gbrain eval export [--since DUR] [--limit N] [--tool query|search]` — stream captured `eval_candidates` rows as NDJSON to stdout. Every line starts with `"schema_version": 1` per the stable contract in `docs/eval-capture.md`. EPIPE-safe, progress heartbeats on stderr, deterministic ordering. Primary consumer is the sibling `gbrain-evals` repo for BrainBench-Real replay.
- `gbrain eval prune --older-than DUR [--dry-run]` — explicit retention cleanup for `eval_candidates`. Requires `--older-than` (never deletes without a window). Duration strings: 30d, 7d, 1h, 90m, 3600s.
- `gbrain eval replay --against FILE.ndjson [--limit N] [--top-regressions K] [--json] [--verbose]` — contributor-facing dev loop. Reads a captured NDJSON snapshot, re-runs each `query` / `search` op against the current brain, computes mean set-Jaccard@k between captured + current `retrieved_slugs`, top-1 stability rate, and latency Δ. JSON mode (`schema_version: 1`) for CI gating; human mode prints a regression table sorted worst-first. Closes the gap between "data captured" and "data used to gate a PR." See `docs/eval-bench.md` for the workflow.
- `gbrain eval cross-modal --task "..." --output <path> [--cycles N] [--slot-a-model ID] [--slot-b-model ID] [--slot-c-model ID] [--receipt-dir DIR] [--json]` (v0.27.x) — multi-model quality gate. Three different-provider frontier models score the OUTPUT against the TASK on 5 documented dimensions. Pass criterion: every dim mean >=7 AND no model scored any dim <5. Exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE (<2/3 models returned parseable scores). Default cycles=3 in TTY, **cycles=1 in non-TTY** (limits accidental scripted bulk spend). Default slots: `openai:gpt-4o` / `anthropic:claude-opus-4-7` / `google:gemini-1.5-pro` — refresh alongside model-family bumps. Receipts land at `~/.gbrain/.gbrain/eval-receipts/<slug>-<sha8-of-output>.json` (gbrainPath honors GBRAIN_HOME). Bypasses `connectEngine()` via the cli.ts no-DB branch — runs cleanly before `gbrain init`. Reuses `src/core/ai/gateway.ts:chat()` for config/auth (no parallel provider stack). Cost-estimate prints to stderr before each cycle (T11=B partial cost guardrail; full `--budget-usd N` is a follow-up TODO).
- `gbrain doctor` gains an `eval_capture` check: reads `eval_capture_failures` for the last 24h, groups by reason, warns when non-zero. Cross-process visibility (doctor runs in a separate process from MCP). Pre-v31 brains get `Skipped (table unavailable)` — non-fatal.
- Config addition: `eval: { capture?: boolean, scrub_pii?: boolean }` in `~/.gbrain/config.json`. **File-plane only** — `gbrain config set` writes the DB plane and does NOT control capture.
- **`GBRAIN_CONTRIBUTOR_MODE=1` env var** is the contributor-facing toggle. Capture is **off by default** as of v0.25.0; production users get a quiet brain. Resolution order: explicit `eval.capture` config wins both directions, then env var, then off. Documented in README.md, CONTRIBUTING.md, and `docs/eval-bench.md`.

Key commands added in v0.12.2:
- `gbrain repair-jsonb [--dry-run] [--json]` — repair double-encoded JSONB rows left over from v0.12.0-and-earlier Postgres writes. Idempotent; PGLite no-ops. The `v0_12_2` migration runs this automatically on `gbrain upgrade`.

Key commands added in v0.12.3:
- `gbrain orphans [--json] [--count] [--include-pseudo]` — surface pages with zero inbound wikilinks, grouped by domain. Auto-generated/raw/pseudo pages filtered by default. Also exposed as `find_orphans` MCP operation. The natural consumer of the v0.12.0 knowledge graph layer: once edges are captured, find the gaps.
- `gbrain doctor` gains two new reliability detection checks: `jsonb_integrity` (v0.12.0 Postgres double-encode damage) and `markdown_body_completeness` (pages truncated by the old splitBody bug). Detection only; fix hints point at `gbrain repair-jsonb` and `gbrain sync --force`.

Key commands added in v0.14.2:
- `gbrain sync --skip-failed` — acknowledge the current set of failed-parse files recorded in `~/.gbrain/sync-failures.jsonl` so the sync bookmark advances past them. Doctor's `sync_failures` check shows previously-skipped as "all acknowledged" instead of warning.
- `gbrain sync --retry-failed` — re-walk the unacknowledged failures and re-attempt parsing. If the files now succeed, they clear from the set and the bookmark advances naturally.
- `gbrain apply-migrations --force-retry <version>` — reset a wedged migration (3 consecutive partials with no completion) by appending a `'retry'` marker. Next `apply-migrations --yes` treats the version as fresh. `complete` status never regresses to `partial` either before or after a retry marker.
- `GBRAIN_POOL_SIZE` env var — honored by both the singleton pool (`src/core/db.ts`) and the parallel-import worker pool (`src/commands/import.ts`). Default is 10; lower to 2 for Supabase transaction pooler to avoid MaxClients crashes during `gbrain upgrade` subprocess spawns. Read at call time via `resolvePoolSize()`.
- `gbrain doctor` gains two new checks: `sync_failures` (surfaces unacknowledged parse failures with exact paths + fix hints) and `brain_score` (renders the 5-component breakdown when score < 100: embed coverage / 35, link density / 25, timeline coverage / 15, orphans / 15, dead links / 10 — sum equals total).

Key commands added in v0.26.0 (OAuth 2.1 + HTTP server + admin dashboard):
- `gbrain serve --http [--port 3131] [--token-ttl 3600] [--enable-dcr] [--log-full-params]` — HTTP MCP server with OAuth 2.1, admin dashboard at `/admin`, SSE activity feed at `/admin/events`, health check at `/health`. Prints admin bootstrap token on first start. Alongside (not replacing) stdio `gbrain serve`. As of v0.26.9, `mcp_request_log.params` and the SSE feed default to a redacted summary (`{redacted, kind, declared_keys, unknown_key_count, approx_bytes}`); pass `--log-full-params` to log raw payloads on a personal laptop with a startup warning.
- **OAuth client registration** — three paths:
  1. CLI: `gbrain auth register-client <name> --grant-types <types> --scopes <scopes>` (wired into `src/commands/auth.ts` as a thin wrapper over `GBrainOAuthProvider.registerClientManual`). Default grant types: `client_credentials`. Default scopes: `read`.
  2. Admin dashboard: Register client modal → credential reveal with Copy + Download JSON.
  3. SDK: `oauthProvider.registerClientManual(name, grantTypes, scopes, redirectUris)` for programmatic wrappers.
  `--enable-dcr` on `serve --http` opens the `/register` endpoint for RFC 7591 self-service registration (off by default).
- `gbrain auth create|list|revoke|test` — legacy bearer tokens still work and grandfather to `read+write+admin` scopes on the OAuth server. `auth` is wired as a first-class `gbrain` subcommand in v0.26.0 (previously only invokable via `bun run src/commands/auth.ts`). No migration required to keep pre-v0.26 clients working.

Key commands added in v0.14.3 (fix wave):
- `gbrain doctor --index-audit` — opt-in Postgres-only check reporting zero-scan indexes from `pg_stat_user_indexes`. Informational only; never auto-drops.
- `gbrain doctor` schema_version check fails loudly when `version=0` — catches `bun install -g github:...` postinstall failures (#218) and routes users to `gbrain apply-migrations --yes`.
- `gbrain jobs submit` gains `--max-stalled`, `--backoff-type`, `--backoff-delay`, `--backoff-jitter`, `--timeout-ms`, `--idempotency-key` — exposing existing `MinionJobInput` fields as first-class CLI flags.
- `gbrain jobs smoke --sigkill-rescue` — opt-in regression smoke case simulating a killed worker; asserts the v0.14.3 schema default (`max_stalled=5`) actually rescues on first stall.

Key commands added in v0.22.13 (PR #490):
- `gbrain sync --workers N` (alias `--concurrency N`) — parallelize the import phase using per-worker Postgres engines (small pool of 2 each) with an atomic queue index. Auto-concurrency: defaults to 4 workers when the diff exceeds 100 files. Smaller diffs stay serial. Explicit `--workers` always wins (even on a 30-file diff). PGLite forces serial regardless. Validation rejects `0`, negatives, non-integers loud (replaces the prior silent fall-through to auto-concurrency).
- `gbrain import --workers N` — same `parseWorkers()` validation as sync; same try/finally worker-engine cleanup. Behavior surface unchanged.

Key commands added in v0.22.16 (claw-test friction loop):
- `gbrain claw-test [--scenario fresh-install|upgrade-from-v0.18] [--keep-tempdir]` — scripted-mode CI gate that runs the full canonical first-day flow against a fresh tempdir. Asserts every expected `--progress-json` phase fired and doctor's `status === 'ok'`. ~30s, no API keys.
- `gbrain claw-test --live --agent openclaw` — friction-discovery mode. Spawns real openclaw, hands it `BRIEF.md`, captures stdin/stdout/stderr to `<run>/transcript.jsonl`, lets the agent log friction via the friction CLI. Run on demand; ~5–10 min and ~$1–2 in tokens.
- `gbrain claw-test --list-agents` — reports which agent runners are registered + their detection state (binary path or unavailable reason).
- `gbrain friction log --severity {confused|error|blocker|nit} --phase <name> --message <text> [--hint ...] [--kind {friction|delight}] [--run-id ...]` — append a friction or delight entry to the active run JSONL.
- `gbrain friction render --run-id <id> [--json] [--transcripts] [--no-redact]` — markdown report grouped by severity + phase; `--redact` is the default for md output (strips `$HOME`/`$CWD` placeholders so reports paste safely in PRs/issues).
- `gbrain friction list [--json]` — recent run-ids with friction/delight counts; interrupted runs marked `(interrupted)`.
- `gbrain friction summary --run-id <id> [--json]` — two-column friction + delight summary.
- `GBRAIN_HOME` env override is now honored uniformly across every gbrain write site (config, audit, friction, sync-failures, import checkpoint, integrity log, integrations heartbeat, migration rollback, etc.) — `gbrainPath(...)` from `src/core/config.ts` is the canonical helper. Read-side host-fingerprint detection (`~/.claude`/`~/.openclaw` etc.) intentionally NOT confined in v1; that's a v1.1 follow-up.
