#!/usr/bin/env bash
# Granola → Dent Brain sync installer.
#
# What it does:
#   1. Verifies bun is installed; bails with a hint if not.
#   2. Copies sync.ts + types.ts + filter.ts + translator.ts + mcp-client.ts
#      to ~/.dent-brain/granola-sync/.
#   3. If config.json doesn't exist there, copies config.example.json into
#      place and opens it for the teammate to fill in their bearer token.
#   4. Renders the launchd plist template with absolute paths and copies it
#      to ~/Library/LaunchAgents/com.dent.granola-sync.plist.
#   5. Loads the agent. Runs once immediately (RunAtLoad=true).
#
# Idempotent — safe to re-run after pulling repo updates to refresh the script.
#
# Usage:
#   bash tools/granola-sync/install.sh
#
# Uninstall:
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.dent.granola-sync.plist
#   rm ~/Library/LaunchAgents/com.dent.granola-sync.plist
#   rm -rf ~/.dent-brain/granola-sync   # WARNING: also wipes cursor + token

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

# 2. Copy runtime files
mkdir -p "$INSTALL_DIR"
for f in sync.ts types.ts filter.ts translator.ts mcp-client.ts; do
  cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
done
echo "    copied 5 runtime files."

# 3. Config seeding
CONFIG_PATH="$INSTALL_DIR/config.json"
if [ ! -f "$CONFIG_PATH" ]; then
  cp "$SCRIPT_DIR/config.example.json" "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
  echo
  echo "==> Created $CONFIG_PATH from template."
  echo "    EDIT IT NOW: replace REPLACE_WITH_YOUR_PERSONAL_DENT_BRAIN_TOKEN"
  echo "    and set teammateEmail to your @dentthefuture.com address."
  echo
  read -rp "Press Enter to open it in your default editor (or Ctrl-C to do it later)..."
  ${EDITOR:-open} "$CONFIG_PATH"
  echo
  read -rp "Press Enter when you've saved your token to continue..."
else
  echo "    config exists at $CONFIG_PATH (not overwritten)."
fi

# 4. Render and install plist
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

# 5. Load + start
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "    loaded launch agent ($LABEL)."

echo
echo "==> Installed. The agent will run hourly (StartInterval=3600)."
echo "    Logs: $INSTALL_DIR/sync.log"
echo "    Manual run:  bun $INSTALL_DIR/sync.ts"
echo "    Dry run:     bun $INSTALL_DIR/sync.ts --dry-run"
echo "    Status:      launchctl print gui/\$(id -u)/$LABEL"
echo "    Stop:        launchctl bootout gui/\$(id -u) $PLIST_PATH"
echo
echo "==> First run firing now (RunAtLoad=true). Tail logs:"
echo "    tail -f $INSTALL_DIR/sync.log"
