import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runner = join(import.meta.dirname, 'sf-live-benchmark.ts')
const summaryRunner = join(import.meta.dirname, 'sf-summary.ts')
const tsRoot = join(import.meta.dirname, '..')

// 既有契约:未知 vendor 必须在网络调用前 exit 1(回归保护)
// Node24 原生 .ts 支持——与 root272-challenge-probe 同型,无 tsx 依赖
{
  const temp = mkdtempSync(join(tmpdir(), 'sf-cli-unknown-'))
  const hook = join(temp, 'hooks.mjs')
  writeFileSync(hook, `import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
 if(url==='node:os') return {format:'module',shortCircuit:true,source:${JSON.stringify(`export const homedir=()=>${JSON.stringify(temp)};`)}};
 if(url.endsWith('/capabilities/flyai.ts')) return {format:'module',shortCircuit:true,source:'export async function flyaiSearch(){throw new Error("NETWORK_FORBIDDEN")}'};
 return next(url,context);
}});`)
  const result = spawnSync(process.execPath, ['--import', hook, runner, '--golden=ctrip-open'], {
    cwd: tsRoot,
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
    },
  })
  const status = result.status
  const errMsg = result.error instanceof Error ? `${result.error.name}: ${result.error.message}` : '-'
  assert.equal(status, 1, `未知 vendor 应在网络调用前 exit 1;实际 status=${status} signal=${result.signal ?? '-'} error=${errMsg}`)
  assert.match(result.stderr, /不支持的 golden vendor: ctrip-open/)
  assert.equal(result.stdout.includes('sf-01 上海→丽江'), false, 'fail-closed 前不得启动任何 query')
  rmSync(temp, { recursive: true, force: true })
}
console.log('SF LIVE CLI TESTS: unknown vendor fail-closed before network OK')

// RFC §3.5 + issue #411:challenge/guard 触发即停止本批后续 session+comparator
// 用 native Node24 模块钩子替换 session 模块为确定性响应,homedir 隔离到临时目录,
// flyai 抛错兜底,加速 cadence——真实 CLI 路径,零网络零供应商
interface ChallengeRunOpts {
  challengeFromIndex: number
  guardVeto?: boolean
  tempPrefix: string
}

interface ChallengeRun {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error: Error | undefined
  calls: Array<{ i: number; q: { from: string; to: string; date: string } }>
  comparatorCalls: number
  temp: string
}

