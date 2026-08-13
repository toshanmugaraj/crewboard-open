// ── Matrix Widget bootstrap ──────────────────────────────────────────────────
// CrewBoard runs as an <iframe> Matrix Widget hosted by Element, plus a small
// backend for the data that needs real encryption at rest. This module owns
// the single WidgetApi connection to the Element host and the capability set
// the widget needs (state events for teams/persons/vehicles/markers/presets,
// plus message events for chat, locations, contact cards, and vehicle cards).
//
// Migrated (2026-07-20) from raw `matrix-widget-api` to
// `@matrix-widget-toolkit/api`'s `WidgetApiImpl`, which wraps the same
// underlying library with a friendlier receive/observe/send surface and
// theme-aware MUI components (see main.jsx). `WidgetApiImpl.create()` takes
// the capability list directly rather than requiring a separate
// requestCapabilities() call after construction, and — confirmed against its
// real source (packages/api/src/api/WidgetApiImpl.ts) — automatically adds
// `MatrixCapabilities.RequiresClient` unless `supportStandalone: true` is
// passed, which we don't need here.
//
// One real gap in the toolkit (confirmed against its `WidgetApi` type, which
// literally has `// TODO: sendSticker, setAlwaysOnScreen` at the bottom):
// `setAlwaysOnScreen()` isn't wrapped. The toolkit's `WidgetApiImpl` exposes
// the underlying raw `matrix-widget-api` instance as `.matrixWidgetApi` for
// exactly this kind of escape hatch — used below in setFloating().
import {
  WidgetApiImpl,
  repairWidgetRegistration,
} from '@matrix-widget-toolkit/api'
import {
  WidgetEventCapability,
  EventDirection,
  MatrixCapabilities,
  Symbols,
} from 'matrix-widget-api'

const STATE_EVENT_TYPES = [
  'org.crewboard.team',
  'org.crewboard.person',
  'org.crewboard.vehicle',
  'org.crewboard.marker',
  'org.crewboard.preset',
  'org.crewboard.settings',
]

const ROOM_EVENT_TYPES = [
  'm.room.message',
  'org.crewboard.location',
  'org.crewboard.contact',
  'org.crewboard.vehicle-card',
]

// New crew -> dispatcher location-tagging path (2026-08-03), replacing the
// \car/\motorcycle text-command convention (vehicleCommands.js) with a
// native-Element-"share location" + state-event pointer approach: a crew
// member shares their location the normal Element way (a real m.location
// timeline event), then a client sends this STATE event pointing at it
// (content: { event_id, tag }). Using state here — not another timeline
// event — is deliberate and different from every other custom event in this
// file: state events are always retrievable via receiveStateEvents() the
// instant a widget (re)connects, with no dependency on having been
// subscribed live when it was sent. That's what fixes the known gap in the
// old command approach (documented in vehicleCommands.js: "a command sent
// while the widget is closed is simply missed"). CrewBoard clears the state
// event's content (empty object) once it's processed into Postgres, so a
// later widget load never reprocesses/resurrects it — see locationTagging.js.
//
// Content is NOT E2EE (state events never are, regardless of room
// encryption — same reason the old teams/persons/vehicles/markers state-event
// "database" was abandoned for Postgres, see this file's CLAUDE.md). Kept
// deliberately tiny (just an event_id pointer + a short tag string, e.g.
// "car"/"motorcycle"/"person"/"misc") — no coordinates, no label, no note —
// so the only thing exposed to the homeserver operator as plaintext is "a
// share tagged <type> happened, pointing at message X", not the actual
// location. The real coordinates stay wherever the pointed-to m.location
// message's encryption already puts them (Megolm, if the room's encrypted —
// which main.jsx already requires for this whole app), and again separately
// once written into Postgres by the usual client-side field encryption.
export const LOCATION_TAG_STATE_TYPE = 'org.crewboard.location-tag'

