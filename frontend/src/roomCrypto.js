// ── Client-side, room-member-only field encryption ──────────────────────────
// This is the piece the backend's per-room AES (backend/src/crypto.js) can't
// be: genuine "only room members can decrypt" encryption, where the server
// NEVER holds the key.
//
// How it works, and why it's possible even though a widget has no direct
// access to Matrix's crypto (see PAINPOINTS.md — `matrix-widget-api` exposes
// no encryption primitive):
//
//   1. The widget generates a random 256-bit AES key K in-browser (WebCrypto).
//   2. It publishes K inside a normal Matrix room *message* event of a custom
//      type (`org.crewboard.keyring`). Element E2EE's that event with Megolm
//      on the way out — the widget never touches Matrix crypto, Element does.
//      Only room members (with room keys) can read it back; the homeserver
//      and CrewBoard's backend cannot. A custom event type also keeps it out
//      of Element's timeline UI by default (cosmetic only — a member can
//      still see it via "show hidden events"; that's fine, every member is
//      *meant* to be able to derive K).
//   3. On load the widget reads K back (Element decrypts it for us) and uses
//      it to AES-GCM encrypt/decrypt sensitive fields (phone, matrix_id,
//      license plate, marker notes, linked room IDs) client-side, BEFORE they
//      reach the backend. The backend stores opaque `mx1:`-prefixed blobs it
//      genuinely cannot read.
//
// New joiners: Megolm only shares a session with members present when an
// event was sent, so a member joining later can't decrypt an OLD keyring
// event. We handle that two ways, belt and suspenders:
//   - set m.room.history_visibility to "shared" (permits Element to backfill
//     old keys to new members — see initRoomCrypto), and
//   - re-publish the SAME K in a fresh event whenever a new member joins
//     (startMembershipWatch), so there's always a recent, decryptable copy.
//   Same K each time, so no data ever needs re-encrypting.
//
// HARD LIMIT the user accepted: if every member ever loses their Megolm keys
// (all devices wiped, no key backup), every keyring event becomes
// undecryptable and all client-encrypted fields are permanently lost — the
// backend cannot help, by design. The mitigation is the admin JSON export
// (Settings → Export), which decrypts client-side into a plaintext backup;
// admins are expected to keep one. Matrix key backup should also be on.
//
// THREAT MODEL: the adversary is the homeserver and CrewBoard's backend, not
// other room members. A custom room *message* event's power level is
// events_default (usually 0), so any member can publish a keyring event —
// we trust members (they can read all the room's data anyway). We pick the
// earliest keyring event we can decrypt as canonical, and log if we ever see
// two different keys, but we don't defend against a malicious member
// planting a rogue key. That would need signing and is out of scope here.
import { widgetApi, getRoomId } from './widget.js'
import { isCompanion, companionGetRoomKeyMaterial } from './relay.js'
import { Symbols } from 'matrix-widget-api'
// Safe to import here (no cycle): apiClient.js only depends on widget.js/
// relay.js, never on roomCrypto.js or api.js. api.js is NOT importable here
// — it depends on encryptValue/decryptValue from THIS file, so importing it
// back would be circular. Used only by roomHasExistingData() below, which
// needs raw row presence/absence, not decrypted content — apiClient.js's
// plain backend.get() is exactly the right layer for that.
import { backend } from './apiClient.js'

const KEYRING_TYPE = 'org.crewboard.keyring'
const CIPHER_PREFIX = 'mx1:'
const IV_LEN = 12 // bytes, standard for AES-GCM

const subtle = globalThis.crypto?.subtle

