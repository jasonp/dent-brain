---
name: dent-append-evidence
version: 2.0.0
description: |
  Capture an observation as a bulleted item in the relevant entity
  markdown page(s). Detects which entities the observation is about,
  links new people to FileMaker via the FM MCP, appends the
  observation under `## Timeline` (when date-anchored) or wherever
  fits the page's existing structure, and lets gbrain's post-hooks
  derive timeline_entries + links automatically. The conversational
  entry point to the typed `markdown_append_to_page` primitive.
triggers:
  - "dent-append-evidence"
  - "log this"
  - "remember this"
  - "capture this evidence"
  - "add to brain"
  - "note that"
tools:
  - detect_entities
  - markdown_append_to_page
  - markdown_replace_page
  - get_page
  - search
  - query
  - fm_find_records
  - fm_get_record
mutating: true
writes_pages: true
writes_to:
  - entities/people/
  - entities/companies/
  - entities/projects/
---

# /dent-append-evidence

Capture a free-form observation, link it to the right entities, append
it to those entities' markdown pages in `dent-brain-data`. The
user-facing handle for the `markdown_append_to_page` MCP primitive.
Most volume in Dent Brain comes from ingest pipelines and `/dent-enrich`
re-syntheses; this skill is for the conversational in-the-moment
"remember this" capture.

> **Read first:** `skills/_brain-filing-rules.md` (entity slug shape) and
> `skills/conventions/quality.md` (citation rules).

> **Storage model (PLAN v2.0, since v0.27.0):** observations are bullets
> in the entity's markdown page itself, NOT rows in a separate evidence
> table. Date-anchored observations go under `## Timeline` (gbrain's
> native convention; the auto-extraction post-hook surfaces them in
> `timeline_entries` for chronological queries). Non-date-anchored
> observations go wherever the LLM judges fits the page's existing
> structure.

---

## Inputs

The user invokes the skill with a natural-language observation:

> "Remember that Mike Cottmeyer said he's transitioning out of LeadingAgile during our 2026-04-22 1:1."

The skill's job: turn that into one or more bullets appended to the
right entity pages, attributed in-line, with the right date when one is
present.

---

## Protocol

### Step 1. Entity detection (mechanical)

Call `detect_entities(text=<the observation>)`. Returns:

```json
{
  "matches": [
    {
      "slug": "entities/people/mike-cottmeyer",
      "title": "Mike Cottmeyer",
      "type": "person",
      "fm_id": "12345",
      "confidence": 1.0,
      "rule": "exact-title",
      "matched_text": "Mike Cottmeyer"
    }
  ],
  "unknowns": ["LeadingAgile"]
}
```

`matches` are confirmed brain entities — collect their slugs for the
write loop in step 4. `unknowns` are name-like strings the brain hasn't
seen — these need the FM-lookup tier next.

### Step 2. FM lookup for unknowns (A5 escalation)

For each string in `unknowns`, call `fm_find_records` against the FM
People layout (or Companies layout if the unknown looks company-like —
check by asking the user if ambiguous). Apply the **A5 escalation rule**
exactly:

