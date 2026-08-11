import React, { useState, useRef, useCallback } from 'react'
import { Box, Typography, Chip, Collapse } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'

// ── Collapsible, independently-scrollable, resizable list section ──────────
// Used by MapBoard.jsx's right panel (2026-08-04) — Live now/Persons/
// Vehicles/Points of interest used to all live inside ONE shared scroll
// container, so a long Persons list pushed Vehicles/POI far down and there
// was no way to shrink a section you didn't care about right now, or to
// collapse one out of the way entirely. Each section is now its own
// independently-scrollable box with a drag handle at the bottom to resize
// it, and a header click to collapse/expand — both remembered per-browser
// (localStorage, same pattern as uiScale.js's persisted UI-scale
// preference) so the layout a dispatcher sets up survives a reload.
const MIN_HEIGHT = 60
const MAX_HEIGHT = 480

export default function CollapsibleSection({ storageKey, title, count, defaultOpen = true, defaultHeight = 180, children }) {
  const openKey = `crewboard-section-open-${storageKey}`
  const heightKey = `crewboard-section-height-${storageKey}`

  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(openKey)
    return saved === null ? defaultOpen : saved === '1'
  })
  const [height, setHeight] = useState(() => {
    const saved = Number(localStorage.getItem(heightKey))
    return saved && saved >= MIN_HEIGHT ? saved : defaultHeight
  })

  function toggleOpen() {
    const next = !open
    setOpen(next)
    localStorage.setItem(openKey, next ? '1' : '0')
  }

  // Plain mousedown/mousemove/mouseup drag, same style as this app's other
  // hand-rolled pointer interactions (e.g. MapBoard's drag-to-place marker)
  // rather than pulling in a resize library for one small drag handle.
  const startRef = useRef(null)
  const handleDragStart = useCallback((e) => {
    e.preventDefault()
    startRef.current = { y: e.clientY, height }

    function onMove(ev) {
      const { y, height: startHeight } = startRef.current
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + (ev.clientY - y)))
      setHeight(next)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // Read the DOM-committed value via a ref would be more correct, but
      // setHeight's functional form gives us the latest state directly and
      // lets us persist it in the same tick the drag ends.
      setHeight((h) => { localStorage.setItem(heightKey, String(h)); return h })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [height, heightKey])

  return (
    <Box sx={{ mb: 1 }}>
      <Box
        onClick={toggleOpen}
        sx={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'pointer', py: 0.5, userSelect: 'none',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <ExpandMoreIcon
            sx={{
              fontSize: 16, color: 'text.secondary',
              transform: open ? 'none' : 'rotate(-90deg)',
              transition: 'transform 0.15s',
            }}
          />
          <Typography variant="overline" sx={{ fontSize: 10, fontWeight: 600, color: 'text.secondary' }}>{title}</Typography>
        </Box>
        {count != null && <Chip size="small" label={count} sx={{ height: 16, fontSize: 9 }} />}
      </Box>

      <Collapse in={open}>
        <Box sx={{ height, overflowY: 'auto', pr: 0.25 }}>
          {children}
        </Box>
        <Box
          onMouseDown={handleDragStart}
          title="Drag to resize"
          sx={{
            height: 8, cursor: 'ns-resize', mt: 0.25,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 1,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          <Box sx={{ width: 28, height: 3, borderRadius: 2, bgcolor: 'divider' }} />
        </Box>
      </Collapse>
    </Box>
  )
}
