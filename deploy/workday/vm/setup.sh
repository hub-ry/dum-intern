#!/usr/bin/env bash
# Runs as root INSIDE the workday VM (provision.sh pushes it with its bundle and runs it).
# Idempotent. Bundle layout in $bundle: units/*.service, nftables.conf, secrets/{worker-token,
# vnc-password,approval.pub (optional)}.
set -euo pipefail

bundle=${1:?usage: setup.sh BUNDLE_DIR}
proxy=http://10.77.0.1:3128
export http_proxy=$proxy https_proxy=$proxy HTTP_PROXY=$proxy HTTPS_PROXY=$proxy
export no_proxy=localhost,127.0.0.1 NO_PROXY=localhost,127.0.0.1
export DEBIAN_FRONTEND=noninteractive
home=/home/worker/workday

echo "== apt proxy + packages"
cat >/etc/apt/apt.conf.d/95dum-workday-proxy <<EOF
Acquire::http::Proxy "$proxy";
Acquire::https::Proxy "$proxy";
EOF
apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl xz-utils nftables e2fsprogs \
  xvfb xauth openbox x11vnc novnc websockify \
  fonts-liberation fonts-noto-color-emoji fonts-dejavu-core

echo "== firewall (in-VM nftables)"
install -m 0644 "$bundle/nftables.conf" /etc/nftables.conf
nft -c -f /etc/nftables.conf
systemctl enable --now nftables.service
systemctl restart nftables.service

echo "== AppArmor profile so Playwright's Chromium can use its user-namespace sandbox"
# Ubuntu 24.04 blocks unprivileged user namespaces unless a profile grants `userns` (Chromium's
# recommended fix; see chromium docs/security/apparmor-userns-restrictions.md). Unconfined otherwise.
install -m 0644 "$bundle/apparmor-chrome" /etc/apparmor.d/dum-workday-chrome
apparmor_parser -r /etc/apparmor.d/dum-workday-chrome

echo "== Node 24"
if ! /usr/local/bin/node --version 2>/dev/null | grep -q '^v24\.'; then
  base=https://nodejs.org/dist/latest-v24.x
  tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -o 'node-v24\.[0-9.]*-linux-x64\.tar\.xz' "$tmp/SHASUMS256.txt" | head -n1)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs --strip-components=1 --no-same-owner
  for b in node npm npx corepack; do ln -sfn "/usr/local/lib/nodejs/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
fi
/usr/local/bin/node --version

echo "== worker user and DUM_WORKDAY_HOME"
id worker >/dev/null 2>&1 || useradd --create-home --shell /bin/bash worker
for g in sudo adm lxd; do gpasswd -d worker "$g" >/dev/null 2>&1 || true; done
rm -f /etc/sudoers.d/worker
[ -d "$home" ] && chattr -i "$home"
install -d -o root -g root -m 0755 "$home"
for d in resume browser-profile state; do install -d -o worker -g worker -m 0700 "$home/$d"; done
install -d -o worker -g worker -m 0700 /home/worker/.vnc /home/worker/.config /home/worker/.config/dum-workday
install -d -o root -g root -m 0755 /opt/ms-playwright

echo "== secrets"
install -o worker -g worker -m 0600 "$bundle/secrets/worker-token" "$home/worker-token"
install -o worker -g worker -m 0600 "$bundle/secrets/vnc-password" /home/worker/.config/dum-workday/vnc-password
if [ -e "$bundle/secrets/approval.pub" ]; then
  install -o root -g root -m 0644 "$bundle/secrets/approval.pub" "$home/approval.pub"
else
  echo "approval.pub not on hub yet; rerun provision.sh after it exists"
fi
# x11vnc rfbauth file (VNC auth uses the first 8 characters).
runuser -u worker -- sh -c 'x11vnc -storepasswd "$(cat /home/worker/.config/dum-workday/vnc-password)" /home/worker/.vnc/passwd' >/dev/null 2>&1
chmod 0600 /home/worker/.vnc/passwd
chattr +i "$home"

echo "== units"
install -m 0644 "$bundle"/units/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable dum-workday-xvfb.service dum-workday-wm.service dum-workday-vnc.service dum-workday-novnc.service dum-workday.service
systemctl restart dum-workday-xvfb.service
systemctl restart dum-workday-wm.service dum-workday-vnc.service dum-workday-novnc.service
echo "setup done"
