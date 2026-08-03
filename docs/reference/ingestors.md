# Ingestors — quick reference

Two per-teammate launchd daemons. Both install via `dent-extensions install <id>`, run on the teammate's laptop, and write into the production brain via the MCP server. The brain is the queue — agent-side enrichment skills (e.g. `/dent-process-inbox`) read from the same slugs the daemons write.

As of v0.39, both ingestors use the **recipe model**: the plugin ships canonical plumbing + a `recipe/` directory; each teammate authors their own `user/filter.ts` that decides what reaches the brain. Daemons refuse to run without a `user/filter.ts` — inert by default. See `tools/<id>/recipe/RECIPE.md` for the contract and `skills/dent/extensions/SKILL.md` for the setup conversation.

## granola-sync

- **Where:** `tools/granola-sync/`, installed to `~/.dent-brain/granola-sync/`
- **Schedule:** hourly (launchd `StartInterval=3600`)
- **Model: windowed folder reconcile.** Each run lists the filter's `includeFolders` notes from the last `GRANOLA_SYNC_LOOKBACK_HOURS` (default 48h) **server-side** (`GET /notes?folder_id=&created_after=`), skips any already in the brain via an **identity lookup** (`get_page_by_identity` on the stable `granola_document_id` — NOT a title-derived slug, so a Granola rename can't fork a duplicate), and `GET /notes/{id}?include=transcript` + files only the gaps. No local cursor — the brain is the source of truth. **Late filing self-heals** as long as the note was *created* within the window (the scan filters on creation time): file a recently-recorded meeting into an include folder and the next run ingests it. An older note needs a `--since` backfill.
- **Auth:** per-teammate API key in macOS keychain (service `dent-brain.granola-sync`, account `$USER`)
- **Filter:** `~/.dent-brain/granola-sync/user/filter.ts` (teammate-authored). Must export `includeFolders: string[]` (the capture set the daemon pulls) and `filter(note)` (a per-note narrowing gate). The daemon dynamic-imports it at startup; fatal-exits if missing or if `includeFolders` is empty. Contract lives in `tools/granola-sync/recipe/RECIPE.md`.
- **Writes to brain:**
  - `meetings/<YYYY-MM-DD>-<title-slug>.md` (summary, notes, attendees, transcript link)
  - `meetings/transcripts/<YYYY-MM-DD>-<title-slug>.md` (diarized log)
  - `entities/people/<slug>.md` (timeline bullet on each attendee's page; creates stubs for unknown attendees)
- **Idempotency:** identity dedup on the stable `granola_document_id` (`get_page_by_identity`). The pre-check skips a note only once its meeting page carries the `## Mentioned` completion marker (written last), so a run killed mid-enrichment finishes next time; attendee bullets dedup on `[Source: granola/<note-id>]`. A Granola rename reuses the existing page's slug instead of forking. `--doc-id <not_…>` force-imports one note (bypasses the folder/window scan) for operator recovery.

## email-sync (Layer 1 — collection)

- **Where:** `tools/email-sync/`, installed to `~/.dent-brain/email-sync/`
- **Schedule:** every 6 hours (launchd `StartInterval=21600`)
- **Pulls from:** Gmail API for the teammate's `workEmail` only (scoped — never personal inboxes)
- **Auth:** one-time browser OAuth dance at install (shared "Dent Brain" Google Cloud OAuth app, test mode); refresh tokens stored locally
- **Filter pipeline:** canonical `noise-filter.ts` (drops bulk-promo senders) → `user/filter.ts` (teammate-authored, runs after noise classification, receives `isNoise` + `isSignature` flags as hints, decides keep/drop) → digest. Daemon fatal-exits without a `user/filter.ts`. Contract: `tools/email-sync/recipe/RECIPE.md`.
- **Writes to brain:** `inbox/<email-slug>/<YYYY-MM-DD>.md` via `put_page` (db-only, no git commit — pages age out as Layer 2 stamps them `processed: true`)

## gws-sync (server-side, metadata-only)

Unlike granola-sync and email-sync, this one is **not** a per-teammate laptop daemon and has no `user/filter.ts`. It runs server-side inside the brain process and is **off unless three `GWS_SYNC_GOOGLE_*` secrets are set** — a brain without them does nothing differently.

- **Where:** `src/dent/ingestors/gws-sync/` (pure `card-builder`/`path-resolver`/`delta-classifier`, `drive-client`, `ingest` orchestrator, `cron`). One-time consent helper: `scripts/dent/gws-sync-oauth.ts`.
- **Schedule:** hourly cron wired in `src/dent/serve.ts`, started only when all three `GWS_SYNC_GOOGLE_*` secrets are present (silent no-op otherwise). Tunable via `GWS_SYNC_INTERVAL_SECONDS` and `GWS_SYNC_MAX_FOLDER_LOOKUPS`.
- **Model: metadata-only router, never content.** A one-time full walk seeds the map, then it rides Drive's changes feed for deltas. The cursor (Drive changes page token) banks in the dent migration v5 `gws_sync_state` table, so the crawl resumes across server redeploys.
- **Two independent gates.** A file earns a card only if it clears BOTH. They answer different questions and neither subsumes the other — see the asymmetry note below.

- **Share-scope filter (`share-scope.ts`) — "is this confidential?"** The crawl runs as a superset identity that can see private and confidential material, but the brain is team-readable — so a file earns a card only when it's actually shared beyond the crawl identity. INCLUDE: on a shared drive, granted to a group/domain/anyone, or shared with at least one real other person. EXCLUDE: private to you, you-only across your own alt accounts, you + a single configured confidential contact, and any file whose sharing the crawler can't read (fail closed). Reads *who* a file is shared with, never content. Off unless configured: `GWS_SYNC_SELF_EMAILS` = your own account(s); `GWS_SYNC_EXCLUDE_PAIR_EMAILS` = a confidential contact whose two-person docs with you stay private.

- **Relevance-scope filter (`relevance-scope.ts`) — "is this ours?"** The crawl lists every Doc/Sheet the identity can *see*, which for a long-lived account includes everything anyone has ever shared with you — a friend's league roster, a vendor's proposal, another org's plan. **Share-scope structurally cannot catch those:** the outside owner is itself the "someone other than you has access" that makes the file pass. Ownership is the discriminator, and it is the one thing an outside sharer cannot forge. INCLUDE: on a shared drive (narrowed by `GWS_SYNC_INCLUDE_DRIVE_IDS` when set, all shared drives when unset), owner's domain in `GWS_SYNC_OWNER_DOMAINS`, or owner in `GWS_SYNC_COLLABORATOR_EMAILS` / `GWS_SYNC_SELF_EMAILS`. EXCLUDE: everything else, including a file with no readable owner and no shared drive (fail closed). Off unless `GWS_SYNC_OWNER_DOMAINS` or `GWS_SYNC_COLLABORATOR_EMAILS` is set — **`GWS_SYNC_SELF_EMAILS` deliberately does NOT activate it**, since that var is already set in deployed brains and activating on it would turn a routine deploy into a silent mass-prune of every teammate-owned card.

- **Sizing the collaborator allowlist.** Contractors and long-time collaborators often own real work from personal Gmail/iCloud addresses, so domain-only is too blunt — it prunes genuine material. Derive the allowlist from the corpus rather than guessing: group existing cards by `owner_email` and allowlist any owner who owns work that belongs in the brain. Re-check it when a new contractor starts.

- **Re-seed cleanup:** one-shot `GWS_SYNC_RESEED=1` clears the cursor for one boot to force a self-pruning re-walk (re-seed adds newly-eligible cards and tombstones now-out-of-scope ones; a file that changes hands or loses its sharing on the hourly delta loses its card the same tick). This is the cleanup path after changing either filter's config — no migration script needed. All filter config is env-only — real emails live in the server config, never in source or docs.
- **No-content guarantee (built in, not promised):** Drive is read with the `drive.metadata.readonly` scope, which can't read file bodies. Sheets carry structure only (tab names + row/column counts) via a `properties`-only field mask with `includeGridData=false` — never cell values.
- **Auth:** a read-only Drive+Sheets refresh token minted by `scripts/dent/gws-sync-oauth.ts --set-railway`, which can set the `GWS_SYNC_GOOGLE_*` secrets directly so the token never lands in shell history or chat.
- **Writes to brain:** one metadata-only **pointer-card** page per Google Doc/Sheet (title, owner, path, link; for sheets, tab/column shape). All reads/writes source-scoped to `dent`.
- **Idempotency:** dedup + rename-safety via `get_page_by_identity` on `gdrive_file_id` (a Drive rename updates the card in place; a folder move refreshes its path). A trashed file tombstones its card; an un-trash resurrects it.

## Lifecycle (recipe model, v0.39+)

This lifecycle applies to the per-teammate laptop daemons (granola-sync, email-sync), not the server-side gws-sync. Both share the same four-step lifecycle:

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
