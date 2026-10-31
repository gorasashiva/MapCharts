#!/usr/bin/env bash
# On the instance (seed-data.sh calls it): merge uploaded recordings from
# <seed>/{tape,book,map} into /var/lib/candl (rules in merge-seed.mjs).
# Recorders are stopped meanwhile because they keep sessions.json in memory
# and would overwrite the merge.
set -Eeuo pipefail

seed="${1:?usage: merge-seed.sh <seed-dir>}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
owner="$(stat -c %U /var/lib/candl)"

systemctl stop candl-tape candl-book candl-map
trap 'systemctl start candl-tape candl-book candl-map; echo "Recorders restarted."' EXIT

node "$script_dir/merge-seed.mjs" "$seed" /var/lib/candl
chown -R "$owner:$owner" /var/lib/candl
