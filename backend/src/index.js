import express from 'express'
import cors from 'cors'
import { runMigrations } from './db.js'
import { requireMatrixAuth } from './auth.js'
import { startListening } from './notify.js'
import teamsRouter from './routes/teams.js'
import personsRouter from './routes/persons.js'
import vehiclesRouter from './routes/vehicles.js'
import markersRouter from './routes/markers.js'
import presetsRouter from './routes/presets.js'
import settingsRouter from './routes/settings.js'
import eventsRouter from './routes/events.js'
import backupRouter from './routes/backup.js'

const app = express()
app.use(cors()) // the widget iframe's origin varies by deployment; auth (not CORS) is what actually gates access — see auth.js
app.use(express.json())

app.get('/api/health', (req, res) => res.json({ ok: true }))

// Every /api/* route below this line requires a valid Matrix OpenID token —
// see auth.js for why this replaces a separate login system entirely.
// Whether it ALSO enforces CrewBoard-room membership (not just "some valid
// user on this homeserver") depends on SYNAPSE_ADMIN_TOKEN + CREWBOARD_ROOM_ID
// both being set — log which mode we're in once at startup so a misconfigured
// deploy is visible immediately rather than discovered later as a silent gap.
// As of the 2026-07-21 per-room scoping work, the room is per-request
// (X-Crewboard-Room-Id header) rather than one hardcoded room, so only the
// admin token gates the membership/power-level checks now. CREWBOARD_ROOM_ID
// is still used as the backfill target for pre-scoping rows (db.js) and as a
// fallback for clients that don't send the header.
if (process.env.SYNAPSE_ADMIN_TOKEN) {
  console.log('Room membership + power-level checks ENABLED (per-request room scoping)')
} else {
  console.warn(
    'Room authorization DISABLED (SYNAPSE_ADMIN_TOKEN not set) — any authenticated user ' +
    'on this homeserver can read AND write any room\'s CrewBoard data. Power-level ' +
    'enforcement (moderator/admin-only writes) is inactive in this mode.'
  )
}
if (!process.env.CREWBOARD_ROOM_ID) {
  console.warn('CREWBOARD_ROOM_ID not set — pre-scoping rows will not be backfilled, and clients that omit X-Crewboard-Room-Id will be rejected with 400')
}
app.use('/api', requireMatrixAuth())

// Lets the frontend render correct affordances (hide/disable editing UI for
// read-only members) instead of letting them try and eat a 403. Not a
// security boundary itself — the routes enforce it server-side regardless.
app.get('/api/whoami', (req, res) => {
  res.json({
    user_id: req.matrixUserId,
    room_id: req.roomId,
    power_level: req.powerLevel ?? 0,
    can_write: !!req.canWrite,
  })
})

app.use('/api/teams', teamsRouter)
app.use('/api/persons', personsRouter)
app.use('/api/vehicles', vehiclesRouter)
app.use('/api/markers', markersRouter)
app.use('/api/presets', presetsRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/events', eventsRouter)
app.use('/api/backup', backupRouter)

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

const PORT = process.env.PORT || 4000

runMigrations()
  .then(() => {
    startListening() // Postgres LISTEN for live updates — see notify.js
    app.listen(PORT, () => console.log(`crewboard-backend listening on :${PORT}`))
  })
  .catch((e) => {
    console.error('Failed to run DB migrations, refusing to start:', e)
    process.exit(1)
  })
