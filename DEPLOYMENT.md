# Deployment

The platform runs on one always-on AWS EC2 instance and needs nothing else
running: three recorders (trade tape, order book, GLD option chain) write to
its disk, and Nginx serves the chart app, which the instance builds itself from
this repository. The browser gets recorded history from the instance and live
prices straight from Delta. Your Mac is only for writing code and `git push`.
Full details: [deploy/aws-ec2/README.md](deploy/aws-ec2/README.md).

Instance: **t4g.small**, **Ubuntu 24.04 arm64**, **30 GB gp3**, **ap-south-1
(Mumbai)**. Security group: **SSH (22) from your IP**, plus port 8080 from
the IPs you test from (below). Nothing open to everyone.

## First-time setup (all on the instance)

```sh
ssh -i ~/.ssh/candl-ec2.pem ubuntu@<instance-ip>

# Private repo only: a read-only key for this one repo
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
#   → GitHub → MapCharts → Settings → Deploy keys → Add key (write access off)
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n' >> ~/.ssh/config

git clone git@github.com:gorasashiva/MapCharts.git ~/candl-platform
# public repo: git clone https://github.com/gorasashiva/MapCharts.git ~/candl-platform
cd ~/candl-platform && sudo ./deploy/aws-ec2/setup.sh $USER
```

`setup.sh` installs Node 24 and Nginx, starts the three recorders (restarting
on crash and reboot), builds the chart app and puts it live, then prints a
status report: all three recorders should be `active`.

## Open the chart (testing: your IPs only)

The site answers on **http://&lt;instance-public-ip&gt;:8080** (`status.sh` prints
the exact address), but only to the IPs you allow in the security group:

1. On the device you want to use, open https://checkip.amazonaws.com in its
   browser and note the IP it shows.
2. AWS console → EC2 → the instance → Security → the security group → Edit
   inbound rules → Add rule: **Custom TCP, port 8080, Source: Custom,
   `<that-ip>/32`**, description e.g. "home wifi". Save.
3. Open http://&lt;instance-public-ip&gt;:8080 on that device.

Devices on the same Wi-Fi share one IP, so one rule covers them all. For
another network (office, a friend's Wi-Fi) add its IP the same way. Never use
`0.0.0.0/0` (anyone).

**Phones on mobile data** change IP often. For those, turn on a password
(on the instance), then allow the phone's current IP as above:

```sh
sudo ~/candl-platform/deploy/aws-ec2/set-password.sh <username>   # --off removes it
```

This is plain HTTP, for testing. For an HTTPS URL with an email login that
works from anywhere (and turns public at launch), see
[Cloudflare Tunnel + Access](deploy/aws-ec2/README.md#later-https-url-with-a-login).

## Updating

Push to GitHub, then on the instance:

```sh
~/candl-platform/deploy/aws-ec2/update.sh
```

It pulls, rebuilds and republishes the app, restarts the recorders only if
their code changed, and re-runs setup if a service or Nginx config changed.
Health check any time: `~/candl-platform/deploy/aws-ec2/status.sh`.

## Analysing the data

Replay the recorded order book on the instance itself, no download needed:

```sh
cd ~/candl-platform
npm run replay:dom -- --symbol XAUTUSD --from 2026-11-01 --to 2026-11-07 --dir /var/lib/candl/book
```

The instance keeps a rolling window (order book 60 days, trade tape 180 days)
and deletes older days by itself. To keep the full history, copy it off at
least every few weeks; **never add `--delete`**:

```sh
rsync -az -e "ssh -i ~/.ssh/candl-ec2.pem" ubuntu@<instance-ip>:/var/lib/candl/ ./candl-data/
```

## One-time: bring over older Mac recordings (optional)

If the Mac recorded before the instance existed, upload that once:

```sh
CANDL_SSH_KEY=~/.ssh/candl-ec2.pem ./deploy/aws-ec2/seed-data.sh ubuntu@<instance-ip> <folder holding tape-data/ book-data/ map-data/>
```

Only data from before the instance's own first recording is taken, so nothing
is counted twice. Afterwards the Mac recorders can stay off.
