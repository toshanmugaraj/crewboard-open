// ── Export / import a room's CrewBoard data as JSON ─────────────────────────
// Exports everything scoped to the caller's room: teams, persons, vehicles,
// and markers (plus presets/settings, which are cheap to include and make a
// backup genuinely complete). Import restores that same shape.
//
// Values come out DECRYPTED — this is a user-facing backup file, so the
// whole point is that it's readable and re-importable elsewhere. That means
// an export contains phone numbers, Matrix IDs, license plates and marker
// notes in the clear, which is exactly why the export route requires power
// level 50+ rather than being open to every room member: it's a bulk
// exfiltration path for precisely the fields the rest of this backend
// bothers to encrypt at rest.
import { Router } from 'express'
import { pool } from '../db.js'
import { newId } from '../ids.js'
import { encryptField, decryptField } from '../crypto.js'
import { requireRoomWriter } from '../auth.js'

const router = Router()

const FORMAT = 'crewboard-backup'
const FORMAT_VERSION = 1

router.get('/export', requireRoomWriter(), async (req, res) => {
  const roomId = req.roomId
  const q = (sql) => pool.query(sql + ' WHERE owner_room_id = $1 ORDER BY created_at ASC', [roomId])

  const [teams, persons, vehicles, markers, presets, settings] = await Promise.all([
    q('SELECT * FROM teams'),
    q('SELECT * FROM persons'),
    q('SELECT * FROM vehicles'),
    q('SELECT * FROM markers'),
    pool.query('SELECT items_enc FROM presets WHERE id = $1', [roomId]),
    pool.query('SELECT data_enc FROM settings WHERE id = $1', [roomId]),
  ])

  // Every _enc field below goes out as whatever decryptField() gives —
  // a real decrypted value for a legacy/backend-encrypted row, or the
  // untouched `mx1:` ciphertext for a client-encrypted one. This route
  // can't do more than that; api.js's backup.export() runs a SECOND,
  // client-side decrypt pass (roomCrypto.js, which actually holds the room
  // key) over everything below to turn it into the genuinely-plaintext,
  // human-readable backup file the user sees. Same two-stage pattern
  // markers/persons/vehicles/teams already used before presets/settings
  // joined the encrypted set.
  res.json({
    format: FORMAT,
    version: FORMAT_VERSION,
    exported_at: Date.now(),
    room_id: roomId,
    teams: teams.rows.map(r => ({
      id: r.id, name: decryptField(r.name_enc, roomId), description: decryptField(r.description_enc, roomId), color: r.color,
      room_id: decryptField(r.room_id_enc, roomId),
      created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    })),
    persons: persons.rows.map(r => ({
      id: r.id, name: r.name,
      phone: decryptField(r.phone_enc, roomId),
      matrix_id: decryptField(r.matrix_id_enc, roomId),
      dm_room_id: decryptField(r.dm_room_id_enc, roomId),
      team_id: r.team_id, image_mxc: r.image_mxc,
      created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    })),
    vehicles: vehicles.rows.map(r => ({
      id: r.id, make: decryptField(r.make_enc, roomId), model: decryptField(r.model_enc, roomId), type: decryptField(r.type_enc, roomId),
      license_plate: decryptField(r.license_plate_enc, roomId),
      team_id: r.team_id, person_id: r.person_id, image_mxc: r.image_mxc,
      created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    })),
    markers: markers.rows.map(r => ({
      id: r.id, entity_type: r.entity_type, entity_id: r.entity_id,
      lat: decryptField(r.lat_enc, roomId), lng: decryptField(r.lng_enc, roomId), locked: r.locked, label: decryptField(r.label_enc, roomId),
      note: decryptField(r.note_enc, roomId), color: r.color, vehicle_type: r.vehicle_type,
      created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    })),
    presets_enc: decryptField(presets.rows[0]?.items_enc, roomId),
    settings_enc: decryptField(settings.rows[0]?.data_enc, roomId),
  })
})

/** POST /api/backup/import?mode=replace|merge
 *
 *  replace (default) — wipes this room's existing teams/persons/vehicles/
 *    markers first, then inserts the file's contents, preserving their
 *    original ids so cross-references (marker.entity_id -> person.id,
 *    vehicle.person_id, *.team_id) survive intact.
 *  merge — keeps existing rows and inserts the file's under FRESH ids,
 *    remapping every cross-reference so an import can't collide with or
 *    silently overwrite anything already in the room.
 *
 *  Runs in a transaction: a malformed file rolls the whole thing back
 *  rather than leaving the room half-imported.
 */
