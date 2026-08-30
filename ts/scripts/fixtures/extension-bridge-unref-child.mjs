import {
  createSessionBridge,
  EXTENSION_ORIGIN,
} from '../../capabilities/session/extension-bridge.ts'

const created = await createSessionBridge({ ports: [0], extensionOrigin: EXTENSION_ORIGIN })
if (!created.ok) {
  process.send?.({ kind: 'error', summary: created.summary })
  process.exit(1)
}

// Parent first parks an external /jobs request, then releases this sole
// intentional event-loop reference. The default bridge must not keep the
// child alive after that point.
const hold = setInterval(() => {}, 60_000)
process.send?.({ kind: 'listening', port: created.bridge.port })
process.once('message', (message) => {
  if (typeof message !== 'object' || message === null || !('kind' in message) || message.kind !== 'release') return
  clearInterval(hold)
  process.disconnect?.()
})
