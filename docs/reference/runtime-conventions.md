# Runtime conventions — which Claude surface for which work

Distributed Brain skills run in two Claude surfaces. The convention below tells the agent (and future contributors) which surface a given skill is designed for, so a teammate doesn't try to install a launchd daemon from a sandboxed Cowork session and hit confusing failures.

## The two surfaces

| Surface | What it is | Sandbox? | Filesystem? | Schedules? |
|---|---|---|---|---|
| **Claude Code Desktop** | The Code tab in the Claude Desktop app, plus the standalone CLI. Same MCP config (`~/.claude.json`). | No — full local filesystem, shell, keychain, launchd. | Yes (read + write). | Local-only; requires the app open at fire time. |
| **Cowork** | The Cowork tab in the Claude Desktop app. Reads `~/Library/Application Support/Claude/claude_desktop_config.json` via stdio MCP bridges. | Sandboxed — no shell, no arbitrary filesystem, no keychain, no launchd. | Mounted folders only, read-mostly. | Pre-authorized scheduled routines that run unattended on Anthropic's infrastructure. |

## The convention

**Claude Code Desktop:** installation, setup, and admin work. Anything that touches:
- The macOS keychain (`security ...`)
- `launchd` (`~/Library/LaunchAgents/`, `launchctl`)
- Shell installers (`bash install.sh`)
- Interactive TTY prompts (API key paste, OAuth callbacks)
- Filesystem outside of mounted skill folders
- Git operations against the code repo
- Cloud infrastructure provisioning (Supabase, Railway, OAuth apps, deploy keys)

**Cowork:** day-to-day brain work and enrichment routines. Anything that's:
- Pure MCP calls against the brain (query, get_page, markdown_append, etc.)
- Pure MCP calls against fm-mcp (entity resolution against FileMaker)
- Scheduled enrichment that must run unattended whether or not the user's laptop is awake
- Conversational use of the brain (`/dent-tell-me-about`, `/dent-append-evidence`)

The dividing line: **if the skill needs to execute a process on the user's machine, it belongs in Code Desktop. If it only needs to call MCP tools, prefer Cowork.**

## Skill-by-skill assignment

| Skill | Surface | Why |
|---|---|---|
| `/dent-onboard-teammate` | Code Desktop | Writes both `~/.claude.json` and `claude_desktop_config.json`; needs filesystem. |
| `/dent-setup` | Code Desktop | Provisions Supabase + Railway + GitHub deploy keys. Heavy infrastructure work. |
| `/dent-extensions install <id>` | Code Desktop | Runs `bash install.sh`, touches keychain + launchd. Cowork can't shell out. |
| `/dent-add-ingestor` | Code Desktop | Writes server-side TypeScript and deploys via `git push`. Pure filesystem + git work. |
| `/dent-append-evidence` | Either (default Cowork) | Pure MCP page edits. Conversational; runs wherever the user is talking. |
| `/dent-tell-me-about` | Either (default Cowork) | Pure MCP queries. |
| `/dent-enrich` | Either (default Cowork) | Pure MCP page synthesis. |
| `/dent-resolve-entity` | Either (default Cowork) | Pure MCP entity disambiguation. |
| `/dent-process-inbox` | **Cowork (scheduled routine)** | Layer 2 of email pipeline. Runs unattended via Cowork's scheduled-routine cron. Calls brain + fm-mcp via MCP. |

## Layer 1 vs Layer 2 (the ingestor split)

Ingestors are a two-layer pipeline that crosses both surfaces:

- **Layer 1 — collectors (launchd daemons):** `granola-sync`, `email-sync`. Installed by Code Desktop, run from `launchd` on the teammate's laptop, write digest pages to the brain via the production MCP server. No Claude runtime in the loop after install.
- **Layer 2 — enrichment (Cowork scheduled routines):** `/dent-process-inbox`. Reads unprocessed digests from the brain, resolves entities, files timeline bullets, stamps `processed: true`. Runs server-side via Cowork's scheduled-routine system so it fires daily regardless of laptop state.

The brain is the queue between the layers. Layer 1 deposits, Layer 2 picks up. Either layer can be down for days without losing data.

## Why this matters

A teammate who tries `/dent-extensions install granola-sync` from a Cowork session will fail in confusing ways — the bash installer can't write to the keychain, can't touch `~/Library/LaunchAgents/`, can't render an interactive prompt for the Granola API key. Marking install-side skills as "Code Desktop only" up front prevents the bad UX.

Conversely, parking `/dent-process-inbox` as a Code Desktop scheduled task means it only fires when the laptop is awake and the app is open. Moving it to Cowork's scheduled-routine system makes it actually reliable.

## When to override the convention

Either-surface skills (the four conversational ones) can run wherever the user is — don't force them into Cowork if the user is asking from a Code Desktop session. The convention is about defaults and gates, not about restricting day-to-day flexibility.
