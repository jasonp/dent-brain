---
name: {{prefix}}-onboard-teammate
description: Admin-side flow to onboard a new teammate to dent-brain. Generates a bearer token, produces a one-paste `claude mcp add` install command for the teammate, and verifies registration via the audit log.
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

# {{prefix}}-onboard-teammate

> **Admin-only skill.** Run this when adding a new person to the dent-brain deployment. Produces the install instructions the teammate follows on their machine.

## Contract

This skill guarantees:
- A new bearer token is issued in `access_tokens` with `name = <teammate-username>`, so `mcp_request_log` is per-user-attributable.
- The teammate receives a single copy-paste `claude mcp add` command. No manual JSON editing, no token pasting into config files.
- The token name matches a real human handle (e.g. `steve`, `jeff`, `robin`) — never a generic name like `claude-desktop` or `team-shared`. Per-user audit depends on this.
- Registration is verified end-to-end via `mcp_request_log` before onboarding is declared complete.

## When to fire

The admin (Jason today; future deployments: whoever holds `gbrain auth` admin rights) runs this when:
- A new Dent team member needs dent-brain access in their Claude Cowork sessions
- An existing teammate's token needs replacement (revoke old + issue new)
- A teammate's machine changes and they need to re-register

The teammate does NOT run this skill themselves. They follow the instructions this skill produces.

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

### Phase 4: Construct the install command

Every teammate gets **dual-registration** so dent-brain works in BOTH:
- Claude Desktop's **Code mode** + the standalone Claude Code CLI (reads `~/.claude.json`).
- Claude Desktop's **Cowork mode** + classic Desktop chats (reads `~/Library/Application Support/Claude/claude_desktop_config.json`).

The two config files take different value shapes and Cowork is **stdio-only** (HTTP-type entries get rejected on launch). Cowork's registration uses the `mcp-remote` npm package as a stdio bridge that proxies to our remote URL. Background:`docs/dent-brain/UPSTREAM_NOTES.md` §"Three Claude surfaces, two config files".

Pull the server URL from `plugin/manifest.json` (`deploy.server_url`) so this skill works for any dent-brain deployment, not just Dent's.

The install command is a single Python-driven shell block. Python 3 is universally available on macOS — we don't require teammates to install the standalone Claude Code CLI. The block:
1. Backs up both target files (timestamped, in `~/.dent-brain/backups/`).
2. Reads each, merges the dent-brain entry, writes it back atomically.
3. Validates JSON after each write.
4. Prints the relaunch instruction.

Substitute `<SERVER_URL>` and `<TOKEN>` before showing to the teammate. Today: `<SERVER_URL>` is `https://dent-brain.dentthefuture.com/mcp`.

```bash
TOKEN="<TOKEN>"
URL="<SERVER_URL>"
TOKEN="$TOKEN" URL="$URL" python3 <<'PY'
import json, os, shutil, time
HOME = os.path.expanduser("~")
TOKEN = os.environ["TOKEN"]; URL = os.environ["URL"]

bk_dir = os.path.join(HOME, ".dent-brain", "backups")
os.makedirs(bk_dir, exist_ok=True)
stamp = time.strftime("%Y%m%d-%H%M%S")

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

# 1. Code mode + standalone CLI: ~/.claude.json (HTTP-type entry)
patch(
    os.path.join(HOME, ".claude.json"),
    {"type": "http", "url": URL, "headers": {"Authorization": f"Bearer {TOKEN}"}},
)

# 2. Cowork mode + classic Desktop chats: claude_desktop_config.json (stdio bridge via mcp-remote)
patch(
    os.path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    {
        "command": "npx",
        "args": ["-y", "mcp-remote", URL, "--header", f"Authorization: Bearer {TOKEN}"],
    },
)

print("\nDone. Backups saved to ~/.dent-brain/backups/")
print("Next: quit Claude Desktop completely (Cmd+Q) and relaunch.")
print("Then start a NEW Cowork session (not an existing one — tool registries cache per-chat).")
PY
```

