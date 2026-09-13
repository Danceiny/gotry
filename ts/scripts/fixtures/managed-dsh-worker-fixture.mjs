import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  const request = JSON.parse(line)
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { finalResponse: 'fixture', events: [{ grandchildPid: grandchild.pid }], notifications: [] } })}\n`)
})
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
