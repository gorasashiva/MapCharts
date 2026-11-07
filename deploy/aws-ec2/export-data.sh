#!/usr/bin/env bash
# On the instance: zip the recordings made since a date and upload the zip to
# a PRIVATE GitHub repo as a release, to download on the Mac with
# fetch-export.sh. Nothing is committed to git. A release file can be up to
# 2 GB, so a bigger zip is uploaded in parts.
#
#   ./deploy/aws-ec2/export-data.sh                                  # tape + map since last Monday
#   ./deploy/aws-ec2/export-data.sh --since 2026-11-02 --kinds tape,book,map
#
# Kinds: tape (every trade: footprint, Big/Deep Trades), book (L2 order book,
# ~200 MB a day), map (GLD option chains). Dates are UTC days, inclusive.
#
# Needs, once:
#   A fine-grained GitHub token for the repo (default gorasashiva/MapCharts),
#   permission Contents: Read and write, saved on the instance:
#     sudo install -d -m 755 /etc/candl
#     sudo sh -c 'umask 077; cat > /etc/candl/github-export.token'   # paste, Enter, Ctrl-D
#     sudo chown "$USER" /etc/candl/github-export.token
#   (or GITHUB_EXPORT_TOKEN=... for a single run).
# On a public repo the release files can be downloaded by anyone; the script
# says so before uploading.
set -Eeuo pipefail

DATA=/var/lib/candl
REPO="${CANDL_EXPORT_REPO:-gorasashiva/MapCharts}"
SINCE="$(date -u -d 'last monday' +%F)"
KINDS="tape,map"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2 ;;
    --kinds) KINDS="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "--since must be YYYY-MM-DD" >&2; exit 1; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "--repo must be owner/name" >&2; exit 1; }
for tool in zip curl python3; do
  command -v "$tool" >/dev/null || { echo "Missing $tool: sudo apt-get install -y $tool" >&2; exit 1; }
done

TOKEN="${GITHUB_EXPORT_TOKEN:-}"
if [[ -z "$TOKEN" && -r /etc/candl/github-export.token ]]; then
  TOKEN="$(tr -d '[:space:]' < /etc/candl/github-export.token)"
fi
[[ -n "$TOKEN" ]] || { echo "No GitHub token: see the top of this script." >&2; exit 1; }

work="$(mktemp -d /var/tmp/candl-export.XXXXXX)"
trap 'rm -rf "$work"' EXIT
# The token goes in a header file, not on the command line (where `ps` would show it).
umask 077
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$work/auth"
umask 022
api() {
  curl -fsS -H @"$work/auth" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
}
field() { python3 -c 'import json, sys; v = json.load(sys.stdin); print(v[sys.argv[1]])' "$1"; }

private="$(api "https://api.github.com/repos/$REPO" | field private)" || {
  echo "Cannot read $REPO with this token (does the repo exist, and does the token cover it?)." >&2
  exit 1
}
[[ "$private" == "True" ]] || echo "Note: $REPO is public, so anyone can download this export from its Releases page." >&2

# ----- the file list (paths relative to $DATA) -------------------------------
list="$work/files.txt"
: > "$list"
cd "$DATA"
IFS=',' read -ra kinds <<< "$KINDS"
for kind in "${kinds[@]}"; do
  case "$kind" in
    tape)
      [[ -d tape ]] || continue
      while IFS= read -r f; do
        day="$(basename "$f")"
        day="${day%%.*}"
        if [[ ! "$day" < "$SINCE" ]]; then echo "$f"; fi
      done < <(find tape -mindepth 2 -maxdepth 2 -type f \( -name '*.ndjson' -o -name '*.ndjson.gz' \)) >> "$list"
      find tape -mindepth 2 -maxdepth 2 -type f -name 'sessions.json' >> "$list"
      ;;
    book)
      [[ -d book ]] || continue
      while IFS= read -r d; do
        if [[ ! "$(basename "$d")" < "$SINCE" ]]; then find "$d" -type f; fi
      done < <(find book -mindepth 2 -maxdepth 2 -type d) >> "$list"
      find book -mindepth 2 -maxdepth 2 -type f -name '*.json' >> "$list"
      ;;
    map)
      if [[ -d map ]]; then find map -type f -newermt "$SINCE" >> "$list"; fi
      ;;
    *) echo "Unknown kind: $kind (use tape, book, map)" >&2; exit 1 ;;
  esac
done
count="$(wc -l < "$list" | tr -d ' ')"
[[ "$count" -gt 0 ]] || { echo "Nothing recorded since $SINCE for: $KINDS" >&2; exit 1; }

# ----- zip (already-gzipped files are stored as they are) --------------------
stamp="$(date -u +%Y%m%d-%H%M)"
name="candl-data-$SINCE-to-$(date -u +%F)"
echo "Zipping $count files ($KINDS since $SINCE)…"
# Today's file is still being written; its last line may be cut off, which the readers skip.
zip -q -n .gz -@ "$work/$name.zip" < "$list"
size="$(stat -c %s "$work/$name.zip")"
if (( size > 1900 * 1024 * 1024 )); then
  split -b 1900M -d -a 2 "$work/$name.zip" "$work/$name.zip.part"
  rm "$work/$name.zip"
fi

# ----- release + upload ------------------------------------------------------
tag="data-$stamp"
summary="$(cut -d/ -f1,2 "$list" | sort | uniq -c | awk '{ printf "- %s: %s files\n", $2, $1 }')"
payload="$(python3 -c 'import json, sys; print(json.dumps({"tag_name": sys.argv[1], "name": sys.argv[2], "body": sys.argv[3], "prerelease": True}))' \
  "$tag" "$name" "Recordings since $SINCE (UTC), kinds: $KINDS, from $(hostname).

$summary")"
rid="$(api -X POST "https://api.github.com/repos/$REPO/releases" -d "$payload" | field id)"
for part in "$work/$name".zip*; do
  echo "Uploading $(basename "$part") ($(du -h "$part" | cut -f1))…"
  api -X POST -H 'Content-Type: application/zip' --data-binary @"$part" \
    "https://uploads.github.com/repos/$REPO/releases/$rid/assets?name=$(basename "$part")" > /dev/null
done
echo
echo "Done: https://github.com/$REPO/releases/tag/$tag"
echo "On the Mac:  ./deploy/aws-ec2/fetch-export.sh $tag"
