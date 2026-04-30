# Upstream Notes

Known quirks and caveats in the gbrain substrate (`garrytan/gbrain`) that affect our fork. Not bugs we need to fix — just things to be aware of.

---

## Three Claude surfaces, two config files, one stdio bridge needed (2026-04-30, supersedes 2026-04-27 AND 2026-04-29 entries)

**The actual surface architecture, verified end-to-end via audit-log evidence:**

| Surface | Config file | HTTP-type entries supported | Notes |
|---|---|---|---|
| Standalone Claude Code CLI (`~/.local/bin/claude`) | `~/.claude.json` (top-level `mcpServers.<name>`) | ✅ Yes — `{type: "http", url, headers}` | `claude mcp add -s user -t http ... -H "..."` writes here |
| Claude Desktop's **Code mode** (embedded `claude-code/<ver>`) | `~/.claude.json` (same file as standalone CLI) | ✅ Yes — same shape | Reads `~/.claude.json` directly. Empirically confirmed 2026-04-29 |
| Claude Desktop's **Cowork mode** (and classic Desktop chats) | `~/Library/Application Support/Claude/claude_desktop_config.json` | ❌ **stdio-only.** HTTP shape rejected with the popup "entries are not valid MCP server configurations and were skipped" | Remote HTTP MCPs need a stdio bridge (see below) |

**The bridge:** `npx -y mcp-remote <url> --header "Authorization: Bearer <token>"`. `mcp-remote` is a maintained npm package (current `0.1.38`, description: "Remote proxy for Model Context Protocol, allowing local-only clients to connect"). It speaks MCP stdio to Claude Desktop and proxies all calls over HTTP to the remote server. Schema in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dent-brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://dent-brain.dentthefuture.com/mcp", "--header", "Authorization: Bearer <token>"]
    }
  }
}
```

**Verification (Phase 0/1 auth-surface re-test, 2026-04-30):**
- Registered dent-brain via `claude mcp add -s user -t http ...` → tools surface in standalone CLI ✓ and Claude Desktop's Code mode ✓ (T2 from 2026-04-29).
- **But:** in a fresh Claude Desktop **Cowork session** the model reported "I don't see any tools with 'dent-brain' in the name." Audit log showed only passive heartbeats during the Cowork test — no fresh `tools/call`.
- Tried adding `{type: "http", url, headers}` directly to `claude_desktop_config.json` → Claude Desktop popup on launch: "entries are not valid MCP server configurations and were skipped: dent-brain." Schema rejected.
- Replaced with stdio entry `{command: "npx", args: ["-y", "mcp-remote", ...]}` → restarted Claude Desktop → fresh Cowork session → `get_stats` returned real JSON, audit row at 13:41:46.421Z, latency 328ms. **Cowork now sees dent-brain.**

**Why this matters for OSS distribution:** the install pattern for downstream forks of dbrain (or anyone deploying their own gbrain-shape brain to Cowork-using teams) is **dual-registration**:
1. `~/.claude.json` direct edit OR `claude mcp add -s user` for Code mode + standalone CLI.
2. `claude_desktop_config.json` with the `mcp-remote` stdio bridge for Cowork.

Both registrations use the same bearer token; the token is URL-agnostic and the same `access_tokens.name` row authenticates both. **No OAuth needed.** The stdio bridge is the workaround.

**Supersedes the 2026-04-29 entry** that claimed Code mode and Cowork share the same registration store. They don't. The 2026-04-29 test passed for Code mode but the conclusion was incorrectly generalized to Cowork. Empirically corrected on 2026-04-30 when a fresh Cowork session failed the same test. See `docs/dent-brain/TESTS_phase0_auth_surfaces.md` for both rounds of testing.

**Supersedes the 2026-04-27 entry** that claimed Code mode "does NOT read ~/.claude.json" and required OAuth. Both halves were wrong: Code mode does read `~/.claude.json`, and OAuth is unnecessary for Cowork given the mcp-remote bridge.

**Caveat — Claude.ai web Connectors UI** (browser, not desktop) was not tested. May still require OAuth there. Out of scope for Dent's MVP; team uses Claude Desktop, not the web.

**For dbrain forks (OSS posture):** ship the dual-registration install command. Don't ship OAuth. The `mcp-remote` bridge is one extra line per teammate's `claude_desktop_config.json` and removes the need for an OAuth issuer. Same friction as upstream gbrain plus a stdio bridge, both well-trodden patterns.

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
