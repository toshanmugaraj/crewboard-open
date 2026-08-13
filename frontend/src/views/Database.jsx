import React, { useState, useEffect, useRef } from 'react'
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  IconButton,
  Chip,
  Avatar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
  Alert,
  Snackbar,
  CircularProgress,
  LinearProgress,
  Checkbox,
  List,
  ListItemButton,
  ListItemAvatar,
  ListItemText,
  InputAdornment,
  Tooltip,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import SendIcon from '@mui/icons-material/Send'
import ForumIcon from '@mui/icons-material/Forum'
import CheckIcon from '@mui/icons-material/Check'
import CameraAltIcon from '@mui/icons-material/CameraAlt'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import PersonIcon from '@mui/icons-material/Person'
import DirectionsCarIcon from '@mui/icons-material/DirectionsCar'
import LinkOffIcon from '@mui/icons-material/LinkOff'
import { api } from '../api'
import { useToast } from '../components/useToast.jsx'
import { useConfirm } from '../components/useConfirm.jsx'
import { roomMatrixToUri, userMatrixToUri } from '../widget.js'
import { navigateTo } from '../matrixStore.js'
import MxcAvatar from '../components/MxcAvatar'

// Migrated (2026-07-20) to MUI as part of the @matrix-widget-toolkit
// adoption — see main.jsx/widget.js/matrixStore.js for the data-layer half.
// All api.js calls and event wiring unchanged; only the rendered chrome
// (modals, forms, lists) is MUI now.

// ── Photo Upload Component ─────────────────────────────────────────────────
// Photos now live in the homeserver's media repo (MXC URIs) instead of the
// old local backend's /image-file endpoint.
function PhotoUpload({ entityType, entityId, currentImageMxc, onUploaded, onError }) {
  const inputRef = useRef(null)
  const [preview, setPreview] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [hover, setHover] = useState(false)

  // api.persons.imageUrl() is async now (2026-07-23) — this homeserver
  // requires an authenticated fetch for media (Matrix v1.11 "authenticated
  // media"; see matrixStore.js's fetchAuthedMediaUrl()), so it can no
  // longer be called directly in a useState initializer. Also covers
  // currentImageMxc changing after mount — e.g. PersonModal's
  // UserDirectorySearch picking a directory result sets the parent's
  // imageMxc state to the Matrix user's own avatar before any file has ever
  // been uploaded through this component.
  useEffect(() => {
    let cancelled = false
    if (!currentImageMxc) { setPreview(null); return }
    api.persons.imageUrl(currentImageMxc)
      .then(url => { if (!cancelled) setPreview(url) })
      .catch(() => { if (!cancelled) setPreview(null) })
    return () => { cancelled = true }
  }, [currentImageMxc])

  async function handleFile(file) {
    if (!file || !entityId) return
    setUploading(true)
    try {
      const uploadFn = entityType === 'person' ? api.persons.uploadImage : api.vehicles.uploadImage
      const { image_mxc } = await uploadFn(entityId, file)
      const url = await api.persons.imageUrl(image_mxc)
      setPreview(url)
      onUploaded && onUploaded(image_mxc)
    } catch (e) { onError ? onError('Upload failed: ' + e.message) : console.error(e) }
    finally { setUploading(false) }
  }

  function handleDrop(e) {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file && file.type.startsWith('image/')) handleFile(file)
  }

  return (
    <Box
      onClick={() => entityId && inputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      sx={{
        width: '100%', height: 140, borderRadius: 1,
        border: '2px dashed', borderColor: 'divider',
        bgcolor: 'action.hover',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: entityId ? 'pointer' : 'not-allowed',
        overflow: 'hidden', position: 'relative', mb: 1.75,
      }}
    >
      {preview ? (
        <>
          <Box component="img" src={preview} alt="Preview" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          {hover && (
            <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Typography sx={{ fontSize: 12, color: '#fff' }}>Click to change photo</Typography>
            </Box>
          )}
        </>
      ) : (
        <Box sx={{ textAlign: 'center', color: 'text.secondary' }}>
          <CameraAltIcon sx={{ fontSize: 28, display: 'block', mx: 'auto', mb: 0.75 }} />
          <Typography sx={{ fontSize: 11 }}>
            {uploading ? 'Uploading...' : entityId ? 'Click or drag photo here' : 'Save record first to add photo'}
          </Typography>
        </Box>
      )}
      <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => handleFile(e.target.files[0])} />
    </Box>
  )
}

