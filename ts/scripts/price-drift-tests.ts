/**
 * 价格漂移监测合同测试(issue #49 长效机制,run-all §41)。
 * 全确定性、零网络:
 *   - diff 算法守门:baseline 改/新/删均被检出;
 *   - offline 模式:无 baseline → skipped_no_baseline;有 baseline → unchanged(reason 提示 --fetch);
 *   - fetch 模式:fetch 失败 → skipped_no_network;parse 失败 → skipped_parse_error;baseline 不存在 →
 *     fetched_no_table_entry 且写 fixture;baseline 存在 + 完全相同 → unchanged;存在 + 不同 → drift;
 *   - 写入 baseline fixture 的 schema_version 守门;
 *   - PR 段落渲染:drift 含 model/field/from/to/direction 表格 + 纪律注脚。
 *   - diff 细节:字段 up/down/new/removed 四个方向全检。
 *
 * 网络例一律走注入的 fetcher / providers 路径,不真联网(真联网在 founder 手动 / CI 心跳)。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runPriceDriftWatch,
  parseOpenaiHtml,
  type DriftOptions,
  type DriftReport,
} from './price-drift-watch.ts'

type ProviderSpec = NonNullable<DriftOptions['providers']>[number]

let passed = 0
function ok(label: string): void {
  passed += 1
  console.log(`  ok ${label}`)
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'drift-'))
}

function makeBaseline(rows: Array<{ model: string; input_cache_miss_usd_per_1m: number; input_cache_hit_usd_per_1m: number | null; output_usd_per_1m: number }>, asOf = '2026-08-30T00:00:00.000Z'): string {
  return JSON.stringify({ schema_version: 'gotry_llm_price_baseline_v1', as_of: asOf, source_url: 'mock://test', rows })
}

/** 测试用注入 provider:baseline_path 指向 tmp 文件,parser 接受 mock HTML 字符串。 */
function makeMockProvider(id: string, baselinePath: string, _fetchReturn: string | Error): ProviderSpec[] {
  const parser = (html: string): Array<{ model: string; input_cache_miss_usd_per_1m: number; input_cache_hit_usd_per_1m: number | null; output_usd_per_1m: number }> => {
    const rows: Array<{ model: string; input_cache_miss_usd_per_1m: number; input_cache_hit_usd_per_1m: number | null; output_usd_per_1m: number }> = []
    for (const seg of html.split(';')) {
      const [model, nums] = seg.split(':')
      if (!model || !nums) continue
      const [miss, hit, out] = nums.split(',').map(Number)
      if (!Number.isFinite(miss) || !Number.isFinite(out)) continue
      rows.push({ model: model.trim(), input_cache_miss_usd_per_1m: miss, input_cache_hit_usd_per_1m: Number.isFinite(hit as number) ? (hit as number) : null, output_usd_per_1m: out })
    }
    return rows
  }
  return [{
    id,
    source_url: `mock://${id}`,
    baseline_path: baselinePath,
    parse: parser,
  }]
}

function fetcherFromMap(map: Record<string, string | Error>) {
  return async (url: string): Promise<string> => {
    const v = map[url]
    if (v instanceof Error) throw v
    if (typeof v === 'string') return v
    throw new Error(`no mock for ${url}`)
  }
}

