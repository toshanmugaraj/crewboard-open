// ── Auth: reuse Matrix's existing login, no separate account system ────────
// CrewBoard the widget already gets a short-lived OpenID Connect token from
// Element for free via widget.js's getOpenIdToken() (uses the Widget API's
// requestOpenIDConnectToken() — no login screen, no password, inherits
// whatever Matrix session the user already has in Element). This backend
// trusts that token instead of implementing its own login: it hands the
// token to the user's own homeserver's federation "userinfo" endpoint
// (MSC boilerplate every homeserver implements — see
// https://spec.matrix.org/latest/server-server-api/#openid), and if the
// homeserver vouches for it, we know who's calling without ever seeing a
// password or issuing our own credentials.
//
// The frontend sends two things per request (see frontend/src/apiClient.js):
//   Authorization: Bearer <access_token>       (from getOpenIdToken())
//   X-Matrix-Server-Name: <matrix_server_name> (also from getOpenIdToken())
// ...but X-Matrix-Server-Name is NOT used to build the verification URL (see
// below) — it's logged/available for debugging only.
//
// NOTE: OpenID tokens are short-lived (Matrix spec default ~3600s, but
// treat it as opaque) and this hits the homeserver on every uncached
// request, so verified tokens are cached in-memory for a minute to avoid
// hammering Synapse under normal UI usage (e.g. rapid list refreshes).
//
// SYNAPSE_BASE_URL is the ONLY source of truth for where to verify tokens.
// If you're running this in Kubernetes/Docker Compose alongside Synapse,
// point it at Synapse's in-cluster/in-network address (e.g.
// http://synapse:8008), not the homeserver's public ingress hostname — a
// pod/container calling its own cluster's public hostname commonly fails
// with "fetch failed" if there's no hairpin NAT, especially behind a
// host-networked ingress controller. An earlier version of this file tried
// building the URL from the OpenID token's own `matrix_server_name` field —
// dropped that: besides the hairpin problem above, a bare server_name isn't
// actually a connectable URL under the Matrix federation spec without
// SRV/well-known delegation, which is unnecessary complexity here since you
// already know the real address for your own homeserver deployment.
const SYNAPSE_BASE_URL = process.env.SYNAPSE_BASE_URL || 'http://localhost:8008'
// Some Synapse deployments split the "client" and "federation" resource
// groups across two separate listeners/ports (confirmed live, 2026-07-28, on
// a production docker-compose deployment: port 8008 serving ONLY `client`,
// port 8048 serving ONLY `federation` — see homeserver.yaml's `listeners`).
// verifyOpenIdToken() below hits /_matrix/federation/v1/openid/userinfo,
// which needs the federation resource; getRoomMembers()/getRoomPowerLevels()
// hit /_synapse/admin/v1/..., which Synapse serves under the CLIENT
// resource. When those two live on different ports, a single SYNAPSE_BASE_URL
// can only ever satisfy one of them — pointing it at the client port 404s
// the OpenID check (this was the "Homeserver rejected OpenID token (HTTP
// 404)" bug), while pointing it at the federation port would instead break
// the admin membership/power-level lookups once SYNAPSE_ADMIN_TOKEN is set.
// SYNAPSE_FEDERATION_URL lets the two be configured independently; defaults
// to SYNAPSE_BASE_URL so deployments where Synapse combines both resources
// on one listener (the common case, and this project's original assumption)
// don't need to set anything new.
const SYNAPSE_FEDERATION_URL = process.env.SYNAPSE_FEDERATION_URL || SYNAPSE_BASE_URL
const CACHE_TTL_MS = 60_000

const verifiedTokenCache = new Map() // token -> { userId, expiresAt }

