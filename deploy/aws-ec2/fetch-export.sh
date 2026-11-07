#!/usr/bin/env bash
# On the Mac: download an export made by export-data.sh on the instance and
# unzip it under server-data/<tag>/ (tape/, book/, map/ as on the server).
#
#   ./deploy/aws-ec2/fetch-export.sh            # the newest export
#   ./deploy/aws-ec2/fetch-export.sh data-20261107-0930
#
# Signs in with the GitHub CLI (`gh auth login` once) or, without it,
# GITHUB_EXPORT_TOKEN (a token that can read the data repo).
# CANDL_EXPORT_REPO (default gorasashiva/MapCharts) and CANDL_EXPORT_DIR
# (default ~/Desktop/Candl/prodserv/server-data) override the defaults.
set -Eeuo pipefail

REPO="${CANDL_EXPORT_REPO:-gorasashiva/MapCharts}"
ROOT="${CANDL_EXPORT_DIR:-$HOME/Desktop/Candl/prodserv/server-data}"
tag="${1:-}"
[[ -z "$tag" || "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Bad tag: $tag" >&2; exit 1; }

dl="$(mktemp -d)"
trap 'rm -rf "$dl"' EXIT

if command -v gh > /dev/null && gh auth status > /dev/null 2>&1; then
  if [[ -z "$tag" ]]; then tag="$(gh release list -R "$REPO" --limit 1 --json tagName -q '.[0].tagName')"; fi
  [[ -n "$tag" ]] || { echo "No exports in $REPO yet." >&2; exit 1; }
  echo "Downloading $tag from $REPO…"
  gh release download "$tag" -R "$REPO" -D "$dl"
else
  [[ -n "${GITHUB_EXPORT_TOKEN:-}" ]] || { echo "Run 'gh auth login' or set GITHUB_EXPORT_TOKEN." >&2; exit 1; }
  umask 077
  printf 'Authorization: Bearer %s\n' "$GITHUB_EXPORT_TOKEN" > "$dl/.auth"
  umask 022
  api() { curl -fsSL -H @"$dl/.auth" -H 'X-GitHub-Api-Version: 2022-11-28' "$@"; }
  # releases/latest skips pre-releases, so list the newest one instead when no tag is given
  if [[ -n "$tag" ]]; then url="https://api.github.com/repos/$REPO/releases/tags/$tag"; else url="https://api.github.com/repos/$REPO/releases?per_page=1"; fi
  rel="$(api -H 'Accept: application/vnd.github+json' "$url")"
  tag="$(node -e 'let r = JSON.parse(require("fs").readFileSync(0, "utf8")); if (Array.isArray(r)) r = r[0]; if (!r) process.exit(1); console.log(r.tag_name)' <<< "$rel")" \
    || { echo "No exports in $REPO yet." >&2; exit 1; }
  echo "Downloading $tag from $REPO…"
  while IFS=$'\t' read -r id name; do
    [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Skipping odd asset name: $name" >&2; continue; }
    api -H 'Accept: application/octet-stream' -o "$dl/$name" "https://api.github.com/repos/$REPO/releases/assets/$id"
  done < <(node -e 'let r = JSON.parse(require("fs").readFileSync(0, "utf8")); if (Array.isArray(r)) r = r[0]; for (const a of r.assets) console.log(a.id + "\t" + a.name)' <<< "$rel")
fi

shopt -s nullglob
parts=("$dl"/*.zip.part*)
zips=("$dl"/*.zip)
if (( ${#parts[@]} )); then
  cat "${parts[@]}" > "$dl/joined.zip"
  zips=("$dl/joined.zip")
fi
(( ${#zips[@]} )) || { echo "The release $tag has no zip." >&2; exit 1; }

dest="$ROOT/$tag"
mkdir -p "$dest"
for z in "${zips[@]}"; do unzip -q -o "$z" -d "$dest"; done
echo
echo "Unzipped to $dest:"
du -sh "$dest"/* 2> /dev/null || true
echo
echo "Use it:"
echo "  footprint / tape in the chart:  TAPE_DIR=$dest/tape TAPE_PORT=8787 node recorder/tapeRecorder.mjs"
echo "    (stop the dev tape recorder first; this one also keeps recording into that folder)"
echo "  DOM replay (if book was exported): npm run replay:dom -- --dir $dest/book --symbol XAUTUSD --from <YYYY-MM-DD>"
