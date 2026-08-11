import React, { useState, useEffect, useRef } from 'react'
import {
  Box,
  Card,
  Typography,
  TextField,
  Button,
  IconButton,
  Stack,
  Alert,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Tooltip,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import ShieldIcon from '@mui/icons-material/Shield'
import PushPinIcon from '@mui/icons-material/PushPin'
import DownloadIcon from '@mui/icons-material/Download'
import UploadIcon from '@mui/icons-material/Upload'
import SaveAltIcon from '@mui/icons-material/SaveAlt'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import BugReportIcon from '@mui/icons-material/BugReport'
import { api } from '../api'
import { useToast } from '../components/useToast.jsx'
import { getRoomId, setFloating } from '../widget.js'
import { getCurrentRoomName } from '../matrixStore.js'
import { isEncryptionReady } from '../roomCrypto.js'
import { copyDiagnosticsToClipboard, sendDiagnosticsToRoom, getDiagnosticsBundle } from '../diagnostics.js'

// Migrated (2026-07-20) to MUI as part of the @matrix-widget-toolkit
// adoption — see main.jsx/widget.js/matrixStore.js for the data-layer half.
// All api.js/widget.js calls unchanged; only the rendered chrome is MUI now.
const FLOAT_STORAGE_KEY = 'crewboard-float-enabled'

const ALL_COUNTRIES = [
  'Afghanistan','Albania','Algeria','Andorra','Angola','Argentina','Armenia','Australia',
  'Austria','Azerbaijan','Bahrain','Bangladesh','Belarus','Belgium','Belize','Benin',
  'Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria',
  'Burkina Faso','Burundi','Cambodia','Cameroon','Canada','Cape Verde','Chad','Chile',
  'China','Colombia','Comoros','Congo','Costa Rica','Croatia','Cuba','Cyprus',
  'Czech Republic','Denmark','Djibouti','Dominican Republic','Ecuador','Egypt',
  'El Salvador','Estonia','Ethiopia','Fiji','Finland','France','Gabon','Gambia',
  'Georgia','Germany','Ghana','Greece','Guatemala','Guinea','Haiti','Honduras',
  'Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy',
  'Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kosovo','Kuwait','Kyrgyzstan',
  'Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Lithuania','Luxembourg',
  'Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Mauritania','Mauritius',
  'Mexico','Moldova','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia',
  'Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Macedonia',
  'Norway','Oman','Pakistan','Palestine','Panama','Paraguay','Peru','Philippines',
  'Poland','Portugal','Qatar','Romania','Russia','Rwanda','Saudi Arabia','Senegal',
  'Serbia','Sierra Leone','Singapore','Slovakia','Slovenia','Somalia','South Africa',
  'South Korea','South Sudan','Spain','Sri Lanka','Sudan','Sweden','Switzerland',
  'Syria','Taiwan','Tajikistan','Tanzania','Thailand','Togo','Tunisia','Turkey',
  'Turkmenistan','Uganda','Ukraine','UAE','United Kingdom','United States','Uruguay',
  'Uzbekistan','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'
]

// Presets editor — backed by org.crewboard.preset room state
function PresetsEditor() {
  const [presets, setPresets] = useState([])
  const [newPreset, setNewPreset] = useState('')
  const presetsRef = useRef([])

  useEffect(() => {
    api.matrix.presets().then(p => {
      setPresets(p)
      presetsRef.current = p
    }).catch(() => {})
  }, [])

  async function save(updated) {
    presetsRef.current = updated
    try { await api.matrix.updatePresets(updated) } catch {}
  }

  async function addPreset() {
    if (!newPreset.trim()) return
    const updated = [...presetsRef.current, newPreset.trim()]
    setPresets(updated)
    setNewPreset('')
    await save(updated)
  }

  async function removePreset(i) {
    const updated = presetsRef.current.filter((_, idx) => idx !== i)
    setPresets(updated)
    await save(updated)
  }

  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      {presets.map((p, i) => (
        <PresetRow key={i} index={i} value={p} presetsRef={presetsRef} onRemove={() => removePreset(i)} onSave={save} />
      ))}
      <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
        <TextField
          size="small" fullWidth
          value={newPreset}
          onChange={e => setNewPreset(e.target.value)}
          placeholder="Add new preset message..."
          onKeyDown={e => e.key === 'Enter' && addPreset()}
        />
        <Button variant="contained" startIcon={<AddIcon fontSize="small" />} onClick={addPreset} disabled={!newPreset.trim()}>Add</Button>
      </Stack>
    </Box>
  )
}