async function verifyOpenIdToken(token) {
  const cached = verifiedTokenCache.get(token)
  if (cached && cached.expiresAt > Date.now()) return cached.userId

  const url = `${SYNAPSE_FEDERATION_URL}/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(token)}`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Homeserver rejected OpenID token (HTTP ${res.status})`)
  }
  const body = await res.json()
  if (!body.sub) {
    throw new Error('Homeserver userinfo response had no "sub" (user id)')
  }

  verifiedTokenCache.set(token, { userId: body.sub, expiresAt: Date.now() + CACHE_TTL_MS })
  return body.sub
}

// ── Room-membership authorization ───────────────────────────────────────────
// verifyOpenIdToken() above only proves IDENTITY ("this really is
// @someone:example.org, the homeserver vouches for it") — it says nothing
// about AUTHORIZATION. Without this section, any user on the same
// homeserver could hit crewboard-backend's API and read/write every team's
// data, whether or not they were ever in the CrewBoard room. Fixing that
// needs a Synapse ADMIN credential, which most homeservers don't hand out
// through the normal registration path.
//
// If your homeserver runs Matrix Authentication Service (MAS) as its auth
// provider (an MSC3861-style setup where MAS, not Synapse, owns user
// accounts and credentials), Synapse's legacy `register_new_matrix_user` /
// `/_synapse/admin/v1/register` (shared-secret registration) will 404 with
// "Unrecognized request" — that whole code path is disabled once MAS is
// fronting auth. The correct way to provision a service account in that
// case is MAS's own CLI (`mas-cli manage register-user`, then
// `mas-cli manage issue-compatibility-token <user> --yes-i-want-to-grant-synapse-admin-privileges`),
// used once, out-of-band, to create a dedicated backend service user and
// mint it a Synapse-admin-capable Matrix access token. Store that token as
// a secret (not re-derived at request time) and inject it into this
// process as SYNAPSE_ADMIN_TOKEN. (If your homeserver instead allows the
// legacy shared-secret registration path, that works too — this backend
// only cares that it ends up with a valid admin-capable access token.)
//
// With that admin token, we can call Synapse's real admin API
// (GET /_synapse/admin/v1/rooms/{roomId}/members) to get the authoritative
// membership list for the CrewBoard room and reject anyone not on it.
//
// ── Per-room scoping (2026-07-21) ──────────────────────────────────────────
// This used to check membership of ONE hardcoded room (CREWBOARD_ROOM_ID).
// Now every row belongs to a room (db.js's owner_room_id) and the widget
// tells us which room it's running in via the X-Crewboard-Room-Id header,
// so membership is checked against THAT room per request.
//
// The room ID coming from the client is not a security problem: a caller
// can claim any room they like, but the membership lookup below is
// authoritative and rejects them unless Synapse says they're actually
// joined to it. Claiming someone else's room just gets you a 403.
//
// CREWBOARD_ROOM_ID is still read, but only as (a) the backfill target for
// pre-scoping rows (db.js) and (b) the fallback room when a client doesn't
// send the header at all, so an older frontend build keeps working.
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN || null
const CREWBOARD_ROOM_ID = process.env.CREWBOARD_ROOM_ID || null

// Minimum Matrix power level required to create/update/delete CrewBoard
// data in a room. 50 is Matrix's conventional "moderator" threshold (100 is
// admin, 0 is a regular member), so moderators and admins can manage
// markers/persons/teams/vehicles while regular members stay read-only.
const WRITE_POWER_LEVEL = 50

const membershipCache = new Map()  // roomId -> { members: Set, expiresAt }
const powerLevelCache = new Map()  // roomId -> { levels: object, expiresAt }

async function synapseAdminGet(path) {
  const res = await fetch(`${SYNAPSE_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}` },
  })
  if (!res.ok) {
    throw new Error(`Synapse admin API returned HTTP ${res.status} for ${path}`)
  }
  return res.json()
}

async function getRoomMembers(roomId) {
  const cached = membershipCache.get(roomId)
  if (cached && cached.expiresAt > Date.now()) return cached.members

  const body = await synapseAdminGet(`/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`)
  const members = new Set(body.members || [])
  membershipCache.set(roomId, { members, expiresAt: Date.now() + CACHE_TTL_MS })
  return members
}

/** Returns the room's m.room.power_levels content, or null if the room has
 *  none (which effectively means "defaults apply"). Uses the admin state
 *  endpoint rather than /members since power levels live in room state. */
async function getRoomPowerLevels(roomId) {
  const cached = powerLevelCache.get(roomId)
  if (cached && cached.expiresAt > Date.now()) return cached.levels

  const body = await synapseAdminGet(`/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`)
  const event = (body.state || []).find(e => e.type === 'm.room.power_levels' && e.state_key === '')
  const levels = event?.content || null
  powerLevelCache.set(roomId, { levels, expiresAt: Date.now() + CACHE_TTL_MS })
  return levels
}

/** A user's effective power level in a room: their explicit entry in
 *  power_levels.users, else the room's users_default, else 0 (the Matrix
 *  spec default when neither is present). */
async function getUserPowerLevel(roomId, userId) {
  const levels = await getRoomPowerLevels(roomId)
  if (!levels) return 0
  const explicit = levels.users?.[userId]
  if (typeof explicit === 'number') return explicit
  return typeof levels.users_default === 'number' ? levels.users_default : 0
}

/** Express middleware. Rejects with 401 if the token is missing or the
 *  homeserver doesn't vouch for it; otherwise sets:
 *    req.matrixUserId  — e.g. "@someone:example.org"
 *    req.roomId        — the room this request operates on (see below)
 *    req.powerLevel    — caller's power level in that room
 *    req.canWrite      — whether powerLevel >= WRITE_POWER_LEVEL
 *  ...and calls next().
 *
 *  The room comes from the X-Crewboard-Room-Id header (the SSE route can't
 *  set headers, so it may pass ?room_id= instead), falling back to
 *  CREWBOARD_ROOM_ID for older clients that send neither.
 *
 *  If SYNAPSE_ADMIN_TOKEN is configured, this enforces that the caller is
 *  currently a member of THAT room, rejecting with 403 otherwise, and
 *  resolves their power level. Without the admin token this step is skipped
 *  (logged once at startup — see index.js) and everyone is treated as a
 *  writer, so an incomplete deploy degrades to identity-only auth rather
 *  than locking every user out of their own data. */
export function requireMatrixAuth() {
  return async (req, res, next) => {
    const authHeader = req.get('authorization') || ''
    // EventSource (used by the SSE live-updates endpoint, routes/events.js)
    // cannot set custom headers at all — the browser API just doesn't
    // support it — so that one route's client passes the token as a query
    // param instead. Every other route still uses the Authorization header.
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.access_token || null)

    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization: Bearer <openid-token>' })
    }

    try {
      req.matrixUserId = await verifyOpenIdToken(token)
    } catch (e) {
      return res.status(401).json({ error: `Matrix auth failed: ${e.message}` })
    }

    const roomId = req.get('x-crewboard-room-id') || req.query.room_id || CREWBOARD_ROOM_ID
    if (!roomId) {
      return res.status(400).json({
        error: 'No room context: send X-Crewboard-Room-Id (or set CREWBOARD_ROOM_ID on the backend)',
      })
    }
    req.roomId = roomId

    if (!SYNAPSE_ADMIN_TOKEN) {
      // Degraded mode — no admin credential to verify membership or power
      // levels with. Treat the caller as a full writer so the app stays
      // usable; index.js logs this loudly at startup.
      req.powerLevel = WRITE_POWER_LEVEL
      req.canWrite = true
      return next()
    }

    try {
      const members = await getRoomMembers(roomId)
      if (!members.has(req.matrixUserId)) {
        return res.status(403).json({ error: 'Not a member of this CrewBoard room' })
      }
      req.powerLevel = await getUserPowerLevel(roomId, req.matrixUserId)
      req.canWrite = req.powerLevel >= WRITE_POWER_LEVEL
    } catch (e) {
      return res.status(503).json({ error: `Room authorization check failed: ${e.message}` })
    }

    next()
  }
}

/** Express middleware for mutating routes. Must run after
 *  requireMatrixAuth(). Rejects with 403 unless the caller has at least
 *  WRITE_POWER_LEVEL in the room they're acting on — i.e. reads are open to
 *  every room member, writes are moderator/admin only. */
export function requireRoomWriter() {
  return (req, res, next) => {
    if (!req.canWrite) {
      return res.status(403).json({
        error: `Requires power level ${WRITE_POWER_LEVEL}+ (moderator or admin) in this room — you have ${req.powerLevel ?? 0}`,
      })
    }
    next()
  }
}

export { WRITE_POWER_LEVEL }
