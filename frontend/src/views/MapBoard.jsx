import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Box,
  Paper,
  TextField,
  InputAdornment,
  List,
  ListItemButton,
  ListItemAvatar,
  ListItemText,
  Avatar,
  Badge,
  Tooltip,
  Divider,
  Typography,
  Button,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  Slider,
  Stack,
  IconButton,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import CameraAltIcon from '@mui/icons-material/CameraAlt'
import SendIcon from '@mui/icons-material/Send'
import LocationOnIcon from '@mui/icons-material/LocationOn'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import { api } from '../api'
import { getUiScale, applyUiScale, setUiScale, UI_SCALE_MIN, UI_SCALE_MAX } from '../uiScale.js'
import { useToast } from '../components/useToast.jsx'
import AddMarkerModal from '../components/AddMarkerModal'
import ScreenshotModal from '../components/ScreenshotModal'
import SendLocationModal from '../components/SendLocationModal'
import CollapsibleSection from '../components/CollapsibleSection'
import MxcAvatar from '../components/MxcAvatar'

// Migrated (2026-07-20) to MUI as part of the @matrix-widget-toolkit
// adoption — see main.jsx/widget.js/matrixStore.js for the data-layer half.
// The Leaflet map itself, its markers, and the popup content built via
// document.createElement/innerHTML (buildPopupHTML) are left as plain
// DOM/CSS on purpose: Leaflet popups render outside React's tree entirely,
// so wrapping them in MUI would need a portal for no real benefit.
// Everything React actually renders (toolbar buttons, side panel, modals)
// is now MUI.
//
// Hybrid/satellite tile mode was removed (2026-08-02) — the map is street
// tiles only now. The place-search bar (which used to call out to
// Nominatim, a public third-party API) was replaced the same day with
// MarkerSearch below — searches only the markers already loaded on this
// board, no external network call at all.

// Public OpenStreetMap tile server by default — free, no API key, but
// rate-limited and not intended for heavy production traffic (see the OSM
// Tile Usage Policy). crewboard-open keeps this as the default so the
// project works out of the box with no config. A real deployment can point
// this at a self-hosted tile server (e.g. TileServer GL / OpenMapTiles) or
// a paid provider instead, without forking this file, via
// MAP_TILE_URL/MAP_TILE_ATTRIBUTION — same runtime-config mechanism
// analytics.js's PLAUSIBLE_* vars use (window.__CREWBOARD_ENV__, templated
// at container startup by docker-entrypoint.d/40-generate-env-js.sh — see
// frontend/public/env.js). Falls back to the OSS default whenever either is
// unset/empty, which is always true for `npm run dev` and for this repo's
// own default container config.
const runtimeEnv = (typeof window !== 'undefined' && window.__CREWBOARD_ENV__) || {}
const TILES = {
  street: {
    url: runtimeEnv.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr: runtimeEnv.MAP_TILE_ATTRIBUTION || '© OpenStreetMap contributors'
  }
}

const DEFAULT_CENTER = [0, 0] // replace with your own default map center
const DEFAULT_ZOOM = 12
const mapViewState = { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM }

// ── On-map marker search ─────────────────────────────────────────────────────
// Replaces the old Nominatim place-search bar (2026-08-02): rather than
// calling out to an external geocoding API, this searches only the markers
// already loaded on this board (persons, vehicles, misc/POI — same `markers`
// array MapBoard already fetched via api.markers.list()), matching against
// each marker's display label, team name, license plate, and note. Selecting
// a result pans/zooms to it and opens its popup — the exact same behavior
// as clicking that marker in the right-hand side panel lists.
function markerMatches(m, needle) {
  const haystacks = [m.label, m.team_name, m.license_plate, m.note]
  return haystacks.some(h => h && h.toLowerCase().includes(needle))
}

function markerTypeIcon(m) {
  if (m.entity_type === 'person') return '👤'
  if (m.entity_type === 'vehicle') return m.vehicle_type === 'motorcycle' ? '🏍' : '🚗'
  return m.vehicle_type ? (m.vehicle_type === 'motorcycle' ? '🏍' : '🚗') : 'ℹ️'
}

function MarkerSearch({ markers, mapInstance, leafletMarkers }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const needle = query.trim().toLowerCase()
  const results = needle
    ? markers.filter(m => hasCoords(m) && markerMatches(m, needle)).slice(0, 8)
    : []

  function selectResult(m) {
    if (!mapInstance.current || !hasCoords(m)) return
    mapInstance.current.setView([m.lat, m.lng], 17, { animate: true })
    leafletMarkers.current[m.id]?.openPopup()
    setOpen(false)
  }

  return (
    <Box ref={wrapperRef} sx={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 500, width: 280 }}>
      <TextField
        fullWidth
        size="small"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => query && setOpen(true)}
        placeholder="Search markers..."
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          sx: { bgcolor: 'background.paper', boxShadow: 2 },
        }}
      />

      {open && needle && (
        <Paper elevation={4} sx={{ mt: 0.5, maxHeight: 260, overflowY: 'auto' }}>
          <List dense disablePadding>
            {results.length === 0 ? (
              <Box sx={{ px: 1.5, py: 1 }}>
                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>No markers on the map match "{query}"</Typography>
              </Box>
            ) : results.map((m) => (
              <ListItemButton key={m.id} onClick={() => selectResult(m)} divider>
                <ListItemText
                  primary={`${markerTypeIcon(m)} ${m.label || '—'}`}
                  secondary={m.team_name || m.license_plate || (m.entity_type === 'misc' ? 'Point of interest' : null)}
                  primaryTypographyProps={{ fontSize: 12, fontWeight: 500, noWrap: true }}
                  secondaryTypographyProps={{ fontSize: 10, noWrap: true }}
                />
              </ListItemButton>
            ))}
          </List>
        </Paper>
      )}
    </Box>
  )
}

