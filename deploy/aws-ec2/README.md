# AWS EC2: recorders + private chart site

One small, always-on instance records Delta's trade tape, order book and the
GLD option chain around the clock, compresses each finished period on its own
disk, and serves the chart app privately (and publicly later, by removing one
login rule).

Recommended: **t4g.small** (2 vCPU ARM, 2 GB), **Ubuntu 24.04 arm64**, **30 GB
gp3**, region **ap-south-1 (Mumbai)**. About $16–20 a month. The instance keeps
a rolling window; the full history lives on the Mac (see "Everyday").

| Service | What it records | Stored as | Kept |
|---|---|---|---|
| `candl-tape` | every trade (footprint, Big/Deep Trades history), served at `/tape/` | `/var/lib/candl/tape/<SYM>/<day>.ndjson`, gzipped 15 min after the UTC day ends (~7 MB/day for 3 markets) | 180 days (~1.3 GB) |
| `candl-book` | L2 order book + trades for the DOM study / `replay:dom` | `/var/lib/candl/book/<SYM>/<day>/<HH>.ndjson.gz`, gzipped as each hour ends (~200 MB/day) | 60 days (~12 GB) |
| `candl-map` | GLD option chain 08:15 + 16:20 New York, served at `/maplevels/` | `/var/lib/candl/map`, small JSON (~230 KB/day) | 400 days |

The recorders compress and prune by themselves; there is no separate job. The
current day (tape) or hour (book) stays plain text while it is being written,
and the chart reads compressed and plain days alike.

All commands below run **from your Mac in this folder** unless marked *(on the instance)*.

## 1. Security group, key and disk

- Inbound rules: **SSH (22) from My IP only**. Nothing else; the site goes out
  through Cloudflare Tunnel (step 5) or an SSH tunnel, never an open port.
- Disk: 30 GB is enough for the retention above (~19 GB used at steady state).
- Keep the key outside any project folder:

```sh
mv ~/Downloads/<your-key>.pem ~/.ssh/candl-ec2.pem && chmod 400 ~/.ssh/candl-ec2.pem
export CANDL_SSH_KEY=~/.ssh/candl-ec2.pem
export EC2=ubuntu@<instance-public-ip>
ssh -i $CANDL_SSH_KEY $EC2 'uname -m && lsb_release -ds && df -h /'   # aarch64, Ubuntu 24.04, ~30G
```

## 2. Copy the code and install

*(on the instance)* clone from GitHub (deploy key for a private repo: see
[DEPLOYMENT.md](../../DEPLOYMENT.md)), then install:

```sh
git clone git@github.com:gorasashiva/MapCharts.git ~/candl-platform
cd ~/candl-platform && sudo ./deploy/aws-ec2/setup.sh $USER
```

Without GitHub access on the instance, `./deploy/aws-ec2/push-code.sh $EC2`
from the Mac copies the folder instead.

`setup.sh` installs Node 24 and Nginx, starts the three recorders (restarting
on crash and on reboot) and ends with a status report. Re-running it is safe.

## 3. Publish the chart app

```sh
npm ci                                   # once, on the Mac
./deploy/aws-ec2/publish.sh $EC2         # build + upload; repeat after app changes
```

After code changes to the recorders: push to GitHub, then *(on the instance)*
`cd ~/candl-platform && git pull && sudo systemctl restart candl-tape candl-book candl-map`.

## 4. Bring over what your Mac already recorded (optional)

```sh
./deploy/aws-ec2/seed-data.sh $EC2 ~/Desktop/Candl/prodserv
```

Only data from **before** the instance's own first recording is taken, so
nothing is counted twice, and the recorded spans are merged so gaps stay gaps.
Safe to run again. Afterwards you can stop the recorders on the Mac.

## 5. Open the chart privately

**Right away, no setup:** an SSH tunnel, then open http://localhost:8080 on the Mac.

```sh
ssh -i $CANDL_SSH_KEY -N -L 8080:127.0.0.1:8080 $EC2
```

**With your own domain (private now, public at launch):** Cloudflare Tunnel + Access.

1. Add the domain to Cloudflare (or buy it there).
2. Zero Trust → Networks → Tunnels → Create (cloudflared) → copy the install
   command for Debian/arm64 and run it *(on the instance)*.
3. Public hostname: `charts.<your-domain>` → `HTTP` → `localhost:8080`.
4. Zero Trust → Access → Applications → Self-hosted → same hostname → policy
   *Allow*, Include → Emails → your email (add testers' emails any time).
5. **At launch:** delete that Access application. Same URL, now public.

## Everyday

```sh
ssh -i $CANDL_SSH_KEY $EC2 '~/candl-platform/deploy/aws-ec2/status.sh'   # health and disk
ssh -i $CANDL_SSH_KEY $EC2 'journalctl -u candl-book -f'                # live log of one recorder
```

Pull recordings to the Mac at least every few weeks (only new files are
transferred). Never add `--delete`: the instance prunes old days, and the Mac
copy is the one that keeps them. Then replay:

```sh
rsync -az -e "ssh -i $CANDL_SSH_KEY" $EC2:/var/lib/candl/book/ ./book-data/
rsync -az -e "ssh -i $CANDL_SSH_KEY" $EC2:/var/lib/candl/tape/ ./tape-data/
npm run replay:dom -- --symbol XAUTUSD --from 2026-11-01 --to 2026-11-07
```

## Disk and costs

- `status.sh` shows disk use. To keep a longer window on the instance, grow
  the volume and raise `BOOK_RETAIN_DAYS` in `candl-book.service`, then
  re-run `setup.sh`.
- Billing → Budgets → a monthly budget of $25 with an email alert.
- The new AWS free plan's credits expire; upgrade the account to a paid plan
  before then so the instance and its data are kept.
