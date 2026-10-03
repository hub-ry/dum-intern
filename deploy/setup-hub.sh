#!/usr/bin/env bash
# One-time setup on hub: service user, systemd unit, and the route on the
# existing cloudflared tunnel. Safe to re-run.
# Run from the repo:  bash deploy/setup-hub.sh   (then deploy/deploy.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=skill-tree.ryhub.dev
PORT=8070
TUNNEL=95f5d6c2-4eb8-4afe-8f36-cd782f7605f2
CFG=/etc/cloudflared/config.yml

id skill-tree >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin skill-tree

sudo install -m 644 deploy/skill-tree.service /etc/systemd/system/skill-tree.service
sudo systemctl daemon-reload
sudo systemctl enable skill-tree.service

# Add the hostname above the catch-all 404 rule, once.
if ! grep -q "hostname: $HOST" "$CFG"; then
  sudo cp "$CFG" "$CFG.bak"
  sudo sed -i "s|^  - service: http_status:404|  - hostname: $HOST\n    service: http://127.0.0.1:$PORT\n  - service: http_status:404|" "$CFG"
  sudo cloudflared tunnel --config "$CFG" ingress validate
  sudo systemctl restart cloudflared
fi
cloudflared tunnel route dns "$TUNNEL" "$HOST" || true   # errors if the record exists
