#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo: sudo $0 <deploy-user>" >&2
  exit 1
fi

deploy_user="${1:-${SUDO_USER:-}}"
if [[ -z "$deploy_user" || "$deploy_user" == "root" ]] || ! id "$deploy_user" >/dev/null 2>&1; then
  echo "Pass the non-root SSH login that will publish the chart files." >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot identify this operating system; expected Ubuntu or Oracle Linux 9." >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
case "${ID:-}" in
  ubuntu)
    package_manager=apt
    web_group=www-data
    ;;
  ol|oraclelinux)
    if [[ "${VERSION_ID%%.*}" != "9" ]]; then
      echo "Oracle Linux 9 is supported; found ${PRETTY_NAME:-unknown}." >&2
      exit 1
    fi
    package_manager=dnf
    web_group=nginx
    ;;
  *)
    echo "This setup supports Ubuntu and Oracle Linux 9; found ${PRETTY_NAME:-unknown}." >&2
    exit 1
    ;;
esac

if [[ "$package_manager" == apt ]]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx rsync
else
  dnf install -y nginx rsync policycoreutils
fi

if ! getent group "$web_group" >/dev/null; then
  echo "Expected Nginx worker group '$web_group' was not found after package installation." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install -d -o "$deploy_user" -g "$web_group" -m 0755 /var/www/candl
install -d -o root -g root -m 0755 /etc/nginx/conf.d
install -o root -g root -m 0644 "$script_dir/nginx-candl.conf" /etc/nginx/conf.d/candl.conf

# Preserve, but disable, package-provided sample sites that may listen on every
# interface. The chart site itself only listens on 127.0.0.1 for Tailscale Serve.
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  rm /etc/nginx/sites-enabled/default
fi
if [[ -f /etc/nginx/conf.d/default.conf ]]; then
  disabled_dir=/etc/nginx/candl-disabled
  install -d -o root -g root -m 0755 "$disabled_dir"
  if [[ -e "$disabled_dir/default.conf" ]]; then
    echo "Refusing to overwrite $disabled_dir/default.conf; move it aside, then rerun." >&2
    exit 1
  fi
  mv /etc/nginx/conf.d/default.conf "$disabled_dir/default.conf"
fi

nginx -t
systemctl enable --now nginx
systemctl reload nginx

if command -v restorecon >/dev/null 2>&1; then
  restorecon -RF /var/www/candl
fi

echo "Nginx is serving 127.0.0.1:8080. Configure Tailscale Serve as described in README.md."
