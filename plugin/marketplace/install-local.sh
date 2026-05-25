#!/usr/bin/env bash
# Example Org, Inc. Brain plugin — Code-mode local installer (v0.40.0.0).
#
# Registers plugin/marketplace/ as a local Claude Code marketplace, then
# installs the plugin from it. This is for Code mode (terminal CLI / Claude
# Desktop's Code mode) only — Cowork has a separate plugin store.
#
# For Cowork install: in a Cowork chat, ask Cowork to "add a custom
# marketplace from github:<your-fork>" and install dent-brain.

set -euo pipefail

DIST_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TARGET_FREEFORM="$HOME/.claude/skills"
MARKETPLACE_NAME="dent-brain"
PLUGIN_NAME="dent-brain"

echo "Installing $PLUGIN_NAME plugin v0.40.0.0 via Claude Code marketplace"
echo "  source: $DIST_DIR"
echo ""

if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: 'claude' CLI not on PATH. Install Claude Code first:"
  echo "  https://claude.ai/download"
  exit 1
fi

# Clean up any legacy freeform install from the v0.29 build pattern.
FREEFORM_REMOVED=0
for skill in dent-setup dent-append-evidence dent-enrich dent-resolve-entity dent-onboard-teammate dent-add-ingestor dent-extensions dent-tell-me-about dent-update dent-process-inbox; do
  if [ -d "$TARGET_FREEFORM/$skill" ]; then
    rm -rf "$TARGET_FREEFORM/$skill"
    echo "  cleaned: $TARGET_FREEFORM/$skill (legacy freeform install)"
    FREEFORM_REMOVED=$((FREEFORM_REMOVED + 1))
  fi
done

echo ""
echo "Registering local marketplace at $DIST_DIR..."
claude plugin marketplace add "$DIST_DIR" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Installing $PLUGIN_NAME@$MARKETPLACE_NAME..."
claude plugin install "$PLUGIN_NAME@$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Verifying install..."
if claude plugin list 2>/dev/null | grep -q "$PLUGIN_NAME@$MARKETPLACE_NAME"; then
  echo "  ✓ $PLUGIN_NAME@$MARKETPLACE_NAME is installed"
else
  echo "  ✗ install verification failed — run 'claude plugin list' to debug"
  exit 2
fi

echo ""
echo "Done. $FREEFORM_REMOVED legacy freeform install(s) cleaned, plugin installed."
echo ""
echo "Code mode will see the slash commands on the next session start."
echo ""
echo "For Cowork: open Cowork and ask"
echo "    'Add a custom marketplace from github:<your-fork> and install $PLUGIN_NAME'"
echo "Cowork has its own separate plugin store; the local marketplace this"
echo "script registered does NOT reach Cowork."
echo ""
echo "Uninstall (Code mode): bash $DIST_DIR/uninstall-local.sh"
