---
name: {{prefix}}-update
description: Bring this teammate's dent-brain install fully up to date across all three propagation lanes — the Cowork plugin (skill content), the MCP server (reported for visibility, nothing to do), and the launchd daemons (granola-sync, email-sync) which need to be re-installed when their bundled source advances. Idempotent; safe to re-run. **Runtime: Claude Code Desktop only** (re-running installers needs shell, keychain, and launchd access — unavailable in Cowork's sandbox). See `docs/reference/runtime-conventions.md`.
triggers:
  - "{{prefix}}-update"
  - "update dent brain"
  - "update my dent brain install"
  - "refresh dent brain"
  - "am I on the latest dent brain"
  - "is my granola sync up to date"
tools:
  - get_health
mutating: true
writes_pages: false
---

# /{{prefix}}-update

## Purpose

Bring this teammate's dent-brain install fully up to date in one pass. Three lanes propagate updates independently:

1. **Plugin lane (skills)** — Cowork plugin marketplace. Auto-fetched when the teammate refreshes the catalog. This skill reports drift and tells the teammate how to refresh if they're behind.
2. **MCP server lane** — Railway redeploy is automatic; nothing to do client-side. This skill reports the current server version for visibility.
3. **Daemon lane (granola-sync, email-sync)** — bundled source advances with each plugin release, but the running daemon at `~/.dent-brain/<id>/sync.ts` is a one-time copy from install time. This skill re-runs `install.sh` for any daemon whose bundle source is newer than its installed copy.

