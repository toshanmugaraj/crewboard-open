// ── Native-share location tagging (2026-08-03) ───────────────────────────────
// New crew -> dispatcher location-tagging path, meant to eventually replace
// the \car/\motorcycle text-command convention in vehicleCommands.js (kept
// running in parallel for now — see that file's own header comment — since
// nothing on the mobile side sends the new state event yet; see
// LOCATION_TAG_MOBILE_HANDOFF.md for what the Element iOS/Android clients
// need to implement before this path actually starts getting used in the
// field).
//
// Flow: a crew member shares their location the normal Element way (native
// "share location" button, any Matrix client can do this — no CrewBoard-
// specific typing required), producing a real m.room.message/msgtype:
// 'm.location' timeline event. Some client then posts an
// org.crewboard.location-tag STATE event pointing at it
// (content: { event_id, tag, ts }) — see widget.js's header comment on that
// event type for why a state event (not another timeline event) is the
// right choice here: it's always retrievable on reconnect, closing the gap
// documented in vehicleCommands.js ("a command sent while the widget is
// closed is simply missed").
//
// processPendingLocationTags() (below) is the one thing that turns a pending
// state event into an actual Postgres marker: resolve the referenced
// message's coordinates, write/update a marker via api.markers.create()/
// update() (same client-side field encryption as every other marker write —
// see api.js's MARKER_ENC), then clear the state event so nobody reprocesses
// it. Host-only (see matrixStore.js's header comment on this section) —
// wired from Layout.jsx, gated on `!isCompanion` there.
import { api } from './api.js'
import { readPendingLocationTags, resolveLocationTagTarget, clearLocationTagState } from './matrixStore.js'

// Same 60s cache as vehicleCommands.js's resolvePerson — a burst of tags
// shouldn't refetch the whole persons/vehicles lists per-tag.
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

let vehiclesCache = null
let vehiclesCacheAt = 0
async function resolveVehicles() {
  const now = Date.now()
  if (!vehiclesCache || now - vehiclesCacheAt > 60000) {
    try { vehiclesCache = await api.vehicles.list() } catch { vehiclesCache = [] }
    vehiclesCacheAt = now
  }
  return vehiclesCache
}

/** The vehicle (if any) assigned to `person` — vehicles.person_id, the same
 *  assignment field Database.jsx's "linked_vehicle"/"linked_person" join
 *  already reads (api.js's vehicles.list()). If the person has more than one
 *  assigned vehicle, prefers whichever one's own `type` field matches the
 *  tag (case-insensitive substring — `type` is free text, not guaranteed to
 *  literally be "car"/"motorcycle"), else just the first assigned vehicle. */
async function findAssignedVehicle(person, tag) {
  if (!person) return null
  const vehicles = await resolveVehicles()
  const assigned = vehicles.filter(v => String(v.person_id) === String(person.id))
  if (assigned.length === 0) return null
  return assigned.find(v => (v.type || '').toLowerCase().includes(tag)) || assigned[0]
}

const VEHICLE_TAGS = new Set(['car', 'motorcycle'])

/** Decides what marker a given tag+sender should become, and how to dedupe
 *  it against markers already on the board.
 *
 *  - 'car'/'motorcycle', sender is a known person WITH an assigned vehicle
 *    (vehicles.person_id — bug fix, 2026-08-04: this used to be skipped
 *    entirely, every vehicle tag became a look-alike misc pin even for
 *    someone with a real vehicle row): moves/creates THAT vehicle's own
 *    marker (entity_type: 'vehicle', entity_id: vehicle.id) — same real
 *    entity a manually-placed vehicle marker would use, so it shows the
 *    vehicle's actual make/model/plate in the popup and the Database tab,
 *    not a look-alike ad hoc pin.
 *  - 'car'/'motorcycle', no assigned vehicle found (unknown sender, known
 *    sender with no vehicle row, etc.): falls back to the original ad hoc
 *    misc-pin behavior — same one-pin-per-sender model as the \car/
 *    \motorcycle text command, dedupe key is the sender's user id.
 *  - 'person', sender is a known CrewBoard person: updates THAT person's own
 *    marker (entity_type: 'person') instead of creating a separate misc pin
 *    — this is the one case where the tag means "this is really me".
 *  - everything else ('person' with no matching record, 'misc', or any
 *    future tag string): treated as a one-off point of interest. Dedupe key
 *    is the LOCATION MESSAGE's own event_id, not the sender — repeated
 *    shares from the same person here are assumed to be different points,
 *    not the same pin moving.
 */
