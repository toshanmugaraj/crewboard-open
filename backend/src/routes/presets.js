import { Router } from 'express'
import { pool } from '../db.js'
import { encryptField, decryptField } from '../crypto.js'
import { requireRoomWriter } from '../auth.js'

const router = Router()

// Per-room scoping (2026-07-21): keyed by room id rather than the literal
// 'default'. The pre-scoping 'default' row is renamed to CREWBOARD_ROOM_ID
// on startup (see db.js's backfill).
//
// Unlike settings.js (map view state, left open), presets are shared
// message templates the whole room sends from — treated as room content, so
// editing them needs power level 50+ like the other entity routes.
//
// items_enc (2026-07-27): the whole preset array is JSON-stringified and
// encrypted as ONE opaque TEXT blob client-side (frontend/src/api.js), not
// stored as JSONB — this backend never sees the individual message
// templates in the clear. This route is just a dumb blob store: it hands
// back whatever decryptField() gives (the untouched `mx1:` ciphertext for a
// client-encrypted value — only the frontend's roomCrypto.js can actually
// decrypt that) and stores whatever it's given the same way, via
// encryptField()'s passthrough. `presets`/`updatePresets` on the frontend do
// the real JSON (de)serialization and (de)cryption around this.
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT items_enc FROM presets WHERE id = $1', [req.roomId])
  res.json({ items_enc: decryptField(rows[0]?.items_enc, req.roomId) })
})

router.put('/', requireRoomWriter(), async (req, res) => {
  const stored = encryptField(req.body.items_enc, req.roomId)
  await pool.query(
    `INSERT INTO presets (id, items_enc) VALUES ($2, $1)
     ON CONFLICT (id) DO UPDATE SET items_enc = $1`,
    [stored, req.roomId]
  )
  res.json({ items_enc: stored })
})

export default router
