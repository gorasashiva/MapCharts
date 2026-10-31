#!/usr/bin/env bash
# From your Mac: copy this project to the instance (~/candl-platform) and
# restart the recorders so they run the new code. Recorded data is untouched.
#
#   CANDL_SSH_KEY=~/.ssh/candl-ec2.pem ./deploy/aws-ec2/push-code.sh ubuntu@<instance-ip>
set -Eeuo pipefail

if [[ "$#" -ne 1 || "$1" == -* ]]; then
  echo "Usage: CANDL_SSH_KEY=<key.pem> $0 <user@host>" >&2
  exit 1
fi
remote="$1"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ssh_cmd=(ssh)
[[ -n "${CANDL_SSH_KEY:-}" ]] && ssh_cmd+=(-i "$CANDL_SSH_KEY")

rsync -az --delete -e "${ssh_cmd[*]}" \
  --exclude node_modules --exclude dist --exclude dist-site --exclude .git \
  --exclude tape-data --exclude book-data --exclude map-data --exclude replay-out \
  --exclude '*.pem' --exclude '.env*' --exclude .DS_Store \
  "$repo/" "$remote:candl-platform/"
echo "Code copied to $remote:~/candl-platform"

# First push: setup.sh hasn't run yet, so there's nothing to restart.
"${ssh_cmd[@]}" "$remote" 'if systemctl is-enabled --quiet candl-tape 2>/dev/null; then sudo systemctl restart candl-tape candl-book candl-map && echo "Recorders restarted."; else echo "Recorders not installed yet: on the instance run  cd ~/candl-platform && sudo ./deploy/aws-ec2/setup.sh \$USER"; fi'
