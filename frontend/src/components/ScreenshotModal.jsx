import React, { useState, useRef, useEffect } from 'react'
import { api } from '../api'

export default function ScreenshotModal({ mapInstance, persons, teams, onClose, onSent, onError }) {
  const [target, setTarget] = useState('person')
  const [personId, setPersonId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [caption, setCaption] = useState('')
  const [sending, setSending] = useState(false)
  const canvasRef = useRef(null)

  useEffect(() => {
    captureMap()
    api.settings.get().then(s => {
      if (s.screenshot_caption) setCaption(s.screenshot_caption)
    }).catch(() => {})
  }, [])

  async function captureMap() {
    if (!mapInstance) return
    try {
      const container = mapInstance.getContainer()
      const { default: html2canvas } = await import('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.esm.js').catch(() => ({ default: null }))
      if (html2canvas) {
        const canvas = await html2canvas(container, {
          useCORS: true, allowTaint: true, backgroundColor: '#1a2035'
        })
        if (canvasRef.current) {
          const ctx = canvasRef.current.getContext('2d')
          canvasRef.current.width = canvas.width
          canvasRef.current.height = canvas.height
          ctx.drawImage(canvas, 0, 0)
        }
      }
    } catch (e) { console.warn('Screenshot capture failed:', e) }
  }

  async function handleSend() {
    if (target === 'person' && !personId) return
    if (target === 'team' && !teamId) return
    setSending(true)
    try {
      let imageBlob = null
      if (canvasRef.current) imageBlob = await new Promise(res => canvasRef.current.toBlob(res, 'image/png'))

      const person = target === 'person' ? persons.find(p => p.id === personId) : null
      const team = target === 'team' ? teams.find(t => t.id === teamId) : null

      await api.matrix.sendScreenshot({
        imageBlob,
        caption: caption || 'Current crew distribution',
        target,
        person,
        team,
        // Full list — only used by the 'all' ("All teams") fan-out, to post
        // into every team's linked room in addition to the ops room.
        teams,
      })
      onSent()
    } catch (e) {
      onError ? onError('Failed to send: ' + e.message) : console.error(e)
    } finally {
      setSending(false)
    }
  }

  const canSend = target === 'all' || (target === 'person' && personId) || (target === 'team' && teamId)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 380 }}>
        <div className="modal-title">Screenshot & Send</div>
        <div className="modal-sub">Capture current map and post it to the room</div>

        <div style={{
          background: 'var(--surface3)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', height: 120, marginBottom: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden'
        }}>
          <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 'var(--radius)' }} />
        </div>

        <div className="form-group">
          <div className="form-label">Send to</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {[
              { key: 'person', icon: '👤', label: 'One person' },
              { key: 'team',   icon: '👥', label: 'Team' },
              { key: 'all',    icon: '📢', label: 'All teams' },
            ].map(t => (
              <button key={t.key} onClick={() => { setTarget(t.key); setPersonId(''); setTeamId('') }}
                className={target === t.key ? 'btn-primary' : 'btn'}
                style={{ flex: 1, padding: '6px', fontSize: 11 }}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {target === 'person' && (
            <select value={personId} onChange={e => setPersonId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— Select person —</option>
              {persons.filter(p => p.matrix_id).map(p => (
                <option key={p.id} value={p.id}>{p.name} · {p.matrix_id}</option>
              ))}
            </select>
          )}
          {target === 'team' && (
            <select value={teamId} onChange={e => setTeamId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— Select team —</option>
              {teams.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          {target === 'all' && (
            <div style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 0' }}>
              Posts to the ops room and every team's room
              {' '}({teams.filter(t => t.room_id).length} of {teams.length} teams have a linked room —
              teams without one still see it via the ops room)
            </div>
          )}
        </div>

        <div className="form-group">
          <div className="form-label">Caption (optional)</div>
          <input value={caption} onChange={e => setCaption(e.target.value)}
            placeholder="e.g. Current positions as of 10AM" style={{ width: '100%' }} />
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSend} disabled={sending || !canSend}>
            <i className="ti ti-send" /> {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
