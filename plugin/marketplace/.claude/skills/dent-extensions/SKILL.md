---
name: dent-extensions
description: Manage local Distributed Brain extensions — install, set up, preview, arm, list, status, or uninstall the per-teammate ingestors (Granola sync, email sync). Each teammate runs their own copy on their laptop with their own bearer token AND their own bespoke filter, so personal meetings/emails stay local. Use this skill when the teammate wants to "set up granola", "set up email sync", "install dent extension", or asks about extension status. **Runtime: Claude Code Desktop only** for install/setup/preview/arm (these touch the local filesystem, macOS keychain, and launchd — none of which Cowork can reach); list/status are safe anywhere. See `docs/reference/runtime-conventions.md`.
triggers:
  - "set up granola"
  - "set up granola sync"
  - "set up email"
  - "set up email sync"
  - "install dent extension"
  - "install granola sync"
  - "install email sync"
  - "manage my extensions"
  - "what dent brain extensions are available"
  - "list my ingestors"
  - "what's my granola-sync status"
  - "is my dent brain sync running"
  - "configure granola"
  - "uninstall granola sync"
  - "uninstall email sync"
tools: []
mutating: true
---

# dent-extensions

> **Per-teammate skill.** Each teammate has their own local install configured with their own bearer token AND their own bespoke filter. The shared brain is the destination, never the configuration store.

## CRITICAL: privacy contract (say this every time)

Before you touch anything, tell the teammate this — exactly once, at the top of the conversation, in your own voice:

> Nothing reaches the shared Distributed Brain until you (1) author a filter that decides what gets in, (2) preview exactly what would be captured, and (3) explicitly arm the daemon. The installer is intentionally inert — it puts the plumbing in place but writes nothing upstream. You're in control at every step.

Don't skip this. The whole point of the recipe model is that the teammate's filter is bespoke; if you don't make that explicit you've broken the trust contract.

## Lifecycle, in order

```
install  →  setup  →  preview  ⇆  edit  →  arm
            (skill drives 1–4)         (one command)
```

1. **Install** — plumbing only. Daemon is provably inert (no user/filter.ts → daemon refuses to run).
2. **Setup** — you (this skill) interview the teammate, write `user/filter.ts` for them.
3. **Preview** — `dent-extensions preview <id>` dry-runs the daemon with their filter against recent data. Prints `[USER-KEEP]` / `[USER-DROP]` per item.
4. **Edit** — iterate on `user/filter.ts` until the preview matches the teammate's expectations. Loop with step 3.
5. **Arm** — `dent-extensions arm <id>` bootstraps launchd. Daemon goes live.

`uninstall` reverses everything in one shot.

## CRITICAL: where the CLI runs

The `dent-extensions` CLI runs on the **teammate's laptop**, not in Cowork. It touches:

- macOS keychain (Granola key)
- `~/.dent-brain/<id>/` (install dir)
- `~/Library/LaunchAgents/` (plist)
- `~/.claude.json` (read-only, for bearer-token discovery)

None of those are reachable from a Cowork sandbox or any cloud agent environment. The agent's role is to **walk the teammate through the steps in their terminal**, not to run the CLI directly. If running on the teammate's laptop (Code Mode on Claude Code Desktop), you CAN drive the CLI directly via Bash.

Detect this by checking whether `~/.dent-brain/` is writable. If yes, drive. If no, hand off via copy-paste.

## CRITICAL: never ask for the teammate's bearer token

The bearer token was set up by `/dent-onboard-teammate`. It lives in `~/.claude.json`. Every extension reads it automatically. Do NOT ask the teammate to find, paste, or look up their token — that's a regression. If the token isn't there, route to `/dent-onboard-teammate` first.

## Locating the CLI

The CLI is in the dent-brain plugin bundle Claude Desktop installs at:
`~/Library/Application Support/Claude/local-agent-mode-sessions/<session>/<inner>/rpm/plugin_<opaque-hash>/`

The path is unpredictable. Discover the bundle by globbing `manifest.lock.json` files. One-liner:

```bash
BUNDLE_DIR=$(find "$HOME/Library/Application Support/Claude/local-agent-mode-sessions" -path '*/rpm/plugin_*/manifest.lock.json' -exec grep -l '"plugin_name": *"dent-brain"' {} + 2>/dev/null | head -1 | xargs -I {} dirname {}) \
  && [ -f "$BUNDLE_DIR/tools/extensions/cli.ts" ] && bun "$BUNDLE_DIR/tools/extensions/cli.ts" list \
  || echo "FALLBACK_NEEDED"
```

If `FALLBACK_NEEDED`, the teammate likely has a git clone. Try `~/gh/dent-brain` / `~/Code/dent-brain`:

```bash
( cd ~/gh/dent-brain 2>/dev/null && git pull --ff-only --quiet origin main && ./tools/extensions/bin/dent-extensions list ) \
  || ( cd ~/Code/dent-brain 2>/dev/null && git pull --ff-only --quiet origin main && ./tools/extensions/bin/dent-extensions list ) \
  || echo "No dent-brain plugin and no clone found. Reinstall the Cowork plugin."
```

