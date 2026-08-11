// ── \car / \motorcycle text-command vehicle tagging ─────────────────────────
// Replaces the earlier reply-to-Element's-native-location-share approach
// (rich-reply relations, a pending-share map, a vehicle-assignment lookup —
// too many moving parts for what's fundamentally a one-line command). Back
// to the plain convention this app already used before that experiment: a
// crew member sends a single message of the form
//   \car <lat>,<lon>
//   \motorcycle <lat>,<lon>
// and CrewBoard drops/moves a marker for them. One message, one action — no
// relation-matching, no dependency on Element's native share feature, no
// separate "does this person have a vehicle assigned" gate.
import { api } from './api.js'

// Matches "\car 26.22,50.59" / "\motorcycle -12.3, 45.6" — leading
// whitespace tolerated, lat/lon separated by a comma with optional spaces
// around it. Case-insensitive so "\Car"/"\CAR" etc. all work.
const COMMAND_RE = /^\s*\\(car|motorcycle)\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i

/** Parses a single m.room.message event's body for a \car/\motorcycle
 *  command. Returns null for anything else (regular chat, other msgtypes,
 *  malformed coordinates). */
export function parseVehicleCommand(event) {
  const body = event?.content?.body
  if (typeof body !== 'string') return null
  const m = body.match(COMMAND_RE)
  if (!m) return null
  return {
    vehicleType: m[1].toLowerCase(),
    lat: parseFloat(m[2]),
    lng: parseFloat(m[3]),
  }
}

// Cache persons briefly so a burst of commands doesn't refetch the whole
// list per-message — same pattern used elsewhere (MapBoard's beacon->person
// matching).
let personsCache = null
let personsCacheAt = 0
async function resolvePerson(matrixId) {
  const now = Date.now()
  if (!personsCache || now - personsCacheAt > 60000) {
    try { personsCache = await api.persons.list() } catch { personsCache = [] }
    personsCacheAt = now
  }
  return personsCache.find(p => p.matrix_id === matrixId) || null
}

/** Call with a single m.room.message event (live or from history). If it's
 *  a \car/\motorcycle command, creates/moves a misc marker for that sender
 *  and resolves to `{ tagged: true, label, updated }`. Resolves to null for
 *  anything that isn't a command.
 *
 *  Dedup: keyed by the sender's Matrix user id in the marker's `entity_id`
 *  column — misc markers normally have no entity_id (nothing to link to),
 *  and api.js's join only ever reads entity_id for entity_type
 *  'person'/'vehicle', never 'misc', so repurposing it here is harmless.
 *  That gives each sender's ad hoc marker the same "one marker, moves on
 *  update" identity a real person/vehicle marker gets from its DB row id —
 *  a second \car command from the same sender moves their pin instead of
 *  piling up a new one. */
export async function tryTagVehicleCommand(event) {
  const cmd = parseVehicleCommand(event)
  if (!cmd) return null

  const sender = event.sender
  const person = await resolvePerson(sender)
  const who = person?.name || sender
  const label = `${who} · ${cmd.vehicleType === 'motorcycle' ? 'Motorcycle' : 'Car'}`

  const existingMarkers = await api.markers.list().catch(() => [])
  const existing = existingMarkers.find(
    (m) => m.entity_type === 'misc' && m.entity_id === sender
  )

  const payload = {
    entity_type: 'misc',
    entity_id: sender,
    vehicle_type: cmd.vehicleType,
    lat: cmd.lat,
    lng: cmd.lng,
    locked: false,
    label,
    note: `\\${cmd.vehicleType} command`,
  }

  if (existing) {
    await api.markers.update(existing.id, payload)
  } else {
    await api.markers.create(payload)
  }

  return { tagged: true, sender, vehicleType: cmd.vehicleType, label, updated: !!existing }
}

// A history catch-up pass (processVehicleCommandHistory()) used to live here
// — replaying api.matrix.inbox()'s recent-message window at mount so a
// \car/\motorcycle command sent while the widget was fully closed still got
// tagged. Removed (2026-07-27): since deletes are real (not tombstoned —
// see db.js), replaying history at every mount had no way to distinguish
// "this command was never tagged" from "this command WAS tagged and the
// user then deliberately deleted the marker" — every reopen resurrected
// whatever had just been deleted. tryTagVehicleCommand() above is now only
// ever called from Layout.jsx's live m.room.message subscription; a command
// sent while the widget is closed is simply missed.
