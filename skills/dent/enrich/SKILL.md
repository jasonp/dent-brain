---
name: enrich
version: 2.0.0
description: |
  Re-synthesize a Dent Brain entity page from its current markdown,
  the linked FileMaker record (when present), and related context
  surfaced through hybrid search. FM is authoritative for owned
  fields; the existing markdown body — including any human
  hand-edits — is preserved verbatim except where new signal warrants
  refinement. Output is written through markdown_replace_page with
  optimistic concurrency.
triggers:
  - "dent-enrich"
  - "enrich this person"
  - "refresh this entity"
  - "update this page from filemaker"
  - "synthesize observations on"
tools:
  - get_page
  - markdown_replace_page
  - search
  - query
  - get_backlinks
  - get_timeline
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
2. **The entity's existing markdown page** — authoritative for everything
   else: prior synthesis, hand-edits, observation bullets accumulated
   under `## Timeline`. Reached via `get_page` (which reads the
   Postgres index that was last refreshed from `dent-brain-data` git).

The output is a synthesized page written through `markdown_replace_page`
with `expected_prior_hash` for optimistic concurrency. If a teammate or
another agent rewrote the page between read and write, the op returns
`page_changed` with the current text and the agent re-synthesizes
against the fresh state.

> **Storage model (PLAN v2.0, since v0.27.0):** observations live as
> bullets in the entity page itself, not in a separate evidence table.
> "Read the evidence" now means "read the page body." Cross-page mentions
> surface through `get_backlinks` and `query`.

---

## When to run

- User mentions an entity in a Cowork session and asks to "refresh" or
  "enrich" the page.
- User just appended significant new observations and wants the
  compiled page updated.
- A new person entity was just created and needs its first synthesis.

**Do NOT run** when the page was synthesized in the last hour and no new
observations have been appended. Re-running with no new signal wastes
the user's API budget and risks drift from preserved hand-edits.

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
  will pass it to the synthesis prompt as "prior synthesis" in Step 5,
  AND you'll need the full bytes to compute `expected_prior_hash` for
  the write in Step 6. **Save the full content as `prior` for both
  uses.**
