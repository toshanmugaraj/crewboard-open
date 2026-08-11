// ── Matrix messaging + live-event layer ──────────────────────────────────────
// teams/persons/vehicles/markers/presets/settings USED to be Matrix custom
// state events (one state key per row) — that generic stateCollection() CRUD
// helper lived here. It's gone now: that "database" moved to
// crewboard-backend (Express + Postgres, see api.js and PAINPOINTS.md) so
// sensitive fields can actually be encrypted at rest, since Matrix room
// state can never be end-to-end encrypted no matter the room's encryption
// setting. What's left in this file is genuinely Matrix-native: room
// *message* events (chat, contact/vehicle cards, location shares — these
// DO get E2EE'd by Element), live location beacons, and media upload.
//
// Migrated (2026-07-20) to @matrix-widget-toolkit/api's receive/observe/send
// surface (see widget.js's header comment for why). Two deliberate
// deviations from a "pure" toolkit migration, both confirmed against the
// toolkit's real source (packages/api/src/api/WidgetApiImpl.ts):
//
// 1. sendRoomEvent() here still calls the RAW `widgetApi.matrixWidgetApi.
//    sendRoomEvent()` rather than the toolkit's own `widgetApi.sendRoomEvent()`.
//    The toolkit's version subscribes to Element's to-widget event-echo
//    stream and waits for the just-sent event to come back — with NO
//    timeout at all. Given this whole session was spent discovering that
//    Element's ack can legitimately take longer than matrix-widget-api's
//    fixed 10s timeout (see PAINPOINTS.md's "Cross-room messaging" section),
//    an *unbounded* wait on the toolkit's own send path is a real regression
//    risk (a send could hang the UI forever instead of timing out loudly at
//    10s). Kept our own bounded fire-and-forget handling instead.
// 2. `receiveStateEvents()`/`receiveRoomEvents()` always request
//    `Number.MAX_SAFE_INTEGER` internally — this actually supersedes the
//    2026-07-20 "explicit limit" fix in readBeacons() below (that fix is
//    kept as a comment for history; the toolkit needs no equivalent tuning).
import { Symbols } from 'matrix-widget-api'
import { widgetApi, getRoomId, getOpenIdToken, navigateTo as widgetNavigateTo, LOCATION_TAG_STATE_TYPE } from './widget.js'
import {
  isCompanion,
  broadcastPush,
  companionSendMessage,
  companionSendRoomEvent,
  companionReadInbox,
  companionReadBeacons,
  companionUploadMedia,
  companionSearchUserDirectory,
  companionFetchMediaUrl,
  companionFindDmRoom,
  companionListJoinedRooms,
  companionGetRoomMembers,
  companionNavigateTo,
  subscribeCompanionPush,
} from './relay.js'

// "Open in Element" escape hatch (Database.jsx/Teams.jsx). widget.js's
// navigateTo() only works in the real widget iframe — a companion popup
// window (?companion=1) has no Widget API connection of its own (widgetApi
// stays null there forever, see widget.js), so this routes over the relay
// to the host iframe instead. Views should import navigateTo from here, not
// directly from widget.js, so the button works from either context.
export async function navigateTo(uri) {
  if (isCompanion) return companionNavigateTo(uri)
  return widgetNavigateTo(uri)
}

// Element's WidgetDriver occasionally fails an early read with
// "Unable to access room timeline: !roomId" — seen across different rooms,
// so it isn't one broken room, it's a race: the driver hasn't finished
// resolving its internal Room object yet when the widget's first read lands
// right after the ready handshake. Not something CrewBoard can fix directly
// (it's Element-side), but a short retry papers over the race cheaply and
// harmlessly if the failure has a different cause. Still relevant post
// migration — the toolkit calls the same underlying raw readStateEvents/
// readRoomEvents under the hood, so the same race and error text apply.
async function withTimelineRetry(fn, attempts = 3, delayMs = 400) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      const isTimelineRace = /unable to access room timeline/i.test(e?.message || '')
      if (!isTimelineRace || i === attempts - 1) throw e
      await new Promise(r => setTimeout(r, delayMs * (i + 1)))
    }
  }
}

// ── Live event subscriptions ─────────────────────────────────────────────────
// The toolkit's observeStateEvents()/observeRoomEvents() each return a single
// Observable that emits the current history FIRST, then live updates as they
// arrive — replacing both the old one-shot readBeacons()-style poll AND the
// separate hand-rolled widgetApi.on('action:update_state'/'action:send_event')
// + fanOut() dance the raw-API version needed just to avoid Element's
// "Unknown or unsupported to-widget action" crash on unacked pushes. That
// whole ack-routing problem is the toolkit's to solve now (its WidgetApiImpl
// constructor registers its own always-ack listener internally).
//
// Scoped to Symbols.AnyRoom for every type here (not just the widget's own
// room) to preserve the original raw-API listener's behavior, which had zero
// room filtering at all — any pushed event of a subscribed type fired
// regardless of room, matching the cross-room messaging/beacon work from
// messaging_architecture_plan.md.
const STATE_LIKE_TYPES = new Set(['org.matrix.msc3672.beacon_info', LOCATION_TAG_STATE_TYPE])

export function subscribeState(eventType, onChange) {
  if (isCompanion) return subscribeCompanionPush(eventType, onChange)
  if (!widgetApi) {
    console.warn(`subscribeState(${eventType}) called before the widget API was ready — ignoring.`)
    return () => {}
  }

  const observable = STATE_LIKE_TYPES.has(eventType)
    ? widgetApi.observeStateEvents(eventType, { roomIds: Symbols.AnyRoom })
    : widgetApi.observeRoomEvents(eventType, { roomIds: Symbols.AnyRoom })

  const subscription = observable.subscribe({
    next: (event) => {
      broadcastPush(event.type, event) // no-op unless a relay host is running — see relay.js
      onChange(event)
    },
    error: (e) => console.warn(`subscribeState(${eventType}) observable errored:`, e),
  })

  return () => subscription.unsubscribe()
}

