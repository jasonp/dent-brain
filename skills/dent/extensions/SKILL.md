---
name: {{prefix}}-extensions
description: Manage local Dent Brain extensions — list, install, configure, test, or uninstall the per-teammate ingestors (Granola sync, future Gmail watch, etc.). Each teammate runs their own copy of each extension on their laptop with their own bearer token, so personal meetings/emails stay local. Use this skill to inspect what's available, see the status of what you've already set up, or add/remove an ingestor.
triggers:
  - "manage my extensions"
  - "what dent brain extensions are available"
  - "list my ingestors"
  - "install granola sync"
  - "install dent extension"
  - "configure granola"
  - "uninstall granola sync"
  - "what's my granola-sync status"
  - "is my dent brain sync running"
tools: []
mutating: true
---

# {{prefix}}-extensions

> **Per-teammate skill.** Each teammate has their own local extensions configured with their own bearer token. The shared brain is the destination, not the configuration store.

## CRITICAL: where the CLI runs

The `dent-extensions` CLI runs on the **teammate's laptop**, not in the agent's environment. Extensions touch:

- `~/Library/Application Support/Granola/...` (the teammate's local Granola cache)
- `~/.dent-brain/granola-sync/` (the teammate's per-extension install dir)
- `~/Library/LaunchAgents/com.dent.granola-sync.plist` (macOS launchd)
- `~/.claude.json` (read-only — for token discovery)

None of those are reachable from a Cowork sandbox or any cloud agent environment. The agent's role is to **tell the teammate what to type into their terminal**, not to run the CLI directly. Do NOT try to invoke `dent-extensions` via Bash from the agent — it won't find the CLI and even if it did it would be operating on the wrong filesystem.

If the agent has terminal access AND is running on the teammate's machine (Code Mode in Claude Code, not Cowork), then it CAN drive the CLI directly. Detect this by checking whether `~/.dent-brain/` is reachable; if yes, drive the CLI; if no, hand off via copy-paste.

## What this skill does

Walks the teammate through `tools/extensions/cli.ts` — a Bun script in the dent-brain repo that gives them one place to:

1. **See what extensions exist** in the dent-brain repo (today: granola-sync; later: gmail-watch, transcript-sync, etc.).
2. **See which are installed** on their machine and whether each is configured + running.
3. **Install** an extension — runs the extension's installer script.
4. **Configure** it — opens the extension's `config.json` in `$EDITOR` (only needed if overriding defaults).
5. **Test** it in dry-run mode to verify wiring before letting it run scheduled.
6. **Uninstall** — stops the launchd agent, removes the plist, removes the install dir.

## Step 1. Find or update the local clone

The teammate must have a checkout of `dent-brain` on disk. Three states to handle:

### State A: clone is missing entirely

If the teammate has never cloned the repo, hand them this:

```bash
mkdir -p ~/gh && cd ~/gh && git clone git@github.com:jasonp/dent-brain.git
cd ~/gh/dent-brain
./tools/extensions/bin/dent-extensions list
```

(Or `~/Code` or wherever they prefer their clones — just be consistent.)

### State B: clone exists but is stale (the most common gotcha)

This is the case the agent hits when running `ls ~/gh/dent-brain/tools/extensions/bin/dent-extensions` returns "no such file or directory" but `ls ~/gh/dent-brain/` succeeds. The teammate has the repo but their checkout predates the extensions tool.

DO NOT report "not located". Instead, hand them this:

```bash
cd ~/gh/dent-brain
git pull
./tools/extensions/bin/dent-extensions list
```

### State C: clone is current

The CLI is at `<clone-path>/tools/extensions/bin/dent-extensions`. They run it directly.

### Detection logic the agent should use

When the teammate first invokes the skill, prefer this single one-liner over branching detection — it works for all three states:

```bash
( cd ~/gh/dent-brain 2>/dev/null && git pull --ff-only --quiet origin main && ./tools/extensions/bin/dent-extensions list ) \
  || ( cd ~/Code/dent-brain 2>/dev/null && git pull --ff-only --quiet origin main && ./tools/extensions/bin/dent-extensions list ) \
  || echo "No dent-brain clone found at ~/gh/dent-brain or ~/Code/dent-brain. Run: git clone git@github.com:jasonp/dent-brain.git ~/gh/dent-brain && cd ~/gh/dent-brain && ./tools/extensions/bin/dent-extensions list"
```

That command:
1. Tries `~/gh/dent-brain` first, runs `git pull` to refresh, then lists extensions
2. Falls back to `~/Code/dent-brain` if that's where they keep it
3. Falls back to clone instructions if neither exists

Hand the teammate THIS one-liner whenever they invoke the skill. It auto-handles all three states without an awkward "I couldn't find it" round trip.

If the teammate's clone is somewhere unusual (e.g. `~/projects/dent-brain`), they tell you and you adjust the one-liner accordingly.

## Step 2. Run `list` first

Always start with `list` — gives the teammate a complete picture before they make any decisions. The output:

```
Dent Brain extensions (1):

  ○ not-installed    granola-sync     Granola → Dent Brain sync
                     Hourly daemon that watches your local Granola cache and pushes Dent-related meeting notes + transcripts into the brain. Filters by title keyword + Dent team domain so personal/non-Dent meetings stay local.
                     → Not installed. Run `dent-extensions install granola-sync` to set it up.
```

Status badges:
- `○ not-installed` — available in the registry but never installed on this machine
- `⚠ unconfigured` — installed but `config.json` has placeholder values
- `⚠ not-running` — installed and configured but launchd agent isn't loaded
- `● active` — installed, configured, and the scheduled agent is running

## Step 3. Per-extension actions

For each available extension, the action menu is:

| Want to | Run |
|---|---|
| Install (first time) | `./tools/extensions/bin/dent-extensions install <id>` |
| Edit config (only if overriding defaults — most users skip this entirely) | `./tools/extensions/bin/dent-extensions configure <id>` |
| Verify wiring without writes | `./tools/extensions/bin/dent-extensions test <id>` |
| See full status (last run, log size, notes) | `./tools/extensions/bin/dent-extensions status <id>` |
| Stop + remove | `./tools/extensions/bin/dent-extensions uninstall <id>` |
| Stop + remove but keep config + cursor | `./tools/extensions/bin/dent-extensions uninstall <id> --keep-config` |

The CLI is idempotent — re-running `install` is safe (it tears down the old launchd agent before installing the new one).

If the teammate has symlinked `dent-extensions` into their `PATH` (per the `tools/extensions/README.md` instructions), they can drop the `./tools/extensions/bin/` prefix.

## Step 4. After install

After a fresh install, the launchd agent runs immediately (RunAtLoad=true) and then on schedule. Tail the log to verify:

```bash
tail -50 ~/.dent-brain/<extension-id>/sync.log
```

If the first run failed, common fixes:

- **`MCP HTTP 401`** — bearer token in `~/.claude.json` is wrong/expired. Re-run `/dent-onboard-teammate` to mint a new one. The daemon picks up the new value on the next run; no re-install needed.
- **`Granola cache not found`** (granola-sync only) — open the Granola app once so it creates its cache file.
- **`No dent-brain MCP configured`** — the teammate hasn't run `claude mcp add dent-brain ...` yet. Route them to `/dent-onboard-teammate` first.

## Step 5. Privacy contract — say this every time

Tell the teammate up front, every install:

> Each extension runs locally on your laptop with your personal bearer token (read fresh from `~/.claude.json` at every sync). Personal data — non-Dent meetings, personal emails — stays local. The extension's filter only ships Dent-related items to the shared brain. You're always in control: `dent-extensions uninstall <id>` stops it instantly.

Don't skip this. Extensions touch personal data on the teammate's machine. Trust matters.

## Anti-patterns

- **Don't try to run the CLI from a Cowork agent.** It can't reach the teammate's filesystem. Hand them the command to type instead.
- **Don't paste the teammate's bearer token into chat.** It's secret AND already in `~/.claude.json` from `/dent-onboard-teammate`. The daemon reads it from there at runtime — never copy it anywhere else.
- **Don't auto-install for the teammate.** `install <id>` runs an interactive bash script. Hand the terminal to the user.
- **Don't manage the production server's ingestors here.** This skill is only for local teammate-side extensions. Server-side ingestors (regfox, mailchimp, etc.) are managed via the gbrain CLI and Railway, not this tool.
- **Don't tell the teammate "the CLI couldn't be located" when their clone exists but is stale.** Always try `git pull` before giving up. The one-liner in Step 1 makes this automatic.

## Output format

When the teammate asks `list`, prefer this shape:

```
Dent Brain extensions:

  ● active            granola-sync       Granola → Dent Brain sync
                      Last run 12m ago. Logs at ~/.dent-brain/granola-sync/sync.log.

  ○ not-installed     gmail-watch        Gmail → Dent Brain inbox watcher
                      Run `dent-extensions install gmail-watch` to set it up.

Run `dent-extensions status <id>` for details, `install <id>` to add one.
```

For status:

```
granola-sync — Granola → Dent Brain sync
  ● active. Last run 12m ago. 4.2 KB logged.
  Config: ~/.dent-brain/granola-sync/config.json (optional — only present if overriding defaults)
  launchd: com.dent.granola-sync (loaded)
```

Keep it scannable. The teammate is probably running this between meetings.

## Tools used

This skill instructs the teammate to run, in their own terminal:

- `dent-extensions list [--json]`
- `dent-extensions status <id> [--json]`
- `dent-extensions install <id>`
- `dent-extensions configure <id>`
- `dent-extensions test <id>`
- `dent-extensions uninstall <id> [--keep-config]`

It does NOT call the dent-brain MCP server. Extensions are local-only configuration; the brain doesn't track who has which extensions installed.
