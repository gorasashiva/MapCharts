#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 1 || "$1" == -* ]]; then
  echo "Usage: $0 <ssh-user@tailscale-host>" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dist="$script_dir/dist"
remote="$1"

if [[ ! -s "$dist/index.html" ]]; then
  echo "No production bundle found. Run deploy/oracle-cloud/build.sh first." >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required on this computer and on the Oracle VM." >&2
  exit 1
fi

ssh "$remote" 'test -d /var/www/candl && test -w /var/www/candl' || {
  echo "Cannot write to /var/www/candl on $remote; run install.sh on the VM first." >&2
  exit 1
}

rsync -az --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$dist/" "$remote:/var/www/candl/"
echo "Published chart bundle to $remote."
