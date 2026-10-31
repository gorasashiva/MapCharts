#!/usr/bin/env bash
# From your Mac: build the chart app and upload it to the instance's
# /var/www/candl. No restart needed; the next page load picks it up.
#
#   CANDL_SSH_KEY=~/.ssh/candl-ec2.pem ./deploy/aws-ec2/publish.sh ubuntu@<instance-ip>
set -Eeuo pipefail

if [[ "$#" -ne 1 || "$1" == -* ]]; then
  echo "Usage: CANDL_SSH_KEY=<key.pem> $0 <user@host>" >&2
  exit 1
fi
remote="$1"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ssh_cmd=(ssh)
[[ -n "${CANDL_SSH_KEY:-}" ]] && ssh_cmd+=(-i "$CANDL_SSH_KEY")

"$repo/deploy/aws-ec2/build.sh"
dist="$repo/deploy/aws-ec2/dist"

rsync -az --delete -e "${ssh_cmd[*]}" --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$dist/" "$remote:/var/www/candl/"
echo "Published the chart app to $remote:/var/www/candl"