// ── module state ────────────────────────────────────────────────────────────
let cryptoKey = null           // imported CryptoKey (K) once resolved
let rawKeyB64 = null           // base64 of the raw 32 bytes, for relaying to companion windows
let encryptionSupported = null // true once we've confirmed the room is E2EE; false if not
let initPromise = null         // de-dupes concurrent initRoomCrypto() calls
// True when the room is encrypted and has EXISTING CrewBoard data, but
// readCanonicalKey() couldn't find/decrypt a keyring event for it — see
// initRoomCrypto()'s "no key found" branch. Deliberately distinct from
// "not encrypted"/"crypto init failed": this is a recoverable state (the
// key likely just hasn't been found yet, not lost) surfaced via the
// "Encryption failed" button in Layout.jsx rather than a full-screen
// refusal, since the rest of the app can still function with encrypted
// fields simply showing blank in the meantime.
let keyMissing = false

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64encode(bytes) {
  let s = ''
  const b = new Uint8Array(bytes)
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}
function b64decode(str) {
  const bin = atob(str)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importRawKey(rawBytes) {
  return subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** True only after initRoomCrypto() has confirmed the room is encrypted AND a
 *  key is available. Callers use this to decide whether to encrypt at all. */
export function isEncryptionReady() {
  return encryptionSupported === true && cryptoKey !== null
}

export function isEncryptedRoom() {
  return encryptionSupported === true
}

/** True when the room is encrypted but no canonical keyring key could be
 *  found for EXISTING data — see initRoomCrypto()'s "no key found" branch
 *  and the module-state comment above. Layout.jsx shows an "Encryption
 *  failed" button next to the CrewBoard title when this is true, letting
 *  the user manually retry (recheckKeyring()) instead of the app silently
 *  minting a destructive replacement key. */
export function isKeyMissing() {
  return keyMissing
}

/** Checks whether this room already has ANY CrewBoard data (persons, teams,
 *  vehicles, or markers) — used to decide whether a "no canonical key
 *  found" result means "genuinely first run, safe to mint a new key" vs.
 *  "a key must already exist somewhere, don't mint a replacement that
 *  would orphan everything already encrypted under it". Deliberately reads
 *  through apiClient.js's plain backend.get() rather than api.js — we only
 *  need row presence, not decrypted content, and importing api.js here
 *  would be circular (see the import comment above). */
async function roomHasExistingData() {
  try {
    const [persons, teams, vehicles, markers] = await Promise.all([
      backend.get('/persons'),
      backend.get('/teams'),
      backend.get('/vehicles'),
      backend.get('/markers'),
    ])
    return [persons, teams, vehicles, markers].some(
      (rows) => Array.isArray(rows) && rows.length > 0
    )
  } catch (e) {
    // Fail SAFE: if we can't even tell whether the room has data, assume it
    // might and refuse to mint a replacement key. Worst case this blocks a
    // genuinely brand-new room until the user clicks "Encryption failed" to
    // retry — an inconvenience. Minting wrongly, on the other hand, silently
    // and permanently orphans every already-encrypted field in a room that
    // actually had data. Not a symmetric risk, so the fail-safe direction
    // matters here.
    console.warn('roomCrypto: roomHasExistingData() check failed — assuming data MIGHT exist:', e.message)
    return true
  }
}

/** Encrypts a string with the room key. Returns null for empty input (so an
 *  optional field stays null). Returns the plaintext UNCHANGED if the key
 *  isn't ready — callers should gate on isEncryptionReady() before writing
 *  sensitive data, but this fail-open avoids silently corrupting a field into
 *  an un-decryptable blob if something calls us too early. */
export async function encryptValue(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null
  if (!isEncryptionReady()) return plaintext
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(String(plaintext)))
  const packed = new Uint8Array(IV_LEN + ct.byteLength)
  packed.set(iv, 0)
  packed.set(new Uint8Array(ct), IV_LEN)
  return CIPHER_PREFIX + b64encode(packed)
}

/** Reverses encryptValue(). A value without the mx1: prefix is passed through
 *  unchanged — it's either already-plaintext (a legacy row the backend
 *  decrypted server-side, or a field written before client encryption) or
 *  null. A decrypt failure returns null rather than throwing so one bad field
 *  can't blow up a whole list render. */
export async function decryptValue(stored) {
  if (stored === null || stored === undefined) return null
  if (typeof stored !== 'string' || !stored.startsWith(CIPHER_PREFIX)) return stored
  if (!cryptoKey) return null
  try {
    const packed = b64decode(stored.slice(CIPHER_PREFIX.length))
    const iv = packed.subarray(0, IV_LEN)
    const ct = packed.subarray(IV_LEN)
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct)
    return dec.decode(pt)
  } catch (e) {
    console.warn('roomCrypto: decryptValue failed for one field —', e.message)
    return null
  }
}

