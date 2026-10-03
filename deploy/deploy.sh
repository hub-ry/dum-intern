#!/usr/bin/env bash
# Test, sync the server's runtime into /opt/skill-tree, restart, and check
# health. The code dir is root-owned so the service can't rewrite itself.
# Run from the repo on hub:  bash deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

npm test

sudo install -d -m 755 /opt/skill-tree
# Only what the server imports: the web folder, the tree code it shares with
# the terminal, and the curated tracks.
sudo rsync -a --delete --chown=root:root --chmod=D755,F644 \
  --include='/src/' --include='/src/web/***' --include='/src/trees/***' \
  --include='/src/sync.ts' --include='/src/skills.ts' --include='/src/curriculum.ts' --include='/src/notes.ts' \
  --exclude='/node_modules/' --exclude='*' \
  ./ /opt/skill-tree/
sudo install -m 644 deploy/server-package.json /opt/skill-tree/package.json
(cd /opt/skill-tree && sudo env PATH=/usr/local/bin:/usr/bin:/bin npm install --omit=dev --no-audit --no-fund --loglevel=error --no-update-notifier)

sudo systemctl restart skill-tree.service
for _ in $(seq 20); do
  curl -fsS http://127.0.0.1:8070/api/health 2>/dev/null && echo && exit 0
  sleep 0.5
done
echo "skill-tree did not come up; journalctl -u skill-tree -n 50" >&2
exit 1
