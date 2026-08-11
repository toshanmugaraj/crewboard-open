// ── Live updates: Postgres LISTEN/NOTIFY fanned out over SSE ────────────────
// Replaces Layout.jsx's 8s poll (added when teams/persons/vehicles/markers
// moved off Matrix state events, which used to push live — see
// PAINPOINTS.md). db.js attaches an AFTER INSERT/UPDATE/DELETE trigger to
// every table that calls pg_notify('crewboard_changes', ...); this module
// holds ONE dedicated Postgres connection running `LISTEN crewboard_changes`
// (deliberately NOT borrowed from the pool in db.js — LISTEN only works for
// as long as that specific connection stays open, and pool connections get
// recycled/returned, which would silently drop it) and re-broadcasts every
// notification to whichever browser tabs are currently connected via SSE
// (routes/events.js).
import pg from 'pg'
import { EventEmitter } from 'node:events'

export const changes = new EventEmitter()
changes.setMaxListeners(0) // one listener per connected SSE client, no cap

let client = null
let reconnectTimer = null

async function connect() {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  await client.query('LISTEN crewboard_changes')

  client.on('notification', (msg) => {
    try {
      changes.emit('change', JSON.parse(msg.payload))
    } catch (e) {
      console.error('notify.js: failed to parse notification payload', e, msg.payload)
    }
  })

  // A dropped/errored LISTEN connection is silent otherwise — no more
  // notifications would ever arrive, but nothing would visibly fail (SSE
  // clients would just stop getting updates until they reconnect on their
  // own poll-fallback timers, if any). Reconnect proactively instead.
  client.on('error', (err) => {
    console.error('notify.js: LISTEN connection error, reconnecting', err.message)
    scheduleReconnect()
  })
  client.on('end', () => scheduleReconnect())

  console.log('notify.js: listening on crewboard_changes')
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect().catch((e) => {
      console.error('notify.js: reconnect failed, retrying in 2s', e.message)
      scheduleReconnect()
    })
  }, 2000)
}

export function startListening() {
  connect().catch((e) => {
    console.error('notify.js: initial LISTEN connect failed, retrying in 2s', e.message)
    scheduleReconnect()
  })
}