// ── Room messaging ───────────────────────────────────────────────────────────
// Each of these branches to the relay (relay.js) when running as a companion
// window (window.open()'d popup, no Widget API connection of its own) — see
// relay.js's header comment for why. The relay just replays these same calls
// through the original widget iframe, which still holds the real connection.
//
// `roomId` is optional on the send functions — omit it to post into the
// widget's own room (the ops room, unchanged default behavior); pass a
// team's/person's linked DM/team room id to send there instead. This only
// works because widget.js requests `org.matrix.msc2762.timeline:*`
// (Symbols.AnyRoom) rather than just the widget's own room — see
// messaging_architecture_plan.md for why that's safe and what it unlocks.
export async function sendRoomEvent(eventType, content, roomId) {
  if (isCompanion) return companionSendRoomEvent(eventType, content, roomId)
  try {
    // Raw call, deliberately not the toolkit's own sendRoomEvent() — see this
    // file's header comment for why (no timeout on the toolkit's version).
    return await widgetApi.matrixWidgetApi.sendRoomEvent(eventType, content, roomId || getRoomId() || undefined)
  } catch (e) {
    // matrix-widget-api's from-widget RPC has a fixed 10s ack timeout
    // (PostmessageTransport.js's timeoutSeconds) — Element can take longer
    // than that to respond without the underlying send actually failing.
    // Confirmed live (2026-07-19): a "Request timed out" error here still
    // resulted in the message landing in the room. Treat a timeout
    // specifically as fire-and-forget — log it and resolve rather than
    // surfacing a false failure toast to the user — since we can't tell
    // from this error alone whether it landed, and it usually has. Any
    // other error (e.g. an actual capability/permission denial, which
    // throws a different message) still propagates normally.
    if (/request timed out/i.test(e?.message || '')) {
      console.warn(`sendRoomEvent(${eventType}) timed out waiting for Element's ack — the message was likely still sent. See PAINPOINTS.md's "Cross-room messaging" section.`, e)
      return undefined
    }
    throw e
  }
}

export async function sendMessage(body, extra = {}, roomId) {
  if (isCompanion) return companionSendMessage(body, extra, roomId)
  return sendRoomEvent('m.room.message', { msgtype: 'm.text', body, ...extra }, roomId)
}
// (companionSendMessage/companionSendRoomEvent already forward roomId as
// `targetRoomId` in their relay.js wrappers — see relay.js.)

// ── Rate-limit-aware multi-room fan-out ──────────────────────────────────────
// Synapse's default rc_message rate limit (homeserver.yaml's rc_message:
// per_second/burst_count) is per SENDER, not per room — posting the same
// event into several rooms back-to-back from one dispatcher account (see
// api.matrix.sendScreenshot()'s "All teams" option, which posts to the ops
// room + every team's linked room) can trip M_LIMIT_EXCEEDED even though no
// single room gets more than one message. sendRoomEventToRooms() below sends
// one room at a time (never Promise.all — parallel is exactly what trips
// the limit) with a small gap and per-send retry/backoff on rate-limit
// errors specifically; any other error still fails that room immediately.
const RATE_LIMIT_RE = /M_LIMIT_EXCEEDED|rate.?limit|\b429\b/i
const RETRY_AFTER_RE = /retry_after_ms["'\s:]+(\d+)/i

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** sendRoomEvent() with backoff-and-retry, but ONLY for rate-limit errors
 *  (M_LIMIT_EXCEEDED/429) — anything else still throws immediately, same as
 *  plain sendRoomEvent(). Honors the homeserver's own retry_after_ms when
 *  Element's error message surfaces one; falls back to exponential backoff
 *  off baseDelayMs otherwise. */
export async function sendRoomEventWithRetry(eventType, content, roomId, { retries = 4, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendRoomEvent(eventType, content, roomId)
    } catch (e) {
      const msg = e?.message || ''
      if (!RATE_LIMIT_RE.test(msg) || attempt >= retries) throw e
      const explicit = msg.match(RETRY_AFTER_RE)
      const waitMs = explicit ? Number(explicit[1]) : baseDelayMs * 2 ** attempt
      console.warn(
        `sendRoomEvent(${eventType}) rate-limited sending to ${roomId || '(current/ops room)'} — ` +
        `retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`, e
      )
      await sleep(waitMs)
    }
  }
}

/** Posts the same event into multiple rooms one at a time (see the
 *  rate-limit note above), with a gap between sends and rate-limit
 *  retry/backoff on each. Doesn't throw on the first failed room — collects
 *  which rooms succeeded/failed and returns both, so a fan-out to N rooms
 *  can partially succeed instead of aborting with the caller unsure what
 *  actually went out. `roomIds` may include `undefined` for "the widget's
 *  own room" (sendRoomEvent's default) — deduped like any other entry. */
