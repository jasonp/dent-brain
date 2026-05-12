---
name: dent-extensions
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

# dent-extensions

> **Per-teammate skill.** Each teammate has their own local extensions configured with their own bearer token. The shared brain is the destination, not the configuration store.

## CRITICAL: what `install` actually does (no prompts)

`dent-extensions install granola-sync` runs `bash tools/granola-sync/install.sh` which performs these 7 steps and exits in ~3 seconds (or pauses briefly on first install to prompt for the Granola API key):

1. Verifies `bun` is on `$PATH` (errors with install hint if not).
2. Verifies `~/.claude.json` has a `dent-brain` MCP entry with a `Bearer` token (errors with a "run /dent-onboard-teammate first" hint if not). It does NOT extract, copy, display, or ask about the token — only checks that the entry exists.
3. Verifies `Granola.app` is installed (where the teammate mints the API key). Errors with download/setup steps if missing.
4. Verifies a working Granola API key is in the macOS keychain (service `dent-brain.granola-sync`, account `$USER`). If missing or rejected by `https://public-api.granola.ai/v1/notes`, prompts the teammate to paste a key (Granola → Settings → Connectors → API keys → Create new key) and stores it via `security add-generic-password`.
5. Copies 6 runtime files to `~/.dent-brain/granola-sync/`.
6. Renders + installs `~/Library/LaunchAgents/com.dent.granola-sync.plist`.
7. Calls `launchctl bootstrap` to load the agent. RunAtLoad=true fires the first sync immediately. Hourly thereafter.

What `install` does NOT do:

- Does NOT prompt for the dent-brain bearer token (auto-discovered from `~/.claude.json`).
- Does NOT open `$EDITOR`.
- Does NOT write a `config.json` (config.json is fully optional, only created if the teammate manually edits one to override defaults).
- Does NOT ask the teammate for an email, name, or any other identity field.

The ONE prompt: when no working Granola API key is in the keychain, Step 4 asks the teammate to paste a `grn_…` key (hidden input). Re-runs with a valid key in keychain skip the prompt — fully non-interactive.

After the install completes, macOS will show a Background Items notification mentioning "Jarred Sumner". Tell the teammate up front so it doesn't surprise them — that's the developer ID of Bun (the JavaScript runtime the daemon uses). It's expected and safe. The installer's final output explains the same thing.

## CRITICAL: never ask the teammate for their bearer token

The teammate's dent-brain bearer token was already set up by `/dent-onboard-teammate` when they ran `claude mcp add dent-brain --header "Authorization: Bearer ..."`. It lives in `~/.claude.json` under `mcpServers["dent-brain"].headers.Authorization`. Every extension reads it from there at runtime — no copy, no second paste, no config edit.

When walking the teammate through install, configure, or troubleshoot:

- **Do NOT** say "find your bearer token", "paste your bearer token", "you'll need your bearer token", or any variant.
- **Do NOT** ask them to `claude mcp list` to look up their token.
- **Do NOT** open a config file for them to paste into.
- **Do NOT** treat the bearer token as a thing the teammate manages. The teammate's mental model should be: "I onboarded once via `/dent-onboard-teammate`, the brain knows who I am, every extension just works."

If `~/.claude.json` doesn't have a `dent-brain` MCP entry, the right response is "it looks like you haven't run `/dent-onboard-teammate` yet — let's do that first" — NOT "let's find your token."

The granola-sync extension specifically needs ZERO config. The installer has no prompts. If you find yourself walking the teammate through any token-related step, you've drifted from the script.

## CRITICAL: where the CLI runs

The `dent-extensions` CLI runs on the **teammate's laptop**, not in the agent's environment. Extensions touch:

