// ── Widget-era API layer ─────────────────────────────────────────────────────
// Same call surface the views already use (api.teams.*, api.persons.*, ...).
// teams/persons/vehicles/markers/presets/settings — CrewBoard's "database" —
// are now backed by crewboard-backend (Express + Postgres, see
// backend/src/*) instead of Matrix room state. That move happened because
// Matrix room state events can never be end-to-end encrypted (only room
// *message* events can — see PAINPOINTS.md) and because Matrix's canonical
// JSON rejects any float, which made lat/lng handling awkward. Postgres has
// neither limitation, and sensitive columns (phone, matrix_id,
// license_plate, notes) are encrypted server-side (backend/src/crypto.js)
// with a key the widget frontend never has access to.
//
// Chat, contact/vehicle cards, and location shares (api.matrix.* below)
// stay on Matrix — those are already room *message* events, which Element
// properly E2EE's client-side, so there was no reason to move them.
import { backend } from './apiClient.js'
import {
  sendMessage,
  sendRoomEvent,
  sendRoomEventToRooms,
  readInbox,
  readBeacons,
  uploadMedia,
  fetchAuthedMediaUrl,
  searchUserDirectory,
  findDmRoom,
  listJoinedRooms,
} from './matrixStore.js'
import { encryptValue, decryptValue } from './roomCrypto.js'
import { trackEvent } from './analytics.js'

// Fire-and-forget usage tracking for a curated set of "core functionality"
// actions (marker/team/person/vehicle create, message/broadcast/location
// send) — see analytics.js's header comment for the hard privacy limit this
// obeys (room id only; never anything about WHAT was created/sent). Never
// awaited and never allowed to affect the caller's return value or throw —
// analytics is strictly observational.
function track(name) {
  try { trackEvent(name) } catch { /* never let analytics break a real action */ }
}

// Used by sendContact() below to build formatted_body — the ONLY HTML this
// app ever sends into a room message, so a minimal local escaper is enough
// (no need to pull in a full HTML-escaping dependency for one call site).
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Client-side field encryption (see roomCrypto.js) ────────────────────────
// These fields are encrypted with the room-member-only key BEFORE they reach
// the backend, and decrypted here after reading. The backend stores them as
// opaque `mx1:` blobs it can't read. decryptValue() passes plaintext through
// untouched, so this also transparently handles legacy rows the backend
// decrypted server-side (during the coexistence window).
const PERSON_ENC = ['phone', 'matrix_id', 'dm_room_id']
// make/model/type joined 2026-07-27.
const VEHICLE_ENC = ['license_plate', 'make', 'model', 'type']
// lat/lng/label joined 2026-07-27 — decryptValue() always hands back a
// STRING (or the untouched mx1: blob), so markers.list() below Number()s
// lat/lng back after decrypting; encryptValue() already coerces via
// String(plaintext) internally, so passing the raw numbers straight into
// encFields on the way out needs no special-casing.
const MARKER_ENC = ['note', 'lat', 'lng', 'label']
// name/description joined 2026-07-27.
const TEAM_ENC = ['room_id', 'name', 'description']

/** Returns a copy of `data` with the named fields encrypted, but only fields
 *  actually present — a partial update (e.g. just { image_mxc }) must not
 *  encrypt-and-write fields the caller didn't touch. */
async function encFields(data, fields) {
  const out = { ...data }
  for (const f of fields) {
    if (f in data) out[f] = await encryptValue(data[f])
  }
  return out
}

async function decRow(row, fields) {
  const out = { ...row }
  await Promise.all(fields.map(async (f) => { out[f] = await decryptValue(row[f]) }))
  return out
}
const decRows = (rows, fields) => Promise.all(rows.map((r) => decRow(r, fields)))