export async function sendRoomEventToRooms(eventType, content, roomIds, { gapMs = 400, retries = 4, baseDelayMs = 1000, onProgress } = {}) {
  const seen = new Set()
  const ok = []
  const failed = []
  let first = true
  // Dedup up front (2026-08-10) so onProgress's `total`/`index` reflect the
  // actual number of sends that will happen, not the raw input length —
  // matters now that callers (bulk direct-message fan-out) drive a progress
  // bar off this.
  const unique = []
  for (const roomId of roomIds) {
    const key = roomId || '__self__'
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(roomId)
  }
  for (let i = 0; i < unique.length; i++) {
    const roomId = unique[i]
    if (!first) await sleep(gapMs)
    first = false
    let success = true
    try {
      await sendRoomEventWithRetry(eventType, content, roomId, { retries, baseDelayMs })
      ok.push(roomId)
    } catch (e) {
      console.warn(`sendRoomEventToRooms: giving up on room ${roomId || '__self__'}:`, e.message)
      failed.push({ roomId, error: e.message })
      success = false
    }
    onProgress?.({ index: i + 1, total: unique.length, roomId, success })
  }
  return { ok, failed }
}

// Room display name for THIS widget's own room only — scoped read (unlike
// listJoinedRooms()'s AnyRoom sweep across every joined room, which is
// overkill just to label the current one). Falls back to null if the room
// has no m.room.name set (a real, if uncommon, case — Element shows the
// member list/DM partner's name instead) or the read fails for any reason;
// callers (Settings.jsx/MatrixHub.jsx) fall back to the raw room id.
export async function getCurrentRoomName() {
  if (isCompanion) return null // no live Widget API connection to read state from — see relay.js
  const roomId = getRoomId()
  try {
    const events = await withTimelineRetry(() =>
      widgetApi.receiveStateEvents('m.room.name', { roomIds: roomId ? [roomId] : undefined })
    )
    return events?.[0]?.content?.name || null
  } catch (e) {
    console.warn('getCurrentRoomName() failed:', e.message)
    return null
  }
}

export async function readInbox(limit = 100) {
  if (isCompanion) return companionReadInbox(limit)
  const roomId = getRoomId()
  // receiveRoomEvents() has no `limit` parameter (the toolkit always asks
  // for Number.MAX_SAFE_INTEGER under the hood) — slice to the most recent
  // `limit` locally instead, preserving this function's external contract.
  const events = await withTimelineRetry(() =>
    widgetApi.receiveRoomEvents('m.room.message', { roomIds: roomId ? [roomId] : undefined })
  )
  return (events || []).slice(-limit)
}

// Parses a "geo:<lat>,<lon>;u=<accuracy>" URI (MSC3488), the format
// org.matrix.msc3672.beacon's content['org.matrix.msc3488.location'].uri
// uses. Returns null if it doesn't match rather than throwing, so one
// malformed beacon doesn't take down the whole list.
function parseGeoUri(uri) {
  if (typeof uri !== 'string') return null
  const m = uri.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (!m) return null
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) }
}

/** Live location beacons broadcast by mobile Element clients (MSC3672) —
 *  replaces the old backend's polled location cache.
 *
 *  - `org.matrix.msc3672.beacon_info` is a STATE event (one per sender per
 *    beacon session) announcing a live-sharing session —
 *    `content.live`/`content.timeout`, NO coordinates.
 *  - `org.matrix.msc3672.beacon` is a separate TIMELINE (room) event
 *    carrying the actual moving coordinates in
 *    `content['org.matrix.msc3488.location'].uri` (a
 *    `geo:lat,lon;u=accuracy` URI), linked back to its `beacon_info` via
 *    `content['m.relates_to'].event_id` (`rel_type: 'm.reference'`).
 *
 *  IMPORTANT (confirmed live, 2026-07-20, from actual events dumped out of
 *  this deployment's room): both MSC3672 (beacons) AND MSC3488 (location
 *  assets, the sub-schema beacons embed) were never stabilized into the
 *  main Matrix spec, and this Element/Synapse combination uses the
 *  UNSTABLE, prefixed names for BOTH — not just the event *types*
 *  (`org.matrix.msc3672.beacon_info`/`org.matrix.msc3672.beacon`, fixed
 *  earlier) but also the *content key* carrying the coordinates
 *  (`org.matrix.msc3488.location`, not `m.location`) and its timestamp
 *  (`org.matrix.msc3488.ts`, not `m.ts`). A real dumped `org.matrix.msc3672.
 *  beacon` event looked like:
 *  `{ type: 'org.matrix.msc3672.beacon', content: {
 *      'org.matrix.msc3488.location': { uri: 'geo:26.22,50.59,0;u=40.6' },
 *      'org.matrix.msc3488.ts': 1784610756030,
 *      'm.relates_to': { rel_type: 'm.reference', event_id: '$q3id...' } } }`
 *  — `m.relates_to` is NOT prefixed (that part of MSC2674 is stable), only
 *  the beacon-specific fields are. Reading the coordinates off `m.location`
 *  meant `parseGeoUri()` always got `undefined` and every beacon was
 *  silently dropped — the toast in Layout.jsx still fired (it subscribes to
 *  the raw event type directly, no field parsing), which is why the "green
 *  location updated" panel showed up while nothing ever plotted on the map.
 *
 *  Reads across EVERY room the dispatcher's Element client knows
 *  (Symbols.AnyRoom), not just the widget's own room, so beacons shared
 *  into a team room or a DM still show up on MapBoard. One person may be
 *  sharing into more than one room at once — de-duplicated, keeping
 *  whichever coordinate update is most recent.
 *
 *  `@matrix-widget-toolkit/api`'s `receiveStateEvents()`/`receiveRoomEvents()`
 *  (confirmed against their real source) always request
 *  `Number.MAX_SAFE_INTEGER` internally, so the earlier "explicit limit"
 *  fix for the timeline-search-not-state-snapshot behavior is handled
 *  automatically and isn't this file's problem to manage anymore. */
