#!/bin/sh
# Usage: scripts/worktree.sh <type>/<task> [base]
# Creates .worktrees/<task> on branch <type>/<task> from <base> (default: dev), links the main
# checkout's local env files (.env.local and friends, never committed) into it, and installs.
set -eu

branch="${1:?usage: scripts/worktree.sh <type>/<task> [base]}"
base="${2:-dev}"
case "$branch" in
  */*) ;;
  *) echo "branch must look like <type>/<task>, e.g. feat/runtime" >&2; exit 1 ;;
esac

# The main checkout owns the env files, even when this runs inside another worktree.
root="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
dir="$root/.worktrees/${branch#*/}"

git -C "$root" worktree add "$dir" -b "$branch" "$base"

# Symlinks, not copies: a token refreshed in the main checkout reaches every worktree.
for file in "$root"/.env "$root"/.env.*; do
  name="$(basename "$file")"
  [ -f "$file" ] && [ "$name" != ".env.schema" ] && ln -s "$file" "$dir/$name"
done

(cd "$dir" && pnpm install)
echo "$dir"
