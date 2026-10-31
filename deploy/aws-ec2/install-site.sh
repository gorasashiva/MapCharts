#!/usr/bin/env bash
# On the instance: build the chart app from this checkout and put it live in
# /var/www/candl. setup.sh and update.sh call it; run it as the deploy user.
# Dependencies are (re)installed only when package-lock.json changed.
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$script_dir/../.." && pwd)"
www="${CANDL_WWW:-/var/www/candl}"
stamp="$repo/node_modules/.candl-lock-hash"

cd "$repo"
lock_hash="$(shasum -a 256 package-lock.json | cut -d' ' -f1)"
if [[ ! -x node_modules/.bin/vite || "$(cat "$stamp" 2>/dev/null)" != "$lock_hash" ]]; then
  echo "== installing dependencies"
  npm ci --no-audit --no-fund
  echo "$lock_hash" > "$stamp"
fi

echo "== building the chart app"
"$script_dir/build.sh"

# --delay-updates: the new bundle appears all at once, never half-copied
rsync -a --delete --delay-updates --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$script_dir/dist/" "$www/"
echo "Chart app is live in $www"