// ── keyring read / publish ──────────────────────────────────────────────────
function parseKeyringEvent(ev) {
  const c = ev?.content
  if (!c || typeof c.key !== 'string') return null
  try {
    const raw = b64decode(c.key)
    if (raw.length !== 32) return null
    return { raw, ts: ev.origin_server_ts || 0, b64: c.key }
  } catch { return null }
}

/** Reads every keyring event we can see and returns the parsed key material,
 *  or null if there are none. Picks the EARLIEST-timestamp one as canonical
 *  (see the threat-model note up top) and warns if it finds two distinct
 *  keys. */
async function readCanonicalKey() {
  // DIAGNOSTIC (2026-07-28): investigating a new org.crewboard.keyring event
  // getting minted+published on every browser reload instead of reusing an
  // existing one — meaning this function is returning null every time even
  // when a valid key was already published in a prior session. Two very
  // different root causes would both look like "returns null": (a) the read
  // finds NO events at all (a WidgetDriver timeline-loading race, same
  // category as the m.room.encryption fix, or this hidden-from-UI event type
  // never getting paginated into Element's locally cached timeline), vs.
  // (b) events ARE found but parseKeyringEvent() rejects every one of them
  // (no Megolm session to decrypt an OLDER message on this browser/device —
  // fresh profile, cleared storage, no key backup). Logging both the raw
  // count and the parsed-and-accepted count distinguishes them without
  // guessing; retried with backoff the same way isRoomEncrypted() is, since
  // if it IS purely a timing race this alone fixes it, and if it's not, the
  // logging still tells us that definitively.
  // Checks whether the org.crewboard.keyring RECEIVE capability was actually
  // granted at the moment we're about to use it — directly tests the theory
  // that this read runs before Element has finished the capability
  // approval round-trip, rather than assuming initWidget()'s resolution
  // already guarantees it (per matrix-widget-api's own source, its 'ready'
  // event — which initWidget() blocks on — only fires after Element's
  // NotifyCapabilities message, i.e. after the initial batch's approve/
  // reject decision. This checks that's actually true on this Element
  // build rather than trusting the spec blindly).
  console.info('roomCrypto: keyring receive capability granted at call time?',
    widgetApi.hasCapabilities(['org.matrix.msc2762.receive.event:org.crewboard.keyring']))

  let events = null
  for (let attempt = 0; attempt < 4; attempt++) {
    events = await widgetApi.receiveRoomEvents(KEYRING_TYPE, { roomIds: [getRoomId()] })
    const parsedCount = (events || []).map(parseKeyringEvent).filter(Boolean).length
    console.info(
      'roomCrypto: readCanonicalKey() attempt', attempt + 1,
      '-> raw events:', events?.length ?? 0,
      ', parsed+accepted:', parsedCount,
      parsedCount === 0 && events?.length > 0
        ? '(found events but could not parse/decrypt any — likely no Megolm session for an older message on this device, NOT a timing race)'
        : ''
    )
    if (parsedCount > 0) break
    if (attempt < 3) await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
  }

  const parsed = (events || []).map(parseKeyringEvent).filter(Boolean)
  if (parsed.length === 0) return null

  parsed.sort((a, b) => a.ts - b.ts)
  const canonical = parsed[0]
  const distinct = new Set(parsed.map(p => p.b64))
  if (distinct.size > 1) {
    console.warn(
      `roomCrypto: found ${distinct.size} distinct keyring keys in this room — ` +
      `using the earliest. If members can't see each other's encrypted data, an ` +
      `extra key was published; re-export/re-import to consolidate.`
    )
  }
  return canonical
}

