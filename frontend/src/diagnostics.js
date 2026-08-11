// ── Widget console-log capture for admin troubleshooting (2026-08-04) ───────
// A CrewBoard widget iframe's browser console is invisible to everyone but
// whoever's physically looking at that exact machine — there's no server
// visibility into it at all, unlike the backend/Element/Synapse pod logs
// documented in CLAUDE.md's Troubleshooting section. For a remote field
// crew member, that means an admin has no way to see what actually went
// wrong beyond whatever the user can describe in words.
//
// This module captures a rolling buffer of console output + basic
// environment context client-side, and offers two ways to get it to an
// admin: copy to clipboard (paste into a support message any way you like),
// or post it directly into the room as a normal message (see sendMessage()
// below) — reusing the exact same send path/encryption every other chat
// message already goes through, no new backend route or Matrix capability
// needed. See Settings.jsx for the UI, MatrixHub.jsx's EventRow for how a
// sent report renders in the activity feed.
//
// Deliberately did NOT build the "pipe logs across the widget/Element-host
// boundary into Element's own Rageshake" approach floated earlier — neither
// the specific action name nor an existing Element-side listener for it
// could be verified to actually exist (checked matrix-widget-api's real
// source and Element's own docs/repo). This module only ever talks to
// CrewBoard's own already-verified send path.
import { sendMessage } from './matrixStore.js'
import { getRoomId } from './widget.js'
import { isCompanion } from './relay.js'
import { getUiScale } from './uiScale.js'

const MAX_ENTRIES = 200 // ring buffer size — plenty for "what just happened", bounded so a report never risks the ~65KB Matrix event content cap
const MAX_LINE_LEN = 500 // a single logged object/error dump shouldn't be able to eat the whole buffer's budget by itself

let buffer = []
let installed = false

// Scrubs the kinds of values CrewBoard otherwise goes out of its way to
// encrypt at rest (see api.js's *_ENC lists) OUT of anything captured here,
// on a best-effort basis — a stray console.log of a person/vehicle record
// during a failed API call is exactly the kind of thing that could leak
// what encryption elsewhere in this app is trying to protect. Not a
// guarantee (freeform strings can still contain a name, a note, etc.) —
// just removes the clearly-structured, clearly-sensitive patterns.
function redact(str) {
  if (typeof str !== 'string') return str
  return str
    .replace(/@[a-zA-Z0-9_.=/-]+:[a-zA-Z0-9.-]+/g, '@[matrix-id]')
    .replace(/mxc:\/\/\S+/g, 'mxc://[redacted]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]')
}

