#!/bin/sh
# Usage: scripts/hooks/gitleaks.sh <gitleaks arguments>
# Runs the gitleaks pinned in mise.toml through mise, else a gitleaks on PATH. Without either it fails:
# a guard that skips itself guards nothing.
set -eu
root="$(git rev-parse --show-toplevel)"
version="$(sed -n 's/^gitleaks *= *"\(.*\)"$/\1/p' "$root/mise.toml")"
if command -v mise >/dev/null 2>&1; then
  exec mise exec "gitleaks@$version" -- gitleaks "$@"
fi
if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks "$@"
fi
echo "gitleaks $version is needed: install mise (https://mise.jdx.dev) and run 'mise install'" >&2
exit 1
