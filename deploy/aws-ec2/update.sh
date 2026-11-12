#!/usr/bin/env bash
# On the instance: bring everything up to date with GitHub in one go.
#
#   ~/candl-platform/deploy/aws-ec2/update.sh
#
# Pulls main, rebuilds and republishes the chart app, re-runs setup when the
# installed services or nginx config differ from the repo's, and otherwise
# restarts the recorders only if their code changed since the last update
# (a restart is a few seconds of gap). Comparing against what is installed,
# not against the pull, means a manual `git pull` beforehand is fine too.
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$script_dir/../.." && pwd)"
deployed_file="$HOME/.candl-deployed-commit"
cd "$repo"

if [[ "${1:-}" != "--pulled" ]]; then
  git pull --ff-only
  # the pull may have changed this very script: run the new version from the top
  exec "$script_dir/update.sh" --pulled
fi
echo "At $(git log -1 --format='%h %s')"

"$script_dir/install-site.sh"

needs_setup=false
cmp -s "$script_dir/nginx-candl.conf" /etc/nginx/conf.d/candl.conf || needs_setup=true
for unit in candl-tape candl-book candl-map; do
  sed -e "s#CANDL_USER#$USER#g" -e "s#CANDL_REPO#$repo#g" "$script_dir/$unit.service" \
    | cmp -s - "/etc/systemd/system/$unit.service" || needs_setup=true
done

# each recorder runs its recorder/*.mjs and the src file it imports; restart only the ones
# whose code changed, so the others keep recording without a gap
deployed="$(cat "$deployed_file" 2>/dev/null || true)"
known=false
if [[ -n "$deployed" ]] && git cat-file -e "$deployed" 2>/dev/null; then known=true; fi
changed_units=()
changed() { ! $known || ! git diff --quiet "$deployed" HEAD -- "$@"; }
changed recorder/tapeRecorder.mjs src/overlays/takerOrders.ts && changed_units+=(candl-tape)
changed recorder/bookRecorder.mjs src/overlays/bookTape.ts recorder/bookHeat.ts src/overlays/domHeatmapModel.ts && changed_units+=(candl-book)
changed recorder/mapRecorder.mjs src/overlays/nyClock.ts && changed_units+=(candl-map)

if $needs_setup; then
  echo "== services or nginx config differ from the repo: re-running setup"
  sudo "$script_dir/setup.sh" "$USER"
elif ((${#changed_units[@]})); then
  echo "== recorder code changed: restarting ${changed_units[*]} (the others keep running)"
  sudo systemctl restart "${changed_units[@]}"
  "$script_dir/status.sh"
else
  echo "Recorders and config unchanged; left running."
  "$script_dir/status.sh"
fi
git rev-parse HEAD > "$deployed_file"
