# Workday worker VM

The Workday application worker runs in its own LXD virtual machine, `workday`, on hub. If a web page
takes over the browser or the worker, all it can reach is what's inside that VM: the application
profile, the vault, and the Workday login sessions. It can't reach hub's files, hub's services, or
the tailnet.

| | |
|---|---|
| VM | `workday`, ubuntu 24.04, 2 vCPU, 3 GiB RAM, 20 GiB disk, `boot.autostart=true` |
| VM address | `10.77.0.10` on `lxdbr0` (`10.77.0.1/24`, no NAT, no IPv6) |
| Worker API (from hub) | `http://10.77.0.10:8790` (bearer token: `~/.config/dum-workday/worker-token`) |
| noVNC (from hub) | `http://10.77.0.10:6080/vnc.html` (password: `~/.config/dum-workday/vnc-password`) |
| Egress | hub proxy `10.77.0.1:3128`, unit `dum-workday-egress` (user unit on hub) |
| Code in VM | `/opt/dum-workday` (root-owned), Chromium in `/opt/ms-playwright` |
| Data in VM | `/home/worker/workday` (`DUM_WORKDAY_HOME`) |

## How it is isolated

- **No host mounts.** Files go in with `lxc file push`. The VM's devices are its own root disk and one
  NIC: `lxc config show workday --expanded` lists only `root` and `eth0`.
- **No routed internet.** hub's iptables `FORWARD` policy is `DROP` (Docker), and lxdbr0 has no NAT
  and no LXD firewall rules. The VM reaches the web only through `egress-proxy.mjs` on hub, bound to
  `10.77.0.1:3128`. The proxy resolves every destination itself and refuses anything that resolves to
  loopback, private ranges, `100.64.0.0/10` (the tailnet), link-local, multicast, or any of hub's own
  addresses. It then connects to the address it checked. CONNECT is allowed to port 443 only, and
  plain HTTP to port 80 only.
- **Allowlist.** Outside provisioning, the proxy also requires the host to match
  `~/.config/dum-workday/egress-allowlist.txt`. That's Workday, reCAPTCHA, and Ubuntu's archive (see
  `egress-allowlist.txt`, the template that gets copied there once). The worker has its own
  allowlist in `config.json`, and a host has to be on both lists. If you add a company host to
  `config.json` `allow`, also add it to the hub allowlist file. The proxy re-reads the file when
  it changes.
- **Firewall inside the VM** (`vm/nftables.conf`, nftables.service). Outbound traffic can only go to
  `10.77.0.1:3128`, to DNS on `10.77.0.1`, or to DHCP. Inbound traffic is accepted only from
  `10.77.0.1` to ports 6080 and 8790. The worker runs as the unprivileged user `worker` (no sudo),
  so it can't change these rules. hub's own firewall is untouched.
- **Data dir.** `/home/worker/workday` is root-owned and `chattr +i`, so the worker can't
  replace `approval.pub` or `config.json`, and it can't rename the directory.
  - Root-owned, read-only to the worker: `approval.pub`, `config.json`.
  - Worker-owned, mode 0600 (the worker edits them in place): `profile.json`, `vault.json`, `worker-token`.
  - Worker-writable directories: `resume/`, `browser-profile/`, `state/`.

Known gap: hub's INPUT policy is ACCEPT, so the only thing stopping traffic from the VM to hub's
ports on `10.77.0.1` (or to hub's tailnet address, which routes back to hub's INPUT) is the in-VM
firewall. Today the only listeners on all interfaces are sshd and BrowserOS (9000/9001/9200), and
`hub_browseros_guard` drops BrowserOS for anything other than lo/tailscale0. A hub-side rule
dropping `iifname "lxdbr0"` except DHCP, DNS, and `tcp dport 3128` would close the gap even if VM
root were compromised. It isn't installed, because hub firewall changes need Ryan's approval.

## Files

