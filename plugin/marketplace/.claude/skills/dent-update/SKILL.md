---
name: dent-update
description: Bring this teammate's dent-brain install fully up to date across all three propagation lanes — the Cowork plugin (skill content), the MCP server (reported for visibility, nothing to do), and the launchd daemons (granola-sync, email-sync) which need to be re-installed when their bundled source advances. Idempotent; safe to re-run. **Runtime: Claude Code Desktop only** (re-running installers needs shell, keychain, and launchd access — unavailable in Cowork's sandbox). See `docs/reference/runtime-conventions.md`.
triggers:
  - "dent-update"
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

# /dent-update

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

## Step 1. Read current state (no writes yet)

Run all the inspections in parallel and present a status table.

```bash
echo "=== Plugin marketplace metadata ==="
cat ~/.claude/plugins/marketplaces/dent-brain/.claude-plugin/marketplace.json 2>/dev/null | grep -E '"version"' | head -1

echo "=== Plugin bundle versions in local cache ==="
ls -1 ~/.claude/plugins/cache/dent-brain/dent-brain/ 2>/dev/null

echo "=== Latest installed plugin path ==="
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/dent-brain/dent-brain/[0-9]*/ 2>/dev/null | sort -V | tail -1)
echo "$PLUGIN_DIR"

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

Then call the brain's `get_health` MCP tool to fetch the production server version (it comes back in the response or via the MCP initialize handshake).

Present a compact status table:

```
LANE                STATE
─────────────────────────────────────────────────────────
Plugin marketplace  fetched v0.37.3, latest in cache: v0.37.3 ✓
MCP server          v0.37.3 (Railway, healthy)
granola-sync daemon installed v0.37.0 — UPDATE AVAILABLE (bundle has v0.37.3)
email-sync daemon   installed v0.37.3 ✓ (last run 2h ago, exit 0)
```

## Step 2. Lane 1 detection — plugin freshness

Compare the marketplace.json's `version` field against the highest version dir in `~/.claude/plugins/cache/dent-brain/dent-brain/`. If the cache is empty or behind:

- **If cache is empty:** "Your Claude Code knows the marketplace exists but hasn't downloaded the bundle yet. Open Claude Desktop, go to Plugins → dent-brain, click Install (or Update). Then re-run `/dent-update`."
- **If cache has an older version than marketplace:** "Your installed plugin is v{installed} but marketplace knows about v{marketplace}. Open Claude Desktop's plugin manager, click Update. Then re-run `/dent-update`."
- **If marketplace itself is stale** (an older version than what GitHub HEAD now declares — hard to detect without a network call, so just note it): "If you haven't refreshed the catalog recently, do so: in Claude Desktop, Plugins → dent-brain marketplace → Refresh. The marketplace metadata is pull-based; without a refresh, Cowork won't see new releases."

If Lane 1 is behind, **STOP here**. The daemon re-install in Step 5 reads from the plugin cache; if the cache is stale, we'd just re-install the same outdated daemon.

If Lane 1 is current, continue.

## Step 3. Lane 2 status — server version (informational)

Report the production server version from `get_health` output. Nothing to do — Railway redeploys on every merge to main, so the server is always at HEAD of the code repo. The number matters only for cross-checking that the teammate's plugin (v{plugin}) and the server (v{server}) are roughly in sync. A big gap (e.g. plugin v0.36 but server v0.38) means the teammate is on a much older plugin and might be calling MCP tools that no longer exist or have changed contracts.

If plugin and server are >2 minor versions apart, surface a warning: "Your plugin is N versions behind the server. Lane 1 update strongly recommended before continuing."

## Step 4. Lane 3 detection — daemon drift

For each entry in the registry that's currently installed at `~/.dent-brain/<id>/`:

1. Read the installed version: `cat ~/.dent-brain/<id>/.installed-version 2>/dev/null` (will be `unknown` for installs that predate the version marker — treat as outdated).
2. Read the bundle's source version: the `VERSION` file at the repo root inside the plugin cache, i.e. `cat $PLUGIN_DIR/VERSION` (the v0.37.4 plugin bundle ships this).
3. If `installed != bundle` (or installed is `unknown`), the daemon is outdated.

Build a list of daemons that need re-install. If the list is empty: "All daemons current at v{version}. Nothing to do." Skip to Step 6.

## Step 5. Lane 3 action — re-install outdated daemons

Use AskUserQuestion:

> {N} daemon(s) need to be brought up to date by re-running their install scripts:
> - granola-sync: installed v0.37.0 → bundle has v0.37.3
> - email-sync: installed v0.37.2 → bundle has v0.37.3
>
> Re-running `install.sh` is idempotent. It copies the new runtime files into `~/.dent-brain/<id>/`, reloads the launchd agent, and verifies the bearer token / API key / OAuth refresh token still works. If credentials are already in place, no prompts. If a key was revoked, the installer will re-prompt.

Options:
- A) Re-install all (recommended)
- B) Re-install a subset (specify which)
- C) Skip — I'll do it manually later

If A or B: for each chosen daemon, run:

```bash
bash $PLUGIN_DIR/tools/<id>/install.sh
```

Stream stdout/stderr to the teammate so they see progress and any prompts. After install completes:
- Write the bundle version into `~/.dent-brain/<id>/.installed-version` so future runs of /dent-update can detect drift correctly. (If install.sh doesn't already do this — newer versions should.)
- Tail the first 5 lines of `~/.dent-brain/<id>/sync.log` after the post-install RunAtLoad fires (`tail -F` for ~30s, then stop) so the teammate sees the daemon actually working.

If C: print a one-liner the teammate can run later:

```bash
bash $(ls -d ~/.claude/plugins/cache/dent-brain/dent-brain/[0-9]*/ | sort -V | tail -1)tools/granola-sync/install.sh
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
