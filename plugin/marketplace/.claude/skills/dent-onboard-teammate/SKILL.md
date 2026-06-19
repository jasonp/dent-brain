---
name: dent-onboard-teammate
description: Admin-side flow to onboard a new teammate to dent-brain. Generates a bearer token, produces the install bundle + an OS-aware install script the teammate's agent runs (NOT `claude mcp add` — that was retired; it broke Cowork and fails on Windows where the connector needs `cmd /c npx`), and verifies registration via the audit log. **Runtime: Claude Code Desktop only** (writes to local config files, runs shell commands). See `docs/reference/runtime-conventions.md`.
triggers:
  - "onboard teammate"
  - "onboard new user"
  - "add teammate to dent-brain"
  - "issue dent-brain token"
  - "give Steve access"
  - "give Jeff access"
tools: []
mutating: true
---

# dent-onboard-teammate

> **Admin-only skill.** Run this when adding a new person to the dent-brain deployment. Produces the install instructions the teammate follows on their machine.

## Contract

This skill guarantees:
- A new bearer token is issued in `access_tokens` with `name = <teammate-username>`, so `mcp_request_log` is per-user-attributable.
- The teammate receives a three-value install bundle (token + server + marketplace) and follows `TEAMMATE_INSTALL.md`; their agent runs the OS-aware install script in §3c. No hand-edited JSON, no improvised `npx` command (which fails on Windows — it needs `cmd /c npx`).
- The token name matches a real human handle (e.g. `steve`, `jeff`, `robin`) — never a generic name like `claude-desktop` or `team-shared`. Per-user audit depends on this.
- Registration is verified end-to-end via `mcp_request_log` before onboarding is declared complete.

## CRITICAL: privacy contract — say this every onboarding

This onboarding sets up the teammate's **brain access** — read/write capability against the shared dent-brain. It does NOT auto-enroll them in any data ingestion. Make sure both the admin and (via the install message) the teammate understand that:

> Onboarding gives you access to the shared brain. **No data flows FROM your laptop into the brain automatically.** If you later choose to install an ingestor (Granola → Brain, Email → Brain, etc.) via `/dent-extensions`, that's a separate, deliberate setup where YOU author the filter that decides what gets in, preview exactly what would be captured, and explicitly arm the daemon. The installer is intentionally inert until you've done all three. Personal meetings and personal emails stay local unless you choose otherwise — there are no pre-built filters that decide for you.

This matters because new teammates reasonably worry "if I install this, will it slurp up my personal stuff?" The answer is no, by design — but only if we keep saying it.

## When to fire

The admin (Jason today; future deployments: whoever holds `gbrain auth` admin rights) runs this when:
- A new Dent team member needs dent-brain access in their Claude Code or Cowork sessions
- An existing teammate's token needs replacement (revoke old + issue new)
- A teammate's machine changes and they need to re-register

The teammate does NOT run this skill themselves. They follow the instructions this skill produces.

The walkthrough this skill points teammates at (`docs/dent-brain/TEAMMATE_INSTALL.md`) is written **Claude Code Desktop primary** — that's the surface where your agent has direct bash access on the laptop and can drive the install end-to-end. If a teammate prefers Cowork, the same walkthrough still works (Cowork agents fall back to copy-paste handoff for shell commands), but the experience is smoother in Claude Code.

## Inputs

Ask the admin via AskUserQuestion (one prompt per field):

1. **Teammate handle** — short, lowercase, no spaces. Examples: `steve`, `jeff`, `robin`, `andreas`, `morgan`. This becomes the token `name` in `access_tokens` AND is what shows up in `mcp_request_log` for every request from that user. Pick something stable that won't conflict.
2. **Teammate full name + email** — for the onboarding message ("Hi Jeff, here's how to install dent-brain..."). Used only in the message text, not stored.
3. **Delivery channel** — how is the install command being shared with the teammate (Slack DM, encrypted email, 1Password share, in-person)? The skill prints the message; the admin handles delivery.

## Phases

### Phase 1: Verify admin context

```bash
# Confirm we have DATABASE_URL access (admin-only)
DATABASE_URL=$(railway variables --kv 2>/dev/null | grep '^DATABASE_URL=' | cut -d= -f2-)
if [[ -z "$DATABASE_URL" ]]; then
  echo "ERROR: cannot fetch DATABASE_URL from Railway. This skill is admin-only — only the deploy admin should run it."
  exit 1
fi
```

