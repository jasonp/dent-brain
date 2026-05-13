# Dent The Future, Inc. Brain — Cowork plugin (v0.37.7)

Adds 10 slash commands:

- `/dent-setup`
- `/dent-append-evidence`
- `/dent-enrich`
- `/dent-resolve-entity`
- `/dent-onboard-teammate`
- `/dent-add-ingestor`
- `/dent-extensions`
- `/dent-tell-me-about`
- `/dent-update`
- `/dent-process-inbox`

These run on top of the `dent-brain` MCP server at `https://dent-brain.dentthefuture.com/mcp`.

## Prerequisites

The MCP connector must be registered in your Claude Desktop config first.
The admin runs `/dent-onboard-teammate` for you, which produces a
one-paste install command.

## Installing this plugin in Cowork

In a Cowork chat, ask: *"Add a custom marketplace from `github:jasonp/dent-brain` and install the dent-brain plugin."*

Cowork pulls the repo, registers it as a marketplace, and installs the
plugin into its own per-session cache. After Claude Desktop restart and
a fresh chat, the slash commands are available.

For full setup (admin: provision server, deploy keys, ingestors), see
`docs/dent-brain/SETUP.md` in the source repo.

## Installing this plugin in Code mode (terminal CLI)

```bash
bash plugin/marketplace/install-local.sh
```

This registers the local `plugin/marketplace` as a Claude Code marketplace
and installs the plugin via `claude plugin install`. Code mode reads from
`~/.claude/plugins/cache`, separate from Cowork's store.

## Source

Built from `https://github.com/jasonp/dent-brain` at v0.37.7.
Rebuild from source skill templates with `bun run build:plugin` from the
source repo root. Forks customize via `bun run setup`.
