# Granola → Dent Brain sync

A small daemon that pulls meetings from the Granola public API and pushes
Dent-related notes + transcripts into the brain. Runs hourly via launchd.
Distributed: each Dent teammate runs their own copy locally, authenticated with
their own Granola API key (stored in the macOS keychain) and their own
dent-brain bearer token, so nobody's personal meetings (1:1 therapy with a
friend, family logistics calls, etc.) ever touch the shared brain.

> **As of v0.37 the daemon talks to Granola's public REST API** instead of
> reading the local cache file. Granola encrypted the cache, so the old path
> stopped working. Mint a Granola API key (Settings → Connectors → API keys)
> and re-run `install.sh` — it'll prompt you for the key the first time.

**Privacy guarantee.** The daemon only syncs meetings that pass the Dent-related
filter. Everything else stays local in Granola.

## What gets synced (the reconcile model)

Each run, the daemon pulls the notes in your **include folders** created in the
last `GRANOLA_SYNC_LOOKBACK_HOURS` (default 48h) — filtered server-side by
Granola, so it only fetches those folders — skips any already in the brain, and
files the rest. Two teammate-authored exports in `user/filter.ts` drive it:

1. **`includeFolders: string[]`** — the Granola folder NAMES to pull (default
   `["Dent"]`). This is the capture set. Filing a meeting into one of these
   folders is how it reaches the brain — and because every run reconciles the
   whole recent window, **filing it late still works**: drop it in the folder
   anytime within the window and the next run ingests it.
2. **`filter(note)`** — a per-note narrowing gate run on each fetched note. Use
   it to EXCLUDE within the captured folders (e.g. a private attendee). A
   folder-only filter just returns `keep: true` for everything it sees.

There is no local cursor — the brain is the source of truth for "already
ingested" (slug existence, `created_via: granola-sync`). To retarget at a
different set of folders, edit `includeFolders`. See `recipe/RECIPE.md` for the
full contract.

The Granola API only returns notes that already have a summary + transcript, so
in-flight meetings simply don't appear yet (they return 404 and are picked up on
a later run once ready — no settle delay needed).

## What lands in the brain

For each kept meeting:

- **Meeting page** at `meetings/<YYYY-MM-DD>-<title-slug>.md` with:
  - Frontmatter: title, date, attendees, granola_url, granola_document_id
  - `## Summary` — Granola's plain-text AI summary (`summary_text`)
  - `## Notes` — Granola's markdown summary (`summary_markdown`)
  - `## Attendees` — name + email list
  - `## Raw transcript` — link to the transcript page
- **Transcript page** at `meetings/transcripts/<YYYY-MM-DD>-<title-slug>.md`
  with the diarized utterance log (mic vs remote, relative timestamps).
  The Granola API only returns notes that have a generated summary + transcript,
  so unprocessed meetings simply don't appear (we re-check them on the next run).
- **Per-attendee bullet** on each attendee's `entities/people/` page:
  `- **YYYY-MM-DD** | Attended meeting: [Title](meetings/...). [Source: granola/<id>]`
- **New stubs** in `entities/people/` for any attendee email the brain didn't
  already have a page for. `created_via: granola-sync` for traceability.

Every bullet/page carries `[Source: granola/<document-id>]` for idempotency —
re-runs of the same meeting are no-ops.

## Setup

### Prerequisites