- `https://public-api.granola.ai/v1/` (Granola public API, authenticated with the teammate's key)
- macOS keychain (service `dent-brain.granola-sync`, where the Granola API key lives)
- `~/.dent-brain/granola-sync/` (the teammate's per-extension install dir)
- `~/Library/LaunchAgents/com.dent.granola-sync.plist` (macOS launchd)
- `~/.claude.json` (read-only — for bearer-token discovery)

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

## Step 1. Locate the dent-extensions CLI

As of v0.37.2 the installer scripts ship inside the Cowork plugin bundle itself — no git clone required for typical teammates. The CLI lives at `~/.claude/plugins/cache/dent-brain/dent-brain/<version>/tools/extensions/bin/dent-extensions`. The skill needs to find the active version directory and invoke the CLI there.

### Preferred path: use the plugin-cache copy

Hand the teammate THIS one-liner. It auto-resolves the latest installed plugin version and invokes the CLI from inside it:

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/dent-brain/dent-brain/[0-9]*/ 2>/dev/null | sort -V | tail -1) \
  && [ -n "$PLUGIN_DIR" ] && "$PLUGIN_DIR/tools/extensions/bin/dent-extensions" list \
  || echo "FALLBACK_NEEDED"
```

If that prints an extensions list, you're done — the teammate is on a plugin version that bundles the installers and there's no clone or pull step required. Move to Step 2.

### Fallback path: developer with a git clone

If the one-liner above prints `FALLBACK_NEEDED` (no plugin installed, or installed plugin predates v0.37.2 and lacks `tools/`), the teammate is either a developer working from a clone OR running a pre-v0.37.2 plugin. Use the legacy clone-based path:

```bash
( cd ~/gh/dent-brain 2>/dev/null && git pull --ff-only --quiet origin main && ./tools/extensions/bin/dent-extensions list ) \
  || ( cd ~/Code/dent-brain 2>/dev/null && git pull --ff-only --quiet origin main && ./tools/extensions/bin/dent-extensions list ) \
  || echo "No dent-brain plugin (>=0.37.2) and no clone found. Either: (a) reinstall the Cowork plugin to pick up the bundled installers, or (b) git clone git@github.com:jasonp/dent-brain.git ~/gh/dent-brain"
```

### Which path you'll actually hit

| Teammate type | Path used |
|---|---|
| Non-developer with current plugin installed | Preferred (plugin cache). Zero git involved. |
| Developer hacking on this repo | Fallback (clone). They typically WANT the clone because they're editing `tools/granola-sync/` and want their edits to be what runs. |
| Teammate on a pre-v0.37.2 plugin | Fallback, but the right fix is to reinstall the plugin — newer bundles include the installers. |

For the developer case: if you're working in a clone and want `/dent-extensions` to use YOUR clone's installer instead of the bundled one, just run `./tools/extensions/bin/dent-extensions install <id>` directly from the clone. The skill's auto-detection is a convenience for non-developers; developers can bypass it.

## Step 2. Pre-install: confirm Granola itself is set up

Before running `install granola-sync`, walk the teammate through Granola's own setup so the install doesn't fail on its Step 3 (Granola pre-flight check). Granola is the meeting note-taker the daemon syncs from — it's a separate Mac app the teammate must install themselves.

Ask the teammate (one quick conversational pass, not a checklist they have to read):

> Quick Granola check before we install the sync — do you already have Granola.ai set up? If not, here's the one-time setup:
>
> 1. Download Granola from https://granola.ai/download and install it.
> 2. Sign in with your `@dentthefuture.com` Google account (the one your Dent calendar invites land on).
> 3. In Granola Settings → Permissions, grant **Microphone** and **Screen Recording** access. Without these, Granola can't capture your meetings.
> 4. Sit through one Dent meeting with Granola open — it learns your account preferences and creates its local cache. Without that cache, the sync has nothing to read.
>
> Once that's done, I'll run the sync installer.

If they confirm Granola is already running on their machine, skip the walkthrough and proceed straight to the install. If they're not sure ("I downloaded it once but never opened it"), have them open the app and complete one meeting before continuing.

The installer (Step 3 below) hard-fails with the same setup steps if Granola isn't ready — so this conversation is defense in depth, not strict prerequisite.

## Step 3. Run `list` first

Always start with `list` — gives the teammate a complete picture before they make any decisions. The output:

```
Dent Brain extensions (1):

  ○ not-installed    granola-sync     Granola → Dent Brain sync
                     Hourly daemon that pulls meetings from the Granola public API (key in macOS keychain) and pushes Dent-related notes + transcripts into the brain. Filters by four orthogonal signals (Granola folder, title, body/transcript, attendee email domain) so personal/non-Dent meetings stay local.
                     → Not installed. Run `dent-extensions install granola-sync` to set it up.
```

Status badges:
- `○ not-installed` — available in the registry but never installed on this machine
- `⚠ unconfigured` — installed but `config.json` has placeholder values
- `⚠ not-running` — installed and configured but launchd agent isn't loaded
- `● active` — installed, configured, and the scheduled agent is running

## Step 4. Per-extension actions

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

## Step 5. After install

Two things happen right after `launchctl bootstrap`:

1. **macOS Background Items notification.** The teammate will see a system notification saying "Jarred Sumner may now run software in the background" (or similar). That's the developer ID of Bun (the JavaScript runtime the daemon uses, signed by its creator the same way Docker is signed by Docker Inc). The installer's output also explains this. Tell the teammate up front so they don't panic — it's the standard macOS notification for any third-party launchd agent.

2. **First sync fires immediately** (RunAtLoad=true). The agent then runs hourly. Tail the log to verify the first run worked:

```bash
tail -50 ~/.dent-brain/<extension-id>/sync.log
```

You should see lines like `[granola-sync] Granola API: authenticated` followed by per-note decisions and a `done:` summary. If you see those, it worked.

If the first run failed, common fixes:

- **`MCP HTTP 401`** — dent-brain bearer token in `~/.claude.json` is wrong/expired. Re-run `/dent-onboard-teammate` to mint a new one. The daemon picks up the new value on the next run; no re-install needed.
- **`Granola API key rejected`** / **`Granola API 401`** — the API key was revoked or never minted. Re-run install.sh; it'll re-prompt and update the keychain. Or rotate manually: `security add-generic-password -U -s dent-brain.granola-sync -a "$USER" -w 'grn_...'`.
- **`No Granola API key in keychain`** — the keychain entry is missing. Re-run install.sh and paste the key when prompted.
- **`No dent-brain MCP configured`** — the teammate hasn't run `claude mcp add dent-brain ...` yet. Route them to `/dent-onboard-teammate` first.

## Step 6. Privacy contract — say this every time

Tell the teammate up front, every install:

> Each extension runs locally on your laptop. Your existing dent-brain auth (the one set up by `/dent-onboard-teammate`) is reused automatically — nothing for you to copy or paste. Personal data — non-Dent meetings, personal emails — stays local. The extension's filter only ships Dent-related items to the shared brain. You're always in control: `dent-extensions uninstall <id>` stops it instantly.

Don't skip this. Extensions touch personal data on the teammate's machine. Trust matters. But also — don't make auth sound scary or like more work. It's already done.

## Anti-patterns

- **Don't try to run the CLI from a Cowork agent.** It can't reach the teammate's filesystem. Hand them the command to type instead.
- **Don't ask the teammate to find or paste their bearer token. EVER.** Auto-discovery from `~/.claude.json` is the contract. If you find yourself saying "find your bearer token", "paste your token", "look up your token", or asking them to run `claude mcp list` to retrieve it — STOP. You've drifted. The token is already there from onboarding.
- **Don't auto-install for the teammate from a sandboxed agent context.** `install <id>` runs a bash script that touches launchd; it has to run on the teammate's actual laptop. Hand the terminal to them. If you're running on the teammate's laptop (Code Mode), you can drive it directly.
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
