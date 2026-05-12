# Ingestors — quick reference

Two per-teammate launchd daemons. Both install via `dent-extensions install <id>`, run on the teammate's laptop, and write into the production brain via the MCP server. The brain is the queue — agent-side enrichment skills (e.g. `/dent-process-inbox`) read from the same `put_page` slugs the daemons write.

## granola-sync

- **Where:** `tools/granola-sync/`, installed to `~/.dent-brain/granola-sync/`
- **Schedule:** hourly (launchd `StartInterval=3600`)
- **Pulls from:** Granola public REST API at `https://public-api.granola.ai/v1/` — `GET /notes` (paginated) + `GET /notes/{id}?include=transcript`
- **Auth:** per-teammate API key minted in Granola → Settings → Connectors → API keys; stored in macOS keychain (service `dent-brain.granola-sync`, account `$USER`)
- **Filters to:** meetings where ANY signal fires — `folder_membership` contains `orgFolders`, title has an `orgKeywords` whole-word match, body/transcript mentions a keyword, or an attendee email is on `orgDomains`
- **Writes to brain:**
  - `meetings/<YYYY-MM-DD>-<title-slug>.md` (summary, notes, attendees, transcript link)
  - `meetings/transcripts/<YYYY-MM-DD>-<title-slug>.md` (diarized log)
  - `entities/people/<slug>.md` (timeline bullet on each attendee's page; creates stubs for unknown attendees)
- **Idempotency:** `[Source: granola/<note-id>]` tag + slug-based dedup. Cursor at `~/.dent-brain/granola-sync/cursor.json`.

## email-sync (Layer 1 — collection)

- **Where:** `tools/email-sync/`, installed to `~/.dent-brain/email-sync/`
- **Schedule:** every 6 hours (launchd `StartInterval=21600`)
- **Pulls from:** Gmail API for the teammate's `workEmail` only (scoped — never personal inboxes)
- **Auth:** one-time browser OAuth dance at install (shared "Dent Brain" Google Cloud OAuth app, test mode); refresh tokens stored locally in `~/.dent-brain/email-sync/`
- **Filters to:** noise-filtered triage entries (notifications, automation, list mail rejected by `noise-filter.ts`)
- **Writes to brain:** `inbox/<email-slug>/<YYYY-MM-DD>.md` via `put_page` (db-only, no git commit — pages age out as Layer 2 stamps them `processed: true`)

## email enrichment (Layer 2 — agent task)

- **Where:** `skills/dent/process-inbox/SKILL.md`
- **Schedule:** daily, currently a Claude Code Desktop scheduled task; better fit for a Cowork routine (unattended execution; no laptop-awake requirement)
- **Reads from brain:** every `inbox/...` page without `processed: true` frontmatter, chronologically
- **Does:** resolves the other party on each email (FileMaker lookup via fm-mcp + `detect_entities`), appends a timeline bullet to that entity's page, stamps the digest `processed: true`
- **Catch-up:** if the laptop was off (or Layer 2 didn't fire), the next run processes all backlog digests in order. No state outside the brain.