| File | Where it runs | What it does |
|---|---|---|
| `provision.sh` | hub | Everything below, idempotent. Rerun any time. |
| `lxd-preseed.yaml` | hub | `lxd init --preseed` input, used only when LXD has neither pool `default` nor `lxdbr0`. |
| `egress-proxy.mjs` | hub | Dependency-free HTTP/CONNECT proxy (`--listen`, `--allowlist FILE`, `--provision`). |
| `egress.sh` | hub | `start` (allowlist), `start --provision` (any public host), `stop`, `status`. |
| `egress-allowlist.txt` | hub | Default allowlist, copied to `~/.config/dum-workday/egress-allowlist.txt` if that file is missing. |
| `dum-workday-egress.service` | hub | Optional persistent user unit for the proxy. Not installed by default. |
| `push-code.sh` | hub | Pushes code into the VM and restarts the worker. |
| `vm/setup.sh` | VM (root) | apt proxy, packages, firewall, Node 24, `worker` user, data dir, secrets, units. |
| `vm/install-code.sh` | VM (root) | Unpacks code, `npm ci` and Playwright Chromium when the lockfile changed, seeds data files, restarts the worker. |
| `vm/nftables.conf` | VM | The in-VM firewall. |
| `vm/apparmor-chrome` | VM | AppArmor profile granting `userns` to Playwright's Chromium only. Ubuntu 24.04 blocks unprivileged user namespaces otherwise, so this is what makes `chromiumSandbox: true` work. |
| `vm/dum-workday-{xvfb,wm,vnc,novnc}.service` | VM | Xvfb `:1` 1440x900x24, openbox, x11vnc on localhost:5901 (`-rfbauth`), websockify/noVNC on `0.0.0.0:6080`. |
| `vm/dum-workday.service` | VM | The worker: `node --import tsx /opt/dum-workday/src/workday/serve.ts` as `worker`, headed on `:1` with Chromium's sandbox on. It's skipped until `serve.ts` and `approval.pub` both exist. |

Worker unit environment: `DUM_WORKDAY_HOME=/home/worker/workday`,
`DUM_WORKDAY_LISTEN=0.0.0.0:8790`, `DUM_WORKDAY_UPSTREAM_PROXY=http://10.77.0.1:3128`,
`DISPLAY=:1`, `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`. There are deliberately no
`HTTP(S)_PROXY` variables, because the worker chains its own in-process allowlist proxy to
`DUM_WORKDAY_UPSTREAM_PROXY`.

Secrets on hub, in `~/.config/dum-workday/` (dir 0700, files 0600). They're created once and never printed:
- `worker-token`: random hex, also at `/home/worker/workday/worker-token` in the VM.
- `vnc-password`: 8 characters (VNC only uses 8), also at `/home/worker/.config/dum-workday/vnc-password`
  in the VM, and as the x11vnc rfbauth file `/home/worker/.vnc/passwd`.
- `approval.key` / `approval.pub`: the Ed25519 pair that signs your Submit approvals (made by `provision.sh`). Only the public half goes to the VM.
- `worker-url`: `http://10.77.0.10:8790`, read by hub's `dum`.
- `egress-allowlist.txt`: the proxy allowlist.

## Set up (hub, as ryanhubbart, who is in the `lxd` group)

```sh
cd ~/code2/dum-intern-wt/workday      # or wherever the branch with deploy/workday is checked out
deploy/workday/provision.sh
```

The first run downloads the ubuntu:24.04 VM image, apt packages, Node 24, npm packages, and
Playwright Chromium (all through the proxy in `--provision` mode). That takes several minutes. At
the end the proxy switches back to allowlist mode.

`provision.sh` makes the approval key pair once (`dum workday keygen`): `approval.key` stays in
`~/.config/dum-workday/` on hub (only the Discord bot reads it, to sign your Submit), and
`approval.pub` is pushed into the VM. It also writes `~/.config/dum-workday/worker-url`, which is
how `dum mcp`, the Discord bot and `dum workday ...` find the worker.