| FM result | Action |
|---|---|
| **0 matches** | Ask the user: "I don't recognize '<name>' — create a stub entity for them?" If yes, write a stub entity page via `markdown_replace_page` with minimal frontmatter (title, type, today's date) and add the slug to the write list. If no, drop the name. |
| **1 match** | Auto-link. Write a new entity page via `markdown_replace_page` with `filemaker_record_id: <PK_People_ID>` in frontmatter, then add the slug to the write list. |
| **2+ matches** | Cannot resolve mechanically. Invoke `/dent-resolve-entity` with the candidate list. After the user picks one, that skill writes the entity page through `markdown_replace_page`; resume here and add the slug to the write list. |

**Email disambiguation shortcut:** if the observation includes an email
address (e.g. "from mike@leadingagile.com"), use it to disambiguate the
2+ matches case before escalating. FM treats secondary emails as lookup
keys — match against any email field on the FM record.

### Step 3. Source attribution

Infer the source the observation came from. Defaults when ambiguous:

- **observation** (manual capture from a Cowork session)
- **today's date** in ISO-8601 if the user didn't specify one

If the user said "from our 1:1 yesterday" or "from yesterday's meeting,"
prefer a meeting reference and use the meeting's existing slug if it's
in the brain (search for it first), else a date string like
`meetings/2026-04-22`.

If the user pasted from an email, use the message-id or thread URL if
available.

The source is rendered in-line in the bullet via `[Source: …]`. See
step 4.

### Step 4. Append to each entity page

For each confirmed entity slug from steps 1–2:

1. **Compose the bullet.** Two shapes:
   - **Date-anchored** (the canonical case — the observation has a date):
     ```
     - **YYYY-MM-DD** | <one-sentence summary> [Source: <source>]
     ```
     Example:
     ```
     - **2026-04-22** | Mike said he's transitioning out of LeadingAgile [Source: meetings/2026-04-22]
     ```
     The `**YYYY-MM-DD** | …` shape is the gbrain-native pattern that
     `parseTimelineEntries` recognizes — get this format right and
     gbrain's post-hook auto-populates `timeline_entries` for free.
   - **Non-date-anchored** (rare — opinions, standing facts):
     ```
     - <observation> [Source: <source>]
     ```

2. **Pick the section.** If the bullet is date-anchored, target
   `## Timeline`. The `markdown_append_to_page` op will create the
   section at EOF if the page doesn't have one. If the bullet is
   non-date-anchored and the existing page has a section that fits
   ("Notes", "Standing facts", whatever the page already uses), pass
   that. Otherwise omit `section` to append at EOF.

   **Do not invent new mandated section names.** `## Timeline` is the
   only structurally-meaningful heading in the brain. Other sections
   exist when the page's author added them; conform to what's there.

3. **Call the op:**
   ```
   markdown_append_to_page({
     slug: <entity slug>,
     section: "## Timeline" | <existing section> | omit,
     content: <the bullet>,
     commit_note: "/dent-append-evidence: " + <one-line user prompt>
   })
   ```

4. **Handle results:**
   - `status: "ok"` — record the `commit_sha` for the user-facing summary.
   - `status: "busy"` — another writer is in flight; retry once after
     a short delay, then surface to the user.
   - `error: "rate_limited"` — slow down. Tell the user the rate cap
     was hit and ask whether to drop or retry.
   - any other error — surface verbatim. Do not silently lose the
     observation.

The `markdown_append_to_page` op handles the lock + git pull/commit/push
+ Postgres re-index internally. The skill does not call `add_link` or
`add_timeline_entry` — gbrain's post-hooks fire when `performSync`
re-imports the page after the commit, so links and timeline entries are
derived state.

### Step 5. Idempotency

Two protections, none of them via a content_hash table:

1. The git layer dedups identical bullets by content. If the user runs
   `/dent-append-evidence` twice with the same observation, the second
   commit is a no-op (the bullet text is unchanged) and
   `markdown_append_to_page` short-circuits with the existing HEAD as
   `commit_sha`.
2. `add` produces no staged change if the file is byte-identical, so
   the second call returns `status: "ok"` without a real commit. Tell
   the user "I already have that observation."

If the user is intentionally appending the same bullet a second time
(e.g., to a different entity), proceed — the bullet lands on the second
entity's page, and that's a real new commit.

### Step 6. Confirm with the user

Surface a one-paragraph summary:

- The entity slugs the bullet landed on, with the `commit_sha` for each.
- If any new stub entities were created, name them.
- If any unknowns were dropped, name them.
- If the FM lookup escalated to `/dent-resolve-entity`, link to that.
- If two-way push retries fired (`rebased: true` in the result), mention
  it once — useful signal that someone else is also writing concurrently.

If anything looks off (wrong entity match, wrong date inference), the
user can correct before the next write.

---

## Anti-patterns

- **Do not append to zero entities.** If detection + FM lookup yield no
  entities, ask the user to clarify who/what before writing. Orphan
  bullets in random pages are unfindable.
- **Do not silently create stubs.** Always confirm with the user before
  writing a new entity page. Typo-driven stubs are how brains rot.
- **Do not embellish.** The bullet should be the user's observation,
  not your interpretation. Save interpretation for `/dent-enrich`
  synthesis.
- **Do not invent mandated section names.** Do NOT create
  `## Recent Observations`, `## State`, `## Notes from agent`, or any
  other dent-specific scaffold. The page's existing structure is
  authoritative; if the page has no relevant section, append at EOF.
  `## Timeline` is the one exception (gbrain-native).
- **Do not write to Postgres directly.** No `put_page` calls. Markdown
  is canonical; Postgres is the rebuildable index.

---

## Tools used

- `detect_entities` — tier-1 mechanical detection (server-side)
- `fm_find_records` / `fm_get_record` — tier-2 FM lookup (per-user FM MCP)
- `markdown_append_to_page` — the canonical write primitive
- `markdown_replace_page` — used only by step 2 when creating a brand-new
  stub entity page (no prior content to merge against)
- `search` / `query` — resolve ambiguous meeting/source references
- `get_page` — verify entity pages exist before write
