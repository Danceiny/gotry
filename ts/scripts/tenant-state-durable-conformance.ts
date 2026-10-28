/**
 * Conformance checks for any DurableStore binding (AaaS A1, docs/rfc/aaas-rfc.md §4.3).
 *
 * The reference directory store runs them offline. The S3-compatible binding of decision Q4 must pass
 * the same checks before it holds a real copy. A failed check is returned, not thrown, so a suite can
 * also prove the checks themselves can fail against deliberately broken stores.
 */

import type { DurableStore } from '../src/tenant-state/durable-store.ts'

export interface DurableConformanceFailure {
  readonly check: string
  readonly detail: string
}

class Violation extends Error {}

function expect(condition: unknown, detail: string): void {
  if (!condition) throw new Violation(detail)
}

function text(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString('utf8')
}

async function expectRangeError(run: () => Promise<unknown>, detail: string): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (error instanceof RangeError) return
    throw new Violation(`${detail}: threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
  throw new Violation(`${detail}: did not throw`)
}

export async function runDurableStoreConformance(store: DurableStore, namespace: string): Promise<DurableConformanceFailure[]> {
  const failures: DurableConformanceFailure[] = []
  let sequence = 0

  async function check(name: string, body: (prefix: string) => Promise<void>): Promise<void> {
    sequence += 1
    try {
      await body(`${namespace}/check-${sequence}`)
    } catch (error) {
      failures.push({ check: name, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  await check('put creates an absent key and never overwrites an existing one', async (prefix) => {
    expect(await store.putIfAbsent(`${prefix}/a`, Buffer.from('first')) === true, 'the first put creates')
    expect(await store.putIfAbsent(`${prefix}/a`, Buffer.from('second')) === false, 'the second put reports the key exists')
    expect(text(await store.get(`${prefix}/a`)) === 'first', 'the first bytes survive')
  })

  await check('an unknown key reads as null', async (prefix) => {
    expect(await store.get(`${prefix}/missing`) === null, 'get of an unknown key')
  })

  await check('bytes round-trip exactly, including a large object', async (prefix) => {
    const payload = Buffer.alloc(1_048_576 + 3)
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 7) & 0xff
    expect(await store.putIfAbsent(`${prefix}/big.bin`, payload) === true, 'put')
    const back = await store.get(`${prefix}/big.bin`)
    expect(back !== null && Buffer.compare(Buffer.from(back), payload) === 0, 'the same 1 MiB + 3 bytes come back')
  })

  await check('list returns sorted keys under a prefix, including a partial last segment', async (prefix) => {
    for (const name of ['snap-2.db', 'snap-1.db', 'snap-1.json', 'base.json']) await store.putIfAbsent(`${prefix}/e1/${name}`, Buffer.from(name))
    await store.putIfAbsent(`${prefix}/e2/snap-1.db`, Buffer.from('x'))
    const all = await store.list(`${prefix}/`)
    expect(all.length === 5, `all five under the prefix, got ${all.length}`)
    expect(JSON.stringify(all) === JSON.stringify([...all].sort()), 'sorted')
    const partial = await store.list(`${prefix}/e1/snap-`)
    expect(JSON.stringify(partial) === JSON.stringify([`${prefix}/e1/snap-1.db`, `${prefix}/e1/snap-1.json`, `${prefix}/e1/snap-2.db`]), `partial prefix: ${JSON.stringify(partial)}`)
    expect((await store.list(`${prefix}/nothing/`)).length === 0, 'an empty prefix lists nothing')
  })

  await check('delete removes exactly the keys under the prefix and counts them', async (prefix) => {
    await store.putIfAbsent(`${prefix}/keep/a`, Buffer.from('a'))
    for (const name of ['x', 'y', 'z']) await store.putIfAbsent(`${prefix}/gone/${name}`, Buffer.from(name))
    expect(await store.deletePrefix(`${prefix}/gone/`) === 3, 'three deleted')
    expect((await store.list(`${prefix}/gone/`)).length === 0, 'nothing left under the prefix')
    expect(text(await store.get(`${prefix}/keep/a`)) === 'a', 'a sibling is untouched')
    expect(await store.deletePrefix(`${prefix}/gone/`) === 0, 'deleting again deletes nothing')
    expect(await store.putIfAbsent(`${prefix}/gone/x`, Buffer.from('again')) === true, 'a deleted key can be created again')
  })

  await check('sixteen concurrent puts of one key create it exactly once with intact bytes', async (prefix) => {
    const contenders = Array.from({ length: 16 }, (_, index) => Buffer.from(`contender-${index}-${'x'.repeat(4096)}`))
    const results = await Promise.all(contenders.map(bytes => store.putIfAbsent(`${prefix}/race`, bytes)))
    expect(results.filter(Boolean).length === 1, `${results.filter(Boolean).length} puts reported creating the key`)
    const stored = await store.get(`${prefix}/race`)
    expect(stored !== null && contenders.some(bytes => Buffer.compare(bytes, Buffer.from(stored)) === 0), 'the stored bytes are exactly one contender')
  })

  await check('keys that could leave the store or touch its scratch area are rejected', async (prefix) => {
    for (const bad of ['', '/', 'a//b', '../x', `${prefix}/../x`, '.tmp/x', `${prefix}/.hidden`, 'a b', 'a/\u0000b']) {
      await expectRangeError(() => store.putIfAbsent(bad, Buffer.from('x')), `put ${JSON.stringify(bad)}`)
      await expectRangeError(() => store.get(bad), `get ${JSON.stringify(bad)}`)
    }
    await expectRangeError(() => store.list('../'), 'list ../')
    await expectRangeError(() => store.deletePrefix(''), 'delete of the empty prefix')
  })

  return failures
}
