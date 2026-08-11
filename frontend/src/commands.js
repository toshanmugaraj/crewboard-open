// ── Chat slash-commands ──────────────────────────────────────────────────────
// Lets a field crew member drop their vehicle onto the map just by typing a
// message in the Element room, no CrewBoard UI needed on their end:
//
//     \car  26.230218, 50.587659     — moves their CAR
//     \bike 26.230218, 50.587659     — moves their MOTORCYCLE
//     (! works as the prefix too:  !car ... / !bike ...)
//
// The command WORD picks which of the sender's vehicles to move, by type — a
// person can have both a car and a motorcycle in the database, so `\car` and
// `\bike` must be able to target the right one. Accepted words:
//     car                      -> vehicle.type 'car'
//     bike | moto | motorcycle -> vehicle.type 'motorcycle'
//
// The dispatcher's CrewBoard widget sees that message, resolves the sender to
// a person in the database, finds that person's linked vehicle OF THE NAMED
// TYPE, and moves (or places) that vehicle's marker to the given coordinates.
// This is deliberately a plain m.room.message, not a custom event type — so it
// works from ANY Matrix client (mobile Element, a bot, etc.), and a person who
// has no CrewBoard widget can still update their position. The widget just
// quietly interprets it; Element still renders it as ordinary chat text too.
//
// Why `\`/`!` and NOT `/`: Element treats a leading '/' as a native
// slash-command. Typing `/car ...` makes Element reject it with "Unrecognized
// command" and NEVER send the message to the room at all — so the widget would
// never see it. A leading backslash or bang is plain text to Element, so the
// message goes through untouched. Both prefixes are accepted.
//
// Design decisions (confirmed with the user, 2026-07-23):
//  - Move-existing-else-create: a given vehicle only ever has one marker.
//  - Known-person-with-matching-vehicle only: the sender's matrix_id must
//    match a person row that has a linked vehicle of the requested type.
//    Everything else is ignored silently (this is a chat room — most messages
//    aren't commands).
//  - Only admin (write-capable, PL50+) widgets act. That matches the real flow
//    (field crew texts, dispatcher's privileged widget plots it) and means we
//    never even try a write we know the backend would 403.
import { api } from './api'
import { isRelevantRoom } from './relevantRooms.js'

// `\<word> <lat> , <lng>` (or `!<word> ...`) — comma-separated, optional
// surrounding whitespace, negative and decimal values allowed. Anchored so it
// only matches a message that IS the command, not one that merely mentions it
// in prose. Group 1 = command word (selects vehicle type), groups 2/3 = coords.
const CMD_RE = /^\s*[\\!](car|bike|moto|motorcycle)\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/i

// Maps each accepted command word to the vehicle.type it targets.
const WORD_TO_VEHICLE_TYPE = {
  car: 'car',
  bike: 'motorcycle',
  moto: 'motorcycle',
  motorcycle: 'motorcycle',
}

// Guards against acting on the same message twice. Two sources of duplicates:
//  1. observeRoomEvents replays existing timeline events when the widget
//     (re)loads — without the timestamp gate below, every reload would
//     re-apply every historical command.
//  2. The same live event can be delivered more than once across a reconnect —
//     the event_id set catches those.
const processedEventIds = new Set()
let watchStartTs = 0

/** Subscribes to room messages and applies any vehicle-location commands.
 *  No-op (and never even subscribes) unless this widget can write — only
 *  admin widgets own the map, so only they should act on a command, and a
 *  non-writer acting would just eat a 403 from the backend. Returns an
 *  unsubscribe function, matching subscribeState()'s contract. */
export function startCommandWatch(subscribeState, canWrite) {
  if (!canWrite) return () => {}
  watchStartTs = Date.now()
  return subscribeState('m.room.message', (event) => {
    handleMessage(event).catch((e) => console.warn('command handler failed:', e.message))
  })
}

async function handleMessage(event) {
  if (!event || event.type !== 'm.room.message') return
  // Optimization: only act on \car/\bike commands from a room CrewBoard
  // actually has linked (this widget's own room, or a team/person room) —
  // see relevantRooms.js. A dispatcher's Element account can be in many
  // rooms unrelated to CrewBoard; there's no reason to parse chat text or
  // do person/vehicle lookups for those.
  if (!isRelevantRoom(event.room_id)) return
  const content = event.content || {}
  if (content.msgtype !== 'm.text') return

  const match = String(content.body || '').trim().match(CMD_RE)
  if (!match) return

  const wantType = WORD_TO_VEHICLE_TYPE[match[1].toLowerCase()]
  if (!wantType) return

  // Dedup (see processedEventIds above). Skip anything older than when we
  // started watching (history replay) and anything already handled.
  const eventId = event.event_id
  if (eventId && processedEventIds.has(eventId)) return
  if (event.origin_server_ts && event.origin_server_ts < watchStartTs) return
  if (eventId) processedEventIds.add(eventId)

  const lat = parseFloat(match[2])
  const lng = parseFloat(match[3])
  // Reject nonsense/out-of-range coordinates rather than dropping a pin in the
  // ocean off West Africa (0,0) or throwing a backend error.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return

  const sender = event.sender
  if (!sender) return

  // Resolve sender -> person -> their linked vehicle OF THE REQUESTED TYPE.
  // All lookups are room-scoped by the backend already (api.js sends
  // X-Crewboard-Room-Id), so a command from someone who isn't in THIS room's
  // database simply finds nothing.
  const persons = await api.persons.list()
  const person = persons.find((p) => p.matrix_id && p.matrix_id === sender)
  if (!person) return

  const vehicles = await api.vehicles.list()
  const mine = vehicles.filter((v) => String(v.person_id) === String(person.id))
  // Prefer an exact type match (`\car` -> their car, `\bike` -> their bike).
  // Fall back to their only vehicle if they have exactly one and it wasn't a
  // type mismatch — e.g. someone typed `\car` but only has a motorcycle on
  // file — rather than silently doing nothing. If they have several and none
  // match the requested type, do nothing (ambiguous).
  let vehicle = mine.find((v) => (v.type || 'car') === wantType)
  if (!vehicle && mine.length === 1) vehicle = mine[0]
  if (!vehicle) return

  // Move the vehicle's existing marker, or create one if it has none.
  // Note: if two admin widgets both process the very first command for a
  // vehicle that has no marker yet, they can each create one (the backend
  // generates a fresh id per create, so there's no unique constraint to
  // collide on). Every subsequent command converges via the update path. In
  // practice one dispatcher widget holds write power, so this race is
  // vanishingly unlikely; a server-side upsert keyed on (owner_room_id,
  // entity_type, entity_id) would close it fully if it ever becomes a problem.
  const markers = await api.markers.list()
  const existing = markers.find(
    (m) => m.entity_type === 'vehicle' && String(m.entity_id) === String(vehicle.id)
  )
  if (existing) {
    await api.markers.update(existing.id, { lat, lng })
  } else {
    await api.markers.create({ entity_type: 'vehicle', entity_id: vehicle.id, lat, lng, locked: true })
  }

  // Nudge the views to refresh (same event MapBoard/Database already listen
  // for). The backend's own LISTEN/NOTIFY->SSE path will also fire, but this
  // makes the update feel instant on the widget that did the write.
  window.dispatchEvent(new CustomEvent('crewboard:markers-updated'))
}