const tempRoots: string[] = []
try {
  function runWithChallengeHook(opts: ChallengeRunOpts): ChallengeRun {
    const temp = mkdtempSync(join(tmpdir(), opts.tempPrefix))
    tempRoots.push(temp)
    const trace = join(temp, 'calls.jsonl')
    const comparatorTrace = join(temp, 'comparator-calls.jsonl')
    const hook = join(temp, 'hooks.mjs')
    const guardStub = opts.guardVeto === true
      ? `if(q.i%2===0){appendFileSync(${JSON.stringify(comparatorTrace)},JSON.stringify({kind:'comparator-guard',i:q.i})+String.fromCharCode(10));}`
      : ''
    writeFileSync(hook, `import {registerHooks} from 'node:module';
const delay=globalThis.setTimeout; globalThis.setTimeout=(fn,ms,...args)=>delay(fn,0,...args);
registerHooks({load(url,context,next){
 if(url.endsWith('/capabilities/session-search.ts')) return {format:'module',shortCircuit:true,source:${JSON.stringify(`import {appendFileSync} from 'node:fs'; let i=0; const startAt=${opts.challengeFromIndex}; export async function sessionFlightSearch(q){appendFileSync(${JSON.stringify(trace)},JSON.stringify({i,q})+'\\n'); ${guardStub} if(i++>=startAt) return {ok:false,via:'session-ctrip-flight-error',verdict:'challenged',evidence:'synthetic challenge; no transport',latencyMs:0,error:'synthetic captcha'}; return {ok:true,via:'session-ctrip-flight',evidence:'synthetic hit; no transport',latencyMs:0,verdict:'hit',options:[{flightNo:'HO0001',depDateTime:q.date+'T10:00:00+08:00',arrDateTime:q.date+'T13:00:00+08:00',price:1000}]};}`)}};
 if(url==='node:os') return {format:'module',shortCircuit:true,source:${JSON.stringify(`export const homedir=()=>${JSON.stringify(temp)};`)}};
 if(url.endsWith('/capabilities/flyai.ts')) return {format:'module',shortCircuit:true,source:${JSON.stringify(`import {appendFileSync} from 'node:fs'; export async function flyaiSearch(){appendFileSync(${JSON.stringify(comparatorTrace)},JSON.stringify({kind:'comparator-flyai'})+String.fromCharCode(10)); return {ok:true,via:'flyai-stub',verdict:'hit',options:[{no:'FLY999',depDateTime:'2026-10-01T08:00:00+08:00',arrDateTime:'2026-10-01T12:00:00+08:00',price:999}]};}`)}};
 return next(url,context);
}});`)
    const result = spawnSync(process.execPath, ['--import', hook, runner, '--golden=flyai'], {
      cwd: tsRoot,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        GOTRY_SESSION_LIVE: '0',
        GOTRY_HBCLI_LIVE: '0',
        GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
      },
    })
    const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const comparatorCalls = existsSync(comparatorTrace)
      ? readFileSync(comparatorTrace, 'utf8').split('\n').filter(Boolean).length
      : 0
    return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error, calls, comparatorCalls, temp }
  }

  function inspectPersistedBatch(temp: string): { recordCount: number; haltedRecord: { queryId: string; doubleSourceState: string; sessionVerdict: string } | null; summary: Record<string, unknown> } {
    const evidenceRoot = join(temp, '.gotry', 'evidence', 'session')
    assert.ok(existsSync(evidenceRoot), `evidence root 缺失:${evidenceRoot}`)
    const queryDirs = readdirSync(evidenceRoot).filter((name) => name.startsWith('sf-') && name !== 'sf-summary')
    const recordFiles: string[] = []
    for (const dir of queryDirs) {
      const files = readdirSync(join(evidenceRoot, dir)).filter((file) => file.endsWith('.json'))
      recordFiles.push(...files.map((file) => join(evidenceRoot, dir, file)))
    }
    const records = recordFiles.map((file) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    const haltedRecord = records.find((record) => {
      const ds = record.doubleSource as { state?: string } | undefined
      return ds?.state === 'challenge_stop' || ds?.state === 'guard_violation'
    }) ?? null
    const haltedInfo = haltedRecord === null
      ? null
      : {
          queryId: String(haltedRecord.query_id),
          doubleSourceState: String((haltedRecord.doubleSource as { state: string }).state),
          sessionVerdict: String(haltedRecord.sessionVerdict ?? (haltedRecord.session as { verdict?: string } | undefined)?.verdict ?? '-'),
        }
    const summaryDir = join(evidenceRoot, 'sf-summary')
    assert.ok(existsSync(summaryDir), `sf-summary 目录缺失:${summaryDir}`)
    const summaryFiles = readdirSync(summaryDir).filter((file) => file.endsWith('.json'))
    assert.equal(summaryFiles.length, 1, `每批应只写一个 sf-summary;实际=${summaryFiles.length}`)
    const summary = JSON.parse(readFileSync(join(summaryDir, summaryFiles[0]!), 'utf8')) as Record<string, unknown>
    return { recordCount: records.length, haltedRecord: haltedInfo, summary }
  }

  function runSfSummaryCli(evidenceRoot: string): { status: number | null; signal: NodeJS.Signals | null; error: Error | undefined; stdout: string; stderr: string; summaryPath: string | null } {
    const result = spawnSync(process.execPath, [summaryRunner, '--evidence-root', evidenceRoot], {
      cwd: tsRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        GOTRY_SESSION_LIVE: '0',
        GOTRY_HBCLI_LIVE: '0',
        GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
      },
    })
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const pathMatch = /summary: (.+)/.exec(combined)
    return { status: result.status, signal: result.signal, error: result.error, stdout: combined, stderr: result.stderr ?? '', summaryPath: pathMatch?.[1]?.trim() ?? null }
  }

  // ① 首条即 challenge → 只调 1 次 session,batch_complete=false,halt_reason=challenge_stop
  const firstChallenge = runWithChallengeHook({ challengeFromIndex: 0, tempPrefix: 'sf-cli-first-' })
  assert.equal(firstChallenge.status, 0, `首条 challenge 应正常 exit 0;signal=${firstChallenge.signal ?? '-'} error=${firstChallenge.error?.message ?? '-'}`)
  assert.equal(firstChallenge.calls.length, 1, `首条 challenge 后必须停止,实际 session 调用=${firstChallenge.calls.length}`)
  assert.equal(firstChallenge.comparatorCalls, 1, `首条 challenge 后 comparator 必须停,实际=${firstChallenge.comparatorCalls}`)
  const firstInspected = inspectPersistedBatch(firstChallenge.temp)
  assert.equal(firstInspected.recordCount, 1, `首条 challenge 仅落 1 条 record;实际=${firstInspected.recordCount}`)
  assert.deepEqual(firstInspected.haltedRecord, { queryId: 'sf-01', doubleSourceState: 'challenge_stop', sessionVerdict: 'challenged' }, 'halted record 应是 sf-01 且 doubleSource=challenge_stop')
  assert.equal(firstInspected.summary.batch_complete, false)
  assert.equal(firstInspected.summary.halt_reason, 'challenge_stop')
  assert.deepEqual(firstInspected.summary.attempted_query_ids, ['sf-01'])
  assert.deepEqual(firstInspected.summary.unattempted_query_ids, ['sf-02', 'sf-03', 'sf-04', 'sf-05', 'sf-06', 'sf-07', 'sf-08'])
  assert.equal(firstInspected.summary.requested_total, 8)
  // 跑真实 sf-summary CLI 验证 fail_closed + missing query_ids
  const firstSfSummary = runSfSummaryCli(join(firstChallenge.temp, '.gotry', 'evidence', 'session'))
  assert.equal(firstSfSummary.status, 1, `sf-summary 对部分批次应 fail-closed exit 1;status=${firstSfSummary.status} stderr-tail=${firstSfSummary.error?.message ?? '-'}`)
  assert.match(firstSfSummary.stdout, /status: fail_closed/)
  assert.match(firstSfSummary.stdout, /total: 1\/8/)
  const firstMissingMatch = `${firstSfSummary.stdout}\n${firstSfSummary.stderr}`.match(/missing query IDs: ([^\n]+)/)
  if (firstMissingMatch === null) {
    throw new Error(`sf-summary stdout+stderr 缺 missing-IDs 行;combined=${JSON.stringify(firstSfSummary.stdout)};stderr=${JSON.stringify(firstSfSummary.stderr)}`)
  }
  assert.equal(firstMissingMatch[1], 'sf-02, sf-03, sf-04, sf-05, sf-06, sf-07, sf-08', 'missing query IDs 必须含 sf-02..sf-08 全部 7 条')
  console.log('SF LIVE CLI TESTS: first challenge halts after 1 session/comparator + sf-summary fail_closed OK')

  // ② 第 4 条 challenge → 调 4 次 session 后停止
  const midChallenge = runWithChallengeHook({ challengeFromIndex: 3, tempPrefix: 'sf-cli-mid-' })
  assert.equal(midChallenge.status, 0, `中途 challenge 应正常 exit 0;signal=${midChallenge.signal ?? '-'} error=${midChallenge.error?.message ?? '-'}`)
  assert.equal(midChallenge.calls.length, 4, `第 4 条 challenge 后必须停止,实际 session 调用=${midChallenge.calls.length}`)
  assert.equal(midChallenge.comparatorCalls, 4, `第 4 条 challenge 后 comparator 同步停止,实际=${midChallenge.comparatorCalls}`)
  const midInspected = inspectPersistedBatch(midChallenge.temp)
  assert.equal(midInspected.recordCount, 4, `中途 challenge 仅落 4 条 record;实际=${midInspected.recordCount}`)
  assert.deepEqual(midInspected.haltedRecord, { queryId: 'sf-04', doubleSourceState: 'challenge_stop', sessionVerdict: 'challenged' }, 'halted record 应是 sf-04')
  assert.equal(midInspected.summary.batch_complete, false)
  assert.equal(midInspected.summary.halt_reason, 'challenge_stop')
  assert.deepEqual(midInspected.summary.attempted_query_ids, ['sf-01', 'sf-02', 'sf-03', 'sf-04'])
  assert.deepEqual(midInspected.summary.unattempted_query_ids, ['sf-05', 'sf-06', 'sf-07', 'sf-08'])
  const midSfSummary = runSfSummaryCli(join(midChallenge.temp, '.gotry', 'evidence', 'session'))
  assert.equal(midSfSummary.status, 1, `sf-summary 对中途 challenge 批次应 fail-closed exit 1;status=${midSfSummary.status}`)
  assert.match(midSfSummary.stdout, /status: fail_closed/)
  assert.match(midSfSummary.stdout, /total: 4\/8/)
  const midMissingMatch = `${midSfSummary.stdout}\n${midSfSummary.stderr}`.match(/missing query IDs: ([^\n]+)/)
  if (midMissingMatch === null) {
    throw new Error(`sf-summary stdout+stderr 缺 missing-IDs;combined=${JSON.stringify(midSfSummary.stdout)};stderr=${JSON.stringify(midSfSummary.stderr)}`)
  }
  assert.equal(midMissingMatch[1], 'sf-05, sf-06, sf-07, sf-08', 'missing query IDs 必须含 sf-05..sf-08 全部 4 条')
  console.log('SF LIVE CLI TESTS: mid-batch challenge halts after 4 session/comparator + sf-summary fail_closed OK')

  // ③ 全程无 challenge → 既有 8 条全跑完,batch_complete=true
  const noChallenge = runWithChallengeHook({ challengeFromIndex: 999, tempPrefix: 'sf-cli-full-' })
  assert.equal(noChallenge.status, 0, `正常批次应 exit 0;signal=${noChallenge.signal ?? '-'} error=${noChallenge.error?.message ?? '-'}`)
  assert.equal(noChallenge.calls.length, 8, `正常批次必须仍跑 8 次 session,实际=${noChallenge.calls.length}`)
  assert.equal(noChallenge.comparatorCalls, 8, `正常批次 comparator 必须同步 8 次;实际=${noChallenge.comparatorCalls}`)
  const noChallengeInspected = inspectPersistedBatch(noChallenge.temp)
  assert.equal(noChallengeInspected.recordCount, 8)
  assert.equal(noChallengeInspected.haltedRecord, null)
  assert.equal(noChallengeInspected.summary.batch_complete, true)
  assert.equal(noChallengeInspected.summary.halt_reason, null)
  assert.deepEqual(noChallengeInspected.summary.attempted_query_ids, ['sf-01', 'sf-02', 'sf-03', 'sf-04', 'sf-05', 'sf-06', 'sf-07', 'sf-08'])
  assert.deepEqual(noChallengeInspected.summary.unattempted_query_ids, [])
  // 完整批次仅断言 inline summary 保留 batch_complete=true;
  // sf-summary 对合成 flyai stub 数据的下游判定不在 #411 范围内
  assert.equal(noChallengeInspected.summary.batch_complete, true, '正常批次 summary.batch_complete 必须为 true')
  console.log('SF LIVE CLI TESTS: normal batch runs all 8 session/comparator + batch_complete=true OK')
} finally {
  for (const temp of tempRoots) {
    if (existsSync(temp)) rmSync(temp, { recursive: true, force: true })
  }
}
