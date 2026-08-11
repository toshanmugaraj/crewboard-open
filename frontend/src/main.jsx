import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { MuiThemeProvider, MuiWidgetApiProvider } from '@matrix-widget-toolkit/mui'
import { useThemeSelection } from '@matrix-widget-toolkit/react'
import './index.css'
import Layout from './components/Layout'
import MapBoard from './views/MapBoard'
import Teams from './views/Teams'
import Database from './views/Database'
import MatrixHub from './views/MatrixHub'
import Settings from './views/Settings'
import { initWidget, widgetApiPromise, fixWidgetName } from './widget.js'
import { isCompanion, connectCompanion, startRelayHost } from './relay.js'
import { sendMessage, sendRoomEvent, readInbox, readBeacons, uploadMedia, searchUserDirectory, subscribeState, primeMediaBase, fetchMediaBlob, findDmRoom, listJoinedRooms, getRoomMembers } from './matrixStore.js'
import { initRoomCrypto, recheckRoomEncryption, startMembershipWatch, getKeyMaterialForRelay } from './roomCrypto.js'
import { startCommandWatch } from './commands.js'
import { applyUiScale, getUiScale } from './uiScale.js'
import { refreshRelevantRooms } from './relevantRooms.js'
import { installDiagnosticsCapture } from './diagnostics.js'
import { trackPageview, trackError } from './analytics.js'
import { api } from './api'

// Set once, best-effort, by WidgetApp's afterCryptoOk() below (it already
// calls api.whoami() for other reasons) — reused by PageviewTracker so
// analytics.js's optional userId prop doesn't need its own separate
// whoami() round trip on every route change. Never anything more than the
// caller's OWN verified Matrix user id — see analytics.js's header comment
// on why that's the only identity data analytics is allowed to carry.
let currentUserId = null

// Restore the user's saved UI scale before anything renders, so the app comes
// up at their chosen size rather than flashing at 100% first. Per-browser
// preference (see uiScale.js), so it applies in both widget and companion modes.
applyUiScale(getUiScale())

// Start capturing console output as early as possible (2026-08-04) — see
// diagnostics.js — so an early-boot error (e.g. initWidget()/initRoomCrypto()
// failing) still ends up in the buffer a "Copy diagnostics"/"Send
// diagnostics" report can include, not just errors after the app is fully
// up. Safe in both widget and companion mode.
installDiagnosticsCapture()

// There's no login/setup wizard anymore. Two ways this can boot:
//  - Normal widget mode: the app inherits Element's already-authenticated
//    session via the Widget API handshake with the Element host hosting our
//    <iframe> (initWidget()). <MuiWidgetApiProvider> below owns the
//    connecting/error UI for this path now (loading spinner, "outside
//    client"/"missing parameters"/"missing capabilities" screens) — it
//    wraps the SAME widgetApiPromise that widget.js's WidgetApiImpl.create()
//    produced, so there's still only one real connection being established.
//  - Companion mode (?companion=1, opened via Layout.jsx's "Open in a
//    separate window" button — see relay.js): this is a plain top-level
//    browser tab with no Widget API connection of its own, so instead it
//    confirms the original widget iframe is still alive and reachable over
//    BroadcastChannel (connectCompanion()) and relays everything through it.
//    Deliberately NOT wrapped in <MuiWidgetApiProvider> — widget.js's
//    widgetApiPromise never resolves in companion mode (see its header
//    comment), so that provider would show a loading spinner forever.
//    <MuiThemeProvider> alone (no dependency on a live WidgetApi connection
//    — it reads the theme via widget parameters/URL) still applies so the
//    popup looks consistent with the main widget.
function CompanionApp() {
  const [status, setStatus] = useState('connecting') // connecting | ready | error
  const [error, setError] = useState(null)

  useEffect(() => {
    connectCompanion()
      // Pull the room key from the host widget over the relay so the popup
      // can decrypt/encrypt fields too (see roomCrypto.js's companion branch).
      // Non-fatal if it fails — the popup still connects; encrypted fields
      // just won't be readable, which surfaces as blank fields rather than a
      // crash.
      .then(() => initRoomCrypto().catch(e => console.warn('companion roomCrypto init failed:', e.message)))
      .then(() => setStatus('ready'))
      .catch(e => { setError(e); setStatus('error') })
  }, [])

  if (status === 'connecting') {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 12, color: 'var(--muted)', fontSize: 13
      }}>
        <div style={{ fontSize: 32 }}>📍</div>
        <div>Connecting to CrewBoard in Element…</div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 12, color: 'var(--text)', fontSize: 13,
        padding: 32, textAlign: 'center'
      }}>
        <div style={{ fontSize: 32 }}>⚠️</div>
        <div style={{ fontWeight: 600 }}>Couldn't reach CrewBoard</div>
        <div style={{ color: 'var(--muted)', maxWidth: 420 }}>{error?.message}</div>
      </div>
    )
  }

  return <AppRoutes />
}

