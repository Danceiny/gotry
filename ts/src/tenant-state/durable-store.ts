/**
 * Durable store of the AaaS state layer: where off-node copies of a tenant ledger live
 * (docs/rfc/aaas-rfc.md §4.3, decision Q4).
 *
 * The contract is the smallest an object store gives: create-if-absent, read, list by prefix
 * and delete by prefix. Create-if-absent is the only write, so an object is immutable once
 * it exists and a stale writer can never replace what a newer owner relies on. Epoch-conditional
 * appends (durability mode D-b) are a later refinement of the same primitive.
 *
 * Every call must settle. A binding gives each request a deadline and fails with `DurableStoreUnavailableError` when it
 * passes: the router renews a tenant's lease while a flush or a forget waits on the store, so a call that never returns
 * holds the tenant on its replica until the process dies.
 *
 * `DirDurableStore` is the reference implementation on a local directory. It stands in for the
 * S3-compatible store of the real deployment, whose binding must pass the same conformance
 * checks before it holds a real copy.
 */

import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DurableStoreUnavailableError } from './errors.ts'

export interface DurableStore {
  /** Creates the object only if the key is absent. Resolves false when it already exists. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>
  get(key: string): Promise<Uint8Array | null>
  /** Every key that starts with the prefix, sorted. */
  list(prefix: string): Promise<string[]>
  /**
   * Deletes every key that starts with the prefix and returns how many it deleted. The prefix is whole segments and ends
   * with `/`: a delete that stopped inside a name would take every neighbour that starts with the same letters.
   */
  deletePrefix(prefix: string): Promise<number>
}

const MAX_KEY_LENGTH = 512
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const PARTIAL_SEGMENT = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/

/** Keys are `/`-separated segments of `[A-Za-z0-9._-]` that do not start with a dot, so no key can leave the store or touch its scratch area. */
export function assertDurableKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || !key.split('/').every(segment => SEGMENT.test(segment))) {
    throw new RangeError(`invalid durable key ${JSON.stringify(typeof key === 'string' ? key.slice(0, 80) : key)}`)
  }
  return key
}

/** A prefix is complete segments followed by an optional partial one: `a/b/`, `a/b/snap-`, `a/b`. */
export function assertDurablePrefix(prefix: string): string {
  const segments = typeof prefix === 'string' ? prefix.split('/') : []
  const last = segments.pop()
  if (
    typeof prefix !== 'string' || prefix.length === 0 || prefix.length > MAX_KEY_LENGTH ||
    last === undefined || !PARTIAL_SEGMENT.test(last) || !segments.every(segment => SEGMENT.test(segment))
  ) {
    throw new RangeError(`invalid durable prefix ${JSON.stringify(typeof prefix === 'string' ? prefix.slice(0, 80) : prefix)}`)
  }
  return prefix
}

/** A prefix to delete by: complete segments, so `acme/` can never take `acme2/`. */
export function assertDurableDeletePrefix(prefix: string): string {
  assertDurablePrefix(prefix)
  if (!prefix.endsWith('/')) throw new RangeError(`a durable delete takes whole segments and ends with "/", got ${JSON.stringify(prefix.slice(0, 80))}`)
  return prefix
}

function code(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | null)?.code
  return typeof value === 'string' ? value : undefined
}

export class DirDurableStore implements DurableStore {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    assertDurableKey(key)
    const destination = this.pathOf(key)
    const scratch = join(this.root, '.tmp')
    const staged = join(scratch, randomBytes(8).toString('hex'))
    try {
      await mkdir(scratch, { recursive: true })
      await mkdir(dirname(destination), { recursive: true })
      const handle = await open(staged, 'wx')
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A hard link either creates the key with all its bytes or fails: a reader never sees a half-written object.
      await link(staged, destination)
      return true
    } catch (error) {
      if (code(error) === 'EEXIST') return false
      throw new DurableStoreUnavailableError(`durable put failed for ${key}`, { cause: error })
    } finally {
      await rm(staged, { force: true })
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertDurableKey(key)
    try {
      return await readFile(this.pathOf(key))
    } catch (error) {
      if (code(error) === 'ENOENT' || code(error) === 'EISDIR' || code(error) === 'ENOTDIR') return null
      throw new DurableStoreUnavailableError(`durable get failed for ${key}`, { cause: error })
    }
  }

  async list(prefix: string): Promise<string[]> {
    assertDurablePrefix(prefix)
    const slash = prefix.lastIndexOf('/')
    const directory = slash === -1 ? '' : prefix.slice(0, slash)
    const keys: string[] = []
    try {
      await this.walk(directory, keys)
    } catch (error) {
      throw new DurableStoreUnavailableError(`durable list failed for ${prefix}`, { cause: error })
    }
    return keys.filter(key => key.startsWith(prefix)).sort()
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertDurableDeletePrefix(prefix)
    const keys = await this.list(prefix)
    try {
      for (const key of keys) await rm(this.pathOf(key), { force: true })
      for (const directory of new Set(keys.map(key => dirname(key)))) await this.pruneEmptyDirectories(directory)
    } catch (error) {
      throw new DurableStoreUnavailableError(`durable delete failed for ${prefix}`, { cause: error })
    }
    return keys.length
  }

  private pathOf(key: string): string {
    return join(this.root, ...key.split('/'))
  }

  private async walk(directory: string, into: string[]): Promise<void> {
    let entries
    try {
      entries = await readdir(directory === '' ? this.root : this.pathOf(directory), { withFileTypes: true })
    } catch (error) {
      if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return
      throw error
    }
    for (const entry of entries) {
      if (directory === '' && entry.name === '.tmp') continue
      const child = directory === '' ? entry.name : `${directory}/${entry.name}`
      if (entry.isDirectory()) await this.walk(child, into)
      else into.push(child)
    }
  }

  private async pruneEmptyDirectories(directory: string): Promise<void> {
    for (let current = directory; current !== '.' && current !== ''; current = dirname(current)) {
      try {
        await rmdir(this.pathOf(current))
      } catch {
        return
      }
    }
  }
}
