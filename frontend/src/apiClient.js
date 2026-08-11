// ── Backend API client ───────────────────────────────────────────────────────
// teams/persons/vehicles/markers/presets/settings now live in crewboard-backend
// (Express + Postgres) instead of Matrix room state — see PAINPOINTS.md's
// "M_BAD_JSON"/encryption sections for why. Chat, contact/vehicle cards, and
// location shares stay on Matrix (matrixStore.js) since those are already
// properly E2EE'd as room message events; only the "database" entities moved.
//
// Auth: every request carries the same Matrix OpenID token the widget
// already gets for free (getOpenIdToken(), used for media uploads too) — no
// separate login. Tokens are short-lived, so they're cached with their own
// expiry rather than requested on every single call.
import { getOpenIdToken, getRoomId } from './widget.js'
import { isCompanion, companionGetOpenIdToken } from './relay.js'
import { trackError } from './analytics.js'

const BASE_URL = '/api'

let cachedToken = null // { access_token, matrix_server_name, expiresAt }

// In a companion window (see relay.js) there's no Widget API connection to
// request a token from directly — relay it through the original widget
// iframe instead, which still has one.
async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) return cachedToken
  const creds = isCompanion ? await companionGetOpenIdToken() : await getOpenIdToken()
  cachedToken = {
    access_token: creds.access_token,
    matrix_server_name: creds.matrix_server_name,
    // expires_in is in seconds; Matrix spec default is ~3600 but treat it as
    // opaque and refresh a little early rather than assume a fixed value.
    expiresAt: Date.now() + (creds.expires_in ? creds.expires_in * 1000 : 5 * 60 * 1000),
  }
  return cachedToken
}

async function request(path, { method = 'GET', body } = {}) {
  let res
  try {
    const token = await getToken()
    // Every row in the backend belongs to exactly one Matrix room
    // (owner_room_id — see backend/src/db.js), and the backend scopes every
    // query to the room named here. Sending the "wrong" room isn't a way in:
    // backend/src/auth.js verifies the caller is actually joined to it via
    // Synapse's admin API and 403s otherwise. In a companion window there's
    // no live Widget API, but getRoomId() falls back to the ?roomId= URL
    // param that Layout.jsx's popout button encodes — so this works in both.
    const roomId = getRoomId()
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token.access_token}`,
        'X-Matrix-Server-Name': token.matrix_server_name || '',
        ...(roomId ? { 'X-Crewboard-Room-Id': roomId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    // Network failure, token fetch failure, etc. — never made it to a real
    // HTTP response. See analytics.js's trackError() header comment for why
    // this only ever records a fixed category ('api_error'), never `e`
    // itself (could be a TypeError whose message embeds the request URL).
    trackError('api_error')
    throw e
  }

  if (!res.ok) {
    trackError('api_error')
    let message = `Request failed (${res.status})`
    try {
      const errBody = await res.json()
      if (errBody?.error) message = errBody.error
    } catch { /* response wasn't JSON, keep the generic message */ }
    throw new Error(message)
  }

  if (res.status === 204) return null
  return res.json()
}

export const backend = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  delete: (path) => request(path, { method: 'DELETE' }),
}

/** Used by realtime.js to build the SSE URL — EventSource can't set custom
 *  headers, so the token has to ride along as a query param instead of the
 *  Authorization header every other request uses (see backend/src/auth.js). */
export async function getAccessTokenForQuery() {
  const token = await getToken()
  return token.access_token
}
