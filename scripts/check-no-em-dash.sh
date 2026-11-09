#!/bin/sh
# Fails if any tracked copy, doc, or source file contains an em dash (U+2014).
# Project rule: no em dashes in copy, docs, or comments.
set -eu

cd "$(dirname "$0")/.."

# U+2014 in UTF-8 is the byte sequence E2 80 94.
EM_DASH="$(printf '\342\200\224')"

files="$(git ls-files -- '*.md' '*.mdx' '*.ts' '*.tsx' '*.js' '*.jsx' '*.json' '*.yml' '*.yaml' '*.html' '*.css' 2>/dev/null || true)"

if [ -z "$files" ]; then
  exit 0
fi

# shellcheck disable=SC2086
matches="$(printf '%s\n' $files | xargs grep -n -- "$EM_DASH" 2>/dev/null || true)"

if [ -n "$matches" ]; then
  echo "Em dashes are not allowed in this repo. Replace them with a comma, colon, or period:"
  echo "$matches"
  exit 1
fi

echo "No em dashes found."
