# Dent Brain v2.0 — Markdown-canonical pivot

**Status:** Draft 2026-05-02. Supersedes PLAN v1.8's Postgres-canonical
evidence model. Triggered by manual gate test on 2026-05-02 surfacing
that no agent-driven write was reaching `dent-brain-data` git, and that
the v1.8 promise of "git history of dent-brain-data IS the
snapshot/revert mechanism" was false.

> **Existing PLAN.md (v1.8) becomes historical** once v2.0 ships. Phases
> 0, 0.5, 1, 2, 3, 4 already shipped under v1.8 — most code retargets
> rather than gets deleted. The `evidence` table goes; everything else
> retargets to write through markdown.

---

## Why this plan exists

Upstream gbrain README line 441 states the model unambiguously:

> **The repo is the system of record. GBrain is the retrieval layer.
> The agent reads and writes through both. Human always wins... edit
> any markdown file and `gbrain sync` picks up the changes.**

We deviated:

1. Phase 1 introduced a Postgres-only `evidence` table with no markdown
   counterpart. Every `append_evidence` call wrote to Postgres only.
   `dent-brain-data` git history never saw the writes.
2. `/dent-enrich` and `/dent-append-evidence` skills call `put_page` and
   `add_timeline_entry` against Postgres. Postgres → markdown writeback
   was promised by PLAN v1.8's "git history is the snapshot mechanism"
   line but was never implemented.
3. The merge-on-rerun rule in `/dent-enrich` reads the existing page
   from Postgres, not from disk, so it would never preserve a human
   markdown edit that hadn't been re-synced.

Manual gate test on 2026-05-02 confirmed all three: Steve Broback page
written via Cowork, evidence + timeline rows in Postgres, but
`~/gh/dent-brain-data/entities/people/steve-broback.md` was unchanged
and the writes were invisible to git.

## Target architecture

```
                       ┌──────────────────────────────────────────┐
                       │  github.com/dentthefuture/dent-brain-data │
                       │  (canonical: markdown + git)              │
                       └──────────────────────────────────────────┘
                              ↑                       ↑
                              │ git push              │ git pull (per teammate)
                              │                       │
        ┌─────────────────────┴─────────┐   ┌─────────┴──────────┐
        │  dent-brain Railway server    │   │  Teammate Mac      │
        │                               │   │  (optional clone)  │
        │  - working clone of           │   │                    │
        │    dent-brain-data            │   │  - hand-edit *.md  │
        │  - Postgres index             │   │  - git push        │
        │  - MCP /mcp endpoint          │   │  - server pulls    │
        │  - signal ingestion cron      │   │                    │
        └────────┬──────────────────────┘   └────────────────────┘
                 │ MCP over HTTP (bearer token)
                 │
        ┌────────┴───────────┐
        │  Cowork (per user) │
        │  + FM MCP (stdio)  │
        │  + RegFox / etc    │
        └────────────────────┘
```

Four principles:

1. **Markdown is canonical.** Every fact about an entity lives as text
   in `dent-brain-data/.../some-file.md`. Postgres is rebuildable from
   the repo via `gbrain sync`.
2. **Pages are unstructured markdown.** Dent skills do not impose
   templates with mandatory sections. The only structural conventions
   we lean on are gbrain-native ones (`## Timeline`, frontmatter fields
   gbrain parses). Entity pages can be three sentences or three thousand
   words. The agent reads the existing structure and conforms — it
   never invents a fixed scaffold like `## Recent Observations` or
   `## State`.
3. **Agent reads + writes through both.** Cowork-driven writes go:
   server's local clone → commit + push → re-index Postgres. Reads go
   through Postgres for speed. Same agent-side ergonomics as today;
   the storage layer changes.
4. **Human always wins.** Three-way merge on every agent write: agent
   reads current markdown, generates new content, merges preserving
   human-only deltas, writes back. Cross-teammate conflicts handled by
   git pull/merge in the normal way.

## Audit: native gbrain reuse vs new dent-fork code

Per Jason's request: explicit catalog of what gbrain already ships vs
what dent-fork has to add. The principle is "use native gbrain whenever
possible; fork only when gbrain has no answer."

### Already in gbrain — REUSE without modification

