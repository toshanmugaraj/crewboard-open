import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  IconButton,
  Chip,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
  Tooltip,
  Autocomplete,
  CircularProgress,
  Alert,
} from '@mui/material'
import LockIcon from '@mui/icons-material/Lock'
import LockOpenIcon from '@mui/icons-material/LockOpen'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import ForumIcon from '@mui/icons-material/Forum'
import MapIcon from '@mui/icons-material/Map'
import PersonIcon from '@mui/icons-material/Person'
import CheckIcon from '@mui/icons-material/Check'
import SendIcon from '@mui/icons-material/Send'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import GroupIcon from '@mui/icons-material/Group'
import { api } from '../api'
import { useToast } from '../components/useToast.jsx'
import { useConfirm } from '../components/useConfirm.jsx'
import { roomMatrixToUri } from '../widget.js'
import { navigateTo } from '../matrixStore.js'

// Migrated (2026-07-20) to MUI as part of the @matrix-widget-toolkit
// adoption — see main.jsx/widget.js/matrixStore.js for the data-layer half.
// All api.js calls and event wiring unchanged; only the rendered chrome
// (modals, cards, buttons) is MUI now.
const TEAM_COLORS = [
  '#4e7fff', '#6030b0', '#2ecc71', '#e05555', '#f0a030',
  '#00bcd4', '#e91e8c', '#ff6b35', '#9c27b0', '#607d8b'
]

