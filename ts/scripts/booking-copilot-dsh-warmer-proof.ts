/** Real default-warmer lifecycle proof: close owns both blocked SDK trees. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRealRunPort, type DshPlannerRunPort } from '../src/booking-surface/dsh-planner.ts'

const root = mkdtempSync(join(tmpdir(), 'gotry-warmer-proof-'))
const priorTmpdir = process.env.TMPDIR
process.env.TMPDIR = root
const markerDir = join(root, 'markers')
const releaseFile = join(root, 'release')
mkdirSync(markerDir, { recursive: true })
const actualBin = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))), 'lib/bin.js')).href
const gateBin = join(root, 'blocked-dsh.mjs')
writeFileSync(gateBin, `
import { existsSync, writeFileSync } from 'node:fs'
const marker = ${JSON.stringify(markerDir)} + '/gate-' + process.pid + '.json'
writeFileSync(marker, JSON.stringify({ pid: process.pid, workerPid: process.ppid }))
while (!existsSync(${JSON.stringify(releaseFile)})) await new Promise((resolve) => setTimeout(resolve, 10))
const { runCli } = await import(${JSON.stringify(actualBin)})
await runCli()
`)

const requests: string[] = []
const sockets = new Set<import('node:net').Socket>()
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (part: Buffer) => { body += part.toString('utf8') })
  req.on('end', () => {
    requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
  })
})
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address !== 'string')

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

const scratchBefore = new Set(readdirSync(root).filter((name) => name.startsWith('gotry-booking-dsh-')))
let port: DshPlannerRunPort | undefined
let warmup: Promise<void> | undefined
let gatePids: Array<{ pid: number; workerPid: number }> = []
try {
  assert.notEqual(process.env.GOTRY_BOOKING_COPILOT_WARMUP, '0', 'proof must exercise the default warmer')
  port = await createRealRunPort({
    stateRoot: root,
    env: {
      PATH: process.env.PATH,
      DEEPSEEK_API_KEY: 'fixture-model-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    },
    dshBin: gateBin,
    maxTokens: 512,
  })
  const warmScratch = readdirSync(root).filter((name) => name.startsWith('gotry-booking-dsh-') && !scratchBefore.has(name))
  assert.equal(warmScratch.length, 1, 'real port owns one scratch directory')
  // The default warmer is already running; start the returned port too so the
  // close proof observes both independent worker/runtime trees.
  warmup = port.warmup!()
  void warmup.catch(() => undefined)
  await until(() => readdirSync(markerDir).length >= 2, 5_000, 'both real dsh startup gates did not start')
  gatePids = readdirSync(markerDir).map((name) => JSON.parse(readFileSync(join(markerDir, name), 'utf8')) as { pid: number; workerPid: number })
  assert.equal(gatePids.length, 2, 'default warmer and actual port each started one runtime')
  assert.equal(requests.length, 0, 'blocked initialize made no provider requests')

  const closeStarted = Date.now()
  const closePromise = port.close()
  assert.strictEqual(port.close(), closePromise, 'repeated close returns the same cleanup promise')
  await bounded(closePromise, 5_000, 'port close did not settle within its cleanup bound')
  assert.ok(Date.now() - closeStarted < 5_000, 'port close remains bounded')
  assert.ok(gatePids.every(({ pid, workerPid }) => !alive(pid) && !alive(workerPid)), 'close reaps both blocked runtime trees before returning')
  await assert.rejects(
    bounded(warmup!, 1_000, 'actual port warmup did not settle after close'),
    /managed DSH run port closed/,
    'close rejects the in-flight actual-port warmup',
  )
  const scratchAfter = readdirSync(root).filter((name) => name.startsWith('gotry-booking-dsh-') && !scratchBefore.has(name))
  assert.equal(scratchAfter.length, 0, 'close removes scratch only after both trees stop')
  assert.equal(requests.length, 0, 'close proof made zero provider requests')
  console.log('DSH WARMER LIFECYCLE PROOF: default warmer and actual port both close, reap, and clean scratch')
} finally {
  // Release any old-code detached warmer so a red run does not leave a gate
  // alive after the assertion has captured the lifecycle regression.
  writeFileSync(releaseFile, 'release')
  await Promise.allSettled([port?.close(), warmup])
  if (gatePids.length) {
    await until(() => gatePids.every(({ pid, workerPid }) => !alive(pid) && !alive(workerPid)), 5_000, 'observed gate trees did not exit during proof cleanup')
  }
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (priorTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = priorTmpdir
  rmSync(root, { recursive: true, force: true })
}