function WidgetApp() {
  // encReady is a three-state gate:
  //   null       — still checking (show a brief loading state)
  //   'ok'       — room is encrypted, key ready, run the app
  //   'unencrypted' — room isn't E2EE; CrewBoard is encrypted-rooms-only, refuse
  //   'error'    — crypto init failed for some other reason
  const [encState, setEncState] = useState(null)
  // Separate from encState so the "unencrypted"/"error" screens can show a
  // "Checking..." state on their retry button without the whole screen
  // flashing back to the initial blank/loading state and losing the
  // message the user was just reading.
  const [rechecking, setRechecking] = useState(false)

  // Runs once crypto is confirmed OK (initial load OR a successful retry —
  // see checkEncryption below). Split out so a retry from the "unencrypted"
  // screen can trigger this exactly the same way the initial load does,
  // without duplicating it.
  function afterCryptoOk() {
    // Resolve the delegated homeserver base early so mxcToHttp() (sync,
    // used in render) can build avatar/photo URLs even when the widget
    // URL carried no baseUrl param. Best-effort, don't block on it.
    primeMediaBase().catch(() => {})

    // Loads the team/person room-link cache used to scope which rooms
    // CrewBoard's own cross-room subscribeState() handlers act on (see
    // relevantRooms.js) — kicked off early so it's populated before Layout/
    // commands.js's subscriptions mount.
    refreshRelevantRooms().catch(() => {})

    // The companion relay can now also hand the room key to popup windows.
    startRelayHost({
      sendMessage, sendRoomEvent, readInbox, readBeacons, uploadMedia, searchUserDirectory,
      getRoomKeyMaterial: getKeyMaterialForRelay,
      // Lets a companion window fetch authenticated avatar/photo media
      // through this host's real Widget API connection — see relay.js's
      // 'fetchMediaUrl' case and matrixStore.js's fetchAuthedMediaUrl().
      fetchMediaBlob,
      // Existing-DM detection for the Person form (see findDmRoom).
      findDmRoom,
      // Joined-room enumeration for the Team broadcast-room picker.
      listJoinedRooms,
      // Room member roster for bulk-importing a team room's members.
      getRoomMembers,
    })

    // Both of these are gated on the backend's authoritative write
    // permission (whoami.can_write), fetched once and reused:
    //  - re-publish the room key when new members join (roomCrypto.js);
    //  - fix the widget's display name in Element if it's still showing
    //    the "Custom" default (widget.js's fixWidgetName()). Gating this
    //    on write power isn't a security requirement (Element would just
    //    reject an unprivileged write) — it's to avoid popping a new
    //    capability-permission prompt in front of members who could never
    //    actually perform the write anyway. Since the widget name is one
    //    shared piece of room state, this only needs to succeed once, from
    //    whoever has power the first time they open CrewBoard after this
    //    shipped — everyone else just sees the corrected name.
    api.whoami().then(me => {
      currentUserId = me.user_id || null
      const canWrite = !!me.can_write
      startMembershipWatch(subscribeState, canWrite)
      // Watch room chat for \car/\bike <lat>,<lng> commands and plot the
      // sender's vehicle. Gated on write power — only admin widgets own the
      // map, and startCommandWatch() no-ops for non-writers (see commands.js).
      startCommandWatch(subscribeState, canWrite)
      if (canWrite) {
        fixWidgetName().catch(e => console.warn('fixWidgetName failed (non-fatal):', e.message))
      }
    }).catch(() => {})
  }

  // Bring up room-member-only encryption BEFORE anything reads/writes data,
  // so no view can round-trip a sensitive field while the key is still
  // resolving. initRoomCrypto() also enforces the encrypted-room
  // requirement (see roomCrypto.js). `recheck` routes through
  // recheckRoomEncryption() instead — used by the refusal screens' "Check
  // again" button, since a plain retry click shouldn't just replay the
  // memoized (failed) initRoomCrypto() promise.
  async function checkEncryption(recheck = false) {
    try {
      const { supported } = recheck ? await recheckRoomEncryption() : await initRoomCrypto()
      if (!supported) { setEncState('unencrypted'); return }
      setEncState('ok')
      afterCryptoOk()
    } catch (e) {
      console.error('initRoomCrypto() failed:', e)
      trackError('encryption_error')
      setEncState('error')
    }
  }

  useEffect(() => {
    initWidget().then(() => checkEncryption(false)).catch((e) => {
      console.error('initWidget() failed:', e)
      trackError('widget_init_error')
      setEncState('error')
    })
  }, [])

  async function handleRetry() {
    setRechecking(true)
    try {
      await checkEncryption(true)
    } finally {
      setRechecking(false)
    }
  }

  if (encState === 'unencrypted') return <EncryptionRequiredScreen onRetry={handleRetry} retrying={rechecking} />
  if (encState === 'error') return <EncryptionErrorScreen onRetry={handleRetry} retrying={rechecking} />

  return (
    <MuiWidgetApiProvider widgetApiPromise={widgetApiPromise}>
      <AppRoutes />
    </MuiWidgetApiProvider>
  )
}