function PresetRow({ index, value, presetsRef, onRemove, onSave }) {
  const inputRef = useRef(null)

  function handleBlur() {
    const val = inputRef.current?.value ?? ''
    const updated = presetsRef.current.map((v, i) => i === index ? val : v)
    onSave(updated)
  }

  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ py: 0.625, borderBottom: 1, borderColor: 'divider' }}>
      <TextField inputRef={inputRef} defaultValue={value} onBlur={handleBlur} size="small" fullWidth variant="standard" />
      <IconButton size="small" color="error" onClick={onRemove}><DeleteIcon fontSize="small" /></IconButton>
    </Stack>
  )
}

// ── Export / import this room's data ────────────────────────────────────────
// Backs api.backup.* (backend/src/routes/backup.js). Both directions are
// admin-only server-side; `canWrite` here only decides whether to show the
// controls as enabled, the backend enforces it regardless.
//
// Worth being blunt in the UI about what an export actually contains: the
// file has phone numbers, Matrix IDs, license plates and marker notes in
// PLAINTEXT — every field the backend otherwise bothers to encrypt at rest.
// It's a normal thing to want, but it shouldn't be silently treated as
// harmless.
function BackupSection({ canWrite, showToast }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [pendingImport, setPendingImport] = useState(null) // parsed JSON awaiting mode choice

  async function handleExport() {
    setBusy(true)
    try {
      const data = await api.backup.export()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      a.href = url
      a.download = `crewboard-backup-${stamp}.json`
      a.click()
      URL.revokeObjectURL(url)
      const counts = `${data.markers?.length ?? 0} markers, ${data.persons?.length ?? 0} persons, ${data.teams?.length ?? 0} teams, ${data.vehicles?.length ?? 0} vehicles`
      showToast(`Exported ${counts}`)
    } catch (e) {
      showToast(`Export failed: ${e.message}`, 'error')
    } finally { setBusy(false) }
  }

  function handleFilePicked(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        setPendingImport(JSON.parse(reader.result))
      } catch {
        showToast("That file isn't valid JSON", 'error')
      }
    }
    reader.readAsText(file)
    // Reset so picking the same file twice in a row still fires onChange.
    if (fileRef.current) fileRef.current.value = ''
  }

  async function runImport(mode) {
    const data = pendingImport
    setPendingImport(null)
    setBusy(true)
    try {
      const result = await api.backup.import(data, mode)
      const c = result.imported || {}
      showToast(`Imported ${c.markers ?? 0} markers, ${c.persons ?? 0} persons, ${c.teams ?? 0} teams, ${c.vehicles ?? 0} vehicles`)
      // Everything on screen is now stale — the SSE stream will push
      // updates, but a hard refresh of the views is the simplest way to be
      // certain nothing is showing pre-import state.
      window.dispatchEvent(new CustomEvent('crewboard:markers-updated'))
      window.dispatchEvent(new CustomEvent('crewboard:persons-updated'))
      window.dispatchEvent(new CustomEvent('crewboard:vehicles-updated'))
      window.dispatchEvent(new CustomEvent('crewboard:rooms-updated'))
    } catch (e) {
      showToast(`Import failed: ${e.message}`, 'error')
    } finally { setBusy(false) }
  }

  return (
    <>
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1.5 }}>
          Markers, persons, teams and vehicles for <strong>this room only</strong>, as a single JSON file.
        </Typography>
        <Alert severity="warning" sx={{ mb: 1.5, fontSize: 11, py: 0.25 }}>
          An export contains phone numbers, Matrix IDs, license plates and marker notes in plaintext —
          everything that's otherwise encrypted at rest. Store the file accordingly.
        </Alert>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined" size="small" startIcon={<SaveAltIcon fontSize="small" />}
            onClick={handleExport} disabled={!canWrite || busy}
          >
            Export JSON
          </Button>
          <Button
            variant="outlined" size="small" startIcon={<UploadIcon fontSize="small" />}
            onClick={() => fileRef.current?.click()} disabled={!canWrite || busy}
          >
            Import JSON
          </Button>
          <input
            ref={fileRef} type="file" accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={e => handleFilePicked(e.target.files?.[0])}
          />
        </Stack>
        {!canWrite && (
          <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 1 }}>
            Export and import need moderator or admin power level in this room.
          </Typography>
        )}
      </Box>

      <Dialog open={!!pendingImport} onClose={() => setPendingImport(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Import backup</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 13, mb: 1.5 }}>
            This file has {pendingImport?.markers?.length ?? 0} markers,{' '}
            {pendingImport?.persons?.length ?? 0} persons, {pendingImport?.teams?.length ?? 0} teams
            and {pendingImport?.vehicles?.length ?? 0} vehicles.
          </DialogContentText>
          <DialogContentText sx={{ fontSize: 12, color: 'text.secondary' }}>
            <strong>Replace</strong> deletes everything currently in this room first, then restores the
            file exactly as it was. <strong>Merge</strong> keeps what's here and adds the file's records
            alongside under new IDs.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingImport(null)}>Cancel</Button>
          <Button onClick={() => runImport('merge')}>Merge</Button>
          <Button color="error" variant="contained" onClick={() => runImport('replace')}>Replace all</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