function stringifyArg(a) {
  if (typeof a === 'string') return a
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`
  try { return JSON.stringify(a) } catch { return String(a) }
}

function push(level, args) {
  try {
    const message = redact(args.map(stringifyArg).join(' ')).slice(0, MAX_LINE_LEN)
    buffer.push({ t: Date.now(), level, message })
    if (buffer.length > MAX_ENTRIES) buffer.shift()
  } catch {
    // Logging itself must never throw — a broken capture shouldn't take
    // down whatever real code path was trying to log something.
  }
}

/** Wraps console.log/warn/error and window's global error hooks to start
 *  filling the ring buffer. Call once, as early as possible (see main.jsx)
 *  so early-boot errors are captured too — safe to call more than once,
 *  only installs on the first call. */
export function installDiagnosticsCapture() {
  if (installed || typeof window === 'undefined') return
  installed = true

  const original = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args) => { push('log', args); original.log(...args) }
  console.warn = (...args) => { push('warn', args); original.warn(...args) }
  console.error = (...args) => { push('error', args); original.error(...args) }

  window.addEventListener('error', (e) => {
    push('error', [`Uncaught: ${e.message}`, e.filename ? `(${e.filename}:${e.lineno}:${e.colno})` : ''])
  })
  window.addEventListener('unhandledrejection', (e) => {
    push('error', ['Unhandled promise rejection:', e.reason?.message || e.reason])
  })
}

/** Current buffer + environment context, as structured data. */
export function getDiagnosticsBundle() {
  return {
    logs: buffer.slice(),
    meta: {
      ts: Date.now(),
      // Strip the hash — HashRouter puts widget URL params (roomId, baseUrl,
      // etc.) there, some of which aren't secrets but there's no reason to
      // include them verbatim in a report either.
      url: typeof window !== 'undefined' ? window.location.href.split('#')[0] : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      roomId: getRoomId(),
      mode: isCompanion ? 'companion window' : 'widget',
      uiScale: getUiScale(),
    },
  }
}

/** Plain-text rendering of a bundle — used for both the clipboard copy and
 *  the room-message send, so "what you copy" and "what you send" are
 *  always identical. */
export function formatDiagnosticsText(bundle) {
  const lines = [
    `CrewBoard diagnostics — ${new Date(bundle.meta.ts).toISOString()}`,
    `Room: ${bundle.meta.roomId || '—'}`,
    `Mode: ${bundle.meta.mode}`,
    `UI scale: ${bundle.meta.uiScale}`,
    `User agent: ${bundle.meta.userAgent}`,
    `URL: ${bundle.meta.url}`,
    '',
    bundle.logs.length === 0
      ? '(no console output captured yet this session)'
      : bundle.logs.map(l => `[${new Date(l.t).toISOString()}] ${l.level.toUpperCase()}  ${l.message}`).join('\n'),
  ]
  return lines.join('\n')
}

/** Copies the current bundle to the clipboard as plain text. Returns the
 *  text (so a caller can also show it/measure it), throws if the clipboard
 *  API is unavailable or denied. */
export async function copyDiagnosticsToClipboard() {
  const text = formatDiagnosticsText(getDiagnosticsBundle())
  await navigator.clipboard.writeText(text)
  return text
}

// Matrix events have roughly a 65KB content cap (see this repo's own
// CLAUDE.md on why room state was abandoned as a "database" for exactly
// this reason). MAX_ENTRIES/MAX_LINE_LEN already keep the buffer well under
// that in practice, but this is a hard backstop: if the formatted text is
// still too big, keep only the TAIL (most recent, most relevant to "what
// just happened") rather than fail the send or silently truncate from a
// less useful end.
const MAX_SEND_CHARS = 40000

/** Posts the current bundle into the room as a normal message — same
 *  sendMessage() path (and therefore same Megolm E2EE, if the room's
 *  encrypted — which CrewBoard already requires) every other chat message
 *  uses. `body` is a short "N log lines" summary, kept deliberately brief
 *  and human-readable for other clients/notifications — the full text goes
 *  in a dedicated `org.crewboard.diagnostics_text` content field.
 *  `msgtype: 'org.crewboard.diagnostic-report'` lets MatrixHub's EventRow
 *  render the full report specially (summary + Copy/Download), while the
 *  event still lands in `api.matrix.inbox()`'s plain `m.room.message` read
 *  — no new widget capability or event type needed. Viewing the full log
 *  is a CrewBoard-side feature (MatrixHub tab), not something plain Element
 *  needs to show inline. */
export async function sendDiagnosticsToRoom() {
  const bundle = getDiagnosticsBundle()
  let text = formatDiagnosticsText(bundle)
  if (text.length > MAX_SEND_CHARS) {
    text = `[...truncated, showing the most recent ${MAX_SEND_CHARS} characters...]\n` + text.slice(-MAX_SEND_CHARS)
  }
  return sendMessage(`🛠️ Diagnostics report (${bundle.logs.length} log lines) — open CrewBoard's Matrix Hub tab to view/copy/download`, {
    msgtype: 'org.crewboard.diagnostic-report',
    'org.crewboard.diagnostics_text': text,
    'org.crewboard.diagnostics_meta': bundle.meta,
    'org.crewboard.diagnostics_line_count': bundle.logs.length,
  })
}