router.post('/import', requireRoomWriter(), async (req, res) => {
  const roomId = req.roomId
  const body = req.body || {}

  if (body.format !== FORMAT) {
    return res.status(400).json({ error: `Not a CrewBoard backup file (expected format "${FORMAT}")` })
  }
  if (body.version !== FORMAT_VERSION) {
    return res.status(400).json({ error: `Unsupported backup version ${body.version} (this server reads version ${FORMAT_VERSION})` })
  }

  const mode = req.query.mode === 'merge' ? 'merge' : 'replace'
  const teams = Array.isArray(body.teams) ? body.teams : []
  const persons = Array.isArray(body.persons) ? body.persons : []
  const vehicles = Array.isArray(body.vehicles) ? body.vehicles : []
  const markers = Array.isArray(body.markers) ? body.markers : []

  // Whether to keep the file's original row ids. IDs are a GLOBAL primary
  // key (not per-room), so preserving them only works when restoring into
  // the SAME room the export came from — deleting that room's rows first
  // (replace mode) clears the way. Importing into a DIFFERENT room must
  // re-id everything, otherwise the insert collides with the source room's
  // rows, which still exist (that's the "duplicate key ... teams_pkey"
  // error). So: preserve ids only for a same-room replace; regenerate (and
  // remap all references) in every other case, including a cross-room
  // replace and any merge.
  const sameRoom = !!body.room_id && body.room_id === roomId
  const preserveIds = mode === 'replace' && sameRoom

  // Old id -> new id, so foreign keys (person.team_id, vehicle.team_id/
  // person_id, marker.entity_id) follow the re-id. When preserving, these
  // just map an id to itself.
  const teamIdMap = new Map()
  const personIdMap = new Map()
  const vehicleIdMap = new Map()
  const mapId = (map, oldId) => (oldId == null ? null : (map.get(String(oldId)) ?? null))
  const assignId = (oldId) => (preserveIds && oldId ? oldId : newId())

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    if (mode === 'replace') {
      // Order matters: markers reference persons/vehicles, vehicles
      // reference persons/teams, persons reference teams.
      await client.query('DELETE FROM markers WHERE owner_room_id = $1', [roomId])
      await client.query('DELETE FROM vehicles WHERE owner_room_id = $1', [roomId])
      await client.query('DELETE FROM persons WHERE owner_room_id = $1', [roomId])
      await client.query('DELETE FROM teams WHERE owner_room_id = $1', [roomId])
    }

    const now = Date.now()

    for (const t of teams) {
      const id = assignId(t.id)
      teamIdMap.set(String(t.id ?? id), id)
      await client.query(
        `INSERT INTO teams (id, name_enc, description_enc, color, room_id_enc, owner_room_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, encryptField(t.name || 'Unnamed team', roomId), encryptField(t.description, roomId), t.color || null,
         encryptField(t.room_id, roomId), roomId, Number(t.created_at) || now, now]
      )
    }

    for (const p of persons) {
      const id = assignId(p.id)
      personIdMap.set(String(p.id ?? id), id)
      await client.query(
        `INSERT INTO persons (id, name, phone_enc, matrix_id_enc, dm_room_id_enc, team_id, image_mxc, owner_room_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, p.name || 'Unnamed', encryptField(p.phone, roomId), encryptField(p.matrix_id, roomId),
         encryptField(p.dm_room_id, roomId), mapId(teamIdMap, p.team_id), p.image_mxc || null,
         roomId, Number(p.created_at) || now, now]
      )
    }

    for (const v of vehicles) {
      const id = assignId(v.id)
      vehicleIdMap.set(String(v.id ?? id), id)
      await client.query(
        `INSERT INTO vehicles (id, make_enc, model_enc, type_enc, license_plate_enc, team_id, person_id, image_mxc, owner_room_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, encryptField(v.make || '—', roomId), encryptField(v.model || '—', roomId), encryptField(v.type || 'car', roomId),
         encryptField(v.license_plate, roomId), mapId(teamIdMap, v.team_id), mapId(personIdMap, v.person_id), v.image_mxc || null,
         roomId, Number(v.created_at) || now, now]
      )
    }

    for (const m of markers) {
      if (m.lat == null || m.lng == null) continue // a marker with no position isn't restorable
      const id = assignId(m.id)
      // entity_id points at a person or a vehicle depending on entity_type —
      // remap both, since ids are regenerated on any cross-room or merge
      // import (a vehicle marker left pointing at the source vehicle id would
      // otherwise dangle).
      const entityId = m.entity_type === 'person'
        ? mapId(personIdMap, m.entity_id)
        : m.entity_type === 'vehicle'
          ? mapId(vehicleIdMap, m.entity_id)
          : (m.entity_id ?? null)
      await client.query(
        `INSERT INTO markers (id, entity_type, entity_id, lat_enc, lng_enc, locked, label_enc, note_enc, color, vehicle_type, owner_room_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, m.entity_type || 'misc', entityId, encryptField(m.lat, roomId), encryptField(m.lng, roomId), !!m.locked,
         encryptField(m.label, roomId), encryptField(m.note, roomId), m.color || null, m.vehicle_type || null,
         roomId, Number(m.created_at) || now, now]
      )
    }

    // presets_enc/settings_enc: the frontend's api.backup.import() already
    // JSON-stringified + encrypted these (same client-side pass that
    // encrypts teams/persons/vehicles/markers' fields above) before this
    // request landed — encryptField() here is just the same passthrough-or-
    // fallback-encrypt treatment every other _enc column gets, not a fresh
    // encryption of plaintext JSON.
    if (body.presets_enc != null) {
      await client.query(
        `INSERT INTO presets (id, items_enc) VALUES ($2, $1)
         ON CONFLICT (id) DO UPDATE SET items_enc = $1`,
        [encryptField(body.presets_enc, roomId), roomId]
      )
    }
    if (body.settings_enc != null) {
      await client.query(
        `INSERT INTO settings (id, data_enc) VALUES ($2, $1)
         ON CONFLICT (id) DO UPDATE SET data_enc = $1`,
        [encryptField(body.settings_enc, roomId), roomId]
      )
    }

    await client.query('COMMIT')
    res.json({
      ok: true,
      mode,
      imported: {
        teams: teams.length,
        persons: persons.length,
        vehicles: vehicles.length,
        markers: markers.length,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(400).json({ error: `Import failed and was rolled back: ${e.message}` })
  } finally {
    client.release()
  }
})

export default router
