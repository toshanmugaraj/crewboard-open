// ── Relevant-room cache for scoping cross-room live-event subscriptions ─────
// Optimization (2026-07-27): widget.js requests `org.matrix.msc2762.
// timeline:*` (Symbols.AnyRoom) — broad read/send access to every room the
// dispatcher's Element client is joined to. That grant itself can't be
// narrowed to just team/person rooms without breaking the "pick an existing
// room" convenience picker in the Team/Person link modals (Teams.jsx/
// Database.jsx's room pickers, via matrixStore.js's listJoinedRooms()) —
// that picker needs to enumerate ALL your joined rooms to work at all, which
// needs the same broad capability regardless of what CrewBoard's OWN
// subscriptions then choose to act on.
//
// What CAN be narrowed, safely and without breaking anything, is which
// rooms CrewBoard's own subscribeState() handlers actually DO something
// with. Team broadcast rooms + person DM rooms (+ this widget's own ops
// room) are the only rooms CrewBoard's cross-room features genuinely care
// about — team roster sync, \car/\bike chat commands, the vehicle-tag
// message watcher, MatrixHub's activity feed. Every OTHER room the
// dispatcher happens to be a member of (for reasons unrelated to CrewBoard)
// was previously still triggering re-syncs, command parsing, and toast
// noise on every message/membership change in it. This cache + isRelevantRoom()
// lets each of those handlers skip work for rooms outside that set.
//
// Deliberately NOT applied to the live-location beacon subscriptions
// (org.matrix.msc3672.beacon/.beacon_info, Layout.jsx) — those are
// intentionally cross-room: a person can share live location from whatever
// room their mobile Element client happens to be in, not necessarily a room
// CrewBoard has linked, and beacons are matched to a known person by
// matrix_id, not by which room they arrived in.
import { api } from './api'
import { getRoomId } from './widget.js'

let cache = null // Set<string> | null — null means "not loaded yet"
let refreshPromise = null

async function doRefresh() {
  try {
    const [teams, persons] = await Promise.all([api.teams.list(), api.persons.list()])
    const ids = new Set()
    for (const t of teams) if (t.room_id) ids.add(t.room_id)
    for (const p of persons) if (p.dm_room_id) ids.add(p.dm_room_id)
    cache = ids
  } catch (e) {
    console.warn('relevantRooms: refresh failed (non-fatal, keeping previous cache):', e.message)
  }
  return cache
}

/** Re-fetches the team/person room-link list. Call once at startup and
 *  whenever a room link could have changed; also wired below to refresh
 *  automatically on the same live-update events realtime.js already
 *  dispatches for teams/persons, so callers don't each need their own
 *  listener just to keep this current. De-dupes concurrent calls. */
export function refreshRelevantRooms() {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

if (typeof window !== 'undefined') {
  window.addEventListener('crewboard:rooms-updated', () => refreshRelevantRooms())
  window.addEventListener('crewboard:persons-updated', () => refreshRelevantRooms())
}

/** True if `roomId` is one CrewBoard's cross-room live-event handlers
 *  should act on: this widget's own room, or a linked team/person room.
 *  Fails OPEN (returns true) if the cache hasn't loaded yet or `roomId` is
 *  falsy/missing — better to do a little unnecessary work during the brief
 *  startup window before the first refresh completes than to silently drop
 *  a real event because the cache wasn't ready yet. */
export function isRelevantRoom(roomId) {
  if (!roomId) return true
  if (roomId === getRoomId()) return true
  if (!cache) return true
  return cache.has(roomId)
}
