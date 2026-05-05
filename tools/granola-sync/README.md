# Granola → Dent Brain sync

A small daemon that watches your local Granola cache and pushes Dent-related
meeting notes + transcripts into the brain. Runs hourly via launchd. Distributed:
each Dent teammate runs their own copy locally with their own bearer token, so
nobody's personal meetings (1:1 therapy with a friend, family logistics calls, etc.)
ever touch the shared brain.

**Privacy guarantee.** The daemon only syncs meetings that pass the Dent-related
filter. Everything else stays local in Granola.

## Filter rules

A meeting is considered Dent-related if ANY of these hit:

1. The meeting **title** contains "dent" (case-insensitive).
2. ANY attendee email is from a **Dent team domain** (default: `@dentthefuture.com`).
3. ANY attendee email is **already an entity in the brain** (we already track them).

Meetings that miss all three are skipped. The cursor still advances past them so
they don't get re-evaluated every hour.

## What lands in the brain

For each kept meeting:

- **Meeting page** at `meetings/<YYYY-MM-DD>-<title-slug>.md` with:
  - Frontmatter: title, date, attendees, calendar link, granola_document_id
  - `## Summary` — Granola's AI summary
  - `## Notes` — Granola's structured notes (`notes_markdown`)
  - `## Chapters` — if Granola produced them
  - `## Attendees` — name + email list
  - `## Raw transcript` — link to the transcript page
- **Transcript page** at `meetings/<YYYY-MM-DD>-<title-slug>--transcript.md`
  with the diarized utterance log (mic vs system audio, relative timestamps).
  Only created if a local transcript exists in Granola's cache (older meetings
  whose transcripts have synced+deleted locally won't get this).
- **Per-attendee bullet** on each attendee's `entities/people/` page:
  `- **YYYY-MM-DD** | Attended meeting: [Title](meetings/...). [Source: granola/<id>]`
- **New stubs** in `entities/people/` for any attendee email the brain didn't
  already have a page for. `created_via: granola-sync` for traceability.

Every bullet/page carries `[Source: granola/<document-id>]` for idempotency —
re-runs of the same meeting are no-ops.

## Setup

### Prerequisites

- macOS (the launchd plist is macOS-specific; sync.ts itself runs anywhere bun does)
- [bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Granola](https://granola.ai) installed and signed in
- A personal dent-brain MCP bearer token (get one from `/dent-onboard-teammate`)
- Your `@dentthefuture.com` email address

### Install

From a fresh clone of this repo:

```bash
bash tools/granola-sync/install.sh
```

The installer will:

1. Copy the runtime files to `~/.dent-brain/granola-sync/`
2. Open `config.json` in your editor — fill in your bearer token + email
3. Install + load the launchd plist at `~/Library/LaunchAgents/com.dent.granola-sync.plist`
4. Run the first sync immediately (RunAtLoad=true)

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
rm -rf ~/.dent-brain/granola-sync   # WARNING: wipes cursor + token
```

## Files written to your machine

| Path | Purpose |
|---|---|
| `~/.dent-brain/granola-sync/config.json` | Your token + email + endpoint. `chmod 600`. |
| `~/.dent-brain/granola-sync/cursor.json` | Last-synced timestamp + recent doc IDs (for dedup). |
| `~/.dent-brain/granola-sync/sync.log` | Stdout/stderr from each scheduled run. |
| `~/.dent-brain/granola-sync/sync.ts` (+ deps) | The runtime. Updated when you re-run `install.sh`. |
| `~/Library/LaunchAgents/com.dent.granola-sync.plist` | The hourly schedule. |

Nothing goes back to your Granola data — read-only. We only touch our own
config + cursor files in `~/.dent-brain/granola-sync/`.

## Troubleshooting

**`MCP HTTP 401` in the log:** your bearer token is wrong/expired. Edit
`~/.dent-brain/granola-sync/config.json` and rerun `install.sh`.

**`Granola cache not found`:** open the Granola desktop app at least once so it
creates `~/Library/Application Support/Granola/cache-v6.json`.

**`no Dent signal in title or attendees`:** the meeting was correctly skipped.
If it was a false-skip, you can force-sync it: `bun ... --doc-id <id>`.

**No transcript page created:** Granola only keeps recent transcripts in the
local cache. Older meetings sync up to Granola's cloud and the local copy is
deleted (`transcript_deleted_at` is non-null on those documents). The meeting
page itself is still created from `notes_markdown`.

**Need to re-sync everything:** delete `cursor.json` (or pass `--since 1970-01-01`)
and re-run. Idempotency tags prevent duplicate writes.