- **Page does not exist:** abort with a clear message ("No page at
  <slug>. Use `/dent-resolve-entity` to create the stub first, or
  `/dent-append-evidence` to capture an observation that creates one.").
  `/dent-enrich` is a re-synthesis primitive, not a stub creator.

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

### Step 3. Read related context

The entity's own page is the primary signal. Two cheap lookups add
texture:

- `get_backlinks(slug)` — what other pages reference this one? Useful
  for "Mike was mentioned in meetings/2026-04-22 and meetings/2026-05-01"
  cross-references.
- `query("<entity title or other distinguishing phrase>")` — RRF-ranked
  hits across the brain. Catches obliquely-related context (other
  pages that mention the entity by alias, or that talk about the same
  topic).

This is texture, not authority. Keep it lightweight unless the user
explicitly asked for a deep re-synthesis. The bullets already in the
page body are the canonical observation set; cross-page hits are
supplemental.

If the page body has no observations AND there's no FM record AND
backlinks/query return nothing: abort with "No FM record, no observations
in the page, no related context — nothing to synthesize. Append an
observation first, or link the FM record id."

### Step 4. (Reserved)

Numbering kept for skill-version diff continuity with v1.x. No action.

### Step 5. Synthesize

Compile the new page content using the inputs from steps 1–3. Apply
these three rules **in order**:

#### 5a. FM-as-truth (when FM data is present)

For owned fields, FM wins. Owned fields include:

- Full name, email, secondary emails
- Current employer, role/title
- Registrations (Dent conferences, hotel nights, past attendance)
- Tags
- Payments / purchases
- LinkedIn URL, location, communication preferences

If observation bullets in the page body contradict FM on an owned
field, **note the discrepancy inline** but render the FM value as the
truth. Example fragment:

```markdown
- **Role:** Founder, LeadingAgile [Source: FM People #12345]
- **Email:** mike@leadingagile.com [Source: FM People #12345]
- (Discrepancy: 2026-04-22 meeting notes mention Mike said he was
  "transitioning out" of LeadingAgile, but FM still lists him as Founder.
  Verify with Mike or update FM.)
```

For unstructured signal (observations, opinions, trajectory, posture),
FM has nothing to say — that material comes entirely from the page's
existing bullets and any cross-references surfaced in step 3.

#### 5b. Merge-on-rerun (when prior synthesis exists)

Pass the **entire body of the existing page** (everything after the
closing frontmatter fence) to the synthesis prompt as "prior synthesis."
Then instruct yourself, verbatim:

> The prior synthesis below may contain hand-edits the user wrote
> directly, observation bullets logged via /dent-append-evidence, and
> earlier /dent-enrich passes. Preserve any human-written content
> verbatim. Preserve every bullet under `## Timeline` verbatim
> (those are the immutable observation log). Only refine sections
> where the new FM record or new context adds material that the prior
> synthesis lacked. When in doubt, keep what's there.

Do not parse out individual sections and overwrite them. Trust the LLM
with the whole body. **Conform to the page's existing structure** —
whatever section headings the prior synthesis or hand-edit established
are authoritative. Do NOT impose a fixed template.

The only structural section name with special meaning is `## Timeline`
(gbrain-native — its bullets get auto-extracted into `timeline_entries`
on re-index). All other section names are page-author-chosen prose.

#### 5c. Citations

Every claim in the rendered page carries an inline `[Source: ...]`
citation:

- FM-derived claims: `[Source: FM People #12345]` or
  `[Source: FM Event Registration #6789]`
- Observation-derived claims: `[Source: meetings/2026-04-22]` or
  `[Source: <whatever the bullet's existing inline citation says>]`
- Cross-reference claims (from get_backlinks / query): cite the
  source page slug, e.g. `[Source: meetings/2026-05-01]`

Section headings can drop the citation if the entire section is from a
single source — say so once at the top of the section instead.

### Step 6. Write the page

Compute `expected_prior_hash = sha256(prior)` (where `prior` is the
full content captured in step 1). Then call:

```
markdown_replace_page({
  slug: <entity slug>,
  content: <full synthesized markdown — frontmatter + body>,
  expected_prior_hash: <hash>,
  commit_note: "/dent-enrich"
})
```

**Frontmatter must preserve:**
- `filemaker_record_id` (if step 2 found one — preserve verbatim)
- `type` (person | company | project | etc.)
- `title` (the human-readable name)
- `updated` (today's date, ISO-8601)

**Handle results:**
- `status: "ok"` — record `commit_sha` for the user-facing summary.
- `status: "page_changed"` — someone wrote between your read and
  write. The op returns `current_content` and `current_hash`. Re-run
  the synthesis with `current_content` as the new prior, then retry
  the write with the new hash. Cap at 2 retries; past that, surface
  to the user ("Page is contended — try again in a moment").
- `status: "busy"` — repo lock held by another writer. Retry once
  after a short delay.
- `error: "rate_limited"` — slow down. Surface to the user.

The page just written gets re-imported into Postgres as part of the
op (`performSync` runs internally), so `get_page` will return the new
content immediately. gbrain's post-hooks fire on the re-import, so
`## Timeline` bullets auto-populate `timeline_entries` and any
new entity refs in the body get extracted into the links graph.

### Step 7. Confirm with the user

Surface a one-paragraph diff to the user: which sections were updated,
which were preserved verbatim, whether any FM-evidence discrepancies
were flagged, and the resulting `commit_sha`.

If the synthesis hit any failures (FM unreachable, page contention),
name them explicitly. Do not silently degrade.

---

## Tier handling

`/dent-enrich` does NOT use the upstream `enrich` skill's tier system
(Tier 1 / 2 / 3). The Dent context is different: every entity in
`entities/people/` is in the brain because Steve or another teammate put
it there, which is itself a notability signal. There's no "skip
enrichment for low-value entities" check. If the user asked for
synthesis, run it.

External-data-source lookups (Crustdata, Proxycurl, web research) are
**out of scope** for this skill in MVP. The Dent brain is fed by
FileMaker (structured) + observation bullets logged via
`/dent-append-evidence` (unstructured). External enrichment APIs are
deferred to v1+ when the team has signal that they're worth the spend.

---

## Anti-patterns

- **Do not** overwrite user hand-edits with regenerated content. The
  merge-on-rerun rule (5b) is non-negotiable.
- **Do not** silently drop FM data when FM is unreachable. Note the
  failure in the synthesis.
- **Do not** parse the existing page into sections and replace
  section-by-section. Trust the LLM with the full body.
- **Do not impose mandated section headings.** No `## State`,
  `## Recent Observations`, `## What They Believe`, `## Trajectory`,
  `## Assessment`, or any fixed dent-specific scaffold. If the page
  already has those because a prior synthesis added them, keep them
  verbatim per 5b. If the page does not have them, do not invent
  them. `## Timeline` is the one structurally-meaningful exception
  (gbrain-native).
- **Do not** write the FM record itself into Dent Brain (no
  `markdown_replace_page` to a `filemaker/` namespace). FM is the
  canonical store; we only read from it.
- **Do not** create a page when both FM and observations are empty.
  Abort with a clear error message instead.
- **Do not** call `markdown_replace_page` without
  `expected_prior_hash` for an existing page. Optimistic concurrency
  is the whole point — without the hash, a teammate's hand-edit gets
  silently clobbered.
- **Do not** write to Postgres directly. No `put_page` calls.

---

## Tools used

- `get_page` — read existing page content (and compute its hash for
  optimistic-concurrency on the write)
- `markdown_replace_page` — write the synthesized page
- `search` / `query` — resolve a name to a slug, or fetch related context
- `get_backlinks` — find pages that reference this entity
- `get_timeline` — pull chronological bullets if the synthesis prompt
  needs them surfaced separately from the page body (rare; the body
  already contains them)
- `fm_get_record` — fetch the authoritative FM record (per-user FM auth)
- `fm_get_layout_fields` — discover field structure when the layout is
  unfamiliar
