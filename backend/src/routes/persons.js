import { Router } from 'express'
import { pool } from '../db.js'
import { newId } from '../ids.js'
import { encryptField, decryptField } from '../crypto.js'
import { requireRoomWriter } from '../auth.js'

const router = Router()

// phone and matrix_id are PII — encrypted at rest (see crypto.js). name is
// intentionally left in the clear: it's needed for sorting/searching and,
// unlike a phone number or Matrix ID, isn't by itself enough to contact or
// impersonate someone.
//
// Per-room scoping (2026-07-21): rows belong to one room (owner_room_id) and
// encrypted fields use that room's derived key. Reads are open to any room
// member; writes need power level 50+ (requireRoomWriter, see auth.js).
function toRow(r, roomId) {
  return {
    id: r.id,
    name: r.name,
    phone: decryptField(r.phone_enc, roomId),
    matrix_id: decryptField(r.matrix_id_enc, roomId),
    // dm_room_id: dispatcher<->person DM room (messaging_architecture_plan.md),
    // encrypted at rest same as phone/matrix_id above.
    dm_room_id: decryptField(r.dm_room_id_enc, roomId),
    team_id: r.team_id,
    image_mxc: r.image_mxc,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  }
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM persons WHERE owner_room_id = $1 ORDER BY created_at ASC',
    [req.roomId]
  )
  res.json(rows.map(r => toRow(r, req.roomId)))
})

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM persons WHERE id = $1 AND owner_room_id = $2',
    [req.params.id, req.roomId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(toRow(rows[0], req.roomId))
})

router.post('/', requireRoomWriter(), async (req, res) => {
  const { name, phone, matrix_id, dm_room_id, team_id, image_mxc } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })
  const id = newId()
  const now = Date.now()
  const { rows } = await pool.query(
    `INSERT INTO persons (id, name, phone_enc, matrix_id_enc, dm_room_id_enc, team_id, image_mxc, owner_room_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
    [id, name, encryptField(phone, req.roomId), encryptField(matrix_id, req.roomId),
     encryptField(dm_room_id, req.roomId), team_id || null, image_mxc || null, req.roomId, now]
  )
  res.status(201).json(toRow(rows[0], req.roomId))
})

router.put('/:id', requireRoomWriter(), async (req, res) => {
  // Merge onto the existing decrypted row rather than per-column COALESCE —
  // several callers send partial updates (photo upload sends only
  // { image_mxc }, for example), and encrypting `undefined` for an omitted
  // field must NOT clobber what's already stored.
  const { rows: existingRows } = await pool.query(
    'SELECT * FROM persons WHERE id = $1 AND owner_room_id = $2',
    [req.params.id, req.roomId]
  )
  if (!existingRows[0]) return res.status(404).json({ error: 'Not found' })
  const existing = toRow(existingRows[0], req.roomId)

  const merged = { ...existing, ...req.body }
  const now = Date.now()
  const { rows } = await pool.query(
    `UPDATE persons SET
       name = $2, phone_enc = $3, matrix_id_enc = $4, dm_room_id_enc = $5, team_id = $6, image_mxc = $7, updated_at = $8
     WHERE id = $1 AND owner_room_id = $9 RETURNING *`,
    [req.params.id, merged.name, encryptField(merged.phone, req.roomId), encryptField(merged.matrix_id, req.roomId),
     encryptField(merged.dm_room_id, req.roomId), merged.team_id || null, merged.image_mxc || null, now, req.roomId]
  )
  res.json(toRow(rows[0], req.roomId))
})

router.delete('/:id', requireRoomWriter(), async (req, res) => {
  await pool.query('DELETE FROM persons WHERE id = $1 AND owner_room_id = $2', [req.params.id, req.roomId])
  res.json({ ok: true })
})

export default router
