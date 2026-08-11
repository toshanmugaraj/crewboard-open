// ── Field-level encryption ───────────────────────────────────────────────────
// Matrix's canonical JSON forbids floats and, more importantly, room STATE
// events (which is where CrewBoard used to keep its "database") can never be
// end-to-end encrypted — only room *message* events go through Megolm, and
// state events are always readable in plaintext by the homeserver (see
// PAINPOINTS.md). That's the real reason this backend + Postgres exists:
// sensitive fields (phone numbers, matrix IDs, license plates, notes) are
// encrypted here with a key that never leaves this server — not even the
// widget frontend has it. Only non-sensitive, low-risk fields (names, team
// colors, coordinates) are stored in the clear, since they're either not
// personally identifying on their own or are needed for indexing/sorting.
//
// ── Per-room key derivation (2026-07-21) ────────────────────────────────────
// Data is now scoped per Matrix room (see db.js's room_id columns and
// auth.js's per-room membership check), and each room's sensitive fields are
// encrypted with a DISTINCT key derived from the master ENCRYPTION_KEY via
// HKDF-SHA256 with the room ID as the info parameter. Compromising one
// room's derived key doesn't yield any other room's data, and a per-room
// key can in principle be dropped (destroying just that room's data)
// without touching the rest.
//
// IMPORTANT — what this is NOT: this is encryption AT REST with a
// server-held key, not end-to-end encryption. This backend can decrypt
// every room's data, because it holds the master key that derives them all.
// The original ask was for markers "encrypted so only room members can
// decrypt, leveraging the Matrix ecosystem" — that is NOT what this does,
// and it is not achievable from inside a widget: `matrix-widget-api`
// exposes no encryption primitive at all (its full MatrixCapabilities list
// has nothing for crypto; the only encryption-adjacent method,
// sendToDevice(type, encrypted, ...), is device-to-device signalling for
// things like Element Call's key exchange, not a way to encrypt stored
// application data). Element performs all Megolm encryption internally and
// never exposes room keys to a widget. Genuine E2EE would require storing
// markers as Matrix room *message* events instead of database rows — which
// reintroduces exactly the limitations (no server-side querying/indexing,
// append-only semantics, per-event size ceiling) that motivated moving off
// Matrix state onto Postgres in the first place. See PAINPOINTS.md.
import crypto from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // bytes, standard for GCM
const TAG_LEN = 16

// Rows written before per-room keys existed are base64 with no prefix and
// are encrypted with the master key directly. New rows get this prefix so
// decryptField() can tell the two apart without a schema migration or a
// bulk re-encrypt pass. base64 never contains ':', so this is unambiguous.
const V2_PREFIX = 'v2:'

// Values the CLIENT encrypted (roomCrypto.js, room-member-only key) carry
// this prefix. The backend must never touch them: it can't decrypt them (it
// doesn't have the key — that's the whole point), and it must not re-encrypt
// them on write. Both encryptField and decryptField pass an mx1: value
// straight through, so client-encrypted blobs round-trip the database
// unchanged while legacy backend-encrypted rows keep working alongside them.
const CLIENT_PREFIX = 'mx1:'

function getMasterKey() {
  const b64 = process.env.ENCRYPTION_KEY
  if (!b64) {
    throw new Error(
      'ENCRYPTION_KEY env var is not set. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" ' +
      'and store it in the crewboard-backend-secret k8s Secret — never commit it.'
    )
  }
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}`)
  }
  return key
}

// Derived keys are pure functions of (master key, roomId) so they're stable
// across restarts and pods — cached only to avoid re-running HKDF on every
// single field of every row in a list response.
const derivedKeyCache = new Map() // roomId -> Buffer(32)

function getRoomKey(roomId) {
  // No room (legacy rows, or a route that genuinely isn't room-scoped) —
  // fall back to the master key, matching pre-2026-07-21 behavior exactly.
  if (!roomId) return getMasterKey()

  const cached = derivedKeyCache.get(roomId)
  if (cached) return cached

  const key = Buffer.from(
    crypto.hkdfSync('sha256', getMasterKey(), Buffer.alloc(0), `crewboard:room:${roomId}`, 32)
  )
  derivedKeyCache.set(roomId, key)
  return key
}

/** Encrypts a string field with the given room's derived key. Returns null
 *  for null/undefined/empty input so optional fields (e.g. a person with no
 *  phone number) stay null in the DB instead of encrypting an empty string.
 *
 *  `roomId` should be the Matrix room the row belongs to. Omitting it falls
 *  back to the master key (legacy behavior) rather than throwing, so any
 *  not-yet-migrated caller keeps working instead of hard-failing writes. */
export function encryptField(plaintext, roomId = null) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null
  // Already client-encrypted (roomCrypto.js) — store verbatim, never double-
  // encrypt. The backend has no key for these and shouldn't.
  if (typeof plaintext === 'string' && plaintext.startsWith(CLIENT_PREFIX)) return plaintext
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, getRoomKey(roomId), iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Store iv + authTag + ciphertext concatenated, base64-encoded, as a single
  // TEXT column — simplest thing that round-trips cleanly through pg.
  const packed = Buffer.concat([iv, authTag, ciphertext]).toString('base64')
  return roomId ? V2_PREFIX + packed : packed
}

/** Reverses encryptField(). Returns null for null input.
 *
 *  Handles both formats transparently: a `v2:`-prefixed value is decrypted
 *  with the room's derived key, an unprefixed one with the master key (rows
 *  written before per-room keys existed). Returns null rather than throwing
 *  on a decrypt failure — a single unreadable field (wrong room's key on a
 *  mis-scoped row, or data encrypted under a rotated master key) shouldn't
 *  take down the entire list response it appears in; it surfaces as a
 *  missing field instead, which the UI already tolerates since all of these
 *  columns are nullable. */
export function decryptField(stored, roomId = null) {
  if (stored === null || stored === undefined) return null
  // Client-encrypted — return the ciphertext as-is; only the room's members
  // (via roomCrypto.js in the frontend) can decrypt it, never this backend.
  if (typeof stored === 'string' && stored.startsWith(CLIENT_PREFIX)) return stored

  const isV2 = stored.startsWith(V2_PREFIX)
  const payload = isV2 ? stored.slice(V2_PREFIX.length) : stored
  const key = isV2 ? getRoomKey(roomId) : getMasterKey()

  try {
    const raw = Buffer.from(payload, 'base64')
    const iv = raw.subarray(0, IV_LEN)
    const authTag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ciphertext = raw.subarray(IV_LEN + TAG_LEN)
    const decipher = crypto.createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (e) {
    console.warn(`decryptField failed (room=${roomId || 'none'}, format=${isV2 ? 'v2' : 'legacy'}): ${e.message}`)
    return null
  }
}
