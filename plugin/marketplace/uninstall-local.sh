#!/usr/bin/env bash
# Uninstall the local Code-mode marketplace registration. Cowork install
# (if any) is unaffected — it uses a separate store.

set -euo pipefail

MARKETPLACE_NAME="dent-brain"
PLUGIN_NAME="dent-brain"

if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: 'claude' CLI not on PATH."
  exit 1
fi

echo "Uninstalling $PLUGIN_NAME@$MARKETPLACE_NAME (Code mode only)..."
claude plugin uninstall "$PLUGIN_NAME@$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Removing local marketplace $MARKETPLACE_NAME..."
claude plugin marketplace remove "$MARKETPLACE_NAME" 2>&1 | sed 's/^/  /' || true

echo ""
echo "Done. Restart Claude Desktop / Code session to clear cached state."