function buildCapabilities() {
  const caps = []

  // Required separately from the send/receive event capabilities below.
  // Per ClientWidgetApi.canUseRoomTimeline() (still the same underlying
  // matrix-widget-api this toolkit wraps), every read_events/readStateEvents/
  // readRoomEvents/send_event(with an explicit room_id) call is gated on
  // `org.matrix.msc2762.timeline:<roomId>` BEFORE the per-event-type
  // capability is even checked. Requesting `timeline:*` (Symbols.AnyRoom)
  // grants this for EVERY room the dispatcher's Element client is joined to
  // — see messaging_architecture_plan.md.
  caps.push(`org.matrix.msc2762.timeline:${Symbols.AnyRoom}`)

  for (const type of STATE_EVENT_TYPES) {
    caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, type).raw)
    caps.push(WidgetEventCapability.forStateEvent(EventDirection.Send, type).raw)
  }
  // Live location beacons sent by mobile Element clients (MSC3672): two
  // event types, not one — `org.matrix.msc3672.beacon_info` is the STATE
  // event announcing a live-sharing session (no coordinates);
  // `org.matrix.msc3672.beacon` is a separate TIMELINE event carrying the
  // moving coordinates, linked back via m.relates_to. See
  // matrixStore.js's readBeacons().
  //
  // IMPORTANT (confirmed live, 2026-07-20, by inspecting a real state event
  // dumped from this room): MSC3672 was never stabilized into the main
  // Matrix spec, and this deployment (this Element/Synapse combination)
  // still uses the UNSTABLE, prefixed event names —
  // `org.matrix.msc3672.beacon_info` / `org.matrix.msc3672.beacon` — not the
  // shortened `m.beacon_info` / `m.beacon` this code requested/read for the
  // entire rest of this debugging session. That was the actual root cause
  // of every empty beacon read, not the capability/timeline-vs-state issues
  // chased earlier (those were all real findings about the API, just not
  // this bug — request/read for a type that was never actually being
  // created under that name).
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, 'org.matrix.msc3672.beacon_info').raw)
  caps.push(WidgetEventCapability.forRoomEvent(EventDirection.Receive, 'org.matrix.msc3672.beacon').raw)

  // ── Client-side room-member-only encryption (see roomCrypto.js) ──────────
  // `org.crewboard.keyring` is a room *message* event (not state — state
  // events are never E2EE'd), carrying the room's AES key. Element Megolm-
  // encrypts it so only room members can read it; the homeserver and our
  // backend can't. Send + receive so we can both publish it (first setup /
  // republish on join) and read it back.
  caps.push(WidgetEventCapability.forRoomEvent(EventDirection.Send, 'org.crewboard.keyring').raw)
  caps.push(WidgetEventCapability.forRoomEvent(EventDirection.Receive, 'org.crewboard.keyring').raw)

  // Read m.room.encryption to confirm the room is actually encrypted before
  // trusting any of the above (CrewBoard is encrypted-rooms-only now);
  // m.room.member to watch for new joiners and republish the key to them;
  // m.room.power_levels to decide who may publish/adjust history visibility.
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, 'm.room.encryption').raw)
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, 'm.room.member').raw)
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, 'm.room.power_levels').raw)
  // m.room.name / m.room.canonical_alias: read across AnyRoom to enumerate the
  // rooms the dispatcher is joined to for the team broadcast-room PICKER
  // (Teams.jsx) — so an admin can pick an existing room instead of pasting a
  // raw room id. See matrixStore.js's listJoinedRooms().
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, 'm.room.name').raw)
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, 'm.room.canonical_alias').raw)

  // Set m.room.history_visibility to "shared" so Element will backfill the
  // room key to members who join later (belt to the republish-on-join
  // suspenders — see roomCrypto.js). Receive to check the current value
  // before changing it; send to change it (only used if we have PL>=50).
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, 'm.room.history_visibility').raw)
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Send, 'm.room.history_visibility').raw)

  for (const type of ROOM_EVENT_TYPES) {
    caps.push(WidgetEventCapability.forRoomEvent(EventDirection.Receive, type).raw)
    caps.push(WidgetEventCapability.forRoomEvent(EventDirection.Send, type).raw)
  }

  // Send: CrewBoard needs to clear a pending tag's state event once it's
  // processed. Receive: CrewBoard needs to read pending tags on load/live
  // (see LOCATION_TAG_STATE_TYPE comment above). Not scoped to a stateKey —
  // same as the STATE_EVENT_TYPES loop above — since state keys here vary
  // per sender.
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Receive, LOCATION_TAG_STATE_TYPE).raw)
  caps.push(WidgetEventCapability.forStateEvent(EventDirection.Send, LOCATION_TAG_STATE_TYPE).raw)

  // Lets CrewBoard ask to "float" (picture-in-picture) via setFloating()
  // below — same capability Jitsi/Element Call widgets use.
  caps.push(MatrixCapabilities.AlwaysOnScreen)

  // Lets the "Add person" form search the homeserver's user directory
  // (MSC3973) — see matrixStore.js's searchUserDirectory(). Progressive
  // enhancement: older clients don't support MSC3973 at all.
  caps.push(MatrixCapabilities.MSC3973UserDirectorySearch)

  // Lets matrixStore.js's uploadMedia() hand the file to ELEMENT to upload
  // (MSC4039's org.matrix.msc4039.upload_file action) instead of this widget
  // making its own authenticated fetch to the homeserver's media API. Media
  // uploads used to go straight from the widget using an OpenID token as the
  // Authorization bearer — which 401'd once something started actually
  // enforcing the Matrix spec here: OpenID tokens are for federation
  // identity verification (the `/_matrix/federation/.../openid/userinfo`
  // flow), never valid Client-Server API bearer tokens, so that upload was
  // never really supposed to work. This capability routes the upload
  // through Element's own already-authenticated session instead — no token
  // juggling on CrewBoard's side at all. Experimental/unstable per its own
  // type comment, but it's what @matrix-widget-toolkit/api's uploadFile()
  // needs, and it's the only widget-native upload path that exists.
  caps.push(MatrixCapabilities.MSC4039UploadFile)

  // Symmetric counterpart to MSC4039UploadFile above — lets
  // matrixStore.js's fetchMediaBlob() hand mxc:// URIs to Element
  // (org.matrix.msc4039.download_file) instead of the widget making its
  // own authenticated fetch to the homeserver's media API. Superseded
  // (2026-08-13) a direct-fetch chain that tried the thumbnail endpoint
  // unauthenticated, then retried with an OpenID token as a Bearer
  // credential — the same "OpenID tokens aren't real access_tokens" gap
  // documented above for uploads applied equally to downloads, so that
  // retry was never guaranteed to work either. Routing through Element's
  // own session sidesteps auth, CORS, and federation redirects all at
  // once. Same experimental/unstable caveat as MSC4039UploadFile.
  caps.push(MatrixCapabilities.MSC4039DownloadFile)

  // Lets CrewBoard ask Element to jump the user to a room or user profile —
  // the escape hatch used when a person/team doesn't have a linked DM/team
  // room yet (see navigateTo() below).
  caps.push(MatrixCapabilities.MSC2931Navigate)

  return caps
}