If this fails, the user is not the admin and should not be running this skill. Stop and explain.

### Phase 2: Check for existing token

```bash
DATABASE_URL="$DATABASE_URL" bun run src/commands/auth.ts list
```

If a token with the chosen handle already exists and is NOT revoked:
- Ask: "A token named `<handle>` already exists. Revoke it and issue a new one? (yes / no)"
- If yes: `bun run src/commands/auth.ts revoke "<handle>"` first, then continue.
- If no: stop. Either the teammate already has access, or the admin needs to pick a different handle.

If revoked or absent: continue.

### Phase 3: Issue the token

```bash
DATABASE_URL="$DATABASE_URL" bun run src/commands/auth.ts create "<handle>"
```

Capture the printed token. The token is shown ONCE. Hold it briefly to construct the install command, then surface it inside the install message — never write it to a file in the repo.

### Phase 4: Read deploy values + construct the install bundle

The teammate-install walkthrough (TEAMMATE_INSTALL.md §3) asks the user to paste a three-value bundle: `token`, `server`, `marketplace`. The admin sends all three in one message.

Read the deploy-specific values from `plugin/manifest.json` so the skill works for any deployment, not just Dent's:

- `deploy.server_url` → the MCP endpoint (e.g. `https://dent-brain.dentthefuture.com/mcp`).
- `deploy.code_repo` → the marketplace repo as `<org>/<repo>` (e.g. `jasonp/dent-brain`); construct the URL by prefixing `https://github.com/`.
- `deploy.org_prefix` → used to derive the install-walkthrough URL: `https://github.com/<deploy.code_repo>/blob/main/docs/<org_prefix>-brain/TEAMMATE_INSTALL.md`. (The docs folder is named after the org_prefix because the setup script renames `docs/dent-brain/` to `docs/<prefix>-brain/` on fork. For Dent, this resolves to `docs/dent-brain/TEAMMATE_INSTALL.md`.)

Substitute these into the install message in Phase 5. Don't hardcode Dent's URLs.

The dual-config rationale:

Every teammate gets **dual-registration** for the MCP connector so the brain works in BOTH:
- Claude Code (the Code mode tab in Claude Desktop + the standalone CLI). Reads `~/.claude.json`. Uses HTTP-type entry directly.
- Cowork (in Claude Desktop) + classic Desktop chats. Reads the Claude Desktop config — `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/.config/Claude/claude_desktop_config.json` on Linux. Cowork is stdio-only; uses the `mcp-remote` npm package as a stdio bridge that proxies to the remote URL (on Windows it must be spawned via `cmd /c npx`).

**macOS and Windows are both supported** (Linux untested but should work). The walkthrough this skill points teammates at (`docs/dent-brain/TEAMMATE_INSTALL.md`) branches per-OS; the install script below is OS-aware so it produces the right config on whichever machine the teammate runs it.

The connector is unified across surfaces with one install (this dual-write Python block does both files at once). The plugin marketplace is NOT — Claude Code and Cowork have separate plugin stores at different paths, so the plugin must be installed once per surface the teammate wants to use it in.

The two config files take different value shapes and Cowork is **stdio-only** (HTTP-type entries get rejected on launch). Cowork's registration uses the `mcp-remote` npm package as a stdio bridge that proxies to the remote URL. Background: `docs/dent-brain/UPSTREAM_NOTES.md` §"Three Claude surfaces, two config files".

The install command is a single OS-aware Python script. Python 3 is universally available on macOS and on Windows (as `python`/`py`) — we don't require teammates to install the standalone Claude Code CLI. The script:
1. Picks the right Claude Desktop config path and stdio-bridge command for the OS it runs on (macOS / Windows / Linux).
2. Backs up both target files (timestamped, in `~/.dent-brain/backups/`).
3. Reads each, merges the dent-brain entry, writes it back atomically.
4. Validates JSON after each write.

Substitute `<SERVER_URL>` (from `manifest.deploy.server_url`) and `<TOKEN>` (from Phase 3) into the invocation. The teammate's agent writes the script to `~/.dent-brain/install-connector.py` and runs it; the token is passed via env vars so it never lands in the script file. (This block is the canonical reference — the per-OS invocations and full walkthrough live in `TEAMMATE_INSTALL.md` §3c, which the teammate's agent follows.)

