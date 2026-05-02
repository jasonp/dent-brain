---
name: append-evidence
version: 1.0.0
description: |
  Capture an observation as a Dent Brain evidence record. Detects which
  entities the observation is about, links new people to FileMaker via
  the FM MCP, writes the evidence row, and adds a timeline entry per
  entity. The conversational entry point to the typed `append_evidence`
  primitive.
triggers:
  - "dent-append-evidence"
  - "log this"
  - "remember this"
  - "capture this evidence"
  - "add to brain"
  - "note that"
tools:
  - detect_entities
  - append_evidence
  - add_timeline_entry
  - get_page
  - put_page
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

Capture a free-form observation, link it to the right entities, write it
to the evidence log. The user-facing handle for the `append_evidence`
MCP primitive. Most volume in Dent Brain comes from ingest pipelines and
`/dent-enrich` re-syntheses; this skill is for the conversational
in-the-moment "remember this" capture.

> **Read first:** `skills/_brain-filing-rules.md` (entity slug shape) and
> `skills/conventions/quality.md` (citation rules).

---

## Inputs

The user invokes the skill with a natural-language observation:

> "Remember that Mike Cottmeyer said he's transitioning out of LeadingAgile during our 2026-04-22 1:1."

The skill's job: turn that into one or more evidence rows attributed to
the right entities, with the right `source_type` / `source_ref` / dates.

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

`matches` are confirmed brain entities — go straight into `entity_refs`
on the evidence write. `unknowns` are name-like strings the brain hasn't
seen — these need the FM-lookup tier next.

### Step 2. FM lookup for unknowns (A5 escalation)

For each string in `unknowns`, call `fm_find_records` against the FM
People layout (or Companies layout if the unknown looks company-like —
check by asking the user if ambiguous). Apply the **A5 escalation rule**
exactly:

| FM result | Action |
|---|---|
| **0 matches** | Ask the user: "I don't recognize '<name>' — create a stub entity for them?" If yes, `put_page` a stub person/company page with minimal frontmatter (title, type, today's date) and add the slug to `entity_refs`. If no, drop the name from this evidence write. |
| **1 match** | Auto-link. `put_page` a new entity page with `filemaker_record_id: <PK_People_ID>` in frontmatter, then add the slug to `entity_refs`. |
| **2+ matches** | Cannot resolve mechanically. Invoke `/dent-resolve-entity` with the candidate list. After the user picks one, that skill writes the entity page; resume here and add the slug to `entity_refs`. |

**Email disambiguation shortcut:** if the observation includes an email
address (e.g. "from mike@leadingagile.com"), use it to disambiguate the
2+ matches case before escalating. FM treats secondary emails as lookup
keys — match against any email field on the FM record.

### Step 3. Source attribution

Infer `source_type` and `source_ref` from the user's phrasing. Defaults
when ambiguous:

- **`source_type`:** "observation" (manual capture from a Cowork session)
- **`source_ref`:** the date in the user's message, or today's date as
  ISO-8601 — never null when avoidable

If the user said "from our 1:1 yesterday" or "from yesterday's meeting,"
prefer `source_type: "meeting"` and `source_ref` matching that meeting's
existing slug if it's in the brain (search for it first), else a date
string like `meetings/2026-04-22`.

If the user pasted from an email, prefer `source_type: "email"` and use
the message-id or thread URL if available.

### Step 4. Write the evidence row

Call `append_evidence` with:

- `content`: the observation text, cleaned but minimally edited. Preserve
  the user's voice. Strip "remember that" / "log this" framing.
- `entity_refs`: every confirmed match slug from steps 1–2.
- `source_type` and `source_ref` from step 3.
- `observed_at`: ISO-8601 timestamp. If the user said "yesterday at 3pm,"
  resolve relative to today.
- `metadata`: `{ captured_via: "dent-append-evidence" }` — useful for
  later filtering of conversation-captured evidence vs ingest-pipeline
  evidence.

If `append_evidence` returns the same content_hash as a prior write,
note that to the user ("I already have that observation — same content
+ entities + source"). Don't re-write.

### Step 5. Timeline entries

For each entity slug in `entity_refs`, call `add_timeline_entry`:

- `slug`: the entity's page slug
- `date`: the `observed_at` date in `YYYY-MM-DD` form
- `summary`: a one-sentence summary of the observation, third person
  ("Mike said he's transitioning out of LeadingAgile" → "Mike said he's
  transitioning out of LeadingAgile")
- `detail`: leave empty for short observations; include the full content
  for longer ones
- `source`: matches the evidence row's `source_type:source_ref`

This is the part the agent does on every evidence write so the timeline
keeps growing even when `/dent-enrich` hasn't been re-run.

### Step 6. Confirm with the user

Surface a one-paragraph summary:

- The evidence id and the entity slugs it landed on
- If any new stub entities were created, name them
- If any unknowns were dropped, name them
- If the FM lookup escalated to `/dent-resolve-entity`, link to that

If anything looks off (wrong entity match, wrong date inference), the
user can correct before the next write.

---

## Anti-patterns

- **Do not write evidence with zero `entity_refs`.** The op rejects this
  and so does common sense — orphan evidence is unfindable. If detection
  + FM lookup yield no entities, ask the user to clarify who/what before
  writing.
- **Do not silently create stubs.** Always confirm with the user before
  `put_page`-ing a new entity. Typo-driven stubs are how brains rot.
- **Do not embellish.** The evidence row should be the user's
  observation, not your interpretation. Save interpretation for
  `/dent-enrich` synthesis.
- **Do not skip timeline entries.** The timeline is what makes the
  entity page legible at a glance — every evidence write adds to it.

---

## Tools used

- `detect_entities` — tier-1 mechanical detection (server-side)
- `fm_find_records` / `fm_get_record` — tier-2 FM lookup (per-user FM MCP)
- `append_evidence` — the typed write primitive
- `add_timeline_entry` — per-entity timeline append
- `put_page` — create stub entity pages when the user agrees
- `search` / `query` — resolve ambiguous meeting/source references
- `get_page` — verify entity pages exist before write
