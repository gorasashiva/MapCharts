#!/usr/bin/env bash
#
# Assemble the deployable static bundle: the landing page, with the charting
# app under charts/.
#
#   dist-site/
#     index.html          <- site/index.html (landing page)
#     charts/
#       index.html        <- the app
#       assets/index-*.js
#
# Upload the CONTENTS of dist-site/ to wherever the site is served from. There
# is no server side: the landing page and the app both call Delta Exchange
# India's public API directly from the visitor's browser.
#
# ---------------------------------------------------------------------------
# SITE_ROOT — the one setting you may need to change.
#
# It is the public URL path the bundle will be served from, and it must match
# reality, because Vite bakes an ABSOLUTE path to the app's JS into charts/
# index.html. Get it wrong and the landing page loads but the app is a blank
# screen with a 404 for its bundle.
#
#   served at https://example.com/              -> SITE_ROOT=/          (default)
#   served at https://example.com/trade/        -> SITE_ROOT=/trade/
#   GitHub Pages project site (repo "CandlV2")  -> SITE_ROOT=/CandlV2/
#   GitHub Pages user site / custom domain root -> SITE_ROOT=/
#
# The layout of dist-site/ never changes — only the baked-in URL does.
# ---------------------------------------------------------------------------
#
# Usage:  ./site/build.sh
#         SITE_ROOT=/CandlV2/ ./site/build.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

SITE_ROOT="${SITE_ROOT:-/}"

# Normalise: must start and end with exactly one "/", so joining is predictable.
[[ "$SITE_ROOT" == /* ]] || SITE_ROOT="/$SITE_ROOT"
[[ "$SITE_ROOT" == */ ]] || SITE_ROOT="$SITE_ROOT/"

# Where the APP ends up publicly. The landing page links to it relatively
# ("charts/"), so it follows the bundle wherever it is mounted; only the app's
# own asset URLs need the absolute prefix.
APP_BASE="${SITE_ROOT}charts/"

OUT="dist-site"

echo "→ site root : $SITE_ROOT"
echo "→ app base  : $APP_BASE"
echo "→ cleaning $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/charts"

echo "→ building app"
npx vite build examples/basic --base="$APP_BASE" --outDir "$(pwd)/$OUT/charts" --emptyOutDir

echo "→ copying landing page"
cp site/index.html "$OUT/index.html"

# Apache/LiteSpeed hosts (Hostinger, cPanel, most shared hosting) read this.
# Harmless everywhere else — Netlify, Vercel, Cloudflare and GitHub Pages
# ignore it and apply their own equivalents.
#
# Deliberately NOT here: an HTTPS redirect. Shared hosts terminate TLS at a
# proxy, so a naive rewrite can loop; use the host's own "Force HTTPS" switch.
echo "→ writing .htaccess"
cat > "$OUT/.htaccess" <<'HTACCESS'
# ---------------------------------------------------------------------------
# Static hosting rules for the Power Charts bundle.
# ---------------------------------------------------------------------------

# The app's JS filename contains a content hash (index-<hash>.js), so a given
# URL's bytes never change — cache it hard. The HTML that points at it must
# NOT be cached, or visitors keep loading the old bundle after a redeploy.
<IfModule mod_expires.c>
  ExpiresActive On
  <FilesMatch "\.(js|css|woff2?|svg|png|jpg|jpeg|gif|ico)$">
    ExpiresDefault "access plus 1 year"
  </FilesMatch>
</IfModule>

<IfModule mod_headers.c>
  <FilesMatch "\.(js|css|woff2?)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\.html$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
</IfModule>

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/plain \
    application/javascript application/json image/svg+xml
</IfModule>

# Don't serve a directory listing if an index file is ever missing.
Options -Indexes
HTACCESS

# A zip is the practical way onto shared hosting: hPanel/cPanel File Manager
# uploads one archive far faster than several files, and extracting it keeps
# the .htaccess (which those UIs hide by default and are easy to miss).
# Zipped from INSIDE the folder, so extracting yields index.html + charts/
# directly in the target directory, not a nested dist-site/ wrapper.
if command -v zip >/dev/null 2>&1; then
  echo "→ packaging $OUT.zip"
  rm -f "$OUT.zip"
  (cd "$OUT" && zip -q -r "../$OUT.zip" . -x '.DS_Store')
fi

echo
echo "✓ $OUT ready — upload its CONTENTS to ${SITE_ROOT}"
[ -f "$OUT.zip" ] && echo "  upload archive : $OUT.zip  (extract it in the target folder)"
echo "  landing page : ${SITE_ROOT}"
echo "  app          : ${APP_BASE}"
echo
if [ "$SITE_ROOT" = "/" ]; then
  echo "  preview: npm run preview:site"
else
  echo "  note: previewing locally at http://localhost:8000/ will 404 the app's"
  echo "        bundle, because it is built for ${APP_BASE}. That is expected —"
  echo "        to preview, rebuild with the default SITE_ROOT=/."
fi
