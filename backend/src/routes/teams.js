import { Router } from 'express'
import { pool } from '../db.js'
import { newId } from '../ids.js'
import { encryptField, decryptField } from '../crypto.js'
import { requireRoomWriter } from '../auth.js'

const router = Router()

// Two different room concepts live on this table, don't confuse them:
//   room_id (room_id_enc)  — the team's linked BROADCAST room
//                            (messaging_architecture_plan.md), encrypted at
//                            rest since a room ID reveals the org's room graph
//   owner_room_id          — the CrewBoard room this team RECORD belongs to
//                            (per-room scoping, 2026-07-21). Plaintext,
//                            because it's the partition key every query
//                            filters on — see db.js.
//
// name/description moved to name_enc/description_enc (2026-07-27) — same
// encrypted-column treatment as room_id_enc above.
function toRow(r, roomId) {
  return {
    id: r.id,
    name: decryptField(r.name_enc, roomId),
    description: decryptField(r.description_enc, roomId),
    color: r.color,
    room_id: decryptField(r.room_id_enc, roomId),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  }
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM teams WHERE owner_room_id = $1 ORDER BY created_at ASC',
    [req.roomId]
  )
  res.json(rows.map(r => toRow(r, req.roomId)))
})

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM teams WHERE id = $1 AND owner_room_id = $2',
    [req.params.id, req.roomId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(toRow(rows[0], req.roomId))
})

router.post('/', requireRoomWriter(), async (req, res) => {
  const { name, description, color, room_id } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })
  const id = newId()
  const now = Date.now()
  const { rows } = await pool.query(
    `INSERT INTO teams (id, name_enc, description_enc, color, room_id_enc, owner_room_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
    [id, encryptField(name, req.roomId), encryptField(description, req.roomId), color || null,
     encryptField(room_id, req.roomId), req.roomId, now]
  )
  res.status(201).json(toRow(rows[0], req.roomId))
})

router.put('/:id', requireRoomWriter(), async (req, res) => {
  // name_enc uses COALESCE against the still-encrypted column, same as the
  // old plaintext version did — an omitted `name` in the request keeps the
  // existing encrypted value rather than overwriting it with an encrypted
  // NULL.
  const { name, description, color, room_id } = req.body
  const now = Date.now()
  const { rows } = await pool.query(
    `UPDATE teams SET name_enc = COALESCE($2, name_enc), description_enc = $3, color = $4, room_id_enc = $5, updated_at = $6
     WHERE id = $1 AND owner_room_id = $7 RETURNING *`,
    [req.params.id, encryptField(name, req.roomId), encryptField(description, req.roomId),
     color ?? null, encryptField(room_id, req.roomId), now, req.roomId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(toRow(rows[0], req.roomId))
})

router.delete('/:id', requireRoomWriter(), async (req, res) => {
  // Real deletes now that there's a real database — no need for Matrix
  // state's tombstone (_deleted: true) pattern anymore. Persons/vehicles
  // referencing this team have team_id set to NULL automatically (ON DELETE
  // SET NULL in the schema), matching the old "members become unassigned"
  // behavior from Teams.jsx's delete confirmation copy.
  await pool.query('DELETE FROM teams WHERE id = $1 AND owner_room_id = $2', [req.params.id, req.roomId])
  res.json({ ok: true })
})

export default router
