#!/usr/bin/env bash
# Copies this worktree's code (tracked + untracked non-ignored files, uncommitted edits included)
# into the workday VM at /opt/dum-workday with `lxc file push`, and restarts the worker.
#   push-code.sh [--deps]
# npm ci + Playwright Chromium run only when package-lock.json changed since the last install (or
# with --deps); for that the egress proxy is switched to --provision mode and back to allowlist.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
vm=workday
force=${1:-}

lxc info "$vm" >/dev/null 2>&1 || { echo "VM $vm does not exist; run provision.sh" >&2; exit 1; }

lock_sha=$(sha256sum "$repo/package-lock.json" | cut -d' ' -f1)
vm_sha=$(lxc exec "$vm" -- cat /opt/dum-workday/node_modules/.dum-workday-lock-sha256 2>/dev/null || true)
deps=""
if [ "$force" = "--deps" ] || [ "$vm_sha" != "$lock_sha" ]; then deps=--deps; fi

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
  if [ -n "$deps" ]; then "$here/egress.sh" start; fi
}
trap cleanup EXIT

(
  cd "$repo"
  git ls-files -co --exclude-standard -z |
    while IFS= read -r -d '' f; do
      if [ -f "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
    done |
    tar --null -T - -cf "$tmp/code.tar"
)

if [ -n "$deps" ]; then "$here/egress.sh" start --provision; fi

lxc file push --quiet --uid 0 --gid 0 --mode 0600 "$tmp/code.tar" "$vm/root/dum-workday-code.tar"
lxc file push --quiet --uid 0 --gid 0 --mode 0700 "$here/vm/install-code.sh" "$vm/root/dum-workday-install-code.sh"
lxc exec "$vm" -- /root/dum-workday-install-code.sh /root/dum-workday-code.tar "$lock_sha" $deps
echo "code pushed: $(git -C "$repo" rev-parse --short HEAD)$(git -C "$repo" diff --quiet HEAD || echo ' + uncommitted changes')"
