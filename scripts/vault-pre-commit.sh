#!/usr/bin/env sh
set -eu

if ! git diff --cached --name-only --diff-filter=ACMRD -- '*.md' ':!z_player_facing/*' | grep -q .; then
  exit 0
fi

VAULT_ROOT="$(git rev-parse --show-toplevel)"
SITE_REPO="${TIMESCAPE_SITE_REPO:-c:/Users/walke/Documents/Coding/timescape-site}"
SYNC_SCRIPT="$SITE_REPO/scripts/ensure-pfn-synced.mjs"

if [ ! -f "$SYNC_SCRIPT" ]; then
  echo "Player-facing sync helper not found at: $SYNC_SCRIPT" >&2
  echo "Set TIMESCAPE_SITE_REPO to your timescape-site clone (or pass --no-verify to skip)." >&2
  exit 1
fi

if [ -n "${TIMESCAPE_VAULT_NAME:-}" ]; then
  node "$SYNC_SCRIPT" "$VAULT_ROOT" --vault-name "$TIMESCAPE_VAULT_NAME"
else
  node "$SYNC_SCRIPT" "$VAULT_ROOT"
fi

if [ -d "$VAULT_ROOT/z_player_facing" ]; then
  git add -- "$VAULT_ROOT/z_player_facing"
fi
