// ── UI scale ─────────────────────────────────────────────────────────────────
// A per-browser zoom factor for the whole widget, so a dispatcher can size the
// interface to their screen / the (often small) Element widget frame. Stored in
// localStorage — it's a personal display preference, not shared app data, so it
// doesn't belong in the per-room backend settings (that would force one scale
// on every member). Applied by setting CSS `zoom` on the document root, which
// scales all rendered components uniformly; Chromium (which Element Web / the
// widget iframe runs on) supports it.
const UI_SCALE_KEY = 'crewboard-ui-scale'
export const UI_SCALE_MIN = 0.7
export const UI_SCALE_MAX = 1.5
export const UI_SCALE_DEFAULT = 1

function clamp(n) {
  if (!Number.isFinite(n)) return UI_SCALE_DEFAULT
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n))
}

// `zoom` on <html> does NOT rescale `vh`/`vw` units for descendants — a
// height:'100vh' box always measures against the REAL, physical viewport
// (unaffected by `zoom`), and only the RESULT of that measurement then gets
// rendered `scale`x bigger/smaller on screen along with everything else in
// the zoomed subtree. Two visible symptoms, one root cause:
//   - scale > 100%: the 100vh-tall box renders taller than the iframe
//     (100vh × scale on screen), so its bottom — MatrixHub's compose box,
//     form save bars, the map's own bottom edge — gets clipped by the
//     overflow:hidden ancestors in index.css/Layout.jsx.
//   - scale < 100%: the SAME box renders shorter than the iframe (100vh ×
//     scale, now < 100%), leaving a plain empty gap of the iframe's own
//     background color below the shrunk app — this is the "extra bottom
//     inset" visible at low scale, and it's NOT the deliberate feature
//     below; it was simply never compensated for in either direction.
//
// A previous fix only patched the >100% clipping symptom with a padding-
// bottom hack sized to the overflow amount (see git history —
// bottomInsetForScale()/BOTTOM_INSET_PER_SCALE_UNIT). That was always a
// band-aid: it reserved a fixed guess of scroll room rather than fixing the
// actual mismatch, so it under/over-shot depending on how tall content
// really was, and did nothing for the <100% gap since that direction has no
// "overflow" for padding to reserve room against.
//
// The real fix is to correct the ONE value `zoom` doesn't touch — feed
// Layout.jsx's outer `height: 100vh` a pre-divided amount
// (`calc(100vh / scale)`) so that after `zoom` renders it back up by
// `scale`, it lands on exactly 100vh of REAL on-screen space again, at any
// scale in either direction. Everything inside sizes off that (now
// correctly-real) box via ordinary flex/px layout, which zoom scales
// consistently — so nothing overflows past the bottom, and nothing leaves a
// gap short of it. `--cb-zoom` carries the current scale for that calc();
// see Layout.jsx's outer Box.

export function getUiScale() {
  try {
    const raw = localStorage.getItem(UI_SCALE_KEY)
    return raw ? clamp(parseFloat(raw)) : UI_SCALE_DEFAULT
  } catch {
    return UI_SCALE_DEFAULT
  }
}

/** Applies a scale without persisting — used for the live slider preview and
 *  the on-startup restore. */
export function applyUiScale(scale) {
  const s = clamp(scale)
  try {
    // `zoom` (rather than transform: scale) so layout reflows at the new size
    // instead of overflowing its original box. String '1' etc. is fine.
    document.documentElement.style.zoom = String(s)
    // Read by Layout.jsx's outer Box as `height: calc(100vh / var(--cb-zoom))`
    // — see the header comment above for why dividing the vh amount by the
    // current scale is what actually fixes the clipping/gap problem, in
    // both directions, at the source.
    document.documentElement.style.setProperty('--cb-zoom', String(s))
    // Broadcast so the map can counter-zoom itself back to 100% (the map is
    // meant to stay at true scale — see MapBoard's counter-zoom effect).
    window.dispatchEvent(new CustomEvent('crewboard:ui-scale', { detail: { scale: s } }))
  } catch { /* no-op outside a browser */ }
  return s
}

/** Persists and applies a scale. */
export function setUiScale(scale) {
  const s = clamp(scale)
  try { localStorage.setItem(UI_SCALE_KEY, String(s)) } catch { /* ignore */ }
  return applyUiScale(s)
}
