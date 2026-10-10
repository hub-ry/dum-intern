#!/usr/bin/env bash
# Deploy Dum's public static site to hub.
#
# Usage (from the repo on hub):   bash deploy/deploy.sh
#
# What it does, and nothing more:
#   * copies src/public/server.ts and the public assets in src/site into
#     /opt/dum-public, root-owned (dirs 755, files 644) so the service user
#     cannot rewrite its own code;
#   * writes a minimal package.json there so Node treats the .ts as ESM;
#   * installs deploy/dum-public.service and reloads systemd;
#   * on first run, cuts over from the retired skill-tree.service to
#     dum-public.service; on later runs, restarts dum-public.service.
#
# It runs no tests, builds, lint or npm install: Node 24 executes the
# TypeScript directly and the server has no dependencies.
#
# Ownership: /opt/dum-public is root:root. The service runs as the existing
# system user skill-tree (created here only if absent). The private workshop
# (deploy/dum-workshop.service, a user unit) and cloudflared are not touched.
# /var/lib/skill-tree is left in place; nothing here deletes persisted state.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL_ROOT=/opt/dum-public
SERVICE=dum-public.service
OLD_SERVICE=skill-tree.service
SERVICE_USER=skill-tree

# Service user: reuse the existing one, create only when missing.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# Code and public assets only. Nothing from the repo root, package files,
# workshop, models or private data is copied.
sudo install -d -m 755 -o root -g root "$INSTALL_ROOT" "$INSTALL_ROOT/src"
sudo rsync -a --delete --chown=root:root --chmod=D755,F644 \
  --include='/public/' --include='/public/server.ts' \
  --include='/site/***' \
  --exclude='*' \
  src/ "$INSTALL_ROOT/src/"

# Minimal module marker so `node server.ts` loads as ESM. Generated here;
# no package file is copied from the repo.
printf '{\n  "name": "dum-public",\n  "private": true,\n  "type": "module"\n}\n' \
  | sudo tee "$INSTALL_ROOT/package.json" >/dev/null
sudo chown root:root "$INSTALL_ROOT/package.json"
sudo chmod 644 "$INSTALL_ROOT/package.json"

# Unit file, then reload so systemd sees the new or changed unit.
sudo install -m 644 -o root -g root deploy/dum-public.service "/etc/systemd/system/$SERVICE"
sudo systemctl daemon-reload

# Cutover. Both services bind 127.0.0.1:8070, so the old one must be down
# before the new one starts. Only happens once the new code and unit are in
# place above. The old unit stays installed but disabled for manual rollback;
# on repeat deployments we restart the new service to pick up its files.
if systemctl is-enabled --quiet "$OLD_SERVICE" 2>/dev/null || systemctl is-active --quiet "$OLD_SERVICE" 2>/dev/null; then
  sudo systemctl disable --now "$OLD_SERVICE"
fi
if systemctl is-active --quiet "$SERVICE"; then
  sudo systemctl restart "$SERVICE"
else
  sudo systemctl enable --now "$SERVICE"
fi

echo "deployed $INSTALL_ROOT and (re)started $SERVICE; see: journalctl -u ${SERVICE%.service} -n 20"
echo "rollback if startup fails: sudo systemctl disable --now $SERVICE; sudo systemctl enable --now $OLD_SERVICE"