async function planMarker(tag, target) {
  const person = await resolvePerson(target.sender)
  const who = person?.name || target.sender

  if (VEHICLE_TAGS.has(tag)) {
    const vehicle = await findAssignedVehicle(person, tag)
    if (vehicle) {
      return {
        dedupeType: 'vehicle',
        dedupeEntityId: vehicle.id,
        payload: {
          entity_type: 'vehicle',
          entity_id: vehicle.id,
        },
      }
    }
    // No assigned vehicle to link to — keep the original ad hoc misc pin so
    // an unknown/unassigned sender's share still shows up on the map.
    return {
      dedupeType: 'misc',
      dedupeEntityId: target.sender,
      payload: {
        entity_type: 'misc',
        entity_id: target.sender,
        vehicle_type: tag,
        label: `${who} · ${tag === 'motorcycle' ? 'Motorcycle' : 'Car'}`,
      },
    }
  }

  if (tag === 'person' && person) {
    return {
      dedupeType: 'person',
      dedupeEntityId: person.id,
      payload: {
        entity_type: 'person',
        entity_id: person.id,
      },
    }
  }

  return {
    dedupeType: 'misc',
    dedupeEntityId: target.eventId,
    payload: {
      entity_type: 'misc',
      entity_id: null, // no natural entity to link to — see MISC_COLORS-style ad hoc markers elsewhere
      label: target.body ? `${who}: ${target.body}` : `${who}'s location`,
    },
  }
}

/** Processes every currently-pending org.crewboard.location-tag state event:
 *  resolves the referenced m.location message, writes/moves the
 *  corresponding marker in Postgres (via api.markers.*, same encryption as
 *  every other marker write), and clears the state event once done.
 *
 *  Safe to call repeatedly/redundantly (mount + every live state push both
 *  call this with the full pending set, rather than diffing) — a tag whose
 *  state event has already been cleared by a previous call (by this
 *  instance, or another already-open CrewBoard tab) simply won't show up in
 *  readPendingLocationTags() again, and the note/lat/lng/label fields go
 *  through the same encFields() path as any other marker write regardless
 *  of how many times a given marker gets updated.
 *
 *  Returns an array of { tagged: true, label, updated } for whichever tags
 *  were actually turned into markers this call, so Layout.jsx can toast
 *  about them — matches tryTagVehicleCommand()'s return shape so the same
 *  toast-building code in Layout.jsx can eventually handle both paths, or
 *  just this one once vehicleCommands.js is retired for good. */
export async function processPendingLocationTags() {
  const pending = await readPendingLocationTags().catch((e) => {
    console.warn('processPendingLocationTags: readPendingLocationTags failed:', e.message)
    return []
  })
  if (pending.length === 0) return []

  const results = []
  for (const stateEvent of pending) {
    const { event_id: eventId, tag } = stateEvent.content || {}
    if (!eventId) continue

    const target = await resolveLocationTagTarget(eventId).catch((e) => {
      console.warn(`processPendingLocationTags: couldn't resolve target for ${eventId}:`, e.message)
      return null
    })
    // Not found yet (the pointed-to message may not have landed in a fresh
    // read the instant the state event arrives) — leave it pending, try
    // again next call rather than clearing/dropping it.
    if (!target) continue
    target.eventId = eventId

    try {
      const { dedupeType, dedupeEntityId, payload } = await planMarker(tag, target)

      const existingMarkers = await api.markers.list().catch(() => [])
      const existing = existingMarkers.find(
        (m) => m.entity_type === dedupeType && (dedupeEntityId != null ? m.entity_id === dedupeEntityId : false)
      )

      const fullPayload = {
        ...payload,
        lat: target.lat,
        lng: target.lng,
        locked: false,
        note: `Shared via location-tag (${tag || 'misc'})`,
      }

      if (existing) {
        await api.markers.update(existing.id, fullPayload)
      } else {
        await api.markers.create(fullPayload)
      }

      await clearLocationTagState(stateEvent.state_key, stateEvent.room_id)

      results.push({
        tagged: true,
        sender: target.sender,
        tag: tag || 'misc',
        label: payload.label || dedupeType,
        updated: !!existing,
      })
    } catch (e) {
      console.warn(`processPendingLocationTags: failed to process tag for event ${eventId}:`, e.message)
      // Deliberately NOT cleared on failure — leave it pending so a retry
      // (next mount/live push) gets another chance, rather than silently
      // losing a share because of a transient Postgres/API error.
    }
  }
  return results
}
