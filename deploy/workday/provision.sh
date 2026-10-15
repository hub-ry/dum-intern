#!/usr/bin/env bash
# Builds (or brings up to date) the `workday` LXD VM on hub. Idempotent; rerun any time.
#   deploy/workday/provision.sh
# 1. LXD init (dir pool `default`, bridge lxdbr0 10.77.0.1/24, no NAT) if LXD is uninitialized.
# 2. hub egress proxy on 10.77.0.1:3128 (--provision during this run, allowlist afterwards).
# 3. hub secrets in ~/.config/dum-workday (worker-token, vnc-password, the approval key pair;
#    created once, never printed) and worker-url, where hub's dum finds the worker.
# 4. VM ubuntu:24.04, 2 vCPU / 3GiB / 20GiB, static 10.77.0.10, no host mounts.
# 5. In the VM: vm/setup.sh (packages, in-VM firewall, Node 24, worker user, data dir, display units).
# 6. push-code.sh (code, npm ci, Playwright Chromium, worker unit).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
vm=workday
ip=10.77.0.10
conf="$HOME/.config/dum-workday"
node=/usr/local/bin/node

echo "== LXD"
has_pool=0; has_net=0
lxc storage show default >/dev/null 2>&1 && has_pool=1
lxc network show lxdbr0 >/dev/null 2>&1 && has_net=1
if [ $has_pool = 0 ] && [ $has_net = 0 ]; then
  lxd init --preseed <"$here/lxd-preseed.yaml"
elif [ $has_pool = 0 ] || [ $has_net = 0 ]; then
  echo "LXD is half-initialized (pool default: $has_pool, lxdbr0: $has_net); fix by hand, see README" >&2
  exit 1
fi
if [ "$(lxc network get lxdbr0 ipv4.address)" != "10.77.0.1/24" ]; then
  echo "lxdbr0 is not 10.77.0.1/24; the proxy, units and firewall assume it" >&2
  exit 1
fi

echo "== egress proxy (provision mode for this run)"
"$here/egress.sh" start --provision
trap '"$here/egress.sh" start' EXIT

echo "== hub secrets in $conf"
install -d -m 0700 "$conf"
if [ ! -e "$conf/worker-token" ]; then
  (umask 077; "$node" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' >"$conf/worker-token")
fi
if [ ! -e "$conf/vnc-password" ]; then
  # VNC authentication only uses 8 characters; 8 base64url chars = 48 random bits.
  (umask 077; "$node" -e 'process.stdout.write(require("crypto").randomBytes(6).toString("base64url"))' >"$conf/vnc-password")
fi
chmod 0600 "$conf/worker-token" "$conf/vnc-password"
# Where hub's dum (MCP tools, the Discord bot, `dum workday ...`) finds the worker.
echo "http://$ip:8790" >"$conf/worker-url"
# The key pair that signs Ryan's Submit approvals: private half stays here, public half goes to the VM.
if [ ! -e "$conf/approval.key" ]; then
  "$node" --import "file://$repo/node_modules/tsx/dist/loader.mjs" "$repo/src/cli.ts" workday keygen
fi

echo "== VM $vm"
if ! lxc info "$vm" >/dev/null 2>&1; then
  lxc init ubuntu:24.04 "$vm" --vm -c limits.cpu=2 -c limits.memory=3GiB -c boot.autostart=true -d root,size=20GiB
  lxc config device override "$vm" eth0 ipv4.address="$ip"
else
  lxc config set "$vm" limits.cpu=2 limits.memory=3GiB boot.autostart=true
fi
if [ "$(lxc info "$vm" | sed -n 's/^Status: //p')" != "RUNNING" ]; then lxc start "$vm"; fi

echo "== waiting for the VM agent"
for i in $(seq 1 90); do
  if lxc exec "$vm" -- true 2>/dev/null; then break; fi
  [ "$i" = 90 ] && { echo "VM agent did not come up in 180s" >&2; exit 1; }
  sleep 2
done
lxc exec "$vm" -- cloud-init status --wait >/dev/null 2>&1 || true

echo "== VM setup"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; "$here/egress.sh" start' EXIT
mkdir -p "$tmp/b/units" "$tmp/b/secrets"
cp "$here"/vm/*.service "$tmp/b/units/"
cp "$here/vm/nftables.conf" "$here/vm/apparmor-chrome" "$here/vm/setup.sh" "$tmp/b/"
cp "$conf/worker-token" "$conf/vnc-password" "$tmp/b/secrets/"
[ -e "$conf/approval.pub" ] && cp "$conf/approval.pub" "$tmp/b/secrets/"
tar -C "$tmp/b" -cf "$tmp/setup.tar" .
lxc file push --quiet --uid 0 --gid 0 --mode 0600 "$tmp/setup.tar" "$vm/root/dum-workday-setup.tar"
lxc exec "$vm" -- sh -c 'set -e; d=/root/dum-workday-setup; rm -rf $d; mkdir -m 0700 $d; tar -xf $d.tar -C $d --no-same-owner; rm -f $d.tar; bash $d/setup.sh $d; rm -rf $d'

echo "== code"
"$here/push-code.sh"

echo "== done"
lxc list "$vm"
echo "worker API: http://$ip:8790   noVNC: http://$ip:6080/vnc.html (password: $conf/vnc-password)"