export async function readBeacons() {
  if (isCompanion) return companionReadBeacons()

  const infoEvents = await withTimelineRetry(() =>
    widgetApi.receiveStateEvents('org.matrix.msc3672.beacon_info', { roomIds: Symbols.AnyRoom })
  )
  const now = Date.now()
  const liveInfoById = new Map() // beacon_info event_id -> info event
  for (const e of (infoEvents || [])) {
    const c = e.content || {}
    if (!c.live) continue
    // Hard expiry (MSC3672): if the session's timeout has elapsed since it
    // started, treat it as no longer live even if an explicit "live: false"
    // stop event never arrives (phone died, lost network, forgot to stop).
    if (c.timeout && e.origin_server_ts && now > e.origin_server_ts + c.timeout) continue
    liveInfoById.set(e.event_id, e)
  }
  if (liveInfoById.size === 0) return []

  // Read the coordinate stream itself — we only keep the freshest one per
  // sender below anyway, so no manual limit tuning needed here either.
  const beaconEvents = await withTimelineRetry(() =>
    widgetApi.receiveRoomEvents('org.matrix.msc3672.beacon', { roomIds: Symbols.AnyRoom })
  )

  const bySender = new Map() // user_id -> beacon
  for (const ev of (beaconEvents || [])) {
    const relatesTo = ev.content?.['m.relates_to']
    const info = relatesTo?.event_id ? liveInfoById.get(relatesTo.event_id) : null
    if (!info) continue // not linked to a currently-live m.beacon_info
    const latlng = parseGeoUri(ev.content?.['org.matrix.msc3488.location']?.uri)
    if (!latlng) continue
    const timestamp = ev.content?.['org.matrix.msc3488.ts'] || ev.origin_server_ts || 0
    const existing = bySender.get(ev.sender)
    if (!existing || timestamp > existing.timestamp) {
      bySender.set(ev.sender, { user_id: ev.sender, room_id: ev.room_id, lat: latlng.lat, lng: latlng.lng, timestamp })
    }
  }
  return [...bySender.values()]
}

// ── Media upload (staff/vehicle photos, screenshots) ────────────────────────
// Uploads now go through the Widget API itself (MSC4039's upload_file
// action, via @matrix-widget-toolkit/api's uploadFile() — see widget.js's
// MSC4039UploadFile capability) rather than a direct authenticated fetch to
// the homeserver's media repo. The old approach used an OpenID token
// (getOpenIdToken()/requestOpenIDConnectToken()) as the upload's Bearer
// credential, which started 401ing — turns out that was never really
// supposed to work: OpenID tokens are for federation identity verification,
// not valid Client-Server API access tokens, so the media upload endpoint
// rejecting them is arguably correct behavior that something just started
// enforcing. Handing the file to Element via the widget action sidesteps
// the whole token question — Element uploads it with the user's own real
// session. Trade-off accepted: uploadFile()'s signature only takes the file
// body (no filename param), so the original filename may not survive the
// upload the way the old direct-POST's `?filename=` query param did —
// acceptable since nothing in this app displays the uploaded filename
// itself (persons/vehicles just store and redisplay the resulting mxc://
// URI as an image). getOpenIdToken() is kept around for the still-fetch-based
// authenticated *download* path below (fetchMediaBlob) — only the upload
// direction changed.

// Resolves the ACTUAL homeserver base URL to POST uploads to. This has to be
// the real, delegated homeserver (e.g. https://matrix.example.org), NOT the
// bare Matrix server_name (e.g. example.org): the server_name commonly
// 30x-redirects to the delegated homeserver via .well-known, and an upload is
// a CORS *preflighted* request (POST + Authorization header) — preflight
// (OPTIONS) responses are NOT allowed to redirect, so hitting the server_name
// directly fails with "Redirect is not allowed for a preflight request".
//
// Order of preference:
//   1. the `baseUrl` widget URL param, if the registration passed one
//      (already the delegated URL, no redirect) — fast path, no extra fetch;
//   2. otherwise resolve delegation ourselves via
//      GET https://<server_name>/.well-known/matrix/client (a plain GET, which
//      CORS *does* allow to redirect, and which Matrix requires to be
//      served with permissive CORS), and use its m.homeserver.base_url;
//   3. last resort, the bare server_name — may still redirect, but it's better
//      than nothing if well-known is missing.
// Reads a widget URL parameter from EITHER the query string OR the hash
// fragment. This app uses HashRouter and Element's registered widget URL puts
// every parameter after the '#' (e.g. https://crewboard.example.org/#/?roomId=...&baseUrl=
// https://matrix.example.org...), so window.location.search is empty and the params
// live in window.location.hash instead. (The toolkit's widgetParameters
// already handle this for the params it knows; this is for our own custom
// ones like baseUrl.)
export function getWidgetUrlParam(name) {
  const search = new URLSearchParams(window.location.search)
  if (search.has(name)) return search.get(name)
  const hash = window.location.hash || ''
  const q = hash.indexOf('?')
  if (q >= 0) {
    const hashParams = new URLSearchParams(hash.slice(q + 1))
    if (hashParams.has(name)) return hashParams.get(name)
  }
  return null
}

// mxcToHttp() (below) is synchronous and only ever reads cachedHomeserverBase
// directly — it never awaits resolveHomeserverBase() itself (it can't, it's
// called from render). That means every path through resolveHomeserverBase()
// MUST assign to cachedHomeserverBase, including the final bare-server-name
// fallback — previously that fallback was only ever *returned*, never
// *cached*, so if the .well-known fetch failed (network hiccup, DNS issue,
// whatever) cachedHomeserverBase stayed null forever and mxcToHttp() kept
// returning null for the rest of the session: avatars/photos would show
// their empty/placeholder state permanently, with no error visible anywhere,
// because <img src={null}> just quietly renders nothing rather than firing a
// network request that could be inspected. Found 2026-07-23 via a report of
// a person's photo showing blank in the list and the edit modal's upload box
// showing its empty "drag a photo here" placeholder despite image_mxc being
// correctly set in the database — the placeholder (not a broken-image icon)
// was the tell: it only renders when mxcToHttp() returns null outright, not
// when a real request fails.
let cachedHomeserverBase = null