// `WidgetApiImpl.create()` should run as early as possible (per the
// toolkit's own docs: "especially on Safari", to not miss the connection
// handshake) — kicked off at module load, awaited by initWidget() below and
// by <MuiWidgetApiProvider> in main.jsx (both need the same promise).
//
// IMPORTANT: guarded against companion-window mode (relay.js's popup flow,
// `?companion=1`). The old raw `new WidgetApi()` constructor was harmless to
// call unconditionally because it stayed inert until `.start()` was
// explicitly invoked by initWidget() — which main.jsx only ever calls in the
// non-companion branch. The toolkit's `WidgetApiImpl.create()` is not inert:
// its `initialize()` calls `.start()` and blocks on the `ready` handshake
// immediately. A companion window is a plain window.open()'d tab with no
// widgetId/parentUrl and no real Element host on the other end (see
// relay.js's header comment) — letting `create()` run there would hang
// forever waiting for a handshake that will never arrive. Detected the same
// way relay.js does (`?companion=1` in the URL) rather than importing
// isCompanion from relay.js, since relay.js already imports getRoomId/
// getOpenIdToken from this file — importing back would be circular.
const isCompanionWindow = new URLSearchParams(window.location.search).get('companion') === '1'

export const widgetApiPromise = isCompanionWindow
  ? new Promise(() => {}) // never resolves; companion mode never awaits this — see initWidget() below
  : WidgetApiImpl.create({
      capabilities: buildCapabilities(),
      supportStandalone: false,
    })

// Most of matrixStore.js/api.js needs synchronous access to the resolved
// instance rather than threading a promise through every call — initWidget()
// populates this once the promise above resolves.
export let widgetApi = null

// Element pushes this to-widget action whenever the user toggles light/dark
// theme. <MuiThemeProvider> (see main.jsx) handles the modern theme sync via
// widget parameters; this stays as a light-weight forwarder for any
// non-MUI code that still wants to react to it directly.
if (!isCompanionWindow) {
  widgetApiPromise.then((api) => {
    api.matrixWidgetApi.on('action:theme_change', (ev) => {
      ev.preventDefault?.()
      window.dispatchEvent(new CustomEvent('crewboard:theme-changed', { detail: ev.detail?.data }))
    })
  })
}

let readyPromise = null

