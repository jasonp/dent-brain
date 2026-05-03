# Credit

This FileMaker MCP server was written by **Steve Broback** for the Dent team's internal use, connecting Claude Desktop to the Dent CRM (`DentCRM2025` on `sea-17.fmsdb.com`) via the FileMaker Data API.

It's adopted wholesale into Dent Brain's plugin bundle with no modifications in this initial commit. The original files live at `_reference/FMP Connector/FileMaker MCP/` in the project working folder. Install guide for team members is at `docs/dent-brain/reference/FileMaker-MCP-Setup-for-Jason.md`.

## What it is

A 395-line Node.js stdio MCP server. Seven tools (`fm_ping`, `fm_list_layouts`, `fm_get_layout_fields`, `fm_list_scripts`, `fm_find_records`, `fm_get_record`, `fm_create_record`). Session token management with auto-refresh on 401. Per-user FileMaker accounts (each team member uses `mcp_<username>` with the `MCP Read And Edit Records` privilege set, so every FM query and write is audited under that user).

## Why it lives here (not as an external dependency)

Dent Brain's `/setup-filemaker-mcp` skill copies this directory to each team member's `~/FileMaker MCP/` during install. Shipping the server source in the plugin bundle means:

1. Install stays offline (no extra npm registry or GitHub download during `/setup-filemaker-mcp`).
2. Version is pinned per Dent Brain plugin release — upgrading the plugin upgrades the FM MCP in lockstep.
3. Any Dent-specific extensions (e.g., the future `DB_Observations` write-layout scoping from the plan's v1 write patterns) live here alongside Steve's original code.

## Upstream changes

Steve's `README.md` says future write-tool additions follow the same pattern in `server.js`. If Steve publishes updated versions (e.g., `fm_update_record`, `fm_delete_record`, `fm_run_script`), we pull them into this directory, bump the plugin bundle version, and team members get the update on their next `/update-dent-brain`.

## Credit preservation

When this directory is copied to a team member's machine by `/setup-filemaker-mcp`, Steve's original `README.md` (now at `plugin/fm-mcp/README.md`) and this `CREDIT.md` are both included. His name stays on it.