// Components that computed an avatar/photo URL before resolution finished
// (or before it fell back) have no way to know cachedHomeserverBase changed,
// since it's a plain module variable, not React state. Fire a DOM event so
// they can recompute — see PhotoUpload's/Database.jsx's listeners.
function notifyMediaBaseReady() {
  try { window.dispatchEvent(new CustomEvent('crewboard:media-base-ready')) } catch { /* no-op outside a browser */ }
}

async function resolveHomeserverBase(serverName) {
  const paramBase = getWidgetUrlParam('baseUrl')
  if (paramBase) {
    cachedHomeserverBase = paramBase.replace(/\/+$/, '')
    notifyMediaBaseReady()
    return cachedHomeserverBase
  }
  if (cachedHomeserverBase) return cachedHomeserverBase
  try {
    const res = await fetch(`https://${serverName}/.well-known/matrix/client`)
    if (res.ok) {
      const body = await res.json()
      const base = body?.['m.homeserver']?.base_url
      if (base) {
        cachedHomeserverBase = base.replace(/\/+$/, '')
        notifyMediaBaseReady()
        return cachedHomeserverBase
      }
    }
  } catch (e) {
    console.warn('resolveHomeserverBase: .well-known delegation lookup failed, using bare server_name:', e.message)
  }
  // Cache the bare-server-name fallback too, not just return it (see comment
  // above cachedHomeserverBase). A plain <img src> GET isn't CORS-preflighted
  // the way the media *upload* POST was (see uploadMedia()'s CORS saga) — so
  // even if this bare hostname 302-redirects to the real delegated
  // homeserver, the browser will just follow it transparently for a simple
  // image load. Something is better than a permanently-null cache.
  cachedHomeserverBase = `https://${serverName}`
  notifyMediaBaseReady()
  return cachedHomeserverBase
}

/** Resolves and caches the real (delegated) homeserver base URL up front, so
 *  the first fetchAuthedMediaUrl() call doesn't have to pay for its own
 *  .well-known lookup even when the widget URL didn't carry a `baseUrl`
 *  param. Best effort; call once after init (see main.jsx). (Historical
 *  note: this used to matter more when avatar URLs were built synchronously
 *  in render via a now-removed mxcToHttp() — that's gone now that media
 *  requires an authenticated fetch, but priming the cache early is still a
 *  small win.) */
export async function primeMediaBase() {
  if (cachedHomeserverBase) return cachedHomeserverBase
  try {
    const { matrix_server_name } = await getOpenIdToken()
    return await resolveHomeserverBase(matrix_server_name)
  } catch (e) {
    console.warn('primeMediaBase failed (media URLs may be unavailable until an upload runs):', e.message)
    return null
  }
}

export async function uploadMedia(fileOrBlob, filename, contentType) {
  if (isCompanion) return companionUploadMedia(fileOrBlob, filename, contentType)
  // filename/contentType are no longer used to build a request — uploadFile()
  // takes just the file body (see header comment above) — but they stay in
  // the signature so callers in api.js don't need to change.
  const { content_uri } = await widgetApi.uploadFile(fileOrBlob)
  return content_uri // mxc://...
}

// ── User directory search (MSC3973) ─────────────────────────────────────────
// Backs the "Add person" form's search-as-you-type — see Database.jsx's
// PersonModal. Requires both the MSC3973UserDirectorySearch capability
// (requested in widget.js) AND the Element client itself to advertise
// MSC3973 support — neither is guaranteed, so callers must treat this as
// progressive enhancement and keep manual name/Matrix ID entry working
// regardless. Note the toolkit's searchUserDirectory() returns camelCase
// fields (userId/displayName/avatarUrl) — different from the raw API's
// snake_case — remapped back to snake_case here so nothing downstream
// (Database.jsx) needs to change.
export async function searchUserDirectory(searchTerm, limit = 8) {
  if (isCompanion) return companionSearchUserDirectory(searchTerm, limit)
  const { results } = await widgetApi.searchUserDirectory(searchTerm, { limit })
  return (results || []).map(r => ({
    user_id: r.userId,
    display_name: r.displayName || r.userId,
    avatar_url: r.avatarUrl || null, // mxc://... or null - see mxcToHttp()
  }))
}