/** Waits for the WidgetApiImpl connection above to finish its handshake with
 *  the Element host and populates the module-level `widgetApi` export.
 *  Capabilities were already passed to WidgetApiImpl.create() at module load
 *  (see widgetApiPromise above) — unlike the old raw-API version, there's no
 *  separate requestCapabilities()/start() dance needed here; `create()` does
 *  both and only resolves once Element has responded (approved or not — see
 *  hasInitialCapabilities() if a caller ever needs to check). */
export function initWidget() {
  if (readyPromise) return readyPromise

  const params = new URLSearchParams(window.location.search)
  const widgetId = params.get('widgetId') || params.get('widgetid')
  if (!widgetId) {
    readyPromise = Promise.reject(new Error(
      'No widgetId in the URL — this app must be opened as a registered ' +
      'Matrix Widget inside Element, not loaded directly in a browser tab.'
    ))
    return readyPromise
  }

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timed out waiting for the Element widget host to respond.')), 20000)
  )

  readyPromise = Promise.race([widgetApiPromise, timeout]).then((api) => {
    widgetApi = api
    // ⚠️ TEMPORARY DEBUG HOOK (2026-07-28) — exposes the live WidgetApiImpl
    // instance on window so it can be poked from DevTools console inside
    // the widget iframe's own frame context (not Element's top-level
    // frame). Remove before this is trusted in production for real —
    // handing widgetApi to global scope is harmless read-wise (every call
    // still goes through the same granted-capability checks) but there's
    // no reason to leave a debug surface like this lying around.
    window.__cbWidgetApi = api
    return api
  })

  return readyPromise
}

/** The Matrix room this widget instance is running in. */
export function getRoomId() {
  const params = new URLSearchParams(window.location.search)
  return widgetApi?.widgetParameters?.roomId || params.get('roomId') || null
}

/** Requests a short-lived OpenID Connect token identifying the current user,
 *  used for direct homeserver calls the Widget API doesn't cover (e.g. media
 *  repo uploads for staff/vehicle photos and screenshots). Same shape as
 *  before — the toolkit's requestOpenIDConnectToken() just adds its own
 *  caching on top of the same underlying call. */
export async function getOpenIdToken() {
  return widgetApi.requestOpenIDConnectToken()
}

/** Asks Element to keep this widget floating on screen (a small
 *  picture-in-picture window) even when you navigate away from the room —
 *  the same mechanism Jitsi/Element Call widgets use. `setAlwaysOnScreen()`
 *  isn't wrapped by @matrix-widget-toolkit/api (confirmed against its
 *  WidgetApi type — literally has a `// TODO: ... setAlwaysOnScreen` marker),
 *  so this drops to the raw underlying instance via `.matrixWidgetApi`.
 *  Requires the m.always_on_screen capability requested above to have been
 *  granted; if not, Element just ignores the call rather than throwing. */
export async function setFloating(enabled) {
  return widgetApi.matrixWidgetApi.setAlwaysOnScreen(enabled)
}

/** Asks Element to navigate to a room or user profile, given a matrix.to
 *  URI (e.g. `https://matrix.to/#/!roomId:server` or `.../#/@user:server`).
 *  Used as the "Open in Element" escape hatch when a person/team doesn't
 *  have a DM/team room linked yet — see messaging_architecture_plan.md and
 *  the room-linking UI in Database.jsx/Teams.jsx. Requires the
 *  MSC2931Navigate capability requested above; rejects if Element doesn't
 *  grant it or the URI is malformed. Now built into the toolkit's WidgetApi
 *  directly (no raw fallback needed here). */
export async function navigateTo(uri) {
  // Guard against the null-deref this used to throw ("Cannot read properties
  // of null (reading 'navigateTo')") when called before initWidget() has
  // resolved, or — the actual real-world case that surfaced this — from a
  // companion popup window (?companion=1), where widgetApiPromise never
  // resolves at all (see its definition above) and widgetApi stays null
  // forever. Callers that can run in companion mode should go through
  // matrixStore.js's navigateTo() instead, which routes this over the
  // relay to the real widget iframe — this guard just turns the crash into
  // a clear error for any caller that still calls this directly.
  if (!widgetApi) {
    throw new Error(
      "Can't open Element from here — the CrewBoard widget connection isn't ready yet."
    )
  }
  return widgetApi.navigateTo(uri)
}

// matrix.to URIs put the raw room/user identifier (with its `!`/`@` sigil
// and `:server` suffix) directly in the fragment, unencoded — NOT
// percent-encoded like a normal URL path segment (Element's matrix.to
// parser expects the sigil literally, and matrix-widget-api's own check is
// just `startsWith("https://matrix.to/#")`).

/** Builds a matrix.to URI for a room, for use with navigateTo(). */
export function roomMatrixToUri(roomId) {
  return `https://matrix.to/#/${roomId}`
}

