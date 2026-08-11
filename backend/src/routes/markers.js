import { Router } from 'express'
import { pool } from '../db.js'
import { newId } from '../ids.js'
import { encryptField, decryptField } from '../crypto.js'
import { requireRoomWriter } from '../auth.js'

const router = Router()

// lat/lng/label are encrypted columns now (2026-07-27) — lat_enc/lng_enc/
// label_enc TEXT, not the old DOUBLE PRECISION/TEXT plaintext columns. This
// route hands back whatever decryptField() gives (a real decrypted string
// for legacy/backend-encrypted rows, or the untouched `mx1:` ciphertext for
// client-encrypted ones — the frontend's roomCrypto.js does the real
// decrypt for those, same pattern as `note` below always used). lat/lng
// come back as STRINGS here either way; frontend/src/api.js converts back to
// Number() after its own decrypt pass, since this route can't tell a
// client-encrypted value's true numeric form until the frontend decrypts it.
//
// Per-room scoping (2026-07-21): every query below is filtered by
// owner_room_id = req.roomId, so a room's widget only ever sees its own
// markers. Writes additionally require power level 50+ in that room
// (requireRoomWriter, see auth.js).
function toRow(r, roomId) {
  return {
    id: r.id,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    lat: decryptField(r.lat_enc, roomId),
    lng: decryptField(r.lng_enc, roomId),
    locked: r.locked,
    label: decryptField(r.label_enc, roomId),
    note: decryptField(r.note_enc, roomId),
    color: r.color,
    // Ad hoc car/motorcycle tag for a misc marker with no linked vehicles
    // row (see db.js's 2026-07-26 migration + frontend/src/vehicleCommands.js's
    // \car/\motorcycle command) — plain column, not encrypted, same
    // treatment as `color`.
    vehicle_type: r.vehicle_type,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  }
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM markers WHERE owner_room_id = $1 ORDER BY created_at ASC',
    [req.roomId]
  )
  res.json(rows.map(r => toRow(r, req.roomId)))
})

router.post('/', requireRoomWriter(), async (req, res) => {
  const { entity_type, entity_id, lat, lng, locked, label, note, color, vehicle_type } = req.body
  if (!entity_type || lat == null || lng == null) {
    return res.status(400).json({ error: 'entity_type, lat, and lng are required' })
  }
  const id = newId()
  const now = Date.now()
  const { rows } = await pool.query(
    `INSERT INTO markers (id, entity_type, entity_id, lat_enc, lng_enc, locked, label_enc, note_enc, color, vehicle_type, owner_room_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING *`,
    [id, entity_type, entity_id ?? null, encryptField(lat, req.roomId), encryptField(lng, req.roomId), !!locked,
     encryptField(label, req.roomId), encryptField(note, req.roomId), color || null, vehicle_type || null, req.roomId, now]
  )
  res.status(201).json(toRow(rows[0], req.roomId))
})

router.put('/:id', requireRoomWriter(), async (req, res) => {
  // owner_room_id is in the WHERE clause, not just the SELECT — a marker in
  // another room must 404 here rather than being mutated by a user who
  // happens to be an admin of some unrelated room.
  const { rows: existingRows } = await pool.query(
    'SELECT * FROM markers WHERE id = $1 AND owner_room_id = $2',
    [req.params.id, req.roomId]
  )
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' })
  const existing = toRow(existingRows[0], req.roomId)

  const merged = { ...existing, ...req.body }
  const now = Date.now()
  const { rows } = await pool.query(
    `UPDATE markers SET
       entity_type = $2, entity_id = $3, lat_enc = $4, lng_enc = $5, locked = $6,
       label_enc = $7, note_enc = $8, color = $9, vehicle_type = $10, updated_at = $11
     WHERE id = $1 AND owner_room_id = $12 RETURNING *`,
    [req.params.id, merged.entity_type, merged.entity_id ?? null, encryptField(merged.lat, req.roomId),
     encryptField(merged.lng, req.roomId), !!merged.locked, encryptField(merged.label, req.roomId),
     encryptField(merged.note, req.roomId), merged.color || null, merged.vehicle_type || null, now, req.roomId]
  )
  res.json(toRow(rows[0], req.roomId))
})

router.delete('/:id', requireRoomWriter(), async (req, res) => {
  await pool.query('DELETE FROM markers WHERE id = $1 AND owner_room_id = $2', [req.params.id, req.roomId])
  res.json({ ok: true })
})

router.delete('/', requireRoomWriter(), async (req, res) => {
  // Bulk clear-all — replaces the old client-side "list then delete each"
  // loop in api.js's markers.clearAll(), now a single statement. Scoped to
  // this room only: an admin clearing their own board must never wipe
  // another room's markers.
  await pool.query('DELETE FROM markers WHERE owner_room_id = $1', [req.roomId])
  res.json({ ok: true })
})

export default router