Lane 1 is detected, not fixed (Claude Code's plugin UI owns it). Lane 2 is informational. Lane 3 is where this skill does actual work.

## When to run it

- After you see in the changelog that a new dent-brain version shipped
- When the team adds a new ingestor (granola, email, or future ones)
- Periodically as a hygiene check ("am I on the latest?")
- After re-installing the Cowork plugin (to push the new daemon code through to your laptop)

## Pre-flight

This skill must run in **Claude Code Desktop**, not Cowork. The bash installers need shell access, the macOS keychain, and `launchctl` — all unavailable in Cowork's sandbox. If you find yourself reading this in a Cowork session, switch to the Code tab in Claude Desktop and re-invoke `/dent-update`.

## Step 1. Locate the installed plugin bundle on disk

Claude Desktop installs `dent-brain` by downloading the prebuilt marketplace bundle (the output of `bun run build:plugin`) into:

```
~/Library/Application Support/Claude/local-agent-mode-sessions/<session>/<inner>/rpm/plugin_<opaque-hash>/
```

The `<opaque-hash>` is not predictable and the session/inner IDs vary per-machine. Robust discovery: glob every `manifest.lock.json` under the rpm tree and match on `plugin_name`. There's exactly one match per machine.

```bash
# Robust bundle discovery. Sets BUNDLE_DIR to the installed dent-brain bundle root,
# or empty if not found.
BUNDLE_DIR=$(find "$HOME/Library/Application Support/Claude/local-agent-mode-sessions" \
  -path '*/rpm/plugin_*/manifest.lock.json' 2>/dev/null \
  -exec grep -l '"plugin_name": *"dent-brain"' {} + 2>/dev/null \
  | head -1 | xargs -I {} dirname {} 2>/dev/null)

if [ -z "$BUNDLE_DIR" ] || [ ! -d "$BUNDLE_DIR" ]; then
  echo "FATAL: dent-brain plugin bundle not found on disk."
  echo "Open Claude Desktop → Plugins → dent-brain marketplace → Install."
  echo "Then re-run /dent-update."
  exit 1
fi

echo "Found bundle: $BUNDLE_DIR"
echo "Bundle VERSION: $(cat "$BUNDLE_DIR/VERSION" 2>/dev/null || echo "(missing)")"
grep -E '"(plugin_version|built_at)"' "$BUNDLE_DIR/manifest.lock.json" 2>/dev/null
```

This skill uses `$BUNDLE_DIR` throughout. If discovery fails, stop and tell the user to install/reinstall the plugin marketplace in Claude Desktop's UI — there's no way to recover client-side bash from a missing bundle.

## Step 2. Read current state

```bash
echo "=== Installed daemons ==="
for d in ~/.dent-brain/*/; do
  id=$(basename "$d")
  [ -d "$d" ] || continue
  installed=$(cat "$d/.installed-version" 2>/dev/null || echo "unknown")
  lastrun=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$d/sync.log" 2>/dev/null || echo "never")
  echo "$id installed=$installed lastlog=$lastrun"
done

echo "=== launchd agent status ==="
for label in com.dent.granola-sync com.dent.email-sync; do
  st=$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -E 'state =|last exit code' | head -2 | tr '\n' ' ')
  [ -n "$st" ] && echo "$label: $st" || echo "$label: not loaded"
done
```

Then call the brain's `get_health` MCP tool to fetch the production server version. Present a compact status table:

```
LANE                STATE
─────────────────────────────────────────────────────────
Plugin bundle       v0.37.7 ✓ (installed at $BUNDLE_DIR)
MCP server          v0.37.7 (Railway, healthy)
granola-sync daemon installed v0.37.0 — UPDATE AVAILABLE (bundle has v0.37.7)
email-sync daemon   installed v0.37.7 ✓ (last run 2h ago, exit 0)
```

## Step 3. Plugin freshness — informational only

The plugin bundle on disk represents whatever version Claude Desktop most recently downloaded from the marketplace. Updates are pull-based: Claude Desktop fetches a new bundle when the user clicks Install or Update in the plugin marketplace UI, or sometimes on app restart.

This skill **cannot trigger a plugin refresh** — the rpm/ install is owned by Claude Desktop, not by the user's shell. If `$BUNDLE_DIR/VERSION` is behind what the user knows is the latest release on GitHub, route them:

> The installed bundle is at v{bundle}. If you know a newer release is available,
> open Claude Desktop → Plugins → dent-brain marketplace and reinstall. Then re-run
> /dent-update.

For comparison-vs-the-server: report the production MCP `serverInfo.version` so the user can see whether their bundle and the server are in sync. A big gap (>2 minor versions) is worth warning about — MCP tool contracts may have shifted.

## Step 3. Lane 2 status — server version (informational)

Report the production server version from `get_health` output. Nothing to do — Railway redeploys on every merge to main, so the server is always at HEAD of the code repo. The number matters only for cross-checking that the teammate's plugin (v{plugin}) and the server (v{server}) are roughly in sync. A big gap (e.g. plugin v0.36 but server v0.38) means the teammate is on a much older plugin and might be calling MCP tools that no longer exist or have changed contracts.

If plugin and server are >2 minor versions apart, surface a warning: "Your plugin is N versions behind the server. Lane 1 update strongly recommended before continuing."

## Step 4. Daemon drift detection

For each entry in the registry that's currently installed at `~/.dent-brain/<id>/`:

1. Read the installed version: `cat ~/.dent-brain/<id>/.installed-version 2>/dev/null` (will be `unknown` for installs that predate the version marker — treat as outdated).
2. Read the bundle's source version: `cat $BUNDLE_DIR/VERSION` (set by Step 1's discovery).
3. If `installed != bundle` (or installed is `unknown`), the daemon is outdated.

Build a list of daemons that need re-install. If the list is empty: "All daemons current at v{version}. Nothing to do." Skip to Step 6.

## Step 4.5. Pre-flight — show the EXISTING connection before offering to rebuild it

Before proposing any re-install, run `dent-extensions status <id>` for each outdated
daemon and show the teammate what they already have. This is free — `status` makes **no
network call**. The point is to prevent the blind-re-auth trap: a teammate who can't
remember how their email was connected should not re-authorize on a guess.

For **email-sync** specifically, surface the `Connection` block from status verbatim:

> Your email-sync is currently connected as **{account}** (e.g. you@example.com).
> Tokens live at `{tokenPath}`, last refreshed {when}. Daemon is {armed/inert}, last run {when}.
> This is email-sync's **own** Google OAuth — it is separate from any gws-cli / gmail-search
> auth you may have for a different account. Updating email-sync cannot touch that.

If the teammate is unsure whether the connection is healthy, offer the **one** safe check:
`dent-extensions verify {id}` (exactly one Gmail probe). Do NOT run it automatically — it
spends Gmail quota, and if Gmail is rate-limiting, every extra call extends the window.

**Never recommend re-authorizing to "fix" a connection without first running `status`
(and, if needed, one `verify`).** A 429/rate-limit is transient and is NOT an auth problem;
re-authorizing on a 429 is exactly what caused the v0.45 lockout.

## Step 5. Lane 3 action — re-install outdated daemons

Use AskUserQuestion:

