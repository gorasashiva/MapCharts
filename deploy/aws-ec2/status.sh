#!/usr/bin/env bash
# Health check on the instance: services, recorder status, disk.
#   ~/candl-platform/deploy/aws-ec2/status.sh
set -uo pipefail

echo "== services"
for s in candl-tape candl-book candl-map nginx; do
  printf '%-12s %s\n' "$s" "$(systemctl is-active "$s")"
done

echo "== recorders"
curl -fsS --max-time 5 http://127.0.0.1:8787/tape/status | head -c 600; echo
curl -fsS --max-time 5 http://127.0.0.1:8789/book/status | head -c 600; echo
curl -fsS --max-time 5 http://127.0.0.1:8788/maplevels/status | head -c 300; echo

echo "== disk"
df -h /var/lib/candl | tail -1
du -sh /var/lib/candl/* 2>/dev/null

echo "== chart site"
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/ || true)"
case "$code" in
  200) echo "nginx serving on port 8080 (no password)" ;;
  401) echo "nginx serving on port 8080 (password on)" ;;
  *) echo "nginx not answering on port 8080 (got '$code')" ;;
esac
# the public address, from the instance metadata service (IMDSv2)
token="$(curl -fsS -X PUT --max-time 2 -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null || true)"
ip="$(curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
[[ -n "$ip" ]] && echo "open from an allowed device: http://$ip:8080"