// ── Troubleshooting diagnostics (2026-08-04) ────────────────────────────────
// See diagnostics.js's header comment for the full design writeup. Copy
// works for anyone (clipboard only, nothing leaves the browser); Send posts
// the same content into the room as a normal message so an admin watching
// via MatrixHub/Element sees it without the reporter needing to paste
// anything anywhere themselves.
function DiagnosticsSection({ showToast }) {
  const [sending, setSending] = useState(false)
  const [copying, setCopying] = useState(false)
  const lineCount = getDiagnosticsBundle().logs.length

  async function handleCopy() {
    setCopying(true)
    try {
      await copyDiagnosticsToClipboard()
      showToast('Diagnostics copied to clipboard')
    } catch (e) {
      showToast(`Couldn't copy: ${e.message}`, 'error')
    } finally { setCopying(false) }
  }

  async function handleSend() {
    setSending(true)
    try {
      await sendDiagnosticsToRoom()
      showToast('Diagnostics sent to this room')
    } catch (e) {
      showToast(`Couldn't send: ${e.message}`, 'error')
    } finally { setSending(false) }
  }

  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1.5 }}>
        Captures recent console output plus basic environment info (browser, room, UI mode) from
        this browser tab only — useful when reporting a problem. "Send" posts it into this room as
        a normal message, same as any other chat message (Megolm-encrypted if the room is
        encrypted, same as everything else here).
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          variant="outlined" size="small" startIcon={<ContentCopyIcon fontSize="small" />}
          onClick={handleCopy} disabled={copying}
        >
          Copy diagnostics
        </Button>
        <Button
          variant="outlined" size="small" startIcon={<BugReportIcon fontSize="small" />}
          onClick={handleSend} disabled={sending}
        >
          Send to this room
        </Button>
        <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{lineCount} log lines captured</Typography>
      </Stack>
    </Box>
  )
}

function Section({ title, children }) {
  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <Box sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="overline" sx={{ fontSize: 10, fontWeight: 600, color: 'text.secondary' }}>{title}</Typography>
      </Box>
      {children}
    </Card>
  )
}

function Row({ label, desc, children }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', gap: 2 }}>
      <Box>
        <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{label}</Typography>
        {desc && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>{desc}</Typography>}
      </Box>
      <Box sx={{ flexShrink: 0 }}>{children}</Box>
    </Box>
  )
}