const teamsStore = {
  list: () => backend.get('/teams'),
  get: (id) => backend.get(`/teams/${id}`),
  create: (data) => backend.post('/teams', data),
  update: (id, data) => backend.put(`/teams/${id}`, data),
  delete: (id) => backend.delete(`/teams/${id}`),
}
const personsStore = {
  list: () => backend.get('/persons'),
  get: (id) => backend.get(`/persons/${id}`),
  create: (data) => backend.post('/persons', data),
  update: (id, data) => backend.put(`/persons/${id}`, data),
  delete: (id) => backend.delete(`/persons/${id}`),
}
const vehiclesStore = {
  list: () => backend.get('/vehicles'),
  get: (id) => backend.get(`/vehicles/${id}`),
  create: (data) => backend.post('/vehicles', data),
  update: (id, data) => backend.put(`/vehicles/${id}`, data),
  delete: (id) => backend.delete(`/vehicles/${id}`),
}
const markersStore = {
  list: () => backend.get('/markers'),
  create: (data) => backend.post('/markers', data),
  update: (id, data) => backend.put(`/markers/${id}`, data),
  delete: (id) => backend.delete(`/markers/${id}`),
  clearAll: () => backend.delete('/markers'),
}
// Wire-level stores now speak in `_enc` blobs (2026-07-27) — the whole
// preset array / settings object is JSON-stringified and encrypted as ONE
// opaque field before it ever reaches these, and decrypted+parsed after.
// See api.matrix.presets()/updatePresets() and api.settings.get()/update()
// below for the actual (de)serialization; these two just move the blob.
const presetsStore = {
  list: () => backend.get('/presets'), // -> { items_enc }
  update: (items_enc) => backend.put('/presets', { items_enc }), // -> { items_enc }
}
const settingsStore = {
  get: () => backend.get('/settings'), // -> { data_enc }
  update: (data_enc) => backend.patch('/settings', { data_enc }), // -> { data_enc }
}

// Joins team name/color onto rows the way the old SQL views did.
function withTeamInfo(rows, teams) {
  const byTeam = Object.fromEntries(teams.map(t => [String(t.id), t]))
  return rows.map(r => ({
    ...r,
    team_name: r.team_id ? byTeam[String(r.team_id)]?.name : null,
    team_color: r.team_id ? byTeam[String(r.team_id)]?.color : null,
  }))
}

