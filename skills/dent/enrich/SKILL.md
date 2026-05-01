---
name: enrich
version: 1.0.0
description: |
  Enrich Dent Brain entity pages by synthesizing FileMaker records (when
  linked) with evidence-log observations. FM is authoritative for owned
  fields; evidence is authoritative for unstructured context. Hand-edits
  in the existing page are preserved across re-runs.
triggers:
  - "dent-enrich"
  - "enrich this person"
  - "refresh this entity"
  - "update this page from filemaker"
  - "synthesize evidence on"
tools:
  - get_page
  - put_page
  - get_evidence
  - get_provenance
  - search
  - query
  - add_link
  - get_backlinks
  - fm_get_record
  - fm_get_layout_fields
mutating: true
writes_pages: true
writes_to:
  - entities/people/
  - entities/companies/
  - entities/projects/
  - namespaces/
---

# /dent-enrich

**Forked from `skills/enrich/SKILL.md` with three Dent-specific
modifications:** FM-injection, FM-wins, merge-on-rerun. Read those
sections carefully — they're the reason this skill exists.

This skill compiles an entity page from two sources:

1. **FileMaker** — authoritative for owned fields (name, email, current
   employer, registrations, payments, tags). Reached via the FM MCP tools
   (`fm_get_record`, `fm_get_layout_fields`) which the user has installed
   locally. Dent Brain's server does NOT proxy to FileMaker.
2. **Dent Brain evidence log** — authoritative for unstructured
   observations (meeting notes, emails, observations). Reached via
   `get_evidence`.

The output is a synthesized page written via `put_page`. The user can
hand-edit the page afterward; the next `/dent-enrich` run will preserve
those edits (see "Merge-on-rerun" below).

---

## When to run

- User mentions an entity in a Cowork session and asks to "refresh" or
  "enrich" the page.
- User just appended significant new evidence and wants the compiled
  page updated.
- A new person entity was just created and needs its first synthesis.

**Do NOT run** when the page was synthesized in the last hour and no new
evidence has been appended. Re-running with no new signal wastes the
user's API budget and risks drift from preserved hand-edits.

---

## Inputs

The skill takes one argument: the **entity slug**. Examples:

- `entities/people/steve-broback`
- `entities/companies/microsoft`
- `entities/projects/dent-blend-austin`

If the user says "enrich Mike Cottmeyer" with no slug, use `query` or
`search` to resolve the slug first, then proceed.

---

## Protocol

### Step 1. Read the existing page

Call `get_page(slug)`. The page may or may not exist yet.

- **Page exists:** capture its full content (frontmatter + body) — you
  will pass it to the synthesis prompt as "prior synthesis" in Step 5.
- **Page does not exist:** create a stub with the page-type template
  matching the slug prefix (`person`, `company`, `project`, etc.), then
  proceed.

### Step 2. Read FileMaker (if linked)

Inspect the page's frontmatter for a `filemaker_record_id` field.

- **Present:** call `fm_get_record` with the layout (typically `People`
  for person entities, derive from page type otherwise) and the record
  id. Capture the returned record verbatim — every field, every value.
  This is **authoritative FM data**.
- **Absent:** skip this step. The synthesis runs on evidence alone.

