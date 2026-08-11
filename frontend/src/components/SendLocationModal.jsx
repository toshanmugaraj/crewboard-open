import React, { useState } from 'react'
import { api } from '../api'

export default function SendLocationModal({ marker, teams, onClose, onSent, onError }) {
  const [target, setTarget] = useState('person')
  const [personId, setPersonId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [sending, setSending] = useState(false)
  const [persons, setPersons] = useState([])

  React.useEffect(() => {
    api.persons.list().then(setPersons).catch(() => {})
  }, [])

  const recipientsWithMatrixId = persons.filter(p => p.matrix_id)

  // Bug fix (2026-07-27): this UI already had a "Send to" picker, but
  // handleSend() never actually used target/personId/teamId — it always
  // called api.matrix.sendLocation(marker) with nothing else, which (before
  // today's api.js fix) always posted into whatever room the widget happens
  // to be running in regardless of what was selected here.
  async function handleSend() {
    setSending(true)
    try {
      const recipientPerson = target === 'person' ? recipientsWithMatrixId.find(p => String(p.id) === personId) : null
      const recipientTeam = target === 'team' ? teams.find(t => String(t.id) === teamId) : null
      await api.matrix.sendLocation(marker, { target, recipientPerson, recipientTeam })
      onSent(target === 'person' ? 1 : target === 'team' ? recipientTeam?.person_count || 1 : recipientsWithMatrixId.length)
    } catch (e) {
      onError ? onError(e.message) : console.error(e)
    } finally {
      setSending(false)
    }
  }

  const canSend =
    (target === 'person' && personId) ||
    (target === 'team' && teamId) ||
    target === 'ops'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
        <div className="modal-title">Send location</div>
        <div className="modal-sub">{marker.label || 'This marker'}'s position will be posted to the room as a map link</div>

        <div style={{ background: 'var(--surface3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>📍 {marker.label || 'Location'}</div>
          {marker.note && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{marker.note}</div>}
          <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 4 }}>{marker.lat?.toFixed(5)}, {marker.lng?.toFixed(5)}</div>
        </div>

        <div className="form-group">
          <div className="form-label">Send to</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {[
              { key: 'person', label: 'Direct message' },
              { key: 'team', label: 'Team' },
              { key: 'ops', label: 'Ops room' },
            ].map(t => (
              <button key={t.key} onClick={() => setTarget(t.key)}
                className={target === t.key ? 'btn-primary' : 'btn'}
                style={{ flex: 1, padding: '6px', fontSize: 11 }}>
                {t.label}
              </button>
            ))}
          </div>

          {target === 'person' && (
            <select value={personId} onChange={e => setPersonId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— Select person —</option>
              {recipientsWithMatrixId.map(p => (
                <option key={p.id} value={p.id}>{p.name} · {p.matrix_id}</option>
              ))}
            </select>
          )}

          {target === 'team' && (
            <select value={teamId} onChange={e => setTeamId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— Select team —</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}

          {target === 'ops' && (
            <div style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 0' }}>
              Posts to the ops room CrewBoard is currently open in, visible to all {recipientsWithMatrixId.length} crew members with a Matrix ID
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSend} disabled={!canSend || sending}>
            <i className="ti ti-send" /> {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
