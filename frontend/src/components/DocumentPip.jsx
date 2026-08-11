import React, { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'

// ── True floating window, separate from the Element web client entirely ────
// Different from widget.js's setFloating()/m.always_on_screen (Settings →
// Matrix → "Float this widget"), which keeps CrewBoard floating *within*
// Element as a small PiP as you switch rooms. This uses the browser's
// Document Picture-in-Picture API to open a real, separate always-on-top
// window with its own DOM — it floats over other browser tabs and other
// apps, not just within Element's UI.
//
// CLOSED, does not work for widgets (verified live 2026-07-16): Chromium's
// own implementation of requestWindow() hard-rejects with NotAllowedError
// ("Opening a PiP window is only allowed from a top-level browsing
// context") for ANY iframe, regardless of Permissions-Policy. Confirmed the
// permissions-policy grant itself DOES work correctly —
// document.featurePolicy.allowsFeature('picture-in-picture') returns true
// inside the widget iframe after patching Element's AppTile.tsx
// iframeFeatures (see crewboard/patches in 2026/element-web) — but that
// patch was solving the wrong constraint. The top-level-only restriction is
// enforced by the browser itself, independent of any allow attribute,
// Permissions-Policy header, or Element config; there is no way to make
// this specific API work from inside a Matrix Widget iframe. (The
// AppTile.tsx patch is otherwise harmless and left in place — camera/mic
// picture-in-picture for <video> elements, which IS iframe-allowed, still
// benefits from it — this comment is just correcting the original
// assumption that it would also unlock Document PiP.)
//
// isSupported below reflects this: even when the API exists on `window`,
// it's also gated on being in a top-level browsing context, so the pop-out
// button simply doesn't render when running as a widget instead of
// offering something guaranteed to fail.
export function useDocumentPip() {
  const [pipWindow, setPipWindow] = useState(null)
  const [error, setError] = useState(null)
  const observerRef = useRef(null)

  const isSupported =
    typeof window !== 'undefined' &&
    'documentPictureInPicture' in window &&
    window.top === window.self

  const copyStyles = useCallback((win) => {
    for (const sheet of document.styleSheets) {
      try {
        const rules = [...sheet.cssRules].map(r => r.cssText).join('\n')
        const style = win.document.createElement('style')
        style.textContent = rules
        win.document.head.appendChild(style)
      } catch {
        // Cross-origin stylesheet — can't read .cssRules from script, but the
        // browser can still just re-fetch it via a <link> in the new window.
        if (sheet.href) {
          const link = win.document.createElement('link')
          link.rel = 'stylesheet'
          link.href = sheet.href
          win.document.head.appendChild(link)
        }
      }
    }
  }, [])

  const open = useCallback(async () => {
    setError(null)
    if (!isSupported) {
      setError("This browser doesn't support pop-out windows (Chrome/Edge only, currently).")
      return
    }
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 420, height: 720 })
      win.document.title = 'CrewBoard'
      win.document.body.style.margin = '0'
      copyStyles(win)

      // Fonts/icon CSS etc. can finish loading and get added to <head>
      // after this window already opened — mirror later additions too.
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeName === 'LINK' || node.nodeName === 'STYLE') copyStyles(win)
          }
        }
      })
      observer.observe(document.head, { childList: true })
      observerRef.current = observer

      win.addEventListener('pagehide', () => {
        observerRef.current?.disconnect()
        setPipWindow(null)
      }, { once: true })

      setPipWindow(win)
    } catch (e) {
      // isSupported already excludes non-top-level contexts, so a
      // NotAllowedError here would be something else (another PiP window
      // already open elsewhere, etc.) rather than the iframe restriction.
      setError(`Couldn't open pop-out window: ${e.message}`)
    }
  }, [isSupported, copyStyles])

  const close = useCallback(() => {
    observerRef.current?.disconnect()
    pipWindow?.close()
    setPipWindow(null)
  }, [pipWindow])

  return { isSupported, pipWindow, error, open, close }
}

/** Renders `children` into the popped-out window via a React portal once
 *  one is open; otherwise renders them in place as normal. Put this around
 *  whatever should move into the floating window. */
export function PipPortal({ pipWindow, children }) {
  if (!pipWindow) return children
  return createPortal(children, pipWindow.document.body)
}