| Need | Native gbrain provides | Path |
|---|---|---|
| Read all markdown from a git repo into Postgres | `performSync(engine, opts)` | `src/commands/sync.ts` |
| Parse markdown frontmatter + body | `parseMarkdown(content, opts)` | `src/core/markdown.ts:61` |
| Serialize page back to markdown | `serializeMarkdown(...)` | `src/core/markdown.ts:318` |
| Write Postgres pages out to disk as markdown | `runExport(engine, args)` | `src/commands/export.ts` |
| Parse timeline entries from `## Timeline` section | `parseTimelineEntries(content)` | `src/core/link-extraction.ts` |
| Auto-link extraction on `put_page` | post-hook in `put_page` | `src/core/operations.ts:289` |
| Auto-timeline extraction on `put_page` | post-hook in `put_page` | `src/core/operations.ts:289` |
| Multi-source brain support (one brain, many repos) | `pages.source_id` + `sources` CLI | v0.18.0 |
| Storage tiering (some dirs git-tracked, some db-only) | `gbrain.yml` + `loadStorageConfig` | `src/core/storage-config.ts` |
| Git wrapping (pull, status, head, etc.) | `git(repoPath, ...args)` helper | `src/commands/sync.ts:192` |
| Hybrid search (vector + keyword + RRF) | `query` op | upstream |
| Embedding pipeline | gbrain core | upstream |
| Bearer auth + audit log | `mcp_request_log` + `access_tokens` | upstream v0.22.7 |

The gbrain README + code prove this point: **the markdown-canonical model
is the gbrain default, and gbrain has every primitive we need to honor it.
The only thing missing for our use case is "agent writes through both" — the
glue between `put_page` and `runExport` + git.**

### Dent-fork additions — KEEP, retarget the storage tail

| Component | Status | What changes |
|---|---|---|
| `detect_entities` MCP op | **Keep as-is** | Pure query, no storage. |
| `src/dent/entity-detection/` service | **Keep as-is** | Pure query. |
| `/dent-enrich` skill | **Retarget** | Synthesis logic stays. Output now flows through the new `markdown_put_page` helper instead of raw `put_page`. The merge-on-rerun rule applies to the markdown file as the prior synthesis. |
| `/dent-append-evidence` skill | **Rewrite** | No more `evidence` table. Skill detects entities, reads the entity page from markdown, appends the observation as a bulleted item with an inline citation, placed in the section of the page where it fits given the page's current structure. Date-anchored observations go under `## Timeline` (gbrain auto-extracts entries from there into `timeline_entries` for chronological queries — that's a native gbrain convention, not a dent template). Non-date-anchored observations go wherever the LLM judges best given the existing prose. Writes back via `markdown_put_page`. |
| `/dent-resolve-entity` skill | **Retarget** | Same flow; writes the new entity stub through `markdown_put_page`. |
| FM federation (`fm_get_record`, etc.) | **Keep as-is** | Per-user stdio. Out of scope for storage redesign. |
| Plugin manifest + install flow | **Keep as-is** | Bearer-token install pattern unchanged. Add optional teammate-side `git clone` step in `/dent-onboard-teammate`. |
| Schema-drift guard in `serve.ts` | **Keep as-is** | Still useful regardless of storage model. |
| Handler-error logging in `serve.ts` | **Keep as-is** | Still useful. |

### Dent-fork additions — DELETE

| Component | Why |
|---|---|
| `evidence` table | No markdown counterpart. Phase 1 invention with no upstream parallel. |
| `append_evidence` MCP op | Replace with `markdown_put_page` + skill orchestration. |
| `get_evidence` MCP op | Replace with `query` / `search` — the normal gbrain retrieval path. Observations live as text in entity pages and surface through hybrid search. |
| `quarantine_batch` MCP op | Quarantine becomes a markdown convention (move file to `_quarantined/<slug>.md` or add a `quarantined: true` frontmatter flag). |
| `get_provenance` MCP op | Provenance lives in citation text inline with each bullet (`[Source: meeting 2026-04-22]`). gbrain already supports this convention. |
| Dent migration v1 (evidence schema) | Withdrawn by migration v3. |
| Dent migration v2 (drop evidence.author) | Withdrawn by migration v3. |
| `src/dent/operations/evidence.ts` | Deleted. |
| `test/dent/evidence/*.test.ts` | Deleted. |

### NET-NEW dent-fork code (minimal)

| Component | Lines (est) | Why no native equivalent |
|---|---|---|
| `markdown_put_page` MCP op + service helper | ~150 | gbrain's `put_page` writes Postgres only; gbrain's `runExport` writes disk only; no primitive does both with three-way merge + commit + push. |
| Server-side dent-brain-data clone management (init, pull, push, lock) | ~100 | gbrain assumes the operator owns the repo locally; for a Railway-hosted multi-writer server, we need a managed clone with concurrency-safe writes. |
| Three-way merge helper | ~80 | gbrain's merge-on-rerun rule lives in skill prose, not code. We need a deterministic helper for non-LLM writes. |
| Dent migration v3 (drop evidence, drop dent_version 1+2 schema bits) | ~20 | Just a `DROP TABLE` migration. |
| `/dent-onboard-teammate` augmentation: optional `git clone` step | ~30 | Existing skill handles MCP registration; we add the optional clone for hand-editors. |
| Server-side ingestion stubs (RegFox first, Gmail/Granola later) | Phase 5+ | Out of v2.0 scope. |