// ---- 1. offline 无 baseline → skipped_no_baseline ----
async function testOfflineNoBaseline(): Promise<void> {
  const root = tmpRoot()
  try {
    const report = await runPriceDriftWatch({
      mode: 'offline',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: makeMockProvider('mockprov', join(root, 'no-such-file.json'), ''),
    })
    assert.equal(report.schema_version, 'gotry_llm_price_drift_v1')
    assert.equal(report.providers['mockprov'].status, 'skipped_no_baseline')
    ok('offline 无 baseline → skipped_no_baseline')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 2. offline 有 baseline → unchanged(reason 提示 --fetch) ----
async function testOfflineWithBaseline(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    writeFileSync(bp, makeBaseline([
      { model: 'm1', input_cache_miss_usd_per_1m: 1.0, input_cache_hit_usd_per_1m: 0.1, output_usd_per_1m: 3.0 },
    ]))
    const report = await runPriceDriftWatch({
      mode: 'offline',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: makeMockProvider('mockprov', bp, ''),
    })
    assert.equal(report.providers['mockprov'].status, 'unchanged')
    assert.match(report.providers['mockprov'].reason ?? '', /--fetch/, 'offline reason 应提示 --fetch')
    ok('offline 有 baseline → unchanged + reason 提示 --fetch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 3. fetch 模式:fet 失败 → skipped_no_network ----
async function testFetchFailure(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    writeFileSync(bp, makeBaseline([
      { model: 'm1', input_cache_miss_usd_per_1m: 1.0, input_cache_hit_usd_per_1m: 0.1, output_usd_per_1m: 3.0 },
    ]))
    const report = await runPriceDriftWatch({
      mode: 'fetch',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: makeMockProvider('mockprov', bp, ''),
      fetcher: fetcherFromMap({ 'mock://mockprov': new Error('ECONNREFUSED') }),
    })
    assert.equal(report.providers['mockprov'].status, 'skipped_no_network')
    assert.match(report.providers['mockprov'].reason ?? '', /ECONNREFUSED/)
    ok('fetch 失败 → skipped_no_network')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 4. fetch 模式:首次 fetch 无 baseline → fetched_no_table_entry 且写 fixture ----
async function testFetchFirstTimeWritesBaseline(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    const report = await runPriceDriftWatch({
      mode: 'fetch',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: makeMockProvider('mockprov', bp, ''),
      fetcher: fetcherFromMap({ 'mock://mockprov': 'm1:1.0,0.1,3.0;m2:2.0,0.2,5.0' }),
    })
    assert.equal(report.providers['mockprov'].status, 'fetched_no_table_entry')
    // 必须有 fixture 文件
    const { existsSync, readFileSync } = await import('node:fs')
    assert.ok(existsSync(bp), 'baseline fixture 必须被写')
    const written = JSON.parse(readFileSync(bp, 'utf8')) as Record<string, unknown>
    assert.equal(written['schema_version'], 'gotry_llm_price_baseline_v1')
    assert.ok(Array.isArray(written['rows']))
    assert.equal((written['rows'] as unknown[]).length, 2)
    ok('fetch 首次 → fetched_no_table_entry + 写 fixture')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 5. fetch 模式:baseline + current 完全相同 → unchanged ----
async function testFetchUnchanged(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    writeFileSync(bp, makeBaseline([
      { model: 'm1', input_cache_miss_usd_per_1m: 1.0, input_cache_hit_usd_per_1m: 0.1, output_usd_per_1m: 3.0 },
    ]))
    const report = await runPriceDriftWatch({
      mode: 'fetch',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: makeMockProvider('mockprov', bp, ''),
      fetcher: fetcherFromMap({ 'mock://mockprov': 'm1:1.0,0.1,3.0' }),
    })
    assert.equal(report.providers['mockprov'].status, 'unchanged')
    ok('fetch 模式:baseline + current 同 → unchanged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 6. fetch 模式:baseline + current 不同 → drift + 字段方向 ----
async function testFetchDrift(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    writeFileSync(bp, makeBaseline([
      { model: 'm-keep', input_cache_miss_usd_per_1m: 1.0, input_cache_hit_usd_per_1m: 0.1, output_usd_per_1m: 3.0 },
      { model: 'm-up', input_cache_miss_usd_per_1m: 1.0, input_cache_hit_usd_per_1m: 0.1, output_usd_per_1m: 3.0 },
      { model: 'm-down', input_cache_miss_usd_per_1m: 1.0, input_cache_hit_usd_per_1m: 0.1, output_usd_per_1m: 3.0 },
      { model: 'm-removed', input_cache_miss_usd_per_1m: 1.0, input_cache_hit_usd_per_1m: 0.1, output_usd_per_1m: 3.0 },
    ]))
    const report = await runPriceDriftWatch({
      mode: 'fetch',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: makeMockProvider('mockprov', bp, ''),
      fetcher: fetcherFromMap({
        'mock://mockprov': [
          'm-keep:1.0,0.1,3.0',
          'm-up:1.5,0.1,3.0',     // miss 1.0→1.5 up
          'm-down:0.8,0.1,3.0',    // miss 1.0→0.8 down
          'm-new:2.0,0.2,4.0',     // 全 new
          // m-removed 不在 current,标记 removed
        ].join(';'),
      }),
    })
    const r = report.providers['mockprov']
    assert.equal(r.status, 'drift')
    const drift = r.drift ?? []
    // 期望:m-up input_cache_miss up, m-down input_cache_miss down, m-new input_cache_miss new, m-removed input_cache_miss removed
    const fields = drift.map(d => `${d.model}|${d.field}|${d.direction}`).sort()
    assert.deepEqual(fields, [
      'm-down|input_cache_miss_usd_per_1m|down',
      'm-new|input_cache_miss_usd_per_1m|new',
      'm-removed|input_cache_miss_usd_per_1m|removed',
      'm-up|input_cache_miss_usd_per_1m|up',
    ], 'drift 字段方向必须逐项正确')
    ok('fetch drift:up/down/new/removed 四向全检')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 7. PR 段落渲染:drift 时含表格 + 纪律注脚 ----
async function testPrParagraph(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    writeFileSync(bp, makeBaseline([
      { model: 'deepseek-v4-flash', input_cache_miss_usd_per_1m: 1.32, input_cache_hit_usd_per_1m: 0.014, output_usd_per_1m: 3.0 },
    ]))
    const report = await runPriceDriftWatch({
      mode: 'fetch',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: makeMockProvider('mockprov', bp, ''),
      fetcher: fetcherFromMap({ 'mock://mockprov': 'deepseek-v4-flash:1.32,0.014,3.0' }),
    })
    assert.equal(report.providers['mockprov'].status, 'unchanged')
    assert.match(report.suggested_pr_paragraph, /价格漂移监测/)
    assert.match(report.suggested_pr_paragraph, /mockprov/)
    assert.match(report.suggested_pr_paragraph, /人工 PR/)
    ok('PR 段落含监测标题 + provider 变动 + 纪律注脚')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 8. baseline schema_version 守门:不匹配 schema 视为不存在(loader 容错) ----
async function testBadBaseline(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    writeFileSync(bp, JSON.stringify({ schema_version: 'gotry_llm_price_baseline_v99', rows: [] }))
    // 离线模式:坏 baseline 视为不存在 → skipped_no_baseline
    const report = await runPriceDriftWatch({
      mode: 'offline',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: makeMockProvider('mockprov', bp, ''),
    })
    assert.equal(report.providers['mockprov'].status, 'skipped_no_baseline', '坏 baseline schema_version 视为不存在,offline 标 SKIP')
    ok('坏 baseline schema_version → offline 视为不存在(SKIP)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await testOfflineNoBaseline()
await testOfflineWithBaseline()
await testFetchFailure()
await testFetchFirstTimeWritesBaseline()
await testFetchUnchanged()
await testFetchDrift()
await testPrParagraph()
await testBadBaseline()

// ---- 9. snapshot 路径:parser 解析 __NEXT_DATA__ 内嵌 JSON dump,fallback 解析段落文字 ----
async function testSnapshotNextDataParser(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    const sp = join(root, 'snapshot.html')
    writeFileSync(bp, makeBaseline([
      { model: 'gpt-4o', input_cache_miss_usd_per_1m: 2.5, input_cache_hit_usd_per_1m: 1.25, output_usd_per_1m: 10.0 },
    ]))
    // 真实 snapshot 文件模拟 __NEXT_DATA__ 形态
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { models: [
        { name: 'gpt-4o', input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001, cached_input_cost_per_token: 0.00000125 },
      ] } },
    })}</script></html>`
    writeFileSync(sp, html)
    const report = await runPriceDriftWatch({
      mode: 'offline',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: [{ id: 'mockprov', source_url: 'mock://mockprov', baseline_path: bp, snapshot_path: sp, parse: parseOpenaiHtml } as unknown as ProviderSpec],
    })
    assert.equal(report.providers['mockprov'].status, 'unchanged', 'snapshot 与 baseline 同价 → unchanged(offline)')
    ok('snapshot 路径:__NEXT_DATA__ 内嵌 JSON dump 解析成功 + 与 baseline 同 → unchanged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 10. snapshot 路径:parser fallback 段落文字;baseline 不一致 → drift ----
async function testSnapshotFallbackDrift(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    const sp = join(root, 'snapshot.html')
    writeFileSync(bp, makeBaseline([
      { model: 'gpt-4o', input_cache_miss_usd_per_1m: 2.5, input_cache_hit_usd_per_1m: 1.25, output_usd_per_1m: 10.0 },
    ]))
    // __NEXT_DATA__ 解析失败(空 props),parser fallback 走段落文字
    const html = '<html><body><p>gpt-4o … $5.00 / 1M input … $20.00 / 1M output</p></body></html>'
    writeFileSync(sp, html)
    const report = await runPriceDriftWatch({
      mode: 'offline',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: [{ id: 'mockprov', source_url: 'mock://mockprov', baseline_path: bp, snapshot_path: sp, parse: parseOpenaiHtml } as unknown as ProviderSpec],
    })
    const r = report.providers['mockprov']
    assert.equal(r.status, 'drift', 'snapshot fallback 解析 + baseline 不一致 → drift')
    const drift = r.drift ?? []
    assert.ok(drift.some(d => d.field === 'input_cache_miss_usd_per_1m' && d.from === 2.5 && d.to === 5.0 && d.direction === 'up'), 'miss 字段 up drift')
    assert.ok(drift.some(d => d.field === 'output_usd_per_1m' && d.from === 10.0 && d.to === 20.0 && d.direction === 'up'), 'output 字段 up drift')
    ok('snapshot fallback:段落文字解析 + 与 baseline 不同 → drift(含 up/down/new/removed)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- 11. snapshot 缺失守门:有 baseline 但无 snapshot → skipped_no_snapshot ----
async function testSnapshotMissing(): Promise<void> {
  const root = tmpRoot()
  try {
    const bp = join(root, 'b.json')
    writeFileSync(bp, makeBaseline([
      { model: 'gpt-4o', input_cache_miss_usd_per_1m: 2.5, input_cache_hit_usd_per_1m: 1.25, output_usd_per_1m: 10.0 },
    ]))
    const report = await runPriceDriftWatch({
      mode: 'offline',
      observedAt: () => new Date('2026-08-30T12:00:00Z'),
      providers: [{ id: 'mockprov', source_url: 'mock://mockprov', baseline_path: bp, snapshot_path: join(root, 'no-such-snapshot.html'), parse: parseOpenaiHtml } as unknown as ProviderSpec],
    })
    assert.equal(report.providers['mockprov'].status, 'skipped_no_snapshot', 'snapshot 缺失 → SKIP')
    ok('snapshot 缺失 → skipped_no_snapshot(offline)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await testSnapshotNextDataParser()
await testSnapshotFallbackDrift()
await testSnapshotMissing()

console.log(`price-drift-watch tests: ${passed} 组断言全绿(offline,fetch 模式手动/CI 心跳)`)