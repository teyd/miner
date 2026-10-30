#!/bin/sh
# Refuses staged files that only ever hold secrets or account data: $DATA_DIR (config, state, logs,
# recordings), recordings anywhere, and env files other than the committed .env.schema.
# .gitignore already ignores most of them; this catches `git add -f`.
set -eu
bad="$(git diff --cached --name-only --diff-filter=d -z |
  tr '\0' '\n' |
  grep -E '(^|/)data/|\.jsonl(\.gz)?$|(^|/)\.env($|\.|rc$)' |
  grep -vE '(^|/)\.env\.schema$' || true)"
if [ -n "$bad" ]; then
  printf 'never commit these (unstage with git restore --staged <file>):\n%s\n' "$bad" >&2
  exit 1
fi