function TeamModal({ team, usedColors, onSave, onClose, onError }) {
  const [name, setName] = useState(team?.name || '')
  const [desc, setDesc] = useState(team?.description || '')
  const [color, setColor] = useState(team?.color || TEAM_COLORS.find(c => !usedColors.includes(c)) || TEAM_COLORS[0])
  const [roomId, setRoomId] = useState(team?.room_id || '')

  // Rooms the dispatcher is joined to, for the broadcast-room picker. Loaded
  // once when the modal opens; best-effort (empty list still lets the admin
  // paste a raw id via the freeSolo input).
  const [rooms, setRooms] = useState([])
  const [loadingRooms, setLoadingRooms] = useState(true)
  useEffect(() => {
    let cancelled = false
    api.matrix.listRooms()
      .then(list => { if (!cancelled) setRooms(list || []) })
      .catch(() => { if (!cancelled) setRooms([]) })
      .finally(() => { if (!cancelled) setLoadingRooms(false) })
    return () => { cancelled = true }
  }, [])

  const selectedRoom = rooms.find(r => r.room_id === roomId) || null

  // Coverage cross-check (2026-08-10, informational only — see CHANGES.md
  // "Decouple team roster from room membership"): which of this team's
  // members (by matrix_id, assigned manually now — see Database.jsx's
  // PersonModal) are actually in the picked broadcast room, i.e. will
  // actually receive a broadcast sent there. This no longer drives roster
  // membership in either direction — it's purely a heads-up so an admin
  // notices "half the team isn't in the room I'm about to broadcast to."
  const teamMatrixIds = (team?.persons || []).map(p => p.matrix_id).filter(Boolean)
  const noMatrixIdCount = (team?.persons || []).length - teamMatrixIds.length
  const coverage = selectedRoom && teamMatrixIds.length > 0
    ? (() => {
        const inRoom = new Set(selectedRoom.members || [])
        const missing = teamMatrixIds.filter(id => !inRoom.has(id))
        return { covered: teamMatrixIds.length - missing.length, total: teamMatrixIds.length, missing }
      })()
    : null

  const roomLabel = (r) => {
    if (typeof r === 'string') return r
    if (!r) return ''
    return r.name || r.room_id
  }

  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    try {
      // room_id (2026-08-10): purely an optional broadcast target now — no
      // longer required, and no longer drives member import/sync. Team
      // membership lives entirely in persons.team_id, assigned by hand from
      // Database.jsx's Team select. See CHANGES.md "Decouple team roster
      // from room membership".
      const data = { name, description: desc, color, room_id: roomId.trim() || null }
      team?.id ? await api.teams.update(team.id, data) : await api.teams.create(data)
      onSave()
    } catch (e) {
      onError ? onError(e.message) : console.error(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {team ? 'Edit team' : 'New team'}
        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>
          {team ? `Editing ${team.name}` : 'Create a new team'}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <TextField label="Team name" value={name} onChange={e => setName(e.target.value)} placeholder="Team Alpha" fullWidth size="small" />
          <TextField label="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Zone A coverage" fullWidth size="small" />

          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 500, mb: 1 }}>Team color</Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {TEAM_COLORS.map(c => {
                const taken = usedColors.includes(c) && c !== team?.color
                return (
                  <Box key={c} onClick={() => !taken && setColor(c)} sx={{
                    width: 28, height: 28, borderRadius: '50%',
                    bgcolor: taken ? 'action.disabledBackground' : c,
                    cursor: taken ? 'not-allowed' : 'pointer',
                    border: color === c ? '3px solid white' : '3px solid transparent',
                    outline: color === c ? `2px solid ${c}` : 'none',
                    opacity: taken ? 0.3 : 1,
                    position: 'relative',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10,
                  }}>
                    {taken && '✕'}
                  </Box>
                )
              })}
            </Stack>
          </Box>

          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 500, mb: 0.5 }}>Broadcast room (optional)</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 0.75 }}>
              Pick a Matrix room to use as this team's broadcast target — sending
              a message to the team posts here. Team membership itself is managed
              separately (assign people to this team from their entry in Database),
              not from this room's roster.
            </Typography>
            <Stack direction="row" spacing={0.75} alignItems="flex-start">
              <Autocomplete
                fullWidth size="small" freeSolo selectOnFocus handleHomeEndKeys
                loading={loadingRooms}
                options={rooms}
                value={selectedRoom || roomId || null}
                getOptionLabel={roomLabel}
                isOptionEqualToValue={(opt, val) => opt.room_id === (typeof val === 'string' ? val : val?.room_id)}
                // roomId must always be a real Matrix room id (!id:server), never
                // a display name. Picking an option gives us the object -> use
                // its room_id. A typed/pasted string is only a room id if it
                // looks like one (starts with ! or #); otherwise it's just the
                // filter text over room NAMES and must NOT be stored as the id.
                // (autoSelect was removed: on blur it fed the highlighted
                // option's display-name label back as a free string, which is
                // exactly how the name ended up saved as the room id.)
                onChange={(_, val) => {
                  if (val && typeof val === 'object') { setRoomId(val.room_id || ''); return }
                  if (typeof val === 'string') {
                    const s = val.trim()
                    setRoomId(s.startsWith('!') || s.startsWith('#') ? s : '')
                  } else {
                    setRoomId('')
                  }
                }}
                onInputChange={(_, val, reason) => {
                  if (reason !== 'input') return
                  const s = val.trim()
                  // Capture a pasted room id/alias immediately; ignore plain
                  // name-filter typing.
                  if (s.startsWith('!') || s.startsWith('#')) setRoomId(s)
                }}
                renderOption={(props, r) => (
                  <Box component="li" {...props} key={r.room_id}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.name || r.room_id}
                      </Typography>
                      <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
                        {r.member_count} members{r.is_dm ? ' · DM' : ''}
                      </Typography>
                    </Box>
                    {r.encrypted
                      ? <Tooltip title="Encrypted"><LockIcon sx={{ fontSize: 15, color: 'success.main', ml: 1 }} /></Tooltip>
                      : <Tooltip title="Not encrypted"><LockOpenIcon sx={{ fontSize: 15, color: 'warning.main', ml: 1 }} /></Tooltip>}
                  </Box>
                )}
                renderInput={(params) => (
                  <TextField {...params} placeholder="Pick a room, or paste !id:server"
                    InputProps={{
                      ...params.InputProps,
                      endAdornment: (
                        <>
                          {loadingRooms ? <CircularProgress size={14} /> : null}
                          {params.InputProps.endAdornment}
                        </>
                      ),
                    }} />
                )}
              />
              {roomId.trim() && (
                <Button
                  size="small" variant="outlined" startIcon={<OpenInNewIcon fontSize="small" />}
                  sx={{ whiteSpace: 'nowrap', mt: 0.25 }}
                  onClick={() => navigateTo(roomMatrixToUri(roomId.trim())).catch(e => onError?.(e.message))}
                >
                  Open
                </Button>
              )}
            </Stack>

            {/* Coverage + encryption feedback for the picked room — informational
                only now, doesn't gate saving or touch anyone's team_id. */}
            {selectedRoom && !selectedRoom.encrypted && (
              <Alert severity="warning" sx={{ mt: 1, py: 0, fontSize: 11 }}>
                This room isn't encrypted — broadcasts to it won't be end-to-end encrypted.
              </Alert>
            )}
            {coverage && (
              <Alert severity={coverage.missing.length === 0 ? 'success' : 'warning'} sx={{ mt: 1, py: 0, fontSize: 11 }}>
                {coverage.missing.length === 0
                  ? `All ${coverage.total} team members with a Matrix ID are in this room.`
                  : `Covers ${coverage.covered} of ${coverage.total} — not in room: ${coverage.missing.join(', ')}. Invite them in Element.`}
                {noMatrixIdCount > 0 ? ` (${noMatrixIdCount} member${noMatrixIdCount > 1 ? 's have' : ' has'} no Matrix ID to check.)` : ''}
              </Alert>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <CheckIcon fontSize="small" />}
          onClick={handleSave} disabled={!name.trim() || saving}>
          {saving ? 'Saving…' : team ? 'Save changes' : 'Create team'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function BroadcastModal({ team, onClose, onSent, onError }) {
  const [msg, setMsg] = useState('')
  const [presets, setPresets] = useState([])
  const [sending, setSending] = useState(false)

  useEffect(() => { api.matrix.presets().then(setPresets).catch(() => {}) }, [])

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
            ? `Private, E2EE message to ${team.name}'s linked room (${team.person_count} members)`
            : `Message will be posted to the shared ops room, tagged for all ${team.person_count} members — link a team room in Edit for a private broadcast`}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          {presets.map((p, i) => (
            <Chip key={i} size="small" label={p} onClick={() => setMsg(p)} sx={{ fontSize: 10 }} />
          ))}
        </Stack>
        <TextField multiline minRows={4} fullWidth value={msg} onChange={e => setMsg(e.target.value)} placeholder="Type your message..." />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<SendIcon fontSize="small" />} onClick={handleSend} disabled={!msg.trim() || sending}>
          {sending ? 'Sending...' : `Send to all (${team.person_count})`}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default function Teams() {
  const navigate = useNavigate()
  const [teams, setTeams] = useState([])
  const [editTeam, setEditTeam] = useState(null)
  const [broadcastTeam, setBroadcastTeam] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const { show: showToast, ToastEl } = useToast()
  const { confirm, ConfirmEl } = useConfirm()

  async function load() {
    try { setTeams(await api.teams.list()) }
    catch (e) { console.error(e) }
  }

  useEffect(() => { load() }, [])

  // Live updates from other crew members' devices — see Layout.jsx/realtime.js
  useEffect(() => {
    window.addEventListener('crewboard:rooms-updated', load)
    return () => window.removeEventListener('crewboard:rooms-updated', load)
  }, [])

  async function handleDelete(id, name) {
    if (!(await confirm(`Delete team "${name}"? Members will become unassigned.`))) return
    try { await api.teams.delete(id); await load(); showToast('Team deleted') }
    catch (e) { showToast(e.message, 'error') }
  }

  return (
    <Box sx={{ flex: 1, overflowY: 'auto', p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2.5 }}>
        <Typography variant="h6" sx={{ fontSize: 16, fontWeight: 600 }}>Teams</Typography>
        <Button variant="contained" startIcon={<AddIcon fontSize="small" />} onClick={() => setShowNew(true)}>New team</Button>
      </Box>

      {teams.length === 0 && (
        <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
          <GroupIcon sx={{ fontSize: 40, mb: 1, opacity: 0.5 }} />
          <Typography sx={{ fontWeight: 500 }}>No teams yet</Typography>
          <Typography sx={{ fontSize: 13 }}>Create a team to start organizing your crew</Typography>
          <Button variant="contained" onClick={() => setShowNew(true)} sx={{ mt: 1 }}>Create first team</Button>
        </Box>
      )}

      {teams.map(team => (
        <Card key={team.id} variant="outlined" sx={{ mb: 1.5 }}>
          <Box sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
            <Stack direction="row" alignItems="center" spacing={1.25}>
              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: team.color, flexShrink: 0 }} />
              <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{team.name}</Typography>
              {team.description && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{team.description}</Typography>}
            </Stack>
            <Stack direction="row" alignItems="center" spacing={0.75}>
              <Chip size="small" label={`${team.person_count || 0} members · ${team.vehicle_count || 0} vehicles`} sx={{ bgcolor: team.color + '20', color: team.color }} />
              <Tooltip title="Edit team">
                <IconButton size="small" onClick={() => setEditTeam(team)}><EditIcon fontSize="small" /></IconButton>
              </Tooltip>
              <Tooltip title="Delete team">
                <IconButton size="small" color="error" onClick={() => handleDelete(team.id, team.name)}><DeleteIcon fontSize="small" /></IconButton>
              </Tooltip>
            </Stack>
          </Box>

          <CardContent sx={{ pt: 0, '&:last-child': { pb: 2 } }}>
            {team.persons && team.persons.length > 0 && (
              <Box sx={{ mb: 1.25 }}>
                <Typography variant="overline" sx={{ fontSize: 10, fontWeight: 600, color: 'text.secondary' }}>Members</Typography>
                <Stack direction="row" spacing={0.625} flexWrap="wrap" useFlexGap>
                  {team.persons.map(p => (
                    <Chip key={p.id} size="small" icon={<PersonIcon fontSize="small" />} label={p.name} variant="outlined" />
                  ))}
                </Stack>
              </Box>
            )}

            {team.vehicles && team.vehicles.length > 0 && (
              <Box sx={{ mb: 1.25 }}>
                <Typography variant="overline" sx={{ fontSize: 10, fontWeight: 600, color: 'text.secondary' }}>Vehicles</Typography>
                <Stack direction="row" spacing={0.625} flexWrap="wrap" useFlexGap>
                  {team.vehicles.map(v => (
                    <Chip key={v.id} size="small" color="success" variant="outlined"
                      label={`${v.type === 'motorcycle' ? '🏍' : '🚗'} ${v.make} ${v.model} · ${v.license_plate || '—'}`} />
                  ))}
                </Stack>
              </Box>
            )}

            <Stack direction="row" spacing={0.75} sx={{ pt: 1.25, borderTop: 1, borderColor: 'divider' }}>
              <Button size="small" variant="contained" startIcon={<ForumIcon fontSize="small" />} onClick={() => setBroadcastTeam(team)}>Broadcast</Button>
              <Button size="small" variant="outlined" startIcon={<MapIcon fontSize="small" />}
                onClick={() => navigate(`/map?team=${team.id}`)}>View on map</Button>
              <Button size="small" variant="outlined" startIcon={<EditIcon fontSize="small" />} onClick={() => setEditTeam(team)}>Edit</Button>
            </Stack>
          </CardContent>
        </Card>
      ))}

      {(showNew || editTeam) && (
        <TeamModal
          team={editTeam || null}
          usedColors={teams.filter(t => t.id !== editTeam?.id).map(t => t.color)}
          onSave={async () => {
            const base = editTeam ? 'Team updated' : 'Team created'
            await load(); setShowNew(false); setEditTeam(null)
            showToast(base)
          }}
          onClose={() => { setShowNew(false); setEditTeam(null) }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {broadcastTeam && (
        <BroadcastModal
          team={broadcastTeam}
          onClose={() => setBroadcastTeam(null)}
          onSent={() => { setBroadcastTeam(null); showToast('Broadcast sent') }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {ToastEl}
      {ConfirmEl}
    </Box>
  )
}