```python
import json, os, shutil, sys, time

HOME = os.path.expanduser("~")
TOKEN = os.environ["TOKEN"]; URL = os.environ["URL"]

bk_dir = os.path.join(HOME, ".dent-brain", "backups")
os.makedirs(bk_dir, exist_ok=True)
stamp = time.strftime("%Y%m%d-%H%M%S")

# Claude Desktop's config path AND the stdio-bridge command differ per OS.
if sys.platform == "darwin":
    desktop_cfg = os.path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    bridge = {"command": "npx", "args": ["-y", "mcp-remote", URL, "--header", f"Authorization: Bearer {TOKEN}"]}
elif sys.platform == "win32":
    appdata = os.environ.get("APPDATA", os.path.join(HOME, "AppData", "Roaming"))
    desktop_cfg = os.path.join(appdata, "Claude", "claude_desktop_config.json")
    # Windows must spawn npx through cmd /c, or Claude Desktop can't launch the bridge.
    bridge = {"command": "cmd", "args": ["/c", "npx", "-y", "mcp-remote", URL, "--header", f"Authorization: Bearer {TOKEN}"]}
else:  # Linux (untested but supported)
    xdg = os.environ.get("XDG_CONFIG_HOME", os.path.join(HOME, ".config"))
    desktop_cfg = os.path.join(xdg, "Claude", "claude_desktop_config.json")
    bridge = {"command": "npx", "args": ["-y", "mcp-remote", URL, "--header", f"Authorization: Bearer {TOKEN}"]}

def patch(path, entry):
    if os.path.exists(path):
        shutil.copy(path, os.path.join(bk_dir, f"{os.path.basename(path)}.{stamp}.bak"))
        with open(path) as f: cfg = json.load(f)
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        cfg = {}
    cfg.setdefault("mcpServers", {})
    cfg["mcpServers"]["dent-brain"] = entry
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    with open(path) as f: json.load(f)  # validate
    print(f"  wrote: {path}")

# 1. Code mode + standalone CLI: ~/.claude.json (HTTP-type entry, all OSes)
patch(
    os.path.join(HOME, ".claude.json"),
    {"type": "http", "url": URL, "headers": {"Authorization": f"Bearer {TOKEN}"}},
)

# 2. Cowork mode + classic Desktop chats: claude_desktop_config.json (stdio bridge via mcp-remote)
patch(desktop_cfg, bridge)

print(f"\nDone. Backups saved to {bk_dir}")
print("Next: quit Claude Desktop completely (Cmd+Q on macOS / Quit from the system tray on Windows) and relaunch.")
print("Then start a NEW session (not an existing one — tool registries cache per-chat).")
```

Run it (substitute `<TOKEN>` / `<SERVER_URL>`):
- **macOS / Linux:** `TOKEN="<TOKEN>" URL="<SERVER_URL>" python3 ~/.dent-brain/install-connector.py`
- **Windows (PowerShell):** `$env:TOKEN="<TOKEN>"; $env:URL="<SERVER_URL>"; python "$env:USERPROFILE\.dent-brain\install-connector.py"`

⚠️ **Why this is dual, not single.** Earlier versions of this skill (pre-2026-04-30) used `claude mcp add -s user -t http ...` only. That works for Code mode but Cowork sessions reported "I don't see any dent-brain tools" because they read a different file. The dual-registration above is the empirically verified fix.

⚠️ **Tool registry caches per-chat in EVERY surface** (Claude Code in Desktop, Cowork, classic chats). Tell the teammate to start a NEW chat after each restart, not continue an existing one. Same caveat Steve's FM MCP doc calls out. Old chats won't see the connector even after Claude Desktop restarts.

⚠️ **Token never logged or backed up to git.** Backups go to `~/.dent-brain/backups/` (gitignored at user-home, never enters any repo). The TOKEN env var is local to the heredoc invocation and dies with the shell session.

### Phase 5: Produce the install message

Print a message the admin can copy and send to the teammate over their delivery channel of choice. Use this template:

