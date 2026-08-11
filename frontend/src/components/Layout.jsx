import React, { useState, useEffect } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import {
  Box,
  IconButton,
  Tooltip,
  Stack,
  Badge,
  Snackbar,
  Alert,
  Divider,
  Chip,
} from '@mui/material'
import PictureInPictureAltIcon from '@mui/icons-material/PictureInPictureAlt'
import PushPinIcon from '@mui/icons-material/PushPin'
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined'
import MapIcon from '@mui/icons-material/Map'
import GroupIcon from '@mui/icons-material/Group'
import StorageIcon from '@mui/icons-material/Storage'
import ForumIcon from '@mui/icons-material/Forum'
import SettingsIcon from '@mui/icons-material/Settings'
import LocationOnIcon from '@mui/icons-material/LocationOn'
import CircleIcon from '@mui/icons-material/Circle'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import { api } from '../api'
import { subscribeState, getWidgetUrlParam } from '../matrixStore.js'
import { startRealtime } from '../realtime.js'
import { getRoomId, setFloating } from '../widget.js'
import { isCompanion } from '../relay.js'
import { tryTagVehicleCommand } from '../vehicleCommands.js'
import { processPendingLocationTags } from '../locationTagging.js'
import { isRelevantRoom } from '../relevantRooms.js'
import ErrorBoundary from './ErrorBoundary'

// Migrated (2026-07-20) to MUI components as part of the
// @matrix-widget-toolkit adoption — see main.jsx/widget.js/matrixStore.js
// for the data-layer half of that migration. All the subscribeState()/
// realtime wiring below is unchanged; only the chrome around <Outlet /> is
// rebuilt in MUI so it inherits Element's theme via <MuiThemeProvider>.
const NAV = [
  { to: '/map', icon: MapIcon, label: 'Map Board' },
  { to: '/teams', icon: GroupIcon, label: 'Teams' },
  { to: '/database', icon: StorageIcon, label: 'Database' },
  { divider: true },
  { to: '/matrix', icon: ForumIcon, label: 'Matrix Hub' },
]

const NOTIFY_SOUND = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAA' +
  'EAAQARKwAAESsAAAEACABkYXRhAAAAAA=='

const TOAST_SEVERITY = {
  message: 'info',
  location: 'success',
  warning: 'warning',
}