The proxy runs as a transient user unit, so it doesn't survive a hub reboot. After a reboot, run
`deploy/workday/egress.sh start`. Or install the persistent unit once:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/workday/dum-workday-egress.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now dum-workday-egress
```

(`egress.sh` notices the installed unit and restarts it instead of starting a transient one.)

## What Ryan does himself

1. **Profile and vault.** Edit them in place as `worker` (the data dir is immutable, so edit the files; don't replace them):
   ```sh
   lxc exec workday -- sudo -u worker nano /home/worker/workday/profile.json
   lxc exec workday -- sudo -u worker nano /home/worker/workday/vault.json
   ```
   The vault holds what the agent must never see. Each entry is a value plus a regex the field's
   label must match; the agent writes only the placeholder (`{{SSN}}`) and the worker types the value:
   ```json
   { "SSN": { "value": "your real SSN", "fields": "social security|ssn" },
     "DOB": { "value": "YYYY-MM-DD", "fields": "date of birth|birth date" } }
   ```
   Restart the worker after editing either file: `lxc exec workday -- systemctl restart dum-workday`.
   `profile.json` starts as a copy of `src/workday/profile.example.json` (fake values). Fill it from
   `~/internship/profile.md` and `application-facts.md`: only what you'd paste into a chat; anything
   else goes in the vault. `resumes` maps names to files in `/home/worker/workday/resume/`, with
   `default` required, e.g. `{"default": "hubbart_resume.pdf", "wing": "hubbart_resume_wing.pdf"}`.
   Push the PDFs there:
   ```sh
   for f in hubbart_resume.pdf hubbart_resume_wing.pdf hubbart_resume_chrobinson.pdf; do
     lxc file push --uid "$(lxc exec workday -- id -u worker)" --gid "$(lxc exec workday -- id -g worker)" \
       --mode 0600 ~/internship/resume/$f workday/home/worker/workday/resume/$f
   done
   ```
2. **Extra company hosts** (careers sites outside `*.myworkdayjobs.com` and the like): add each one to
   `config.json` `allow` in the VM (root-owned) and to the hub allowlist:
   ```sh
   lxc exec workday -- sh -c 'chattr -i /home/worker/workday && nano /home/worker/workday/config.json; chattr +i /home/worker/workday'
   nano ~/.config/dum-workday/egress-allowlist.txt
   ```
3. **Log in to each company's Workday** in the worker's own Chromium, through noVNC:
   ```sh
   ssh -L 6080:10.77.0.10:6080 hub         # on the laptop
   ```
   Then open `http://localhost:6080/vnc.html`, connect, and enter the password from
   `~/.config/dum-workday/vnc-password` on hub (`cat` it on hub yourself). Sign in once per company
   tenant. The session lives in `/home/worker/workday/browser-profile/`.

## Update the code

```sh
deploy/workday/push-code.sh          # tracked + untracked non-ignored files, uncommitted edits included
deploy/workday/push-code.sh --deps   # force npm ci + Playwright Chromium reinstall
```

It reruns `npm ci --omit=dev` and the Chromium install only when `package-lock.json` differs from the
installed one. For that it switches the proxy to `--provision` mode and back. Then it restarts
`dum-workday.service`.

To change units, the firewall, or packages, edit the files here and rerun `provision.sh`.

## How an application goes (hub side)

1. In Discord, Ryan gives Dum a Workday link. Dum calls `dum_workday_apply`; hub records a job in
   `~/.local/state/dum/workday/` and starts `dum workday run <job>` on its own.
2. That runs the Workday agent: `claude -p` with no built-in tools and one MCP server,
   `dum workday-mcp`, which forwards `open_application`, `fill_from_profile`, `upload_resume`,
   `screenshot`, `next_step` to the worker over HTTP. Hub never sees vault values; the worker
   redacts every answer.
3. On the review page the agent calls `request_submit`. The worker parks a submit (nonce + page
   fingerprint) and returns a masked screenshot; hub turns it into a Submit card in Discord.
4. Only Ryan's **Submit it** button makes the bot sign an approval with `approval.key` and hand it to
   the worker, which checks it and presses Submit. **Don't submit** signs nothing.
   If the worker was down, `dum workday submit <request-id>` hands the approval over again.

`dum_workday_status` (or `dum status`) shows each job: running, `needs_ryan` (sign in through
noVNC, then ask again), `awaiting_approval`, or failed.

Smoke test against the local fake site (never a real Workday site): `node --import tsx src/workday/smoke.ts`
(scripted) or `--agent` (the real agent).

## Check

```sh
lxc list workday
lxc config show workday --expanded               # devices: root (disk) and eth0 (nic) only
lxc exec workday -- systemctl status dum-workday dum-workday-novnc dum-workday-vnc dum-workday-xvfb
lxc exec workday -- journalctl -u dum-workday -n 50
curl -sI http://10.77.0.10:6080/vnc.html
deploy/workday/egress.sh status                  # journal shows allow/deny per host
journalctl --user -u dum-workday-egress -n 50
```

## Tear down

```sh
lxc delete --force workday
deploy/workday/egress.sh stop
# optional: the LXD network and pool (only if nothing else uses them)
lxc profile device remove default eth0 && lxc network delete lxdbr0
lxc profile device remove default root && lxc storage delete default
# optional: hub secrets
rm -r ~/.config/dum-workday ~/.local/lib/dum-workday
```