```
Hi <FullName>, you're set up on dent-brain.

The teammate install walkthrough is here:
<INSTALL_URL>

Your Claude agent will read this URL and walk you through the install
conversationally — install the MCP connector, install the dent-brain
plugin, verify the prefix, and (optionally) clone the data repo for
hand-editing or set up granola-sync for auto-syncing meeting notes.

To start:

1. Confirm Claude Desktop is installed and you're signed in.
   (https://claude.ai/download)

2. Open a fresh Claude Code session in Claude Desktop (the Code mode
   tab — your agent there has direct shell access to your laptop, which
   makes the install much smoother than Cowork's sandbox). Paste:

   "Read <INSTALL_URL> and walk me through the install step by step.
   Pause at each question and wait for my answer."

3. The walkthrough will pause at Section 3 to ask for your install
   bundle. When it does, paste these THREE values into the chat
   (NOT into Terminal, NOT anywhere else):

       token: <TOKEN>
       server: <SERVER_URL>
       marketplace: <MARKETPLACE_URL>

   Your agent uses these to install the MCP connector (single config,
   visible to both Claude Code and Cowork) and the plugin marketplace.

If anything errors at any step, copy the output and ping <admin handle>.
Backups of your previous Claude Desktop config are in ~/.dent-brain/backups/.

Heads up:
- Don't share the token. It's tied to your name in our audit log.
- Don't reuse it across machines — ping <admin handle> for a re-issue.
- The token shown above is one-shot — paste it into your Claude agent
  once during install, then forget it. It lives at rest only in your
  local Claude config.
- The plugin install in Section 5 lands in Claude Code's plugin store.
  If you also want the /dent-* slash commands in Cowork, repeat that
  one section from a Cowork session (same marketplace URL, separate
  store).

Privacy — read before deciding what to do next:

This onboarding sets up your read/write access to the shared brain. NO
data flows from your laptop into the brain automatically. If you later
want to install an ingestor (Granola → Brain, Email → Brain), it's a
separate, deliberate setup via /dent-extensions where YOU author the
filter that decides what gets in, preview exactly what would be
captured, and explicitly arm the daemon. The installer is inert until
you've done all three. Personal meetings and personal emails stay
local unless you choose otherwise — we don't ship pre-built filters
that decide for you.
```

Substitute (all values come from `plugin/manifest.json` except `<TOKEN>` from Phase 3 and `<FullName>` / `<admin handle>` from Phase 1):

- `<FullName>` — teammate's full name (Phase 1 input).
- `<TOKEN>` — the bearer token issued in Phase 3.
- `<SERVER_URL>` — `manifest.deploy.server_url`.
- `<MARKETPLACE_URL>` — `https://github.com/` + `manifest.deploy.code_repo`.
- `<INSTALL_URL>` — `<MARKETPLACE_URL>` + `/blob/main/docs/` + `manifest.deploy.org_prefix` + `-brain/TEAMMATE_INSTALL.md`.
- `<admin handle>` — the admin running this skill (their handle).

### Phase 6: Tell the admin to deliver

Print:

```
Onboarding message ready. Send this to <FullName> via <DeliveryChannel>.

After they run the install command, come back to this terminal and run
the verification step (Phase 7) to confirm registration.
```

Pause. Wait for the admin to say "done" or "they ran it" before continuing.

### Phase 7: Verify registration

After the teammate has run the install command AND restarted Claude Desktop AND started a new session (Claude Code or Cowork) asking the model to call `get_stats`, check the audit log:

```bash
./scripts/tail-mcp-audit.sh 20 | grep "<handle>"
```

Pass criteria: at least one row with `op=tools/call` from token `<handle>`. Initialize / tools-list rows alone don't count — they fire on connector load even if the teammate never invokes a tool. The `tools/call` row is proof the Cowork session both saw the connector AND successfully invoked it end-to-end.

If no `tools/call` row appears within ~5 minutes of the teammate confirming they asked for `get_stats`:
- **Most likely:** they continued an OLD chat instead of starting a new one. Tool registries are cached per-chat. Tell them to start a fresh chat and try again.
- **Less likely (Cowork only):** Claude Desktop's launch popup said "entries are not valid MCP server configurations and were skipped: dent-brain." That means `mcp-remote` couldn't load — usually because Node 18+ isn't installed (`node --version`). Install it (`brew install node` on macOS; `winget install --id OpenJS.NodeJS.LTS -e` or https://nodejs.org on Windows) and relaunch. On Windows, also confirm the Cowork entry spawns via `cmd /c npx` (the OS-aware install script handles this) — a bare `npx` command often fails to launch under Claude Desktop on Windows. Claude Code uses the HTTP entry directly so it doesn't hit this case.
- **Rare:** the install script didn't write valid JSON. Ask them to confirm the config parses, using the OS-aware validator in `TEAMMATE_INSTALL.md` §4 (it resolves the right Claude Desktop config path per OS). On macOS that path is `~/Library/Application Support/Claude/claude_desktop_config.json`; on Windows `%APPDATA%\Claude\claude_desktop_config.json`; on Linux `~/.config/Claude/claude_desktop_config.json`.
- **Last resort:** restore the pre-install backup from `~/.dent-brain/backups/` and re-run the install command.

