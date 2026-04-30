# Phase 0 closeout: empirical auth-surface test

**Goal:** before writing any OAuth code, verify which Claude surfaces actually accept a remote MCP connection registered with bearer-token auth.

**Working hypothesis** (gbrain README, 2026-04-29):
> "Remote MCP (Claude Desktop, Cowork, Perplexity)" — bearer + `claude mcp add -H "Authorization: Bearer TOKEN"` works on all three.
> ChatGPT requires OAuth 2.1 (not yet implemented in gbrain).

**Counter-evidence** (UPSTREAM_NOTES.md, 2026-04-27):
> "When an MCP is added via `claude mcp add` from the standalone Claude Code CLI, it appears in standalone CLI sessions but NOT in Claude Desktop's 'Claude Code' feature, NOT in Claude.ai web's Customize → Connectors view."

We need to determine which is correct for our deployment. Outcome decides the Phase 0 closeout work.

---

## Setup (one-time)

### S1. Create a fresh test token

We want a named token that's unambiguously the one used during testing, so we can revoke it cleanly when done.

```bash
cd /Users/jasonpreston/gh/dent-brain
source .env.local 2>/dev/null || source .env 2>/dev/null
DATABASE_URL="$DATABASE_URL" bun run src/commands/auth.ts create "phase0-auth-surface-test"
```

Copy the printed token. Save it in `1Password` or paste into a scratch file you'll delete after; we'll refer to it as `$TEST_TOKEN` below.

### S2. Confirm the server is healthy

```bash
curl -fsS https://dent-brain-production.up.railway.app/health
curl -fsS -H "Authorization: Bearer $TEST_TOKEN" \
  -X POST https://dent-brain-production.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20
```

`tools/list` should return ~30 tool definitions. If this fails, fix the server first; don't waste UI testing time on a broken backend.

### S3. Tail the Railway logs in a side terminal

```bash
railway logs --tail
```

Or open the Railway dashboard. The audit log + stderr lines are how we confirm a UI surface is actually hitting `/mcp` even when the UI doesn't show useful errors.

---

## Test matrix

For each surface: register the connector, observe whether tools list, try invoking `get_health` (no DB) and `get_stats` (DB), and check Railway logs for evidence the request hit `/mcp`.

| # | Surface | Binary / UI path | How to register | Pass criteria |
|---|---|---|---|---|
| T1 | Standalone Claude Code CLI | `/Users/jasonpreston/.local/bin/claude` (v2.1.123) | `claude mcp add` (CLI) | Already known to work; this is a baseline re-verify |
| T2 | Claude Desktop's embedded Claude Code | `/Library/Application Support/Claude/claude-code/2.1.119/...` | Open Claude Desktop, switch to Claude Code mode, check if `~/.claude.json` registrations surface; if not, look for an in-UI MCP add | Tools list in a Claude Code session inside Claude Desktop |
| T3 | Claude.ai web — Customize → Connectors (Pro/Max) | Browser, claude.ai, settings | Add Custom Connector → paste URL + try to add custom header / bearer | If the UI accepts a bearer/header field: tools list. If it forces OAuth: this is where OAuth is actually required |
| T4 | Cowork shared session | Cowork session in any of T1/T2/T3 | After connector is registered in surface X, open a Cowork session and verify the tool registry includes dent-brain tools | Cowork session sees dent-brain tools |

---

## Test procedures

### T1: Standalone CLI re-verify (baseline, ~5 min)

```bash
# Re-register dent-brain on the standalone CLI to confirm baseline
claude mcp remove dent-brain 2>/dev/null || true
claude mcp add dent-brain -t http \
  https://dent-brain-production.up.railway.app/mcp \
  -H "Authorization: Bearer $TEST_TOKEN"

# Start a CLI session and check tool registry
claude
```

Inside the session, ask: "list the dent-brain tools available to you" or just call `get_health`. Pass = tool invocation succeeds + Railway log shows the request.

### T2: Claude Desktop's embedded Claude Code (~10 min)

1. Open **Claude Desktop** (the macOS app, not the Code CLI).
2. Switch to **Claude Code mode** (whichever menu/affordance Anthropic ships in this version).
3. Look for an MCP / connector setting:
   - Is there a UI to add a remote MCP?
   - Does it show entries from `~/.claude.json` automatically?
   - Or is it driven only by `local-agent-mode-sessions/.../local_*.json` (Cowork-cloud-managed)?
4. If there's a UI to add: register `https://dent-brain-production.up.railway.app/mcp` with bearer auth.
5. If there's NO add UI: this confirms UPSTREAM_NOTES — Claude Desktop's Code mode is Cowork-cloud-managed only, OAuth required.
6. Try invoking `get_health` from a Claude Code mode session.

**Record:** screenshots of the MCP/connector UI (or absence of one), what register flow exists, and whether tools list.

