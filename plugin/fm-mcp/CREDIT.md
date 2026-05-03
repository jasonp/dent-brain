# Credit

This FileMaker MCP server is the work of **Steve Broback** — a Node.js
stdio MCP server (~395 lines) that connects Claude Desktop to a FileMaker
database via the FileMaker Data API. It's vendored into the dbrain
plugin bundle with no modifications in the initial commit; the original
files (with the author's `README.md`) live alongside this `CREDIT.md`
in `plugin/fm-mcp/`.

## What it is

Seven tools (`fm_ping`, `fm_list_layouts`, `fm_get_layout_fields`,
`fm_list_scripts`, `fm_find_records`, `fm_get_record`, `fm_create_record`).
Session token management with auto-refresh on 401. Per-user FileMaker
accounts (each user runs as `mcp_<username>` with a privilege set the
DBA configures, so every FM query and write is audited under that user).

## Why it lives here (not as an external dependency)

dbrain's `/<prefix>-setup-filemaker-mcp` skill (when shipped) copies this
directory to each team member's `~/FileMaker MCP/` during install.
Vendoring keeps installs offline (no extra npm registry or GitHub
download), pins the version per dbrain plugin release, and gives forks
a clean place to add their own org-specific FM extensions alongside
the original code.

## Upstream changes

If the author publishes updated versions (e.g. `fm_update_record`,
`fm_delete_record`, `fm_run_script`), pull them into this directory,
bump the plugin bundle version, and team members get the update on
their next plugin upgrade.

## Credit preservation

When this directory is copied to a team member's machine, the author's
original `README.md` and this `CREDIT.md` are both included. Attribution
stays on the work.
