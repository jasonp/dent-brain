#!/usr/bin/env bash
# Email → Dent Brain sync installer (plumbing only as of v0.39).
#
# What it does:
#   1. Verifies bun + ~/.claude.json + dent-brain MCP registration.
#   2. Bakes in the shared "Dent Brain" Google OAuth Client ID + Secret.
#   3. Prompts only for workEmail (everything else is shared or auto-derived).
#   4. Writes ~/.dent-brain/email-sync/config.json.
#   5. Copies runtime + recipe files to ~/.dent-brain/email-sync/.
#   6. Runs the one-time Google OAuth dance.
#   7. Probes Gmail to confirm tokens match workEmail.
#   8. Stages the launchd plist to ~/Library/LaunchAgents/ but does NOT
#      bootstrap it. The daemon stays inert until the teammate runs
#      /dent-extensions setup email-sync to author user/filter.ts, then
#      /dent-extensions arm email-sync to start it.
#   9. Tells the user the next-step setup flow.
#
# Privacy contract: nothing reaches the shared brain until the teammate has
# (a) generated a user filter via the setup flow, (b) previewed what would be
# captured, (c) explicitly armed the daemon.
#
# Idempotent. Re-running refreshes runtime files + config + plist + tokens.
#
# The shared Google OAuth credentials live in environment variables so you
# never paste them into chat. Set them in your shell, then run this:
#   DENT_GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
#   DENT_GOOGLE_CLIENT_SECRET=GOCSPX-... \
#   DENT_EMAIL_WORK_EMAIL=you@example.com \
#     bash tools/email-sync/install.sh
#
# For Dent admins: see tools/email-sync/README.md "Distributing the OAuth app"
# for how to package these into the /dent-extensions install command so
# teammates don't have to set the env vars themselves.
#
# Uninstall:
#   tools/extensions/bin/dent-extensions uninstall email-sync

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.dent-brain/email-sync"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.dent.email-sync.plist"
LABEL="com.dent.email-sync"
TOKENS_PATH="${INSTALL_DIR}/google-tokens.json"

echo "==> Email-sync installer"
echo "    source: $SCRIPT_DIR"
echo "    target: $INSTALL_DIR"

# 1. Verify bun
if ! command -v bun >/dev/null 2>&1; then
  echo
  echo "ERROR: bun is not installed."
  echo "Install bun first:  curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
BUN_PATH="$(command -v bun)"
echo "    bun: $BUN_PATH"

# 2. Verify ~/.claude.json + dent-brain MCP registration
CLAUDE_JSON="${HOME}/.claude.json"
if [ ! -f "$CLAUDE_JSON" ]; then
  echo
  echo "ERROR: ~/.claude.json not found."
  echo "Run /dent-onboard-teammate first to register the MCP server."
  exit 1
fi
if ! bun -e 'import { readFileSync } from "fs";
const c = JSON.parse(readFileSync(process.argv[1], "utf-8"));
const projects = c?.projects ? Object.values(c.projects) : [];
const cands = [c, ...projects];
let url = null;
for (const cand of cands) {
  const e = cand?.mcpServers?.["dent-brain"];
  if (e?.url && e?.headers?.Authorization?.startsWith?.("Bearer ")) { url = e.url; break; }
}
if (!url) process.exit(1);
console.log(url);' "$CLAUDE_JSON" > /tmp/email-sync-discover.$$ 2>/dev/null; then
  echo
  echo "ERROR: ~/.claude.json has no dent-brain MCP entry with a Bearer token."
  echo "Run /dent-onboard-teammate first, then re-run this installer."
  rm -f /tmp/email-sync-discover.$$
  exit 1
fi
DISCOVERED_URL="$(cat /tmp/email-sync-discover.$$)"
rm -f /tmp/email-sync-discover.$$
echo "    dent-brain MCP discovered: $DISCOVERED_URL"

# 3. Collect config values. Env vars win; otherwise prompt.
prompt_required() {
  local var="$1"; local label="$2"; local silent="${3:-no}"
  local current="${!var:-}"
  if [ -n "$current" ] && [[ ! "$current" =~ ^REPLACE_ ]]; then return 0; fi
  echo
  if [ "$silent" = "yes" ]; then
    read -r -s -p "  $label: " val
    echo
  else
    read -r -p "  $label: " val
  fi
  if [ -z "$val" ]; then
    echo "ERROR: $label is required."
    exit 1
  fi
  printf -v "$var" '%s' "$val"
}

