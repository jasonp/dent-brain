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

## CRITICAL: what `install` actually does (no prompts)

`dent-extensions install granola-sync` is **NOT INTERACTIVE**. It runs `bash tools/granola-sync/install.sh` which performs exactly these 6 steps and exits in ~3 seconds:

1. Verifies `bun` is on `$PATH` (errors with install hint if not).
2. Verifies `~/.claude.json` has a `dent-brain` MCP entry with a `Bearer` token (errors with a "run /dent-onboard-teammate first" hint if not). It does NOT extract, copy, display, or ask about the token — only checks that the entry exists.
3. Verifies `Granola.app` is installed AND `~/Library/Application Support/Granola/cache-v6.json` exists (i.e. teammate has opened Granola at least once). Errors with detailed setup steps if either is missing.
4. Copies 5 runtime files to `~/.dent-brain/granola-sync/`.
5. Renders + installs `~/Library/LaunchAgents/com.dent.granola-sync.plist`.
6. Calls `launchctl bootstrap` to load the agent. RunAtLoad=true fires the first sync immediately. Hourly thereafter.

What `install` does NOT do:

- Does NOT prompt for a bearer token.
- Does NOT open `$EDITOR`.
- Does NOT write a `config.json` (config.json is fully optional, only created if the teammate manually edits one to override defaults).
- Does NOT ask the teammate for an email, name, or any other identity field.
- Does NOT have a "what to expect during the prompts" phase — there are no prompts.

If you find yourself describing prompts, editors, or token-pasting, you've hallucinated. Re-read this section and re-describe the install accurately: "I'll run the installer. It takes ~3 seconds, no prompts, then you'll have an hourly Granola sync."

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
                     Hourly daemon that watches your local Granola cache and pushes Dent-related meeting notes + transcripts into the brain. Filters by title keyword + Dent team domain so personal/non-Dent meetings stay local.
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

You should see lines like `[granola-sync] Granola cache: N documents, M local transcripts` followed by per-doc decisions and a `done:` summary. If you see those, it worked.

If the first run failed, common fixes:

- **`MCP HTTP 401`** — bearer token in `~/.claude.json` is wrong/expired. Re-run `/dent-onboard-teammate` to mint a new one. The daemon picks up the new value on the next run; no re-install needed.
- **`Granola cache not found`** — the teammate has Granola installed but hasn't opened it yet. Open the Granola app, sign in, then re-run the daemon manually (`bun ~/.dent-brain/granola-sync/sync.ts`).
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
