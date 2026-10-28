/**
 * Child process of tenant-state-tests.ts: races one lease acquisition against its
 * sibling processes on a shared SQLite lease file.
 *
 * argv: <lease db path> <go file> <lease key> <replica id> <ttl ms>
 * Prints "ready", waits for the go file, then prints one JSON line with the outcome.
 */

import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { LeaseHeldError } from '../src/tenant-state/errors.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'

const [dbPath, goFile, key, replicaId, ttl] = process.argv.slice(2)

const store = new SqliteLeaseStore({ path: dbPath })
process.stdout.write('ready\n')
while (!existsSync(goFile)) await sleep(2)

let outcome: Record<string, unknown>
try {
  const grant = await store.acquire(key, replicaId, Number(ttl))
  outcome = { replicaId, outcome: 'granted', epoch: grant.record.epoch }
} catch (error) {
  outcome = error instanceof LeaseHeldError
    ? { replicaId, outcome: 'held', epoch: error.record.epoch, owner: error.record.owner }
    : { replicaId, outcome: 'error', message: String(error) }
}
process.stdout.write(`${JSON.stringify(outcome)}\n`)
store.close()
