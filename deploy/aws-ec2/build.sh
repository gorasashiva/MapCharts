#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
vite="$repo_root/node_modules/.bin/vite"

if [[ ! -x "$vite" ]]; then
  echo "Vite is not installed. From the repository root, run: npm ci" >&2
  exit 1
fi

"$vite" build "$repo_root/examples/basic" \
  --config "$repo_root/examples/basic/vite.config.ts" \
  --outDir "$script_dir/dist" \
  --emptyOutDir

if [[ ! -s "$script_dir/dist/index.html" ]]; then
  echo "Build completed without producing deploy/aws-ec2/dist/index.html." >&2
  exit 1
fi
