---
name: {{prefix}}-tell-me-about
description: Token-efficient summary of any Dent Brain entity — people, companies, projects, events, audience contacts. Routes the question through hybrid search + chunked retrieval + timeline rather than dumping the full page. Use this whenever the user asks "what do we know about X", "who is X", "tell me about Y", "summarize Z", or any open-ended question about a named entity.
triggers:
  - "tell me about"
  - "what do we know about"
  - "who is"
  - "summarize what we know"
  - "give me a summary of"
  - "what's the deal with"
  - "show me everything on"
  - "fill me in on"
  - "background on"
  - "remind me about"
tools: []
mutating: false
---

# {{prefix}}-tell-me-about

> **Token-efficient entity lookup.** Bypasses the default "search → get_page → dump 80K of bullets" trap. Uses hybrid search + chunks + timeline to answer the user's actual question.

## CRITICAL: do NOT use `get_page` for this skill

Entity pages in Dent Brain can be huge — `entities/people/sumanth-channabasappa.md` is 80KB+, attendees with multi-year history easily exceed 100KB. Calling `get_page` on these dumps the entire compiled body into the context window. That's wasteful and tells the user nothing the brain hasn't already indexed.

Use these ops instead:
- **`query`** — hybrid search, returns ranked passages (~1–3K tokens) with `[Source: ...]` citations. THIS is your primary tool.
- **`resolve_slugs`** — turn a name into a slug (or list of candidate slugs) without fetching content.
- **`get_timeline`** — returns just the time-ordered bullets for a slug, optionally limited. Cheap.
- **`get_backlinks`** — pages that reference this entity. Cheap.
- **`get_links`** — outbound relationships from this entity.
- **`get_chunks`** — slug + chunk index → fetches a specific chunk only.

Use `get_page` ONLY when:
- The user explicitly asks for the FULL page contents ("show me the raw markdown"), OR
- A previous `query` returned a hit on a small page (< 5K bytes) and reading the whole thing is genuinely cheaper than a second query

If you find yourself reaching for `get_page`, stop and re-read this section. The right answer is almost always `query` with a more specific question.

## Step 1. Resolve the entity name to a slug

The user typed something like "Steve Broback" or "Dent 2026" or "Granola". Resolve it:

```
resolve_slugs <name>
```

This returns one or more candidate slugs across all entity directories:
- `entities/people/<slug>` — actual humans (event attendees, speakers, sponsors)
- `entities/audience/<slug>` — email-list-only contacts (Mailchimp imports)
- `entities/companies/<slug>` — orgs
- `entities/projects/<slug>` — initiatives + specific events (Dent 2026, Ketchum Library Talk, etc.)
- `meetings/<date>-<slug>` — meeting pages

Decide based on the directory and the user's phrasing:
- **Multiple `entities/people/` matches** (e.g. two `Glenn`s) — list them with their emails as disambiguators, ask the user which.
- **Single match** — proceed.
- **No match** — try `query <name>` directly; if still nothing, tell the user the brain has no entry for that name.
- **Match in `entities/audience/` only** — note this in the response: "I have an email-list contact for X but no Dent-event history yet."
- **Mix of people + audience matching** — prefer people; mention audience separately if relevant.

## Step 2. Pick the right query strategy based on the user's question shape

Most "tell me about" questions decompose into one of these shapes. Match the shape, run the matching recipe.

### Shape A: open-ended summary ("tell me about Steve", "who is Sarah?")

```
query "<name> background organization role"  --slug-prefix <slug>
get_timeline <slug>  --limit 8
```

Take the top 5 ranked snippets from query + 8 most-recent timeline events. Compose a 4–6 sentence summary covering role/company, recent activity, notable connections. Include at least one `[Source: ...]` citation per claim.

### Shape B: specific factual question ("what's Steve's role?", "where does Sarah work?")

```
query "<the user's exact question>"  --slug-prefix <slug>
```

Pull only the top 1–3 hits. Answer in one sentence with a citation.

### Shape C: relationship question ("who has Steve met with?", "who works at Acme?")