async function publishKey(rawBytes) {
  await widgetApi.matrixWidgetApi.sendRoomEvent(KEYRING_TYPE, {
    key: b64encode(rawBytes),
    alg: 'A256GCM',
    v: 1,
  }, getRoomId() || undefined)
}

// ── room state helpers ──────────────────────────────────────────────────────
// ⚠️ TEMPORARY DEBUG BYPASS (2026-07-28) — always reports the room as
// encrypted, skipping the real m.room.encryption check below entirely, so
// production testing can get past the "this room isn't encrypted" gate
// while we isolate OTHER issues (the SYNAPSE_BASE_URL/federation-resource
// 401s, etc.) without this screen blocking every test. This does NOT fix
// the underlying detection question — it just silences it for now.
// MUST be reverted (delete this early return) before this is trusted in
// production for real: with this bypass, a genuinely-unencrypted room would
// no longer be refused, and roomCrypto.js would go on to mint/publish a
// room key into an UNENCRYPTED room's message timeline in plaintext,
// defeating the entire point of client-side field encryption.
async function isRoomEncrypted() {
  return true // eslint-disable-line no-unreachable -- see TEMPORARY DEBUG BYPASS above
  // m.room.encryption is a state event that only exists once a room has
  // encryption turned on. Its presence is the signal; content doesn't matter.
  //
  // Retried a few times with a short delay (2026-07-27 fix): confirmed this
  // could come back with NO event on the widget's very first load in a
  // room, even though the room genuinely is encrypted — Element's
  // WidgetDriver hasn't finished resolving its internal Room object yet
  // (the same class of race matrixStore.js's withTimelineRetry papers over
  // for OTHER reads, documented there as "Unable to access room timeline");
  // this one just resolves with an empty result instead of throwing, so it
  // needs its own retry rather than reusing that helper. Without this, a
  // dispatcher adding CrewBoard to a real encrypted room for the first time
  // could see the "this room isn't encrypted" refusal screen purely from
  // bad timing, not an actual configuration problem.
  // NOTE (2026-07-28): switched from receiveSingleStateEvent() to
  // receiveStateEvents() directly. Per the installed
  // @matrix-widget-toolkit/api source (build/esm/index.js ~L1470-1500),
  // receiveSingleStateEvent(eventType, stateKey) is ONLY a thin wrapper:
  // `return (await this.receiveStateEvents(eventType, { stateKey }))[0]` —
  // same underlying matrixWidgetApi.readStateEvents() call, same Joi
  // isValidStateEvent() filter. So this swap alone changes nothing about
  // WHETHER the event is found; it's here so the raw array (and the console
  // logging below) show us directly whether the read comes back empty
  // (Element's WidgetDriver race — the case the retry loop is already
  // built for) vs. comes back with an event that isValidStateEvent() then
  // silently drops (a schema mismatch, which would need a different fix).
  for (let attempt = 0; attempt < 4; attempt++) {
    const events = await widgetApi.receiveStateEvents('m.room.encryption')
    if (attempt === 0 || (!events || events.length === 0)) {
      console.info('roomCrypto: isRoomEncrypted() attempt', attempt + 1, '-> events:', events)
    }
    if (events && events.length > 0) return true
    if (attempt < 3) await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
  }
  return false
}