prompt_required DENT_EMAIL_WORK_EMAIL "Your work email (e.g. steve@dentthefuture.com)"
prompt_required DENT_GOOGLE_CLIENT_ID "Dent Brain Google OAuth Client ID (...apps.googleusercontent.com)"
prompt_required DENT_GOOGLE_CLIENT_SECRET "Dent Brain Google OAuth Client Secret (GOCSPX-...)" yes
DENT_EMAIL_AUTHUSER="${DENT_EMAIL_AUTHUSER:-0}"

echo "    workEmail:        $DENT_EMAIL_WORK_EMAIL"
echo "    googleClientId:   ${DENT_GOOGLE_CLIENT_ID:0:24}..."
echo "    authUser:         $DENT_EMAIL_AUTHUSER"

# 4. Copy runtime files + recipe + stamp installed version. `user/` is left
#    untouched — owned by the teammate, authored via /dent-extensions setup.
mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/recipe" "$INSTALL_DIR/user"
for f in collect.ts types.ts mcp-client.ts google-client.ts oauth-flow.ts noise-filter.ts link-gen.ts digest.ts; do
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
echo "    copied 8 runtime files (installed-version: $(cat "$INSTALL_DIR/.installed-version"))."

# 4b. Install the Layer-2 skill body to a stable location the teammate's
#     Claude Code Desktop scheduled task will reference. Sits OUTSIDE
#     ~/.claude/scheduled-tasks/ on purpose: that path is Claude's owned
#     namespace (the Routines tool writes its own SKILL.md there with
#     the user's task-creation prompt). We ship the canonical body in our
#     namespace; the teammate's Routines task is just a thin pointer.
SKILL_DIR="${HOME}/.dent-brain/skills"
mkdir -p "$SKILL_DIR"
SKILL_SRC="$(cd "$SCRIPT_DIR/../.." && pwd)/skills/dent/process-inbox/SKILL.md"
SKILL_DST="$SKILL_DIR/process-inbox.md"
if [ -f "$SKILL_SRC" ]; then
  # Resolve {{prefix}} → "dent" in the same install step that copies it,
  # so the teammate's installed file is verbatim what Claude Code reads.
  sed 's/{{prefix}}/dent/g' "$SKILL_SRC" > "$SKILL_DST"
  echo "    installed Layer-2 skill: $SKILL_DST"
else
  echo "    WARNING: could not find process-inbox SKILL.md at $SKILL_SRC"
  echo "    Skipping Layer-2 install. You can copy it manually later."
fi

# 5. Write config.json. Mode 0600 — secret is sensitive even though Google
#    classifies it as a public identifier for Desktop apps.
CONFIG_PATH="$INSTALL_DIR/config.json"
umask 077
cat > "$CONFIG_PATH" <<EOF
{
  "workEmail": "$DENT_EMAIL_WORK_EMAIL",
  "googleClientId": "$DENT_GOOGLE_CLIENT_ID",
  "googleClientSecret": "$DENT_GOOGLE_CLIENT_SECRET",
  "googleTokensPath": "$TOKENS_PATH",
  "authUser": "$DENT_EMAIL_AUTHUSER",
  "cursorPath": "$INSTALL_DIR/cursor.json",
  "cacheDir": "$INSTALL_DIR/cache"
}
EOF
umask 022
chmod 600 "$CONFIG_PATH"
echo "    wrote config: $CONFIG_PATH (mode 600)"

