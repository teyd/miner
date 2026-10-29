#!/bin/sh
# Usage: scripts/worktree-setup.sh
# Run inside any linked worktree, whoever created it (scripts/worktree.sh, an editor, an agent
# tool). Links the main checkout's local env files (.env.local and friends, never committed)
# into it and installs. Safe to run again.
set -eu

# The main checkout owns the env files, even when this runs inside another worktree.
common="$(git rev-parse --path-format=absolute --git-common-dir)"
root="$(dirname "$common")"
here="$(git rev-parse --show-toplevel)"

if [ "$root" = "$here" ]; then
  echo "this is the main checkout, nothing to link" >&2
else
  # Symlinks, not copies: a token refreshed in the main checkout reaches every worktree.
  for file in "$root"/.env "$root"/.env.*; do
    name="$(basename "$file")"
    if [ -f "$file" ] && [ "$name" != ".env.schema" ] && [ ! -e "$here/$name" ]; then
      ln -s "$file" "$here/$name"
    fi
  done
fi

cd "$here"
pnpm install
