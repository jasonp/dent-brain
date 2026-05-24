# RegFox ingestor (Phase 5.1)

Server-side polling ingestor that pulls new RegFox registrations every
5 minutes and lands them as bullets on entity pages in the brain.

## What it does

Every tick (default 300s) the ingestor:

1. Calls the Webconnex API v2 `/search/registrants` endpoint with
   `greaterThanId=<cursor>` to get only new-since-last-tick registrants.
2. For each registrant, decides where the bullet goes:
   - **Email match** (an existing brain page has `email: <orderEmail>`
     in frontmatter) → append a date-anchored bullet under that page's
     `## Timeline`.
   - **Name match without email match** (page exists at
     `entities/people/<kebab-name>` but no email match) → AMBIGUOUS.
     Could be the same person registering with a new email, or two
     different people with the same name. The ingestor refuses to
     guess; writes a checklist row to `_ingest/pending_regfox.md` in
     the data repo for human review.
   - **No match** → creates a new stub page with rich frontmatter
     (email, regfox_registrant_id, regfox_form_id, etc.) and the
     bullet as the first Timeline entry.
3. Persists the cursor (`last_seen_id`) per form in the
   `regfox_ingest_state` Postgres table so the next tick picks up
   where this one left off.

The bullet is a gbrain-canonical date-anchored line:

```
- **2026-04-22** | Registered for Acme Conf 2026 ($1495.00 USD with discount code EARLYBIRD). [Source: regfox/1440/12345]
```

The `- **YYYY-MM-DD** | …` shape is what gbrain's `parseTimelineEntries`
auto-extracts into `timeline_entries` on the next sync, so the
registration shows up in chronological queries for free.

## Required env vars

Set on Railway via `railway variables --set "KEY=value"`:

| Var | Required | Default | Purpose |
|---|---|---|---|
| `DENT_BRAIN_REGFOX_API_KEY` | yes | — | Webconnex API key. The ingestor refuses to start without it. |
| `DENT_BRAIN_DATA_DEPLOY_KEY` | yes (already set) | — | The ingestor writes through `markdown_append_to_page` / `markdown_replace_page`, both of which need the data-repo clone. |

## Optional env vars

| Var | Default | Purpose |
|---|---|---|
| `DENT_BRAIN_REGFOX_POLL_INTERVAL_SECONDS` | `300` | Tick interval. Set `0` to disable. |
| `DENT_BRAIN_REGFOX_FORM_IDS` | (poll all) | Comma-separated form IDs to scope polling. |
| `DENT_BRAIN_REGFOX_PRODUCT` | `regfox.com` | Webconnex product. Set to `ticketspice.com`, `givingfuel.com`, or `redpodium.com` to use the same code for those products. |
| `DENT_BRAIN_REGFOX_DISCOUNT_FIELD_PATH` | (best-effort) | Override path inside `fieldData` where the discount code lives. The ingestor tries `coupon_code`, `discount_code`, etc. by default; set this only after seeing the first real payload tells you the actual path. |

## Where to find your API key

RegFox dashboard → **Pages** → **Extras** tab → **Integrations** →
**API Keys** → **Add API Key**. Copy the key and set it on Railway:

```bash
railway variables --set "DENT_BRAIN_REGFOX_API_KEY=<paste here>"
```

API access is on RegFox Premium and Professional plans only.

## Verifying the ingestor works

After deploy, watch boot logs for:

```
[dent-brain] regfox-ingestor: every 300s, forms=all
```

After the first tick (5 min later), watch logs for:

```
[regfox-ingestor] tick ok: processed=N created=M appended=K pendingReview=J skipped=L
```

If `processed=0` after an interval, either there are genuinely no new
registrations OR the cursor is already past everything (first run starts
at `last_seen_id=0`, so it fetches the FULL backlog incrementally —
default page size is 100, max 250).

## What lands in git

For each new registration that creates an entity, you'll see a commit
authored by `dent-brain-server <noreply@example.com>` (or whatever
your `DENT_BRAIN_GIT_NAME` / `DENT_BRAIN_GIT_EMAIL` are set to) with
message `agent: replace entities/people/<kebab-name>`. Subsequent
registrations matched-by-email get `agent: append entities/people/<slug>`
commits.

## Pending review

`<data-repo>/_ingest/pending_regfox.md` accumulates rows for registrants
the ingestor couldn't auto-place. Sample row:

```
- [ ] regfox-id:12345 — Alice Example <alice@example.com> — slug entities/people/alice-example already exists with a different / no email — could be the same person registering with a new email, or two different people with the same name. Human review.
```

Review and resolve manually:
- Tick the box and edit the right entity page (or create a new one with
  a disambiguated slug like `alice-example-2`).
- Or delete the line if the registrant should be ignored.

The ingestor skips already-listed registrants on subsequent ticks
(idempotent on `regfox-id:<id>` substring match).

## Rate limits

Webconnex API limits are 10,000 requests / day and 900 requests / 15
minutes. The ingestor reads `X-Burst-Remaining` after every fetch and
halts the tick early if it drops below 10. At default settings (5-min
ticks, 100 records per page), normal volume burns ~12 requests / hour
or ~290 / day — well under the cap.

## Backfill

First run starts with `last_seen_id = 0` and fetches the entire history
of registrations from the API in `greaterThanId`-ordered pages. The
default `maxPerTick = 250` cap means the first few ticks process 250
registrants each, advancing the cursor. After the backlog is consumed,
ticks settle into "process whatever arrived in the last 5 minutes."

## Troubleshooting

- **`tick error: Webconnex API 401`**: API key invalid or revoked.
  Re-issue from the RegFox dashboard, update the Railway env var.
- **`tick error: Webconnex API 429`**: rate-limited. The burst floor
  should prevent this — if it happens, lower `pageLimit` or raise
  `pollIntervalSeconds`.
- **`tick ok: processed=0` for hours despite new registrations**: cursor
  may be ahead of new registrations because the API returned them in
  some prior tick. Check the `regfox_ingest_state` table:
  ```sql
  SELECT * FROM regfox_ingest_state ORDER BY last_polled_at DESC;
  ```
- **Pending review file growing without resolution**: the human-side
  workflow is the choke point. Review it weekly; tick boxes or delete
  lines to keep it tractable.