async function ensureHistoryShared() {
  // "shared" lets Element backfill old room (and thus keyring) keys to new
  // members. If it's already shared/world_readable, leave it. We just attempt
  // the change and let Element enforce power level — a member without the
  // rights to send this state event gets rejected, which we catch and ignore,
  // falling back to the republish-on-join path. (We deliberately don't read
  // power levels client-side to pre-check: the widget only knows the caller's
  // own Matrix ID if the registration URL passes $matrix_user_id, which isn't
  // guaranteed, so the authoritative gate is Element's own rejection here and
  // the backend's whoami for the republish path.)
  try {
    const ev = await widgetApi.receiveSingleStateEvent('m.room.history_visibility', '')
    const current = ev?.content?.history_visibility
    if (current === 'shared' || current === 'world_readable') return
    await widgetApi.sendStateEvent('m.room.history_visibility', { history_visibility: 'shared' }, { stateKey: '' })
    console.info('roomCrypto: set m.room.history_visibility = shared so new members can receive the room key')
  } catch (e) {
    console.warn('roomCrypto: could not set history visibility (non-fatal, republish-on-join still covers new members):', e.message)
  }
}

// ── init ────────────────────────────────────────────────────────────────────
/** Confirms the room is encrypted, then loads or (first time) creates the
 *  room key. Resolves to { supported: boolean }. If supported is false the
 *  caller (main.jsx) should refuse to run the app — CrewBoard is
 *  encrypted-rooms-only. Safe to call more than once; the work runs once. */
export function initRoomCrypto() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (!subtle) {
      // Non-secure context (http://) — WebCrypto's subtle is unavailable.
      encryptionSupported = false
      throw new Error('WebCrypto unavailable — CrewBoard must be served over HTTPS.')
    }

    if (isCompanion) {
      // Companion windows have no Widget API of their own; they can't read
      // room state or Megolm-encrypted events. Relay the raw key material
      // from the host widget instead (same-origin BroadcastChannel, local to
      // this browser — never crosses the network). The host is the one that
      // actually confirmed encryption and owns the keyring lifecycle.
      const material = await companionGetRoomKeyMaterial()
      if (!material?.key) {
        encryptionSupported = material?.encrypted === false ? false : null
        return { supported: encryptionSupported === true }
      }
      rawKeyB64 = material.key
      cryptoKey = await importRawKey(b64decode(material.key))
      encryptionSupported = true
      return { supported: true }
    }

    encryptionSupported = await isRoomEncrypted()
    if (!encryptionSupported) return { supported: false }

    let key = await readCanonicalKey()
    if (!key) {
      // 2026-07-28: no longer mints blindly on "no key found". A missing
      // read result is ambiguous — it could genuinely mean "first run in
      // this room" (safe to mint), or it could mean the key already exists
      // but readCanonicalKey() just couldn't find/decrypt it this time (the
      // exact read-timing/decrypt-availability race under investigation
      // this session). Minting in the SECOND case is actively destructive:
      // every field already encrypted under the real key becomes
      // permanently undecryptable with a new one, and the room ends up with
      // two irreconcilable keyring events (see readCanonicalKey()'s "found
      // N distinct keys" warning). roomHasExistingData() disambiguates by
      // checking for existing rows independent of decryption state — if the
      // room already has ANY CrewBoard data, a keyring key MUST already
      // exist somewhere, so we refuse to mint and surface a recoverable
      // "Encryption failed" state instead (isKeyMissing()/recheckKeyring(),
      // wired to the header button in Layout.jsx) rather than corrupt data
      // silently.
      const hasExistingData = await roomHasExistingData()
      if (hasExistingData) {
        keyMissing = true
        cryptoKey = null
        console.warn(
          'roomCrypto: room has existing data but no canonical keyring key ' +
          'was found — refusing to mint a replacement (would orphan already-' +
          'encrypted fields). Use the "Encryption failed" header button to retry.'
        )
        return { supported: true, keyMissing: true }
      }

      // Genuinely first run in this room (no existing data at all) — safe
      // to mint. Any member CAN publish (events_default), but only bother
      // setting history visibility if we're privileged. Re-read once after
      // a short beat to lose fewer races with a second admin setting up
      // simultaneously.
      const rawBytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
      await publishKey(rawBytes)
      await ensureHistoryShared()
      await new Promise(r => setTimeout(r, 800))
      key = (await readCanonicalKey()) || { raw: rawBytes, b64: b64encode(rawBytes) }
    }

    keyMissing = false
    rawKeyB64 = key.b64
    cryptoKey = await importRawKey(key.raw)
    return { supported: true }
  })()
  return initPromise
}