- macOS (launchd + keychain are macOS-specific; sync.ts itself runs anywhere bun does)
- [bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Granola](https://granola.ai) installed and signed in
- A **Granola API key** minted in the desktop app: Settings → Connectors → API
  keys → Create new key. Available on Granola Business/Enterprise plans; on
  Enterprise, your workspace admin must enable "Allow personal API keys".
- The dent-brain MCP server registered in `~/.claude.json` — set up by
  `/dent-onboard-teammate` via `claude mcp add dent-brain ...`. The daemon
  reads the bearer token + URL from there at runtime.

That's it — no email config, no per-teammate identity setup. The Dent-team
filter uses `@dentthefuture.com` as the domain signal regardless of who's
running the daemon.

### Install

From a fresh clone of this repo:

```bash
bash tools/granola-sync/install.sh
```

The installer will:

1. Verify `~/.claude.json` has a `dent-brain` MCP entry with a Bearer token
2. Check the macOS keychain for a Granola API key. If missing or rejected by
   the API, prompt you to paste one (you mint it in Granola → Settings →
   Connectors → API keys). The key is stored under service
   `dent-brain.granola-sync` / account `$USER` and never leaves your laptop.
3. Copy the runtime files to `~/.dent-brain/granola-sync/`
4. Install + load the launchd plist at `~/Library/LaunchAgents/com.dent.granola-sync.plist`
5. Run the first sync immediately (RunAtLoad=true)

Subsequent re-runs are no-prompt as long as the stored key still works.

After install, tail the log to watch the first sync:

```bash
tail -f ~/.dent-brain/granola-sync/sync.log
```

### Manual operations

```bash
# Dry run (no writes, prints the plan)
bun ~/.dent-brain/granola-sync/sync.ts --dry-run

# Verbose dry run (logs every doc decision, including skips)
bun ~/.dent-brain/granola-sync/sync.ts --dry-run --verbose

# Sync a specific meeting by Granola document id (find it in Granola's URL bar)
bun ~/.dent-brain/granola-sync/sync.ts --doc-id <granola-uuid>

# Widen the reconcile window back to a specific date (backfill)
bun ~/.dent-brain/granola-sync/sync.ts --since 2026-04-01

# Cap how many meetings get processed in one run
bun ~/.dent-brain/granola-sync/sync.ts --limit 3

# launchd status
launchctl print gui/$(id -u)/com.dent.granola-sync

# Stop the agent (until next install/load)
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.dent.granola-sync.plist
```

### Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.dent.granola-sync.plist
rm ~/Library/LaunchAgents/com.dent.granola-sync.plist
rm -rf ~/.dent-brain/granola-sync   # WARNING: wipes user/filter.ts + log (dent-brain token stays in ~/.claude.json)
security delete-generic-password -s dent-brain.granola-sync -a "$USER"  # remove the Granola API key
```

## Files written to your machine

| Path | Purpose |
|---|---|
| `~/.dent-brain/granola-sync/config.json` | OPTIONAL. Only created if you need to override defaults (additional Dent domains, etc.). NO tokens — dent-brain token is read from `~/.claude.json`; Granola API key is read from the macOS keychain. |
| `~/.dent-brain/granola-sync/user/filter.ts` | Teammate-authored. Exports `includeFolders` (folders to pull) + `filter()` (narrowing gate). |
| `~/.dent-brain/granola-sync/sync.log` | Stdout/stderr from each scheduled run. |
| `~/.dent-brain/granola-sync/sync.ts` (+ deps) | The runtime. Updated when you re-run `install.sh`. |
| `~/Library/LaunchAgents/com.dent.granola-sync.plist` | The hourly schedule. |
| macOS keychain (`dent-brain.granola-sync`) | Your Granola API key. View/edit in Keychain Access.app or via `security find-generic-password -s dent-brain.granola-sync -a "$USER" -w`. |

The daemon is read-only against Granola — it only makes GET requests to
`https://public-api.granola.ai/v1/`. It never modifies your Granola data.

## Troubleshooting

**`MCP HTTP 401` in the log:** your bearer token in `~/.claude.json` is
wrong/expired. Re-run `/dent-onboard-teammate` to mint a new one (the new
value lands in claude.json and the daemon picks it up next run — no
re-install needed).

**`Granola API 401` in the log:** your Granola API key was revoked or expired.
Mint a new one in Granola (Settings → Connectors → API keys) and either re-run
`install.sh` (it'll re-prompt) or update the keychain directly:
`security add-generic-password -U -s dent-brain.granola-sync -a "$USER" -w 'grn_...'`.

**`No Granola API key in keychain`:** the keychain entry is missing. Re-run
`install.sh` and paste the key when prompted.

**`no Dent signal in title or attendees`:** the meeting was correctly skipped.
If it was a false-skip, you can force-sync it: `bun ... --doc-id not_<id>`.

**No transcript page created:** the Granola API only returns notes that have
both a summary and a transcript. If a recent meeting hasn't shown up yet,
Granola is still processing it — it'll appear on the next run. Notes the API
hasn't finished processing return 404 and are silently retried.

**Need to backfill older meetings:** pass `--since <date>` to widen the reconcile
window (e.g. `--since 2026-01-01`) and re-run. The brain-existence check skips
everything already filed, so only the gaps are fetched and written — no duplicates.
