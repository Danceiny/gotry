import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { EXPECTED_QUERY_IDS } from './sf-summary.ts'

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(tsRoot, 'scripts', 'sf-summary.ts')

function record(queryId: string, batch: string, startedAt: string, source: 'manual' | 'static' | 'unknown', verdict: 'hit' | 'error' = 'hit'): Record<string, unknown> {
  const isStatic = source === 'static'
  const effective = source === 'manual' ? 'manual-golden' : isStatic ? 'static-openflights+manual-band' : 'vendor-x'
  return {
    query_id: queryId,
    expected: { from: 'SYN', to: 'DST', date: '2026-10-01', kind: 'flight' },
    requested_source: isStatic ? 'static' : source === 'manual' ? 'manual' : 'vendor-x',
    effective_source: effective,
    fallback_reason: isStatic && verdict === 'error' ? 'synthetic static route error' : null,
    official_source: effective,
    official_provenance: { source: 'synthetic fixture', batch },
    manifest_sha256: `sha256:${batch}`,
    batch_id: batch.startsWith('explicit-') ? batch : undefined,
    started_at: startedAt,
    official: { source: effective, verdict, latency_ms: 1 },
    session: { verdict, price: verdict === 'hit' ? 100 : 0, route_segments: [], fetched_at: startedAt },
    doubleSource: { state: 'comparable', mismatches: [] },
    softScore: null,
    sessionLatencyMs: 100,
    sessionError: verdict === 'error' ? 'synthetic error' : null,
  }
}

function writeJson(root: string, queryId: string, filename: string, value: unknown): void {
  const directory = join(root, queryId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, filename), JSON.stringify(value, null, 2))
}

function writeRaw(root: string, queryId: string, filename: string, value: string): void {
  const directory = join(root, queryId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, filename), value)
}

function writeBatch(root: string, filename: string, batch: string, source: 'manual' | 'static' | 'unknown' = 'manual', verdict: 'hit' | 'error' = 'hit'): void {
  EXPECTED_QUERY_IDS.forEach((queryId, index) => {
    const second = (index + 1).toString().padStart(2, '0')
    writeJson(root, queryId, filename, record(queryId, batch, `2026-09-09T10:00:${second}.000Z`, source, verdict))
  })
}

