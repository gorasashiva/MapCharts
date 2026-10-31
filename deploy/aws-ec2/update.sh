#!/usr/bin/env bash
# On the instance: bring everything up to date with GitHub in one go.
#
#   ~/candl-platform/deploy/aws-ec2/update.sh
#
# Pulls main, rebuilds and republishes the chart app, and restarts the
# recorders only if their code changed (a restart is a few seconds of gap).
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo"

before="$(git rev-parse HEAD)"
git pull --ff-only
after="$(git rev-parse HEAD)"
if [[ "$before" == "$after" ]]; then
  echo "Already up to date ($(git log -1 --format='%h %s'))."
else
  git log --oneline "$before..$after"
fi

"$script_dir/install-site.sh"

changed() { ! git diff --quiet "$before" "$after" -- "$@"; }
if changed deploy/aws-ec2/setup.sh 'deploy/aws-ec2/*.service' deploy/aws-ec2/nginx-candl.conf; then
  echo "== services or nginx config changed: re-running setup"
  sudo "$script_dir/setup.sh" "$USER"
elif changed recorder src/overlays/takerOrders.ts src/overlays/bookTape.ts; then
  # recorders run recorder/*.mjs and the two src files they import
  echo "== recorder code changed: restarting recorders"
  sudo systemctl restart candl-tape candl-book candl-map
  "$script_dir/status.sh"
else
  echo "Recorders unchanged; left running."
fi