> {N} daemon(s) need to be brought up to date by re-running their installers:
> - granola-sync: installed v0.37.0 → bundle has v0.37.3
> - email-sync: installed v0.37.2 → bundle has v0.37.3
>
> Re-install copies the new runtime files into `~/.dent-brain/<id>/`, reloads the launchd
> agent, and **reuses your existing authorization** — it does NOT re-authorize. It only
> opens an OAuth re-consent if your token is genuinely revoked (a real `401`); a transient
> rate-limit (429) is handled gracefully and never triggers re-auth.

Options:
- A) Re-install all (recommended)
- B) Re-install a subset (specify which)
- C) Skip — I'll do it manually later

If A or B: for each chosen daemon, re-install through the dispatcher (it picks the right
runner — `bun` for the cross-platform `.ts` installers, `bash` for legacy `.sh`):

```bash
bun "$BUNDLE_DIR/tools/extensions/cli.ts" install <id>
```

Stream stdout/stderr to the teammate so they see progress and any prompts. After install completes:
- Write the bundle version into `~/.dent-brain/<id>/.installed-version` so future runs of /dent-update can detect drift correctly. (If the installer doesn't already do this — newer versions should.)
- Tail the first 5 lines of `~/.dent-brain/<id>/sync.log` after the post-install RunAtLoad fires (`tail -F` for ~30s, then stop) so the teammate sees the daemon actually working.
- **Inertness check (important after a major-version jump).** Run `dent-extensions status <id>` again. If the badge is `⚠ no-filter` or `⚠ not-armed`, the daemon copied fine but is silently doing nothing — surface it loudly with the exact next commands: `dent-extensions setup <id>` (author the filter), then `dent-extensions preview <id>` → `dent-extensions arm <id>`. (Re-installing over a pre-filter-contract version, e.g. v0.38 → v0.45+, leaves the daemon inert until a filter exists.)
- **If the installer reported a rate-limit (429) instead of a clean verify**, tell the teammate: the install succeeded and tokens are intact; do NOT re-authorize; once the retry-after window passes, run `dent-extensions verify <id>` then `preview` → `arm`.

If C: print a one-liner the teammate can run later (uses the same discovery as Step 1):

```bash
BUNDLE_DIR=$(find "$HOME/Library/Application Support/Claude/local-agent-mode-sessions" -path '*/rpm/plugin_*/manifest.lock.json' -exec grep -l '"plugin_name": *"dent-brain"' {} + 2>/dev/null | head -1 | xargs -I {} dirname {}) && bun "$BUNDLE_DIR/tools/extensions/cli.ts" install <id>
```

## Step 6. Summary

Print a one-screen summary:

```
DENT-BRAIN UPDATE COMPLETE
──────────────────────────────────────────────────────
Plugin:        v0.37.3 ✓
MCP server:    v0.37.3 ✓
granola-sync:  v0.37.0 → v0.37.3 (re-installed)
email-sync:    v0.37.3 ✓ (already current)

Next run: granola-sync fires at the top of the hour.
          email-sync fires in 4h 12m.
          Run `dent-extensions status` anytime to check.
```

## Failure handling

- **Plugin cache empty AND user can't refresh:** check that Claude Code can reach github.com. If it can't (corp firewall, etc.), there's no path to update — flag this clearly.
- **install.sh fails for one daemon:** report the error, continue with the others. Don't roll back. Idempotency makes the next /dent-update run a safe retry.
- **launchctl bootstrap rejects the agent:** previous version might still be loaded — `launchctl bootout` and retry once. If still failing, the agent's plist is malformed; print the path and ask the user to inspect.
- **Bearer token rejected mid-update:** the dent-brain MCP rejected the token (probably rotated). Tell the user to re-run `/dent-onboard-teammate` to mint a new one, then re-run /dent-update.

## What this skill explicitly does NOT do

- Does NOT update the Cowork plugin marketplace itself — that's Claude Desktop's UI's job.
- Does NOT modify `~/.claude.json` or `claude_desktop_config.json` — those are managed by `/dent-onboard-teammate`.
- Does NOT touch the code repo, git, or any developer-only state.
- Does NOT prompt for API keys or OAuth flows unless install.sh determines a credential is missing or rejected.
- Does NOT run on Cowork (sandbox can't shell out to install.sh). The skill description carries the runtime tag so Cowork sessions surface a clean error.