// ── Existing-DM detection ────────────────────────────────────────────────────
// Best-effort lookup of a 1:1 DM room already shared with `targetUserId`, so
// the Person form can auto-fill dm_room_id instead of making the dispatcher
// paste it by hand.
//
// This is a HEURISTIC, not an authoritative lookup, and can't be otherwise:
// the canonical "which room is my DM with X" signal is the `m.direct` account
// data, and the Widget API has no capability to read account data at all (its
// whole model is room events/state). So instead we scan `m.room.member` across
// every room the dispatcher's client is in (Symbols.AnyRoom — same cross-room
// read the beacon aggregation uses) and return a room whose *current*
// join/invite membership is exactly {self, target}, AND where both self and
// target explicitly hold power level 100 (2026-08-02 — Element's own "start
// DM" flow explicitly sets BOTH occupants of a new DM room to power level
// 100 in `m.room.power_levels.users`, not just "equal to each other" — a
// fresh ad hoc 2-person room where nobody's touched power levels would also
// have self/target "equal" (both at the room's users_default, usually 0),
// so requiring the literal value 100 is the closer match to what a real
// Element-created DM room looks like, not merely equal-to-each-other). Both
// checks are still heuristics, not a real is-this-a-DM guarantee (that's
// what `m.direct` account data is for, and the Widget API can't read
// account data at all) — acceptable for a "we pre-filled this, check it's
// right" convenience, and the field stays editable. Returns the room id or
// null.
//
// `selfUserId` must be supplied by the caller (the backend's verified whoami
// user_id) — the widget's own user id isn't reliably in widgetParameters
// (depends on $matrix_user_id being in the registration URL), so we don't try
// to guess it here.
export async function findDmRoom(targetUserId, selfUserId) {
  if (isCompanion) return companionFindDmRoom(targetUserId, selfUserId)
  if (!targetUserId || !selfUserId || targetUserId === selfUserId) return null

  const [members, powerLevels] = await Promise.all([
    withTimelineRetry(() => widgetApi.receiveStateEvents('m.room.member', { roomIds: Symbols.AnyRoom })),
    withTimelineRetry(() => widgetApi.receiveStateEvents('m.room.power_levels', { roomIds: Symbols.AnyRoom })),
  ])

  // Current room state is one member event per (room, user); a departed user
  // shows membership 'leave'/'ban' and is excluded, so a set of size 2 really
  // is a room with two present people.
  const presentByRoom = new Map()
  const directRooms = new Set() // rooms whose member event carried is_direct
  for (const e of (members || [])) {
    const membership = e.content?.membership
    if (membership !== 'join' && membership !== 'invite') continue
    const set = presentByRoom.get(e.room_id) || new Set()
    set.add(e.state_key)
    presentByRoom.set(e.room_id, set)
    if (e.content?.is_direct) directRooms.add(e.room_id)
  }

  // m.room.power_levels is one event per room (empty state key), giving a
  // `users` map (user_id -> power level) plus a `users_default` fallback for
  // anyone not listed explicitly.
  const powerLevelsByRoom = new Map()
  for (const e of (powerLevels || [])) {
    powerLevelsByRoom.set(e.room_id, e.content || {})
  }
  function powerLevelOf(roomId, userId) {
    const content = powerLevelsByRoom.get(roomId)
    if (!content) return 0 // no power_levels event read for this room — treat as default/unknown
    const users = content.users || {}
    return userId in users ? users[userId] : (content.users_default ?? 0)
  }

  const matches = []
  for (const [roomId, set] of presentByRoom) {
    if (set.size !== 2 || !set.has(selfUserId) || !set.has(targetUserId)) continue
    if (powerLevelOf(roomId, selfUserId) !== 100 || powerLevelOf(roomId, targetUserId) !== 100) continue
    matches.push(roomId)
  }
  if (matches.length === 0) return null
  // Prefer a room explicitly flagged is_direct if we saw that flag; else just
  // take the first 2-person, both-power-100 match.
  return matches.find(r => directRooms.has(r)) || matches[0]
}

// ── Joined-room enumeration (team broadcast-room picker) ─────────────────────
// Lists the rooms the dispatcher's Element client is joined to, so the Teams
// editor can offer a PICKER (choose an existing room) instead of making the
// admin paste a raw !room:server id. There's no "list my rooms" Widget API
// call, so — same trick as beacon aggregation and findDmRoom — we read state
// across Symbols.AnyRoom and reconstruct the list: m.room.member gives the
// roster (and thus member_count + who's in it), m.room.name the display name,
// m.room.encryption whether it's E2EE.
//
// Returns [{ room_id, name, member_count, members: string[], encrypted,
// is_dm }], sorted by name. `members` (the joined user_ids) is included so the
// caller can do the team-coverage cross-check (which team members are / aren't
// in the room) without a second round trip. Works only for rooms the client
// is actually joined to — which is exactly the constraint the admin's flow
// already assumes (they created/joined the room in Element first).
export async function listJoinedRooms() {
  if (isCompanion) return companionListJoinedRooms()

  const [memberEvents, nameEvents, encEvents] = await Promise.all([
    withTimelineRetry(() => widgetApi.receiveStateEvents('m.room.member', { roomIds: Symbols.AnyRoom })),
    withTimelineRetry(() => widgetApi.receiveStateEvents('m.room.name', { roomIds: Symbols.AnyRoom })).catch(() => []),
    withTimelineRetry(() => widgetApi.receiveStateEvents('m.room.encryption', { roomIds: Symbols.AnyRoom })).catch(() => []),
  ])

  const nameByRoom = new Map()
  for (const e of (nameEvents || [])) {
    if (e.content?.name) nameByRoom.set(e.room_id, e.content.name)
  }
  const encryptedRooms = new Set((encEvents || []).filter(e => e.content?.algorithm).map(e => e.room_id))

  // Joined members per room (invite-state members don't count toward "who will
  // receive a message" the way a joined member does).
  const membersByRoom = new Map()
  for (const e of (memberEvents || [])) {
    if (e.content?.membership !== 'join') continue
    const set = membersByRoom.get(e.room_id) || new Set()
    set.add(e.state_key)
    membersByRoom.set(e.room_id, set)
  }

  const rooms = []
  for (const [roomId, set] of membersByRoom) {
    const members = [...set]
    rooms.push({
      room_id: roomId,
      name: nameByRoom.get(roomId) || null,
      member_count: members.length,
      members,
      encrypted: encryptedRooms.has(roomId),
      is_dm: members.length === 2,
    })
  }
  rooms.sort((a, b) => (a.name || a.room_id).localeCompare(b.name || b.room_id))
  return rooms
}

