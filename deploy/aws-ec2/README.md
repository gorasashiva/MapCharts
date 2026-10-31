# AWS EC2: recorders + chart site

One small, always-on instance records Delta's trade tape, order book and the
GLD option chain around the clock, compresses each finished period on its own
disk, and builds and serves the chart app privately (public later, by removing
one login rule). Nothing has to run anywhere else. Quick start:
[DEPLOYMENT.md](../../DEPLOYMENT.md).

Recommended: **t4g.small** (2 vCPU ARM, 2 GB), **Ubuntu 24.04 arm64**, **30 GB
gp3**, region **ap-south-1 (Mumbai)**. About $16–20 a month.

| Service | What it records | Stored as | Kept |
|---|---|---|---|
| `candl-tape` | every trade (footprint, Big/Deep Trades history), served at `/tape/` | `/var/lib/candl/tape/<SYM>/<day>.ndjson`, gzipped 15 min after the UTC day ends (~7 MB/day for 3 markets) | 180 days (~1.3 GB) |
| `candl-book` | L2 order book + trades for the DOM study / `replay:dom` | `/var/lib/candl/book/<SYM>/<day>/<HH>.ndjson.gz`, gzipped as each hour ends (~200 MB/day) | 60 days (~12 GB) |
| `candl-map` | GLD option chain 08:15 + 16:20 New York, served at `/maplevels/` | `/var/lib/candl/map`, small JSON (~230 KB/day) | 400 days |

The recorders compress and prune by themselves; there is no separate job. The
current day (tape) or hour (book) stays plain text while it is being written,
and the chart reads compressed and plain days alike. 30 GB holds all of the
above with room to spare (~19 GB at steady state).

## Scripts

| Script | Where | What it does |
|---|---|---|
| `setup.sh` | instance, `sudo`, once (safe to re-run) | Node 24, Nginx, the three recorder services, then `install-site.sh` and `status.sh` |
| `install-site.sh` | instance | `npm ci` (only when `package-lock.json` changed), build, swap the new bundle into `/var/www/candl` |
| `update.sh` | instance | `git pull`, `install-site.sh`, then restart recorders / re-run setup only if their code or config changed |
| `status.sh` | instance | services, recorder status, disk, site check and its public address |
| `set-password.sh` | instance, `sudo`, optional | username/password in front of the site (`--off` removes it) |
| `seed-data.sh` + `merge-seed.*` | Mac, once, optional | upload older local recordings and merge them without double counting |
| `build.sh` | either | the Vite build of `examples/basic` into `deploy/aws-ec2/dist` |

## Open the chart: testing on the public IP

Nginx listens on port 8080 of every interface; the **security group decides
who gets through**. Add one inbound rule per network you test from: Custom
TCP, port 8080, source `<ip>/32` (each device can look up its IP at
https://checkip.amazonaws.com). Then open `http://<instance-public-ip>:8080`
(`status.sh` prints it). Never open 8080 to `0.0.0.0/0`.

Optional password for devices whose IP keeps changing:
`sudo ./deploy/aws-ec2/set-password.sh <username>` (and `--off` to remove).
It is plain HTTP, so treat it as a testing setup.

## Later: HTTPS URL with a login

**With your own domain (private now, public at launch):** Cloudflare Tunnel + Access.
Point the tunnel at `localhost:8080` and remove the port 8080 rules from the
security group, so the only way in is through Cloudflare.

1. Add the domain to Cloudflare (or buy it there).
2. Zero Trust → Networks → Tunnels → Create (cloudflared) → copy the install
   command for Debian/arm64 and run it on the instance.
3. Public hostname: `charts.<your-domain>` → `HTTP` → `localhost:8080`.
4. Zero Trust → Access → Applications → Self-hosted → same hostname → policy
   *Allow*, Include → Emails → your email (add testers' emails any time).
5. **At launch:** delete that Access application. Same URL, now public.

The tunnel needs no inbound port; once it is in use, the security group can go back to SSH only.

## Everyday

```sh
~/candl-platform/deploy/aws-ec2/status.sh     # health and disk
~/candl-platform/deploy/aws-ec2/update.sh     # after pushing to GitHub
journalctl -u candl-book -f                   # live log of one recorder
```

Replay on the instance: `npm run replay:dom -- --symbol XAUTUSD --from <day> --to <day> --dir /var/lib/candl/book`.

To keep history beyond the rolling window, copy `/var/lib/candl/` off with
`rsync -az` every few weeks, **never with `--delete`** (the instance prunes old
days; the copy is the one that keeps them).

## Costs

- `status.sh` shows disk use. To keep a longer window on the instance, grow
  the volume and raise `BOOK_RETAIN_DAYS` in `candl-book.service`, then
  re-run `setup.sh`.
- Billing → Budgets → a monthly budget of $25 with an email alert.
- The new AWS free plan's credits expire; upgrade the account to a paid plan
  before then so the instance and its data are kept.
