---
name: resolve-entity
version: 1.0.0
description: |
  Disambiguate a name that resolves to 2+ FileMaker People records with
  identical Full_Name. Show the candidates, let the user pick, write the
  chosen filemaker_record_id into a new entity page. Invoked by
  /dent-append-evidence when the A5 escalation rule fires.
triggers:
  - "dent-resolve-entity"
  - "resolve this entity"
  - "which Mike"
  - "disambiguate FM record"
tools:
  - fm_find_records
  - fm_get_record
  - put_page
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
with that `Full_Name`. The skill asks the user which one, then creates
the entity page wired to the chosen `PK_People_ID`.

> **Invoked by:** `/dent-append-evidence` step 2, when `fm_find_records`
> returns 2+ rows. Can also be run standalone by the admin to clean up
> ambiguous entities.

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

- **User picks 1–N (an FM candidate):** `put_page` a new entity page at
  the appropriate slug (e.g. `entities/people/mike-cottmeyer` — derive
  from name; use kebab-case). Frontmatter must include
  `filemaker_record_id: <PK_People_ID>`. Body is a minimal stub — let
  the next `/dent-enrich` run flesh it out from FM + evidence.
- **User picks N+1 (none of these):** `put_page` a new entity page with
  no `filemaker_record_id`. Add a note in the body that FM had matching
  Full_Name records but none corresponded.
- **User picks N+2 (skip):** Return null. The calling skill drops the
  name from `entity_refs`.

### Step 4. Confirm and return

Tell the user what landed:

- New entity slug
- Whether it's FM-linked (and the PK_People_ID if so)
- The path forward ("/dent-enrich on this slug to fill out the page")

Return the slug to the caller (`/dent-append-evidence` resumes its write
flow with this slug added to `entity_refs`).

---

## Edge cases

- **Slug collision:** if the natural slug already exists in the brain,
  append a disambiguator (e.g. `mike-cottmeyer-2`) and tell the user. Do
  NOT overwrite an existing entity page.
- **All candidates are dead leads:** if the user picks "none of these"
  but doesn't want a new entity either, drop everything and return null.
- **FM unreachable:** if `fm_find_records` fails, surface the error and
  abort. The caller should drop the name from this evidence write and
  surface the failure to the user.

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

---

## Tools used

- `fm_find_records` — re-fetch FM People candidates
- `fm_get_record` — pull a single record's fields if the layout's list
  view drops anything
- `put_page` — write the new entity page with the chosen FM linkage
- `get_page` — check for slug collisions
- `search` — fuzzy slug resolution if a similar entity might already
  exist
