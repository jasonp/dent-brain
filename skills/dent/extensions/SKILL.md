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

## What this skill does

Drives `tools/extensions/cli.ts` (a small Bun-based manager) to give the teammate one place to:

1. **See what extensions exist** in the dent-brain repo (today: granola-sync; later: gmail-watch, transcript-sync, etc.).
2. **See which are installed** on their machine and whether each is configured + running.
3. **Install** an extension — runs the extension's installer script.
4. **Configure** it — opens the extension's `config.json` in `$EDITOR`.
5. **Test** it in dry-run mode to verify wiring before letting it run scheduled.
6. **Uninstall** — stops the launchd agent, removes the plist, removes the install dir.

## How to invoke

The skill is a thin wrapper. Drive it conversationally:

> *user:* "What dent brain extensions are available?"
> *agent:* runs `dent-extensions list --json`, formats the output, summarizes status.

> *user:* "Install granola-sync."
> *agent:* runs `dent-extensions install granola-sync`. The installer is interactive (prompts for the bearer token), so the agent should hand over to the terminal and wait for the teammate to finish.

> *user:* "Is my granola-sync running?"
> *agent:* runs `dent-extensions status granola-sync`, reports the badge + last-run-at + any notes.

## Step 1. Locate the CLI

Each teammate has a clone of `dent-brain` somewhere on disk. The CLI lives at:

```
<dent-brain-clone>/tools/extensions/bin/dent-extensions
```

Common locations:
- `~/gh/dent-brain/tools/extensions/bin/dent-extensions`
- `~/Code/dent-brain/tools/extensions/bin/dent-extensions`
- wherever the teammate cloned the repo

If the teammate hasn't cloned it yet, point them at the README:
- `https://github.com/jasonp/dent-brain/blob/main/tools/extensions/README.md`
- They `git clone git@github.com:jasonp/dent-brain.git` first, then return.

If they want to use it without typing the full path, the README explains how to symlink it into `/usr/local/bin`.

## Step 2. Run `list` first

Always start with `list` — gives the teammate a complete picture before they make any decisions:

```bash
dent-extensions list
```

Shows every available extension with its status badge (`● active`, `⚠ unconfigured`, `⚠ not-running`, `○ not-installed`), description, and any actionable notes. Reformat the output for the teammate if helpful — link the extension ids to next-step commands.

## Step 3. Per-extension actions

For each available extension, the action menu is:

| Want to | Run |
|---|---|
| Install (first time) | `dent-extensions install <id>` |
| Edit config (e.g. update bearer token) | `dent-extensions configure <id>` |
| Verify wiring without writes | `dent-extensions test <id>` |
| See full status (last run, log size, notes) | `dent-extensions status <id>` |
| Stop + remove | `dent-extensions uninstall <id>` |
| Stop + remove but keep config | `dent-extensions uninstall <id> --keep-config` |

The CLI is idempotent — re-running `install` is safe (it tears down the old launchd agent before installing the new one).

## Step 4. After install

After a fresh install, the launchd agent runs immediately (RunAtLoad=true) and then on schedule. Tail the log to verify:

```bash
tail -50 ~/.dent-brain/<extension-id>/sync.log
```

If the first run failed, common fixes:
- **`MCP HTTP 401`** — bearer token wrong or expired. Run `dent-extensions configure <id>` to fix, then `install <id>` again to reload the agent.
- **`Granola cache not found`** (granola-sync only) — open the Granola app once so it creates its cache file.
- **`config.json contains placeholder values`** — the teammate skipped editing config.json during install. Run `configure <id>`.

## Step 5. Privacy contract

Tell the teammate up front, every time:

> Each extension runs locally on your laptop with your personal bearer token. Personal data (non-Dent meetings, personal emails) stays local — the extension's filter only ships Dent-related items to the shared brain. You're in control: `dent-extensions uninstall <id>` stops it instantly.

Don't skip this — extensions touch personal data on the teammate's machine. Trust matters.

## Anti-patterns

- **Don't paste the teammate's bearer token into chat** — it's secret. The installer prompts for it interactively and writes it to a `chmod 600` config file. Never log it.
- **Don't auto-install for the teammate** — `install <id>` runs an interactive bash script. Hand the terminal to the user; don't try to script around the editor prompt.
- **Don't manage the production server's ingestors here.** This skill is only for local teammate-side extensions. Server-side ingestors (regfox, mailchimp, etc.) are managed via the gbrain CLI and Railway, not this tool.

## Output format

When the teammate asks `list`, prefer this shape (reformat from `--json`):

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
  Config: ~/.dent-brain/granola-sync/config.json
  launchd: com.dent.granola-sync (loaded)
```

Keep it scannable. The teammate is probably running this between meetings.

## Tools used

This skill shells out via Bash to:

- `dent-extensions list [--json]`
- `dent-extensions status <id> [--json]`
- `dent-extensions install <id>`
- `dent-extensions configure <id>`
- `dent-extensions test <id>`
- `dent-extensions uninstall <id> [--keep-config]`

It does NOT call the dent-brain MCP server. Extensions are local-only configuration; the brain doesn't track who has which extensions installed.