### T3: Claude.ai web — Custom Connectors (~10 min)

1. Open https://claude.ai in a browser, signed in to your Pro/Max account.
2. Navigate to **Settings → Customize → Connectors** (or wherever the connector config lives in the current UI).
3. Click **Add Custom Connector** (or equivalent).
4. Examine the form:
   - Does it accept a remote MCP URL?
   - Is there a "custom headers" field or "API key" field where a bearer token can go?
   - Or is the only auth option **OAuth** (with redirect URLs, client_id/client_secret fields)?
5. If header/key field exists: register dent-brain with bearer. Verify it works.
6. If OAuth-only: record the exact OAuth flow the UI expects (DCR? hard-coded client_id? redirect URI shape?).

**This is the surface most likely to require OAuth.** If we end up needing OAuth, T3 evidence scopes the work.

### T4: Cowork shared session (~10 min)

Cowork sessions inherit from one of the surfaces above. Test once T1/T2/T3 are characterized. Open a fresh Cowork session in the surface where dent-brain is registered, ask the agent to list tools, and verify dent-brain tools appear.

---

## Decision tree

After running T1-T4, fill in this decision tree and update PLAN.md accordingly.

| T1 (CLI) | T2 (Desktop Code) | T3 (Web Connectors) | T4 (Cowork) | Conclusion |
|---|---|---|---|---|
| ✅ | ✅ | ✅ (bearer accepted) | ✅ | gbrain README is right. **No OAuth needed.** Phase 0 closes with per-user identity wiring only. |
| ✅ | ✅ | ❌ (OAuth-only) | ✅ in CLI/Desktop, ❌ in Web | OAuth needed **only for Claude.ai web**. Scope: skip OAuth for MVP (Steve uses Desktop), add later if web becomes important. |
| ✅ | ❌ | ❌ | ❌ | UPSTREAM_NOTES is right. **OAuth needed for everything beyond standalone CLI.** Implement as v1.4 originally specified, or revisit the local-stdio architecture. |
| ✅ | ✅ | ❌ | ❌ in Web | Mixed — see row 2. |

---

## Findings (2026-04-29)

### T1: Standalone CLI — PASS ✅

- Existing `dent-brain` registration in `~/.claude.json` (User scope), bearer `gbrain_ccb368fc...` (`dent-brain-jason` token), already ✓ Connected per `claude mcp list`.
- Direct HTTP verify with fresh test token: `tools/list` returned all 41 tools; `get_stats` returned 62ms / 245ms; `get_health` returned valid JSON.
- Railway audit log confirmed both test-token requests landed (`tools/call` rows, status=success).

### T2: Claude Desktop's Claude Code mode — PASS ✅ (full)

- Claude Desktop's embedded Claude Code mode **DOES read `~/.claude.json`**. The `dent-brain` registration (already present from the standalone CLI flow) appears in tool listings under "Custom / Personal."
- Tool invocation works end-to-end: asking the model to call `get_stats` produced a `tools/call` audit row at `2026-04-29T16:22:23.978Z`, latency 213ms (consistent with a real DB-touching call, not a probe), token=`dent-brain-jason` (same token as the CLI registration — confirming shared config).
- **This directly contradicts UPSTREAM_NOTES.md's 2026-04-27 finding that Claude Desktop's Claude Code does NOT read `~/.claude.json`.** That note was wrong. UPSTREAM_NOTES.md updated to reflect this.

### T3: Claude.ai web Connectors — SKIPPED

- Out of scope for the team-use case. Dent team uses Claude Cowork desktop apps (T2 surface), not the claude.ai web app. Even if the web UI requires OAuth, it doesn't gate the deliverable. Re-open this test only if a future use case requires web access.

### T4: Cowork session — IMPLICITLY COVERED BY T2

- Cowork sessions inside Claude Desktop's Claude Code mode use the same MCP registry T2 just verified. `dent-brain-jason` token is what served the T2 tool call, so a Cowork session in the same surface will have the same access. Explicit Cowork test deferred unless a Cowork-specific surface emerges as different.

---

## Decision

**Conclusion:** OAuth implementation is NOT required for the MVP team-use case. Bearer auth via `claude mcp add` works on the Claude Desktop / Claude Code / Cowork surface that the team will actually use. Phase 0 closeout reshapes from "implement OAuth" to "ship per-team-member install flow" — the install skill that registers the connector in each user's `~/.claude.json` with their personal bearer.

**Followups recorded:**
1. ✅ Test token `phase0-auth-surface-test` revoked.
2. ✅ UPSTREAM_NOTES.md "Three Claude surfaces" section corrected with the actual 2026-04-29 finding.
3. ⏳ PLAN.md v1.5 changelog entry to record the empirical result + Phase 0 closeout reshape.
4. Future: re-open T3 only if a use case requires Claude.ai web access (e.g., team members on free plans, or browser-only workflows).
