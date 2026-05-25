#!/usr/bin/env bash
# Granola → Dent Brain sync installer (plumbing only).
#
# What it does:
#   1. Verifies bun is installed; bails with a hint if not.
#   2. Verifies the dent-brain MCP server is registered in ~/.claude.json
#      (token + URL are auto-discovered at runtime).
#   3. Verifies Granola itself is installed (the user mints the API key there).
#   4. Verifies the Granola API key in the macOS keychain. If missing or
#      invalid, prompts the user to paste a key and stores it via `security`.
#   5. Copies runtime + recipe files to ~/.dent-brain/granola-sync/.
#   6. Renders the launchd plist template to ~/Library/LaunchAgents/ but does
#      NOT bootstrap it. The daemon stays inert until the teammate runs
#      /dent-extensions setup granola-sync to author user/filter.ts, then
#      /dent-extensions arm granola-sync to start it.
#   7. Prints next-step guidance.
#
# Privacy contract: nothing reaches the shared brain until the teammate has
# (a) generated a user filter via the setup flow, (b) previewed what would be
# captured, (c) explicitly armed the daemon. install.sh is intentionally
# inert by design.
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
  echo "  2. Install + open it; sign in with your @work.com Google account"
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

# 5. Copy runtime files + recipe + stamp installed version (used by /dent-update
#    for drift detection). `user/` is left untouched — it's owned by the teammate
#    and authored via /dent-extensions setup granola-sync.
mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/recipe" "$INSTALL_DIR/user"
for f in sync.ts types.ts translator.ts mcp-client.ts granola-api.ts; do
  cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
done
cp "$SCRIPT_DIR/recipe/filter.example.ts" "$INSTALL_DIR/recipe/filter.example.ts"
if [ -f "$SCRIPT_DIR/recipe/RECIPE.md" ]; then
  cp "$SCRIPT_DIR/recipe/RECIPE.md" "$INSTALL_DIR/recipe/RECIPE.md"
fi
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

# 6. Render the plist to a staged path, but DO NOT load it. The arm step does
#    that, only after the teammate has authored a user filter and reviewed a
#    preview. Tear down any prior bootstrap so a re-install of this version
#    leaves the daemon provably inert.
mkdir -p "$(dirname "$PLIST_PATH")"
DISARMED=no
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "    unloading prior launch agent…"
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
  DISARMED=yes
fi
sed \
  -e "s|__BUN_PATH__|$BUN_PATH|g" \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$SCRIPT_DIR/com.dent.granola-sync.plist.template" > "$PLIST_PATH"
echo "    staged plist (not loaded): $PLIST_PATH"

echo
if [ "$DISARMED" = "yes" ]; then
  echo "==> ⚠  DAEMON DISARMED. The prior launch agent was torn down for this re-install."
  echo "    Re-run \`dent-extensions arm granola-sync\` to resume syncing."
  echo
fi
echo "==> Plumbing installed. Daemon is INERT — nothing will reach the brain yet."
echo
echo "    Next: tell Claude Code 'set up granola-sync' (or run /dent-extensions"
echo "    setup granola-sync). The skill will:"
echo "      1. Read your Granola folder list."
echo "      2. Walk you through what to include / exclude."
echo "      3. Write $INSTALL_DIR/user/filter.ts."
echo "      4. Run a preview against the last 30 days — you see exactly what"
echo "         would be filed, before anything is filed."
echo "      5. After your approval, arm the daemon."
echo
echo "    Manual paths (if you'd rather hand-author):"
echo "      Copy example:   cp $INSTALL_DIR/recipe/filter.example.ts $INSTALL_DIR/user/filter.ts"
echo "      Preview:        dent-extensions preview granola-sync"
echo "      Arm:            dent-extensions arm granola-sync"
echo "      Uninstall:      dent-extensions uninstall granola-sync"