// `scale` (the interface-size setting) enlarges just the LABEL, not the pin —
// the map itself is counter-zoomed to 100% (see MapBoard's counter-zoom
// effect), so a `zoom` on the label div here nets to the same visual size as
// the rest of the scaled chrome, letting labels grow with the slider while the
// map/tiles/marker positions stay at true scale.
// avatarUrl (2026-08-13): a resolved blob: URL for the marker's linked
// person's/vehicle's own photo (marker.image_mxc, see api.js's markers.list()
// join, resolved via api.media.url() — see MapBoard's avatarUrls state
// below). When present it replaces the plain emoji glyph inside the pin's
// circle with the actual photo, cropped to a circle; the pin shape/color
// itself is unchanged either way, so team color + faded/highlighted state
// still read the same at a glance.
function makeIcon(color, type, label, faded = false, customEmoji = null, scale = 1, avatarUrl = null) {
  const safeLabel = (label || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const opacity = faded ? '0.2' : '1'
  // Positioned to sit inside the teardrop's circle (svg viewBox "0 0 34 42"
  // rendered at 40x50 — cx=17,cy=17,r=10 in viewBox coords lands at roughly
  // (20,20) r≈11.5 on screen once scaled).
  const avatarHtml = avatarUrl
    ? `<img src="${avatarUrl}" style="position:absolute;left:8px;top:8px;width:22px;height:22px;border-radius:50%;object-fit:cover;border:1.5px solid rgba(255,255,255,0.7);pointer-events:none;" />`
    : ''

  const labelHtml = `
    <div style="
      zoom:${scale};
      background:rgba(15,17,23,0.88);
      border:1px solid rgba(255,255,255,0.15);
      border-radius:4px;
      padding:2px 6px;
      font-size:10px;
      font-weight:500;
      color:#e8eaf0;
      white-space:nowrap;
      margin-top:2px;
      font-family:Inter,system-ui,sans-serif;
      max-width:90px;
      overflow:hidden;
      text-overflow:ellipsis;
    ">${safeLabel}</div>`

  if (type === 'misc') {
    // Info square instead of teardrop pin
    return L.divIcon({
      html: `
        <div style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5));opacity:${opacity};transition:opacity 0.3s;">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
            <rect x="2" y="2" width="28" height="28" rx="7"
              fill="${color}" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/>
            <text x="16" y="22" text-anchor="middle" font-size="17" font-weight="700" font-family="Georgia, serif" fill="white" font-style="italic">i</text>
          </svg>
          ${labelHtml}
        </div>`,
      iconSize: [32, 62],
      iconAnchor: [16, 32],
      popupAnchor: [0, -34],
      className: ''
    })
  }

  const emoji = customEmoji || (type === 'motorcycle' ? '🏍' : type === 'car' ? '🚗' : '👤')
  return L.divIcon({
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5));opacity:${opacity};transition:opacity 0.3s;">
        <div style="position:relative;width:40px;height:50px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 34 42">
            <path d="M17 0C7.6 0 0 7.6 0 17c0 12.7 17 25 17 25S34 29.7 34 17C34 7.6 26.4 0 17 0z"
              fill="${color}" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/>
            <circle cx="17" cy="17" r="10" fill="rgba(0,0,0,0.2)"/>
            ${avatarUrl ? '' : `<text x="17" y="22" text-anchor="middle" font-size="15" fill="white">${emoji}</text>`}
          </svg>
          ${avatarHtml}
        </div>
        ${labelHtml}
      </div>`,
    iconSize: [40, 74],
    iconAnchor: [20, 50],
    popupAnchor: [0, -52],
    className: ''
  })
}

// ── Placement pin (drag-to-place new marker) ─────────────────────────────────
// Shown only while the user is actively placing a new marker (see
// startPlacingMarker() in the component below) — a draggable pin with a
// small red crosshair/target reticle at its tip, marking the exact point
// that'll be used once dropped. Visually distinct from both the finished
// person/vehicle/misc pins (makeIcon) and the live-location beacon dots
// (makeBeaconIcon) so it's unambiguous this one hasn't been placed yet.
function makePlacingIcon() {
  return L.divIcon({
    html: `
      <div style="position:relative;width:40px;height:58px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5));cursor:grab;">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 34 42" style="position:absolute;top:0;left:0;">
          <path d="M17 0C7.6 0 0 7.6 0 17c0 12.7 17 25 17 25S34 29.7 34 17C34 7.6 26.4 0 17 0z"
            fill="#2e7dd7" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
          <circle cx="17" cy="17" r="10" fill="rgba(0,0,0,0.2)"/>
          <text x="17" y="22" text-anchor="middle" font-size="15" fill="white">📍</text>
        </svg>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" style="position:absolute;left:12px;top:42px;">
          <circle cx="8" cy="8" r="7" fill="#fff" stroke="#e53935" stroke-width="1.5"/>
          <path d="M8 3v10M3 8h10" stroke="#e53935" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </div>`,
    iconSize: [40, 58],
    // The red crosshair's center (not the pin's own tip) is the actual
    // coordinate that gets used — that's what "drop" means here.
    iconAnchor: [20, 50],
    className: ''
  })
}

// ── Live location beacon marker ──────────────────────────────────────────────
// Distinct from the manually-placed person/vehicle pins above (makeIcon) —
// this is a live-updating dot for someone actively sharing location from
// Element X on their phone (org.matrix.msc3672.beacon — the real,
// unstable-prefixed MSC3672 event name this deployment uses, see
// matrixStore.js's readBeacons()), plotted independently of the
// Postgres-backed markers list. See messaging_architecture_plan.md.
// `label` is the vehicle+person (or just person) text shown under the dot —
// same visual language as makeIcon()'s labelHtml above, just smaller and
// tinted with the beacon's team color (via `color`) so a live dot reads as
// "part of" that team's pins/legend rather than a generic marker.
// avatarUrl (2026-08-13): the sharing person's own photo (person.image_mxc,
// resolved the same way as makeIcon()'s — see MapBoard's avatarUrls state).
// Deliberately does NOT replace the pulsing ring or its animation — that's
// the whole visual signal that this is a LIVE dot, not a placed marker, so
// it has to survive regardless of whether an avatar is available. The
// avatar only takes over the small solid inner dot, sized up slightly (16px
// -> 20px) so the photo actually reads at this scale, with the team-color
// ring kept as a box-shadow outline since the avatar image would otherwise
// cover the color swatch entirely.
function makeBeaconIcon(color, label, scale = 1, avatarUrl = null) {
  const safeLabel = (label || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const labelHtml = label ? `
    <div style="
      zoom:${scale};
      background:rgba(15,17,23,0.9);
      border:1.5px solid ${color};
      border-radius:6px;
      padding:3px 9px;
      font-size:13px;
      font-weight:700;
      color:#fff;
      white-space:nowrap;
      margin-top:5px;
      font-family:Inter,system-ui,sans-serif;
      max-width:220px;
      overflow:hidden;
      text-overflow:ellipsis;
      text-align:center;
      box-shadow:0 1px 6px rgba(0,0,0,0.5);
    ">${safeLabel}</div>` : ''
  return L.divIcon({
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;cursor:pointer;">
        <div style="position:relative;width:28px;height:28px;filter:drop-shadow(0 1px 5px rgba(0,0,0,0.5));">
          <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.35;animation:cb-beacon-pulse 1.8s ease-out infinite;"></div>
          ${avatarUrl
            ? `<img src="${avatarUrl}" style="position:absolute;left:4px;top:4px;width:20px;height:20px;border-radius:50%;object-fit:cover;border:2.5px solid rgba(255,255,255,0.95);box-shadow:0 0 0 1.5px ${color};pointer-events:none;" />`
            : `<div style="position:absolute;left:6px;top:6px;width:16px;height:16px;border-radius:50%;background:${color};border:2.5px solid rgba(255,255,255,0.95);"></div>`
          }
        </div>
        <style>@keyframes cb-beacon-pulse{0%{transform:scale(0.4);opacity:0.6}100%{transform:scale(1.8);opacity:0}}</style>
        ${labelHtml}
      </div>`,
    iconSize: [230, 62],
    iconAnchor: [115, 14],
    popupAnchor: [0, -14],
    className: ''
  })
}

// matrixStore.js's readBeacons() now parses the MSC3672 geo: URI itself
// (org.matrix.msc3672.beacon_info is the state event announcing a session,
// no coordinates; org.matrix.msc3672.beacon is a separate timeline event
// carrying content['m.location'].uri, linked back via m.relates_to) and
// returns authoritative lat/lng directly — this just reads them off the
// result.
function parseBeaconLatLng(beacon) {
  if (typeof beacon.lat === 'number' && typeof beacon.lng === 'number') return [beacon.lat, beacon.lng]
  return null
}

// A marker's lat/lng can legitimately be null: api.js's markers.list()
// passes through decryptValue()'s null result as-is when a field fails to
// decrypt (roomCrypto.js deliberately swallows per-field decrypt failures
// rather than throwing, "so one bad field can't blow up a whole list
// render" — see its own comment) — e.g. the room key not being ready yet
// when the list loads, a race more visible on some browsers than others.
// Every place that hands marker coordinates to Leaflet needs this guard;
// without it, a single marker with a null lat/lng crashed the ENTIRE map
// view (a bad `.lat` read bubbling up through Leaflet and crashing into
// CrewBoard's ErrorBoundary — confirmed live, 2026-07-28, Safari-only,
// likely because the underlying decrypt-timing race is more exposed there).
function hasCoords(m) {
  return m && Number.isFinite(m.lat) && Number.isFinite(m.lng)
}

// Key used to track "hidden from map" per person/vehicle in the right panel
// (see hiddenEntities below) — keyed off entity_type+entity_id rather than
// marker id, since it's a per-person/vehicle display preference that should
// survive their underlying marker row being deleted and re-placed later.
function entityKey(entityType, entityId) {
  return `${entityType}:${entityId}`
}

const HIDDEN_MARKERS_KEY = 'crewboard-hidden-markers'

function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <Dialog open onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Avatar sx={{ bgcolor: 'error.light', width: 36, height: 36 }}>
          <DeleteIcon sx={{ color: 'error.main', fontSize: 18 }} />
        </Avatar>
        Clear all markers
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>{message}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="error" variant="contained" startIcon={<DeleteIcon />} onClick={onConfirm}>Clear all</Button>
      </DialogActions>
    </Dialog>
  )
}

export default function MapBoard() {
  const [searchParams, setSearchParams] = useSearchParams()
  const mapRef = useRef(null)
  const mapInstance = useRef(null)
  const tileLayerRef = useRef(null)
  const leafletMarkers = useRef({})       // id → L.marker
  const beaconMarkers = useRef({})        // user_id → L.marker (live location dots)
  const connectionLines = useRef([])       // L.polyline[]
  const placingMarkerRef = useRef(null)   // L.marker — the draggable crosshair pin, while active
  const [markers, setMarkers] = useState([])
  const [persons, setPersons] = useState([])
  const [vehicles, setVehicles] = useState([])
  const [teams, setTeams] = useState([])
  const [liveLocations, setLiveLocations] = useState([])
  // mxc:// -> resolved blob: URL, for person/vehicle avatars shown on map
  // pins (makeIcon), live-location beacons (makeBeaconIcon), and the right
  // panel's Persons/"Live now" lists (MxcAvatar below). Populated by the
  // effect below rather than fetched per-render — the same mxc shows up on
  // both a marker pin and a sidebar row, so this is a shared cache, not
  // per-component state like MxcAvatar's own internal one.
  const [avatarUrls, setAvatarUrls] = useState({})
  const [selectedMarker, setSelectedMarker] = useState(null)
  const [locationMarker, setLocationMarker] = useState(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [pendingLatLng, setPendingLatLng] = useState(null)
  const [placingMarker, setPlacingMarker] = useState(false)
  const [showScreenshot, setShowScreenshot] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [highlightedTeam, setHighlightedTeam] = useState(null)
  const [mapReady, setMapReady] = useState(0) // team id or null
  const rootRef = useRef(null)
  // When the widget is pinned/floating in Element's small picture-in-picture
  // frame (see Layout.jsx's float toggle), the map plus its overlay buttons
  // (Add marker, Clear all, Screenshot) all cram into a tiny
  // box and overlap into an unreadable mess (the pin/toolbar buttons stack on
  // top of each other). Below a threshold we hide the map and all its
  // controls entirely and show just the side list, which stays usable at any
  // size. Measured off the component's own root via ResizeObserver rather
  // than window size, since the widget iframe can be resized independently.
  const [compact, setCompact] = useState(false)
  // Current interface-size setting — the map itself stays at 100% (counter-zoom
  // effect below), but marker labels and popups scale with this so they grow
  // along with the rest of the chrome.
  const [uiScale, setUiScaleState] = useState(() => getUiScale())
  const { show: showToast, ToastEl } = useToast()

  // Per-person/vehicle "hide from map" toggle set from the right panel — a
  // purely local declutter preference (not synced to other dispatchers via
  // the backend, unlike everything else on this board), persisted per
  // browser the same way CollapsibleSection remembers panel layout.
  // Doesn't delete or touch the underlying marker row at all; it just skips
  // adding that marker to the Leaflet map in the render effect below.
  const [hiddenEntities, setHiddenEntities] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(HIDDEN_MARKERS_KEY) || '[]')
      return new Set(Array.isArray(saved) ? saved : [])
    } catch { return new Set() }
  })

  function toggleHidden(key) {
    setHiddenEntities(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem(HIDDEN_MARKERS_KEY, JSON.stringify([...next]))
      return next
    })
  }

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      // Roughly: narrower than the side panel needs to sit beside a usable
      // map, or too short to show map + controls without overlap.
      setCompact(width < 440 || height < 340)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Leaflet doesn't know its container changed size while it was display:none
  // (compact mode) — when we bring the map back, tell it to re-measure or it
  // renders as a grey partial tile area until the next pan/zoom.
  useEffect(() => {
    if (!compact && mapInstance.current) {
      // next frame, after the map box is back in layout
      requestAnimationFrame(() => mapInstance.current?.invalidateSize())
    }
  }, [compact])

  // Keep the MAP itself at 100% while the rest of the UI scales (Settings ->
  // interface size). The whole document is zoomed by `scale`; counter-zoom the
  // map container by 1/scale so it nets to true scale — the map and its
  // markers/tiles stay crisp and correctly sized regardless of the chrome
  // scale. Re-measure after each change so Leaflet re-tiles to the new box.
  useEffect(() => {
    const applyInverse = (scale) => {
      const el = mapRef.current
      if (!el) return
      el.style.zoom = scale ? String(1 / scale) : '1'
      requestAnimationFrame(() => mapInstance.current?.invalidateSize())
    }
    applyInverse(getUiScale())
    const handler = (e) => {
      const s = e.detail?.scale ?? getUiScale()
      applyInverse(s)
      setUiScaleState(s) // re-render markers/popups at the new label scale
    }
    window.addEventListener('crewboard:ui-scale', handler)
    return () => window.removeEventListener('crewboard:ui-scale', handler)
  }, [mapReady])

  // Marker lock state is persisted server-side (so every dispatcher's tab
  // sees the same lock/unlock live via the existing markers-updated SSE
  // sync — see CLAUDE.md's "Live updates"), but an unlocked marker left
  // over from BEFORE a reload isn't a real in-progress drag anymore, just a
  // stale flag nobody's actually still acting on. Bug fix (2026-08-09):
  // relock any marker that's unlocked the first time this widget instance
  // loads data, so "unlocked" only ever means "someone unlocked it in the
  // session that's currently open", never "forever until someone manually
  // re-locks it". Guarded to run once per widget load (not on every later
  // live refresh) via didInitialRelock, and silently no-ops for read-only
  // members (the backend 403s their writes anyway — see auth.js).
  const didInitialRelock = useRef(false)

  const loadData = useCallback(async () => {
    try {
      const [m, p, v, t] = await Promise.all([
        api.markers.list(), api.persons.list(),
        api.vehicles.list(), api.teams.list()
      ])
      setMarkers(m); setPersons(p); setVehicles(v); setTeams(t)

      if (!didInitialRelock.current) {
        didInitialRelock.current = true
        const staleUnlocked = m.filter(mk => mk.locked === false)
        if (staleUnlocked.length > 0) {
          try {
            await Promise.all(staleUnlocked.map(mk => api.markers.update(mk.id, { locked: true })))
            setMarkers(await api.markers.list())
          } catch (e) {
            console.warn('Relocking stale-unlocked markers on load failed (likely read-only member):', e.message)
          }
        }
      }
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Resolves every distinct image_mxc across persons/vehicles into a
  // blob: URL and caches it in avatarUrls (declared above), so map pins,
  // beacons, and the sidebar lists all read off the same cache instead of
  // each firing their own downloadFile() for the same mxc. Only fetches
  // mxcs not already in the cache — avatarUrls itself is intentionally NOT
  // a dependency here (that would re-run the instant it's set, in a loop);
  // this only needs to react to the person/vehicle rows changing.
  useEffect(() => {
    const mxcs = new Set()
    persons.forEach(p => { if (p.image_mxc) mxcs.add(p.image_mxc) })
    vehicles.forEach(v => { if (v.image_mxc) mxcs.add(v.image_mxc) })
    const missing = [...mxcs].filter(mxc => !(mxc in avatarUrls))
    if (missing.length === 0) return
    let cancelled = false
    Promise.all(missing.map(mxc => api.media.url(mxc).then(url => [mxc, url]).catch(() => [mxc, null])))
      .then(pairs => {
        if (cancelled) return
        setAvatarUrls(prev => {
          const next = { ...prev }
          pairs.forEach(([mxc, url]) => { next[mxc] = url })
          return next
        })
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persons, vehicles])

  // "View on map" (Teams.jsx, ?team=<id>) — highlight that team and pan/fit
  // the map to its markers once teams+markers have loaded, then clear the
  // param so it doesn't re-trigger on a later reload/back-navigation and so
  // manually toggling the legend afterward behaves normally.
  useEffect(() => {
    const teamId = searchParams.get('team')
    if (!teamId || teams.length === 0) return
    const team = teams.find(t => t.id === teamId)
    if (!team) return

    setHighlightedTeam(team.id)

    const map = mapInstance.current
    if (map) {
      const teamMarkers = markers.filter(m => m.team_name === team.name && m.entity_type !== 'misc' && hasCoords(m))
      if (teamMarkers.length > 0) {
        const bounds = L.latLngBounds(teamMarkers.map(m => [m.lat, m.lng]))
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 })
      }
    }

    setSearchParams({}, { replace: true })
  }, [teams, markers, mapReady, searchParams, setSearchParams])

  // Live location beacons (org.matrix.msc3672.beacon, cross-room aggregated — see
  // matrixStore.js's readBeacons() and messaging_architecture_plan.md).
  // Progressive enhancement: silently no-ops if nothing's being shared or
  // the read fails, rather than surfacing an error toast for what's an
  // optional feature.
  const loadBeacons = useCallback(async () => {
    try { setLiveLocations(await api.matrix.locations()) }
    catch (e) { console.warn('readBeacons() failed (non-fatal):', e.message) }
  }, [])

  useEffect(() => { loadBeacons() }, [loadBeacons])

  // Refresh markers + beacons when a live location updates the room state,
  // even if this tab is already open. Also poll on a slow cadence as a
  // fallback in case Element doesn't push cross-room beacon updates the same
  // way it does for the widget's own room — cheap enough to run regardless.
  useEffect(() => {
    const handler = () => { loadData(); loadBeacons() }
    window.addEventListener('crewboard:markers-updated', handler)
    const interval = setInterval(loadBeacons, 30000)
    return () => { window.removeEventListener('crewboard:markers-updated', handler); clearInterval(interval) }
  }, [loadData, loadBeacons])

  // Init map — restore last position from DB
  useEffect(() => {
    if (mapInstance.current || !mapRef.current) return

    api.settings.get().then(s => {
      if (s.map_center_lat && s.map_center_lng) {
        mapViewState.center = [parseFloat(s.map_center_lat), parseFloat(s.map_center_lng)]
        mapViewState.zoom = parseInt(s.map_zoom || '12')
      }
    }).catch(() => {}).finally(() => {
      if (mapInstance.current) return
      const map = L.map(mapRef.current, {
        center: mapViewState.center, zoom: mapViewState.zoom, zoomControl: false
      })
      L.control.zoom({ position: 'topright' }).addTo(map)
      const tile = L.tileLayer(TILES.street.url, { attribution: TILES.street.attr, maxZoom: 19 })
      tile.addTo(map)
      tileLayerRef.current = tile
      // Clicking the map no longer opens the add-marker modal directly —
      // see startPlacingMarker() below. Placement now goes through a
      // draggable pin (the "Add marker" button drops one at the map
      // center) so the user can see and adjust exactly where it'll land
      // before the modal opens, rather than committing to whatever point
      // they happened to click.
      map.on('moveend zoomend', () => {
        const center = map.getCenter()
        const zoom = map.getZoom()
        mapViewState.center = [center.lat, center.lng]
        mapViewState.zoom = zoom
        api.settings.update({
          map_center_lat: center.lat.toString(),
          map_center_lng: center.lng.toString(),
          map_zoom: zoom.toString()
        }).catch(() => {})
      })
      mapInstance.current = map
      // Force markers to re-render now that map is ready
      setMapReady(r => r + 1)
    })

    return () => {
      if (mapInstance.current) {
        const center = mapInstance.current.getCenter()
        const zoom = mapInstance.current.getZoom()
        mapViewState.center = [center.lat, center.lng]
        mapViewState.zoom = zoom
        mapInstance.current.remove()
        mapInstance.current = null
      }
    }
  }, [])

  // Invalidate map size when switching back to this tab (fixes blank/missing tiles+markers)
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && mapInstance.current) {
        setTimeout(() => {
          mapInstance.current?.invalidateSize()
          loadData()
        }, 100)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [loadData])

  // Sync markers + apply highlight/fade + draw connection lines
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return

    // Remove old markers
    Object.values(leafletMarkers.current).forEach(m => m.remove())
    leafletMarkers.current = {}

    // Remove old connection lines
    connectionLines.current.forEach(l => l.remove())
    connectionLines.current = []

    markers.forEach(marker => {
      if (!hasCoords(marker)) {
        console.warn('MapBoard: skipping marker with missing/invalid coordinates (likely a decrypt-timing race — see hasCoords()):', marker.id)
        return
      }
      // Right panel's per-person/vehicle show/hide toggle — skip adding this
      // marker to the map entirely (row still exists in the panel list).
      if ((marker.entity_type === 'person' || marker.entity_type === 'vehicle') &&
        hiddenEntities.has(entityKey(marker.entity_type, marker.entity_id))) {
        return
      }
      const faded = highlightedTeam !== null && teams.length > 0 && marker.entity_type !== 'misc' &&
        marker.team_name !== teams.find(t => t.id === highlightedTeam)?.name
      // marker.color is the pin color chosen in AddMarkerModal's "Pin color"
      // swatch for misc markers (plaintext column, backend/routes/markers.js
      // toRow()) — it must win over team_color (which misc markers never
      // have, since they're not linked to a person/vehicle/team) so the
      // color the dispatcher actually picked shows up on the map, not
      // always the same fallback gray.
      const color = marker.color || marker.team_color || '#3d4460'
      // A misc marker with vehicle_type set is one created by
      // vehicleCommands.js's \car/\motorcycle text-command tagging (no
      // linked vehicles row) — render it with the same glyph a
      // database-linked vehicle marker gets instead of
      // the generic info-square misc pin.
      const type = marker.entity_type === 'vehicle' ? (marker.vehicle_type || 'car')
        : marker.entity_type === 'misc' ? (marker.vehicle_type || 'misc') : 'person'
      const label = marker.label || ''
      const avatarUrl = marker.image_mxc ? avatarUrls[marker.image_mxc] || null : null
      const icon = makeIcon(color, type, label, faded, null, uiScale, avatarUrl)

      const lm = L.marker([marker.lat, marker.lng], { icon, draggable: !marker.locked, title: label })

      const popupContent = document.createElement('div')
      popupContent.innerHTML = buildPopupHTML(marker)
      popupContent.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]')
        if (!btn) return
        const action = btn.dataset.action
        if (action === 'toggle-lock') toggleLock(marker.id, !marker.locked)
        if (action === 'delete') deleteMarker(marker.id)
        if (action === 'message') setSelectedMarker(marker)
        if (action === 'send-location') setLocationMarker(marker)
      })

      // autoPan: false (bug fix, 2026-08-04) — every "jump to this marker"
      // click from the right panel already does an explicit
      // map.setView([lat,lng], 17, {animate:true}) BEFORE calling
      // openPopup() (see the right-panel onClick handlers below). Leaflet's
      // own default autoPan:true then runs its OWN pan on top of that, once
      // it measures the actual popup bubble's on-screen size/position —
      // which re-centers on the POPUP BUBBLE, not the marker point, and can
      // shove the marker itself off toward an edge depending on the popup's
      // height and where it happened to land relative to the container
      // edges. Since every caller already explicitly centers on the marker
      // right before opening its popup, Leaflet's own auto-pan is only ever
      // fighting that explicit centering here, never doing useful work —
      // disabling it is what keeps "select from the list" reliably landing
      // the marker in the middle instead of "usually the middle, sometimes
      // an edge" depending on popup content height.
      lm.bindPopup(popupContent, { maxWidth: px(220), autoPan: false })
      // Re-measure the popup once it's actually open. Bug fix (2026-08-19):
      // this used to be load-bearing — the popup content applied its own
      // CSS `zoom:${uiScale}` on top of the map container's counter-zoom,
      // and Leaflet measures `_contentNode.offsetWidth/offsetHeight`
      // synchronously when it binds/opens, which could race that stacked
      // zoom settling and lock the wrapper to a stale, too-small pre-zoom
      // size — visibly, buttons spilling out past the popup's rounded
      // border. buildPopupHTML() no longer uses CSS `zoom` at all (see its
      // comment / the `px()` helper below) — every size in the popup is a
      // literal, already-scaled px value baked into the HTML string up
      // front, so there's nothing left to asynchronously settle and this
      // read is correct on the very first synchronous measurement. Kept
      // anyway as cheap insurance against the map's OWN counter-zoom (set
      // imperatively outside React, see the uiScale effect above) not yet
      // having applied if a popup opens in the same tick as mount.
      lm.on('popupopen', () => requestAnimationFrame(() => lm.getPopup()?.update()))
      lm.on('dragend', async (e) => {
        const { lat, lng } = e.target.getLatLng()
        try { await api.markers.update(marker.id, { lat, lng }); showToast('Position saved') }
        catch { showToast('Failed to save position', 'error') }
      })

      lm.addTo(map)
      leafletMarkers.current[marker.id] = lm
    })

    // Draw dotted connection lines for highlighted team
    if (highlightedTeam !== null) {
      const team = teams.find(t => t.id === highlightedTeam)
      if (!team) return

      // All vehicle markers belonging to this team on the map (excluding
      // ones hidden via the right panel toggle — no point drawing a line to
      // a pin that isn't actually shown)
      const vehicleMarkers = markers.filter(m =>
        m.entity_type === 'vehicle' &&
        m.team_name === team.name &&
        hasCoords(m) &&
        !hiddenEntities.has(entityKey(m.entity_type, m.entity_id))
      )

      // All person markers belonging to this team on the map (same hidden
      // exclusion as above)
      const personMarkers = markers.filter(m =>
        m.entity_type === 'person' &&
        m.team_name === team.name &&
        hasCoords(m) &&
        !hiddenEntities.has(entityKey(m.entity_type, m.entity_id))
      )

      // Connect each vehicle to every team member on the map
      vehicleMarkers.forEach(vm => {
        personMarkers.forEach(pm => {
          const line = L.polyline(
            [[vm.lat, vm.lng], [pm.lat, pm.lng]],
            {
              color: team.color,
              weight: 2,
              opacity: 0.85,
              dashArray: '6, 8',
              lineCap: 'round'
            }
          )
          line.addTo(map)
          connectionLines.current.push(line)
        })
      })
    }
  }, [markers, highlightedTeam, teams, mapReady, uiScale, avatarUrls, hiddenEntities])

  // Beacons are keyed by whatever Matrix user_id is doing the sharing —
  // that includes anyone in the room, not just people CrewBoard knows
  // about. Only plot ones that resolve to a person actually in the
  // database (matched by matrix_id); everyone else's beacon is dropped
  // rather than shown as a bare, unlabeled dot. Also resolves the person's
  // linked vehicle (if any — same person_id link Database.jsx/api.js use
  // elsewhere) so the marker can show "vehicle · person" instead of just a
  // name, and carries the person's team_color through for both the marker
  // and the label tint.
  const activeBeacons = useMemo(() => {
    return liveLocations
      .map(beacon => {
        const person = persons.find(p => p.matrix_id === beacon.user_id)
        if (!person) return null
        const vehicle = vehicles.find(v => String(v.person_id) === String(person.id))
        return { ...beacon, person, vehicle }
      })
      .filter(Boolean)
  }, [liveLocations, persons, vehicles])

  // Person ids currently sharing a live location — drives the indicator
  // dot in the right panel's Persons list below.
  const sharingPersonIds = useMemo(
    () => new Set(activeBeacons.map(b => b.person.id)),
    [activeBeacons]
  )

  // Sync live-location beacon dots — kept in a separate effect/ref
  // (beaconMarkers) from the placed markers above so a beacon update doesn't
  // rebuild every manually-placed pin, and vice versa.
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return

    Object.values(beaconMarkers.current).forEach(m => m.remove())
    beaconMarkers.current = {}

    activeBeacons.forEach(({ person, vehicle, ...beacon }) => {
      const latlng = parseBeaconLatLng(beacon)
      if (!latlng) return
      const color = person.team_color || '#4e7fff'
      const label = vehicle ? `${vehicle.make} ${vehicle.model} · ${person.name}` : person.name
      const avatarUrl = person.image_mxc ? avatarUrls[person.image_mxc] || null : null

      const bm = L.marker(latlng, { icon: makeBeaconIcon(color, label, uiScale, avatarUrl), title: `${label} (live location)`, zIndexOffset: 1000 })
      const ageMin = beacon.timestamp ? Math.max(0, Math.round((Date.now() - beacon.timestamp) / 60000)) : null

      // A beacon isn't a placed DB marker, so build a marker-like object the
      // Message / Send-location modals already understand (they read .label,
      // .matrix_id, .lat/.lng, etc.) from the resolved person + vehicle +
      // live coordinate — so clicking a beacon opens the same detail popup and
      // actions a person marker has (minus lock/delete, which don't apply to a
      // live dot).
      const entity = {
        id: person.id, entity_type: 'person', entity_id: person.id,
        label: person.name, name: person.name,
        matrix_id: person.matrix_id || null, phone: person.phone || null,
        dm_room_id: person.dm_room_id || null,
        team_name: person.team_name || null, team_color: person.team_color || null,
        license_plate: vehicle?.license_plate || null,
        linked_vehicle: vehicle ? `${vehicle.make} ${vehicle.model}` : null,
        lat: latlng[0], lng: latlng[1], note: null, locked: true,
      }

      const popupContent = document.createElement('div')
      popupContent.innerHTML = `
        <div style="min-width:${px(190)}px;max-width:100%;box-sizing:border-box;">
          <div style="font-size:${px(14)}px;font-weight:700;margin-bottom:${px(2)}px;">📍 ${person.name}</div>
          <div style="font-size:${px(10)}px;color:var(--muted);margin-bottom:${px(8)}px;display:flex;align-items:center;gap:${px(5)}px;">
            <span style="width:${px(8)}px;height:${px(8)}px;border-radius:50%;background:${color};display:inline-block;"></span>
            ${person.team_name || 'Live location'}${ageMin != null ? ` · ${ageMin === 0 ? 'just now' : ageMin + 'm ago'}` : ''}
          </div>
          ${vehicle ? `<div style="font-size:${px(12)}px;color:var(--muted);margin-bottom:${px(4)}px;">🚗 ${vehicle.make} ${vehicle.model}${vehicle.license_plate ? ` · ${vehicle.license_plate}` : ''}</div>` : ''}
          ${person.phone ? `<div style="font-size:${px(12)}px;color:var(--muted);margin-bottom:${px(4)}px;">📞 ${person.phone}</div>` : ''}
          ${person.matrix_id ? `<div style="font-size:${px(11)}px;color:var(--dim);margin-bottom:${px(4)}px;">${person.matrix_id}</div>` : ''}
          <div style="display:flex;gap:${px(5)}px;margin-top:${px(10)}px;">
            ${person.matrix_id ? `<button data-action="message" style="${popupBtn(11, 6)}border:1px solid var(--accent-border);background:var(--accent-bg);color:var(--accent);">💬 Message</button>` : ''}
            <button data-action="send-location" style="${popupBtn(11, 6)}border:1px solid var(--border2);background:var(--surface3);color:var(--muted);">📍 Location</button>
          </div>
        </div>`
      popupContent.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]')
        if (!btn) return
        if (btn.dataset.action === 'message') setSelectedMarker(entity)
        if (btn.dataset.action === 'send-location') setLocationMarker(entity)
      })
      // autoPan: false — same fix and same reasoning as the regular marker
      // popups above (see that bindPopup call's comment).
      bm.bindPopup(popupContent, { maxWidth: px(260), autoPan: false })
      // Same insurance as the regular marker popups above — see that
      // `popupopen` comment for why this is no longer load-bearing now that
      // sizing is baked in as literal px rather than a nested CSS zoom.
      bm.on('popupopen', () => requestAnimationFrame(() => bm.getPopup()?.update()))
      bm.addTo(map)
      beaconMarkers.current[person.id] = bm
    })
  }, [activeBeacons, mapReady, uiScale, avatarUrls])

  // Popup content scales with the interface-size setting (uiScale) via
  // literal, pre-computed px values baked into the HTML string below — NOT
  // CSS `zoom`. Bug fix (2026-08-19): the popup used to sit inside a THIRD
  // nested zoom context (the app-wide zoom on <html> × the map container's
  // own counter-zoom × this popup's own `zoom:${uiScale}`), and Leaflet
  // measures the popup's rendered width synchronously the instant it opens
  // — a race against that stacked zoom actually finishing layout that
  // occasionally lost, locking the popup wrapper to a stale pre-zoom width
  // while the (correctly larger) zoomed content painted past its edges —
  // see the `popupopen` comment above. Baking `uiScale` into literal
  // font-size/padding/gap numbers up front instead means the popup's DOM
  // is correctly sized on its very first layout pass, with no separate
  // zoom step left to race at all.
  const px = (n) => Math.round(n * uiScale)

  // Shared style for the "flex:1" action buttons inside popup content
  // (Message/Location, Lock/Unlock, Send, etc). Bug fix (2026-07-27): these
  // used to just be `flex:1` with no `min-width:0` — flex items default to
  // `min-width:auto`, meaning a button won't shrink below its own text's
  // natural width no matter how little room the row actually has. With two+
  // buttons whose combined natural width exceeds the popup's own maxWidth
  // (passed to bindPopup above), the row simply overflowed past the
  // popup's rounded border instead of shrinking to fit — visibly, the
  // rightmost button floated outside the dark popup box entirely.
  // `min-width:0` lets flex items actually shrink; `overflow:hidden` +
  // `text-overflow:ellipsis` + `white-space:nowrap` truncates gracefully
  // instead of wrapping/clipping mid-glyph if a button still doesn't have
  // quite enough room at very small UI-scale settings.
  function popupBtn(fontSize = 10, padding = 5) {
    return `flex:1;min-width:0;box-sizing:border-box;padding:${px(padding)}px;border-radius:${px(6)}px;font-size:${px(fontSize)}px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`
  }

  // Delete "✕" button — flex:0 1 auto (shrink allowed) + min-width:0 so it
  // can truncate/compress too rather than being pinned to a fixed width
  // that pokes out past the popup border if a row ever gets tight.
  function popupDeleteBtn() {
    return `flex:0 1 auto;min-width:0;box-sizing:border-box;overflow:hidden;padding:${px(5)}px ${px(8)}px;border-radius:${px(6)}px;border:1px solid var(--danger-border);background:var(--danger-bg);color:var(--danger);font-size:${px(10)}px;cursor:pointer;`
  }

  function buildPopupHTML(m) {
    if (m.entity_type === 'misc') {
      // vehicle_type set = tagged via vehicleCommands.js's \car/\motorcycle
      // command, not a manually-dropped POI pin.
      const subtitle = m.vehicle_type
        ? `Shared location · tagged ${m.vehicle_type}`
        : 'Point of interest'
      return `
        <div style="min-width:${px(180)}px;max-width:100%;box-sizing:border-box;">
          <div style="font-size:${px(13)}px;font-weight:600;margin-bottom:${px(2)}px;">${m.vehicle_type ? (m.vehicle_type === 'motorcycle' ? '🏍' : '🚗') : '📍'} ${m.label || '—'}</div>
          <div style="font-size:${px(10)}px;color:var(--muted);margin-bottom:${px(8)}px;">${subtitle}</div>
          ${m.note ? `<div style="font-size:${px(11)}px;color:var(--muted);margin-bottom:${px(8)}px;line-height:1.5;">${m.note}</div>` : ''}
          <div style="display:flex;gap:${px(5)}px;margin-top:${px(10)}px;">
            <button data-action="send-location" title="Send location" style="${popupBtn()}border:1px solid var(--accent-border);background:var(--accent-bg);color:var(--accent);">📍</button>
            <button data-action="toggle-lock" title="${m.locked ? 'Unlock' : 'Lock'}" style="${popupBtn()}border:1px solid var(--border2);background:var(--surface3);color:var(--muted);">
              ${m.locked ? '🔓' : '🔒'}
            </button>
            <button data-action="delete" style="${popupDeleteBtn()}">✕</button>
          </div>
          <div style="margin-top:${px(8)}px;padding-top:${px(8)}px;border-top:1px solid var(--border);font-size:${px(10)}px;color:var(--dim);">
            ${m.locked ? '🔒 Locked — click Unlock to reposition' : '🔓 Unlocked — drag to reposition'}
          </div>
        </div>`
    }
    return `
      <div style="min-width:${px(180)}px;max-width:100%;box-sizing:border-box;">
        <div style="font-size:${px(13)}px;font-weight:600;margin-bottom:${px(2)}px;">${m.label || '—'}</div>
        <div style="font-size:${px(10)}px;color:var(--muted);margin-bottom:${px(8)}px;display:flex;align-items:center;gap:${px(5)}px;">
          ${m.team_name ? `<span style="width:${px(7)}px;height:${px(7)}px;border-radius:50%;background:${m.team_color};display:inline-block;"></span>${m.team_name}` : 'Unassigned'}
        </div>
        ${m.phone ? `<div style="font-size:${px(11)}px;color:var(--muted);margin-bottom:${px(4)}px;">📞 ${m.phone}</div>` : ''}
        ${m.license_plate ? `<div style="font-size:${px(11)}px;color:var(--muted);margin-bottom:${px(4)}px;">🪪 ${m.license_plate}</div>` : ''}
        ${m.linked_vehicle ? `<div style="font-size:${px(11)}px;color:var(--muted);margin-bottom:${px(4)}px;">🚗 ${m.linked_vehicle}</div>` : ''}
        ${m.linked_person ? `<div style="font-size:${px(11)}px;color:var(--muted);margin-bottom:${px(4)}px;">👤 ${m.linked_person}</div>` : ''}
        ${m.note ? `<div style="font-size:${px(11)}px;color:var(--muted);margin-bottom:${px(8)}px;line-height:1.5;">${m.note}</div>` : ''}
        <div style="display:flex;gap:${px(5)}px;margin-top:${px(10)}px;">
          ${m.matrix_id ? `<button data-action="message" title="Message" style="${popupBtn()}border:1px solid var(--accent-border);background:var(--accent-bg);color:var(--accent);">💬</button>` : ''}
          <button data-action="send-location" title="Send location" style="${popupBtn()}border:1px solid var(--border2);background:var(--surface3);color:var(--muted);">📍</button>
        </div>
        <div style="display:flex;gap:${px(5)}px;margin-top:${px(5)}px;">
          <button data-action="toggle-lock" title="${m.locked ? 'Unlock' : 'Lock'}" style="${popupBtn()}border:1px solid var(--border2);background:var(--surface3);color:var(--muted);">
            ${m.locked ? '🔓' : '🔒'}
          </button>
          <button data-action="delete" style="${popupDeleteBtn()}">✕</button>
        </div>
        <div style="margin-top:${px(8)}px;padding-top:${px(8)}px;border-top:1px solid var(--border);font-size:${px(10)}px;color:var(--dim);">
          ${m.locked ? '🔒 Locked — click Unlock to reposition' : '🔓 Unlocked — drag to reposition'}
        </div>
      </div>`
  }

  async function toggleLock(id, locked) {
    try {
      // Unlocking a marker auto re-locks every OTHER currently-unlocked one
      // first (2026-08-09) — at most one marker draggable at a time, so two
      // dispatchers (or two tabs) can't end up mid-drag on different
      // markers simultaneously via the same shared, live-synced lock state.
      if (!locked) {
        const others = markers.filter(mk => mk.id !== id && mk.locked === false)
        await Promise.all(others.map(mk => api.markers.update(mk.id, { locked: true })))
      }
      await api.markers.update(id, { locked })
      await loadData()
      showToast(locked ? 'Marker locked' : 'Marker unlocked')
    }
    catch { showToast('Failed', 'error') }
  }

  async function deleteMarker(id) {
    try { await api.markers.delete(id); await loadData(); showToast('Marker removed') }
    catch { showToast('Failed', 'error') }
  }

  async function clearAll() {
    try { await api.markers.clearAll(); await loadData(); showToast('All markers cleared') }
    catch { showToast('Failed', 'error') }
    setShowClearConfirm(false)
  }

  async function handleAddMarker(entityType, entityId, extra = {}) {
    if (!pendingLatLng) return
    try {
      await api.markers.create({
        entity_type: entityType,
        entity_id: entityId,
        lat: pendingLatLng.lat,
        lng: pendingLatLng.lng,
        locked: true,
        ...extra
      })
      await loadData(); showToast('Marker placed')
    } catch (e) { showToast(e.message, 'error') }
    setShowAddModal(false); setPendingLatLng(null)
  }

  function toggleTeamHighlight(teamId) {
    setHighlightedTeam(prev => prev === teamId ? null : teamId)
  }

  // ── Drag-to-place new marker ────────────────────────────────────────────
  // "Add marker" no longer opens the modal directly, and clicking the map
  // background no longer does either (see the map-init effect above). It
  // drops a draggable crosshair pin (makePlacingIcon) at the map's current
  // center instead — the user drags it around as many times as they like,
  // and AddMarkerModal only opens once they explicitly CLICK the pin to
  // confirm the spot.
  //
  // Bug fix (2026-08-04): this used to also open the modal on 'dragend' —
  // i.e. the instant the user released the pin after a single drag, before
  // they'd necessarily settled on the right spot. That made "drag once, let
  // go" indistinguishable from "confirm this location", so there was no way
  // to nudge the pin more than once without the modal popping up after the
  // very first drop. Placement and confirmation are now two separate
  // gestures: dragging (any number of times, 'dragend' no longer does
  // anything but leave the pin where it lands) repositions the pin, and only
  // a click on the pin itself confirms it and opens the modal.
  function startPlacingMarker() {
    const map = mapInstance.current
    if (!map || placingMarkerRef.current) return

    const pin = L.marker(map.getCenter(), {
      icon: makePlacingIcon(),
      draggable: true,
      autoPan: true,
      zIndexOffset: 2000,
    })
    pin.addTo(map)

    pin.on('click', () => {
      setPendingLatLng(pin.getLatLng())
      setShowAddModal(true)
      pin.remove()
      placingMarkerRef.current = null
      setPlacingMarker(false)
    })

    placingMarkerRef.current = pin
    setPlacingMarker(true)
  }

  function cancelPlacingMarker() {
    placingMarkerRef.current?.remove()
    placingMarkerRef.current = null
    setPlacingMarker(false)
  }

  // Clean up the placement pin if the view unmounts mid-placement (route
  // change, etc.) rather than leaving a stray marker/listener behind.
  useEffect(() => {
    return () => { placingMarkerRef.current?.remove(); placingMarkerRef.current = null }
  }, [])

  const placedPersonIds = new Set(markers.filter(m => m.entity_type === 'person').map(m => m.entity_id))
  const placedVehicleIds = new Set(markers.filter(m => m.entity_type === 'vehicle').map(m => m.entity_id))
  const miscMarkers = markers.filter(m => m.entity_type === 'misc')

  return (
    <Box ref={rootRef} sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* MAP — hidden in compact/floating mode (kept mounted, just display:none,
          so the Leaflet instance survives; invalidateSize() runs on return). */}
      <Box sx={{ flex: 1, position: 'relative', display: compact ? 'none' : 'block' }}>
        <Box ref={mapRef} sx={{ width: '100%', height: '100%' }} />

        {/* TOP LEFT — zoom slider (always reachable, overlaid on the map) then
            the Add-marker cluster below it. */}
        <Box sx={{ position: 'absolute', top: 12, left: 12, zIndex: 500, display: 'flex', flexDirection: 'column', gap: 0.75, alignItems: 'flex-start' }}>
          <Paper
            elevation={2}
            // Keep the slider itself at true size regardless of the interface
            // scale (it's inside the scaled document), so it never grows off
            // the corner — counter-zoom it. Its width in on-screen px stays put.
            sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.25, borderRadius: 2, zoom: 1 / uiScale }}
          >
            <Tooltip title="Interface size">
              <Typography sx={{ fontSize: 11, color: 'text.secondary', fontWeight: 600 }}>A</Typography>
            </Tooltip>
            <Slider
              size="small"
              value={uiScale}
              min={UI_SCALE_MIN}
              max={UI_SCALE_MAX}
              step={0.05}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${Math.round(v * 100)}%`}
              onChange={(_, v) => applyUiScale(v)}
              onChangeCommitted={(_, v) => setUiScale(v)}
              sx={{ width: 96 }}
            />
            <Typography sx={{ fontSize: 15, color: 'text.secondary', fontWeight: 600 }}>A</Typography>
            <Chip size="small" label={`${Math.round(uiScale * 100)}%`} sx={{ height: 18, fontSize: 10, minWidth: 42 }} />
          </Paper>

          <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
            <Button
              variant="contained" size="small" startIcon={<AddIcon fontSize="small" />}
              onClick={startPlacingMarker}
              disabled={placingMarker}
            >
              Add marker
            </Button>
            {placingMarker ? (
              <>
                <Chip size="small" label="Drag the pin, then click it to confirm" variant="outlined" sx={{ bgcolor: 'background.paper', fontSize: 10 }} />
                <Chip size="small" label="Cancel" onClick={cancelPlacingMarker} onDelete={cancelPlacingMarker} sx={{ fontSize: 10 }} />
              </>
            ) : null}
          </Box>
        </Box>

        {/* TOP CENTER — search markers already on this board (no external
            API call — see MarkerSearch above) */}
        <MarkerSearch markers={markers} mapInstance={mapInstance} leafletMarkers={leafletMarkers} />

        {/* TOP RIGHT — moved up from the bottom so a taller-than-viewport
            document (high interface scale) can't clip them off-screen.
            Offset left of Leaflet's own zoom control (top-right corner). */}
        <Box sx={{ position: 'absolute', top: 12, right: 52, zIndex: 500, display: 'flex', flexDirection: 'column', gap: 0.75, alignItems: 'flex-end' }}>
          <Button variant="outlined" size="small" startIcon={<CameraAltIcon fontSize="small" />} sx={{ bgcolor: 'background.paper' }} onClick={() => setShowScreenshot(true)}>
            Screenshot & Send
          </Button>
          <Button variant="contained" color="error" size="small" startIcon={<DeleteIcon fontSize="small" />} onClick={() => setShowClearConfirm(true)}>
            Clear all
          </Button>
        </Box>

        {/* HIGHLIGHT HINT */}
        {highlightedTeam && (
          <Box sx={{ position: 'absolute', top: 50, left: '50%', transform: 'translateX(-50%)', zIndex: 500 }}>
            <Chip
              size="small"
              variant="outlined"
              color="primary"
              icon={<Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: teams.find(t => t.id === highlightedTeam)?.color, ml: 1 }} />}
              label={`${teams.find(t => t.id === highlightedTeam)?.name} highlighted`}
              onDelete={() => setHighlightedTeam(null)}
            />
          </Box>
        )}
      </Box>

      {/* RIGHT PANEL — takes the full width in compact/floating mode, since the
          map beside it is hidden then. */}
      <Box sx={{ width: compact ? '100%' : 210, flex: compact ? 1 : 'none', bgcolor: 'background.paper', borderLeft: compact ? 0 : 1, borderColor: 'divider', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
        <Box sx={{ px: 1.75, py: 1.25, borderBottom: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="overline" sx={{ fontSize: 10, fontWeight: 600, color: 'text.secondary', letterSpacing: 0.5 }}>On the map</Typography>
          <Chip size="small" label={markers.length} sx={{ height: 18, fontSize: 10 }} />
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto', px: 1.75, py: 1.25 }}>
          {activeBeacons.length > 0 && (
            <CollapsibleSection storageKey="live-now" title="Live now" count={activeBeacons.length} defaultHeight={140}>
              <List dense disablePadding>
                {activeBeacons.map(({ person, vehicle, ...beacon }) => {
                  const ageMin = beacon.timestamp ? Math.max(0, Math.round((Date.now() - beacon.timestamp) / 60000)) : null
                  const label = vehicle ? `${vehicle.make} ${vehicle.model} · ${person.name}` : person.name
                  return (
                    <ListItemButton
                      key={person.id}
                      disableGutters
                      sx={{ py: 0.5, borderBottom: 1, borderColor: 'divider' }}
                      onClick={() => {
                        const latlng = parseBeaconLatLng(beacon)
                        if (latlng && mapInstance.current) {
                          mapInstance.current.setView(latlng, 17, { animate: true })
                          beaconMarkers.current[person.id]?.openPopup()
                        }
                      }}
                    >
                      <ListItemAvatar sx={{ minWidth: 34 }}>
                        <Badge
                          overlap="circular"
                          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
                          badgeContent={
                            <Tooltip title="Sharing live location">
                              <LocationOnIcon sx={{ fontSize: 11, color: 'success.main', bgcolor: 'background.paper', borderRadius: '50%' }} />
                            </Tooltip>
                          }
                        >
                          <MxcAvatar mxc={person.image_mxc} fetchFn={api.media.url} sx={{ width: 26, height: 26, fontSize: 9, bgcolor: person.team_color ? person.team_color + '25' : 'action.selected', color: person.team_color || 'text.secondary' }}>
                            {person.name.slice(0, 2).toUpperCase()}
                          </MxcAvatar>
                        </Badge>
                      </ListItemAvatar>
                      <ListItemText
                        primary={label}
                        secondary={ageMin != null ? (ageMin === 0 ? 'Updated just now' : `Updated ${ageMin}m ago`) : null}
                        primaryTypographyProps={{ fontSize: 11.5 }}
                        secondaryTypographyProps={{ fontSize: 10 }}
                      />
                    </ListItemButton>
                  )
                })}
              </List>
            </CollapsibleSection>
          )}

          <CollapsibleSection storageKey="persons" title="Persons" count={persons.length} defaultHeight={220}>
          {persons.length === 0 && <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>No persons added yet</Typography>}
          <List dense disablePadding>
            {persons.map(p => (
              <ListItemButton
                key={p.id}
                disableGutters
                sx={{ py: 0.5, borderBottom: 1, borderColor: 'divider' }}
                disabled={!placedPersonIds.has(p.id)}
                onClick={() => {
                  const marker = markers.find(m => m.entity_type === 'person' && m.entity_id === p.id)
                  if (marker && hasCoords(marker) && mapInstance.current) {
                    const key = entityKey('person', p.id)
                    // Jumping to a hidden marker un-hides it too, rather than
                    // panning to an empty spot on the map — the popup itself
                    // may not open on this exact click since the marker only
                    // gets (re)added to the map on the next render.
                    if (hiddenEntities.has(key)) toggleHidden(key)
                    mapInstance.current.setView([marker.lat, marker.lng], 17, { animate: true })
                    leafletMarkers.current[marker.id]?.openPopup()
                  }
                }}
              >
                <ListItemAvatar sx={{ minWidth: 34 }}>
                  <Badge
                    overlap="circular"
                    anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
                    invisible={!sharingPersonIds.has(p.id)}
                    badgeContent={
                      <Tooltip title="Sharing live location">
                        <LocationOnIcon sx={{ fontSize: 11, color: 'success.main', bgcolor: 'background.paper', borderRadius: '50%' }} />
                      </Tooltip>
                    }
                  >
                    <MxcAvatar mxc={p.image_mxc} fetchFn={api.media.url} sx={{ width: 26, height: 26, fontSize: 9, bgcolor: p.team_color ? p.team_color + '25' : 'action.selected', color: p.team_color || 'text.secondary' }}>
                      {p.name.slice(0, 2).toUpperCase()}
                    </MxcAvatar>
                  </Badge>
                </ListItemAvatar>
                <ListItemText
                  primary={p.name}
                  secondary={p.team_name || 'Unassigned'}
                  primaryTypographyProps={{ fontSize: 12, fontWeight: 500, noWrap: true }}
                  secondaryTypographyProps={{ fontSize: 10 }}
                />
                {placedPersonIds.has(p.id) && (
                  <Tooltip title={hiddenEntities.has(entityKey('person', p.id)) ? 'Show on map' : 'Hide from map'}>
                    <IconButton
                      size="small"
                      onClick={(e) => { e.stopPropagation(); toggleHidden(entityKey('person', p.id)) }}
                      sx={{ p: 0.25, mr: 0.25 }}
                    >
                      {hiddenEntities.has(entityKey('person', p.id))
                        ? <VisibilityOffIcon sx={{ fontSize: 15, color: 'text.disabled' }} />
                        : <VisibilityIcon sx={{ fontSize: 15, color: 'text.secondary' }} />}
                    </IconButton>
                  </Tooltip>
                )}
                <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: placedPersonIds.has(p.id) ? 'success.main' : 'action.disabled', flexShrink: 0 }} />
              </ListItemButton>
            ))}
          </List>
          </CollapsibleSection>

          <CollapsibleSection storageKey="vehicles" title="Vehicles" count={vehicles.length} defaultHeight={220}>
          {vehicles.length === 0 && <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>No vehicles added yet</Typography>}
          <List dense disablePadding>
            {vehicles.map(v => (
              <ListItemButton
                key={v.id}
                disableGutters
                sx={{ py: 0.5, borderBottom: 1, borderColor: 'divider' }}
                disabled={!placedVehicleIds.has(v.id)}
                onClick={() => {
                  const marker = markers.find(m => m.entity_type === 'vehicle' && m.entity_id === v.id)
                  if (marker && hasCoords(marker) && mapInstance.current) {
                    const key = entityKey('vehicle', v.id)
                    if (hiddenEntities.has(key)) toggleHidden(key)
                    mapInstance.current.setView([marker.lat, marker.lng], 17, { animate: true })
                    leafletMarkers.current[marker.id]?.openPopup()
                  }
                }}
              >
                <ListItemAvatar sx={{ minWidth: 34 }}>
                  <Box sx={{ width: 26, height: 26, borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: v.team_color ? v.team_color + '20' : 'action.selected', fontSize: 13 }}>
                    {v.type === 'motorcycle' ? '🏍' : '🚗'}
                  </Box>
                </ListItemAvatar>
                <ListItemText
                  primary={`${v.make} ${v.model}`}
                  secondary={v.license_plate || '—'}
                  primaryTypographyProps={{ fontSize: 12, fontWeight: 500, noWrap: true }}
                  secondaryTypographyProps={{ fontSize: 10 }}
                />
                {placedVehicleIds.has(v.id) && (
                  <Tooltip title={hiddenEntities.has(entityKey('vehicle', v.id)) ? 'Show on map' : 'Hide from map'}>
                    <IconButton
                      size="small"
                      onClick={(e) => { e.stopPropagation(); toggleHidden(entityKey('vehicle', v.id)) }}
                      sx={{ p: 0.25, mr: 0.25 }}
                    >
                      {hiddenEntities.has(entityKey('vehicle', v.id))
                        ? <VisibilityOffIcon sx={{ fontSize: 15, color: 'text.disabled' }} />
                        : <VisibilityIcon sx={{ fontSize: 15, color: 'text.secondary' }} />}
                    </IconButton>
                  </Tooltip>
                )}
                <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: placedVehicleIds.has(v.id) ? 'success.main' : 'action.disabled', flexShrink: 0 }} />
              </ListItemButton>
            ))}
          </List>
          </CollapsibleSection>

          {miscMarkers.length > 0 && (
            <CollapsibleSection storageKey="poi" title="Points of interest" count={miscMarkers.length} defaultHeight={180}>
              <List dense disablePadding>
                {miscMarkers.map(m => (
                  <ListItemButton
                    key={m.id}
                    disableGutters
                    sx={{ py: 0.5, borderBottom: 1, borderColor: 'divider' }}
                    disabled={!hasCoords(m)}
                    onClick={() => {
                      if (hasCoords(m) && mapInstance.current) {
                        mapInstance.current.setView([m.lat, m.lng], 17, { animate: true })
                        leafletMarkers.current[m.id]?.openPopup()
                      }
                    }}
                  >
                    <Box sx={{ width: 26, height: 26, borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: (m.color || m.team_color || '#2e7dd7') + '20', fontSize: 13, flexShrink: 0 }}>ℹ️</Box>
                    <Box sx={{ flex: 1, minWidth: 0, ml: 1 }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</Typography>
                      <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>Point of interest</Typography>
                    </Box>
                  </ListItemButton>
                ))}
              </List>
            </CollapsibleSection>
          )}
        </Box>

        {/* LEGEND — clickable teams */}
        <Box sx={{ px: 1.75, py: 1.25, borderTop: 1, borderColor: 'divider', pb: 4 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
            <Typography variant="overline" sx={{ fontSize: 10, fontWeight: 600, color: 'text.secondary' }}>Teams</Typography>
            {highlightedTeam && (
              <Typography onClick={() => setHighlightedTeam(null)} sx={{ fontSize: 9, color: 'text.secondary', cursor: 'pointer' }}>Clear</Typography>
            )}
          </Box>
          {teams.map(t => (
            <Box
              key={t.id}
              onClick={() => toggleTeamHighlight(t.id)}
              sx={{
                display: 'flex', alignItems: 'center', gap: 0.875, fontSize: 10, mb: 0.5,
                color: highlightedTeam === t.id ? t.color : 'text.secondary',
                cursor: 'pointer', px: 0.75, py: 0.375, borderRadius: 1,
                bgcolor: highlightedTeam === t.id ? t.color + '15' : 'transparent',
                border: 1, borderColor: highlightedTeam === t.id ? t.color + '40' : 'transparent',
              }}
            >
              <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: t.color, flexShrink: 0 }} />
              {t.name}
              {highlightedTeam === t.id && <Box component="span" sx={{ ml: 'auto', fontSize: 9 }}>●</Box>}
            </Box>
          ))}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.875, fontSize: 10, color: 'text.secondary', px: 0.75, py: 0.375 }}>
            <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: 'text.disabled', flexShrink: 0 }} />
            Unassigned
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.875, fontSize: 10, color: 'text.secondary', px: 0.75, py: 0.375 }}>
            <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: '#2e7dd7', flexShrink: 0 }} />
            ℹ️ Points of interest
          </Box>
          {teams.length > 0 && (
            <Typography sx={{ fontSize: 9, color: 'text.disabled', mt: 0.75, pt: 0.75, borderTop: 1, borderColor: 'divider' }}>
              Click a team to highlight
            </Typography>
          )}
        </Box>
      </Box>

      {/* MODALS */}
      {showClearConfirm && (
        <ConfirmDialog
          message="This will remove all markers from the map. Persons and vehicles in the database will not be affected."
          onConfirm={clearAll}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}

      {showAddModal && (
        <AddMarkerModal
          persons={persons} vehicles={vehicles}
          pendingLatLng={pendingLatLng}
          onAdd={handleAddMarker}
          onClose={() => { setShowAddModal(false); setPendingLatLng(null) }}
        />
      )}

      {showScreenshot && (
        <ScreenshotModal
          mapInstance={mapInstance.current}
          persons={persons} teams={teams}
          onClose={() => setShowScreenshot(false)}
          onSent={() => { setShowScreenshot(false); showToast('Screenshot sent') }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      <Dialog open={!!selectedMarker} onClose={() => setSelectedMarker(null)} maxWidth="xs" fullWidth>
        {selectedMarker && (
          <>
            <DialogTitle>
              Message {selectedMarker.label}
              <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>{selectedMarker.matrix_id}</Typography>
            </DialogTitle>
            <DialogContent>
              <MessageQuick matrixId={selectedMarker.matrix_id} personName={selectedMarker.label}
                dmRoomId={selectedMarker.dm_room_id} teamName={selectedMarker.team_name} teamRoomId={selectedMarker.team_room_id}
                onSent={() => { setSelectedMarker(null); showToast('Message sent') }}
                onError={(msg) => showToast(msg, 'error')} />
            </DialogContent>
          </>
        )}
      </Dialog>

      {locationMarker && (
        <SendLocationModal
          marker={locationMarker}
          teams={teams}
          onClose={() => setLocationMarker(null)}
          onSent={(count) => { setLocationMarker(null); showToast(`Location sent to ${count} recipient${count > 1 ? 's' : ''}`) }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {ToastEl}
    </Box>
  )
}

// Bug fix (2026-07-27): this used to have no target selection at all —
// api.matrix.send() was called without dm_room_id, so even a person with a
// linked DM room never actually got a real direct message; every "message
// this marker's person" send landed as a tagged message in whichever room
// the widget happens to be running in. Now offers "Direct message" / "Team"
// / "Ops room" (only enabling the options that actually have somewhere to
// go — a linked DM room / the person's team having a linked room), same
// recipient-routing pattern as SendLocationModal.jsx's picker.
function MessageQuick({ matrixId, personName, dmRoomId, teamName, teamRoomId, onSent, onError }) {
  const [msg, setMsg] = useState('')
  const [presets, setPresets] = useState([])
  const [target, setTarget] = useState(dmRoomId ? 'dm' : teamRoomId ? 'team' : 'ops')
  useEffect(() => { api.matrix.presets().then(setPresets).catch(() => {}) }, [])

  async function send() {
    if (!msg.trim()) return
    try {
      if (target === 'dm') {
        await api.matrix.send({ matrix_id: matrixId, person_name: personName, dm_room_id: dmRoomId, body: msg })
      } else if (target === 'team') {
        await api.matrix.broadcast({ team_name: teamName, room_id: teamRoomId, body: msg })
      } else {
        await api.matrix.send({ matrix_id: matrixId, person_name: personName, body: msg })
      }
      onSent()
    } catch (e) { onError ? onError(e.message) : console.error(e) }
  }

  return (
    <Box>
      <Stack direction="row" spacing={0.75} sx={{ mb: 1.25 }}>
        {[
          { key: 'dm', label: 'Direct message', disabled: !dmRoomId, reason: 'No DM room linked for this person yet — messages fall back to the shared room. Link one in Database > Edit person.' },
          { key: 'team', label: 'Team', disabled: !teamRoomId, reason: 'No broadcast room linked for this team yet — link one in Teams > Edit team.' },
          { key: 'ops', label: 'Ops room', disabled: false, reason: '' },
        ].map(t => (
          // Tooltip needs a child that still fires pointer events to show on
          // hover — a disabled <button> blocks them, so the wrapping <span>
          // (a flex item like any other here, disableHoverListener={false}
          // only when actually disabled) is the standard MUI workaround, not
          // an accident. flex: 1 keeps the same equal-width layout the plain
          // fullWidth buttons had before.
          <Tooltip key={t.key} title={t.disabled ? t.reason : ''} disableHoverListener={!t.disabled}>
            <span style={{ flex: 1 }}>
              <Button size="small" fullWidth disabled={t.disabled}
                variant={target === t.key ? 'contained' : 'outlined'}
                onClick={() => setTarget(t.key)}>
                {t.label}
              </Button>
            </span>
          </Tooltip>
        ))}
      </Stack>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
        {presets.map((p, i) => (
          <Chip key={i} size="small" label={p} onClick={() => setMsg(p)} sx={{ fontSize: 10 }} />
        ))}
      </Box>
      <TextField
        multiline minRows={3} fullWidth
        value={msg} onChange={e => setMsg(e.target.value)}
        placeholder="Type a message..."
        sx={{ mb: 1.25 }}
      />
      <DialogActions sx={{ p: 0 }}>
        <Button variant="contained" startIcon={<SendIcon fontSize="small" />} onClick={send}>Send</Button>
      </DialogActions>
    </Box>
  )
}
