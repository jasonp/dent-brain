#!/usr/bin/env bash
# Granola → Dent Brain sync installer.
#
# What it does:
#   1. Verifies bun is installed; bails with a hint if not.
#   2. Verifies the dent-brain MCP server is registered in ~/.claude.json
#      (token + URL are auto-discovered at runtime).
#   3. Verifies Granola itself is installed (the user mints the API key there).
#   4. Verifies the Granola API key in the macOS keychain. If missing or
#      invalid, prompts the user to paste a key and stores it via `security`.
#   5. Copies sync.ts + types.ts + filter.ts + translator.ts + mcp-client.ts
#      + granola-api.ts to ~/.dent-brain/granola-sync/.
#   6. Renders the launchd plist template and loads it.
#   7. Prints a heads-up about the macOS Background Items notification.
#
# Idempotent — safe to re-run after pulling repo updates. If a working API key
# is already in the keychain, you won't be re-prompted.
#
# Usage:
#   bash tools/granola-sync/install.sh
#
# Uninstall:
#   tools/extensions/bin/dent-extensions uninstall granola-sync

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.dent-brain/granola-sync"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.dent.granola-sync.plist"
LABEL="com.dent.granola-sync"
KEYCHAIN_SERVICE="dent-brain.granola-sync"
KEYCHAIN_ACCOUNT="${USER:-default}"

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

# 2. Verify the dent-brain MCP server is registered in claude.json.
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

# 3. Verify Granola itself is installed (the user needs it to mint the key).
GRANOLA_APP="/Applications/Granola.app"
if [ ! -d "$GRANOLA_APP" ]; then
  echo
  echo "ERROR: Granola is not installed."
  echo
  echo "Granola is the meeting note-taker this daemon syncs from. To set it up:"
  echo "  1. Download Granola from https://granola.ai/download"
  echo "  2. Install + open it; sign in with your @dentthefuture.com Google account"
  echo "  3. In Granola Settings → Permissions, grant Mic + Screen Recording access"
  echo "  4. Re-run this installer."
  exit 1
fi
echo "    Granola.app: installed"

# 4. Verify the Granola API key in the keychain. If missing or invalid, prompt.
validate_key() {
  # Returns 0 if the key authenticates against /v1/notes, non-zero otherwise.
  local key="$1"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $key" \
    "https://public-api.granola.ai/v1/notes?page_size=1" || echo 000)
  [ "$code" = "200" ]
}

EXISTING_KEY="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null || true)"
if [ -n "$EXISTING_KEY" ] && validate_key "$EXISTING_KEY"; then
  echo "    Granola API key: present in keychain, validated ✓"
else
  if [ -n "$EXISTING_KEY" ]; then
    echo "    Granola API key: present in keychain but REJECTED by the API — re-prompting."
  else
    echo "    Granola API key: not in keychain — prompting."
  fi
  echo
  echo "    Mint a key in the Granola desktop app:"
  echo "      Granola → Settings → Connectors → API keys → Create new key"
  echo "    Paste it below (input is hidden). It will be stored in your macOS keychain"
  echo "    under service '$KEYCHAIN_SERVICE' / account '$KEYCHAIN_ACCOUNT'."
  echo
  if [ ! -t 0 ]; then
    echo "ERROR: stdin is not a TTY — cannot prompt for the API key."
    echo "Store it manually, then re-run the installer:"
    echo "  security add-generic-password -U -s '$KEYCHAIN_SERVICE' -a '$KEYCHAIN_ACCOUNT' -w 'grn_...'"
    exit 1
  fi
  while :; do
    printf "    Granola API key: "
    IFS= read -rs NEW_KEY
    echo
    NEW_KEY="${NEW_KEY#"${NEW_KEY%%[![:space:]]*}"}"  # ltrim
    NEW_KEY="${NEW_KEY%"${NEW_KEY##*[![:space:]]}"}"  # rtrim
    if [ -z "$NEW_KEY" ]; then
      echo "    (empty — try again, or Ctrl-C to abort)"
      continue
    fi
    if validate_key "$NEW_KEY"; then
      security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$NEW_KEY"
      echo "    stored in keychain ✓"
      break
    else
      echo "    key was rejected by https://public-api.granola.ai/v1/notes — try again, or Ctrl-C to abort"
    fi
  done
fi

# 5. Copy runtime files + stamp installed version (used by /dent-update for drift detection).
mkdir -p "$INSTALL_DIR"
for f in sync.ts types.ts filter.ts translator.ts mcp-client.ts granola-api.ts; do
  cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
done
# Resolve the bundle version. If SCRIPT_DIR is inside a plugin cache,
# `<cache>/VERSION` will be present. If running from a git clone, fall
# back to the repo's VERSION. Used by /dent-update to detect daemon drift.
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ -f "$BUNDLE_ROOT/VERSION" ]; then
  cp "$BUNDLE_ROOT/VERSION" "$INSTALL_DIR/.installed-version"
else
  echo "unknown" > "$INSTALL_DIR/.installed-version"
fi
echo "    copied 6 runtime files (installed-version: $(cat "$INSTALL_DIR/.installed-version"))."

# 6. Render and install plist
PLIST_RENDERED="$(mktemp)"
sed \
  -e "s|__BUN_PATH__|$BUN_PATH|g" \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$SCRIPT_DIR/com.dent.granola-sync.plist.template" > "$PLIST_RENDERED"

mkdir -p "$(dirname "$PLIST_PATH")"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "    unloading existing launch agent…"
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
fi

cp "$PLIST_RENDERED" "$PLIST_PATH"
rm "$PLIST_RENDERED"
echo "    installed plist: $PLIST_PATH"

# 7. Load + start
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "    loaded launch agent ($LABEL)."

echo
echo "==> macOS may show a notification:"
echo "    'Jarred Sumner may now run software in the background'"
echo "    or similar. That's the developer ID of Bun (https://bun.sh), the"
echo "    runtime our sync script uses. Expected and safe."
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
