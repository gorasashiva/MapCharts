#!/usr/bin/env bash
# On the instance: put a username/password in front of the chart site, for
# devices whose IP keeps changing (phones on mobile data). Every browser then
# shows a login prompt once and remembers it.
#
#   sudo ./deploy/aws-ec2/set-password.sh <username>    # asks for the password
#   sudo ./deploy/aws-ec2/set-password.sh --off         # remove the password
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi
conf=/etc/nginx/candl-auth.d/password.conf
users=/etc/nginx/candl.htpasswd
install -d -m 0755 /etc/nginx/candl-auth.d

if [[ "${1:-}" == "--off" ]]; then
  rm -f "$conf"
  nginx -t && systemctl reload nginx
  echo "Password removed; access is controlled by the security group only."
  exit 0
fi

user="${1:?usage: set-password.sh <username> | --off}"
read -r -s -p "Password for $user: " pass; echo
read -r -s -p "Again: " again; echo
if [[ -z "$pass" || "$pass" != "$again" ]]; then
  echo "Passwords empty or different; nothing changed." >&2
  exit 1
fi
printf '%s:%s\n' "$user" "$(printf '%s' "$pass" | openssl passwd -apr1 -stdin)" > "$users"
chown root:www-data "$users"
chmod 0640 "$users"
cat > "$conf" <<EOF
auth_basic "Candl";
auth_basic_user_file $users;
EOF
nginx -t && systemctl reload nginx
echo "Password on for user '$user'. Plain HTTP sends it unencrypted: use it for testing only."