function runCli(root: string, scriptPath: string = cliPath): { exit: number; output: string; summary: Record<string, any> } {
  mkdirSync(join(root, 'home'), { recursive: true })
  const result = spawnSync(process.execPath, [scriptPath, '--evidence-root', root], {
    cwd: tsRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(root, 'home'),
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
    },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const pathMatch = /summary: (.+)/.exec(output)
  assert.ok(pathMatch, `CLI must print its output path\n${output}`)
  const summary = JSON.parse(readFileSync(pathMatch[1]!.trim(), 'utf8')) as Record<string, any>
  return { exit: result.status ?? -1, output, summary }
}

function runCliArgs(scriptPath: string, root: string, extraArgs: string[]): { exit: number; output: string } {
  mkdirSync(join(root, 'home'), { recursive: true })
  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    cwd: tsRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(root, 'home'),
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
    },
  })
  return { exit: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function makeSymlinkFixtures(): { fileLink: string; dirLink: string } {
  const base = mkdtempSync(join(tmpdir(), 'gotry-sf420-symlink-'))
  const fileLink = join(base, 'sf-summary-file-link.ts')
  const dirLink = join(base, 'sf-summary-dir-link')
  symlinkSync(cliPath, fileLink)
  symlinkSync(join(tsRoot, 'scripts'), dirLink, 'dir')
  return { fileLink, dirLink }
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gotry-sf-summary-e2e-'))
}

const roots: string[] = []
try {
  // One canonical filename is one legacy batch, even though each producer
  // record has a different per-query started_at.
  const coherentRoot = freshRoot()
  roots.push(coherentRoot)
  writeBatch(coherentRoot, '2026-09-09T10-00-00-000Z.json', 'manual-batch')
  const coherent = runCli(coherentRoot)
  assert.equal(coherent.exit, 0, coherent.output)
  assert.equal(coherent.summary.status, 'ok')
  assert.equal(coherent.summary.total, 8)
  assert.equal(coherent.summary.selected_batch.batch_id, '2026-09-09T10-00-00-000Z')
  assert.equal(coherent.summary.selected_batch.identity_source, 'canonical_filename')
  assert.equal(coherent.summary.started_at, '2026-09-09T10:00:00.000Z')
  assert.notEqual(coherent.summary.generated_at, coherent.summary.started_at)
  assert.equal(new Set(coherent.summary.records.map((item: any) => item.started_at)).size, 8)

  // A newer static/error batch wins over an older manual hit and remains in
  // the static bucket. An unsupported source is visible as unknown, never
  // silently reclassified as FlyAI.
  const sourceRoot = freshRoot()
  roots.push(sourceRoot)
  writeJson(sourceRoot, 'sf-01', '2026-01-01T10-00-00-000Z.json', record('sf-01', 'old-manual', '2026-01-01T10:00:01.000Z', 'manual', 'hit'))
  writeBatch(sourceRoot, '2026-09-10T10-00-00-000Z.json', 'new-static', 'static', 'error')
  writeJson(sourceRoot, 'sf-03', '2026-09-10T10-00-00-000Z.json', { ...record('sf-03', 'new-static', '2026-09-09T10:00:03.000Z', 'unknown', 'error'), requested_source: 'vendor-x', effective_source: 'vendor-x', official_source: 'vendor-x' })
  const source = runCli(sourceRoot)
  assert.equal(source.exit, 0, source.output)
  const sourceQ1 = source.summary.records.find((item: any) => item.query_id === 'sf-01')
  assert.equal(sourceQ1.effective_source, 'static-openflights+manual-band')
  assert.equal(sourceQ1.session_verdict, 'error')
  assert.deepEqual(source.summary.sources.manual_golden_query_ids, [])
  assert.ok(source.summary.sources.static_query_ids.includes('sf-01'))
  assert.ok(source.summary.sources.unknown_query_ids.includes('sf-03'))
  assert.deepEqual(source.summary.sources.flyai_query_ids, [])
  assert.equal(sourceQ1.requested_source, 'static')
  assert.equal(sourceQ1.fallback_reason, 'synthetic static route error')
  assert.deepEqual(sourceQ1.official_provenance, { source: 'synthetic fixture', batch: 'new-static' })
  assert.equal(sourceQ1.manifest_sha256, 'sha256:new-static')

  // A newest incomplete/corrupt filename batch is selected before JSON
  // parsing can discard it; the older complete manual batch is not a fallback.
  const corruptRoot = freshRoot()
  roots.push(corruptRoot)
  writeBatch(corruptRoot, '2026-01-01T10-00-00-000Z.json', 'old-complete', 'manual', 'hit')
  const newest = '2026-09-11T10-00-00-000Z.json'
  EXPECTED_QUERY_IDS.slice(0, 7).forEach((queryId, index) => writeJson(corruptRoot, queryId, newest, record(queryId, 'new-incomplete', `2026-09-11T10:00:0${index + 1}.000Z`, 'static', 'error')))
  writeRaw(corruptRoot, 'sf-08', newest, '{ corrupt json')
  const corrupt = runCli(corruptRoot)
  assert.equal(corrupt.exit, 1, corrupt.output)
  assert.equal(corrupt.summary.status, 'fail_closed')
  assert.equal(corrupt.summary.selected_batch.batch_id, '2026-09-11T10-00-00-000Z')
  assert.ok(corrupt.summary.missing_query_ids.includes('sf-08'))
  assert.ok(corrupt.summary.selected_malformed_records.some((item: any) => item.file === `sf-08/${newest}`))
  assert.equal(corrupt.summary.records.find((item: any) => item.query_id === 'sf-01').effective_source, 'static-openflights+manual-band')

  // A malformed old batch is diagnostic only when a newer complete batch is
  // independently reportable.
  const oldCorruptRoot = freshRoot()
  roots.push(oldCorruptRoot)
  writeRaw(oldCorruptRoot, 'sf-01', '2026-01-01T10-00-00-000Z.json', '{ old corrupt')
  writeBatch(oldCorruptRoot, '2026-09-12T10-00-00-000Z.json', 'new-complete', 'manual', 'hit')
  const oldCorrupt = runCli(oldCorruptRoot)
  assert.equal(oldCorrupt.exit, 0, oldCorrupt.output)
  assert.equal(oldCorrupt.summary.selected_malformed_records.length, 0)
  assert.equal(oldCorrupt.summary.malformed_records.length, 1)

  // Historical records without a canonical filename or valid explicit batch
  // capture time remain visible unmatched and cannot become the batch.
  const legacyRoot = freshRoot()
  roots.push(legacyRoot)
  writeBatch(legacyRoot, '2026-09-13T10-00-00-000Z.json', 'new-complete', 'manual', 'hit')
  writeJson(legacyRoot, 'sf-01', 'legacy.json', { ...record('sf-01', 'legacy', '2020-01-01T00:00:00.000Z', 'manual', 'hit'), batch_id: undefined, started_at: undefined })
  const legacy = runCli(legacyRoot)
  assert.equal(legacy.exit, 0, legacy.output)
  assert.equal(legacy.summary.selected_batch.batch_id, '2026-09-13T10-00-00-000Z')
  assert.ok(legacy.summary.unknown_batch_records.some((item: any) => item.file === 'sf-01/legacy.json'))
  assert.equal(legacy.summary.records.find((item: any) => item.query_id === 'sf-01').batch_id, '2026-09-13T10-00-00-000Z')

  // A complete eight-record batch with structured challenge, legacy top-level challenged, and guard
  // evidence must still fail closed; zero missing IDs prevents missing-record errors from masking the
  // new challenge/guard error condition.
  const challengeRoot = freshRoot()
  roots.push(challengeRoot)
  const challengeBatch = '2026-09-14T10-00-00-000Z.json'
  writeJson(challengeRoot, 'sf-01', challengeBatch, record('sf-01', 'challenge-batch', '2026-09-14T10:00:01.000Z', 'manual', 'hit'))
  writeJson(challengeRoot, 'sf-02', challengeBatch, {
    ...record('sf-02', 'challenge-batch', '2026-09-14T10:00:02.000Z', 'manual', 'hit'),
    session: { verdict: 'challenged', price: 0, route_segments: [], fetched_at: '2026-09-14T10:00:02.000Z' },
    doubleSource: { state: 'challenge_stop', quota_disposition: 'no_spend_stop', mismatches: [] },
  })
  writeJson(challengeRoot, 'sf-03', challengeBatch, {
    ...record('sf-03', 'challenge-batch', '2026-09-14T10:00:03.000Z', 'manual', 'hit'),
    session: { verdict: 'error', price: 0, route_segments: [], fetched_at: '2026-09-14T10:00:03.000Z' },
    sessionVerdict: 'challenged',
    doubleSource: { state: 'source_unavailable', quota_disposition: 'no_spend_stop', mismatches: [] },
  })
  writeJson(challengeRoot, 'sf-04', challengeBatch, {
    ...record('sf-04', 'challenge-batch', '2026-09-14T10:00:04.000Z', 'manual', 'hit'),
    session: { verdict: 'error', price: 0, route_segments: [], fetched_at: '2026-09-14T10:00:04.000Z' },
    doubleSource: { state: 'guard_violation', quota_disposition: 'no_spend_stop', mismatches: [] },
  })
  EXPECTED_QUERY_IDS.slice(4).forEach((queryId, index) => {
    const second = (index + 5).toString().padStart(2, '0')
    writeJson(challengeRoot, queryId, challengeBatch, record(queryId, 'challenge-batch', `2026-09-14T10:00:${second}.000Z`, 'manual', 'hit'))
  })
  const challenge = runCli(challengeRoot)
  assert.equal(challenge.exit, 1, challenge.output)
  assert.equal(challenge.summary.status, 'fail_closed')
  assert.equal(challenge.summary.challenge_stop_detected, true)
  assert.equal(challenge.summary.total, 8)
  assert.deepEqual(challenge.summary.missing_query_ids, [])
  assert.ok(challenge.summary.errors.some((error: string) => error.includes('challenge/guard stop evidence')))

  // Issue #420 — symlink-path entrypoint guard: the same Node invocation
  // through a temporary file symlink and a temporary parent-directory
  // symlink must reach main() and produce identical results to the canonical
  // path. The symlinks are real symlinks (not pre-canonicalized); the caller
  // passes the symlink path itself and Node receives it as argv[1].

  const symlinkFixture = freshRoot()
  roots.push(symlinkFixture)
  const { fileLink, dirLink } = makeSymlinkFixtures()
  roots.push(resolve(fileLink, '..'))
  roots.push(resolve(dirLink, '..'))

  writeBatch(symlinkFixture, '2026-09-15T10-00-00-000Z.json', 'symlink-batch')
  const coherentCanonical = runCli(symlinkFixture)
  assert.equal(coherentCanonical.exit, 0, coherentCanonical.output)
  const coherentFileLink = runCli(symlinkFixture, fileLink)
  const coherentDirLink = runCli(symlinkFixture, join(dirLink, 'sf-summary.ts'))

  for (const variant of [coherentFileLink, coherentDirLink]) {
    assert.equal(variant.exit, 0, variant.output)
    assert.equal(variant.summary.status, coherentCanonical.summary.status)
    assert.equal(variant.summary.total, coherentCanonical.summary.total)
    assert.equal(variant.summary.selected_batch.batch_id, coherentCanonical.summary.selected_batch.batch_id)
    assert.equal(variant.summary.selected_batch.identity_source, coherentCanonical.summary.selected_batch.identity_source)
    assert.deepEqual(
      variant.summary.records.map((record: any) => record.query_id),
      coherentCanonical.summary.records.map((record: any) => record.query_id),
    )
    assert.deepEqual(
      variant.summary.records.map((record: any) => record.soft_score?.pass ?? null),
      coherentCanonical.summary.records.map((record: any) => record.soft_score?.pass ?? null),
    )
  }

  // Issue #420 — invalid argument must exit nonzero through symlinks too,
  // with the same closed-vocabulary message as the canonical path.
  const invalidFileLink = runCliArgs(fileLink, symlinkFixture, ['--definitely-invalid-argument'])
  assert.equal(invalidFileLink.exit, 1, invalidFileLink.output)
  assert.match(invalidFileLink.output, /unknown argument: --definitely-invalid-argument/)
  const invalidDirLink = runCliArgs(join(dirLink, 'sf-summary.ts'), symlinkFixture, ['--definitely-invalid-argument'])
  assert.equal(invalidDirLink.exit, 1, invalidDirLink.output)
  assert.match(invalidDirLink.output, /unknown argument: --definitely-invalid-argument/)

  // Issue #420 — corrupt newest batch must fail closed through symlinks too,
  // with the same status / missing / selected_malformed_records as the
  // canonical path. This pins the scoring/aggregation red lines from being
  // silently bypassed by the symlink guard.
  const corruptSymlinkRoot = freshRoot()
  roots.push(corruptSymlinkRoot)
  writeBatch(corruptSymlinkRoot, '2026-01-01T10-00-00-000Z.json', 'old-complete', 'manual', 'hit')
  const newestCorrupt = '2026-09-16T10-00-00-000Z.json'
  EXPECTED_QUERY_IDS.slice(0, 7).forEach((queryId, index) => writeJson(corruptSymlinkRoot, queryId, newestCorrupt, record(queryId, 'new-incomplete', `2026-09-16T10:00:0${index + 1}.000Z`, 'static', 'error')))
  writeRaw(corruptSymlinkRoot, 'sf-08', newestCorrupt, '{ corrupt json')
  const corruptCanonical = runCli(corruptSymlinkRoot)
  assert.equal(corruptCanonical.exit, 1, corruptCanonical.output)
  const corruptFileLink = runCli(corruptSymlinkRoot, fileLink)
  assert.equal(corruptFileLink.exit, 1, corruptFileLink.output)
  assert.equal(corruptFileLink.summary.status, corruptCanonical.summary.status)
  assert.equal(corruptFileLink.summary.selected_batch.batch_id, corruptCanonical.summary.selected_batch.batch_id)
  assert.deepEqual(corruptFileLink.summary.missing_query_ids, corruptCanonical.summary.missing_query_ids)
  assert.deepEqual(corruptFileLink.summary.selected_malformed_records, corruptCanonical.summary.selected_malformed_records)
  const corruptDirLink = runCli(corruptSymlinkRoot, join(dirLink, 'sf-summary.ts'))
  assert.equal(corruptDirLink.exit, 1, corruptDirLink.output)
  assert.equal(corruptDirLink.summary.status, corruptCanonical.summary.status)
  assert.deepEqual(corruptDirLink.summary.missing_query_ids, corruptCanonical.summary.missing_query_ids)

  // Issue #420 — module-import inertness: importing the module from a
  // separate test process must not run main() and must not touch the default
  // user evidenceRoot under HOME. The library API stays callable.
  const importRoot = mkdtempSync(join(tmpdir(), 'gotry-sf420-import-'))
  roots.push(importRoot)
  const importHome = join(importRoot, 'home')
  mkdirSync(importHome, { recursive: true })
  const defaultRoot = join(importHome, '.gotry', 'evidence', 'session')
  const importerPath = join(importRoot, 'importer.mjs')
  writeFileSync(importerPath, `
    import { homedir } from 'node:os'
    import { existsSync } from 'node:fs'
    import { join } from 'node:path'
    const defaultEvidenceRoot = join(homedir(), '.gotry', 'evidence', 'session')
    if (existsSync(defaultEvidenceRoot)) process.exit(11)
    const mod = await import(${JSON.stringify(pathToFileURL(cliPath).href)})
    if (typeof mod.main !== 'function') process.exit(12)
    if (typeof mod.parseCliArgs !== 'function') process.exit(13)
    if (typeof mod.buildSummary !== 'function') process.exit(14)
    if (existsSync(defaultEvidenceRoot)) process.exit(15)
    process.stdout.write('import-inert OK\\n')
  `)
  const importerResult = spawnSync(process.execPath, [importerPath], {
    cwd: tsRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: importHome,
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
    },
  })
  assert.equal(importerResult.status ?? -1, 0, `${importerResult.stdout ?? ''}${importerResult.stderr ?? ''}`)
  assert.match(`${importerResult.stdout ?? ''}${importerResult.stderr ?? ''}`, /import-inert OK/)
  assert.equal(existsSync(defaultRoot), false, `default HOME evidenceRoot must not be created by import`)

  console.log('SF SUMMARY CLI E2E: coherent filename batch, chronology, source provenance, missing/corrupt fail-closed, legacy unknown, old/new isolation, and challenge-partial fail-closed OK')
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
