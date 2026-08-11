// Dev/build-time placeholder — Vite copies public/ verbatim into dist/, so
// this file always exists at /env.js even before any container has run.
// In production, the container entrypoint (see docker-entrypoint.d/40-
// generate-env-js.sh at the repo root, and Dockerfile) OVERWRITES this file
// at container startup with real values read from PLAUSIBLE_API_HOST/
// PLAUSIBLE_DOMAIN env vars — see analytics.js. Loaded via a plain <script>
// tag in index.html, before the main bundle, so window.__CREWBOARD_ENV__ is
// always defined (even if empty) by the time analytics.js's getConfig()
// runs. Empty values here just mean analytics.js's isEnabled() stays false
// — same as local `npm run dev`, where no container/entrypoint ever runs.
window.__CREWBOARD_ENV__ = {
  PLAUSIBLE_API_HOST: '',
  PLAUSIBLE_DOMAIN: '',
}
