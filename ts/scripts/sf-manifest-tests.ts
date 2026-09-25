import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateSfManifest } from './sf-manifest.ts'

const dataRoot = join(import.meta.dirname, '..', 'data')
const queries = JSON.parse(readFileSync(join(dataRoot, 'session-golden-20.json'), 'utf8'))
const comparator = JSON.parse(readFileSync(join(dataRoot, 'sf-golden-manifest.json'), 'utf8'))
const expectedIds = Array.from({ length: 8 }, (_, i) => `sf-${String(i + 1).padStart(2, '0')}`)

const frozen = validateSfManifest(queries, comparator)
assert.deepEqual(frozen.map((q) => q.id), expectedIds)
assert.equal(comparator.query_manifest_sha256, '3be197830e5a6aa6e1309684a1fce4a736ad2a845c67b6f2f1b8a4ad3ccf977a')

function changedQuery(mutator: (copy: typeof queries) => void, reason: RegExp): void {
  const copy = structuredClone(queries)
  mutator(copy)
  assert.throws(() => validateSfManifest(copy, comparator), reason)
}

changedQuery((copy) => { copy.queries[0].to = '昆明' }, /frozen query digest/)
changedQuery((copy) => { copy.queries.splice(7, 1) }, /sf-01..08/)
changedQuery((copy) => { copy.queries.splice(8, 0, { id: 'sf-09', kind: 'flight', from: '上海', to: '北京', date: '2026-12-01' }) }, /sf-01..08/)
changedQuery((copy) => { [copy.queries[0], copy.queries[1]] = [copy.queries[1], copy.queries[0]] }, /sf-01..08/)

const wrongComparator = structuredClone(comparator)
wrongComparator.matches[0].to = '昆明'
assert.throws(() => validateSfManifest(queries, wrongComparator), /comparator query mismatch/)

const duplicateComparator = structuredClone(comparator)
duplicateComparator.matches[7].query_id = 'sf-07'
assert.throws(() => validateSfManifest(queries, duplicateComparator), /comparator query mismatch/)

const wrongDigest = { ...comparator, query_manifest_sha256: '0'.repeat(64) }
assert.throws(() => validateSfManifest(queries, wrongDigest), /frozen query digest/)
assert.throws(() => validateSfManifest(queries, { ...comparator, query_manifest_sha256: undefined }), /frozen query digest/)

console.log('SF MANIFEST FREEZE: eight exact queries, digest, comparator parity, and drift rejection OK')