Throughout this skill, **`dent-extensions <verb>` refers to that resolved binary path.** Substitute it everywhere.

## Step 1. List and orient

Always start with `dent-extensions list`. It tells you what's available and what state the teammate is in for each extension.

Status badges:
- `○ not-installed` — never installed
- `⚠ unconfigured` — installed but config.json placeholders unresolved (email-sync only)
- `⚠ no-filter` — installed but no `user/filter.ts` yet → daemon is inert. THIS is the state setup addresses.
- `⚠ not-armed` — has a filter but launchd isn't loaded → preview, then arm.
- `● active` — armed and running

## Step 2. Pre-install checks

Before running the installer, confirm the upstream prerequisites:

**For granola-sync:** Granola.app must be installed AND the teammate must have signed in, granted Mic + Screen Recording permissions, and completed at least one meeting (so the local cache exists). The installer will hard-fail if Granola.app is missing; this conversation is defense in depth. Ask:

> Before I install: do you have Granola.ai set up on this Mac? Signed in, mic + screen recording allowed, and at least one meeting captured? If not, install from https://granola.ai/download and run through one meeting first — I'll wait.

The installer will also prompt for a Granola API key (Granola → Settings → Connectors → API keys). Tell the teammate up front so they don't get caught off-guard.

**For email-sync:** the teammate's email must be on the Distributed Brain Google Cloud OAuth app's test-user list. Confirm with the admin if you're unsure.

## Step 3. Install (plumbing only)

```bash
dent-extensions install <id>
```

This copies runtime + recipe files, stages the launchd plist, but does **not** bootstrap it. The daemon is inert: try to run it manually and it will fatal-out on missing `user/filter.ts`.

After this completes, run `dent-extensions status <id>` and confirm the badge is `⚠ no-filter`. That's the cue to move to setup.

The macOS Background Items notification ("Jarred Sumner may now run software in the background") fires when arm happens, not install. Mention it once when you arm, not here.

## Step 4. Setup interview — author `user/filter.ts`

This is the heart of the recipe model. You're going to interview the teammate, learn their actual data shape, and write a filter that decides what reaches the shared brain.

**Start by reading the contract:** `cat $INSTALL_DIR/recipe/RECIPE.md` (or `~/.dent-brain/<id>/recipe/RECIPE.md`). It tells you what `filter()` must export and what shape its input takes.

### 4a. granola-sync setup interview

Goal: write `~/.dent-brain/granola-sync/user/filter.ts` that captures org-relevant meetings and drops everything else.

Discovery questions (one conversational pass, not a checklist):

1. **What folders do you use in Granola?** Read them via the API:
   ```bash
   curl -sS -H "Authorization: Bearer $(security find-generic-password -s dent-brain.granola-sync -a $USER -w)" \
     "https://public-api.granola.ai/v1/folders" | jq '.folders[] | .name'
   ```
   Show the list and ask which are work and which are personal.

2. **Which email domains belong to the team?** Default is `example.com`. Ask about subsidiaries, contractors, etc.

3. **Any folders or attendee domains that should ALWAYS be excluded?** Therapy, family, personal coaching, a partner's domain, etc.

4. **What about title keywords?** Include and exclude both — e.g. include "dent" but exclude any title containing "Therapy."

Build a draft filter following the structure in `recipe/filter.example.ts` (constants up top, exclude checks first, then includes). Write it to `~/.dent-brain/granola-sync/user/filter.ts`. Use the Write tool.

### 4b. email-sync setup interview

Goal: write `~/.dent-brain/email-sync/user/filter.ts`. The email user filter has two postures — pick one with the teammate:

- **Excludelist** (default-keep, drop specific things): suits teammates whose work inbox is mostly work, with a few personal senders to filter out. Most common.
- **Allowlist** (default-drop, keep only matching senders/domains): suits teammates with substantial personal traffic on the work address.

Discovery flow:

1. Sample the recent senders on the work address:
   ```bash
   bun ~/.dent-brain/email-sync/collect.ts --dry-run --since $(date -v-14d +%Y-%m-%d) --verbose 2>&1 \
     | grep -E '^  (TRIAGE|SIG|NOISE) ' | head -50
   ```
   (Run this BEFORE writing `user/filter.ts` — the daemon will refuse to run without a filter, so write a permissive placeholder first OR use `--filter $INSTALL_DIR/recipe/filter.example.ts` to use the example.)

   Actually — easiest path: copy the example filter to user/filter.ts, then iterate:
   ```bash
   cp ~/.dent-brain/email-sync/recipe/filter.example.ts ~/.dent-brain/email-sync/user/filter.ts
   ```

2. Ask the teammate to look at the sample and tell you which senders/domains/subjects are personal. Build the exclude or allow lists from their answers.

3. Update `~/.dent-brain/email-sync/user/filter.ts` to reflect their answers. Use the Write tool — overwrite the file.

