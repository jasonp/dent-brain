#!/bin/bash
#
# check-deploy-identity.sh — keep real deploy identity out of the public repo.
#
# The repo ships a PLACEHOLDER plugin/manifest.json; the real org identity +
# endpoints live in plugin/manifest.local.json (gitignored). The plugin build
# (build:plugin) reads ONLY the committed placeholder manifest, so the
# generated, committed marketplace bundle is always placeholder-safe.
#
# This gate is the safety net: it greps the committed public-facing build
# surface for the real org's identity tokens and fails loudly if any leaked
# in — e.g. if someone wired the build to merge manifest.local.json and then
# committed the regenerated bundle, or hand-edited a bundle file.
#
# Scope is deliberately narrow: the manifest + the generated bundle. Source
# code, tests, and the historical CHANGELOG are de-identified on their own
# track and are NOT scanned here (a separate pass / different gate owns those).
#
# Usage:
#   scripts/check-deploy-identity.sh          # scan working tree
#   scripts/check-deploy-identity.sh --staged # scan git staged index
#   scripts/check-deploy-identity.sh --help
#
# Exit codes: 0 clean, 1 identity leaked, 2 setup error.

set -euo pipefail

# Real org identity tokens that must never reach the public bundle surface.
# (Case-insensitive. The domain covers server_url, data_repo, and emails.)
BANNED_PATTERNS=(
  'dentthefuture'
  'Dent The Future'
)

# Only these committed paths are scanned — the artifact a teammate/forker
# downloads and installs.
SCAN_PATHS=(
  'plugin/manifest.json'
  '.claude-plugin'
  'plugin/marketplace'
)

usage() {
  cat <<EOF
scripts/check-deploy-identity.sh — keep real deploy identity out of the public bundle.

USAGE:
  scripts/check-deploy-identity.sh           Scan tracked bundle files in the working tree.
  scripts/check-deploy-identity.sh --staged  Scan only staged bundle files.
  scripts/check-deploy-identity.sh --help    Show this message.

Scans ${SCAN_PATHS[*]} for the real org identity (placeholders only allowed there).
Real values belong in plugin/manifest.local.json (gitignored).

Exit codes: 0 clean, 1 identity leaked, 2 setup error.
EOF
}

MODE=working
for arg in "$@"; do
  case "$arg" in
    --staged) MODE=staged ;;
    --help|-h) usage; exit 1 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "check-deploy-identity: git not found" >&2
  exit 2
fi

if [ "$MODE" = staged ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR -- "${SCAN_PATHS[@]}" 2>/dev/null || true)
else
  FILES=$(git ls-files -- "${SCAN_PATHS[@]}" 2>/dev/null || true)
fi

[ -z "$FILES" ] && exit 0

FOUND=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ ! -f "$file" ] && continue
  # This script names the banned tokens to enforce the rule — skip itself.
  [ "$file" = "scripts/check-deploy-identity.sh" ] && continue
  for pat in "${BANNED_PATTERNS[@]}"; do
    if grep -in "$pat" "$file" >/dev/null 2>&1; then
      echo "[check-deploy-identity] real org identity '$pat' in $file:" >&2
      grep -in "$pat" "$file" | sed 's|^|  |' >&2
      FOUND=1
    fi
  done
done <<< "$FILES"

if [ "$FOUND" -eq 1 ]; then
  echo "" >&2
  echo "Real deploy identity leaked into the public bundle surface." >&2
  echo "The committed manifest + bundle must use placeholders; real values go in" >&2
  echo "plugin/manifest.local.json (gitignored). Re-run 'bun run build:plugin' with" >&2
  echo "no manifest.local.json present to regenerate a clean bundle." >&2
  exit 1
fi

exit 0