export default function Settings() {
  const [settings, setSettings] = useState({})
  const [floating, setFloatingUi] = useState(() => localStorage.getItem(FLOAT_STORAGE_KEY) === '1')
  // Defaults to canWrite:true so the UI isn't disabled during the initial
  // fetch (or if /whoami fails on an older backend) — the server rejects
  // unauthorized writes regardless, so an optimistic default only ever
  // costs a clear error message, never a bypass.
  const [me, setMe] = useState({ can_write: true, power_level: null })
  // Room DISPLAY name (m.room.name), not the raw !id:server — see
  // getCurrentRoomName()'s header comment. null until it resolves (or if
  // the room genuinely has no name set), in which case the Room row falls
  // back to the id like it always used to.
  const [roomName, setRoomName] = useState(null)
  const { show: showToast, ToastEl } = useToast()
  const captionRef = useRef(null)

  useEffect(() => {
    api.settings.get().then(setSettings).catch(() => {})
    api.whoami().then(setMe).catch(() => {})
    getCurrentRoomName().then(setRoomName).catch(() => {})
  }, [])

  // Restore the floating (picture-in-picture) preference on load — this is
  // per-browser, not shared app data, so it lives in localStorage rather
  // than crewboard-backend. Element's own "always on screen" state doesn't
  // survive a full iframe reload, so this re-asserts it each time the
  // widget starts up if the user had it turned on last time.
  useEffect(() => {
    if (floating) setFloating(true).catch(() => {})
  }, [])

  async function toggleFloating() {
    const next = !floating
    try {
      await setFloating(next)
      setFloatingUi(next)
      localStorage.setItem(FLOAT_STORAGE_KEY, next ? '1' : '0')
      showToast(next ? 'Floating enabled — navigate to another room to see it pop out' : 'Floating disabled')
    } catch (e) {
      showToast(`Couldn't change floating mode: ${e.message}`, 'error')
    }
  }

  async function saveCaption() {
    const val = captionRef.current?.value || ''
    try {
      await api.settings.update({ screenshot_caption: val })
      showToast('Caption saved')
    } catch (e) { showToast(e.message, 'error') }
  }

  async function saveTileCountry(country) {
    try {
      await api.settings.update({ offline_tiles_country: country })
      setSettings(prev => ({ ...prev, offline_tiles_country: country }))
      showToast('Country saved')
    } catch (e) { showToast(e.message, 'error') }
  }

  return (
    <Box sx={{ flex: 1, overflowY: 'auto', p: 3, maxWidth: 640 }}>
      <Typography variant="h6" sx={{ fontSize: 16, fontWeight: 600, mb: 2.5 }}>Settings</Typography>

      {/* MATRIX — informational only; the account, E2EE, and device
          verification all belong to the Element session hosting this
          widget, so there's nothing for CrewBoard to configure here. */}
      <Section title="Matrix">
        <Row label="Room" desc="This widget instance is scoped to a single Matrix room">
          {roomName ? (
            <Tooltip title={getRoomId() || ''}>
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{roomName}</Typography>
            </Tooltip>
          ) : (
            <Typography sx={{ fontSize: 12, color: 'text.secondary', fontFamily: 'monospace' }}>{getRoomId() || '—'}</Typography>
          )}
        </Row>
        <Row label="Account & encryption" desc="Managed by the Element session hosting this widget">
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ fontSize: 12, color: 'success.main' }}>
            <ShieldIcon sx={{ fontSize: 15 }} />
            Native Element E2EE
          </Stack>
        </Row>
        <Row
          label="Your access"
          desc="Markers, persons, teams and vehicles can only be edited by moderators and admins of this room"
        >
          <Chip
            size="small"
            label={
              me.power_level == null
                ? '—'
                : me.can_write
                  ? `Can edit (PL ${me.power_level})`
                  : `Read-only (PL ${me.power_level})`
            }
            color={me.can_write ? 'success' : 'default'}
            variant="outlined"
            sx={{ fontSize: 11 }}
          />
        </Row>
        <Row
          label="Data encryption"
          desc="Contact details, license plates and notes are encrypted with a key only room members hold — published as an encrypted message in this room and never seen by the server. Losing all members' Matrix keys means losing this data; keep a JSON export (below) as backup."
        >
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ fontSize: 12, color: isEncryptionReady() ? 'success.main' : 'text.secondary' }}>
            <ShieldIcon sx={{ fontSize: 15 }} />
            {isEncryptionReady() ? 'Room-member encrypted' : 'Key not loaded'}
          </Stack>
        </Row>
        <Row label="Device verification" desc="Verify devices from Element's own room member list / settings">
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>Not managed by CrewBoard</Typography>
        </Row>
        <Row
          label="Float this widget"
          desc="Keep CrewBoard visible as a small floating window when you switch to another room in Element — same mechanism call widgets use. Requires Element to grant the request the first time."
        >
          <Button
            size="small"
            variant={floating ? 'contained' : 'outlined'}
            startIcon={<PushPinIcon fontSize="small" />}
            onClick={toggleFloating}
          >
            {floating ? 'Floating on' : 'Float widget'}
          </Button>
        </Row>
      </Section>

      {/* BACKUP */}
      <Section title="Export / Import">
        <BackupSection canWrite={me.can_write} showToast={showToast} />
      </Section>

      {/* PRESETS */}
      <Section title="Quick Message Presets">
        <PresetsEditor />
      </Section>

      {/* SCREENSHOT CAPTION */}
      <Section title="Screenshot Caption">
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1 }}>
            Default caption sent with every map screenshot.
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              key="caption"
              inputRef={captionRef}
              defaultValue={settings.screenshot_caption || 'Current crew distribution'}
              placeholder="e.g. Current crew distribution"
              size="small" fullWidth
            />
            <Button variant="contained" onClick={saveCaption} sx={{ flexShrink: 0 }}>Save</Button>
          </Stack>
        </Box>
      </Section>

      {/* MAP TILES */}
      <Section title="Map Tiles">
        <Row label="Online tiles" desc="Live OpenStreetMap — active when connected">
          <Stack direction="row" alignItems="center" spacing={0.625} sx={{ fontSize: 12, color: 'success.main' }}>
            <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'success.main' }} />
            Always active
          </Stack>
        </Row>
        <Row label="Offline tile pack" desc="Auto-used when internet is unavailable">
          <Stack direction="row" spacing={1} alignItems="center">
            {/* Native select (2026-08-10) — MUI's default Popper-based Menu
                renders no visible items inside this widget's iframe (see
                Database.jsx's PersonModal Team field for the full
                explanation). */}
            <TextField select size="small" sx={{ width: 160 }}
              value={settings.offline_tiles_country || 'Bahrain'}
              onChange={e => saveTileCountry(e.target.value)} SelectProps={{ native: true }}>
              {ALL_COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
            </TextField>
            <Button variant="contained" size="small" startIcon={<DownloadIcon fontSize="small" />}
              onClick={() => showToast('Tile download requires tile server setup — see README')}>
              Download
            </Button>
          </Stack>
        </Row>
        <Row label="Pack status" desc={settings.offline_tiles_country || 'Bahrain'}>
          <Typography sx={{ fontSize: 12, color: settings.offline_tiles_downloaded === '1' ? 'success.main' : 'text.secondary' }}>
            {settings.offline_tiles_downloaded === '1' ? '✓ Downloaded' : 'Not downloaded'}
          </Typography>
        </Row>
      </Section>

      {/* DIAGNOSTICS */}
      <Section title="Troubleshooting">
        <DiagnosticsSection showToast={showToast} />
      </Section>

      {/* ABOUT */}
      <Section title="About">
        <Row label="Application" desc="Field crew management and dispatch tool — Matrix Element Web Widget">
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>CrewBoard</Typography>
        </Row>
        <Row label="Version" desc="">
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>v2.0.0</Typography>
        </Row>
        <Row label="Transport" desc="">
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Matrix Widget API · @matrix-widget-toolkit/api</Typography>
        </Row>
      </Section>

      {ToastEl}
    </Box>
  )
}
