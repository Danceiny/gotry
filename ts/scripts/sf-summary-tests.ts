import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXPECTED_QUERY_IDS } from './sf-summary.ts'

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(tsRoot, 'scripts', 'sf-summary.ts')
const tsxPath = join(tsRoot, 'node_modules', '.bin', 'tsx')

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

function runCli(root: string): { exit: number; output: string; summary: Record<string, any> } {
  mkdirSync(join(root, 'home'), { recursive: true })
  const result = spawnSync(process.execPath, [tsxPath, cliPath, '--evidence-root', root], {
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

  // Challenge-truncated partial batch (issue #411/RFC §3.5): missing five entries means never marked
  // complete/valid calibration (status=fail_closed), with a challenge_stop_detected annotation;
  // old evidence where session.verdict was rewritten to error is still recognized via top-level sessionVerdict.
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
  const challenge = runCli(challengeRoot)
  assert.equal(challenge.exit, 1, challenge.output)
  assert.equal(challenge.summary.status, 'fail_closed')
  assert.equal(challenge.summary.challenge_stop_detected, true)
  assert.equal(challenge.summary.total, 4)
  assert.equal(challenge.summary.missing_query_ids.length, 4)

  console.log('SF SUMMARY CLI E2E: coherent filename batch, chronology, source provenance, missing/corrupt fail-closed, legacy unknown, old/new isolation, and challenge-partial fail-closed OK')
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
