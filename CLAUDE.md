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

## Reference files (read on demand)

- `docs/reference/runtime-conventions.md` — which Claude surface (Code Desktop vs Cowork) hosts which skill, and why
- `docs/reference/ingestors.md` — granola-sync + email-sync quick reference
- `docs/reference/key-files.md` — per-file change annotations (drifts fast; prefer `git log` / reading the file)
- `docs/reference/testing.md` — full testing handbook (file taxonomy, isolation lint, canonical PGLite block, `withEnv`, inventory)
- `docs/reference/release-ops.md` — version locations, migration policy, CHANGELOG voice, GH Actions SHA pinning, community PR waves, E2E DB lifecycle, bulk progress reporting
- `docs/reference/version-history.md` — commands added per release (CHANGELOG.md is authoritative)
- `docs/architecture/brains-and-sources.md` — brain/source topology
- `docs/CHANGELOG_VOICE.md` — CHANGELOG formatting
- `docs/progress-events.md` — progress JSON event schema
- `skills/RESOLVER.md` — skill routing table

## Two organizational axes

- **Brain** = which DB. Personal is `host`; mount team brains via `gbrain mounts add`. Routing: `--brain`, `GBRAIN_BRAIN_ID`, `.gbrain-mount`.
- **Source** = which repo inside the DB (wiki/gstack/openclaw/essays). Slugs scope per source. Routing: `--source`, `GBRAIN_SOURCE`, `.gbrain-source`.

Both use the same 6-tier resolution. See `docs/architecture/brains-and-sources.md` and `skills/conventions/brain-routing.md`.

## Architecture

Contract-first: `src/core/operations.ts` defines the shared operations; CLI and MCP server are generated from it. Engine factory (`src/core/engine-factory.ts`) dynamically imports `'pglite'` or `'postgres'`. Skills are fat markdown files, tool-agnostic.

Explore via `ls src/core/`, `ls src/commands/`, `ls src/mcp/` — names are descriptive; read files for detail. Do not maintain a file inventory in this doc; it goes stale fast.

**Trust boundary:** `OperationContext.remote` distinguishes trusted local CLI callers (`remote: false`, set by `src/cli.ts`) from untrusted agent-facing callers (`remote: true`, set by MCP transports). Security-sensitive ops tighten behavior when remote; missing/undefined is treated as remote (fail-closed).

## Commands & Skills

`gbrain --help` / `gbrain --tools-json` is the source of truth. Read `skills/RESOLVER.md` before brain ops; cross-cutting rules live in `skills/conventions/`, `skills/_brain-filing-rules.md`, `skills/_output-rules.md`.

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Testing — command tiers

| Command | Scope | When |
|---|---|---|
| `bun run test` | Parallel unit fast loop (8-shard), then `*.serial.test.ts`. Excludes slow + e2e. ~85s. | Inner edit loop. |
| `bun run verify` | `check:privacy && check:jsonb && check:progress && check:wasm && typecheck`. ~12s. | Before pushing. |
| `bun run test:full` | verify + test + test:slow + smart e2e. | Pre-PR sanity. |
| `bun run test:slow` | `*.slow.test.ts` only. | Touching slow-path code. |
| `bun run test:serial` | `*.serial.test.ts` at `--max-concurrency=1`. | Debugging quarantined files. |
| `bun run test:e2e` | Real Postgres. Requires Docker + `DATABASE_URL`. | Pre-ship / nightly. |
| `bun run check:all` | All 7 historical pre-checks (superset of `verify`). | Local sweep. |

File taxonomy: `*.test.ts` (parallel), `*.slow.test.ts` (cold-path), `*.serial.test.ts` (cross-file-state quarantine), `test/e2e/*.test.ts` (real Postgres). See `docs/reference/testing.md` for isolation lint (R1–R4), canonical PGLite block, `withEnv` pattern, and the full inventory.

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

Run `bun test` AND `bun run test:e2e` (full DB lifecycle). Both must pass.

**Also required: deploy-drift check.** Run `bun run check:prod-version` at the start of every /ship. The script reads `./VERSION` and hits the production MCP server's initialize handshake; if production reports a lower version than main, the script exits 1 with railway-redeploy instructions. Reason: this project's GitHub → Railway auto-deploy hook is broken, so merges to main do NOT propagate to production automatically. Shipping more changes on top of un-deployed fixes compounds the problem and is exactly how we hit the May 8 → May 12 zombie-reaper recurrence. If the check fails, run `railway redeploy --yes` from the repo root and wait ~90s before retrying.

## Post-ship requirements (production deploy)

After every merge to main, manually run `railway redeploy --yes` from the repo root. The GitHub → Railway integration on this project does not work; merges do not auto-deploy. Confirm the new version reached production by re-running `bun run check:prod-version` (should report in-sync) or by hitting the MCP `initialize` endpoint and reading `serverInfo.version`.

## Post-ship requirements (MANDATORY)

After EVERY /ship, run /document-release. Not optional. If /ship's Step 8.5 ran it automatically that counts; otherwise run it manually. Files that MUST be checked: README.md, CLAUDE.md, CHANGELOG.md, TODOS.md, docs/.

## Version locations

The version moves in five files together: `VERSION`, `package.json`, `CHANGELOG.md`, `TODOS.md` (when filing new follow-ups), `CLAUDE.md` (when folding annotations). Auto-derived (must be regenerated before /ship pushes the version commit): `bun.lock` (via `bun install`), `llms-full.txt` / `llms.txt` (via `bun run build:llms`), and the Cowork plugin marketplace bundle — `.claude-plugin/marketplace.json`, `plugin/marketplace/.claude-plugin/plugin.json`, `plugin/marketplace/manifest.lock.json`, `plugin/marketplace/README.md`, `plugin/marketplace/install-local.sh`, and the rendered skill copies under `plugin/marketplace/.claude/skills/` (all via `bun run build:plugin`). **If you skip `build:plugin`, Claude Desktop's plugin UI shows the previous version forever** — the MCP server reports the new version via the initialize handshake, but the plugin metadata stays stale. Do NOT bump historical files (`skills/migrations/v*.md`, migration test files, code comments). See `docs/reference/release-ops.md` for full table and the /ship + CI version-gate semantics.

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
