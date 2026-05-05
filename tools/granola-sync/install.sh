#!/usr/bin/env bash
# Granola → Dent Brain sync installer.
#
# What it does:
#   1. Verifies bun is installed; bails with a hint if not.
#   2. Verifies the dent-brain MCP server is registered in ~/.claude.json
#      (token + URL are auto-discovered at runtime — no second copy needed).
#   3. Verifies Granola itself is installed and has been opened at least once.
#   4. Copies sync.ts + types.ts + filter.ts + translator.ts + mcp-client.ts
#      to ~/.dent-brain/granola-sync/.
#   5. Renders the launchd plist template with absolute paths and copies it
#      to ~/Library/LaunchAgents/com.dent.granola-sync.plist.
#   6. Loads the agent. Runs once immediately (RunAtLoad=true).
#   7. Prints a heads-up about the macOS Background Items notification.
#
# No config.json is needed for the default setup — `dentDomains` defaults
# to ['dentthefuture.com'], paths default to standard macOS locations, and
# the bearer token + server URL are read from ~/.claude.json. To override,
# write a config.json after install.
#
# Idempotent — safe to re-run after pulling repo updates to refresh the script.
#
# Usage:
#   bash tools/granola-sync/install.sh
#
# Uninstall:
#   tools/extensions/bin/dent-extensions uninstall granola-sync
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.dent-brain/granola-sync"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.dent.granola-sync.plist"
LABEL="com.dent.granola-sync"

echo "==> Granola sync installer"
echo "    source: $SCRIPT_DIR"
echo "    target: $INSTALL_DIR"

# 1. Verify bun
if ! command -v bun >/dev/null 2>&1; then
  echo
  echo "ERROR: bun is not installed."
  echo "Install bun first:  curl -fsSL https://bun.sh/install | bash"
  echo "Then re-run this installer."
  exit 1
fi
BUN_PATH="$(command -v bun)"
echo "    bun: $BUN_PATH"

# 2. Verify the dent-brain MCP server is registered in claude.json. We don't
#    copy the token — the daemon reads it fresh from claude.json at every run.
CLAUDE_JSON="${HOME}/.claude.json"
if [ ! -f "$CLAUDE_JSON" ]; then
  echo
  echo "ERROR: ~/.claude.json not found."
  echo "Run /dent-onboard-teammate first to register the MCP server."
  exit 1
fi
if ! bun -e 'import { readFileSync } from "fs";
const c = JSON.parse(readFileSync(process.argv[1], "utf-8"));
const e = c?.mcpServers?.["dent-brain"];
if (!e?.url || !e?.headers?.Authorization?.startsWith?.("Bearer ")) { process.exit(1); }
console.log("ok"); console.log(e.url);' "$CLAUDE_JSON" > /tmp/granola-claude-discover.$$ 2>/dev/null; then
  echo
  echo "ERROR: ~/.claude.json has no dent-brain MCP entry with a Bearer token."
  echo "Run /dent-onboard-teammate first, then re-run this installer."
  rm -f /tmp/granola-claude-discover.$$
  exit 1
fi
DISCOVERED_URL="$(sed -n '2p' /tmp/granola-claude-discover.$$)"
rm -f /tmp/granola-claude-discover.$$
echo "    dent-brain MCP discovered: $DISCOVERED_URL"

# 3. Verify Granola itself is installed and has been opened. Without these,
#    the daemon will succeed at install time but fail on first run with
#    "Granola cache not found" — better to surface the gap up front.
GRANOLA_APP="/Applications/Granola.app"
GRANOLA_CACHE="${HOME}/Library/Application Support/Granola/cache-v6.json"

if [ ! -d "$GRANOLA_APP" ]; then
  echo
  echo "ERROR: Granola is not installed."
  echo
  echo "Granola is the meeting note-taker this daemon syncs from. To set it up:"
  echo "  1. Download Granola from https://granola.ai/download"
  echo "  2. Install + open it; sign in with your @dentthefuture.com Google account"
  echo "     (the same one your Dent calendar invites go to)"
  echo "  3. In Granola Settings → Permissions, grant:"
  echo "       - Microphone access (so it captures your voice)"
  echo "       - Screen Recording access (so it captures the other side of the call)"
  echo "  4. Sit through one meeting with Granola open so it learns + creates its cache"
  echo "  5. Re-run this installer."
  exit 1
fi
echo "    Granola.app: installed at $GRANOLA_APP"

if [ ! -f "$GRANOLA_CACHE" ]; then
  echo
  echo "ERROR: Granola cache not found at $GRANOLA_CACHE."
  echo
  echo "Granola is installed but you haven't opened it (or signed in) yet. The"
  echo "daemon needs Granola's local cache to read meeting notes from."
  echo "  1. Open Granola.app, sign in with your @dentthefuture.com Google account"
  echo "  2. In Granola Settings → Permissions, grant Mic + Screen Recording access"
  echo "  3. Re-run this installer."
  exit 1
fi
echo "    Granola cache: present"

# 4. Copy runtime files
mkdir -p "$INSTALL_DIR"
for f in sync.ts types.ts filter.ts translator.ts mcp-client.ts; do
  cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
done
echo "    copied 5 runtime files."

# 5. Render and install plist
PLIST_RENDERED="$(mktemp)"
sed \
  -e "s|__BUN_PATH__|$BUN_PATH|g" \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$SCRIPT_DIR/com.dent.granola-sync.plist.template" > "$PLIST_RENDERED"

mkdir -p "$(dirname "$PLIST_PATH")"

# Unload any existing version before replacing — launchctl is finicky.
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "    unloading existing launch agent…"
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
fi

cp "$PLIST_RENDERED" "$PLIST_PATH"
rm "$PLIST_RENDERED"
echo "    installed plist: $PLIST_PATH"

# 6. Load + start
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "    loaded launch agent ($LABEL)."

# 7. macOS Background Items heads-up — the user will see a system notification
#    naming "Jarred Sumner" (the developer ID of Bun, the runtime our script uses).
#    Without this context it looks alarming. With this context it's mundane.
echo
echo "==> macOS may show a notification:"
echo "    'Jarred Sumner may now run software in the background'"
echo "    or similar. That's the developer ID of Bun (https://bun.sh), the"
echo "    runtime our sync script uses. It's expected and safe — Bun is signed"
echo "    by its creator the same way Docker is signed by Docker Inc, etc."
echo
echo "    To verify or pause/resume the daemon later:"
echo "      System Settings → General → Login Items & Extensions → Allow in Background"
echo "    Look for 'com.dent.granola-sync'."

echo
echo "==> Installed. The agent will run hourly (StartInterval=3600)."
echo "    Logs:        $INSTALL_DIR/sync.log"
echo "    Manual run:  bun $INSTALL_DIR/sync.ts"
echo "    Dry run:     bun $INSTALL_DIR/sync.ts --dry-run"
echo "    Status:      dent-extensions status granola-sync"
echo "    Stop:        dent-extensions uninstall granola-sync"
echo
echo "==> First run firing now (RunAtLoad=true). Tail logs:"
echo "    tail -f $INSTALL_DIR/sync.log"
