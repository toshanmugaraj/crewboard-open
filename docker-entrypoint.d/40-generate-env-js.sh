#!/bin/sh
# Templates /usr/share/nginx/html/env.js from PLAUSIBLE_API_HOST/
# PLAUSIBLE_DOMAIN/MAP_TILE_URL/MAP_TILE_ATTRIBUTION container env vars at
# CONTAINER STARTUP, not image build time — this is what makes them
# configurable via docker-compose's .env file without rebuilding/re-tagging
# the frontend image. See CHANGES.md (2026-08-06) and analytics.js for the
# rest of this feature; MAP_TILE_URL/MAP_TILE_ATTRIBUTION follow the same
# pattern for a self-hosted map tile server — see MapBoard.jsx's TILES.
# Left unset, MapBoard.jsx falls back to public OpenStreetMap tiles, so
# crewboard-open's own default container config stays OSS-appropriate.
#
# Dropped into /docker-entrypoint.d/ rather than overriding the base
# nginxinc/nginx-unprivileged image's own ENTRYPOINT: that image already
# runs every executable script in this directory (alphabetically, hence the
# "40-" prefix — Docker's own official nginx entrypoint uses this same
# mechanism for its optional envsubst-on-templates feature, numbered
# "20-") before finally exec-ing nginx itself. Piggybacking on that means
# nginx.conf/`docker run <image>` behavior (signal handling, foreground
# process, etc.) is untouched.
#
# Deliberately only ever writes room-id/user-id-adjacent CONFIG here
# (a Plausible host + site domain, and now a map tile server) — never
# anything about an actual request/user. See analytics.js's header comment
# for what the resulting window.__CREWBOARD_ENV__ is and isn't allowed to
# be used for.
set -eu

: "${PLAUSIBLE_API_HOST:=}"
: "${PLAUSIBLE_DOMAIN:=}"
: "${MAP_TILE_URL:=}"
: "${MAP_TILE_ATTRIBUTION:=}"

cat > /usr/share/nginx/html/env.js <<EOF
window.__CREWBOARD_ENV__ = {
  PLAUSIBLE_API_HOST: "${PLAUSIBLE_API_HOST}",
  PLAUSIBLE_DOMAIN: "${PLAUSIBLE_DOMAIN}",
  MAP_TILE_URL: "${MAP_TILE_URL}",
  MAP_TILE_ATTRIBUTION: "${MAP_TILE_ATTRIBUTION}"
};
EOF
