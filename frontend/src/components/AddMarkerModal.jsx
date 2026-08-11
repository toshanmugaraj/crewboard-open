import React, { useState } from 'react'

const MISC_COLORS = ['#2e7dd7', '#f0a030', '#e91e8c', '#00bcd4', '#9c27b0', '#2ecc71']

export default function AddMarkerModal({ persons, vehicles, pendingLatLng, onAdd, onClose }) {
  const [type, setType] = useState(pendingLatLng?.label ? 'misc' : 'person')
  const [entityId, setEntityId] = useState('')
  const [miscLabel, setMiscLabel] = useState(pendingLatLng?.label || '')
  // Shared across all three marker types now — previously only misc markers
  // could carry a note; person/vehicle markers had no way to record one at
  // creation time at all.
  const [note, setNote] = useState('')
  const [miscColor, setMiscColor] = useState(MISC_COLORS[0])

  const list = type === 'person' ? persons : type === 'vehicle' ? vehicles : []
  const label = (item) => type === 'person'
    ? `${item.name}${item.team_name ? ` · ${item.team_name}` : ''}`
    : `${item.make} ${item.model}${item.license_plate ? ` · ${item.license_plate}` : ''}${item.team_name ? ` · ${item.team_name}` : ''}`

  function handleAdd() {
    if (type === 'misc') {
      if (!miscLabel.trim()) return
      onAdd('misc', null, { label: miscLabel.trim(), note: note.trim() || null, color: miscColor })
      return
    }
    if (!entityId) return
    // entityId is a Matrix state-key string (e.g. "cb-1a2b3c-x1"), not a
    // numeric SQL row id — parseInt() here used to silently produce NaN,
    // which Synapse then rejected with "M_BAD_JSON: Bad JSON value: float".
    onAdd(type, entityId, { note: note.trim() || null })
  }

  const canAdd = type === 'misc' ? miscLabel.trim().length > 0 : !!entityId

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">Place marker</div>
        <div className="modal-sub">
          {pendingLatLng
            ? `At ${pendingLatLng.lat.toFixed(5)}, ${pendingLatLng.lng.toFixed(5)}`
            : 'At map center'}
        </div>

        <div className="form-group">
          <div className="form-label">Marker type</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { key: 'person', icon: '👤', label: 'Person' },
              { key: 'vehicle', icon: '🚗', label: 'Vehicle' },
              { key: 'misc', icon: '📍', label: 'Misc' },
            ].map(t => (
              <button key={t.key} onClick={() => { setType(t.key); setEntityId('') }}
                className={type === t.key ? 'btn-primary' : 'btn'}
                style={{ flex: 1, padding: '8px' }}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </div>

        {type !== 'misc' ? (
          <div className="form-group">
            <div className="form-label">{type === 'person' ? 'Select person' : 'Select vehicle'}</div>
            <select value={entityId} onChange={e => setEntityId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— Choose {type} —</option>
              {list.map(item => (
                <option key={item.id} value={item.id}>{label(item)}</option>
              ))}
            </select>
            {list.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>
                No {type}s in database yet. Add them in the Database tab first.
              </div>
            )}
          </div>
        ) : null}

        {type !== 'misc' && (
          <div className="form-group">
            <div className="form-label">Note (optional)</div>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Extra detail shown in the marker popup..."
              style={{ width: '100%', minHeight: 60, resize: 'vertical' }}
            />
          </div>
        )}

        {type === 'misc' && (
          <>
            <div className="form-group">
              <div className="form-label">Label</div>
              <input
                value={miscLabel}
                onChange={e => setMiscLabel(e.target.value)}
                placeholder="e.g. Festival entrance"
                style={{ width: '100%' }}
              />
              <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4 }}>
                Supports English and Arabic. Shown below the pin on the map.
              </div>
            </div>

            <div className="form-group">
              <div className="form-label">Note (optional)</div>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Extra detail shown in the marker popup..."
                style={{ width: '100%', minHeight: 60, resize: 'vertical' }}
              />
            </div>

            <div className="form-group">
              <div className="form-label">Pin color</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {MISC_COLORS.map(c => (
                  <div key={c} onClick={() => setMiscColor(c)} style={{
                    width: 26, height: 26, borderRadius: '50%', background: c,
                    cursor: 'pointer', border: miscColor === c ? '3px solid white' : '3px solid transparent',
                    outline: miscColor === c ? `2px solid ${c}` : 'none'
                  }} />
                ))}
              </div>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleAdd} disabled={!canAdd}>
            <i className="ti ti-map-pin" /> Place marker
          </button>
        </div>
      </div>
    </div>
  )
}