// ── Direct Message Modal ──────────────────────────────────────────────────
function DirectMessageModal({ person, onClose, onSent, onError }) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [presets, setPresets] = useState([])

  React.useEffect(() => {
    api.matrix.presets().then(setPresets).catch(() => {})
  }, [])

  async function handleSend() {
    if (!body.trim() || !person.matrix_id) return
    setSending(true)
    try {
      await api.matrix.send({ matrix_id: person.matrix_id, person_name: person.name, dm_room_id: person.dm_room_id, body: body.trim() })
      // Jump the dispatcher straight into the actual chat after sending —
      // only meaningful when there's a real linked DM room to go to; the
      // tagged-ops-room fallback path has nowhere more specific to send
      // them (they're already looking at CrewBoard, not a particular DM).
      if (person.dm_room_id) {
        navigateTo(roomMatrixToUri(person.dm_room_id)).catch(e => console.warn('navigateTo failed (non-fatal):', e.message))
      }
      onSent()
    } catch (e) { onError ? onError(e.message) : console.error(e) }
    setSending(false)
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Message {person.name}
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>
          {person.dm_room_id
            ? 'Private, E2EE direct message'
            : person.matrix_id
              ? 'Posted to the shared ops room, tagged for this person — link a DM room in Edit for a private message'
              : 'No Matrix ID'}
        </Typography>
      </DialogTitle>
      <DialogContent>
        {!person.matrix_id && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>This person has no Matrix ID — add one in the Database first.</Alert>
        )}

        {presets.length > 0 && (
          <Stack direction="row" spacing={0.625} flexWrap="wrap" useFlexGap sx={{ mb: 1.25 }}>
            {presets.map((p, i) => (
              <Chip key={i} size="small" label={p} onClick={() => setBody(p)} />
            ))}
          </Stack>
        )}

        <TextField
          fullWidth multiline minRows={3} autoFocus
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
          placeholder="Type a message... (Enter to send)"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<SendIcon fontSize="small" />} onClick={handleSend} disabled={!body.trim() || !person.matrix_id || sending}>
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ── Send Contact Modal ────────────────────────────────────────────────────
// Bug fix (2026-07-27): this used to have no recipient selection at all —
// always posted into whatever room the widget happens to be running in.
// Now lets the sender pick a specific person (their DM room) or team
// (their broadcast room), same recipient-routing pattern already used by
// ScreenshotModal.jsx's "Send to" picker.
function SendContactModal({ person, persons, teams, onClose, onSent, onError }) {
  const [target, setTarget] = useState('room')
  const [recipientPersonId, setRecipientPersonId] = useState('')
  const [recipientTeamId, setRecipientTeamId] = useState('')
  const [sending, setSending] = useState(false)

  // Don't offer sending someone's own card back to themselves.
  const recipientChoices = persons.filter(p => p.id !== person.id && p.matrix_id)

  async function handleSend() {
    setSending(true)
    try {
      const recipientPerson = target === 'person' ? recipientChoices.find(p => p.id === recipientPersonId) : null
      const recipientTeam = target === 'team' ? teams.find(t => t.id === recipientTeamId) : null
      await api.matrix.sendContact(person, { target, recipientPerson, recipientTeam })
      onSent()
    } catch (e) { onError ? onError(e.message) : console.error(e) } finally { setSending(false) }
  }

  const canSend = target === 'room' || (target === 'person' && recipientPersonId) || (target === 'team' && recipientTeamId)

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Send contact card
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>
          Post {person.name}'s details{person.image_mxc ? ' + photo' : ''}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Paper variant="outlined" sx={{ px: 1.75, py: 1.25, mb: 1.5 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{person.name}</Typography>
          {person.matrix_id && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>🔷 {person.matrix_id}</Typography>}
          {person.phone && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>📞 {person.phone}</Typography>}
          {person.team_name && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>👥 {person.team_name}</Typography>}
          {person.image_mxc && <Typography sx={{ fontSize: 11, color: 'success.main', mt: 0.25 }}>📷 Photo attached</Typography>}
        </Paper>

        <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary', mb: 0.75 }}>Send to</Typography>
        <Stack direction="row" spacing={0.75} sx={{ mb: 1.25 }}>
          {[
            { key: 'room', label: 'This room' },
            { key: 'person', label: 'One person' },
            { key: 'team', label: 'Team' },
          ].map(t => (
            <Button key={t.key} size="small" fullWidth
              variant={target === t.key ? 'contained' : 'outlined'}
              onClick={() => { setTarget(t.key); setRecipientPersonId(''); setRecipientTeamId('') }}>
              {t.label}
            </Button>
          ))}
        </Stack>

        {target === 'person' && (
          <TextField select fullWidth size="small" value={recipientPersonId}
            onChange={e => setRecipientPersonId(e.target.value)} SelectProps={{ native: true }}>
            <option value="">— Select person —</option>
            {recipientChoices.map(p => (
              <option key={p.id} value={p.id}>{p.name} · {p.matrix_id}</option>
            ))}
          </TextField>
        )}
        {target === 'team' && (
          <TextField select fullWidth size="small" value={recipientTeamId}
            onChange={e => setRecipientTeamId(e.target.value)} SelectProps={{ native: true }}>
            <option value="">— Select team —</option>
            {teams.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </TextField>
        )}
        {target === 'room' && (
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            Posts to the room CrewBoard is currently open in.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<SendIcon fontSize="small" />} onClick={handleSend} disabled={sending || !canSend}>
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ── Send Vehicle Modal ────────────────────────────────────────────────────
function SendVehicleModal({ vehicle, onClose, onSent, onError }) {
  const [sending, setSending] = useState(false)

  async function handleSend() {
    setSending(true)
    try {
      await api.matrix.sendVehicleCard(vehicle)
      onSent()
    } catch (e) { onError ? onError(e.message) : console.error(e) } finally { setSending(false) }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Send vehicle details
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>
          Post {vehicle.make} {vehicle.model} details{vehicle.image_mxc ? ' + photo' : ''} to the room
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Paper variant="outlined" sx={{ px: 1.75, py: 1.25 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{vehicle.make} {vehicle.model}</Typography>
          {vehicle.license_plate && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>🪪 {vehicle.license_plate}</Typography>}
          {vehicle.team_name && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>👥 {vehicle.team_name}</Typography>}
          {vehicle.person_name && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>👤 {vehicle.person_name}</Typography>}
          {vehicle.image_mxc && <Typography sx={{ fontSize: 11, color: 'success.main', mt: 0.25 }}>📷 Photo attached</Typography>}
        </Paper>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<SendIcon fontSize="small" />} onClick={handleSend} disabled={sending}>
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// Search-as-you-type against the homeserver's user directory (MSC3973),
// used by PersonModal below to fill in name/Matrix ID/avatar from a picked
// result instead of typing them by hand. Debounced, and silently disables
// itself (falls back to the plain manual fields, which stay usable either
// way) if the widget host or homeserver doesn't support MSC3973 — see
// api.js's searchUsers()/matrixStore.js's searchUserDirectory().
function UserDirectorySearch({ onPick }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const debounceRef = useRef(null)

  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (unsupported || query.trim().length < 2) { setResults([]); setOpen(false); return }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await api.matrix.searchUsers(query.trim(), 8)
        setResults(r)
        setOpen(true)
      } catch (e) {
        // Not supported by this Element version/homeserver — stop trying
        // for the rest of this modal's lifetime rather than re-throwing on
        // every keystroke.
        setUnsupported(true)
        setResults([])
        setOpen(false)
      } finally { setLoading(false) }
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [query, unsupported])

  if (unsupported) return null

  return (
    <Box sx={{ position: 'relative', mb: 2 }}>
      <TextField
        fullWidth size="small"
        label="Search Matrix directory (optional)"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Type a name or Matrix ID to search..."
        InputProps={{
          endAdornment: loading ? (
            <InputAdornment position="end"><CircularProgress size={14} /></InputAdornment>
          ) : undefined,
        }}
      />
      {open && results.length > 0 && (
        <Paper elevation={4} sx={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, mt: 0.5, maxHeight: 220, overflowY: 'auto' }}>
          <List dense disablePadding>
            {results.map(r => (
              <ListItemButton key={r.user_id} divider onClick={() => { onPick(r); setQuery(''); setResults([]); setOpen(false) }}>
                <ListItemAvatar sx={{ minWidth: 34 }}>
                  {r.avatar_url ? (
                    <MxcAvatar mxc={r.avatar_url} fetchFn={api.matrix.userAvatarUrl} sx={{ width: 26, height: 26 }}>
                      {(r.display_name || r.user_id).slice(0, 2).toUpperCase()}
                    </MxcAvatar>
                  ) : (
                    <Avatar sx={{ width: 26, height: 26, fontSize: 10 }}>{(r.display_name || r.user_id).slice(0, 2).toUpperCase()}</Avatar>
                  )}
                </ListItemAvatar>
                <ListItemText
                  primary={r.display_name}
                  secondary={r.user_id}
                  primaryTypographyProps={{ fontSize: 12, fontWeight: 500, noWrap: true }}
                  secondaryTypographyProps={{ fontSize: 10, noWrap: true }}
                />
              </ListItemButton>
            ))}
          </List>
        </Paper>
      )}
      {open && results.length === 0 && !loading && (
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>No matches</Typography>
      )}
    </Box>
  )
}

// ── Person Modal ──────────────────────────────────────────────────────────
function PersonModal({ person, teams, vehicles, onSave, onClose, onError }) {
  const [name, setName] = useState(person?.name || '')
  const [phone, setPhone] = useState(person?.phone || '')
  const [matrixId, setMatrixId] = useState(person?.matrix_id || '')
  const [dmRoomId, setDmRoomId] = useState(person?.dm_room_id || '')
  // Team assignment (2026-08-10): a plain manual field again, not derived
  // from Matrix room membership — see CHANGES.md "Decouple team roster from
  // room membership" for why. `''` means Unassigned (matches team_id: null).
  const [teamId, setTeamId] = useState(person?.team_id ? String(person.team_id) : '')
  const [savedId, setSavedId] = useState(person?.id || null)
  const [imageMxc, setImageMxc] = useState(person?.image_mxc || null)
  const [detectingDm, setDetectingDm] = useState(false)
  // Our own verified user id, needed to recognise a DM room (a room whose only
  // members are us + the person). Fetched once from the backend's whoami since
  // the widget's own user id isn't reliably in the URL params (see
  // matrixStore.js's findDmRoom).
  const [selfUserId, setSelfUserId] = useState(null)
  useEffect(() => {
    api.whoami().then(me => setSelfUserId(me.user_id)).catch(() => {})
  }, [])

  // Read-only — a vehicle is linked to a person from the Vehicle form (its
  // person_id), not the other way around, so this is purely informational:
  // whichever vehicle (if any) currently has vehicle.person_id === this
  // person's id.
  const assignedVehicle = person?.id
    ? (vehicles || []).find(v => String(v.person_id) === String(person.id))
    : null

  // Looks for an already-existing 1:1 DM room with `targetId` and fills the DM
  // room field if found. Best-effort — the Widget API can't create/invite, so
  // if there's no existing DM the dispatcher still has to start one in Element
  // (the "Start chat in Element" button) and re-run this. `silent` suppresses
  // the "no DM found" notice for the automatic on-pick attempt.
  async function detectDmRoom(targetId, { silent = false } = {}) {
    if (!targetId) return
    setDetectingDm(true)
    try {
      const roomId = await api.matrix.findDmRoom(targetId, selfUserId)
      if (roomId) setDmRoomId(roomId)
      else if (!silent) onError?.('No existing 1:1 room found with this user — start a chat in Element, then detect again.')
    } catch (e) {
      if (!silent) onError?.(e.message)
    } finally {
      setDetectingDm(false)
    }
  }

  // Populates name/Matrix ID/avatar from a picked directory result. Doesn't
  // overwrite a name the user already typed by hand, since search is meant
  // to fill the form in, not clobber manual edits made before searching.
  //
  // The avatar_url MSC3973 returns is already an mxc:// URI on this same
  // homeserver — no re-upload needed, it's usable as-is via the same
  // media-repo download path api.persons.imageUrl()/mxcToHttp() use for
  // any other image_mxc. Setting it here only updates local state, though
  // — see handleSave() below for why it also needs to go in the save
  // payload directly for a brand-new person.
  //
  // Also kicks off a best-effort existing-DM lookup (only if the DM field is
  // still empty, so it never clobbers a manually-entered room id), silently —
  // finding nothing is the common case and shouldn't nag.
  function applyDirectoryResult(r) {
    if (!name.trim()) setName(r.display_name)
    setMatrixId(r.user_id)
    if (r.avatar_url) setImageMxc(r.avatar_url)
    if (!dmRoomId.trim()) detectDmRoom(r.user_id, { silent: true })
  }

  async function handleSave() {
    if (!name.trim()) return
    try {
      // image_mxc included here (not just left to PhotoUpload's own
      // upload-triggered api.persons.uploadImage() call) because that path
      // requires an existing person id — for a brand-new person picked
      // from the directory search, this save is the ONLY place their
      // avatar_url-derived image_mxc ever reaches the backend.
      // team_id (2026-08-10): a plain manual field, picked directly from the
      // Team dropdown — no longer derived from Matrix room membership.
      const team_id = teamId || null
      const data = { name, phone: phone || null, matrix_id: matrixId || null, dm_room_id: dmRoomId.trim() || null, team_id, image_mxc: imageMxc || null }
      let result
      if (person?.id) {
        result = await api.persons.update(person.id, data)
      } else {
        result = await api.persons.create(data)
        setSavedId(result.id)
      }
      // Pass the before/after team_id along (2026-08-10) so the caller can
      // detect a reassignment and remind the admin that broadcast-room
      // membership doesn't move automatically — see Database()'s onSave.
      onSave({ oldTeamId: person?.team_id || null, newTeamId: team_id })
    } catch (e) { onError ? onError(e.message) : console.error(e) }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {person ? 'Edit person' : 'Add person'}
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>
          {person ? `Editing ${person.name}` : 'Add to your crew database'}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <PhotoUpload
          entityType="person"
          entityId={savedId}
          currentImageMxc={imageMxc}
          onUploaded={(mxc) => setImageMxc(mxc)}
          onError={onError}
        />

        <UserDirectorySearch onPick={applyDirectoryResult} />

        <Stack spacing={2}>
          <TextField label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="Ahmed Khalil" fullWidth size="small" />
          <TextField label="Matrix ID" value={matrixId} onChange={e => setMatrixId(e.target.value)} placeholder="@ahmed:yourcompany.com" fullWidth size="small" inputProps={{ dir: 'ltr' }} />
          <TextField label="Phone number (optional)" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+973 3600 0001" fullWidth size="small" inputProps={{ dir: 'ltr' }} />

          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 500, mb: 0.5 }}>DM room (optional)</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 0.75 }}>
              Link a private, E2EE Matrix room for direct messages with this
              person. If you already have a 1:1 chat with them it's detected
              automatically; otherwise start one in Element, then Detect.
            </Typography>
            <Stack direction="row" spacing={0.75}>
              <TextField value={dmRoomId} onChange={e => setDmRoomId(e.target.value)} placeholder="!abc123:example.org" size="small" fullWidth
                InputProps={{
                  sx: { fontFamily: 'monospace', fontSize: 12 },
                  endAdornment: detectingDm ? (
                    <InputAdornment position="end"><CircularProgress size={14} /></InputAdornment>
                  ) : undefined,
                }}
                inputProps={{ dir: 'ltr' }} />
              {dmRoomId.trim() ? (
                <Button size="small" variant="outlined" startIcon={<OpenInNewIcon fontSize="small" />} sx={{ whiteSpace: 'nowrap' }}
                  onClick={() => navigateTo(roomMatrixToUri(dmRoomId.trim())).catch(e => onError?.(e.message))}>
                  Open in Element
                </Button>
              ) : matrixId.trim() ? (
                <>
                  <Button size="small" variant="outlined" disabled={detectingDm} sx={{ whiteSpace: 'nowrap' }}
                    onClick={() => detectDmRoom(matrixId.trim())}>
                    Detect
                  </Button>
                  <Button size="small" variant="outlined" startIcon={<ForumIcon fontSize="small" />} sx={{ whiteSpace: 'nowrap' }}
                    onClick={() => navigateTo(userMatrixToUri(matrixId.trim())).catch(e => onError?.(e.message))}>
                    Start chat
                  </Button>
                </>
              ) : null}
            </Stack>
          </Box>

          {/* Team (2026-08-10): a plain manual assignment again — persons.team_id
              is the only source of truth, not Matrix room membership. See
              CHANGES.md "Decouple team roster from room membership".
              Native select (SelectProps={{ native: true }}) — same fix as
              SendContactModal's recipient pickers below: MUI's default
              Popper-based Menu opens (the field shows focused/expanded) but
              renders no visible items inside this widget's iframe, most
              likely the app's own `overflow: hidden` on html/body (index.css,
              deliberate for the widget's own fixed-chrome layout)
              interfering with the portaled popup's positioning. A native
              select is rendered by the browser itself, immune to that.
              Trade-off: plain text options only, no colored team-dot. */}
          {/* InputLabelProps shrink (2026-08-10): a native select with an
              empty-string value ("Unassigned") doesn't trip MUI's automatic
              label-shrink detection the way a filled text field would, so
              the floating "Team" label sat overlapping the selected option
              text instead of moving up to the outline notch. Force it. */}
          <TextField select label="Team" fullWidth size="small" value={teamId}
            onChange={e => setTeamId(e.target.value)} SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
            <option value="">Unassigned</option>
            {teams.length === 0 && (
              <option value="__no_teams__" disabled>No teams yet — create one in Teams</option>
            )}
            {teams.map(t => (
              // Fallback to the raw id (2026-08-10) rather than a silently
              // blank option — if a team's name ever fails to decrypt (e.g.
              // read before the E2EE keyring key is ready, see
              // roomCrypto.js's decryptValue()) this makes that obvious
              // instead of looking like an empty option.
              <option key={t.id} value={String(t.id)}>{t.name || `(unnamed team ${t.id})`}</option>
            ))}
          </TextField>

          {/* Read-only — linked from the Vehicle form's own "Assigned to
              person" field, not editable here. */}
          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 500, mb: 0.5 }}>Assigned vehicle</Typography>
            {!person?.id ? (
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                Save this person first, then assign a vehicle to them from the Vehicle form.
              </Typography>
            ) : assignedVehicle ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <DirectionsCarIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                <Typography sx={{ fontSize: 12 }}>
                  {assignedVehicle.make} {assignedVehicle.model}
                  {assignedVehicle.license_plate ? ` · ${assignedVehicle.license_plate}` : ''}
                </Typography>
              </Stack>
            ) : (
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                No vehicle assigned — assign one to them from the Vehicle form.
              </Typography>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<CheckIcon fontSize="small" />} onClick={handleSave} disabled={!name.trim()}>
          {person ? 'Save changes' : 'Add person'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ── Vehicle Modal ─────────────────────────────────────────────────────────
function VehicleModal({ vehicle, teams, persons, onSave, onClose, onError }) {
  const [make, setMake] = useState(vehicle?.make || '')
  const [model, setModel] = useState(vehicle?.model || '')
  const [type, setType] = useState(vehicle?.type || 'car')
  const [plate, setPlate] = useState(vehicle?.license_plate || '')
  const [personId, setPersonId] = useState(vehicle?.person_id || '')
  const [savedId, setSavedId] = useState(vehicle?.id || null)
  const [imageMxc, setImageMxc] = useState(vehicle?.image_mxc || null)

  // Team is not chosen by hand for a vehicle — it's derived from whichever
  // person the vehicle is assigned to (that person's own team, a plain
  // manual field — see PersonModal's Team select). A vehicle with nobody
  // assigned has no team.
  const assignedPerson = personId ? persons.find(p => p.id === personId) : null
  const derivedTeam = assignedPerson?.team_id ? teams.find(t => t.id === assignedPerson.team_id) : null

  async function handleSave() {
    if (!make.trim() || !model.trim()) return
    try {
      const data = {
        make, model, type,
        license_plate: plate || null,
        team_id: derivedTeam ? derivedTeam.id : null,
        person_id: personId || null
      }
      let result
      if (vehicle?.id) {
        result = await api.vehicles.update(vehicle.id, data)
      } else {
        result = await api.vehicles.create(data)
        setSavedId(result.id)
      }
      onSave()
    } catch (e) { onError ? onError(e.message) : console.error(e) }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {vehicle ? 'Edit vehicle' : 'Add vehicle'}
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>
          {vehicle ? `Editing ${vehicle.make} ${vehicle.model}` : 'Add to your fleet database'}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <PhotoUpload
          entityType="vehicle"
          entityId={savedId}
          currentImageMxc={imageMxc}
          onUploaded={(mxc) => setImageMxc(mxc)}
          onError={onError}
        />

        <Stack spacing={2}>
          <Stack direction="row" spacing={1.5}>
            <TextField label="Make" value={make} onChange={e => setMake(e.target.value)} placeholder="Volkswagen" fullWidth size="small" />
            <TextField label="Model" value={model} onChange={e => setModel(e.target.value)} placeholder="Polo" fullWidth size="small" />
          </Stack>

          {/* Native selects (2026-08-10) — same fix as PersonModal's Team
              field above: MUI's default Popper-based Menu renders no visible
              items inside this widget's iframe (see that comment for the
              full explanation). */}
          <Stack direction="row" spacing={1.5}>
            <TextField select label="Type" fullWidth size="small" value={type}
              onChange={e => setType(e.target.value)} SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
              <option value="car">🚗 Car</option>
              <option value="motorcycle">🏍 Motorcycle</option>
            </TextField>
            <TextField label="License plate" value={plate} onChange={e => setPlate(e.target.value)} placeholder="LMN 1234" fullWidth size="small" />
          </Stack>

          {/* InputLabelProps shrink — see the Team field's comment in
              PersonModal above for why this is needed on every native select
              that has a label (an empty-string "— None —" value doesn't trip
              MUI's automatic label-shrink detection). */}
          <TextField select label="Assigned to person (optional)" fullWidth size="small" value={personId}
            onChange={e => setPersonId(e.target.value)} SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
            <option value="">— None —</option>
            {persons.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </TextField>

          {/* Team is read-only here — see derivedTeam above. */}
          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 500, mb: 0.5 }}>Team</Typography>
            {!assignedPerson ? (
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                Assigned automatically from the linked person's team.
                Assign a person above to set it.
              </Typography>
            ) : derivedTeam ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" label={derivedTeam.name}
                  sx={{ bgcolor: (derivedTeam.color || '#888') + '25', color: derivedTeam.color || 'text.primary', fontWeight: 600 }} />
                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>auto, from {assignedPerson.name}'s team</Typography>
              </Stack>
            ) : (
              <Typography sx={{ fontSize: 11, color: 'warning.main' }}>
                {assignedPerson.name} isn't assigned to a team — this vehicle will be Unassigned.
              </Typography>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<CheckIcon fontSize="small" />} onClick={handleSave} disabled={!make.trim() || !model.trim()}>
          {vehicle ? 'Save changes' : 'Add vehicle'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ── Team Broadcast Modal (from the Persons team filter) ─────────────────────
// 2026-08-10: mirrors Teams.jsx's own BroadcastModal (send to team.room_id
// when linked, tagged-ops-room fallback otherwise) so broadcasting works
// directly from the Database screen's team filter without navigating to
// Teams. Kept as a separate copy rather than sharing the component since
// Teams.jsx doesn't export it — same duplication pattern already accepted
// elsewhere in this file (e.g. DirectMessageModal / SendContactModal each
// fetch their own presets independently).
function TeamBroadcastModal({ team, onClose, onSent, onError }) {
  const [msg, setMsg] = useState('')
  const [presets, setPresets] = useState([])
  const [sending, setSending] = useState(false)

  React.useEffect(() => { api.matrix.presets().then(setPresets).catch(() => {}) }, [])

  async function handleSend() {
    if (!msg.trim()) return
    setSending(true)
    try {
      await api.matrix.broadcast({ team_id: team.id, team_name: team.name, room_id: team.room_id, body: msg })
      onSent()
    } catch (e) { onError ? onError(e.message) : console.error(e) } finally { setSending(false) }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Broadcast to {team.name}
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>
          {team.room_id
            ? `Private, E2EE message to ${team.name}'s linked room`
            : `Message will be posted to the shared ops room, tagged for ${team.name} — link a broadcast room in Teams for a private broadcast`}
        </Typography>
      </DialogTitle>
      <DialogContent>
        {presets.length > 0 && (
          <Stack direction="row" spacing={0.625} flexWrap="wrap" useFlexGap sx={{ mb: 1.25 }}>
            {presets.map((p, i) => (
              <Chip key={i} size="small" label={p} onClick={() => setMsg(p)} sx={{ fontSize: 10 }} />
            ))}
          </Stack>
        )}
        <TextField multiline minRows={4} fullWidth autoFocus value={msg} onChange={e => setMsg(e.target.value)} placeholder="Type your message..." />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<ForumIcon fontSize="small" />} onClick={handleSend} disabled={!msg.trim() || sending}
          sx={{ bgcolor: team.color, '&:hover': { bgcolor: team.color } }}>
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ── Bulk Direct Message Modal (multi-select persons) ─────────────────────────
// 2026-08-10: sends the same message into several people's own DM rooms
// individually — NOT a broadcast to a shared room. Only ever targets persons
// with a linked dm_room_id (same rule the per-person DM button already
// enforces — see Database()'s IconButton disabled={!p.dm_room_id}); anyone
// selected without one is counted as "skipped," not silently redirected to
// a tagged-message fallback. Sends sequentially with rate-limit backoff via
// api.matrix.sendBulkDirect() (matrixStore.js's sendRoomEventToRooms —
// Synapse's rc_message limit is per-sender, so blasting everyone's DM at
// once risks M_LIMIT_EXCEEDED partway through), reporting progress via
// onProgress for the progress bar below.
function BulkDirectMessageModal({ persons, onClose, onSent, onError }) {
  const [body, setBody] = useState('')
  const [presets, setPresets] = useState([])
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState(null) // { index, total, name }
  const [result, setResult] = useState(null) // { sent, failed, skipped } once done

  React.useEffect(() => { api.matrix.presets().then(setPresets).catch(() => {}) }, [])

  const targets = persons.filter(p => p.dm_room_id)
  const skippedCount = persons.length - targets.length
  // dm_room_id -> name, for turning sendBulkDirect's per-room progress ticks
  // into a person's name in the UI (sendRoomEventToRooms only knows room
  // ids, not who they belong to).
  const nameByRoom = new Map(targets.map(p => [p.dm_room_id, p.name]))

  async function handleSend() {
    if (!body.trim() || targets.length === 0) return
    setSending(true)
    setProgress({ index: 0, total: targets.length, name: null })
    try {
      const r = await api.matrix.sendBulkDirect({
        persons: targets,
        body: body.trim(),
        onProgress: ({ index, total, roomId }) => setProgress({ index, total, name: nameByRoom.get(roomId) || null }),
      })
      setResult(r)
      if (r.failed.length === 0) onSent(r)
    } catch (e) { onError ? onError(e.message) : console.error(e) } finally { setSending(false) }
  }

  return (
    <Dialog open onClose={sending ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Direct message {persons.length} {persons.length === 1 ? 'person' : 'people'}
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>
          Sends individually into each person's own DM room — {targets.length} of {persons.length} selected have one linked
          {skippedCount > 0 ? ` (${skippedCount} skipped — no DM room linked)` : ''}.
        </Typography>
      </DialogTitle>
      <DialogContent>
        {targets.length === 0 && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>None of the selected people have a DM room linked — nothing to send.</Alert>
        )}

        {!result && presets.length > 0 && (
          <Stack direction="row" spacing={0.625} flexWrap="wrap" useFlexGap sx={{ mb: 1.25 }}>
            {presets.map((p, i) => (
              <Chip key={i} size="small" label={p} onClick={() => setBody(p)} sx={{ fontSize: 10 }} />
            ))}
          </Stack>
        )}

        {!result && (
          <TextField
            fullWidth multiline minRows={3} autoFocus
            value={body} onChange={e => setBody(e.target.value)}
            disabled={sending}
            placeholder="Type a message..."
          />
        )}

        {sending && progress && (
          <Box sx={{ mt: 1.5 }}>
            <LinearProgress variant="determinate" value={(progress.index / progress.total) * 100} />
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>
              {progress.index < progress.total
                ? `Sending ${progress.index + 1} of ${progress.total}${progress.name ? ` — ${progress.name}` : ''}...`
                : `Sent ${progress.total} of ${progress.total}`}
            </Typography>
          </Box>
        )}

        {result && (
          <Alert severity={result.failed.length === 0 ? 'success' : 'warning'} sx={{ mt: 1.5 }}>
            Sent to {result.sent} of {targets.length}.
            {result.failed.length > 0 ? ` ${result.failed.length} failed — see console for details.` : ''}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={sending}>{result ? 'Close' : 'Cancel'}</Button>
        {!result && (
          <Button variant="contained" startIcon={<ForumIcon fontSize="small" />}
            onClick={handleSend} disabled={!body.trim() || sending || targets.length === 0}>
            {sending ? 'Sending...' : `Send to ${targets.length}`}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

// ── Main Database View ────────────────────────────────────────────────────
export default function Database() {
  const [persons, setPersons] = useState([])
  const [vehicles, setVehicles] = useState([])
  const [teams, setTeams] = useState([])
  const [editPerson, setEditPerson] = useState(null)
  const [editVehicle, setEditVehicle] = useState(null)
  const [showNewPerson, setShowNewPerson] = useState(false)
  const [showNewVehicle, setShowNewVehicle] = useState(false)
  const [sendContact, setSendContact] = useState(null)
  const [sendVehicle, setSendVehicle] = useState(null)
  const [directMessage, setDirectMessage] = useState(null)
  const [search, setSearch] = useState('')
  // Team filter for the Persons list (2026-08-10). '' = all teams,
  // '__unassigned__' = persons with no team, otherwise a team id (as a
  // string, matching the native <select>'s option values).
  const [teamFilter, setTeamFilter] = useState('')
  const [broadcastTeam, setBroadcastTeam] = useState(null)
  // Multi-select for bulk direct-messaging (2026-08-10) — a Set of person
  // ids, independent of the team filter/search (selecting someone, then
  // narrowing the filter, doesn't silently drop them from the selection).
  const [selectedPersonIds, setSelectedPersonIds] = useState(new Set())
  const [bulkDirectMessage, setBulkDirectMessage] = useState(null)
  // Reminder shown after a delete/reassign that may have left broadcast-room
  // membership out of sync (2026-08-10) — see CHANGES.md. Shape:
  // { message, actions: [{ label, room_id }] }. There's no automatic fix
  // (the widget can't manage room membership at all — see CLAUDE.md), so
  // this is just a one-click way to jump to Element and handle it by hand.
  const [membershipReminder, setMembershipReminder] = useState(null)
  const { show: showToast, ToastEl } = useToast()
  const { confirm, ConfirmEl } = useConfirm()

  async function load() {
    try {
      const [p, v, t] = await Promise.all([api.persons.list(), api.vehicles.list(), api.teams.list()])
      setPersons(p); setVehicles(v); setTeams(t)
      // Drop any selected person id that no longer exists (deleted, or a
      // live update from another device) — avoids "selected: 2" silently
      // referring to a person that's gone.
      const stillHere = new Set(p.map(x => x.id))
      setSelectedPersonIds(prev => {
        const next = new Set([...prev].filter(id => stillHere.has(id)))
        return next.size === prev.size ? prev : next
      })
    } catch (e) { console.error(e) }
  }

  useEffect(() => { load() }, [])

  // Joined-rooms roster (2026-08-10), fetched once — used only for the
  // "N of this team's members are actually in the room" coverage indicator
  // next to the team filter. Same data Teams.jsx's own coverage check uses;
  // fetched independently here since Database no longer otherwise needs
  // Matrix room state (see the "Decouple team roster from room membership"
  // entry in CHANGES.md for why that dependency was removed everywhere
  // else). Not live-updated — matches Teams.jsx's modal, which also only
  // fetches once per open; good enough for an informational indicator.
  const [matrixRooms, setMatrixRooms] = useState([])
  useEffect(() => {
    let cancelled = false
    api.matrix.listRooms().then(r => { if (!cancelled) setMatrixRooms(r || []) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  function openRoomInElement(roomId) {
    navigateTo(roomMatrixToUri(roomId)).catch(e => showToast(e.message, 'error'))
  }

  function togglePersonSelected(id) {
    setSelectedPersonIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Live updates from other crew members' devices — see Layout.jsx/realtime.js.
  // load() already re-fetches persons/vehicles/teams together, so one
  // listener per relevant table is enough.
  useEffect(() => {
    const events = ['crewboard:persons-updated', 'crewboard:vehicles-updated', 'crewboard:rooms-updated']
    events.forEach(e => window.addEventListener(e, load))
    return () => events.forEach(e => window.removeEventListener(e, load))
  }, [])

  async function deletePerson(id, name) {
    if (!(await confirm(`Remove "${name}" from the database?`))) return
    const person = persons.find(p => p.id === id)
    try {
      await api.persons.delete(id); await load(); showToast('Person removed')
      // Deleting from CrewBoard has no effect on actual Matrix room
      // membership (the widget can't manage that — see CLAUDE.md) —
      // remind the admin if this person's team had a broadcast room they
      // may still be sitting in.
      const team = person?.team_id ? teams.find(t => String(t.id) === String(person.team_id)) : null
      if (team?.room_id) {
        setMembershipReminder({
          message: `${name} removed — they may still be a member of ${team.name}'s broadcast room.`,
          actions: [{ label: `Open ${team.name}'s room`, room_id: team.room_id }],
        })
      }
    } catch (e) { showToast(e.message, 'error') }
  }

  async function deleteVehicle(id, label) {
    if (!(await confirm(`Remove "${label}" from the database?`))) return
    try { await api.vehicles.delete(id); await load(); showToast('Vehicle removed') }
    catch (e) { showToast(e.message, 'error') }
  }

  const q = search.toLowerCase()
  const filteredPersons = persons
    .filter(p =>
      p.name.toLowerCase().includes(q) || (p.phone || '').includes(q) || (p.team_name || '').toLowerCase().includes(q)
    )
    // Team filter (2026-08-10) — independent of the text search above.
    .filter(p => {
      if (!teamFilter) return true
      if (teamFilter === '__unassigned__') return !p.team_id
      return String(p.team_id) === teamFilter
    })
  // The team currently picked in the filter, if any (used to color/gate the
  // broadcast button next to it) — null for "All teams" or "Unassigned".
  const filterTeam = teamFilter && teamFilter !== '__unassigned__'
    ? teams.find(t => String(t.id) === teamFilter)
    : null
  // Room-coverage indicator for the filtered team (2026-08-10) — mirrors
  // Teams.jsx's own coverage check, cross-referencing this team's members
  // (by matrix_id) against matrixRooms' live roster for its linked room.
  // null whenever it can't be computed (no team picked, no room linked, the
  // dispatcher's own room list hasn't loaded yet, or nobody on the team has
  // a Matrix ID to check) — the chip is simply omitted in that case rather
  // than showing a misleading 0/0.
  const filterTeamRoom = filterTeam?.room_id ? matrixRooms.find(r => r.room_id === filterTeam.room_id) : null
  const filterTeamCoverage = filterTeamRoom
    ? (() => {
        const withMatrixId = persons.filter(p => String(p.team_id) === String(filterTeam.id) && p.matrix_id)
        if (withMatrixId.length === 0) return null
        const inRoom = new Set(filterTeamRoom.members || [])
        const missing = withMatrixId.filter(p => !inRoom.has(p.matrix_id))
        return { covered: withMatrixId.length - missing.length, total: withMatrixId.length, missingNames: missing.map(p => p.name) }
      })()
    : null
  const filteredVehicles = vehicles.filter(v =>
    `${v.make} ${v.model}`.toLowerCase().includes(q) || (v.license_plate || '').toLowerCase().includes(q) || (v.team_name || '').toLowerCase().includes(q)
  )

  // Multi-select derived state (2026-08-10) — "select all" reflects/toggles
  // only the currently FILTERED persons, same convention as most list UIs
  // (narrowing the filter doesn't change who's selected, it just changes
  // what the header checkbox means "all" relative to).
  const selectedPersons = persons.filter(p => selectedPersonIds.has(p.id))
  const allFilteredSelected = filteredPersons.length > 0 && filteredPersons.every(p => selectedPersonIds.has(p.id))
  const someFilteredSelected = filteredPersons.some(p => selectedPersonIds.has(p.id))
  function toggleSelectAllFiltered() {
    setSelectedPersonIds(prev => {
      const next = new Set(prev)
      if (allFilteredSelected) filteredPersons.forEach(p => next.delete(p.id))
      else filteredPersons.forEach(p => next.add(p.id))
      return next
    })
  }

  return (
    <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ px: 2.5, py: 1.75, borderBottom: 1, borderColor: 'divider' }}>
        <TextField
          fullWidth size="small"
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search persons or vehicles..."
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
      </Box>

      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {/* PERSONS */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: 1, borderColor: 'divider', overflow: 'hidden' }}>
          <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography sx={{ fontWeight: 600, fontSize: 13 }}>Persons</Typography>
              <Chip size="small" label={persons.length} sx={{ height: 18, fontSize: 10 }} />
            </Stack>
            <Button size="small" variant="contained" startIcon={<AddIcon fontSize="small" />} onClick={() => setShowNewPerson(true)}>Add</Button>
          </Box>

          {/* Team filter + broadcast (2026-08-10). Native select — see
              PersonModal's Team field above for why (MUI's default Select
              menu renders no visible items inside this widget's iframe).
              Broadcast is only shown for an actual picked team (not "All
              teams"/"Unassigned"): disabled + explained via tooltip when
              that team has no broadcast room linked, and colored to match
              the team's own color when it does. */}
          <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
            <TextField select size="small" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}
              SelectProps={{ native: true }} sx={{ minWidth: 160 }}>
              <option value="">All teams</option>
              <option value="__unassigned__">Unassigned</option>
              {teams.map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
            </TextField>
            {filterTeam && (
              <Tooltip title={filterTeam.room_id ? `Broadcast to ${filterTeam.name}` : `${filterTeam.name} has no broadcast room linked — add one in Teams`}>
                <span>
                  <Button size="small" variant="contained" startIcon={<ForumIcon fontSize="small" />}
                    disabled={!filterTeam.room_id}
                    onClick={() => setBroadcastTeam(filterTeam)}
                    sx={{ bgcolor: filterTeam.color, '&:hover': { bgcolor: filterTeam.color } }}>
                    Broadcast
                  </Button>
                </span>
              </Tooltip>
            )}
            {/* Room-coverage chip (2026-08-10) — see filterTeamCoverage above.
                Informational only, same as Teams.jsx's own coverage check;
                never changes anyone's team_id or room membership. */}
            {filterTeamCoverage && (
              <Tooltip title={
                filterTeamCoverage.missingNames.length === 0
                  ? 'All of this team\'s members with a Matrix ID are in the broadcast room.'
                  : `Not in the broadcast room: ${filterTeamCoverage.missingNames.join(', ')}`
              }>
                <Chip
                  size="small"
                  variant="outlined"
                  color={filterTeamCoverage.missingNames.length === 0 ? 'success' : 'warning'}
                  label={`${filterTeamCoverage.covered}/${filterTeamCoverage.total} in room`}
                />
              </Tooltip>
            )}

            <Box sx={{ flex: 1 }} />

            {/* Multi-select (2026-08-10) — "select all" applies to the
                currently filtered list (see toggleSelectAllFiltered above),
                indeterminate when some but not all of it is selected. Direct
                message button only appears once something's selected. */}
            {selectedPersons.length > 0 && (
              <Tooltip title={`Direct message ${selectedPersons.length} selected ${selectedPersons.length === 1 ? 'person' : 'people'}`}>
                <Button size="small" variant="contained" color="success" startIcon={<ForumIcon fontSize="small" />}
                  onClick={() => setBulkDirectMessage(selectedPersons)}>
                  Message ({selectedPersons.length})
                </Button>
              </Tooltip>
            )}
            <Tooltip title={allFilteredSelected ? 'Deselect all' : 'Select all'}>
              <Checkbox
                size="small"
                checked={allFilteredSelected}
                indeterminate={someFilteredSelected && !allFilteredSelected}
                onChange={toggleSelectAllFiltered}
                disabled={filteredPersons.length === 0}
                sx={{ p: 0.5 }}
              />
            </Tooltip>
          </Box>

          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {filteredPersons.length === 0 && (
              <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
                <PersonIcon sx={{ fontSize: 36, mb: 1, opacity: 0.5 }} />
                <Typography sx={{ fontWeight: 500 }}>No persons yet</Typography>
                <Typography sx={{ fontSize: 13 }}>Add crew members to get started</Typography>
              </Box>
            )}
            {filteredPersons.map(p => (
              <Stack
                key={p.id}
                direction="row"
                alignItems="center"
                spacing={1.25}
                sx={{
                  px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider',
                  // Mild per-team tint (2026-08-09) — same low-alpha hex-suffix
                  // convention already used for the avatar bg above ('25'/'20'),
                  // just fainter here ('0d' ≈ 5% opacity) since it's covering
                  // the whole row, not a small avatar circle. No team ('team_color'
                  // unset/null) falls back to no tint at all, not a default color.
                  bgcolor: p.team_color ? p.team_color + '0d' : 'transparent',
                }}
              >
                <Checkbox
                  size="small"
                  checked={selectedPersonIds.has(p.id)}
                  onChange={() => togglePersonSelected(p.id)}
                  sx={{ p: 0.5, ml: -0.5 }}
                />
                <MxcAvatar
                  mxc={p.image_mxc}
                  fetchFn={api.persons.imageUrl}
                  sx={{ width: 36, height: 36, bgcolor: p.team_color ? p.team_color + '25' : 'action.selected', color: p.team_color || 'text.secondary' }}
                >
                  {p.name.slice(0, 2).toUpperCase()}
                </MxcAvatar>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{p.name}</Typography>
                    {!p.dm_room_id && (
                      <Tooltip title="No DM room linked yet — direct message is disabled until one's linked. Link one in Edit.">
                        <LinkOffIcon sx={{ fontSize: 13, color: 'warning.main' }} />
                      </Tooltip>
                    )}
                  </Stack>
                  <Typography sx={{ fontSize: 10, color: 'text.secondary', mt: 0.125 }}>
                    {p.phone || 'No phone'} · {p.team_name || 'Unassigned'}
                    {p.vehicle_make && ` · 🚗 ${p.vehicle_make} ${p.vehicle_model}`}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.25}>
                  {/* Disabled without a linked DM room (2026-08-10) — no more
                      silent fallback-to-shared-room from this button; link a
                      DM room in Edit first (see the warning icon above). */}
                  <span>
                    <IconButton size="small" color="success" onClick={() => setDirectMessage(p)}
                      disabled={!p.dm_room_id} title={p.dm_room_id ? 'Send direct message' : 'No DM room linked — link one in Edit first'}>
                      <ForumIcon fontSize="small" />
                    </IconButton>
                  </span>
                  <IconButton size="small" color="primary" onClick={() => setSendContact(p)} title="Send contact card"><SendIcon fontSize="small" /></IconButton>
                  <IconButton size="small" onClick={() => setEditPerson(p)} title="Edit"><EditIcon fontSize="small" /></IconButton>
                  <IconButton size="small" color="error" onClick={() => deletePerson(p.id, p.name)} title="Delete"><DeleteIcon fontSize="small" /></IconButton>
                </Stack>
              </Stack>
            ))}
          </Box>
        </Box>

        {/* VEHICLES */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography sx={{ fontWeight: 600, fontSize: 13 }}>Vehicles</Typography>
              <Chip size="small" label={vehicles.length} sx={{ height: 18, fontSize: 10 }} />
            </Stack>
            <Button size="small" variant="contained" startIcon={<AddIcon fontSize="small" />} onClick={() => setShowNewVehicle(true)}>Add</Button>
          </Box>

          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {filteredVehicles.length === 0 && (
              <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
                <DirectionsCarIcon sx={{ fontSize: 36, mb: 1, opacity: 0.5 }} />
                <Typography sx={{ fontWeight: 500 }}>No vehicles yet</Typography>
                <Typography sx={{ fontSize: 13 }}>Add fleet vehicles to get started</Typography>
              </Box>
            )}
            {filteredVehicles.map(v => (
              <Stack key={v.id} direction="row" alignItems="center" spacing={1.25} sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
                <MxcAvatar
                  mxc={v.image_mxc}
                  fetchFn={api.vehicles.imageUrl}
                  variant="rounded"
                  sx={{ width: 36, height: 36, fontSize: 18, bgcolor: v.team_color ? v.team_color + '20' : 'action.selected' }}
                >
                  {v.type === 'motorcycle' ? '🏍' : '🚗'}
                </MxcAvatar>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{v.make} {v.model}</Typography>
                  <Typography sx={{ fontSize: 10, color: 'text.secondary', mt: 0.125 }}>
                    {v.license_plate || 'No plate'} · {v.team_name || 'Unassigned'}
                    {v.person_name && ` · 👤 ${v.person_name}`}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.25}>
                  <IconButton size="small" color="primary" onClick={() => setSendVehicle(v)} title="Send vehicle card"><SendIcon fontSize="small" /></IconButton>
                  <IconButton size="small" onClick={() => setEditVehicle(v)} title="Edit"><EditIcon fontSize="small" /></IconButton>
                  <IconButton size="small" color="error" onClick={() => deleteVehicle(v.id, `${v.make} ${v.model}`)} title="Delete"><DeleteIcon fontSize="small" /></IconButton>
                </Stack>
              </Stack>
            ))}
          </Box>
        </Box>
      </Box>

      {/* MODALS */}
      {(showNewPerson || editPerson) && (
        <PersonModal
          person={editPerson}
          teams={teams}
          vehicles={vehicles}
          onSave={async ({ oldTeamId, newTeamId } = {}) => {
            const wasEditing = !!editPerson
            await load(); setShowNewPerson(false); setEditPerson(null)
            showToast(wasEditing ? 'Person updated' : 'Person added')
            // Reassignment reminder (2026-08-10) — team_id changed in
            // Postgres, but nobody's actual Matrix room membership moved
            // (the widget can't do that — see CLAUDE.md). Surface both the
            // old and new team's broadcast rooms, if linked, as one-click
            // "Open in Element" follow-ups.
            if (wasEditing && String(oldTeamId || '') !== String(newTeamId || '')) {
              const oldTeam = oldTeamId ? teams.find(t => String(t.id) === String(oldTeamId)) : null
              const newTeam = newTeamId ? teams.find(t => String(t.id) === String(newTeamId)) : null
              const actions = []
              if (oldTeam?.room_id) actions.push({ label: `Open ${oldTeam.name}'s room`, room_id: oldTeam.room_id })
              if (newTeam?.room_id && newTeam.room_id !== oldTeam?.room_id) actions.push({ label: `Open ${newTeam.name}'s room`, room_id: newTeam.room_id })
              if (actions.length > 0) {
                setMembershipReminder({
                  message: 'Team changed — broadcast room membership isn\'t automatic. Update it in Element if needed.',
                  actions,
                })
              }
            }
          }}
          onClose={() => { setShowNewPerson(false); setEditPerson(null) }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {(showNewVehicle || editVehicle) && (
        <VehicleModal
          vehicle={editVehicle}
          teams={teams}
          persons={persons}
          onSave={async () => { await load(); setShowNewVehicle(false); setEditVehicle(null); showToast(editVehicle ? 'Vehicle updated' : 'Vehicle added') }}
          onClose={() => { setShowNewVehicle(false); setEditVehicle(null) }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {broadcastTeam && (
        <TeamBroadcastModal
          team={broadcastTeam}
          onClose={() => setBroadcastTeam(null)}
          onSent={() => { setBroadcastTeam(null); showToast('Broadcast sent') }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {bulkDirectMessage && (
        <BulkDirectMessageModal
          persons={bulkDirectMessage}
          onClose={() => setBulkDirectMessage(null)}
          onSent={(r) => { setBulkDirectMessage(null); setSelectedPersonIds(new Set()); showToast(`Message sent to ${r.sent}`) }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {directMessage && (
        <DirectMessageModal
          person={directMessage}
          onClose={() => setDirectMessage(null)}
          onSent={() => { setDirectMessage(null); showToast(`Message sent to ${directMessage.name}`) }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {sendContact && (
        <SendContactModal
          person={sendContact}
          persons={persons}
          teams={teams}
          onClose={() => setSendContact(null)}
          onSent={() => { setSendContact(null); showToast('Contact card sent') }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {sendVehicle && (
        <SendVehicleModal
          vehicle={sendVehicle}
          onClose={() => setSendVehicle(null)}
          onSent={() => { setSendVehicle(null); showToast('Vehicle details sent') }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {ToastEl}
      {ConfirmEl}

      {/* Membership-drift reminder (2026-08-10) — see deletePerson() and
          PersonModal's onSave above. No auto-dismiss on its own timer isn't
          right either (it's not actionable-critical), so a generous
          duration plus a manual close. */}
      <Snackbar
        open={!!membershipReminder}
        onClose={() => setMembershipReminder(null)}
        autoHideDuration={12000}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        {membershipReminder ? (
          <Alert
            severity="info"
            variant="filled"
            onClose={() => setMembershipReminder(null)}
            action={
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                {membershipReminder.actions.map((a, i) => (
                  <Button key={i} size="small" color="inherit"
                    onClick={() => { openRoomInElement(a.room_id); setMembershipReminder(null) }}>
                    {a.label}
                  </Button>
                ))}
                {/* Explicit dismiss (2026-08-10) — MUI Alert only
                    auto-generates a close icon from onClose when no custom
                    `action` is supplied; since we need the action buttons
                    above, add a plain text dismiss alongside them. */}
                <Button size="small" color="inherit" onClick={() => setMembershipReminder(null)}>Dismiss</Button>
              </Stack>
            }
          >
            {membershipReminder.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  )
}
