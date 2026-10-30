#!/bin/sh
# Usage: scripts/hooks/token.sh [file]
# Fails if the staged files (or the given file, e.g. a commit message) contain the literal value of
# TOKEN from .env.local. Varlock loads it; the value is never printed or put on a command line.
# Without an env file or TOKEN (a fresh clone) it skips: gitleaks still checks the shape. Any other
# failure (varlock can't load an existing .env.local, bash missing) fails the commit: never silently off.
set -u
root="$(git rev-parse --show-toplevel)"
"$root/node_modules/.bin/varlock" run -- bash "$root/scripts/hooks/token-scan.bash" "$@" 2>/dev/null
rc=$?
case $rc in
  0) exit 0 ;;
  3) exit 1 ;;
  5) echo "token check skipped: no TOKEN set" >&2; exit 0 ;;
  *)
    if ! ls "$root"/.env "$root"/.env.local >/dev/null 2>&1; then
      echo "token check skipped: no .env.local" >&2
      exit 0
    fi
    echo "token check failed (rc $rc): run 'pnpm exec varlock load' to see why" >&2
    exit 1
    ;;
esac
