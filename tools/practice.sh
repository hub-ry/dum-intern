#!/usr/bin/env bash
# A fresh repo and skill tree for trying this checkout without touching real projects.
set -euo pipefail

root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
practice="$(mktemp -d "${TMPDIR:-/tmp}/dum-practice.XXXXXX")"
mkdir -p "$practice/repo" "$practice/home"
git init -q "$practice/repo"
printf 'Practice repo: %s\nSkill notes:   %s\nBoth stay here after you exit.\n\n' "$practice/repo" "$practice/home"
cd "$practice/repo"
export DUM_HOME="$practice/home"
exec node --import "$root/node_modules/tsx/dist/loader.mjs" "$root/src/cli.tsx" "$@"