/** Manually retries finding the canonical keyring key WITHOUT ever minting a
 *  replacement — used by the "Encryption failed" header button (Layout.jsx)
 *  when isKeyMissing() is true. Unlike recheckRoomEncryption() below, this
 *  does NOT clear/replay initPromise (the room-encrypted verdict and
 *  companion/first-run paths don't need re-running, only the key lookup),
 *  so it's cheap to click repeatedly. Returns true once a key is loaded
 *  (already was, or just found), false if still missing. */
export async function recheckKeyring() {
  if (isEncryptionReady()) return true
  if (encryptionSupported !== true || isCompanion) return false
  const key = await readCanonicalKey()
  if (!key) return false
  rawKeyB64 = key.b64
  cryptoKey = await importRawKey(key.raw)
  keyMissing = false
  return true
}

/** Re-runs the encryption check from scratch — clears the memoized
 *  `initPromise` so `initRoomCrypto()` doesn't just hand back its previous
 *  (failed) result, then calls it again. Used by the "this room isn't
 *  encrypted" refusal screen's "Check again" button (see main.jsx):
 *  isRoomEncrypted() already retries internally for a few seconds to cover
 *  the common WidgetDriver room-object race, but there's no way to know in
 *  advance if a few seconds is always enough, and a dispatcher may also
 *  genuinely be turning on encryption for the first time RIGHT NOW in
 *  Element's room settings, in another tab, while looking at this screen —
 *  a manual recheck covers both without needing a full widget/page reload
 *  (which, inside an Element-hosted iframe, isn't always an obvious action
 *  for a user to take). Safe to call repeatedly: the underlying work
 *  (isRoomEncrypted() + key mint/read) is itself idempotent — re-minting
 *  never happens if a key already exists (readCanonicalKey() finds it
 *  first), so this can't create a second, conflicting room key. */
export function recheckRoomEncryption() {
  initPromise = null
  return initRoomCrypto()
}

/** Watches for new members and re-publishes the current key so joiners always
 *  have a decryptable copy (see the header comment). Returns an unsubscribe
 *  function. No-op in companion mode. `canRepublish` should be the caller's
 *  authoritative write permission (backend whoami.can_write) — gating on it
 *  avoids every member's widget re-publishing on every join; one privileged
 *  widget doing it is enough, and duplicates are harmless (same K) anyway. */
export function startMembershipWatch(subscribeState, canRepublish = false) {
  if (isCompanion || !isEncryptionReady() || !canRepublish) return () => {}

  const seen = new Set()

  const unsub = subscribeState('m.room.member', async (ev) => {
    // Own-room-only: the keyring only ever lives in THIS widget's room (see
    // publishKey() below, always targeted at getRoomId()), so a join in a
    // team/person room — or any other room the AnyRoom grant exposes — isn't
    // a reason to republish here. Deliberately not relevantRooms.js's
    // broader isRelevantRoom(), which would also match team/person rooms.
    if (ev?.room_id && ev.room_id !== getRoomId()) return
    if (ev?.content?.membership !== 'join') return
    const who = ev.state_key
    // De-dupe: only react to a membership event the first time we see this
    // user land on "join" this session (Element re-delivers state on sync).
    if (!who || seen.has(who)) return
    seen.add(who)
    try {
      const key = await readCanonicalKey()
      if (key) await publishKey(key.raw)
    } catch (e) {
      console.warn('roomCrypto: re-publish on join failed (non-fatal):', e.message)
    }
  })
  return unsub
}

/** Raw key material for handing to a companion window over the relay. Returns
 *  { encrypted, key } — key is null if there's no key (e.g. unencrypted
 *  room). Same-browser transfer only; never send this over the network. */
export function getKeyMaterialForRelay() {
  return { encrypted: encryptionSupported === true, key: rawKeyB64 }
}
