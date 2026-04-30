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

Build the exact one-line command the teammate will paste. Pull the server URL from `plugin/manifest.json` (`deploy.server_url`) so this works in any dent-brain deployment.

```
claude mcp add dent-brain -s user -t http <SERVER_URL> -H "Authorization: Bearer <TOKEN>"
```

⚠️ **`-s user` is non-negotiable.** Without it, `claude mcp add` defaults to "local" scope (project-private) and the registration lives in the per-project section of `~/.claude.json`. That works for terminal `claude` sessions launched from one specific directory, but **does NOT surface in Claude Desktop's Claude Code mode or Cowork** — both of those read the user-scope (top-level) section of `~/.claude.json`. A teammate who installs at local scope will think they have dent-brain access ("✓ Connected" in `claude mcp list`) but their Cowork sessions won't see it. Always use `-s user`.

For Dent's deploy today: `<SERVER_URL>` is `https://dent-brain.dentthefuture.com/mcp` (canonical, custom domain). The Railway-provided `https://dent-brain-production.up.railway.app/mcp` URL keeps working in parallel and is acceptable as a fallback if the custom domain ever lapses.

### Phase 5: Produce the install message

Print a message the admin can copy and send to the teammate over their delivery channel of choice. Use this template:

```
Hi <FullName>, you're set up on dent-brain.

To install on your machine:

1. Make sure Claude Desktop is installed and you're signed in.
   (Download: https://claude.ai/download)

2. Open a terminal and run this exactly (one line — DO NOT split into multiple lines):

   claude mcp add dent-brain -s user -t http <SERVER_URL> -H "Authorization: Bearer <TOKEN>"

3. Verify it works. Open Claude Desktop, switch to Claude Code mode, start
   a new session, and ask:

   "List the dent-brain tools you have access to."

   You should see a list including get_stats, query, search, put_page, etc.
   If you don't, ping <admin handle>.

4. Try a real query. Ask:

   "Use dent-brain to call get_stats and tell me what's in there."

   You'll get back a JSON blob with the current page count. Brain might be
   small or empty for a while — that's expected during the early phase.

You're done. dent-brain is now available in any Claude Cowork session you
open from Claude Desktop on this machine.

Heads up:
- Don't share the token. It's tied to your name so we can see who's making
  which queries (audit + cost tracking — not surveillance).
- If you switch machines, ping <admin handle> for a re-issue. Don't try to
  copy the token between machines.
- If the install command shows an error, copy the full output and share it
  with <admin handle>.
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

After the teammate has run the install command, check the audit log:

```bash
./scripts/tail-mcp-audit.sh 20 | grep "<handle>"
```

Pass criteria: at least one row with `op=initialize` or `op=tools/list` from token `<handle>`. The standalone CLI registration triggers an immediate handshake to fetch tool definitions; that handshake produces audit rows.

If no rows appear within ~5 minutes of the teammate running the command:
- The command may not have run successfully on their machine. Ask them to paste the terminal output.
- Or: their `~/.claude.json` may already have a different `dent-brain` entry that's blocking the new one. Have them run `claude mcp list` to check, then `claude mcp remove dent-brain` if needed before retrying.

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
