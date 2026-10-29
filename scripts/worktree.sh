#!/bin/sh
# Usage: scripts/worktree.sh <type>/<task> [base]
# Plain-git way to start a task: creates .worktrees/<task> on branch <type>/<task> from <base>
# (default: dev), then runs scripts/worktree-setup.sh in it. Not needed when a tool such as
# T3 Code already made the worktree: run scripts/worktree-setup.sh there instead.
set -eu

branch="${1:?usage: scripts/worktree.sh <type>/<task> [base]}"
base="${2:-dev}"
case "$branch" in
  */*) ;;
  *) echo "branch must look like <type>/<task>, e.g. feat/runtime" >&2; exit 1 ;;
esac

root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
dir="$root/.worktrees/${branch#*/}"

git -C "$root" worktree add "$dir" -b "$branch" "$base"
(cd "$dir" && sh scripts/worktree-setup.sh)
echo "$dir"