export default function Layout() {
  const [online, setOnline] = useState(navigator.onLine)
  const [matrixConn, setMatrixConn] = useState(false)
  const [unread, setUnread] = useState(0)
  const [toast, setToast] = useState(null)
  const [floating, setFloatingState] = useState(false)

  // Element tears down a room's widget iframe when you navigate away from
  // that room, UNLESS the widget has asked to stay "always on screen" (the
  // same picture-in-picture mechanism Jitsi/Element Call widgets use —
  // widget.js's setFloating(), gated on the m.always_on_screen capability
  // requested at connect time). This matters for more than just visually
  // floating CrewBoard: a companion window (openCompanionWindow() below)
  // has no Matrix connection of its own — it relays every call through
  // THIS iframe over BroadcastChannel (see relay.js) — so if this iframe
  // gets torn down by a room switch, the companion window starts failing
  // with "Couldn't reach the CrewBoard tab" even though it's still open.
  // Pinning keeps this iframe (and therefore the companion window, and any
  // in-flight cross-room reads/writes) alive across room navigation.
  //
  // Best-effort only: matrix-widget-api has no to-widget event telling us
  // if Element internally un-floats this widget on its own (e.g. the user
  // closes the floating window from Element's own chrome), so `floating`
  // here is CrewBoard's own last-known state, not necessarily live truth —
  // if it drifts, toggling the button again resyncs it.
  async function toggleFloating() {
    const next = !floating
    try {
      await setFloating(next)
      setFloatingState(next)
      showToast(next ? 'Pinned — stays connected when you switch rooms' : 'Unpinned', next ? 'location' : 'message')
    } catch (e) {
      showToast(`Couldn't change pinned state: ${e.message}`, 'warning')
    }
  }

  // Opens CrewBoard in a real, separate top-level browser window that stays
  // connected to the room via relay.js — see relay.js's header comment for
  // why this exists (Document Picture-in-Picture doesn't work from a widget
  // iframe, this is the working alternative). Not shown from inside an
  // already-open companion window itself.
  function openCompanionWindow() {
    // A companion window is only useful if this iframe survives a room
    // switch — pin automatically so the common case (open the popup, then
    // go look at another room) just works without a separate manual step.
    // Fire-and-forget: if Element ignores the capability, the popup just
    // falls back to the existing "Couldn't reach the CrewBoard tab" error
    // the same as it would have before this existed.
    if (!floating) {
      setFloating(true).then(() => setFloatingState(true)).catch(() => {})
    }

    const popup = new URL(window.location.origin + window.location.pathname)
    popup.searchParams.set('companion', '1')
    // baseUrl lives in the widget URL's HASH (Element's registered URL puts
    // template params after '#'), not the query string — read it hash-aware.
    // Carry it into the popup as a normal query param (the popup builds its
    // own URL, so search is fine there).
    const baseUrl = getWidgetUrlParam('baseUrl')
    if (baseUrl) popup.searchParams.set('baseUrl', baseUrl)
    const roomId = getRoomId()
    if (roomId) popup.searchParams.set('roomId', roomId)
    popup.hash = '#/map'

    // Bug fix (2026-08-04): window.open() with no left/top in its features
    // string left placement entirely up to the browser, which for most
    // browsers means "top-left corner of the screen" — not the natural spot
    // for a floating companion window. Size it to half the available screen
    // (availWidth/availHeight, not width/height, so it doesn't overlap the
    // OS taskbar/dock) and explicitly center it. screen.availLeft/availTop
    // account for a secondary monitor positioned left of/above the primary
    // one (Chrome/Firefox both support these; falls back to 0 where they
    // don't, same as if this code weren't here at all).
    const availWidth = window.screen.availWidth || window.screen.width
    const availHeight = window.screen.availHeight || window.screen.height
    const availLeft = window.screen.availLeft || 0
    const availTop = window.screen.availTop || 0
    const popupWidth = Math.round(availWidth / 2)
    const popupHeight = Math.round(availHeight / 2)
    const left = Math.round(availLeft + (availWidth - popupWidth) / 2)
    const top = Math.round(availTop + (availHeight - popupHeight) / 2)

    window.open(
      popup.toString(),
      'crewboard-companion',
      `width=${popupWidth},height=${popupHeight},left=${left},top=${top}`
    )
  }

  function playNotifySound() {
    try { new Audio(NOTIFY_SOUND).play().catch(() => {}) } catch {}
  }

  function showToast(text, type = 'message', duration = 10000) {
    setToast({ text, type })
    setTimeout(() => setToast(null), duration)
  }

  // ── Online/offline detection ─────────────────────────────────────────────
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // ── Matrix status (initial load) ─────────────────────────────────────────
  useEffect(() => {
    api.matrix.status()
      .then(s => setMatrixConn(s.connected))
      .catch(() => {})
    api.matrix.inbox()
      .then((threads) => setUnread(threads.length))
      .catch(() => {})
    // Deliberately NOT replaying \car/\motorcycle commands out of history at
    // mount (a processVehicleCommandHistory() catch-up pass used to run
    // here). That caught commands sent while the widget was fully closed,
    // but had a worse side effect: deletes are real in this app (db.js —
    // markers aren't tombstoned), so there's no way to tell "this sender
    // never sent a command" apart from "this sender's marker WAS created
    // from history and then deliberately deleted." Every reopen replayed the
    // same old command and resurrected the marker the user just removed.
    // Tagging now only happens from the live subscription below — a command
    // sent while the widget was closed is simply missed, which is the
    // tradeoff accepted in exchange for deletes actually sticking.
  }, [])

  // ── Team roster sync with linked rooms — REMOVED (2026-08-10) ────────────
  // Used to run api.teams.syncMembersFromRooms() at mount and on every
  // relevant m.room.member change, both adding AND removing persons'
  // team_id based on a linked room's live roster. Root-caused two real bugs
  // this was causing: (1) a DM room only ever has 2 members by definition,
  // so linking one as a team's room would shrink the roster to ~1 person on
  // every sync; (2) a person who's a member of another team's room (or just
  // hasn't left an old room yet) could get silently unassigned, since "not
  // currently in this room" was being treated as "left the team." Team
  // membership is now a plain manual persons.team_id assignment (see
  // Database.jsx's PersonModal), independent of room membership entirely —
  // see CHANGES.md "Decouple team roster from room membership" for the full
  // writeup. team.room_id survives purely as an optional broadcast target.

  // ── Live updates for markers/teams/persons/vehicles — real push again ────
  // markers/teams/persons/vehicles/presets/settings moved off Matrix room
  // state onto crewboard-backend (Postgres) — see api.js and PAINPOINTS.md's
  // encryption/scalability section for why. That meant losing Element's
  // live state-event push for a while (backfilled with an 8s poll). Now
  // backed by real push again: Postgres triggers + LISTEN/NOTIFY
  // (backend/src/notify.js, db.js) fanned out over SSE
  // (backend/src/routes/events.js) via realtime.js, which dispatches these
  // same window CustomEvents views already listen for.
  useEffect(() => {
    if (!online) return
    return startRealtime()
  }, [online])

  // org.matrix.msc3672.beacon (live location from mobile Element clients) is
  // still a genuine Matrix timeline event pushed by Element itself, not
  // something CrewBoard writes — that one's unaffected by the backend move.
  // NOTE (2026-07-20): this is the real, unstable-prefixed MSC3672 event
  // name actually used by this deployment — confirmed by inspecting a live
  // beacon_info event pulled from the room. The shortened `m.beacon`/
  // `m.beacon_info` names used earlier this session don't exist here; that
  // mismatch (not capabilities, not the timeline-vs-state read semantics)
  // was the real reason beacons never showed up. See matrixStore.js's
  // readBeacons() for the full writeup.
  useEffect(() => {
    if (!online) return
    const unsub = subscribeState('org.matrix.msc3672.beacon', (data) => {
      showToast('Location updated', 'location')
      window.dispatchEvent(new CustomEvent('crewboard:markers-updated', { detail: data }))
    })
    return unsub
  }, [online])

  // org.matrix.msc3672.beacon_info announces a NEW live-sharing session
  // starting (or an existing one stopping) — no coordinates, just
  // content.live/timeout (see matrixStore.js's readBeacons()). Subscribing
  // to this too, not just the coordinate stream, means MapBoard refreshes
  // the instant someone starts sharing rather than waiting for their first
  // coordinate tick or the 30s poll fallback.
  useEffect(() => {
    if (!online) return
    const unsub = subscribeState('org.matrix.msc3672.beacon_info', (data) => {
      window.dispatchEvent(new CustomEvent('crewboard:markers-updated', { detail: data }))
    })
    return unsub
  }, [online])

  // New chat messages posted to the room
  useEffect(() => {
    if (!online) return
    // subscribeState()'s Observable (matrixStore.js) replays the room's
    // ENTIRE m.room.message history through this callback before any live
    // event arrives — see that file's header comment: the widget-toolkit's
    // observeRoomEvents() always emits current history first, then live
    // updates. Without this guard, every mount/reconnect would re-run
    // tryTagVehicleCommand() on every \car/\motorcycle command ever sent in
    // the room (not just a bounded recent window — the old, deliberately
    // removed processVehicleCommandHistory() catch-up was at least capped
    // to ~100 messages; this replay isn't capped at all), resurrecting
    // every deleted marker and toasting "new message" for years-old chatter.
    // Only treat an event as live if it happened at or after this
    // subscription started.
    const subscribedAt = Date.now()
    const unsub = subscribeState('m.room.message', async (data) => {
      if ((data.origin_server_ts || 0) < subscribedAt) return
      // Optimization: a crew member's \car/\motorcycle command only ever
      // makes sense from the ops room or their own linked team/DM room —
      // see relevantRooms.js. Skips tagging work (and a person/vehicle
      // lookup) for messages in rooms CrewBoard has no reason to care about.
      if (!isRelevantRoom(data.room_id)) return

      // \car/\motorcycle text-command tagging (vehicleCommands.js) — a
      // self-contained one-message command, no relation-matching or
      // vehicle-assignment lookup needed. If it created/moved a marker,
      // Postgres LISTEN/NOTIFY -> SSE -> realtime.js pushes the resulting
      // crewboard:markers-updated to MapBoard on its own; no manual
      // dispatch needed here.
      const tagResult = await tryTagVehicleCommand(data).catch((e) => {
        console.warn('tryTagVehicleCommand failed:', e)
        return null
      })
      if (tagResult?.tagged) {
        showToast(
          tagResult.updated
            ? `📍 Updated ${tagResult.label}'s location on the map`
            : `📍 Tagged ${tagResult.label} — added to the map`,
          'location'
        )
        return // skip the generic "new message" ping below for a command
                // message that was just consumed as a tag — the toast above
                // already says something happened with it.
      }
      playNotifySound()
      showToast(`New message from ${data.sender || 'crew'}`, 'message')
      setUnread(n => n + 1)
    })
    return unsub
  }, [online])

  // Native-share location tagging (2026-08-03, see locationTagging.js) — the
  // new crew -> dispatcher path meant to eventually replace \car/\motorcycle
  // above. subscribeState() for a genuine state event type (unlike
  // m.room.message above) replays the CURRENT state snapshot first, then
  // live updates — exactly the "on load, check for anything pending" catch-
  // up behavior this needs, no subscribedAt guard required: reprocessing an
  // already-cleared tag is harmless (readPendingLocationTags() filters it
  // out) and reprocessing a still-pending one just re-attempts it.
  //
  // Host-only: a companion popup window has no Widget API of its own to
  // read/clear state events with (see matrixStore.js's header comment on
  // this section) — it doesn't need to, since whichever instance DOES
  // process a tag writes straight to Postgres, and every other open
  // instance (companion windows included) picks up the resulting marker the
  // normal way via the existing crewboard:markers-updated/SSE pipeline.
  useEffect(() => {
    if (!online || isCompanion) return
    let cancelled = false

    async function runOnce() {
      const results = await processPendingLocationTags().catch((e) => {
        console.warn('processPendingLocationTags failed:', e)
        return []
      })
      if (cancelled) return
      for (const r of results) {
        showToast(
          r.updated
            ? `📍 Updated ${r.label}'s location on the map`
            : `📍 Tagged ${r.label} — added to the map`,
          'location'
        )
      }
    }

    // subscribeState()'s Observable replays the CURRENT state (one event per
    // pending tag, if any) immediately on subscribe, then live updates as
    // new tags are published — that replay IS the "check for anything
    // pending on load" pass, no separate call needed. Each replayed/live
    // event re-runs the full pending-set pass rather than processing just
    // that one event — processPendingLocationTags() is cheap and idempotent
    // (see its own header comment), and a burst of N pending tags at mount
    // would otherwise fire N redundant full passes; this still only takes
    // whichever one settles last to actually clear anything meaningful,
    // which is fine.
    const unsub = subscribeState('org.crewboard.location-tag', () => { runOnce() })
    return () => { cancelled = true; unsub() }
  }, [online])

  return (
    // height: pre-divides the vh amount by the current UI-scale factor
    // (--cb-zoom, set by uiScale.js) so that after `zoom` renders this box
    // back up by that same factor, it lands on exactly 100vh of real
    // on-screen space again — at ANY scale, not just above 100%. See
    // uiScale.js's header comment for the full explanation (this replaces
    // the old bottom-inset padding hack, which only patched the >100%
    // clipping symptom and did nothing for the <100% empty-gap symptom).
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh / var(--cb-zoom, 1))', overflow: 'hidden' }}>

      {/* Running inside an Element iframe — no window titlebar/chrome here,
          Element's own window frame surrounds the whole client. */}
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          height: 38, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider',
          px: 2, flexShrink: 0, gap: 1.25,
        }}
      >
        <Box component="span" sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary', letterSpacing: 1, flex: 1 }}>
          CREWBOARD
        </Box>
        {!isCompanion && (
          <Tooltip title={floating ? 'Unpin (widget can be closed by switching rooms)' : 'Pin so CrewBoard stays connected when you switch rooms'}>
            <IconButton size="small" onClick={toggleFloating} color={floating ? 'primary' : 'default'}>
              {floating ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
        {!isCompanion && (
          <Tooltip title="Open in a separate window">
            <IconButton size="small" onClick={openCompanionWindow}>
              <PictureInPictureAltIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {/* MAIN */}
      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* SIDEBAR */}
        <Stack
          component="nav"
          alignItems="center"
          sx={{
            width: 50, bgcolor: 'background.paper', borderRight: 1, borderColor: 'divider',
            py: 1.25, gap: 0.25, flexShrink: 0,
            // Scroll the nav itself when it's taller than the viewport (e.g. at
            // a high interface-scale in a short widget frame) so every nav
            // icon stays reachable instead of clipped by the outer
            // overflow:hidden. (Settings is pinned at the top now.)
            overflowY: 'auto', minHeight: 0,
            '&::-webkit-scrollbar': { width: 0 }, // hide the scrollbar (still scrollable)
          }}
        >
          {/* Settings — pinned at the TOP of the sidebar, above the map icon. */}
          <Tooltip title="Settings" placement="right">
            <NavLink to="/settings" style={{ textDecoration: 'none' }}>
              {({ isActive }) => (
                <Box
                  sx={{
                    width: 34, height: 34, borderRadius: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: isActive ? 'primary.main' : 'text.secondary',
                    bgcolor: isActive ? 'action.selected' : 'transparent',
                    border: 1,
                    borderColor: isActive ? 'primary.main' : 'transparent',
                  }}
                >
                  <SettingsIcon fontSize="small" />
                </Box>
              )}
            </NavLink>
          </Tooltip>
          <Divider sx={{ width: 24, my: 0.5 }} />

          {NAV.map((item, i) =>
            item.divider ? (
              <Divider key={i} sx={{ width: 24, my: 0.5 }} />
            ) : (
              <Tooltip key={item.to} title={item.label} placement="right">
                <NavLink to={item.to} style={{ textDecoration: 'none' }}>
                  {({ isActive }) => (
                    <Box
                      sx={{
                        width: 34, height: 34, borderRadius: 1,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        position: 'relative',
                        color: isActive ? 'primary.main' : 'text.secondary',
                        bgcolor: isActive ? 'action.selected' : 'transparent',
                        border: 1,
                        borderColor: isActive ? 'primary.main' : 'transparent',
                        transition: 'all .15s',
                      }}
                    >
                      {item.to === '/matrix' && unread > 0 ? (
                        <Badge badgeContent={unread} color="primary" max={9}>
                          <item.icon fontSize="small" />
                        </Badge>
                      ) : (
                        <item.icon fontSize="small" />
                      )}
                    </Box>
                  )}
                </NavLink>
              </Tooltip>
            )
          )}

          <Divider sx={{ width: 24, my: 0.5 }} />

          {/* Interactive user guide (2026-08-09) — a self-contained static
              site under public/guide/, not a React route, so it's opened as
              a plain new tab (like the "open in separate window" button
              above) rather than an internal NavLink. */}
          <Tooltip title="Guide" placement="right">
            <IconButton
              size="small"
              onClick={() => window.open('/guide/', '_blank', 'noopener,noreferrer')}
              sx={{ width: 34, height: 34, borderRadius: 1, color: 'text.secondary' }}
            >
              <HelpOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* CONTENT */}
        {/* No bottom-inset padding hack needed here anymore — the outer Box
            above now compensates height itself (calc(100vh / --cb-zoom)),
            so every view's real bottom edge already stays inside the
            visible frame at any scale, in both directions. See uiScale.js's
            header comment for the full explanation. */}
        <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', position: 'relative' }}>
          <ErrorBoundary>
            <Outlet context={{ online, matrixConnected: matrixConn }} />
          </ErrorBoundary>

          {/* TOAST */}
          <Snackbar
            open={!!toast}
            anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
            sx={{ position: 'absolute', top: 52 }}
          >
            <Alert severity={toast ? (TOAST_SEVERITY[toast.type] || 'info') : 'info'} variant="filled" icon={toast?.type === 'location' ? <LocationOnIcon fontSize="small" /> : undefined}>
              {toast?.text}
            </Alert>
          </Snackbar>

          {/* STATUS BAR */}
          <Chip
            size="small"
            icon={<CircleIcon sx={{ fontSize: '8px !important' }} />}
            label={online ? (matrixConn ? 'Online · Matrix connected' : 'Online · Matrix disconnected') : 'Offline'}
            color={online && matrixConn ? 'success' : 'default'}
            variant="outlined"
            sx={{
              position: 'absolute', bottom: 8, right: 8, zIndex: 100, pointerEvents: 'none',
              fontSize: 10, height: 22, bgcolor: 'background.paper',
            }}
          />
        </Box>
      </Box>
    </Box>
  )
}
