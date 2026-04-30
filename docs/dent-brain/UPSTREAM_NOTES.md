# Upstream Notes

Known quirks and caveats in the gbrain substrate (`garrytan/gbrain`) that affect our fork. Not bugs we need to fix — just things to be aware of.

---

## Claude Desktop's Claude Code mode reads `~/.claude.json` (2026-04-29, supersedes 2026-04-27 finding)

**Empirical result:** Claude Desktop's embedded Claude Code mode DOES read `~/.claude.json`. An MCP registered via `claude mcp add` (standalone CLI, bearer + custom headers) appears in tool listings inside Claude Desktop's Claude Code mode and is fully invokable. Same token name shows up in the audit log regardless of which surface fired the call.

**Verification (Phase 0 auth-surface test, 2026-04-29):**
- Registered `dent-brain` via `claude mcp add -t http <url>/mcp -H "Authorization: Bearer ..."` from the standalone CLI.
- Opened Claude Desktop, switched to Claude Code mode. Asked the model to list its MCP tools — `dent-brain` appeared under "Custom / Personal."
- Asked the model to call `get_stats`. Audit log recorded `op=tools/call latency=213ms status=success token=dent-brain-jason`. Same token row that the standalone CLI uses.

**Conclusion:** the standalone CLI and Claude Desktop's Claude Code mode share the same `~/.claude.json` registration store. Bearer auth via `claude mcp add` works on both surfaces. **No OAuth needed for the team-use case** (Dent team works in Claude Desktop's Cowork sessions).

**Caveat — not yet tested:** Claude.ai web's "Customize → Connectors" UI was NOT tested in this round. It may still require OAuth for custom connectors registered through the browser. For Dent's MVP this is out of scope (team uses desktop apps, not web).

**Supersedes the 2026-04-27 entry** that claimed Claude Desktop's Claude Code mode doesn't read `~/.claude.json`. That earlier finding was wrong — likely a config or session quirk in that test, not a structural property. The OAuth implementation flagged as "Phase 0 closeout" in PLAN.md v1.4 is therefore unnecessary for Dent's MVP. See `docs/dent-brain/TESTS_phase0_auth_surfaces.md` for the test that produced this correction.

**For dbrain forks (OSS posture):** the install model is the same as upstream gbrain — `claude mcp add` per-user with a bearer token. No OAuth issuer to deploy, no consent UI, no DCR. ChatGPT integration (if/when desired) would still require OAuth 2.1 per gbrain's README, but that's a different conversation.

---

## Postgres connection pool wedges with prepared statements under PgBouncer transaction mode (2026-04-27)

**Symptom:** `/health` (no DB) responds in <100ms. `/ready` (`SELECT 1`) and `/mcp` tool calls timeout at 30s. First query or two might succeed; subsequent queries hang the entire pool.

**Root cause:** Supabase's transaction-mode pooler (port 6543) routes each query to a possibly-different backend connection. `postgres.js` defaults to using prepared statements, which are bound to a specific backend. Under transaction-mode pooling, prepared statements either fail silently or wedge the pool when the backend they were prepared on isn't available.

**Fix:** set `prepare: false` on the `postgres()` config when DATABASE_URL points at the pooler. Detect via `:6543` or `pooler.supabase.com` substring.

**Convention:** gbrain's `PostgresEngine` does this automatically via `resolvePrepare(url)` in `src/core/db.ts`. Our HTTP MCP wrapper's separate `authDb` connection didn't inherit the convention — added in `src/dent/server/http-mcp.ts` post-deploy.

**Lesson for any new direct-postgres connection in this repo:** always check the convention. Don't construct a fresh `postgres()` without thinking about pooler-mode prepare.

---

## Test suite: 3 flaky tests under full-suite run (2026-04-22)

**Symptom:** Running `bun test` in full-suite mode, 3 tests fail deterministically with `beforeEach`/`afterEach` hook timeouts around 6.8-7s:

- `test/extract-fs.test.ts`
- `test/e2e/search-quality.test.ts`
- `test/e2e/graph-quality.test.ts`

**Diagnosis:**
- All 3 files **pass** when run in isolation (`bun test test/extract-fs.test.ts` — 24/24 in 2.1s).
- They use heavy PGLite setup in `beforeAll` hooks — each spins up an in-process Postgres and runs 14 migrations.
- Under the full 2154-test suite (116 files, ~78s total), these 3 tests' setup hooks contend for resources and hit Bun test runner's default timeout (appears to be ~5-7s).
- Classic pattern for PGLite-heavy test suites. Not a correctness issue; a concurrency/resource issue.

**Impact on Dent Brain:**
- Zero. We haven't added any code yet, so this is purely an upstream gbrain quirk.
- Pass rate is 99.86% (1972/1975 active tests, excluding skips).

**When we add our own tests (`src/dent/`, `test/dent/`):**
- Run our tests separately: `bun test test/dent/` (won't contend with substrate tests).
- If we ever need to run the FULL suite deterministically (e.g., pre-ship), we can bump timeouts for the 3 flaky files or run them serially via test-level config.

**Reproducibility:**
- Determinism verified with 2 full-suite runs on 2026-04-22 (same 3 tests, similar timings).
- Bun version: 1.3.11.

**Not filed upstream yet.** If it becomes annoying in CI, we'll report it to `garrytan/gbrain`. For now, documented here.