# 6. One-time OAuth dance. Skip if a refresh token is already on disk and
#    matches the configured workEmail; that means a previous install already
#    succeeded.
NEED_OAUTH=yes
if [ -f "$TOKENS_PATH" ]; then
  echo
  echo "==> Found existing OAuth tokens at $TOKENS_PATH."
  if PROBE_OUT=$(bun --cwd "$INSTALL_DIR" -e '
import { GoogleClient } from "./google-client.ts";
const cfg = JSON.parse(require("fs").readFileSync("./config.json","utf-8"));
const gc = new GoogleClient({ tokensPath: cfg.googleTokensPath, clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret });
gc.health().then(p => { console.log(p.emailAddress); process.exit(0); }, e => { console.error(e.message); process.exit(1); });
' 2>&1); then
    if [ "$PROBE_OUT" = "$DENT_EMAIL_WORK_EMAIL" ]; then
      echo "    Tokens valid for $PROBE_OUT — skipping OAuth dance."
      NEED_OAUTH=no
    else
      echo "    Existing tokens are for $PROBE_OUT but workEmail is $DENT_EMAIL_WORK_EMAIL."
      echo "    Re-running OAuth flow..."
    fi
  else
    echo "    Existing tokens did not validate ($PROBE_OUT) — re-running OAuth flow."
  fi
fi

if [ "$NEED_OAUTH" = "yes" ]; then
  echo
  echo "==> Running one-time Google OAuth dance..."
  echo "    A browser tab will open. You'll see a 'this app isn't verified'"
  echo "    warning — this is expected (Dent Brain is in test mode in Google"
  echo "    Cloud). Click 'Advanced' → 'Go to Dent Brain (unsafe)' → 'Allow'."
  echo
  bun "$INSTALL_DIR/oauth-flow.ts" \
    --client-id "$DENT_GOOGLE_CLIENT_ID" \
    --client-secret "$DENT_GOOGLE_CLIENT_SECRET" \
    --tokens-path "$TOKENS_PATH"
  chmod 600 "$TOKENS_PATH"
fi

# 7. Probe Gmail one more time — confirms tokens work AND match workEmail.
echo
echo "==> Probing Gmail with the freshly-issued token..."
PROBE_RESULT=$(bun --cwd "$INSTALL_DIR" -e '
import { GoogleClient } from "./google-client.ts";
const cfg = JSON.parse(require("fs").readFileSync("./config.json","utf-8"));
const gc = new GoogleClient({ tokensPath: cfg.googleTokensPath, clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret });
gc.health().then(p => { console.log(p.emailAddress); process.exit(0); }, e => { console.error(e.message); process.exit(1); });
' 2>&1)
PROBE_EXIT=$?
if [ $PROBE_EXIT -ne 0 ]; then
  echo "ERROR: Gmail probe failed: $PROBE_RESULT"
  echo "Check that $DENT_EMAIL_WORK_EMAIL is on the Google Cloud test-user list,"
  echo "and that the OAuth client is for a 'Desktop app' application type."
  exit 1
fi
if [ "$PROBE_RESULT" != "$DENT_EMAIL_WORK_EMAIL" ]; then
  echo "ERROR: OAuth tokens are for $PROBE_RESULT but config.workEmail is $DENT_EMAIL_WORK_EMAIL."
  echo "You may have authorized a different Google account in the browser. Re-run install.sh."
  rm -f "$TOKENS_PATH"
  exit 1
fi
echo "    Gmail: reachable as $PROBE_RESULT"

# 8. Stage the plist to ~/Library/LaunchAgents but DO NOT bootstrap it. The
#    arm step (/dent-extensions arm email-sync) does that, only after the
#    teammate has authored a user filter and reviewed a preview.
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
  "$SCRIPT_DIR/com.dent.email-sync.plist.template" > "$PLIST_PATH"
echo "    staged plist (not loaded): $PLIST_PATH"

echo
if [ "$DISARMED" = "yes" ]; then
  echo "==> ⚠  DAEMON DISARMED. The prior launch agent was torn down for this re-install."
  echo "    Re-run \`dent-extensions arm email-sync\` to resume syncing."
  echo
fi
echo "==> Plumbing installed. Daemon is INERT — nothing will reach the brain yet."
echo
echo "    Next: tell Claude Code 'set up email-sync' (or run /dent-extensions"
echo "    setup email-sync). The skill will:"
echo "      1. Sample your recent senders + ask about your inbox posture."
echo "      2. Walk you through include/exclude rules for your work email."
echo "      3. Write $INSTALL_DIR/user/filter.ts."
echo "      4. Run a preview over the last few days — you see exactly what"
echo "         would be filed, before anything is filed."
echo "      5. After your approval, arm the daemon."
echo
echo "    Manual paths (if you'd rather hand-author):"
echo "      Copy example:   cp $INSTALL_DIR/recipe/filter.example.ts $INSTALL_DIR/user/filter.ts"
echo "      Preview:        dent-extensions preview email-sync"
echo "      Arm:            dent-extensions arm email-sync"
echo "      Uninstall:      dent-extensions uninstall email-sync"
echo
echo "==> Layer 2 (entity-timeline enrichment) is a separate Claude Code"
echo "    Desktop scheduled task. Skill body: $SKILL_DST"
echo "    To register, in Claude Code Desktop:"
echo "        Create a daily scheduled task at 3am called dent-process-inbox"
echo "        with these instructions:"
echo "          \"Read ~/.dent-brain/skills/process-inbox.md and follow the"
echo "          instructions exactly.\""
