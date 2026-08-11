import { Router } from 'express'
import { pool } from '../db.js'
import { encryptField, decryptField } from '../crypto.js'

const router = Router()

// Per-room scoping (2026-07-21): the settings row is keyed by room id now
// rather than the literal 'default'. The pre-scoping 'default' row is
// renamed to CREWBOARD_ROOM_ID on startup (see db.js's backfill).
//
// Deliberately NOT gated behind requireRoomWriter(), unlike markers/persons/
// teams/vehicles: this row holds map view state (center/zoom), and
// MapBoard.jsx persists it on every `moveend`/`zoomend`. Gating it on power
// level would mean a read-only member panning the map generates a stream of
// 403s. View state isn't the data the admin-only requirement was about.
//
// data_enc (2026-07-27): the whole settings object is JSON-stringified and
// encrypted as ONE opaque TEXT blob client-side (frontend/src/api.js), not
// stored as JSONB — same blob-store treatment as presets.js's items_enc.
// IMPORTANT behavior change from the old JSONB version: PATCH used to do a
// server-side field-level merge (`{ ...existing, ...req.body }`) — the
// backend can't do that anymore since it only ever sees ciphertext (or an
// opaque `mx1:` blob it can't read at all) rather than a real object to
// spread. The frontend now does the read-decrypt-merge-encrypt cycle itself
// (api.js's settings.update()) and sends the already-merged, already-
// encrypted whole blob here; this route just stores it. Trade-off accepted:
// two browser tabs updating settings around the same moment can now race
// and one write can clobber the other (previously atomic per-request on the
// server) — acceptable for map view state, not worth a server-side
// encrypted-merge scheme.
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT data_enc FROM settings WHERE id = $1', [req.roomId])
  res.json({ data_enc: decryptField(rows[0]?.data_enc, req.roomId) })
})

router.patch('/', async (req, res) => {
  const stored = encryptField(req.body.data_enc, req.roomId)
  await pool.query(
    `INSERT INTO settings (id, data_enc) VALUES ($2, $1)
     ON CONFLICT (id) DO UPDATE SET data_enc = $1`,
    [stored, req.roomId]
  )
  res.json({ data_enc: stored })
})

export default router