## Step 5. Preview

```bash
dent-extensions preview <id>
```

This dry-runs the daemon with the teammate's filter. For granola, it shows per-meeting `KEEP`/`SKIP` decisions over the cursor window. For email, it shows `USER-KEEP` / `USER-DROP` per email plus the canonical noise/signature flags.

Walk through the output with the teammate. Look for:

- **False positives** (KEEP that should be SKIP): personal meeting that got through, personal email that wasn't excluded. Update the filter, re-preview.
- **False negatives** (SKIP that should be KEEP): work meeting that didn't match any include signal. Update the filter, re-preview.

Loop on edit → preview until the teammate says "yes, this is what I want."

## Step 6. Arm

```bash
dent-extensions arm <id>
```

This bootstraps launchd. Daemon is now live. First run fires immediately (`RunAtLoad=true` for granola; email runs every 6h).

Tell the teammate about the macOS Background Items notification:

> macOS will show a notification: "Jarred Sumner may now run software in the background" (or similar). That's the developer ID of Bun (the runtime our daemon uses). Expected and safe.

Confirm the first run worked by tailing the log:

```bash
tail -50 ~/.dent-brain/<id>/sync.log
```

You should see filter decisions and a `done:` summary.

## Updating an already-armed install

If the teammate wants to change their filter after arming:

1. Edit `~/.dent-brain/<id>/user/filter.ts` (you can do this directly — the daemon picks up the new logic on its next scheduled run).
2. `dent-extensions preview <id>` to verify the change does what they expect.
3. No re-arm needed unless launchd has somehow lost the plist.

## Plugin updates and the user filter

Plugin updates (`/dent-update` or reinstall) overwrite the runtime + recipe files in `~/.dent-brain/<id>/` but **never touch `user/filter.ts`.** That's the contract. If a future plugin release bumps the recipe version (`RECIPE_VERSION` in types.ts), the daemon will WARN on the version mismatch but keep running with the old filter. The migration is a conversation with this skill, not a forced overwrite.

If you see a version mismatch warning in `sync.log`, walk the teammate through the migration: read `recipe/RECIPE.md` for the new contract, propose changes to their `user/filter.ts`, write the update, re-preview, done.

## Troubleshooting

**"No user filter at /…/user/filter.ts"** — install was successful but setup wasn't completed. Run the setup interview (Step 4).

**`MCP HTTP 401`** — dent-brain bearer token in `~/.claude.json` is wrong/expired. Re-run `/dent-onboard-teammate`. Daemon picks up the new token next run.

**`Granola API key rejected`** — re-run `install <id>`; the installer will re-prompt for a key and update the keychain.

**`No dent-brain MCP configured`** — teammate hasn't run `/dent-onboard-teammate` yet. Route them there first.

**Filter logs `WARN: filter declares RECIPE_VERSION=N but daemon expects M`** — recipe version mismatch (plugin update introduced a new contract). Walk through migration as above.

## Anti-patterns

- **Don't run the CLI from a Cowork agent.** Hand commands to the teammate to paste.
- **Don't ask for the bearer token.** Ever. Auto-discovery from `~/.claude.json` is the contract.
- **Don't auto-arm.** Arming is a deliberate act the teammate authorizes after seeing a preview. Don't `dent-extensions arm` without an immediately preceding `preview` they approved.
- **Don't edit recipe/ files on the teammate's machine.** Those are owned by the plugin and overwritten on update. Edit `user/filter.ts`.
- **Don't tell the teammate "the CLI couldn't be located" when their clone exists but is stale.** Always try `git pull` before giving up.

## Output format

For `list`:

```
Distributed Brain extensions:

  ● active            granola-sync       Granola → Distributed Brain sync
                      Last run 12m ago. Filter: ~/.dent-brain/granola-sync/user/filter.ts

  ⚠ no-filter         email-sync         Email → Distributed Brain sync
                      Installed but no user filter yet. Run setup.

Run `dent-extensions status <id>` for details, `setup <id>` to author a filter.
```

For `status`:

```
granola-sync — Granola → Distributed Brain sync
  ● active. Last run 12m ago. 4.2 KB logged.
  user filter:   ~/.dent-brain/granola-sync/user/filter.ts (RECIPE_VERSION=1)
  launchd:       com.dent.granola-sync (loaded)
```

Keep it scannable. The teammate is probably running this between meetings.

## Tools used

This skill instructs the teammate to run, in their own terminal (or drives them via Bash on the teammate's laptop):

- `dent-extensions list [--json]`
- `dent-extensions status <id> [--json]`
- `dent-extensions install <id>`
- `dent-extensions setup <id>`
- `dent-extensions preview <id>`
- `dent-extensions arm <id>`
- `dent-extensions configure <id>`
- `dent-extensions uninstall <id> [--keep-config]`

It uses the Write tool (when driving from the teammate's laptop) to author `~/.dent-brain/<id>/user/filter.ts`. It does NOT call the dent-brain MCP server.