⚠️ **Why this is dual, not single.** Earlier versions of this skill (pre-2026-04-30) used `claude mcp add -s user -t http ...` only. That works for Code mode but Cowork sessions reported "I don't see any dent-brain tools" because they read a different file. The dual-registration above is the empirically verified fix.

⚠️ **Cowork tool registry caches per-chat.** Tell the teammate to start a NEW Cowork session, not continue an existing one. Same caveat Steve's FM MCP doc calls out. Old chats won't see the connector even after Claude Desktop restarts.

⚠️ **Token never logged or backed up to git.** Backups go to `~/.dent-brain/backups/` (gitignored at user-home, never enters any repo). The TOKEN env var is local to the heredoc invocation and dies with the shell session.

### Phase 5: Produce the install message

Print a message the admin can copy and send to the teammate over their delivery channel of choice. Use this template:

```
Hi <FullName>, you're set up on dent-brain.

To install on your machine:

1. Make sure Claude Desktop is installed and you're signed in.
   (Download: https://claude.ai/download)

2. Open a terminal (Spotlight → "Terminal") and PASTE this entire block,
   then press Enter. It's one shell command that registers dent-brain in
   two places so it works in Claude Code AND in Claude Cowork sessions.

   <PASTE THE PYTHON BLOCK FROM PHASE 4 HERE, WITH TOKEN AND URL FILLED IN>

3. Quit Claude Desktop completely (Cmd+Q) and relaunch.

4. Start a NEW Cowork session (not an existing one — tool registries are
   cached per-chat, so old chats won't see dent-brain even after restart).
   Ask: "Use dent-brain to call get_stats and tell me what's in there."

   You should see a JSON blob with the current page count. The brain may
   be empty or small in the early phase — that's expected.

You're done. dent-brain is now available in:
- Claude Cowork sessions opened from Claude Desktop (the main team workflow)
- Claude Desktop's Code mode (if you use it)
- The standalone Claude Code CLI in your terminal (if you use it)

All three surfaces share the same token and the same per-user audit log,
so we can see what each person is querying (and the cost) without it
being surveillance — it's just operational hygiene.

Heads up:
- Don't share the token. It's tied to your name in our audit log.
- If you switch machines, ping <admin handle> for a re-issue. Don't try
  to copy the token between machines.
- If anything errors, copy the full terminal output and share it with
  <admin handle>. There's a backup of your previous config at
  ~/.dent-brain/backups/ — restoring is one shell command.
```

Substitute: `<FullName>`, `<SERVER_URL>`, `<TOKEN>`, `<admin handle>`.

### Phase 6: Tell the admin to deliver

Print:

```
Onboarding message ready. Send this to <FullName> via <DeliveryChannel>.

After they run the install command, come back to this terminal and run
the verification step (Phase 7) to confirm registration.
```

Pause. Wait for the admin to say "done" or "they ran it" before continuing.

### Phase 7: Verify registration

After the teammate has run the install command AND restarted Claude Desktop AND started a new Cowork session asking the model to call `get_stats`, check the audit log:

```bash
./scripts/tail-mcp-audit.sh 20 | grep "<handle>"
```

Pass criteria: at least one row with `op=tools/call` from token `<handle>`. Initialize / tools-list rows alone don't count — they fire on connector load even if the teammate never invokes a tool. The `tools/call` row is proof the Cowork session both saw the connector AND successfully invoked it end-to-end.

If no `tools/call` row appears within ~5 minutes of the teammate confirming they asked for `get_stats`:
- **Most likely:** they continued an OLD Cowork chat instead of starting a new one. Tool registries are cached per-chat. Tell them to start a fresh chat and try again.
- **Less likely:** Claude Desktop's launch popup said "entries are not valid MCP server configurations and were skipped: dent-brain." That means `mcp-remote` couldn't load — usually because Node 18+ isn't installed (`node --version`). Install via `brew install node` and relaunch.
- **Rare:** the python block in the install message wasn't pasted as a single unit. Ask them to confirm the JSON is valid: `python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json` should print without error.
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
