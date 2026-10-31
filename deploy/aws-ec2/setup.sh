#!/usr/bin/env bash
# One-time setup on an Ubuntu 24.04 EC2 instance (arm64 or x86_64).
#
#   cd ~/candl-platform && sudo ./deploy/aws-ec2/setup.sh "$USER"
#
# Installs Node 24 and Nginx; runs the tape, book and MAP recorders as
# always-on services writing to /var/lib/candl (each compresses finished
# periods itself); serves the chart bundle from /var/www/candl on
# port 8080 (open it to your IPs in the security group), built here from
# this checkout so nothing has to come from another machine.
# Safe to re-run: it rewrites the configs and restarts the services.
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0 <deploy-user>" >&2
  exit 1
fi
deploy_user="${1:-${SUDO_USER:-}}"
if [[ -z "$deploy_user" || "$deploy_user" == "root" ]] || ! id "$deploy_user" >/dev/null 2>&1; then
  echo "Pass the non-root login that owns the code (usually ubuntu)." >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "This script supports Ubuntu (24.04 recommended); found ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$script_dir/../.." && pwd)"

echo "== packages"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg nginx rsync
# The recorders import .ts files directly, which needs Node 22.18+ (24 LTS here).
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
node -v

echo "== data directories"
install -d -o "$deploy_user" -g "$deploy_user" -m 0755 /var/lib/candl /var/lib/candl/tape /var/lib/candl/book /var/lib/candl/map
install -d -o "$deploy_user" -g www-data -m 0755 /var/www/candl

echo "== recorder services"
for unit in candl-tape candl-book candl-map; do
  sed -e "s#CANDL_USER#$deploy_user#g" -e "s#CANDL_REPO#$repo#g" "$script_dir/$unit.service" > "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable candl-tape candl-book candl-map
systemctl restart candl-tape candl-book candl-map

echo "== nginx"
install -d -m 0755 /etc/nginx/candl-auth.d
install -m 0644 "$script_dir/nginx-candl.conf" /etc/nginx/conf.d/candl.conf
if [[ -L /etc/nginx/sites-enabled/default ]]; then rm /etc/nginx/sites-enabled/default; fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "== chart app"
sudo -u "$deploy_user" -H "$script_dir/install-site.sh"

sleep 3
"$script_dir/status.sh" || true
echo
echo "Done. Later updates: ~/candl-platform/deploy/aws-ec2/update.sh (pull, rebuild, restart)."
