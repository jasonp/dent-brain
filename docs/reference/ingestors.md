# Ingestors — quick reference

Two per-teammate launchd daemons. Both install via `dent-extensions install <id>`, run on the teammate's laptop, and write into the production brain via the MCP server. The brain is the queue — agent-side enrichment skills (e.g. `/dent-process-inbox`) read from the same slugs the daemons write.

As of v0.39, both ingestors use the **recipe model**: the plugin ships canonical plumbing + a `recipe/` directory; each teammate authors their own `user/filter.ts` that decides what reaches the brain. Daemons refuse to run without a `user/filter.ts` — inert by default. See `tools/<id>/recipe/RECIPE.md` for the contract and `skills/dent/extensions/SKILL.md` for the setup conversation.

## granola-sync

- **Where:** `tools/granola-sync/`, installed to `~/.dent-brain/granola-sync/`
- **Schedule:** hourly (launchd `StartInterval=3600`)
- **Pulls from:** Granola public REST API at `https://public-api.granola.ai/v1/` — `GET /notes` (paginated) + `GET /notes/{id}?include=transcript`
- **Auth:** per-teammate API key in macOS keychain (service `dent-brain.granola-sync`, account `$USER`)
- **Filter:** `~/.dent-brain/granola-sync/user/filter.ts` (teammate-authored). The daemon dynamic-imports it at startup; fatal-exits if missing. Contract lives in `tools/granola-sync/recipe/RECIPE.md`.
- **Writes to brain:**
  - `meetings/<YYYY-MM-DD>-<title-slug>.md` (summary, notes, attendees, transcript link)
  - `meetings/transcripts/<YYYY-MM-DD>-<title-slug>.md` (diarized log)
  - `entities/people/<slug>.md` (timeline bullet on each attendee's page; creates stubs for unknown attendees)
- **Idempotency:** `[Source: granola/<note-id>]` tag + slug-based dedup. Cursor at `~/.dent-brain/granola-sync/cursor.json`.

## email-sync (Layer 1 — collection)

- **Where:** `tools/email-sync/`, installed to `~/.dent-brain/email-sync/`
- **Schedule:** every 6 hours (launchd `StartInterval=21600`)
- **Pulls from:** Gmail API for the teammate's `workEmail` only (scoped — never personal inboxes)
- **Auth:** one-time browser OAuth dance at install (shared "Distributed Brain" Google Cloud OAuth app, test mode); refresh tokens stored locally
- **Filter pipeline:** canonical `noise-filter.ts` (drops bulk-promo senders) → `user/filter.ts` (teammate-authored, runs after noise classification, receives `isNoise` + `isSignature` flags as hints, decides keep/drop) → digest. Daemon fatal-exits without a `user/filter.ts`. Contract: `tools/email-sync/recipe/RECIPE.md`.
- **Writes to brain:** `inbox/<email-slug>/<YYYY-MM-DD>.md` via `put_page` (db-only, no git commit — pages age out as Layer 2 stamps them `processed: true`)

## Lifecycle (recipe model, v0.39+)

Both ingestors share the same four-step lifecycle:

```
install   → plumbing copies to ~/.dent-brain/<id>/. Daemon is inert (no user/filter.ts).
setup     → /dent-extensions skill interviews teammate, writes user/filter.ts.
preview   → dent-extensions preview <id>   # dry-run, no writes; verify the filter
arm       → dent-extensions arm <id>       # bootstraps launchd; daemon goes live
```

The `recipe/` directory in the install dir contains `RECIPE.md` (contract doc) and `filter.example.ts` (starting point). Plugin updates overwrite recipe and runtime files but **never** touch `user/`. Recipe-version mismatches surface as warnings, not fatals.

## email enrichment (Layer 2 — agent task)

- **Where:** `skills/dent/process-inbox/SKILL.md`
- **Runtime:** **Cowork scheduled routine** (daily, Sonnet). Server-side execution means it fires regardless of laptop state. Empirically confirmed Cowork can reach fm-mcp for the FileMaker fallback.
- **Reads from brain:** every `inbox/...` page without `processed: true` frontmatter, chronologically
- **Does:** resolves the other party on each email (FileMaker lookup via fm-mcp + `detect_entities`), appends a timeline bullet to that entity's page, stamps the digest `processed: true`
- **Catch-up:** if a run is missed, the next run processes all backlog digests in order. No state outside the brain.

See `docs/reference/runtime-conventions.md` for the Code-Desktop-vs-Cowork surface convention that puts Layer 1 (collection) on Code Desktop and Layer 2 (enrichment) on Cowork.
