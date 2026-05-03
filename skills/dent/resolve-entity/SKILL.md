---
name: {{prefix}}-resolve-entity
version: 2.0.0
description: |
  Disambiguate a name that resolves to 2+ FileMaker People records with
  identical Full_Name. Show the candidates, let the user pick, write the
  chosen filemaker_record_id into a new entity markdown page via
  `markdown_replace_page`. Invoked by /dent-append-evidence when the A5
  escalation rule fires.
triggers:
  - "dent-resolve-entity"
  - "resolve this entity"
  - "which Mike"
  - "disambiguate FM record"
tools:
  - fm_find_records
  - fm_get_record
  - markdown_replace_page
  - get_page
  - search
mutating: true
writes_pages: true
writes_to:
  - entities/people/
  - entities/companies/
---

# /dent-resolve-entity

Disambiguation flow for the A5 "2+ FM matches" case. The user just
mentioned a name (say, "Mike") and FM has more than one People record
with that `Full_Name`. The skill asks the user which one, then writes
a new entity page in `dent-brain-data` wired to the chosen
`PK_People_ID`.

> **Invoked by:** `/dent-append-evidence` step 2, when `fm_find_records`
> returns 2+ rows. Can also be run standalone by the admin to clean up
> ambiguous entities.

> **Storage model (PLAN v2.0, since v0.27.0):** entity pages are
> markdown files in `dent-brain-data` git, written through
> `markdown_replace_page` (because brand-new pages have no prior
> content to merge against — straight write, no hash check). Postgres
> is the rebuildable retrieval index.

---

## Inputs

The skill takes:

- `name`: the ambiguous string (e.g. "Mike")
- `email` (optional): if available, this should already have resolved the
  ambiguity upstream. If the caller still escalated, treat email as
  unhelpful and proceed.
- `context` (optional): the surrounding text from the original
  observation — helpful when the user can identify the right record from
  context alone ("oh, the one we met at Comic Con").

---

## Protocol

### Step 1. Re-fetch candidates

Call `fm_find_records` on the People layout for the given name. (The
caller already did this once but may have shed fields; re-fetch to
guarantee a fresh, complete list.) Pull the fields the user needs to
distinguish the records:

- `PK_People_ID`
- `Full_Name`
- Primary email
- Current employer / role
- Tags (if any)
- Last activity date (if surfaced by the layout)

If the second fetch returns **0 or 1 records**, abort gracefully — the
ambiguity resolved itself between calls. Tell the user, return the
single match (or null), and let `/dent-append-evidence` resume.

### Step 2. Present candidates to the user

Show the candidates as a numbered list. Each line:

```
1. Mike Cottmeyer (mike@leadingagile.com) — Founder, LeadingAgile — last seen 2026-03-14
2. Mike Coté (mike@adventium.io) — CTO, Adventium — last seen 2025-11-02
3. Mike Smith (msmith@example.com) — VP Eng, Example Corp — no recent activity
```

Plus two extra options:

- **N+1: None of these — create a new entity** (the FM People records
  are real but not the person the observation is about)
- **N+2: Skip — leave this name unresolved for now** (drop the name
  from the calling evidence write)

If `context` was passed in, include it in the prompt: "From the
observation: '<context>'. Which Mike?"

### Step 3. Apply the user's choice

- **User picks 1–N (an FM candidate):** call `markdown_replace_page` to
  write a new entity page at the appropriate slug (e.g.
  `entities/people/mike-cottmeyer` — derive from name; use kebab-case).
  The `content` is a minimal markdown stub:
  ```markdown
  ---
  title: Mike Cottmeyer
  type: person
  filemaker_record_id: 12345
  updated: 2026-04-22
  ---

  # Mike Cottmeyer

  Stub created by /dent-resolve-entity. Run /dent-enrich to flesh out
  from FM + observations.
  ```
  Omit `expected_prior_hash` — this is a brand-new page, no prior
  content to conflict with. The page is unstructured by design; the
  next `/dent-enrich` run synthesizes a fuller body when there's
  signal.

- **User picks N+1 (none of these):** call `markdown_replace_page` with
  the same stub shape but **no** `filemaker_record_id`. Add a one-line
  body note: "FM had matching Full_Name records but none corresponded
  to this person."

- **User picks N+2 (skip):** Return null. The calling skill drops the
  name from its write list.

### Step 4. Confirm and return

Tell the user what landed:

- New entity slug
- Whether it's FM-linked (and the PK_People_ID if so)
- The `commit_sha` returned by `markdown_replace_page`
- The path forward ("/dent-enrich on this slug to fill out the page")

Return the slug to the caller (`/dent-append-evidence` resumes its
write flow with this slug added to its target list).

---

## Edge cases

- **Slug collision:** before calling `markdown_replace_page`, call
  `get_page(slug)` to check whether the natural slug already exists in
  the brain. If yes, append a disambiguator (e.g. `mike-cottmeyer-2`)
  and tell the user. Do NOT overwrite an existing entity page —
  `markdown_replace_page` without an `expected_prior_hash` will
  clobber, which is wrong here.
- **All candidates are dead leads:** if the user picks "none of these"
  but doesn't want a new entity either, drop everything and return null.
- **FM unreachable:** if `fm_find_records` fails, surface the error and
  abort. The caller should drop the name from this write and surface
  the failure to the user.
- **`markdown_replace_page` returns `busy` or `rate_limited`:** retry
  once after a short delay. Past that, surface the error — do not
  silently lose the new entity write.

---

## Anti-patterns

- **Do not auto-pick** even when one candidate looks obviously right
  from context. The whole point of this skill is human disambiguation —
  guess wrong once and the brain gets a wrong FM link that's hard to
  unwind.
- **Do not write to the FM record.** This is a Dent-Brain-side write
  only. FM stays read-only in MVP.
- **Do not call `/dent-enrich`** automatically after creating the entity
  page. The user is in the middle of `/dent-append-evidence`; let that
  finish, run enrich later when ready.
- **Do not write to Postgres directly.** No `put_page` calls. Markdown
  is canonical; new entity pages flow through
  `markdown_replace_page` so the page lands as a real commit in
  `dent-brain-data` git.

---

## Tools used

- `fm_find_records` — re-fetch FM People candidates
- `fm_get_record` — pull a single record's fields if the layout's list
  view drops anything
- `markdown_replace_page` — write the new entity page with the chosen FM
  linkage
- `get_page` — check for slug collisions before writing
- `search` — fuzzy slug resolution if a similar entity might already
  exist
