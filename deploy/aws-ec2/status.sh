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
curl -fsS -o /dev/null -w 'http://127.0.0.1:8080/ -> %{http_code}\n' --max-time 5 http://127.0.0.1:8080/ || echo "nginx not answering on 127.0.0.1:8080"