// CrewBoard stores sensitive fields (phone numbers, Matrix IDs, license
// plates, marker notes) encrypted with a key only room members hold. That
// only works if the room itself is end-to-end encrypted — in an unencrypted
// room the key would land on the homeserver in plaintext, silently defeating
// the whole point. So we refuse to run rather than pretend.
// Shared "Check again" button for both refusal screens below — retries the
// encryption check in place (see main.jsx's checkEncryption/handleRetry)
// instead of asking the user to reload the widget, which isn't always an
// obvious action to take from inside an Element-hosted iframe. Covers two
// real cases: (1) isRoomEncrypted()'s own internal retry genuinely wasn't
// enough time for Element to resolve its room object, or (2) the room
// wasn't encrypted a moment ago but the user is turning it on RIGHT NOW in
// Element's room settings (in another tab/panel) and wants to recheck
// without leaving this screen.
function RetryButton({ onRetry, retrying, children = 'Check again' }) {
  return (
    <button
      onClick={onRetry}
      disabled={retrying}
      style={{
        marginTop: 4, padding: '8px 18px', borderRadius: 8, border: '1px solid var(--accent-border, #3d5afe40)',
        background: retrying ? 'var(--surface3, #2a3050)' : 'var(--accent-bg, #3d5afe20)',
        color: 'var(--accent, #7c93ff)', fontSize: 13, fontWeight: 500,
        cursor: retrying ? 'default' : 'pointer',
      }}
    >
      {retrying ? 'Checking…' : children}
    </button>
  )
}

// CrewBoard stores sensitive fields (phone numbers, Matrix IDs, license
// plates, marker notes) encrypted with a key only room members hold. That
// only works if the room itself is end-to-end encrypted — in an unencrypted
// room the key would land on the homeserver in plaintext, silently defeating
// the whole point. So we refuse to run rather than pretend.
function EncryptionRequiredScreen({ onRetry, retrying }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 12, padding: 32, textAlign: 'center', color: 'var(--text, #e8eaf0)',
    }}>
      <div style={{ fontSize: 32 }}>🔒</div>
      <div style={{ fontWeight: 600, fontSize: 15 }}>This room isn't encrypted</div>
      <div style={{ color: 'var(--muted, #9aa0ac)', maxWidth: 440, fontSize: 13, lineHeight: 1.5 }}>
        CrewBoard keeps contact details, license plates and notes encrypted so only room
        members can read them — which requires the room to have encryption turned on.
        Enable encryption in this room's settings in Element (Room settings → Security &
        Privacy), then check again — no need to reload.
      </div>
      <RetryButton onRetry={onRetry} retrying={retrying} />
    </div>
  )
}

