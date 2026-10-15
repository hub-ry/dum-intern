#!/usr/bin/env bash
# Runs as root INSIDE the workday VM (push-code.sh pushes it with the code tarball and runs it).
#   install-code.sh TARBALL LOCK_SHA [--deps]
# Unpacks the code into /opt/dum-workday (root-owned, swapped in whole). With --deps (or when the
# installed node_modules was built from a different package-lock.json) runs npm ci and installs
# Playwright's Chromium + its apt dependencies into /opt/ms-playwright; that needs hub's egress
# proxy in --provision mode, which push-code.sh arranges. Then seeds missing data files and
# restarts the worker.
set -euo pipefail

tarball=${1:?usage: install-code.sh TARBALL LOCK_SHA [--deps]}
lock_sha=${2:?}
deps=${3:-}
proxy=http://10.77.0.1:3128
export http_proxy=$proxy https_proxy=$proxy HTTP_PROXY=$proxy HTTPS_PROXY=$proxy
export no_proxy=localhost,127.0.0.1 NO_PROXY=localhost,127.0.0.1
export DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
export PATH=/usr/local/bin:$PATH
cur=/opt/dum-workday
new=/opt/dum-workday.new
home=/home/worker/workday
marker=node_modules/.dum-workday-lock-sha256

rm -rf "$new"
mkdir -p "$new"
tar -xf "$tarball" -C "$new" --no-same-owner
rm -f "$tarball"

if [ "$deps" != "--deps" ] && [ "$(cat "$cur/$marker" 2>/dev/null)" = "$lock_sha" ]; then
  mv "$cur/node_modules" "$new/node_modules"
else
  echo "== npm ci"
  (cd "$new" && npm ci --omit=dev --no-audit --no-fund)
  echo "== Playwright Chromium (+ apt deps)"
  (cd "$new" && npx playwright-core install-deps chromium && npx playwright-core install chromium)
  chmod -R a+rX /opt/ms-playwright
  echo "$lock_sha" >"$new/$marker"
fi

chown -R root:root "$new"
chmod -R go-w "$new"
rm -rf "$cur.old"
[ -d "$cur" ] && mv "$cur" "$cur.old"
mv "$new" "$cur"
rm -rf "$cur.old"

echo "== data files"
chattr -i "$home"
[ -e "$home/config.json" ] || install -o root -g root -m 0644 /dev/stdin "$home/config.json" <<<'{"allow": [], "allowHttp": false}'
[ -e "$home/vault.json" ] || install -o worker -g worker -m 0600 /dev/stdin "$home/vault.json" <<<'{}'
if [ ! -e "$home/profile.json" ]; then
  if [ -e "$cur/src/workday/profile.example.json" ]; then
    install -o worker -g worker -m 0600 "$cur/src/workday/profile.example.json" "$home/profile.json"
  else
    echo "profile.json not created: $cur/src/workday/profile.example.json is not in this code yet"
  fi
fi
chattr +i "$home"

echo "== worker"
systemctl daemon-reload
if [ ! -e "$cur/src/workday/serve.ts" ]; then
  echo "dum-workday.service not started: $cur/src/workday/serve.ts is not in this code yet"
elif [ ! -e "$home/approval.pub" ]; then
  systemctl stop dum-workday.service
  echo "dum-workday.service not started: $home/approval.pub missing; put it at ~/.config/dum-workday/approval.pub on hub and rerun provision.sh"
else
  systemctl restart dum-workday.service
  sleep 3
  systemctl --no-pager --lines=15 status dum-workday.service || true
fi
