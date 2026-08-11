import { Router } from 'express'
import { changes } from '../notify.js'

const router = Router()

// Server-Sent Events stream of {table, op, id} — one line per Postgres
// NOTIFY (see notify.js/db.js's triggers). Deliberately doesn't push actual
// row content, just "something changed" — the client re-fetches via the
// normal REST routes, which also re-runs the client-side joins in api.js
// rather than needing to duplicate that logic here.
router.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: don't buffer this response
  })
  res.write('\n')

  const onChange = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  changes.on('change', onChange)

  // Keep the connection from being reaped by an idle-timeout somewhere in
  // the chain (browser, nginx-ingress, this Express server) — SSE comments
  // (lines starting with `:`) are ignored by EventSource but reset idle
  // timers along the way.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000)

  req.on('close', () => {
    clearInterval(keepAlive)
    changes.off('change', onChange)
  })
})

export default router
