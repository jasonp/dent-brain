# Upstream Notes

Known quirks and caveats in the gbrain substrate (`garrytan/gbrain`) that affect our fork. Not bugs we need to fix — just things to be aware of.

---

## Three Claude surfaces, three different MCP-config paths (2026-04-27)

**Surfacing:** When an MCP is added via `claude mcp add` from the standalone Claude Code CLI, it appears in standalone CLI sessions but NOT in Claude Desktop's "Claude Code" feature, NOT in Claude.ai web's Customize → Connectors view.

**Why:** the three surfaces use different config sources:

| Surface | Binary path | Reads | Auth supported |
|---|---|---|---|
| **Standalone CLI** | `~/.local/bin/claude` | `~/.claude.json` | Bearer + headers via `--header` |
| **Claude Desktop's Claude Code** | `~/Library/Application Support/Claude/claude-code/<ver>/claude.app/.../claude` | Per-session `local-agent-mode-sessions/.../local_*.json` files keyed by Cowork connector UUIDs | OAuth (via Cowork cloud) |
| **Claude.ai web** | (no local binary) | Cowork-cloud-managed connectors | OAuth |

**Implication for dbrain (any deployment):** for cross-surface team rollout, OAuth 2.1 client credentials on the server is required. Bearer-with-custom-headers only works for the standalone CLI workflow. This isn't a gbrain quirk — it's how Anthropic structured Claude's surfaces.

**For our deployment:** Phase 0 closeout = implement OAuth on the dent-brain server. The MCP SDK ships `@modelcontextprotocol/sdk/server/auth/` provider implementations that map cleanly to our existing `access_tokens` table.

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