```
get_backlinks <slug>           # pages that mention this entity
get_links <slug>               # pages this entity links out to
```

Don't query yet. Walk the graph. If after backlinks you still need detail, query specific named entities.

### Shape D: timeline / history question ("when did Steve register for Dent 2024?", "how many events has X attended?")

```
get_timeline <slug>  --limit 50
```

Group + summarize. Don't fetch query results — the timeline is the source of truth for events.

### Shape E: full-content request ("show me the raw page", "what does the markdown actually say?")

This is the one case `get_page` is appropriate. Ask the user to confirm: "That'll be a large fetch — N KB. Sure?" Only proceed on confirmation.

### Shape F: ambiguous / multi-part question

Decompose into sub-questions, run shape B once per sub-question. Don't try to answer with a single query.

## Step 3. Handle entity-type variations

The recipe stays the same, but emphasize different fields by entity type:

| Type | Emphasize in summary | Especially useful op |
|---|---|---|
| `entities/people/<x>` | Role, organization, recent meetings, registration history | `get_timeline` |
| `entities/audience/<x>` | Mailchimp source, last engagement, tags | `get_timeline` (status events) |
| `entities/companies/<x>` | Industry, employees of theirs in the brain, deals | `get_links` |
| `entities/projects/<x>` (events) | Date, location, attendee count (in frontmatter), notable speakers | `get_backlinks` (attendees) |
| `meetings/<date>-<x>` | Attendees, summary, action items | `get_chunks` for sections |

For events, the page itself is usually small (the event page just lists attendees + facts). `get_page` is OK here — the dump is small.

## Step 4. Synthesize the answer

Compose a response sized to the user's question:

- One-liner question → one-sentence answer + 1 citation
- "Tell me about" → 4–6 sentence summary with 3–5 citations
- "Show me everything" → bullet list grouped by category (facts / recent activity / relationships / open questions), still bounded to ~500 words

End with one of:
- "Want me to dig deeper into any of these?" (encourages drill-down via shape B)
- "I noticed [interesting thing] — want context?" (proactive surfacing of edge cases)
- Nothing extra (if the answer is complete)

DO NOT end with "I've also saved a copy of the file" or "let me read the file" — never reach for the on-disk file. The brain's MCP ops are the only correct path.

## Anti-patterns

- **Don't call `get_page` first.** That's the inefficient default this skill exists to avoid. If you find yourself there, re-read the CRITICAL section.
- **Don't read files from disk.** `bash` access to a local clone of `dent-brain-data` is a fallback for editing, not for querying. Always go through the MCP ops.
- **Don't summarize without citations.** Every fact you state should carry a `[Source: ...]` reference from the snippets `query` returned.
- **Don't dump the whole timeline if the user asked a specific question.** A "what's Steve's email" question doesn't need 30 registration bullets — it needs the frontmatter + maybe one bullet.
- **Don't hallucinate from the entity name.** If `query` returns no results, say so. Don't fill in plausible-sounding biography.
- **Don't disambiguate silently.** Two `Glenn`s in `entities/audience/` are likely different people. List them and ask.

## Output format

For a typical "tell me about <person>" call, aim for:

```
**<Full Name>** — <role at company>

<2-3 sentence summary of who they are + recent activity>. [Source: ...]

Recent activity:
- <date>: <event> [Source: ...]
- <date>: <event> [Source: ...]
- <date>: <event> [Source: ...]

Notable connections: <names of 2-4 entities they're linked to>.

Want me to pull more on any of those?
```

For a one-shot factual question:

```
<one-sentence answer>. [Source: ...]
```

Keep it scannable. The user is probably asking before a meeting and wants the answer in 5 seconds.

## Tools used

- `resolve_slugs` (Step 1)
- `query` (Steps 2A, 2B; primary tool)
- `get_timeline` (Steps 2A, 2D)
- `get_backlinks` (Step 2C)
- `get_links` (Step 2C)
- `get_chunks` (rarely; targeted retrieval from a known page)
- `get_page` (only for Shape E full-content requests, with user confirmation)
