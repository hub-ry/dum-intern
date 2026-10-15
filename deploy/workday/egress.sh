#!/usr/bin/env bash
# Runs hub's egress proxy for the workday VM as a user unit.
#   egress.sh start              allowlist mode (unit dum-workday-egress)
#   egress.sh start --provision  any public host (unit dum-workday-egress-provision), for apt/npm/downloads
#   egress.sh stop | status
# If dum-workday-egress.service is installed in ~/.config/systemd/user it is (re)started instead of
# a transient unit. Either way the proxy refuses private, tailnet and hub addresses.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
node=/usr/local/bin/node
lib="$HOME/.local/lib/dum-workday"
conf="$HOME/.config/dum-workday"
listen=10.77.0.1:3128
steady=dum-workday-egress
prov=dum-workday-egress-provision

install_files() {
  install -d -m 0755 "$lib"
  install -d -m 0700 "$conf"
  install -m 0644 "$here/egress-proxy.mjs" "$lib/egress-proxy.mjs"
  [ -e "$conf/egress-allowlist.txt" ] || install -m 0600 "$here/egress-allowlist.txt" "$conf/egress-allowlist.txt"
}

installed() { [ -e "$HOME/.config/systemd/user/$steady.service" ]; }

stop_unit() {
  systemctl --user stop "$1.service" 2>/dev/null || true
  systemctl --user reset-failed "$1.service" 2>/dev/null || true
}

wait_listening() {
  for _ in $(seq 1 50); do
    if (exec 3<>"/dev/tcp/${listen%:*}/${listen#*:}") 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  echo "egress proxy did not start listening on $listen" >&2
  systemctl --user status "$1.service" --no-pager >&2 || true
  return 1
}

case "${1:-}" in
  start)
    install_files
    if [ "${2:-}" = "--provision" ]; then
      stop_unit "$steady"
      stop_unit "$prov"
      systemd-run --user --quiet --unit="$prov" --property=Restart=on-failure \
        "$node" "$lib/egress-proxy.mjs" --listen "$listen" --provision
      wait_listening "$prov"
    else
      stop_unit "$prov"
      if installed; then
        systemctl --user restart "$steady.service"
      else
        stop_unit "$steady"
        systemd-run --user --quiet --unit="$steady" --property=Restart=always --property=RestartSec=5 \
          "$node" "$lib/egress-proxy.mjs" --listen "$listen" --allowlist "$conf/egress-allowlist.txt"
      fi
      wait_listening "$steady"
    fi
    ;;
  stop)
    stop_unit "$prov"
    stop_unit "$steady"
    ;;
  status)
    systemctl --user --no-pager status "$steady.service" "$prov.service" || true
    ;;
  *)
    echo "usage: $0 start [--provision] | stop | status" >&2
    exit 2
    ;;
esac
