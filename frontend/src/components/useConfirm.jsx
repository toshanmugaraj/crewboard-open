import { useState, useCallback, useRef } from 'react'

// Element's widget iframe sandbox has no `allow-modals`, so native
// window.confirm()/alert()/prompt() are silently no-ops (confirm() returns
// false immediately, as if the user clicked Cancel, with no dialog ever
// shown). This is an in-app replacement for confirm() — same call shape
// (`await confirm('message')` resolves true/false) but rendered as a normal
// React modal instead of relying on the browser chrome.
export function useConfirm() {
  const [state, setState] = useState(null)
  const resolver = useRef(null)

  const confirm = useCallback((message) => {
    setState({ message })
    return new Promise((resolve) => { resolver.current = resolve })
  }, [])

  function resolve(result) {
    setState(null)
    resolver.current?.(result)
    resolver.current = null
  }

  const ConfirmEl = state ? (
    <div className="modal-overlay" onClick={() => resolve(false)}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 340 }}>
        <div className="modal-title">Please confirm</div>
        <div className="modal-sub">{state.message}</div>
        <div className="modal-actions">
          <button className="btn" onClick={() => resolve(false)}>Cancel</button>
          <button className="btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => resolve(true)}>Confirm</button>
        </div>
      </div>
    </div>
  ) : null

  return { confirm, ConfirmEl }
}