**Total net-new for v2.0 pivot: ~380 lines.** The audit confirms gbrain is
doing 90%+ of the heavy lifting; our job is to wire the pieces it already
has into a "writes go to git first, then to Postgres" loop.

## The new write path (one diagram)

```
agent calls markdown_put_page(slug, new_content) ─┐
                                                  ▼
        ┌───────────────────────────────────────────────────────────┐
        │ 1. acquire repo lock (advisory, per-repo)                 │
        │ 2. git pull --ff-only origin master                       │
        │ 3. read existing markdown file (if exists)                │
        │ 4. three-way merge: prior + new + user-edits-since-prior  │
        │ 5. serializeMarkdown(merged) → write to disk              │
        │ 6. git add <file> && git commit -m "agent: <slug>"        │
        │ 7. git push                                                │
        │ 8. performSync(engine, { repoPath, sourceId: 'dent' })    │
        │    — refreshes the Postgres index for this slug           │
        │ 9. release lock, return result                             │
        └───────────────────────────────────────────────────────────┘
```

Failure handling:
- **Lock contention:** retry with exponential backoff up to 30s, then
  return a `{error: 'busy'}` so the caller can decide. (Realistic
  collision rate: very low — agent writes are bursty but not parallel.)
- **`git pull` conflicts:** abort the write, return `{error: 'merge_conflict'}`,
  surface the conflicting file paths. Human resolves via the local
  clone.
- **`git push` rejected:** repeat steps 2–7 once. If still rejected,
  return error.
- **`performSync` fails after push:** the markdown is canonical and is
  already in git. Postgres index is stale until next sync. Log a warning,
  return success on the write — Postgres will catch up on next sync.

## Phases

**Phase 0 — Plan ratification.** This document. Land it; archive PLAN.md
v1.8 sections that v2.0 supersedes into PLAN_AUDIT_TRAIL.md.

**Phase 1 — Server-side clone + `markdown_put_page` primitive.**
1. Provision `dent-brain-data` clone at `/app/dent-brain-data/` on Railway.
   GitHub deploy key stored as a Railway env var.
2. Implement `src/dent/markdown-writer/` service with `writeMarkdownPage(slug, content, options)` doing the 9-step flow above.
3. Register `markdown_put_page` MCP op in `src/dent/operations/`.
4. Tests: TS unit tests for the merge helper, integration test against a
   throwaway local git repo (no Railway needed).
5. **Gate:** call `markdown_put_page` from a script, observe a commit
   land in `dent-brain-data` with the expected content.

**Phase 2 — Drop `evidence`, retarget skills.**
1. Dent migration v3: `DROP TABLE evidence` + clean up dent_version 1/2
   schema bits. Apply to prod.
2. Delete `src/dent/operations/evidence.ts`, `src/dent/migrate.ts`'s v1+v2
   blocks, all `test/dent/evidence/*` files, the four evidence MCP ops.
3. **Wipe orphaned test pages from prod Postgres.** Steve's stub from
   2026-05-02 + any other fake-data pages that exist in Postgres but
   not in `dent-brain-data` get deleted. Fresh start; no migration
   gymnastics needed because the data is fake.
4. Rewrite `/dent-append-evidence` skill: detect entities → read entity
   page from markdown → append observation bullet with inline citation,
   placed under `## Timeline` if date-anchored, otherwise wherever the
   LLM judges fits the existing page structure → call `markdown_put_page`.
   No mandated sections.
5. Retarget `/dent-enrich` skill: synthesis output flows through
   `markdown_put_page`. Merge-on-rerun reads from disk, not Postgres.
6. Retarget `/dent-resolve-entity` skill: stub-page writes go through
   `markdown_put_page`.
7. Update skill contract tests to match new prose. Specifically: the
   contract tests should now assert that no skill prose mandates a
   structural section name like `## Recent Observations` or `## State`.
   The only structural reference allowed is `## Timeline` (gbrain-native).
8. **Gate:** repeat the 2026-05-02 manual test — Cowork session writes
   an observation about Steve, observe the change appear in
   `~/gh/dent-brain-data/entities/people/steve-broback.md` AND on github
   within 60s. Run a `git log` and confirm a commit attributed to the
   server. Confirm the observation lives in whatever section of the page
   makes sense (e.g. under `## Timeline` if date-anchored), not a
   mandated scaffold heading.