If `fm_get_record` fails (network error, deleted record, permission
issue): note the failure inline in the synthesis ("FM lookup failed:
{reason}") and continue with evidence-only. Do NOT throw away the
existing page.

### Step 3. Read the evidence log

Call `get_evidence(entity_ref=slug, limit=50, include_quarantined=false)`.
Capture every record in the response.

If the evidence log is empty for this entity, that's fine — the synthesis
can still produce a useful page from the FM record alone. If it's empty
AND there's no FM record, abort with: "No FM record and no evidence —
nothing to synthesize. Append evidence first, or link the FM record id."

### Step 4. (Optional) Cross-reference

If the entity has rich connections, consider:

- `get_backlinks(slug)` — what other pages reference this one?
- `query("what do we know about <name>")` — RRF-ranked context from
  related pages.

This is texture, not authority. Keep it lightweight unless the user
explicitly asked for a deep re-synthesis.

### Step 5. Synthesize

Compile the new page content using the inputs from steps 1–4. Apply
these three rules **in order**:

#### 5a. FM-as-truth (when FM data is present)

For owned fields, FM wins. Owned fields include:

- Full name, email, secondary emails
- Current employer, role/title
- Registrations (Dent conferences, hotel nights, past attendance)
- Tags
- Payments / purchases
- LinkedIn URL, location, communication preferences

If Dent Brain evidence contradicts FM on an owned field, **note the
discrepancy inline** but keep the FM value as the rendered truth.
Example:

```markdown
## State
- **Role:** Founder, LeadingAgile [Source: FM People #12345]
- **Email:** mike@leadingagile.com [Source: FM People #12345]
- (Discrepancy: 2026-04-22 meeting notes mention Mike said he was
  "transitioning out" of LeadingAgile, but FM still lists him as Founder.
  Verify with Mike or update FM.)
```

For unstructured fields (What They Believe, What They're Building,
Hobby Horses, Trajectory, Assessment), FM has nothing to say — those
sections come entirely from evidence.

#### 5b. Merge-on-rerun (when prior synthesis exists)

Pass the **entire body of the existing page** (everything after the
closing frontmatter fence) to the synthesis prompt as "prior synthesis."
Then instruct yourself, verbatim:

> The prior synthesis below may contain hand-edits the user wrote
> directly. Preserve any human-written content verbatim. Only refine
> sections where the new FM record or new evidence adds material that
> the prior synthesis lacked. When in doubt, keep what the user wrote.

Do not parse out individual sections (`## State`, `## Trajectory`,
etc.) and overwrite them. Trust the LLM with the whole body. This
matches the v1.8 FM-as-truth posture: simpler primitives, accept
residual risk on the unstructured side.

#### 5c. Citations

Every claim in the rendered page carries an inline `[Source: ...]`
citation:

- FM-derived claims: `[Source: FM People #12345]` or
  `[Source: FM Event Registration #6789]`
- Evidence-derived claims: `[Source: evidence #<id>]` or
  `[Source: meeting 2026-04-22]` if the evidence has a `source_ref`

Section headings can drop the citation if the entire section is from a
single source — say so once at the top of the section instead.

### Step 6. Write the page

Call `put_page(slug, content)` with the synthesized content. The page's
frontmatter MUST include:

- `filemaker_record_id` (if step 2 found one — preserve it verbatim)
- `type` (person | company | project | etc.)
- `title` (the human-readable name)
- `updated` (today's date, ISO-8601)

`put_page` auto-creates outbound links and timeline entries via gbrain's
post-hooks — you do not need to call `add_link` or `add_timeline_entry`
explicitly unless the synthesis surfaces an entity that wasn't already
linked.

### Step 7. Confirm with the user

Surface a one-paragraph diff to the user: which sections were updated,
which were preserved verbatim, whether any FM-evidence discrepancies
were flagged.

If the synthesis hit any failures (FM unreachable, ambiguous prior
synthesis), name them explicitly. Do not silently degrade.

---

## Tier handling

`/dent-enrich` does NOT use the upstream `enrich` skill's tier system
(Tier 1 / 2 / 3). The Dent context is different: every entity in
`entities/people/` is in the brain because Steve or another teammate put
it there, which is itself a notability signal. There's no "skip enrichment
for low-value entities" check. If the user asked for synthesis, run it.

External-data-source lookups (Crustdata, Proxycurl, web research) are
**out of scope** for this skill in MVP. The Dent brain is fed by
FileMaker (structured) + Dropbox/Gmail/meeting notes (unstructured via
evidence). External enrichment APIs are deferred to v1+ when the team
has signal that they're worth the spend.

---

## Anti-patterns

- **Do not** overwrite user hand-edits with regenerated content. The
  merge-on-rerun rule (5b) is non-negotiable.
- **Do not** silently drop FM data when FM is unreachable. Note the
  failure in the synthesis.
- **Do not** parse the existing page into sections and replace
  section-by-section. Trust the LLM with the full body.
- **Do not** write the FM record itself into Dent Brain (no `put_page`
  to a `filemaker/` namespace). FM is the canonical store; we only read
  from it.
- **Do not** create a page when both FM and evidence are empty. Abort
  with a clear error message instead.

---

## Tools used

- `get_page` — read existing page content
- `put_page` — write the synthesized page
- `get_evidence` — pull observations for the entity
- `get_provenance` — look up source attribution for a specific evidence id
  (used when surfacing the diff in step 7)
- `search` / `query` — resolve a name to a slug, or fetch related context
- `get_backlinks` — find pages that reference this entity
- `add_link` — create cross-references when synthesis surfaces new ones
- `fm_get_record` — fetch the authoritative FM record (per-user FM auth)
- `fm_get_layout_fields` — discover field structure when the layout is
  unfamiliar
