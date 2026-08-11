import crypto from 'node:crypto'

let counter = 1

/** Same "cb-<ts36>-<counter36>" shape the frontend used to generate
 *  client-side (matrixStore.js's newId()) — generated server-side now so
 *  concurrent requests from different browsers can never collide. Adds a
 *  short random suffix on top of the counter for the same reason (this
 *  process could restart and reset the in-memory counter to 1). */
export function newId() {
  const rand = crypto.randomBytes(3).toString('hex')
  return `cb-${Date.now().toString(36)}-${(counter++).toString(36)}-${rand}`
}
