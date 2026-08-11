// ── Plausible analytics, privacy-scoped (2026-08-06) ────────────────────────
// CrewBoard's whole design philosophy elsewhere in this repo is "encrypt or
// don't collect" — sensitive fields are E2EE'd client-side (roomCrypto.js),
// diagnostics reports redact anything phone/matrix-id-shaped (diagnostics.js).
// This module holds the same line for product analytics: every event this
// app ever sends to Plausible carries AT MOST a Matrix room id and/or a
// Matrix user id as identifying data — never a name, phone number,
// coordinate, marker label, message body, or any other field this app
// otherwise treats as sensitive. Do not add anything else to buildProps()
// below, and do not pass a real `url` (the actual widget URL's hash/query
// carries roomId/baseUrl/tokens — see widget.js) — only ever the synthetic
// one built here.
//
// Talks directly to a self-hosted Plausible instance's POST /api/event
// endpoint (not the plausible.js script-tag/pageview-autocapture approach,
// which assumes a normal top-level browser tab with real referrers/screen
// dimensions/etc — CrewBoard runs inside an Element <iframe>, so most of
// what that script would auto-collect is either meaningless or an extra
// leak surface for no benefit).
//
// Config comes from window.__CREWBOARD_ENV__, itself templated at container
// startup from the PLAUSIBLE_API_HOST/PLAUSIBLE_DOMAIN docker-compose .env
// vars (see /docker-entrypoint.d/40-generate-env-js.sh + index.html) — this
// is what makes the Plausible server URL/site key configurable without an
// image rebuild, per the explicit requirement this feature shipped for.
// Falls back to Vite build-time VITE_PLAUSIBLE_* vars for local `npm run
// dev`, where no container/entrypoint ever runs. Analytics is OFF (every
// call below silently no-ops) whenever either value is unset — e.g. a fresh
// deploy that hasn't configured Plausible yet, or local dev.
import { getRoomId } from './widget.js'

// A PLAUSIBLE_API_HOST set without a scheme (e.g. "watcher.example.com"
// instead of "https://watcher.example.com") is NOT an absolute URL — fetch()
// silently treats it as a path relative to the CURRENT page's own origin
// (CrewBoard's own domain, not the Plausible host), producing a nonsense
// concatenated URL that 404s/405s against CrewBoard's own nginx instead of
// ever reaching Plausible. Confirmed live (2026-08-06): PLAUSIBLE_API_HOST=
// "watcher.example.com" on a CrewBoard served from crewboard.example.org
// produced a POST to https://crewboard.example.org/watcher.example.com/api/event
// (405, wrong server entirely). Default to https:// when no scheme is given
// so a bare-hostname config value still works correctly instead of failing
// this confusingly.
function normalizeApiHost(host) {
  const trimmed = (host || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function getConfig() {
  const runtimeEnv = (typeof window !== 'undefined' && window.__CREWBOARD_ENV__) || {}
  const buildEnv = (typeof import.meta !== 'undefined' && import.meta.env) || {}
  const apiHost = runtimeEnv.PLAUSIBLE_API_HOST || buildEnv.VITE_PLAUSIBLE_API_HOST || ''
  const domain = runtimeEnv.PLAUSIBLE_DOMAIN || buildEnv.VITE_PLAUSIBLE_DOMAIN || ''
  return { apiHost: normalizeApiHost(apiHost), domain }
}

function isEnabled() {
  const { apiHost, domain } = getConfig()
  return Boolean(apiHost && domain)
}

// The ONLY fields this module is allowed to attach to an event: room id,
// user id, and (2026-08-06) a fixed error `type` category — never a free-form
// error message or stack trace (those can carry marker labels, matrix IDs,
// backend URLs, or other content this app otherwise treats as sensitive; see
// ERROR_TYPES below and trackError()'s header comment for why this is a
// closed set rather than "whatever string the caller passes").
function buildProps({ roomId, userId, type } = {}) {
  const props = {}
  if (roomId) props.room = roomId
  if (userId) props.user = userId
  if (type) props.type = type
  return props
}

async function post(name, path, extraProps) {
  if (!isEnabled()) return
  const { apiHost, domain } = getConfig()
  const roomId = getRoomId()
  const props = buildProps({ roomId, ...extraProps })
  try {
    await fetch(`${apiHost}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Synthetic, non-identifying URL — never the real widget location
      // (its hash/query carry roomId/baseUrl/tokens; see widget.js). Plausible
      // requires SOME url, so this is a fixed, fake one that just encodes the
      // event's own "page"/name for Plausible's own dashboard grouping.
      body: JSON.stringify({
        name,
        url: `app://crewboard/${path || name}`,
        domain,
        props,
      }),
    })
  } catch {
    // Analytics must never break the app or surface an error to the user —
    // same "best-effort, silently swallow" posture as diagnostics.js.
  }
}

/** Call on every route change. `path` is CrewBoard's own internal route
 *  (e.g. "map", "teams") — not a real URL. `userId` optional (pass the
 *  caller's own verified Matrix user id, e.g. from api.whoami().user_id, if
 *  known — never anyone else's). */
export function trackPageview(path, userId) {
  post('pageview', path, userId ? { userId } : undefined)
}

/** Call for a specific product action (marker created, message sent, etc).
 *  `name` should be a short, generic event name — never include the actual
 *  content of what happened (no marker labels, message bodies, etc). */
export function trackEvent(name, userId) {
  post(name, name, userId ? { userId } : undefined)
}

// ── Error tracking (2026-08-06) ──────────────────────────────────────────
// A CLOSED set of generic error categories — not the actual error message
// or stack trace. Real error text routinely contains exactly the kind of
// thing this module exists to keep out of analytics: a failed fetch's URL
// (which can embed a room id in a path), a decrypt failure naming the field
// that failed, a stack frame with a local variable dump, etc. — the same
// reasoning diagnostics.js's redact() is built around, except redaction is
// best-effort and this is meant to be a hard guarantee. If you need actual
// error text for debugging, that's what diagnostics.js's "Send to this
// room" report is for (goes into the E2EE room itself, not to Plausible).
//
// Add a new category here (and use it at the real call site) rather than
// ever passing a raw `error.message`/`error.toString()` through to
// trackError() — unrecognized values are coerced to 'unknown_error' below,
// specifically so a typo or a lazily-passed message string can't leak
// through silently.
const ERROR_TYPES = new Set([
  'widget_init_error',   // initWidget() failed to connect to Element
  'encryption_error',    // initRoomCrypto() failed / room key setup failed
  'api_error',            // a crewboard-backend request failed (apiClient.js)
  'matrix_send_error',    // a Matrix send/room-event call failed
  'media_upload_error',   // uploadMedia() failed
  'unknown_error',        // fallback — an error occurred but wasn't categorized
])

/** Records that an error of a given (fixed) category happened — no message,
 *  no stack, nothing else. `type` must be one of ERROR_TYPES; anything else
 *  is recorded as 'unknown_error' instead of passed through as-is. */
export function trackError(type, userId) {
  const safeType = ERROR_TYPES.has(type) ? type : 'unknown_error'
  post('error', `error/${safeType}`, { type: safeType, ...(userId ? { userId } : {}) })
}