Once verified: tell the admin "verified — `<handle>` is live as of `<timestamp>`."

### Phase 8: Record the onboarding

Write a brain page (or append to a tracking page) capturing the onboarding for audit:

```
slug: ops/onboarding/<handle>-<YYYY-MM-DD>
content:
  - timestamp
  - teammate full name + handle
  - admin who issued
  - server_url used
  - first audit-log evidence (timestamp + op)
  - delivery channel used
```

This is the breadcrumb. If a token is ever compromised, we know who issued it, when, and via what channel.

### Phase 9 (optional): Read-only clone of the export mirror

Since v0.45 the canonical store is Postgres; `dent-brain-data` is a **one-way nightly export mirror** (DB → git). **Hand-edits pushed to the repo are NOT ingested** — the next nightly export overwrites them. All writes go through the brain ops (`/dent-append-evidence`, `markdown_append_to_page`, `markdown_replace_page`, `put_page`). A clone is still handy as a read-only view (grep, offline browsing, night-to-night diffs). **This phase is optional** — Claude-only is the default, and most teammates never need it. Run it only when:

- The teammate explicitly asked to browse the pages as files, or
- They've expressed a preference for "I'd rather just grep the markdown in my editor."

The contract:

- The teammate is added as a collaborator on `dentthefuture/dent-brain-data` (admin grants this — does NOT happen automatically). **Read access is enough** — they should never push page edits.
- The teammate clones the repo locally and pulls when they want a fresh snapshot; the mirror advances one commit per nightly export (10:00 UTC).
- The full read-only workflow lives in `docs/dent-brain/TEAMMATE_GUIDE.md` § Mode 2. Point them at it; do NOT inline the whole doc into the install message.

Steps for the admin:

1. **Add the teammate as a collaborator** on `dentthefuture/dent-brain-data`:
   - GitHub → repo Settings → Collaborators → Add people → `<their GitHub username>`.
   - Choose **Read** access.
2. **Send a follow-up install message** to the teammate:

   ```
   Hi <FullName>, optional follow-up: you can clone dent-brain-data for
   a read-only file view of the brain — handy for grep, offline
   browsing, or diffing what changed.

   1. Confirm you got the GitHub email inviting you to
      `dentthefuture/dent-brain-data` and accept it.
   2. Read docs/dent-brain/TEAMMATE_GUIDE.md § Mode 2 (in this repo).
   3. Important: the repo is a one-way nightly mirror of the brain's
      database. Don't hand-edit and push pages — edits there are never
      ingested and the next nightly export overwrites them. To change
      brain content, write through your Claude agent.

   You don't have to use this mode. Claude-only works for everything.
   ```

3. **Verify (after they confirm they cloned):** ask them to `git pull --ff-only` and grep any page; no server-side verification is needed since the clone is read-only.

If the teammate declines or has no use for it, skip this phase entirely. There is no penalty — the brain works the same either way.

## Anti-patterns

- ❌ Issuing a generic token name like `team`, `claude`, `cowork`, or `shared`. Breaks per-user audit. Pick a real human handle.
- ❌ Writing the token to any file in the repo, the brain, or a shared doc. Token lives in transit (terminal output → admin → delivery channel → teammate's `~/.claude.json`) and at rest (the teammate's `~/.claude.json`, which is their machine only). Nowhere else.
- ❌ Reusing a token across machines or teammates. One token per (person, machine) pair. If a teammate uses two machines, issue two tokens (`steve`, `steve-laptop`) so we can see which device made which call.
- ❌ Skipping Phase 7 verification. "They said it worked" is not evidence. The audit log is.

## Exit conditions

Skill is complete when:
- Token is issued, name matches teammate handle.
- Install message has been delivered to the teammate.
- Audit log shows the teammate's token has hit `/mcp` at least once.
- An onboarding page exists in the brain (or has been queued for write).

## Followups (out of scope for this skill)

- Token rotation cadence (Phase 0 closeout: not implemented; revisit if a token is suspected compromised or quarterly).
- Per-user dashboards from `mcp_request_log` (P1 polish).
- Self-service token re-issue (a teammate-run skill that can refresh their own token without admin intervention) — explicitly NOT shipping in MVP. Admin holds the keys.
