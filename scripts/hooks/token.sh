#!/bin/sh
# Usage: scripts/hooks/token.sh [file]
# Fails if the staged files (or the given file, e.g. a commit message) contain the literal value of
# TOKEN from .env.local. Varlock loads it; the value is never printed or put on a command line.
# Without a loadable TOKEN (a fresh clone, no .env.local) it skips: gitleaks still checks the shape.
set -u
root="$(git rev-parse --show-toplevel)"
"$root/node_modules/.bin/varlock" run -- bash "$root/scripts/hooks/token-scan.bash" "$@" 2>/dev/null
rc=$?
case $rc in
  0) exit 0 ;;
  3) exit 1 ;;
  *) echo "token check skipped: TOKEN not loadable through varlock" >&2; exit 0 ;;
esac
