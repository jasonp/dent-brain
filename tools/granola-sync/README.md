# Granola → Distributed Brain sync

A small daemon that pulls meetings from the Granola public API and pushes
org-related notes + transcripts into the brain. Runs hourly via launchd.
Distributed: each teammate runs their own copy locally, authenticated with
their own Granola API key (stored in the macOS keychain) and their own
dent-brain bearer token, so nobody's personal meetings (1:1 therapy with a
friend, family logistics calls, etc.) ever touch the shared brain.

> **As of v0.37 the daemon talks to Granola's public REST API** instead of
> reading the local cache file. Granola encrypted the cache, so the old path
> stopped working. Mint a Granola API key (Settings → Connectors → API keys)
> and re-run `install.sh` — it'll prompt you for the key the first time.

**Privacy guarantee.** The daemon only syncs meetings that pass the org-related
filter. Everything else stays local in Granola.

## Filter rules

A meeting is considered org-related if ANY of these hit (whole-word match,
case-insensitive — so the keyword `acme` matches "Acme dinner" or "ACME
sync", and whole-word matching means a keyword like `cat` won't false-match
"category" / "vacation" / "scatter"):

1. The doc is filed in a **Granola folder** whose name matches one of the
   configured `orgFolders` (default: `["Acme"]`). Strongest signal — you
   curated it yourself.
2. The meeting **title** contains one of the configured `orgKeywords`
   (default: `["acme"]`).
3. The meeting **body or transcript** mentions one of the `orgKeywords`.
   Catches meetings where the org came up substantively but isn't in the
   title.
4. ANY attendee email is from a configured `orgDomains` entry (default:
   `["example.com"]`).

Plus a `fileAll: true` config option that bypasses everything and files
every meeting. Off by default — turning it on for a cross-org user (e.g.
someone with Acme + Foo Corp + Bar Labs meetings in the same Granola)
leaks the other orgs' content into this brain.

To retarget the daemon at a different organization, drop a `config.json`
overriding `orgKeywords`, `orgFolders`, and `orgDomains`. See
`config.example.json`.

Meetings that miss every signal are skipped. Settle delay (45 min on the
last update) keeps in-flight Granola post-processing from being mistaken
for an empty meeting; those docs come back as candidates on the next run.

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

That's it — no email config, no per-teammate identity setup. The team
filter uses `@example.com` as the domain signal regardless of who's
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

# Re-sync from a specific date (overrides the cursor)
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
rm -rf ~/.dent-brain/granola-sync   # WARNING: wipes cursor + log (dent-brain token stays in ~/.claude.json)
security delete-generic-password -s dent-brain.granola-sync -a "$USER"  # remove the Granola API key
```

## Files written to your machine

| Path | Purpose |
|---|---|
| `~/.dent-brain/granola-sync/config.json` | OPTIONAL. Only created if you need to override defaults (additional your org domains, etc.). NO tokens — dent-brain token is read from `~/.claude.json`; Granola API key is read from the macOS keychain. |
| `~/.dent-brain/granola-sync/cursor.json` | Last-synced timestamp + recent note IDs (for dedup). |
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

**`no a relevant signal in title or attendees`:** the meeting was correctly skipped.
If it was a false-skip, you can force-sync it: `bun ... --doc-id not_<id>`.

**No transcript page created:** the Granola API only returns notes that have
both a summary and a transcript. If a recent meeting hasn't shown up yet,
Granola is still processing it — it'll appear on the next run. Notes the API
hasn't finished processing return 404 and are silently retried.

**Need to re-sync everything:** delete `cursor.json` (or pass `--since 1970-01-01`)
and re-run. Slug-based idempotency in the brain prevents duplicate writes.
