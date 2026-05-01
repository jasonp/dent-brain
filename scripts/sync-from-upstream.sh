#!/usr/bin/env bash
# scripts/sync-from-upstream.sh
#
# Pull updates from upstream gbrain (garrytan/gbrain) into this dbrain fork.
# Re-applies the gbrain → dbrain rename in package.json if upstream's version
# clobbered our changes during the merge.
#
# Usage:
#   bun run sync:upstream         (recommended)
#   bash scripts/sync-from-upstream.sh
#
# What it does:
#   1. Verifies upstream remote points at garrytan/gbrain
#   2. Fetches upstream master
#   3. Attempts a clean merge into the current branch
#   4. Detects and surfaces any conflicts (you resolve manually)
#   5. Verifies package.json still has dbrain branding (re-applies if not)
#   6. Runs `bun test` to confirm nothing else broke
#   7. Reports clean status or what needs human attention
#
# Cost per upstream merge: ~2 minutes if no conflicts, longer if substrate
# changes touch files we've extended.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Verify upstream remote
# ---------------------------------------------------------------------------

UPSTREAM_URL="$(git remote get-url upstream 2>/dev/null || echo '')"
EXPECTED_UPSTREAM="https://github.com/garrytan/gbrain.git"

if [[ "$UPSTREAM_URL" != "$EXPECTED_UPSTREAM" ]]; then
  echo "ERROR: 'upstream' remote does not point at gbrain."
  echo "  Expected: $EXPECTED_UPSTREAM"
  echo "  Found:    ${UPSTREAM_URL:-<not set>}"
  echo
  echo "Fix with:"
  echo "  git remote add upstream $EXPECTED_UPSTREAM"
  echo "  (or 'git remote set-url upstream $EXPECTED_UPSTREAM' if the remote exists)"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Fetch upstream
# ---------------------------------------------------------------------------

echo "==> Fetching upstream..."
git fetch upstream master

# Save current branch so we can reset on failure
CURRENT_BRANCH="$(git branch --show-current)"
echo "==> On branch: $CURRENT_BRANCH"

# ---------------------------------------------------------------------------
# 3. Attempt merge
# ---------------------------------------------------------------------------

echo "==> Merging upstream/master..."
if ! git merge upstream/master --no-edit; then
  echo
  echo "MERGE CONFLICT — resolve manually."
  echo "Files in conflict:"
  git diff --name-only --diff-filter=U
  echo
  echo "After resolving:"
  echo "  git add <files>"
  echo "  git commit"
  echo "  bun test"
  echo
  echo "Then re-run: bun run sync:upstream"
  echo "(it'll skip the merge step, re-verify rename, run tests.)"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Verify dbrain rename survived the merge
# ---------------------------------------------------------------------------

echo "==> Verifying dbrain rename in package.json..."

NAME="$(grep -E '^\s*"name"' package.json | head -1 | sed 's/.*"name":\s*"\([^"]*\)".*/\1/')"
BIN_KEY="$(grep -A 2 '"bin"' package.json | grep -E '^\s*"[a-z]+"' | head -1 | sed 's/.*"\([a-z]*\)".*/\1/')"

NEEDS_REAPPLY=false
if [[ "$NAME" != "dbrain" ]]; then
  echo "  package.json 'name' clobbered: $NAME (expected: dbrain)"
  NEEDS_REAPPLY=true
fi
if [[ "$BIN_KEY" != "dbrain" ]]; then
  echo "  package.json 'bin' clobbered: $BIN_KEY (expected: dbrain)"
  NEEDS_REAPPLY=true
fi

if $NEEDS_REAPPLY; then
  echo "==> Re-applying dbrain rename to package.json..."
  # Use sed to restore the rename. Two cases handled:
  #   1. Top-level "name": "gbrain" → "dbrain"
  #   2. bin "gbrain": → "dbrain":
  # Build outfile renames are also restored.
  sed -i.bak \
    -e 's/"name": "gbrain"/"name": "dbrain"/' \
    -e 's/"gbrain": "src\/cli\.ts"/"dbrain": "src\/cli.ts"/' \
    -e 's/--outfile bin\/gbrain /--outfile bin\/dbrain /g' \
    -e 's/--outfile bin\/gbrain-/--outfile bin\/dbrain-/g' \
    package.json
  rm -f package.json.bak

  # Verify
  NAME_AFTER="$(grep -E '^\s*"name"' package.json | head -1 | sed 's/.*"name":\s*"\([^"]*\)".*/\1/')"
  BIN_AFTER="$(grep -A 2 '"bin"' package.json | grep -E '^\s*"[a-z]+"' | head -1 | sed 's/.*"\([a-z]*\)".*/\1/')"

  if [[ "$NAME_AFTER" != "dbrain" || "$BIN_AFTER" != "dbrain" ]]; then
    echo "ERROR: rename re-application failed. Manual fix needed:"
    echo "  - Edit package.json to set 'name' and 'bin' both to 'dbrain'"
    exit 1
  fi

  echo "  Rename re-applied. Staging the fix:"
  git add package.json
  git commit -m "chore(sync): re-apply dbrain rename after upstream merge"
fi

# ---------------------------------------------------------------------------
# 5. Run tests
# ---------------------------------------------------------------------------

echo "==> Running tests..."
if ! bun test --timeout=60000 2>&1 | tail -20; then
  echo
  echo "WARNING: tests failed after upstream merge."
  echo "This usually means upstream changed an interface our additions depend on."
  echo "Investigate failures and fix before pushing."
  exit 1
fi

# ---------------------------------------------------------------------------
# 6. Report
# ---------------------------------------------------------------------------

UPSTREAM_HEAD="$(git rev-parse upstream/master | cut -c1-8)"
LOCAL_HEAD="$(git rev-parse HEAD | cut -c1-8)"
echo
echo "============================================"
echo "Upstream sync complete."
echo "  upstream/master: $UPSTREAM_HEAD"
echo "  $CURRENT_BRANCH HEAD: $LOCAL_HEAD"
echo "  Tests: passing"
echo "  dbrain rename: intact"
echo
echo "Next: review the merge with 'git log --oneline upstream/master..HEAD'"
echo "      then push with 'git push origin $CURRENT_BRANCH'"
echo "============================================"
