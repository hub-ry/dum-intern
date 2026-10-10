#!/usr/bin/env bash
# Install the Dum notes service on hub.
#
# Usage (from the repo on hub):   bash deploy/deploy-notes.sh
#
# What it does, and nothing more:
#   * checks that the public server is already installed by deploy/deploy.sh
#     (/opt/dum-public/src/public/server.ts), that /usr/local/bin/node exists,
#     and that the skill-tree service account exists. It installs none of them;
#   * creates /var/lib/dum-notes if missing, owned by UID 1000 and that user's
#     primary group, mode 755 (non-recursive; existing contents are preserved);
#   * installs deploy/dum-notes.service (root, 644), reloads systemd and
#     enables the unit;
#   * starts (or restarts) dum-notes.service ONLY if /var/lib/dum-notes/index.html
#     already exists. Otherwise it reports "installed, not started".
#
# Publication is explicit and manual: nothing here copies source, credentials,
# site content or any placeholder index into /var/lib/dum-notes. Until a real
# index.html is published there, the unit's ConditionPathExists keeps it from
# starting, and this script does not start it either. Rerun after publishing.
#
# Not touched: dum-public.service, the workshop, cloudflared, private env files.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL_ROOT=/opt/dum-public
NOTES_ROOT=/var/lib/dum-notes
SERVICE=dum-notes.service
SERVICE_USER=skill-tree
NODE_BIN=/usr/local/bin/node
PUBLISHER_UID=1000

# Preconditions: this script depends on, but does not perform, the public deploy.
if [ ! -f "$INSTALL_ROOT/src/public/server.ts" ]; then
  echo "missing $INSTALL_ROOT/src/public/server.ts; run deploy/deploy.sh first" >&2
  exit 1
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "missing $NODE_BIN" >&2
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "service user $SERVICE_USER does not exist; run deploy/deploy.sh first" >&2
  exit 1
fi

# Primary group of UID 1000, derived from the passwd database.
PUBLISHER_GID="$(getent passwd "$PUBLISHER_UID" | cut -d: -f4)"
if [ -z "$PUBLISHER_GID" ]; then
  echo "no account with UID $PUBLISHER_UID in passwd" >&2
  exit 1
fi

# Notes root: create or adjust the directory itself only. Contents untouched.
sudo install -d -m 755 -o "$PUBLISHER_UID" -g "$PUBLISHER_GID" "$NOTES_ROOT"

# Unit file, reload, enable. Enabling does not start it.
sudo install -m 644 -o root -g root deploy/dum-notes.service "/etc/systemd/system/$SERVICE"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"

# Deferred startup: only a published index may bring the service up.
if [ -f "$NOTES_ROOT/index.html" ]; then
  if systemctl is-active --quiet "$SERVICE"; then
    sudo systemctl restart "$SERVICE"
  else
    sudo systemctl start "$SERVICE"
  fi
  echo "installed and (re)started $SERVICE; see: journalctl -u ${SERVICE%.service} -n 20"
else
  echo "installed and enabled $SERVICE, not started: $NOTES_ROOT/index.html does not exist"
  echo "restart the configured private workshop to create its notes index, then rerun this script"
fi
