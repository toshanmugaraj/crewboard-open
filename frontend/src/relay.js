// ── Companion-window relay ───────────────────────────────────────────────────
// Lets CrewBoard open in a real, separate top-level browser window/tab (via
// window.open(), see Layout.jsx's "Open in a separate window" button) while
// still talking to the Matrix room. This exists because the Document
// Picture-in-Picture API is permanently blocked from widget iframes (see
// PAINPOINTS.md's "True floating window" section) — window.open() has no
// such restriction, but the new tab has no widgetId/parentUrl, so it can't
// do its own Widget API handshake (initWidget() would just time out
// waiting for an Element host that isn't there). Instead: the ORIGINAL
// widget iframe (which does have a real Widget API connection) stays
// mounted and acts as a relay/transport; the popup talks to it over
// BroadcastChannel, which works between same-origin windows/tabs regardless
// of iframe/top-level status — unlike Document PiP, nothing here is gated
// on being a top-level browsing context.
//
// Constraint this implies: the popup only works while the original widget
// iframe is still alive somewhere in Element (minimized/floating via
// setFloating() in widget.js is fine — closing the room/widget entirely
// kills the transport for any open companion windows too).
//
// Known limitation: if roomId isn't passed in the popup's URL (only
// happens if something opens a companion window without going through
// Layout.jsx's button), and the user has more than one CrewBoard widget
// open in different rooms/tabs at once, the companion may bind to
// whichever host answers first rather than a specific room. Layout.jsx's
// popout button avoids this by encoding the current room's id into the
// popup URL up front.
import { getRoomId, getOpenIdToken, navigateTo } from './widget.js'

const CHANNEL_NAME = 'crewboard-relay'
const HELLO_TIMEOUT_MS = 4000
// Every non-hello method the host answers (sendMessage/sendRoomEvent/
// readInbox/readBeacons/...) ultimately goes through matrix-widget-api's
// own from-widget postMessage RPC, which has a fixed 10-second internal ack
// timeout (PostmessageTransport.js) -- Element occasionally takes close to
// that long to respond even on a successful send (see matrixStore.js's
// sendRoomEvent() fire-and-forget catch for the non-companion case). This
// timeout used to also be 10000, i.e. the SAME duration -- meaning this
// companion-side clock and the host's internal widget-api clock started at
// roughly the same moment and raced each other, so the companion routinely
// gave up and showed "Couldn't reach the CrewBoard tab" a moment before the
// host's (successful, just slow) response arrived over the channel.
// Comfortably longer than the host's worst case (10s) plus readBeacons'/
// readInbox's own retry-on-timeline-race backoff (withTimelineRetry in
// matrixStore.js, up to ~2.4s extra) plus BroadcastChannel/relay overhead.
const RPC_TIMEOUT_MS = 20000

const params = new URLSearchParams(window.location.search)
export const isCompanion = params.get('companion') === '1'
const targetRoomId = params.get('roomId') || null

let channel = null
function getChannel() {
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME)
  return channel
}

function rpcId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// ── Host side (runs inside the real widget iframe) ──────────────────────────
// Call once, after initWidget() has resolved. Answers RPC requests from any
// companion window(s) for this same room, and forwards live pushes (see
// broadcastPush(), called from matrixStore.js's fanOut()).
let hostStarted = false
export function startRelayHost(matrixStoreFns) {
  if (hostStarted || isCompanion) return
  hostStarted = true
  const roomId = getRoomId()
  const ch = getChannel()

  ch.addEventListener('message', async (ev) => {
    const msg = ev.data
    if (!msg || msg.kind !== 'request') return
    // Only respond if the request is for our room, or didn't specify one.
    if (msg.roomId && roomId && msg.roomId !== roomId) return

    if (msg.method === 'hello') {
      ch.postMessage({ kind: 'response', id: msg.id, ok: true, result: { roomId } })
      return
    }

    try {
      let result
      switch (msg.method) {
        case 'getOpenIdToken':
          result = await getOpenIdToken()
          break
        case 'sendMessage':
          result = await matrixStoreFns.sendMessage(msg.args.body, msg.args.extra, msg.args.targetRoomId)
          break
        case 'sendRoomEvent':
          result = await matrixStoreFns.sendRoomEvent(msg.args.eventType, msg.args.content, msg.args.targetRoomId)
          break
        case 'readInbox':
          result = await matrixStoreFns.readInbox(msg.args.limit)
          break
        case 'readBeacons':
          result = await matrixStoreFns.readBeacons()
          break
        case 'uploadMedia':
          result = await matrixStoreFns.uploadMedia(msg.args.file, msg.args.filename, msg.args.contentType)
          break
        case 'searchUserDirectory':
          result = await matrixStoreFns.searchUserDirectory(msg.args.searchTerm, msg.args.limit)
          break
        case 'findDmRoom':
          result = await matrixStoreFns.findDmRoom(msg.args.targetUserId, msg.args.selfUserId)
          break
        case 'listJoinedRooms':
          result = await matrixStoreFns.listJoinedRooms()
          break
        case 'getRoomMembers':
          result = await matrixStoreFns.getRoomMembers(msg.args.roomId)
          break
        case 'navigateTo':
          // Lets a companion popup window use the "Open in Element" escape
          // hatch (Database.jsx/Teams.jsx) even though it has no Widget API
          // of its own — navigateTo() only exists on the real widget's
          // WidgetApiImpl instance (widget.js), so the host does it and just
          // reports back whether Element accepted the request.
          result = await navigateTo(msg.args.uri)
          break
        case 'getRoomKeyMaterial':
          // Hands the raw room encryption key to a companion window so it can
          // decrypt/encrypt fields itself (a companion has no Widget API and
          // can't read the Megolm-encrypted keyring event). This travels only
          // over the same-origin BroadcastChannel — inside the user's own
          // browser, never the network. See roomCrypto.js.
          result = matrixStoreFns.getRoomKeyMaterial()
          break
        case 'fetchMediaUrl':
          // Avatars/photos go through the Widget API's downloadFile()
          // (MSC4039's download_file action — see matrixStore.js's
          // fetchMediaBlob()/fetchAuthedMediaUrl()), which only exists on a
          // real WidgetApiImpl connection — a companion window has none (no
          // widgetId/parentUrl to hand-shake with, see this file's header
          // comment). The host does the download and hands back a raw Blob.
          // BroadcastChannel structured-clones Blob objects fine, so the
          // companion re-wraps the received blob into its OWN object URL
          // (see companionFetchMediaUrl below) — object URLs are only valid
          // in the window that created them, they don't survive the trip.
          result = await matrixStoreFns.fetchMediaBlob(msg.args.mxc, msg.args.size)
          break
        default:
          throw new Error(`Unknown relay method: ${msg.method}`)
      }
      ch.postMessage({ kind: 'response', id: msg.id, ok: true, result })
    } catch (e) {
      ch.postMessage({ kind: 'response', id: msg.id, ok: false, error: e.message })
    }
  })
}

