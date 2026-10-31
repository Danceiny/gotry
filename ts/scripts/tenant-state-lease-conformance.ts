/**
 * Conformance checks for any LeaseStore binding (AaaS A1, docs/rfc/aaas-rfc.md §4.2).
 *
 * The reference SQLite store runs them offline against a fake clock. The hotel-be
 * MySQL binding of decision Q3 must pass the same checks before it holds a real
 * lease, with `advance` backed by a real sleep. A failed check is returned, not
 * thrown, so a suite can also prove the checks themselves can fail by running them
 * against deliberately broken stores.
 */

import { LeaseHeldError, LeaseLostError } from '../src/tenant-state/errors.ts'
import type { LeaseStore } from '../src/tenant-state/lease-store.ts'

export interface LeaseStoreSubject {
  readonly store: LeaseStore
  /** Moves the store's clock forward: a fake clock in offline runs, a real sleep for a networked store. */
  advance(ms: number): Promise<void> | void
  /** The store's current time, on the same scale as `leaseUntilMs`. */
  now(): number
}

export interface ConformanceFailure {
  readonly check: string
  readonly detail: string
}

const TTL = 1_000

class Violation extends Error {}

function expect(condition: unknown, detail: string): void {
  if (!condition) throw new Violation(detail)
}

async function expectRejects<T extends Error>(run: () => Promise<unknown>, type: new (...args: never[]) => T, detail: string): Promise<T> {
  try {
    await run()
  } catch (error) {
    if (error instanceof type) return error
    throw new Violation(`${detail}: threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
  throw new Violation(`${detail}: did not throw`)
}

export async function runLeaseStoreConformance(subject: LeaseStoreSubject, namespace: string): Promise<ConformanceFailure[]> {
  const { store } = subject
  const failures: ConformanceFailure[] = []
  let sequence = 0

  async function check(name: string, body: (key: string) => Promise<void>): Promise<void> {
    sequence += 1
    try {
      await body(`${namespace}/check-${sequence}`)
    } catch (error) {
      failures.push({ check: name, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  await check('first acquire grants epoch 1', async (key) => {
    expect(await store.read(key) === null, 'an unknown key reads as null')
    const grant = await store.acquire(key, 'a', TTL)
    expect(grant.record.epoch === 1, `epoch ${grant.record.epoch}`)
    expect(grant.record.owner === 'a' && grant.record.key === key, 'owner and key echo the request')
    expect(grant.ttlMs === TTL, `granted ttl ${grant.ttlMs}`)
    expect(grant.record.leaseUntilMs > subject.now(), 'the lease ends in the future')
    expect(grant.record.forgottenAtEpoch === 0, 'nothing is forgotten yet')
    expect(JSON.stringify(await store.read(key)) === JSON.stringify(grant.record), 'read returns the granted record')
  })

  await check('acquire is refused while another unexpired lease exists', async (key) => {
    await store.acquire(key, 'a', TTL)
    const held = await expectRejects(() => store.acquire(key, 'b', TTL), LeaseHeldError, 'a second owner must be refused')
    expect(held.record.owner === 'a' && held.record.epoch === 1, 'the refusal names the current holder')
  })

  await check('acquire is refused for the current holder too', async (key) => {
    await store.acquire(key, 'a', TTL)
    await expectRejects(() => store.acquire(key, 'a', TTL), LeaseHeldError, 'a holder must renew, not re-acquire')
  })

  await check('renew keeps the epoch and extends the lease', async (key) => {
    const first = await store.acquire(key, 'a', TTL)
    await subject.advance(TTL / 2)
    const renewed = await store.renew(key, 'a', 1, TTL)
    expect(renewed.record.epoch === 1, `epoch ${renewed.record.epoch}`)
    expect(renewed.record.leaseUntilMs > first.record.leaseUntilMs, 'the lease end moved forward')
  })

  await check('renew by another owner or for another epoch is refused', async (key) => {
    await store.acquire(key, 'a', TTL)
    await expectRejects(() => store.renew(key, 'b', 1, TTL), LeaseLostError, 'foreign owner')
    await expectRejects(() => store.renew(key, 'a', 2, TTL), LeaseLostError, 'foreign epoch')
    await expectRejects(() => store.renew(`${key}-unknown`, 'a', 1, TTL), LeaseLostError, 'unknown key')
    await store.renew(key, 'a', 1, TTL)
  })

  await check('an expired lease is taken at epoch + 1 and the old holder is refused everywhere', async (key) => {
    await store.acquire(key, 'a', TTL)
    await subject.advance(TTL + 1)
    const taken = await store.acquire(key, 'b', TTL)
    expect(taken.record.epoch === 2 && taken.record.owner === 'b', `epoch ${taken.record.epoch} owner ${taken.record.owner}`)
    await expectRejects(() => store.renew(key, 'a', 1, TTL), LeaseLostError, 'stale renew')
    await expectRejects(() => store.release(key, 'a', 1), LeaseLostError, 'stale release')
    await expectRejects(() => store.markForgotten(key, 'a', 1), LeaseLostError, 'stale forget')
    await store.renew(key, 'b', 2, TTL)
  })

  await check('renewing after expiry is refused even when nobody took over', async (key) => {
    await store.acquire(key, 'a', TTL)
    await subject.advance(TTL + 1)
    await expectRejects(() => store.renew(key, 'a', 1, TTL), LeaseLostError, 'an expired lease cannot be revived')
    const again = await store.acquire(key, 'a', TTL)
    expect(again.record.epoch === 2, `re-acquire after expiry starts epoch ${again.record.epoch}`)
  })

  await check('release expires the lease at once and keeps the epoch', async (key) => {
    await store.acquire(key, 'a', TTL)
    const released = await store.release(key, 'a', 1)
    expect(released.epoch === 1, `epoch ${released.epoch}`)
    expect(released.leaseUntilMs <= subject.now(), 'the lease is already over')
    const next = await store.acquire(key, 'b', TTL)
    expect(next.record.epoch === 2, `the next owner starts epoch ${next.record.epoch} with no waiting`)
  })

  await check('a stale release changes nothing', async (key) => {
    await store.acquire(key, 'a', TTL)
    await subject.advance(TTL + 1)
    await store.acquire(key, 'b', TTL)
    await expectRejects(() => store.release(key, 'a', 1), LeaseLostError, 'stale release')
    const held = await expectRejects(() => store.acquire(key, 'c', TTL), LeaseHeldError, 'b still holds')
    expect(held.record.owner === 'b' && held.record.epoch === 2, 'the stale release did not touch the live lease')
  })

  await check('epochs strictly increase and never repeat', async (key) => {
    const epochs: number[] = []
    for (let round = 0; round < 6; round += 1) {
      const owner = round % 2 === 0 ? 'a' : 'b'
      const grant = await store.acquire(key, owner, TTL)
      epochs.push(grant.record.epoch)
      if (round % 3 === 2) await store.release(key, owner, grant.record.epoch)
      else await subject.advance(TTL + 1)
    }
    expect(epochs.join(',') === '1,2,3,4,5,6', `epochs ${epochs.join(',')}`)
  })

  await check('forget records a floor that survives the next acquisition', async (key) => {
    await store.acquire(key, 'a', TTL)
    await expectRejects(() => store.markForgotten(key, 'b', 1), LeaseLostError, 'only the holder may forget')
    const marked = await store.markForgotten(key, 'a', 1)
    expect(marked.forgottenAtEpoch === 1, `floor ${marked.forgottenAtEpoch}`)
    await store.release(key, 'a', 1)
    const next = await store.acquire(key, 'b', TTL)
    expect(next.record.epoch === 2 && next.record.forgottenAtEpoch === 1, `epoch ${next.record.epoch} floor ${next.record.forgottenAtEpoch}`)
  })

  await check('forget needs a live lease', async (key) => {
    await store.acquire(key, 'a', TTL)
    await subject.advance(TTL + 1)
    await expectRejects(() => store.markForgotten(key, 'a', 1), LeaseLostError, 'an expired holder cannot forget')
  })

  await check('ttl outside the bounds is rejected', async (key) => {
    await expectRejects(() => store.acquire(key, 'a', 1), RangeError, 'ttl below the minimum')
    await expectRejects(() => store.acquire(key, 'a', 24 * 3_600_000), RangeError, 'ttl above the maximum')
    await expectRejects(() => store.acquire(key, 'a', 1_000.5), RangeError, 'fractional ttl')
    expect(await store.read(key) === null, 'a rejected request leaves no record')
  })

  return failures
}