/** Builds a matrix.to URI for a user profile (Element shows a "start chat"
 *  option from there), for use with navigateTo(). */
export function userMatrixToUri(userId) {
  return `https://matrix.to/#/${userId}`
}

/** Fixes the widget's display name in Element's room-widget UI, which
 *  otherwise shows "Custom" — Element stamps that default in when a widget
 *  is added by URL without an explicit name, and it's stored in the shared
 *  `im.vector.modular.widgets` room state event (one value for the whole
 *  room, not per-member), which nothing in this app's own URL params
 *  controls.
 *
 *  Uses the toolkit's own `repairWidgetRegistration()` (confirmed against
 *  its real source, `@matrix-widget-toolkit/api`'s build output) rather than
 *  hand-rolling this: it already (a) only overwrites the name if it's
 *  currently falsy/"Custom"/"Custom Widget" — so it can never clobber a name
 *  an admin deliberately set to something else, and (b) races the write
 *  against a 1s timeout and treats that as success, working around a known
 *  quirk where Element's connection blips right after a widget config
 *  change.
 *
 *  Since the name is shared room state, this only needs to succeed ONCE,
 *  from whoever happens to have write power the first time they open
 *  CrewBoard after this shipped — every other member just sees the
 *  corrected name with no action of their own. Callers should gate this on
 *  the caller actually having write power (e.g. the backend's
 *  `whoami.can_write`) — not because an unprivileged send would do any harm
 *  (Element/Synapse would simply reject it), but because
 *  `repairWidgetRegistration()` requests a NEW capability
 *  (send+receive `im.vector.modular.widgets`) the first time it runs, which
 *  pops a permission prompt in Element — no reason to show that to members
 *  who could never actually use it.
 *
 *  BUG FIX (2026-07-27): `repairWidgetRegistration()` only decides WHAT value
 *  to write for `name` (keep the existing one vs. override it) — it does NOT
 *  decide WHETHER to write at all. Confirmed against its real source
 *  (`@matrix-widget-toolkit/api`'s build output): it unconditionally calls
 *  `widgetApi.sendStateEvent('im.vector.modular.widgets', ...)` at the end,
 *  every single time it's called, even when nothing actually changed. Since
 *  main.jsx calls this on every widget load for any user with write power,
 *  that was rewriting the widget's room state event on every single reload
 *  — harmless to the app, but it shows up in the room timeline as
 *  "Crewboard widget modified by <you>" every time, which is just noise once
 *  the name is already correct. Now reads the current registration first and
 *  only calls repairWidgetRegistration() (i.e. only writes) when the name
 *  actually still needs fixing.
 *
 *  CORRECTION to the first attempt at this fix: reading the registration
 *  needs the same `im.vector.modular.widgets` send+receive capability that
 *  `repairWidgetRegistration()` requests internally via
 *  `widgetApi.requestCapabilities(...)` — that capability is NOT part of
 *  this widget's initial handshake capability set (buildCapabilities()
 *  above), it's only ever requested ad-hoc, on demand. The first version of
 *  this guard called `receiveSingleStateEvent()` directly without
 *  requesting that capability first, so the read failed silently on every
 *  load and fell through to the exact same unconditional write as before —
 *  confirmed live (still showed "Crewboard widget modified by ..." on every
 *  reload after deploying that version). Now requests the capability
 *  ourselves first, same as `repairWidgetRegistration()` does — this is not
 *  a NEW capability beyond what was already being requested every time
 *  before, just requested slightly earlier so the read can actually
 *  succeed. */
export async function fixWidgetName(name = 'Crewboard') {
  if (!widgetApi) return

  try {
    await widgetApi.requestCapabilities([
      WidgetEventCapability.forStateEvent(EventDirection.Send, 'im.vector.modular.widgets', widgetApi.widgetId),
      WidgetEventCapability.forStateEvent(EventDirection.Receive, 'im.vector.modular.widgets', widgetApi.widgetId),
    ])
    const current = await widgetApi.receiveSingleStateEvent('im.vector.modular.widgets', widgetApi.widgetId)
    const currentName = current?.content?.name
    if (currentName && currentName !== 'Custom Widget' && currentName !== 'Custom') {
      return // already correct — skip the unconditional rewrite entirely
    }
  } catch {
    // Couldn't request the capability or read the event — fall through and
    // let repairWidgetRegistration() try the whole thing itself, same as
    // before this guard existed.
  }

  await repairWidgetRegistration(widgetApi, { name })
}