/** Forwards a live push (new chat message, beacon update, etc.) from the
 *  host's own subscribeState() handlers out to any listening companions.
 *  No-op until startRelayHost() has run (i.e. in a real widget, after
 *  initWidget() resolves) and never fires from a companion window itself. */
export function broadcastPush(eventType, data) {
  if (isCompanion || !hostStarted) return
  getChannel().postMessage({ kind: 'push', roomId: getRoomId(), eventType, data })
}

// ── Companion side (runs in the popup) ───────────────────────────────────────
let companionRoomId = targetRoomId

function call(method, args) {
  return new Promise((resolve, reject) => {
    const ch = getChannel()
    const id = rpcId()
    const timeout = setTimeout(() => {
      ch.removeEventListener('message', onMsg)
      reject(new Error(
        "Couldn't reach the CrewBoard tab in Element — keep CrewBoard open " +
        "in the room (floating/minimized is fine) for this window to work."
      ))
    }, method === 'hello' ? HELLO_TIMEOUT_MS : RPC_TIMEOUT_MS)

    function onMsg(ev) {
      const msg = ev.data
      if (!msg || msg.kind !== 'response' || msg.id !== id) return
      clearTimeout(timeout)
      ch.removeEventListener('message', onMsg)
      if (msg.ok) resolve(msg.result)
      else reject(new Error(msg.error))
    }
    ch.addEventListener('message', onMsg)
    ch.postMessage({ kind: 'request', id, method, args, roomId: companionRoomId })
  })
}

/** Confirms a primary widget tab is alive and reachable. Rejects if nothing
 *  answers within HELLO_TIMEOUT_MS — the original widget iframe may have
 *  been closed, or Element itself closed. Call this before rendering the
 *  rest of the companion app. */
export function connectCompanion() {
  return call('hello', {}).then(({ roomId }) => {
    companionRoomId = roomId
    return roomId
  })
}

export const companionGetOpenIdToken = () => call('getOpenIdToken')
export const companionSendMessage = (body, extra, targetRoomId) => call('sendMessage', { body, extra, targetRoomId })
export const companionSendRoomEvent = (eventType, content, targetRoomId) => call('sendRoomEvent', { eventType, content, targetRoomId })
export const companionReadInbox = (limit) => call('readInbox', { limit })
export const companionReadBeacons = () => call('readBeacons')
export const companionUploadMedia = (file, filename, contentType) => call('uploadMedia', { file, filename, contentType })
export const companionSearchUserDirectory = (searchTerm, limit) => call('searchUserDirectory', { searchTerm, limit })
export const companionFindDmRoom = (targetUserId, selfUserId) => call('findDmRoom', { targetUserId, selfUserId })
export const companionListJoinedRooms = () => call('listJoinedRooms')
export const companionGetRoomMembers = (roomId) => call('getRoomMembers', { roomId })
export const companionGetRoomKeyMaterial = () => call('getRoomKeyMaterial')
export const companionNavigateTo = (uri) => call('navigateTo', { uri })

/** See the 'fetchMediaUrl' case in startRelayHost() above — the host sends
 *  back a raw Blob (structured-clonable over BroadcastChannel), and this
 *  wraps it in an object URL scoped to THIS window, since object URLs
 *  aren't valid outside the window/document that created them. */
export async function companionFetchMediaUrl(mxc, size) {
  const blob = await call('fetchMediaUrl', { mxc, size })
  return URL.createObjectURL(blob)
}

/** Live pushes forwarded from the host — same shape subscribeState()
 *  consumers already expect. Returns an unsubscribe function, matching
 *  matrixStore.js's subscribeState() signature. */
export function subscribeCompanionPush(eventType, onChange) {
  const ch = getChannel()
  function onMsg(ev) {
    const msg = ev.data
    if (!msg || msg.kind !== 'push') return
    if (msg.roomId && companionRoomId && msg.roomId !== companionRoomId) return
    if (msg.eventType !== eventType) return
    onChange(msg.data)
  }
  ch.addEventListener('message', onMsg)
  return () => ch.removeEventListener('message', onMsg)
}
