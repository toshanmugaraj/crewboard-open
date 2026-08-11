import { Router } from 'express'
import { pool } from '../db.js'
import { newId } from '../ids.js'
import { encryptField, decryptField } from '../crypto.js'
import { requireRoomWriter } from '../auth.js'

const router = Router()

// Per-room scoping (2026-07-21): rows belong to one room (owner_room_id).
// make/model/type/license_plate are all encrypted columns (make_enc/
// model_enc/type_enc/license_plate_enc, 2026-07-27 for the first three) with
// that room's derived key as the backend fallback — see crypto.js. Reads are
// open to any room member; writes need power level 50+ (see auth.js).
function toRow(r, roomId) {
  return {
    id: r.id,
    make: decryptField(r.make_enc, roomId),
    model: decryptField(r.model_enc, roomId),
    type: decryptField(r.type_enc, roomId),
    license_plate: decryptField(r.license_plate_enc, roomId),
    team_id: r.team_id,
    person_id: r.person_id,
    image_mxc: r.image_mxc,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  }
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM vehicles WHERE owner_room_id = $1 ORDER BY created_at ASC',
    [req.roomId]
  )
  res.json(rows.map(r => toRow(r, req.roomId)))
})

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM vehicles WHERE id = $1 AND owner_room_id = $2',
    [req.params.id, req.roomId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(toRow(rows[0], req.roomId))
})

router.post('/', requireRoomWriter(), async (req, res) => {
  const { make, model, type, license_plate, team_id, person_id, image_mxc } = req.body
  if (!make || !model) return res.status(400).json({ error: 'make and model are required' })
  const id = newId()
  const now = Date.now()
  const { rows } = await pool.query(
    `INSERT INTO vehicles (id, make_enc, model_enc, type_enc, license_plate_enc, team_id, person_id, image_mxc, owner_room_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *`,
    [id, encryptField(make, req.roomId), encryptField(model, req.roomId), encryptField(type || 'car', req.roomId),
     encryptField(license_plate, req.roomId), team_id || null, person_id || null, image_mxc || null, req.roomId, now]
  )
  res.status(201).json(toRow(rows[0], req.roomId))
})

router.put('/:id', requireRoomWriter(), async (req, res) => {
  const { rows: existingRows } = await pool.query(
    'SELECT * FROM vehicles WHERE id = $1 AND owner_room_id = $2',
    [req.params.id, req.roomId]
  )
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' })
  const existing = toRow(existingRows[0], req.roomId)

  const merged = { ...existing, ...req.body }
  const now = Date.now()
  const { rows } = await pool.query(
    `UPDATE vehicles SET
       make_enc = $2, model_enc = $3, type_enc = $4, license_plate_enc = $5,
       team_id = $6, person_id = $7, image_mxc = $8, updated_at = $9
     WHERE id = $1 AND owner_room_id = $10 RETURNING *`,
    [req.params.id, encryptField(merged.make, req.roomId), encryptField(merged.model, req.roomId),
     encryptField(merged.type, req.roomId), encryptField(merged.license_plate, req.roomId),
     merged.team_id || null, merged.person_id || null, merged.image_mxc || null, now, req.roomId]
  )
  res.json(toRow(rows[0], req.roomId))
})

router.delete('/:id', requireRoomWriter(), async (req, res) => {
  await pool.query('DELETE FROM vehicles WHERE id = $1 AND owner_room_id = $2', [req.params.id, req.roomId])
  res.json({ ok: true })
})

export default router
