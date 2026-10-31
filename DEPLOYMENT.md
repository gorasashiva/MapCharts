# Deployment

The platform runs on one always-on AWS EC2 instance: three recorders (trade
tape, order book, GLD option chain) plus Nginx serving the chart app privately.
Scripts and full details: [deploy/aws-ec2/README.md](deploy/aws-ec2/README.md).

Instance: **t4g.small**, **Ubuntu 24.04 arm64**, **30 GB gp3**, **ap-south-1
(Mumbai)**. Security group: **SSH (22) from your IP only**, nothing else.

## First-time setup

**1. On the instance:** clone and install.

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

The setup ends with a status report; all three recorders should be `active`.

**2. On the Mac:** publish the chart app and upload earlier local recordings.

```sh
export CANDL_SSH_KEY=~/.ssh/candl-ec2.pem EC2=ubuntu@<instance-ip>
npm ci
./deploy/aws-ec2/publish.sh $EC2
./deploy/aws-ec2/seed-data.sh $EC2 <folder holding tape-data/ book-data/ map-data/>
```

**3. Open it privately:** keep this running, then browse to http://localhost:8080.

```sh
ssh -i $CANDL_SSH_KEY -N -L 8080:127.0.0.1:8080 $EC2
```

Once the instance is recording, stop any recorders running on the Mac.

## Updating

| What changed | Do this |
|---|---|
| Recorder code | push to GitHub, then on the instance: `cd ~/candl-platform && git pull && sudo systemctl restart candl-tape candl-book candl-map` |
| Chart app | from the Mac: `./deploy/aws-ec2/publish.sh $EC2` |
| Health check | `ssh -i $CANDL_SSH_KEY $EC2 '~/candl-platform/deploy/aws-ec2/status.sh'` |

## Keeping the data

The instance keeps a rolling window (order book 60 days, trade tape 180 days)
and deletes older days by itself. Copy recordings to the Mac at least every
few weeks; **never add `--delete`**, the Mac copy is the full history.

```sh
rsync -az -e "ssh -i $CANDL_SSH_KEY" $EC2:/var/lib/candl/book/ ./book-data/
rsync -az -e "ssh -i $CANDL_SSH_KEY" $EC2:/var/lib/candl/tape/ ./tape-data/
rsync -az -e "ssh -i $CANDL_SSH_KEY" $EC2:/var/lib/candl/map/  ./map-data/
```

## Going public

Put Cloudflare Tunnel + Access in front (private login now, removed at launch;
same URL). Steps in [deploy/aws-ec2/README.md](deploy/aws-ec2/README.md#5-open-the-chart-privately).
