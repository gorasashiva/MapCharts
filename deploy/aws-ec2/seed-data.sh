#!/usr/bin/env bash
# From your Mac: upload what your local recorders have collected so the
# instance's history starts from your first recording, not from today.
# Files the instance already has are kept; recorded spans (sessions.json) are
# merged, so gaps stay marked as gaps.
#
#   CANDL_SSH_KEY=~/.ssh/candl-ec2.pem ./deploy/aws-ec2/seed-data.sh ubuntu@<instance-ip> ~/Desktop/Candl/prodserv
set -Eeuo pipefail

if [[ "$#" -ne 2 || "$1" == -* ]]; then
  echo "Usage: CANDL_SSH_KEY=<key.pem> $0 <user@host> <folder holding tape-data/ book-data/ map-data/>" >&2
  exit 1
fi
remote="$1"
src="$2"
ssh_cmd=(ssh)
[[ -n "${CANDL_SSH_KEY:-}" ]] && ssh_cmd+=(-i "$CANDL_SSH_KEY")

"${ssh_cmd[@]}" "$remote" 'mkdir -p ~/candl-seed'
for kind in tape book map; do
  if [[ -d "$src/$kind-data" ]]; then
    echo "Uploading $kind-data ($(du -sh "$src/$kind-data" | cut -f1))…"
    rsync -az -e "${ssh_cmd[*]}" --exclude '*.log' "$src/$kind-data/" "$remote:candl-seed/$kind/"
  fi
done
"${ssh_cmd[@]}" "$remote" 'sudo ~/candl-platform/deploy/aws-ec2/merge-seed.sh ~/candl-seed'
