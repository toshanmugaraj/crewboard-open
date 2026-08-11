import { useState, useCallback } from 'react'

export function useToast() {
  const [toast, setToast] = useState(null)

  const show = useCallback((message, type = 'success', duration = 3000) => {
    setToast({ message, type })
    setTimeout(() => setToast(null), duration)
  }, [])

  const ToastEl = toast ? (
    <div className={`toast ${toast.type}`} style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 3000 }}>
      {toast.message}
    </div>
  ) : null

  return { show, ToastEl }
}
