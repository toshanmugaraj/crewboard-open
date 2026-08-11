// ── Live updates over SSE ────────────────────────────────────────────────────
// Consumes backend/src/routes/events.js's Server-Sent Events stream (backed
// by Postgres LISTEN/NOTIFY — see backend/src/notify.js and db.js's
// triggers) and re-dispatches the same window CustomEvents views already
// listen for. Replaces the 8s poll that filled the gap after teams/persons/
// vehicles/markers moved off Matrix state events (see PAINPOINTS.md).
import { getAccessTokenForQuery } from './apiClient.js'
import { getRoomId } from './widget.js'

const TABLE_EVENTS = {
  teams: 'crewboard:rooms-updated',
  persons: 'crewboard:persons-updated',
  vehicles: 'crewboard:vehicles-updated',
  markers: 'crewboard:markers-updated',
  presets: 'crewboard:presets-updated',
  settings: 'crewboard:settings-updated',
}

let es = null
let reconnectTimer = null
let stopped = false

async function open() {
  if (stopped) return
  const token = await getAccessTokenForQuery()
  // EventSource can't set custom headers, so the room id rides along as a
  // query param here the same way the token does — backend/src/auth.js
  // accepts ?room_id= as the fallback for exactly this route.
  const roomId = getRoomId()
  const params = new URLSearchParams({ access_token: token })
  if (roomId) params.set('room_id', roomId)
  es = new EventSource(`/api/events?${params.toString()}`)

  es.onmessage = (ev) => {
    if (!ev.data) return // the initial blank line / keep-alive comments never reach onmessage, but guard anyway
    try {
      const { table } = JSON.parse(ev.data)
      const eventName = TABLE_EVENTS[table]
      if (eventName) window.dispatchEvent(new CustomEvent(eventName))
    } catch (e) {
      console.warn('realtime.js: unparseable SSE payload', ev.data, e)
    }
  }

  es.onerror = () => {
    // Native EventSource auto-reconnects to the SAME url string on its own,
    // which would keep replaying a token that may have expired by then
    // (OpenID tokens are short-lived). Take over reconnection instead: close
    // it, and open a fresh connection with a newly-fetched token.
    es?.close()
    es = null
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open().catch((e) => console.warn('realtime.js: reconnect failed', e))
    }, 3000)
  }
}

/** Starts the live-updates stream. Returns a function that stops it —
 *  call from a useEffect cleanup. Safe to call multiple times; only one
 *  stream runs at a time. */
export function startRealtime() {
  stopped = false
  open().catch((e) => console.warn('realtime.js: initial connect failed', e))
  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    es?.close()
    es = null
  }
}
