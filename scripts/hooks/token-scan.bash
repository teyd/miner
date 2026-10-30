#!/usr/bin/env bash
# Run by token.sh under `varlock run`. Exit 0: clean, 3: token found, 5: no TOKEN. Reports on stdout.
set -u
[ -n "${TOKEN:-}" ] || exit 5
# printf is a builtin, so the token reaches grep through a pipe, never through argv.
has_token() { grep -qaFf <(printf '%s\n' "$TOKEN"); }
if [ $# -gt 0 ]; then
  if has_token <"$1"; then
    echo "token found in $1"
    exit 3
  fi
  exit 0
fi
found=0
while IFS= read -r -d '' file; do
  if has_token < <(git show ":$file"); then
    echo "token found in staged file $file"
    found=1
  fi
done < <(git diff --cached --name-only --diff-filter=d -z)
[ $found -eq 0 ] || exit 3