export const api = {
  // Who the caller is and what they're allowed to do in the room this
  // widget instance is running in — power_level plus a can_write flag
  // (backend requires level 50+, i.e. moderator/admin, for any write). Used
  // to disable editing affordances for read-only members rather than
  // letting them click through and eat a 403. The backend enforces this
  // independently on every route; this is purely for UI honesty.
  whoami: () => backend.get('/whoami'),

  // Generic mxc:// → blob: URL resolver. api.persons.imageUrl/
  // api.vehicles.imageUrl/api.matrix.userAvatarUrl below do the exact same
  // fetchAuthedMediaUrl() call, just named for their own callers' entity —
  // this is the one to reach for when the caller doesn't have a specific
  // entity in hand, e.g. MapBoard.jsx resolving a marker's linked person/
  // vehicle avatar (could be either) or a live-location beacon's avatar
  // from one shared call site.
  media: {
    url: (mxc) => fetchAuthedMediaUrl(mxc),
  },

  // Export/import the whole room's dataset (teams, persons, vehicles,
  // markers, plus presets/settings) as a single JSON document.
  //
  // Because sensitive fields are now client-encrypted, the backend export
  // hands back `mx1:` ciphertext (it can't read them) — so export DECRYPTS
  // client-side to produce a readable, portable plaintext backup, and import
  // RE-ENCRYPTS with the current room's key before sending. This is also what
  // makes the export the answer to the "key loss = data loss" risk: it's a
  // plaintext copy that doesn't depend on the room's Megolm keys surviving.
  // That's exactly why it's admin-only, and why the UI warns about handling
  // the file carefully.
  backup: {
    export: async () => {
      const data = await backend.get('/backup/export')
      const [teams, persons, vehicles, markers] = await Promise.all([
        decRows(data.teams || [], TEAM_ENC),
        decRows(data.persons || [], PERSON_ENC),
        decRows(data.vehicles || [], VEHICLE_ENC),
        decRows(data.markers || [], MARKER_ENC),
      ])
      // Markers' lat/lng come back as decrypted strings, same fixup
      // markers.list() above needs — a backup file should hold real
      // numbers, not "26.22".
      const markersFixed = markers.map(m => ({
        ...m,
        lat: m.lat != null ? Number(m.lat) : null,
        lng: m.lng != null ? Number(m.lng) : null,
      }))
      // presets_enc/settings_enc are each a single encrypted JSON blob
      // (2026-07-27), not per-field like the rows above — decrypt once,
      // then parse, same as api.matrix.presets()/api.settings.get().
      const presetsJson = await decryptValue(data.presets_enc)
      const presets = presetsJson ? (() => { try { return JSON.parse(presetsJson) } catch { return [] } })() : []
      const settingsJson = await decryptValue(data.settings_enc)
      const settings = settingsJson ? (() => { try { return JSON.parse(settingsJson) } catch { return {} } })() : {}
      return { ...data, teams, persons, vehicles, markers: markersFixed, presets, settings }
    },
    // mode: 'replace' (default — wipes this room's data first, preserving
    // ids so cross-references survive) or 'merge' (keeps existing rows and
    // re-ids the incoming ones so nothing collides).
    import: async (data, mode = 'replace') => {
      const [teams, persons, vehicles, markers, presets_enc, settings_enc] = await Promise.all([
        Promise.all((data.teams || []).map(r => encFields(r, TEAM_ENC))),
        Promise.all((data.persons || []).map(r => encFields(r, PERSON_ENC))),
        Promise.all((data.vehicles || []).map(r => encFields(r, VEHICLE_ENC))),
        Promise.all((data.markers || []).map(r => encFields(r, MARKER_ENC))),
        Array.isArray(data.presets) ? encryptValue(JSON.stringify(data.presets)) : null,
        data.settings && typeof data.settings === 'object' ? encryptValue(JSON.stringify(data.settings)) : null,
      ])
      const payload = { ...data, teams, persons, vehicles, markers, presets_enc, settings_enc }
      return backend.post(`/backup/import?mode=${encodeURIComponent(mode)}`, payload)
    },
  },

  teams: {
    list: async () => {
      const [teamsRaw, personsRaw, vehiclesRaw] = await Promise.all([
        teamsStore.list(), personsStore.list(), vehiclesStore.list(),
      ])
      const [teams, persons, vehicles] = await Promise.all([
        decRows(teamsRaw, TEAM_ENC),
        decRows(personsRaw, PERSON_ENC),
        decRows(vehiclesRaw, VEHICLE_ENC),
      ])
      return teams.map(t => {
        const teamPersons = persons.filter(p => String(p.team_id) === String(t.id))
        const teamVehicles = vehicles.filter(v => String(v.team_id) === String(t.id))
        return { ...t, persons: teamPersons, vehicles: teamVehicles, person_count: teamPersons.length, vehicle_count: teamVehicles.length }
      })
    },
    get: async (id) => decRow(await teamsStore.get(id), TEAM_ENC),
    create: async (data) => { const r = await teamsStore.create(await encFields(data, TEAM_ENC)); track('team_created'); return r },
    update: async (id, data) => teamsStore.update(id, await encFields(data, TEAM_ENC)),
    delete: (id) => teamsStore.delete(id),

    // Room-membership-based roster sync (syncMembersFromRooms /
    // persons.importFromRoom / persons.syncFromRoom) was removed 2026-08-10
    // — see CHANGES.md "Decouple team roster from room membership". Team
    // membership is now a plain manual persons.team_id assignment (see
    // Database.jsx's PersonModal Team select); team.room_id is kept only as
    // an optional broadcast target (api.matrix.broadcast()).
  },

  persons: {
    list: async () => withTeamInfo(await decRows(await personsStore.list(), PERSON_ENC), await decRows(await teamsStore.list(), TEAM_ENC)),
    get: async (id) => decRow(await personsStore.get(id), PERSON_ENC),
    create: async (data) => { const r = await personsStore.create(await encFields(data, PERSON_ENC)); track('person_created'); return r },
    update: async (id, data) => personsStore.update(id, await encFields(data, PERSON_ENC)),
    delete: (id) => personsStore.delete(id),

    // importFromRoom / syncFromRoom (room-membership-driven team roster)
    // removed 2026-08-10 — see CHANGES.md "Decouple team roster from room
    // membership". Assign a person to a team by hand instead: set their
    // team_id via update() (Database.jsx's PersonModal Team select does
    // this directly).
    uploadImage: async (id, file) => {
      // image_mxc isn't a secret (it's an opaque media URI), so no encryption
      // — and this partial update carries only image_mxc, so encFields would
      // no-op on the sensitive fields anyway.
      const image_mxc = await uploadMedia(file, file.name, file.type)
      await personsStore.update(id, { image_mxc })
      return { image_mxc }
    },
    // Async now (2026-07-23) — this homeserver requires an authenticated
    // fetch for media (see matrixStore.js's fetchAuthedMediaUrl()), so this
    // can no longer be a synchronous "build a URL string" call. Callers need
    // a useEffect/useState, not a direct render-time call.
    imageUrl: (imageMxc) => fetchAuthedMediaUrl(imageMxc),
  },

  vehicles: {
    list: async () => withTeamInfo(await decRows(await vehiclesStore.list(), VEHICLE_ENC), await decRows(await teamsStore.list(), TEAM_ENC)),
    get: async (id) => decRow(await vehiclesStore.get(id), VEHICLE_ENC),
    create: async (data) => { const r = await vehiclesStore.create(await encFields(data, VEHICLE_ENC)); track('vehicle_created'); return r },
    update: async (id, data) => vehiclesStore.update(id, await encFields(data, VEHICLE_ENC)),
    delete: (id) => vehiclesStore.delete(id),
    uploadImage: async (id, file) => {
      const image_mxc = await uploadMedia(file, file.name, file.type)
      await vehiclesStore.update(id, { image_mxc })
      return { image_mxc }
    },
    // Async now (2026-07-23) — this homeserver requires an authenticated
    // fetch for media (see matrixStore.js's fetchAuthedMediaUrl()), so this
    // can no longer be a synchronous "build a URL string" call. Callers need
    // a useEffect/useState, not a direct render-time call.
    imageUrl: (imageMxc) => fetchAuthedMediaUrl(imageMxc),
  },

  markers: {
    list: async () => {
      const [markersRaw, personsRaw, vehiclesRaw, teamsRaw] = await Promise.all([
        markersStore.list(), personsStore.list(), vehiclesStore.list(), teamsStore.list(),
      ])
      // Decrypt everything before the join — the person/vehicle sensitive
      // fields (matrix_id, phone, license_plate) get surfaced on the marker
      // for MapBoard's popup, so they have to be plaintext by the time they're
      // attached, and marker notes are encrypted too. Teams need the same
      // treatment now that name/description are encrypted (2026-07-27) —
      // team.name below was silently coming back as ciphertext/undefined
      // before this was added.
      const [markersDecrypted, persons, vehicles, teams] = await Promise.all([
        decRows(markersRaw, MARKER_ENC),
        decRows(personsRaw, PERSON_ENC),
        decRows(vehiclesRaw, VEHICLE_ENC),
        decRows(teamsRaw, TEAM_ENC),
      ])
      // decryptValue() always returns a STRING (or the untouched mx1: blob,
      // or null) — lat/lng need to be real numbers again for Leaflet/every
      // other consumer now that the true plaintext coordinate is in hand.
      // The backend can't do this Number() conversion itself (routes/
      // markers.js's toRow() might only ever see an un-decryptable mx1:
      // blob for a client-encrypted row) — has to happen here, after OUR
      // decrypt pass actually produced the real value.
      const markers = markersDecrypted.map(m => ({
        ...m,
        lat: m.lat != null ? Number(m.lat) : null,
        lng: m.lng != null ? Number(m.lng) : null,
      }))
      const personById = Object.fromEntries(persons.map(p => [String(p.id), p]))
      const vehicleById = Object.fromEntries(vehicles.map(v => [String(v.id), v]))
      const teamById = Object.fromEntries(teams.map(t => [String(t.id), t]))

      return markers.map(m => {
        const person = m.entity_type === 'person' && m.entity_id ? personById[String(m.entity_id)] : null
        const vehicle = m.entity_type === 'vehicle' && m.entity_id ? vehicleById[String(m.entity_id)] : null
        const team = person?.team_id ? teamById[String(person.team_id)] : vehicle?.team_id ? teamById[String(vehicle.team_id)] : null
        // Person/vehicle markers never had their own `label` in the DB (only
        // misc markers get one, typed in at creation) — the map/popup used to
        // just show "—" for them. Derive a display label from the linked
        // entity's own name so it's always shown, regardless of whether a
        // note was also set.
        const label = person ? person.name
          : vehicle ? `${vehicle.make} ${vehicle.model}`
          : m.label
        return {
          ...m,
          label,
          team_name: team?.name || null,
          team_color: team?.color || null,
          matrix_id: person?.matrix_id || null,
          phone: person?.phone || null,
          // Recipient routing for the marker popup's Message/Location
          // actions (MapBoard.jsx's MessageQuick + SendLocationModal) — the
          // linked person's own DM room and their team's broadcast room, so
          // those modals can offer "Direct message" / "Team" / "Ops room" as
          // real send targets instead of always posting into whatever room
          // the widget happens to be open in.
          dm_room_id: person?.dm_room_id || null,
          team_room_id: team?.room_id || null,
          license_plate: vehicle?.license_plate || null,
          // MapBoard's makeIcon() reads marker.vehicle_type to pick the car vs
          // motorcycle glyph — without this a motorcycle marker silently
          // rendered with the default car icon. `m.vehicle_type` (own column,
          // added 2026-07-26) is the fallback for a misc marker tagged via
          // vehicleCommands.js's \car/\motorcycle command, which has no
          // linked vehicles row to read `.type` off of.
          vehicle_type: vehicle?.type || m.vehicle_type || null,
          linked_vehicle: person ? vehicles.find(v => String(v.person_id) === String(person.id))?.make : null,
          linked_person: vehicle?.person_id ? personById[String(vehicle.person_id)]?.name : null,
          // The linked person's/vehicle's own photo (not a secret — see
          // persons.uploadImage()'s comment above) — lets MapBoard.jsx show
          // it on the pin itself via api.media.url() instead of the plain
          // colored teardrop + emoji glyph.
          image_mxc: person?.image_mxc || vehicle?.image_mxc || null,
        }
      })
    },
    // lat/lng go in as plain JS numbers — encryptValue() (roomCrypto.js)
    // coerces via String(plaintext) internally, so encFields needs no
    // special-casing to encrypt a number vs. a string field.
    create: async (data) => { const r = await markersStore.create(await encFields(data, MARKER_ENC)); track('marker_created'); return r },
    update: async (id, data) => markersStore.update(id, await encFields(data, MARKER_ENC)),
    delete: async (id) => { const r = await markersStore.delete(id); track('marker_deleted'); return r },
    clearAll: () => markersStore.clearAll(),
  },

  // Matrix messaging — the only messaging transport CrewBoard has. Everything
  // is posted as an event in the single room the widget is added to; there is
  // no separate DM/bot layer, no phone-number routing, and no signal-cli.
  // Room membership, invites, and E2EE device verification are handled
  // natively by Element itself — CrewBoard doesn't reimplement them.
  matrix: {
    status: () => Promise.resolve({ connected: true }),

    // Presets are client-side encrypted as ONE JSON blob (2026-07-27) — the
    // whole array goes in/out of presetsStore as a single `items_enc`
    // string, decrypted+parsed here so every existing caller (MatrixHub.jsx,
    // Database.jsx, Settings.jsx, Teams.jsx) keeps seeing a plain array,
    // unaware anything changed underneath.
    presets: async () => {
      const { items_enc } = await presetsStore.list()
      const json = await decryptValue(items_enc)
      if (!json) return []
      try { return JSON.parse(json) } catch { return [] }
    },
    updatePresets: async (items) => {
      const items_enc = await encryptValue(JSON.stringify(items || []))
      await presetsStore.update(items_enc)
      return items
    },

    inbox: () => readInbox(),
    locations: () => readBeacons(),

    // Homeserver user directory search (MSC3973), used by the "Add person"
    // form's search-as-you-type. Progressive enhancement — throws if
    // Element/the homeserver doesn't support MSC3973, callers should catch
    // and fall back to manual name/Matrix ID entry.
    searchUsers: (searchTerm, limit) => searchUserDirectory(searchTerm, limit),
    userAvatarUrl: (mxc) => fetchAuthedMediaUrl(mxc), // async now, see imageUrl above

    // Best-effort detection of an existing 1:1 DM room with a Matrix user, so
    // the Person form can auto-fill dm_room_id (see matrixStore.js's
    // findDmRoom for the heuristic + why account data can't be read directly).
    // selfUserId is the caller's own verified user id (api.whoami().user_id).
    findDmRoom: (targetUserId, selfUserId) => findDmRoom(targetUserId, selfUserId),

    // Lists the rooms the dispatcher is joined to, for the Teams editor's
    // broadcast-room picker (choose an existing room instead of pasting an id).
    // Returns [{ room_id, name, member_count, members, encrypted, is_dm }].
    listRooms: () => listJoinedRooms(),

    // Direct message to a specific person. Sends a genuine private message
    // into their linked DM room (dm_room_id) when one's been set up — see
    // messaging_architecture_plan.md — otherwise falls back to the original
    // tagged message in the shared ops room so nothing regresses for
    // not-yet-linked people.
    send: ({ matrix_id, person_name, dm_room_id, body }) => {
      track('message_sent')
      return dm_room_id
        ? sendMessage(body, {}, dm_room_id)
        : sendMessage(`@${person_name || matrix_id || 'crew'}: ${body}`, {
            'org.crewboard.target_matrix_id': matrix_id || null,
          })
    },

    // Bulk direct message (2026-08-10) — fans the same message into several
    // people's own DM rooms individually (Database.jsx's multi-select "Send
    // direct message" action), NOT a single shared broadcast room. Only
    // targets persons with a linked dm_room_id — same rule as the per-person
    // DM button (Database.jsx disables it without one, no tagged-room
    // fallback here either, since a bulk send to a fallback tag in the
    // shared room would just spam it once per recipient for no benefit).
    // Sequential with rate-limit backoff (sendRoomEventToRooms in
    // matrixStore.js — never Promise.all, see that function's own comment)
    // since Synapse's rc_message limit is per-sender, not per-room; blasting
    // N people's DMs at once from one dispatcher account risks
    // M_LIMIT_EXCEEDED partway through. onProgress (optional) is forwarded
    // straight through for a progress bar. Returns { sent, failed, skipped }
    // — `skipped` counts persons with no dm_room_id at all (never attempted).
    sendBulkDirect: async ({ persons, body, onProgress }) => {
      const targets = (persons || []).filter(p => p.dm_room_id)
      const roomIds = targets.map(p => p.dm_room_id)
      const { ok, failed } = await sendRoomEventToRooms(
        'm.room.message', { msgtype: 'm.text', body }, roomIds, { onProgress }
      )
      track('bulk_message_sent')
      return { sent: ok.length, failed, skipped: (persons || []).length - targets.length }
    },

    // Team broadcast. Sends into the team's linked room (private, E2EE) when
    // one's been set up; otherwise falls back to the tagged ops-room message.
    broadcast: ({ team_id, team_name, room_id, body }) => {
      track('broadcast_sent')
      return room_id
        ? sendMessage(`📢 ${body}`, {}, room_id)
        : sendMessage(`📢 ${team_name ? `[${team_name}] ` : ''}${body}`, {
            'org.crewboard.target_team_id': team_id ?? null,
          })
    },

    broadcastAll: ({ body }) => { track('broadcast_sent'); return sendMessage(`📢 [All crew] ${body}`) },

    // Bug fix (2026-07-27): this used to always post into whatever room the
    // widget instance happens to be running in, with no way to choose a
    // recipient — same bug class as sendScreenshot() above. Now takes an
    // optional `{ target, recipientPerson, recipientTeam }`, routing exactly
    // like send()/broadcast()/sendScreenshot() already do: 'person' goes to
    // recipientPerson.dm_room_id (or the shared room if none is linked yet),
    // 'team' goes to recipientTeam.room_id (same fallback), and omitting
    // target/passing anything else keeps the original behavior — post into
    // the widget's own room.
    // Bug fix (2026-08-09): this used to send a custom org.crewboard.contact
    // STATE... actually room *event* type that only CrewBoard itself knew how
    // to render — invisible/useless in plain Element or any other Matrix
    // client, same class of bug sendLocation() fixed for locations on
    // 2026-08-02. Now sends a real m.room.message (msgtype: 'm.text') with a
    // plain-text body plus an HTML formatted_body (bolded name, one field per
    // line) — any Matrix client renders this natively, no CrewBoard-specific
    // event type required. Routing (linked DM/team room vs. tagged fallback
    // in the current room) is unchanged from before. Doesn't include the
    // photo (image_mxc) — a contact card with just name/phone/matrix
    // id/team is the common case; MatrixHub.jsx's EventRow still has a
    // read-only legacy branch for org.crewboard.contact so old room history
    // sent before this fix still renders correctly.
    sendContact: (person, { target, recipientPerson, recipientTeam } = {}) => {
      const fields = [
        ['Phone', person.phone],
        ['Matrix ID', person.matrix_id],
        ['Team', person.team_name],
      ].filter(([, value]) => !!value)

      const body = [`Contact: ${person.name}`, ...fields.map(([label, value]) => `${label}: ${value}`)].join('\n')
      const formatted_body = [
        `Contact: <strong>${escapeHtml(person.name)}</strong>`,
        ...fields.map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`),
      ].join('<br/>')
      const extra = { format: 'org.matrix.custom.html', formatted_body }

      if (target === 'person') {
        return recipientPerson?.dm_room_id
          ? sendMessage(body, extra, recipientPerson.dm_room_id)
          : sendMessage(body, { ...extra, 'org.crewboard.target_matrix_id': recipientPerson?.matrix_id || null })
      }

      if (target === 'team') {
        return recipientTeam?.room_id
          ? sendMessage(body, extra, recipientTeam.room_id)
          : sendMessage(body, { ...extra, 'org.crewboard.target_team_id': recipientTeam?.id ?? null })
      }

      return sendMessage(body, extra)
    },

    sendVehicleCard: (vehicle) =>
      sendRoomEvent('org.crewboard.vehicle-card', {
        vehicle_id: vehicle.id,
        make: vehicle.make,
        model: vehicle.model,
        license_plate: vehicle.license_plate || null,
        team_name: vehicle.team_name || null,
        image_mxc: vehicle.image_mxc || null,
      }),

    // Bug fix (2026-07-27): this used to ignore any recipient entirely —
    // always called sendRoomEvent() with no roomId, posting into whatever
    // room the widget instance happens to be running in. Now takes an
    // optional `{ target, recipientPerson, recipientTeam }`, same
    // routing/fallback pattern as sendContact()/sendScreenshot() above:
    // 'person' → recipientPerson.dm_room_id (or tagged fallback), 'team' →
    // recipientTeam.room_id (or tagged fallback), anything else (including
    // omitted) keeps the original "post into the current room" behavior.
    // Bug fix (2026-08-02): this used to send a custom org.crewboard.location
    // event that only CrewBoard itself knew how to render — invisible/useless
    // in plain Element. Now sends a real m.room.message with
    // msgtype: 'm.location' (body: "<label> at <lat>, <lng>", plus geo_uri
    // and the MSC3488 location fields Element understands natively), and a
    // second, separate m.text message with the label bolded, so the location
    // shows up as two normal, readable messages in any Matrix client, not
    // just as a special-cased CrewBoard event. Routing (linked DM/team room
    // vs. tagged fallback in the current room) is unchanged from before.
    sendLocation: (marker, { target, recipientPerson, recipientTeam } = {}) => {
      track('location_shared')
      const label = marker.label || 'Marker'
      const geoUri = `geo:${marker.lat},${marker.lng}`
      const body = `${label} at ${marker.lat}, ${marker.lng}`

      const locationExtra = {
        msgtype: 'm.location',
        geo_uri: geoUri,
        'org.matrix.msc3488.location': { uri: geoUri, description: label },
        'org.matrix.msc3488.asset': { type: 'm.pin' },
      }
      // entity_type is 'person' | 'vehicle' | 'misc' (see markers.list()'s
      // join above) — included so the bolded label reads e.g. "Location of
      // person John" / "vehicle Toyota Camry" / "misc Festival entrance",
      // not just the bare label.
      const typeLabel = marker.entity_type || 'misc'
      const taggedLabel = `${typeLabel} ${label}`
      const boldBody = `Location of ${taggedLabel}`
      const boldExtra = {
        format: 'org.matrix.custom.html',
        formatted_body: `Location of <strong>${taggedLabel}</strong>`,
      }

      function sendBoth(roomId, tag) {
        const locExtra = tag ? { ...locationExtra, ...tag } : locationExtra
        const boldExtraTagged = tag ? { ...boldExtra, ...tag } : boldExtra
        return sendMessage(body, locExtra, roomId).then(() =>
          sendMessage(boldBody, boldExtraTagged, roomId)
        )
      }

      if (target === 'person') {
        return recipientPerson?.dm_room_id
          ? sendBoth(recipientPerson.dm_room_id)
          : sendBoth(undefined, { 'org.crewboard.target_matrix_id': recipientPerson?.matrix_id || null })
      }

      if (target === 'team') {
        return recipientTeam?.room_id
          ? sendBoth(recipientTeam.room_id)
          : sendBoth(undefined, { 'org.crewboard.target_team_id': recipientTeam?.id ?? null })
      }

      return sendBoth(undefined)
    },

    // Bug fix (2026-07-27): this used to ignore the "Send to" selection
    // entirely — it always called sendRoomEvent() with no roomId, which
    // falls back to whatever room the widget instance is currently running
    // in (see sendRoomEvent's `roomId || getRoomId()` in matrixStore.js).
    // For "One person" that's wrong the same way api.matrix.send() already
    // guards against: it needs to go into the person's linked DM room
    // (dm_room_id), not the room CrewBoard happens to be open in. Mirrors
    // send()/broadcast()'s existing person/team room-routing logic exactly.
    //
    // "All teams" (renamed from "Everyone" — 2026-07-27: the old label
    // implied it reached every crew member directly, but it only ever
    // posted once into whichever room the widget was running in) now
    // actually fans the screenshot out to the ops room PLUS every team's
    // linked broadcast room, one at a time with rate-limit retry/backoff
    // (sendRoomEventToRooms in matrixStore.js) rather than in parallel —
    // Synapse's rc_message rate limit is per-sender, so blasting N rooms at
    // once from one dispatcher account risks M_LIMIT_EXCEEDED.
    sendScreenshot: async ({ imageBlob, caption, target, person, team, teams }) => {
      const mxc = await uploadMedia(imageBlob, 'crewboard-screenshot.png', 'image/png')
      const content = {
        msgtype: 'm.image',
        body: caption || 'Current crew distribution',
        url: mxc,
      }

      if (target === 'person') {
        return person?.dm_room_id
          ? sendRoomEvent('m.room.message', content, person.dm_room_id)
          : sendRoomEvent('m.room.message', {
              ...content,
              'org.crewboard.target_matrix_id': person?.matrix_id || null,
            })
      }

      if (target === 'team') {
        return team?.room_id
          ? sendRoomEvent('m.room.message', content, team.room_id)
          : sendRoomEvent('m.room.message', {
              ...content,
              'org.crewboard.target_team_id': team?.id ?? null,
            })
      }

      // target === 'all' ("All teams"): ops room (undefined roomId =
      // sendRoomEvent's own-room default) + every team that has a linked
      // room. Teams with no linked room still see it via the ops room post,
      // same as their tagged-message fallback elsewhere.
      const teamRooms = (teams || []).filter(t => t.room_id).map(t => ({ roomId: t.room_id, label: t.name }))
      const roomIds = [undefined, ...teamRooms.map(t => t.roomId)]
      const { ok, failed } = await sendRoomEventToRooms('m.room.message', content, roomIds)
      if (failed.length > 0) {
        const labelFor = (roomId) =>
          roomId === undefined ? 'ops room' : (teamRooms.find(t => t.roomId === roomId)?.label || roomId)
        throw new Error(
          `Sent to ${ok.length}/${roomIds.length} rooms — failed: ${failed.map(f => labelFor(f.roomId)).join(', ')}`
        )
      }
      return { ok, failed }
    },
  },

  // Settings (map view state) are client-side encrypted as ONE JSON blob
  // (2026-07-27), same treatment as presets above. IMPORTANT behavior
  // change: settings.patch() on the backend used to do a server-side
  // field-level merge (`{ ...existing, ...req.body }`) — it can't anymore,
  // since all it ever sees is ciphertext it can't read the fields of. update()
  // here does the read-decrypt-merge-encrypt cycle itself instead and sends
  // the whole already-merged blob. MapBoard.jsx calls this with small
  // partial updates (`{ mapCenter, mapZoom }`) on every pan/zoom — same
  // call shape as before, this trade-off is invisible to callers except for
  // one thing worth knowing: two tabs updating settings around the same
  // moment can now race (last write wins) where the old server-side merge
  // was atomic per-request. Acceptable for map view state.
  settings: {
    get: async () => {
      const { data_enc } = await settingsStore.get()
      const json = await decryptValue(data_enc)
      if (!json) return {}
      try { return JSON.parse(json) } catch { return {} }
    },
    update: async (partial) => {
      const current = await api.settings.get()
      const merged = { ...current, ...partial }
      const data_enc = await encryptValue(JSON.stringify(merged))
      await settingsStore.update(data_enc)
      return merged
    },
  },
}
