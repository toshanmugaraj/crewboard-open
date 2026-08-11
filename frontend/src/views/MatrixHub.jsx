import React, { useState, useEffect, useRef } from 'react'
import { Box, Typography, TextField, IconButton, Chip, Alert, Stack, Button, Tooltip } from '@mui/material'
import SendIcon from '@mui/icons-material/Send'
import ForumIcon from '@mui/icons-material/Forum'
import BadgeIcon from '@mui/icons-material/Badge'
import DirectionsCarIcon from '@mui/icons-material/DirectionsCar'
import LocationOnIcon from '@mui/icons-material/LocationOn'
import PhotoIcon from '@mui/icons-material/Photo'
import BugReportIcon from '@mui/icons-material/BugReport'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DownloadIcon from '@mui/icons-material/Download'
import { api } from '../api'
import { subscribeState, getCurrentRoomName } from '../matrixStore.js'
import { getRoomId } from '../widget.js'
import { useToast } from '../components/useToast.jsx'

// Migrated (2026-07-20) to MUI as part of the @matrix-widget-toolkit
// adoption — see main.jsx/widget.js/matrixStore.js for the data-layer half.
// All api.js calls and subscribeState() wiring unchanged.
//
// A widget only has capabilities for the single room it's added to, so
// "Matrix Hub" is no longer a multi-room client with its own room
// creation/membership/verification UI — Element already does all of that
// natively for the room this widget lives in. This view is CrewBoard's own
// activity feed for the room: messages, contact cards, vehicle cards, and
// location shares posted from the other CrewBoard tabs, plus a quick compose
// box for chatting without leaving the app.
export default function MatrixHub() {
  const [events, setEvents] = useState([])
  const [presets, setPresets] = useState([])
  const [compose, setCompose] = useState('')
  const [sending, setSending] = useState(false)
  const feedRef = useRef(null)
  const roomId = getRoomId()
  // Room DISPLAY name (m.room.name), not the raw !id:server — see
  // getCurrentRoomName()'s header comment in matrixStore.js. null until it
  // resolves (or if the room genuinely has no name), in which case the
  // header falls back to the id like it always used to.
  const [roomName, setRoomName] = useState(null)
  const { show: showToast, ToastEl } = useToast()

  async function load() {
    try {
      const inbox = await api.matrix.inbox()
      setEvents(inbox)
    } catch (e) { console.error(e) }
  }

  useEffect(() => {
    load()
    api.matrix.presets().then(setPresets).catch(() => {})
    getCurrentRoomName().then(setRoomName).catch(() => {})
  }, [])
  // Scroll ONLY the feed container to the bottom on new events — not
  // scrollIntoView(), which also scrolls every scrollable ancestor including
  // the document. Under a >100% interface scale the document is taller than
  // the viewport, so scrollIntoView() was scrolling the whole page (revealing
  // the nav / jumping to top) instead of just the message list.
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events])

  // Live updates pushed from Element as new events land in the room.
  // MatrixHub is a single-room activity feed for THIS widget's own room
  // specifically (not team/person rooms — see relevantRooms.js's header
  // comment), so this checks room_id directly against getRoomId() rather
  // than the broader isRelevantRoom() used by the cross-room watchers.
  useEffect(() => {
    const unsub = subscribeState('m.room.message', (ev) => {
      if (ev?.room_id && ev.room_id !== roomId) return
      load()
    })
    return unsub
  }, [])

  async function send() {
    if (!compose.trim()) return
    setSending(true)
    try {
      await api.matrix.send({ body: compose.trim() })
      setCompose('')
      await load()
    } catch (e) { showToast(e.message, 'error') }
    setSending(false)
  }

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden', flexDirection: 'column' }}>
      <Box sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Matrix Hub</Typography>
        {roomName ? (
          <Tooltip title={roomId || ''}>
            <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>{roomName}</Typography>
          </Tooltip>
        ) : (
          <Typography sx={{ fontSize: 10, color: 'text.disabled', fontFamily: 'monospace' }}>{roomId || 'no room'}</Typography>
        )}
      </Box>

      <Alert severity="info" icon={<ForumIcon fontSize="small" />} sx={{ mx: 2, mt: 1.25 }}>
        Room membership, invites, and device verification are managed in Element itself —
        use Element's room settings and the room's member list for those. This tab is CrewBoard's
        activity feed for the room.
      </Alert>

      <Box ref={feedRef} sx={{ flex: 1, overflowY: 'auto', px: 2, pt: 0.5, pb: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {events.length === 0 && (
          <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
            <ForumIcon sx={{ fontSize: 36, mb: 1, opacity: 0.5 }} />
            <Typography sx={{ fontWeight: 500 }}>No activity yet</Typography>
            <Typography sx={{ fontSize: 13 }}>Messages, broadcasts, and shared locations will show up here</Typography>
          </Box>
        )}
        {events.map((ev, i) => (
          <EventRow key={ev.event_id || i} event={ev} showToast={showToast} />
        ))}
      </Box>

      {presets.length > 0 && (
        <Box sx={{ px: 1.5, py: 0.75, display: 'flex', gap: 0.75, flexWrap: 'wrap', borderTop: 1, borderColor: 'divider' }}>
          {presets.map((p, i) => (
            <Chip key={i} size="small" label={p} onClick={() => setCompose(p)} />
          ))}
        </Box>
      )}

      <Box sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider', display: 'flex', gap: 1 }}>
        <TextField
          fullWidth size="small"
          value={compose}
          onChange={e => setCompose(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="Post a message to the room…"
        />
        <IconButton color="primary" onClick={send} disabled={!compose.trim() || sending}>
          <SendIcon fontSize="small" />
        </IconButton>
      </Box>
      {ToastEl}
    </Box>
  )
}

// A diagnostics report's full log text lives in a dedicated content field
// (org.crewboard.diagnostics_text — see diagnostics.js), not `body` — body
// is kept as a short, human-readable summary for other clients. Copy/
// download pull from that field, viewable here in MatrixHub.
async function copyReportText(text, showToast) {
  try {
    await navigator.clipboard.writeText(text || '')
    showToast?.('Diagnostics copied to clipboard')
  } catch (e) {
    showToast?.(`Couldn't copy: ${e.message}`, 'error')
  }
}

function downloadReportText(text, meta) {
  const stamp = new Date(meta?.ts || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const blob = new Blob([text || ''], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `crewboard-diagnostics-${stamp}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

function EventRow({ event, showToast }) {
  const content = event.content || {}
  const sender = event.sender || 'unknown'
  const time = event.origin_server_ts
    ? new Date(event.origin_server_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  let body
  if (event.type === 'org.crewboard.contact') {
    body = <><BadgeIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom', mr: 0.5 }} /> Shared contact: <strong>{content.name}</strong>{content.phone ? ` · ${content.phone}` : ''}</>
  } else if (event.type === 'org.crewboard.vehicle-card') {
    body = <><DirectionsCarIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom', mr: 0.5 }} /> Shared vehicle: <strong>{content.make} {content.model}</strong>{content.license_plate ? ` · ${content.license_plate}` : ''}</>
  } else if (event.type === 'org.crewboard.location') {
    // Legacy event type (pre 2026-08-02) — kept so old room history still
    // renders nicely. New sends use real m.room.message/msgtype:'m.location'
    // (handled below) instead, so this is a read-only path now.
    body = <><LocationOnIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom', mr: 0.5 }} /> Shared location: <strong>{content.label || 'Marker'}</strong> ({Number(content.lat)?.toFixed?.(4)}, {Number(content.lng)?.toFixed?.(4)})</>
  } else if (content.msgtype === 'm.location') {
    body = <><LocationOnIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom', mr: 0.5 }} /> {content.body || 'Shared location'}</>
  } else if (content.msgtype === 'm.image') {
    body = <><PhotoIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom', mr: 0.5 }} /> {content.body || 'Screenshot'}</>
  } else if (content.msgtype === 'org.crewboard.diagnostic-report') {
    // See diagnostics.js — Settings' "Send to this room" button. Admin-
    // facing: copy/download the full captured log text, which lives in a
    // dedicated content field, not `body` (body stays a short summary for
    // other clients/notifications).
    const text = content['org.crewboard.diagnostics_text'] || ''
    const meta = content['org.crewboard.diagnostics_meta'] || {}
    const lineCount = content['org.crewboard.diagnostics_line_count']
    body = (
      <>
        <Box sx={{ mb: 0.75 }}>
          <BugReportIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom', mr: 0.5 }} />
          Diagnostics report{lineCount != null ? ` (${lineCount} log lines)` : ''}
          {meta.mode ? <Typography component="span" sx={{ fontSize: 11, color: 'text.secondary', ml: 0.5 }}>· {meta.mode}</Typography> : null}
        </Box>
        <Stack direction="row" spacing={0.75}>
          <Button size="small" variant="outlined" startIcon={<ContentCopyIcon fontSize="small" />} onClick={() => copyReportText(text, showToast)}>
            Copy log
          </Button>
          <Button size="small" variant="outlined" startIcon={<DownloadIcon fontSize="small" />} onClick={() => downloadReportText(text, meta)}>
            Download .txt
          </Button>
        </Stack>
      </>
    )
  } else {
    body = content.body || ''
  }

  return (
    <Box sx={{ maxWidth: '80%' }}>
      <Typography sx={{ fontSize: 10, color: 'text.disabled', mb: 0.25 }}>{sender}</Typography>
      <Box sx={{ bgcolor: 'action.hover', color: 'text.primary', borderRadius: '12px 12px 12px 2px', px: 1.5, py: 0.875, fontSize: 13, lineHeight: 1.5 }}>
        {body}
      </Box>
      {time && <Typography sx={{ fontSize: 10, color: 'text.disabled', mt: 0.25 }}>{time}</Typography>}
    </Box>
  )
}
