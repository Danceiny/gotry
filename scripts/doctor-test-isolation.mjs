// Test-only Node preload. Temporary HOME isolates files, not TCP ports.
// Redirect just the doctor's GET /status probes away from production bridges;
// Offline cases create no socket at all.
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'

const get = http.get
http.get = function (options, ...rest) {
  if (options?.hostname === '127.0.0.1' && options.path === '/status'
      && [8791, 8792, 8793, 8794, 8795].includes(options.port)) {
    const port = Number(process.env.GOTRY_TEST_DOCTOR_PORT || 0)
    if (port > 0) return get.call(this, { ...options, port }, ...rest)
    const request = new EventEmitter()
    request.destroy = () => request
    queueMicrotask(() => request.emit('error', new Error('isolated offline doctor probe')))
    return request
  }
  return get.call(this, options, ...rest)
}
syncBuiltinESMExports()