function EncryptionErrorScreen({ onRetry, retrying }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 12, padding: 32, textAlign: 'center', color: 'var(--text, #e8eaf0)',
    }}>
      <div style={{ fontSize: 32 }}>⚠️</div>
      <div style={{ fontWeight: 600, fontSize: 15 }}>Couldn't set up encryption</div>
      <div style={{ color: 'var(--muted, #9aa0ac)', maxWidth: 440, fontSize: 13, lineHeight: 1.5 }}>
        CrewBoard couldn't load or create this room's encryption key. Check the browser
        console for details, then try again. If it persists, an admin may need to open the
        widget first to publish the initial key.
      </div>
      <RetryButton onRetry={onRetry} retrying={retrying} />
    </div>
  )
}

// Fires a Plausible pageview (see analytics.js) on every route change.
// No-ops entirely if Plausible isn't configured (analytics.js's own
// isEnabled() check) — safe to always mount. Deliberately reads
// location.pathname only (CrewBoard's own internal route, e.g. "/map") —
// never the full href, which HashRouter puts widget URL params in.
function PageviewTracker() {
  const location = useLocation()
  useEffect(() => {
    trackPageview(location.pathname.replace(/^\//, '') || 'map', currentUserId)
  }, [location.pathname])
  return null
}

function AppRoutes() {
  return (
    <HashRouter>
      <PageviewTracker />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/map" replace />} />
          <Route path="map" element={<MapBoard />} />
          <Route path="teams" element={<Teams />} />
          <Route path="database" element={<Database />} />
          <Route path="matrix" element={<MatrixHub />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

// ── Theme sync (2026-07-28) ──────────────────────────────────────────────────
// MuiThemeProvider's ThemeSelectionProvider (see @matrix-widget-toolkit/react)
// only picks an INITIAL theme once, from the `theme` widget URL parameter —
// which Element only populates if the registration URL actually asks for it
// via the `$org.matrix.msc2873.client_theme` template placeholder (confirmed
// against matrix-widget-api's own url-template.js). CrewBoard's documented
// registration URL never included that placeholder, so `theme` is always
// empty and ThemeSelectionProvider falls back to the OS-level
// `prefers-color-scheme: dark` media query instead of Element's actual
// in-app theme choice — the root cause of "background/font color mismatch
// with Element Web". Fixed the docs (README.md/SETUP.md/DEPLOY.md/
// BUILD_INSTRUCTIONS.md/the Helm chart's NOTES.txt) to include the
// placeholder for NEW widget registrations, but that alone can't fix
// ALREADY-registered widgets (the URL is baked into room state at add-widget
// time) or a LIVE theme toggle after the widget has loaded — for those,
// ThemeSelectionProvider exposes a `setTheme()` nobody was calling.
// widget.js already listens for Element's `action:theme_change` to-widget
// message and forwards it as a `crewboard:theme-changed` window CustomEvent
// (previously dead code — nothing consumed it). This component is that
// consumer: it calls setTheme() on every live change (fixing already-
// registered widgets + toggles going forward) AND mirrors the resolved
// theme onto `<html data-theme="...">` so index.css's plain (non-MUI) chrome
// — Layout.jsx's shell, Leaflet popups, .btn/.toggle classes, etc., none of
// which run through MUI's theme — can have light/dark variants too instead
// of the single hardcoded dark palette it had before.
function ThemeSync() {
  const { theme, setTheme } = useThemeSelection()

  useEffect(() => {
    // Mirrors chooseTheme()'s own logic (@matrix-widget-toolkit/mui): only
    // an exact 'dark' match is dark, everything else (including
    // 'light-high-contrast' and undefined) renders as some light variant.
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'
  }, [theme])

  useEffect(() => {
    function onThemeChanged(ev) {
      // Element's action:theme_change payload has no fixed schema in the
      // spec (matrix-widget-api's own JSDoc: "arbitrary contents") — Element
      // Web's actual convention is a `name` field (e.g. {name: 'dark'}), but
      // read a couple of plausible keys defensively rather than assume.
      const name = ev?.detail?.name || ev?.detail?.theme
      if (typeof name === 'string' && name) setTheme(name)
    }
    window.addEventListener('crewboard:theme-changed', onThemeChanged)
    return () => window.removeEventListener('crewboard:theme-changed', onThemeChanged)
  }, [setTheme])

  return null
}

function App() {
  return (
    <MuiThemeProvider>
      <ThemeSync />
      {isCompanion ? <CompanionApp /> : <WidgetApp />}
    </MuiThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
