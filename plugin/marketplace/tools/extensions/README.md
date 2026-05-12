# Dent Brain extensions manager

A teammate-local CLI for managing the per-laptop ingestors that push signal
into the shared brain. As of today: `granola-sync`. Future: `gmail-watch`,
`transcript-sync`, etc.

> **Privacy contract.** Each extension runs locally on your machine with your
> personal bearer token. Personal data (non-Dent meetings, personal emails)
> stays local — every extension has a filter that only ships Dent-related
> items to the shared brain. `dent-extensions uninstall <id>` stops any
> extension instantly.

## Quick start

```bash
# From a fresh clone of dent-brain:
cd ~/gh/dent-brain

# See what's available + what's installed locally
./tools/extensions/bin/dent-extensions list

# Install one
./tools/extensions/bin/dent-extensions install granola-sync

# Inspect after install
./tools/extensions/bin/dent-extensions status granola-sync

# Run a dry-run test (no writes)
./tools/extensions/bin/dent-extensions test granola-sync

# Edit your config (only needed if overriding defaults — most users skip this)
./tools/extensions/bin/dent-extensions configure granola-sync

# Stop + remove
./tools/extensions/bin/dent-extensions uninstall granola-sync
```

### Make `dent-extensions` global

Symlink the launcher into `/usr/local/bin` (or any dir in your `PATH`):

```bash
ln -s "$(pwd)/tools/extensions/bin/dent-extensions" /usr/local/bin/dent-extensions
dent-extensions list
```

## Status badges

| Badge | Meaning |
|---|---|
| `● active` | Installed, configured, and the scheduled agent is running. |
| `⚠ unconfigured` | Installed but `config.json` still has placeholder values. Run `configure <id>`. (Most extensions need no config — they auto-discover everything from your existing `~/.claude.json` and macOS conventions.) |
| `⚠ not-running` | Installed and configured, but the launchd agent isn't loaded. Re-run `install <id>` to reload it. |
| `○ not-installed` | Available in the registry but never installed on this machine. |

## Commands

```
dent-extensions list                          Show all extensions + status
dent-extensions status [<id>]                 Detailed status (all if no id)
dent-extensions install <id>                  Run the extension's installer
dent-extensions configure <id>                Open config in $EDITOR
dent-extensions test <id>                     Dry-run to verify wiring
dent-extensions uninstall <id> [--keep-config]
                                              Stop + remove the extension
dent-extensions help                          Show help

Global flags:
  --json    Machine-readable output for `list` and `status`.
```

## Architecture

The CLI is a small Bun script at `tools/extensions/cli.ts`. It reads a
registry of extensions from `tools/extensions/registry.ts` — adding a new
extension is one Bun-file edit (no rebuild, no redeploy).

Each extension is described by an `Extension` object in the registry:

```ts
{
  id: 'granola-sync',
  name: 'Granola → Dent Brain sync',
  description: '...',
  kind: 'launchd-daemon',
  sourceDir: 'tools/granola-sync',
  installScript: 'install.sh',
  installDir: '${HOME}/.dent-brain/granola-sync',
  configPath: '${HOME}/.dent-brain/granola-sync/config.json',
  launchdLabel: 'com.dent.granola-sync',
  launchdPlistPath: '${HOME}/Library/LaunchAgents/com.dent.granola-sync.plist',
  entryScript: '${HOME}/.dent-brain/granola-sync/sync.ts',
  testArgs: ['--dry-run', '--verbose'],
  // unconfiguredMarkers: optional. Only set if your extension's config.json
  // ships with placeholder strings the user must replace. The granola-sync
  // extension has no markers because it auto-discovers everything from
  // ~/.claude.json — as soon as it's installed it's also configured.
}
```

Status is computed at call time:
- **installed** = `installDir` exists
- **configured** = `configPath` exists AND no `unconfiguredMarkers` strings appear in it
- **running** = `launchctl print gui/<uid>/<launchdLabel>` exits 0
- **lastRunAt** = mtime of the extension's `sync.log`

## For agents (Cowork skill `/dent-extensions`)

The skill `skills/dent/extensions/SKILL.md` is the conversational front-door.
It uses `dent-extensions list --json` and `dent-extensions status <id> --json`
to inspect, then runs the user-facing actions (`install`, `configure`, etc.)
in their terminal. The skill is opinionated about not pasting bearer tokens
into chat — it routes that through the installer's interactive prompt.

## Adding a new extension

1. Build the extension under `tools/<extension-id>/` with an `install.sh` that
   sets up its config + launchd plist (or whatever scheduler it needs).
2. Add the entry to `tools/extensions/registry.ts`. Required fields: `id`,
   `name`, `description`, `kind`, `sourceDir`. Add `unconfiguredMarkers` if
   the config has placeholder values to detect.
3. Commit. Teammates `git pull` and run `dent-extensions list` — the new
   extension appears immediately.

That's it — no version bump, no redeploy.