**Phase 3 — Teammate hand-edit path.**
1. `/dent-onboard-teammate` skill gains an optional "clone the repo
   locally" step with one-paste instructions.
2. Document the workflow in DEPLOY.md or a new TEAMMATE_GUIDE.md: how
   to pull, edit, push, see your changes reflected in Cowork queries
   (after server pulls + re-syncs).
3. **Gate:** Jason or Steve hand-edits Steve's page locally, pushes,
   runs `query` from a Cowork session, sees the new content.

**Phase 4 — Server pulls on a schedule.**
1. Cron entry on the dent-brain server: every 5 min, `git pull --ff-only`
   + `performSync` if HEAD changed.
2. Document the lag window for teammates ("expect 5-min delay between
   git push and Cowork seeing it").
3. **Gate:** observe a teammate-side push appear in Cowork query results
   without manual intervention within the lag window.

**Phase 5+ — signal ingestion (server-side, post-pivot).**
Existing PLAN v1.8 Phase 5 (Dropbox) carries forward. RegFox API ingestor
is a new candidate. All ingestors write markdown into the server's clone
+ commit + push, same as agent writes. No new write paths.

## What about evidence-as-history?

Jason explicitly said: *"It's OK not to have a clear evidence log of who
added what to the markdown files."*

So we don't keep the evidence table even as a derived cache. The audit
trail comes from two existing places:

1. **Git commit history** for what the agent + teammates wrote.
2. **`mcp_request_log`** for who-called-which-MCP-op-when (token name,
   timestamp, latency, status). This stays as upstream provides it.

If a future need surfaces — e.g., "show me every observation Steve added
about a person in the last week" — we run a `git log` against the data
repo. Or we add an evidence-log file convention later (`logs/<date>.md`).
But not as a primary store.

## Decisions (signed off 2026-05-02)

1. **Repo lock primitive:** Postgres advisory lock keyed on a repo
   identifier. Survives a Railway deploy roll where multiple server
   instances briefly co-exist; centralized; one DB roundtrip per write
   is acceptable cost.
2. **GitHub auth for the server:** deploy key scoped to
   `dentthefuture/dent-brain-data`. Stored as a Railway env secret.
   Smaller blast radius than a PAT.
3. **Per-token write rate limit on `markdown_put_page`:** 30 writes per
   minute per token. Returns `{error: 'rate_limited'}` past the cap.
4. **Three-way merge mechanism:** `diff3`-style merge. Clean merges
   commit through. On conflict, return `{error: 'merge_conflict', files:
   [...]}` and let the caller (skill prose or, ultimately, a human)
   resolve. No silent overwrites of human edits — ever.
5. **Orphaned Postgres pages:** delete, don't reconcile. Fake-data era;
   clean slate.
5. **Resolved.** Orphaned Postgres pages (Steve's stub from 2026-05-02,
   any other fake-data writes that never made it to `dent-brain-data`)
   get deleted, not reconciled. We're testing with fake data; clean
   slate is faster and lower-risk than `gbrain export --restore-only`
   gymnastics. See Phase 2 step 3.

## Success criteria for v2.0 ship

1. Steve Broback's page edits — agent-side AND human-side — appear in
   `dent-brain-data` git history within 60s of the write.
2. `gbrain query "Steve Broback"` returns content the agent just wrote,
   sourced from the Postgres index that was refreshed via `performSync`.
3. The `evidence` table is gone. `dent_version` shows the v3 drop.
4. `/dent-append-evidence`, `/dent-enrich`, `/dent-resolve-entity` all
   pass their contract tests against the new markdown-write storage.
5. A teammate can clone `dent-brain-data` locally, edit a markdown file,
   push, and see the change in their next Cowork query within 5 min.
6. Audit table above is honest — no fork code that duplicates a gbrain
   primitive.

---

## Appendix: what we're NOT doing in v2.0

- We are NOT removing PostgreSQL. Postgres is the retrieval index. It
  stays.
- We are NOT changing how Cowork connects (still HTTP MCP + bearer token
  + per-user FM stdio).
- We are NOT changing the FileMaker federation pattern.
- We are NOT building a Postgres → markdown materializer that runs
  asynchronously. Writes go to markdown synchronously (with an advisory
  lock and a retry budget).
- We are NOT moving evidence to a per-entity log file like
  `entities/people/steve-broback-evidence.md`. Per Jason's call:
  observations become bullets in the entity page itself.
- We are NOT extracting RegFox or Gmail ingestion into v2.0. Those are
  Phase 5+, post-pivot. The pivot is a storage-model fix, not an ingest
  story.