// Full member roster (with display names + avatars) for one room. No longer
// called from api.js (the room-membership-driven team roster it used to
// feed — importFromRoom/syncFromRoom — was removed 2026-08-10, see
// CHANGES.md "Decouple team roster from room membership"); kept as a plain
// matrixStore primitive since it's still generically useful and reachable
// via the companion relay. m.room.member content carries `displayname` and
// `avatar_url` (an mxc:// URI, reusable directly as image_mxc — same as a
// directory-search pick). Joined members only.
export async function getRoomMembers(roomId) {
  if (isCompanion) return companionGetRoomMembers(roomId)
  if (!roomId) return []
  // Read m.room.member across Symbols.AnyRoom and filter to the target room,
  // rather than passing { roomIds: [roomId] }. This matches listJoinedRooms
  // (which is confirmed to return member data) — a single-room read for a room
  // that isn't the widget's own can come back empty/rejected on some Element
  // builds even with the AnyRoom timeline grant, whereas the AnyRoom read is
  // the path that actually works here.
  //
  // Retried with backoff (2026-07-29 fix): confirmed live that this could
  // come back with ZERO members for a linked TEAM room right after a fresh
  // widget reload, even though the room genuinely has members — the same
  // WidgetDriver/local-timeline-cache race already fixed for m.room.
  // encryption and the keyring read, just worse here: this is reading a room
  // OTHER than the widget's own current room, so Element's local cache for
  // it is even less likely to be warm the instant the widget boots.
  // withTimelineRetry() only catches THROWN errors, not a silent empty
  // result, so it needs its own retry loop the same way isRoomEncrypted()
  // and readCanonicalKey() do.
  let events = null
  for (let attempt = 0; attempt < 4; attempt++) {
    events = await withTimelineRetry(() =>
      widgetApi.receiveStateEvents('m.room.member', { roomIds: Symbols.AnyRoom })
    )
    const forThisRoom = (events || []).filter((e) => e.room_id === roomId)
    if (forThisRoom.length > 0) break
    if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  const out = []
  for (const e of (events || [])) {
    if (e.room_id !== roomId) continue
    if (e.content?.membership !== 'join') continue
    out.push({
      user_id: e.state_key,
      display_name: e.content.displayname || e.state_key,
      avatar_url: e.content.avatar_url || null,
    })
  }
  return out
}

// ── Location tagging via native Element "share location" (2026-08-03) ───────
// Replaces the crew->dispatcher half of the \car/\motorcycle text-command
// convention (vehicleCommands.js) with: crew member uses Element's own
// native "share location" feature (a real m.location message, any Matrix
// client can do this — no CrewBoard-specific typing required), then some
// client (currently: nothing yet — see LOCATION_TAG_MOBILE_HANDOFF.md, this
// is the widget-side half only) posts a small STATE event pointing at it —
// see widget.js's LOCATION_TAG_STATE_TYPE comment for the full rationale
// (state, not another timeline event, specifically so a widget that was
// closed when the share happened still catches up on reconnect).
//
// Deliberately host-only, same as startRelayHost() itself — a companion
// popup window has no Widget API of its own to send/receive state events
// with, and doesn't need to: whichever CrewBoard instance (almost always the
// real widget) processes a pending tag writes straight to Postgres via
// api.markers.create()/update(), and every OTHER open instance (including
// any companion windows) picks up the resulting marker the normal way, via
// the existing Postgres LISTEN/NOTIFY -> SSE -> crewboard:markers-updated
// pipeline — not by also reading/racing on the Matrix state event itself.
// Callers (locationTagging.js, wired from Layout.jsx) must check
// `!isCompanion` themselves before using any of these.

/** All CURRENTLY PENDING location-tag state events across every room the
 *  dispatcher's client is joined to (Symbols.AnyRoom, same cross-room read
 *  every other feature here uses). "Pending" = non-empty content — a
 *  cleared/consumed tag has its content overwritten to {} (see
 *  clearLocationTagState() below) and is filtered out here, so a widget
 *  reconnecting never reprocesses (and never resurrects) a tag someone else
 *  already turned into a marker. */
export async function readPendingLocationTags() {
  const events = await withTimelineRetry(() =>
    widgetApi.receiveStateEvents(LOCATION_TAG_STATE_TYPE, { roomIds: Symbols.AnyRoom })
  )
  return (events || []).filter(e => e.content && e.content.event_id)
}

/** Fetches the room's own recent m.room.message timeline (Symbols.AnyRoom)
 *  and returns the one whose event_id matches, if it's a real
 *  msgtype:'m.location' message (the shape sendLocation()/native Element
 *  share both produce). Used to resolve what a location-tag state event's
 *  `event_id` actually points at. Returns null if not found/not a location
 *  message — the caller (locationTagging.js) treats that as "can't process
 *  yet" rather than an error, since a state event can legitimately arrive
 *  slightly before its pointed-to message is visible in a fresh read. */
export async function resolveLocationTagTarget(eventId) {
  if (!eventId) return null
  const events = await withTimelineRetry(() =>
    widgetApi.receiveRoomEvents('m.room.message', { roomIds: Symbols.AnyRoom })
  )
  const match = (events || []).find(e => e.event_id === eventId)
  if (!match || match.content?.msgtype !== 'm.location') return null
  const geoUri = match.content?.geo_uri || match.content?.['org.matrix.msc3488.location']?.uri
  const coords = parseGeoUri(geoUri)
  if (!coords) return null
  return {
    sender: match.sender,
    room_id: match.room_id,
    lat: coords.lat,
    lng: coords.lng,
    body: match.content?.body || null,
  }
}

/** Publishes (or overwrites) the pending tag pointer for `stateKey` (see
 *  locationTagging.js — convention is the sharer's own user id, one pending
 *  tag per sender, matching the existing \car/\motorcycle dedup model).
 *  `content` should be just `{ event_id, tag, ts }` — see widget.js's
 *  comment on why this is kept deliberately small (state events are never
 *  E2EE). */
export async function sendLocationTagState(content, stateKey, roomId) {
  return widgetApi.sendStateEvent(LOCATION_TAG_STATE_TYPE, content, { roomId: roomId || getRoomId() || undefined, stateKey })
}

/** Marks a tag as consumed by overwriting its content with {} — Matrix state
 *  events can't be deleted, only replaced, so an empty object is this app's
 *  "nothing pending here" convention (same idea as m.room.topic's removal
 *  convention). Idempotent: clearing an already-empty state event is a
 *  harmless no-op, which matters because more than one CrewBoard instance
 *  could theoretically race to process + clear the same tag (see
 *  locationTagging.js's own dedupe-by-marker-entity_id guard for the
 *  Postgres-write half of that race). */
export async function clearLocationTagState(stateKey, roomId) {
  return widgetApi.sendStateEvent(LOCATION_TAG_STATE_TYPE, {}, { roomId: roomId || getRoomId() || undefined, stateKey })
}

// ── Authenticated media (Matrix v1.11 / MSC3916) ────────────────────────────
// Superseded the old synchronous mxcToHttp() (2026-07-23). That function
// built a plain URL string against the legacy `/_matrix/media/v3/thumbnail/
// ...` endpoint — confirmed LIVE against this homeserver (Synapse 1.156, by
// exec'ing into the synapse pod and hitting localhost:8008 directly,
// bypassing all the DNS noise) that this endpoint now returns 404
// M_NOT_FOUND unconditionally, regardless of width/height. This server has
// "authenticated media" enabled (Synapse's default since ~1.108) — the
// legacy unauthenticated endpoints are simply gone for this media. The
// earlier "switch width 320 → 352" fix was chasing the wrong cause; it
// happened to look plausible because the failure mode (image just doesn't
// load) was identical either way.
//
// The replacement, `/_matrix/client/v1/media/thumbnail/...`, does exist
// (confirmed via a 401 M_MISSING_TOKEN response, not 404) but requires a
// real `Authorization: Bearer <token>` header — which a browser cannot
// attach to a plain <img src="...">. So this can no longer be a synchronous
// "build a URL string" function at all: it has to fetch() with an auth
// header and hand back a blob: object URL instead.
//
// The token reused here is the same OpenID token uploadMedia() already
// requests via getOpenIdToken() (widgetApi.requestOpenIDConnectToken()) and
// successfully uses as a Bearer credential against this same homeserver's
// media API (confirmed working for the upload path) — not a different,
// unproven token type.
//
// Cached per `${mxc}:${size}` so repeated renders of the same avatar don't
// re-fetch/re-decode the image or mint a new blob: URL every time (object
// URLs are also cheap to leak if minted per-render — Persons/Vehicles lists
// re-render often via the live-update listeners in Database.jsx).
const mediaUrlCache = new Map() // key -> Promise<string | null>

/** Fetches an mxc:// URI as an authenticated thumbnail and resolves to a
 *  `blob:` object URL usable in an <img src>, or null if there's no mxc, no
 *  homeserver base yet, or the fetch fails. Async now (see header comment
 *  above) — callers need a useEffect/useState, not a direct render call;
 *  see Database.jsx's usage. */
export async function fetchAuthedMediaUrl(mxc, size = 352) {
  if (!mxc || !mxc.startsWith('mxc://')) return null
  const cacheKey = `${mxc}:${size}`
  if (mediaUrlCache.has(cacheKey)) return mediaUrlCache.get(cacheKey)

  const promise = (async () => {
    if (isCompanion) return companionFetchMediaUrl(mxc, size)
    const blob = await fetchMediaBlob(mxc, size)
    return blob ? URL.createObjectURL(blob) : null
  })()

  mediaUrlCache.set(cacheKey, promise)
  // Don't poison the cache with a failed attempt — a transient network blip
  // shouldn't permanently blank an avatar for the rest of the session the
  // way the old cachedHomeserverBase bug did.
  promise.catch(() => mediaUrlCache.delete(cacheKey))
  return promise
}

/** Does the actual authenticated fetch + returns a raw Blob (not a URL) —
 *  used directly by fetchAuthedMediaUrl() in normal widget mode, AND handed
 *  to relay.js's startRelayHost() so a companion window (which has no
 *  Widget API of its own, so can't request an OpenID token) can ask the
 *  host to fetch on its behalf and relay back the Blob (structured-clonable
 *  over BroadcastChannel) — see relay.js's 'fetchMediaUrl' case and
 *  companionFetchMediaUrl(). */
export async function fetchMediaBlob(mxc, size = 352) {
  if (!mxc || !mxc.startsWith('mxc://')) return null
  const { access_token, matrix_server_name } = await getOpenIdToken()
  const homeserverUrl = getWidgetUrlParam('baseUrl') || await resolveHomeserverBase(matrix_server_name)
  const path = `/_matrix/client/v1/media/thumbnail/${mxc.slice('mxc://'.length)}`
  const query = new URLSearchParams({ width: String(size), height: String(size), method: 'crop' })
  const res = await fetch(`${homeserverUrl.replace(/\/+$/, '')}${path}?${query.toString()}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  if (!res.ok) throw new Error(`Authenticated media fetch failed (${res.status})`)
  return res.blob()
}
