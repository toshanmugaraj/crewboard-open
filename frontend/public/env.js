// Dev/build-time placeholder — Vite copies public/ verbatim into dist/, so
// this file always exists at /env.js even before any container has run.
// In production, the container entrypoint (see docker-entrypoint.d/40-
// generate-env-js.sh at the repo root, and Dockerfile) OVERWRITES this file
// at container startup with real values read from PLAUSIBLE_API_HOST/
// PLAUSIBLE_DOMAIN/MAP_TILE_URL/MAP_TILE_ATTRIBUTION env vars — see
// analytics.js and MapBoard.jsx. Loaded via a plain <script> tag in
// index.html, before the main bundle, so window.__CREWBOARD_ENV__ is
// always defined (even if empty) by the time analytics.js's getConfig()/
// MapBoard.jsx's tile config run. Empty values here just mean the OSS
// defaults apply — analytics.js's isEnabled() stays false, and MapBoard.jsx
// falls back to the public OpenStreetMap tile server — same as local
// `npm run dev`, where no container/entrypoint ever runs.
window.__CREWBOARD_ENV__ = {
  PLAUSIBLE_API_HOST: '',
  PLAUSIBLE_DOMAIN: '',
  // Optional custom tile server for a self-hosted deployment — see
  // MapBoard.jsx's TILES. Left empty here (and in this repo's default
  // container config) so crewboard-open keeps using public OpenStreetMap
  // tiles out of the box, per the OSS Tile Usage Policy comment there.
  MAP_TILE_URL: '',
  MAP_TILE_ATTRIBUTION: '',
}
