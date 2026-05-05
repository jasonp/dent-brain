#!/usr/bin/env bash
# Granola → Dent Brain sync installer.
#
# What it does:
#   1. Verifies bun is installed; bails with a hint if not.
#   2. Verifies the dent-brain MCP server is registered in ~/.claude.json
#      (token + URL are auto-discovered at runtime — no second copy needed).
#   3. Copies sync.ts + types.ts + filter.ts + translator.ts + mcp-client.ts
#      to ~/.dent-brain/granola-sync/.
#   4. Creates config.json with teammateEmail prefilled from `git config user.email`
#      (so the teammate just confirms — no copy-paste of secrets).
#   5. Renders the launchd plist template with absolute paths and copies it
#      to ~/Library/LaunchAgents/com.dent.granola-sync.plist.
#   6. Loads the agent. Runs once immediately (RunAtLoad=true).
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

# 3. Copy runtime files
mkdir -p "$INSTALL_DIR"
for f in sync.ts types.ts filter.ts translator.ts mcp-client.ts; do
  cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
done
echo "    copied 5 runtime files."

# 4. Config seeding (no token — auto-discovered at runtime)
CONFIG_PATH="$INSTALL_DIR/config.json"
if [ ! -f "$CONFIG_PATH" ]; then
  # Prefill teammateEmail from git config if it ends in a Dent domain.
  GIT_EMAIL="$(git config --global user.email 2>/dev/null || true)"
  if [[ "$GIT_EMAIL" == *@dentthefuture.com ]]; then
    DEFAULT_EMAIL="$GIT_EMAIL"
  else
    DEFAULT_EMAIL=""
  fi

  echo
  if [ -n "$DEFAULT_EMAIL" ]; then
    echo "    Found Dent email in git config: $DEFAULT_EMAIL"
    read -rp "    Use this as your teammateEmail? [Y/n] " yn
    if [[ "$yn" =~ ^[Nn]$ ]]; then
      read -rp "    Enter your @dentthefuture.com email: " DEFAULT_EMAIL
    fi
  else
    read -rp "    Enter your @dentthefuture.com email: " DEFAULT_EMAIL
  fi

  cat > "$CONFIG_PATH" <<EOF
{
  "_comment": "serverUrl + bearerToken are auto-discovered from ~/.claude.json. To override, add them here.",
  "teammateEmail": "$DEFAULT_EMAIL",
  "granolaCachePath": "\${HOME}/Library/Application Support/Granola/cache-v6.json",
  "cursorPath": "\${HOME}/.dent-brain/granola-sync/cursor.json",
  "dentDomains": ["dentthefuture.com"]
}
EOF
  chmod 600 "$CONFIG_PATH"
  echo "    wrote $CONFIG_PATH"
else
  echo "    config exists at $CONFIG_PATH (not overwritten)."
fi

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
