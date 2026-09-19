/**
 * #514 FlyAI process diagnostics proof.
 *
 * Every case goes through the registered tool and production effect, while the
 * CLI is an actual short lived subprocess injected through `cliBin`.  No
 * provider credentials or network calls are used.
 */

import assert from 'node:assert/strict'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { flyaiSearch, type FlyaiQuery, type FlyaiResult } from '../capabilities/flyai.ts'
import { makeProductionInterpreter } from '../capabilities/effect.ts'
import { loadFactRegistry } from '../capabilities/fact-log.ts'
import { apply, type Config } from '../src/index.ts'

type ProofResult = FlyaiResult
type RegisteredTool = {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

const outputPrefix = 'gotry-flyai-'
const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const futureFlightArgs = { kind: 'flight', from: '北京', to: '上海', date: '2030-04-01' }
const futureHotelArgs = { kind: 'hotel', to: '大理', checkIn: '2030-04-02', checkOut: '2030-04-04' }
const emptyPayload = 'process.stdout.write(JSON.stringify({ data: { itemList: [] } }))'
const hitPayload = [
  "process.stdout.write(JSON.stringify({ data: { itemList: [{ journeys: [{ segments: [{ marketingTransportNo: 'G514', marketingTransportName: '高铁', depDateTime: '2030-04-01 09:00', arrDateTime: '2030-04-01 12:00', depStationName: '北京南', arrStationName: '上海虹桥', duration: 180 }] }], ticketPrice: '480' }] } }))",
].join('\n')

async function writeCli(root: string, name: string, source: string, kind: 'node' | 'shell' = 'node'): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `${kind === 'shell' ? '#!/bin/sh' : '#!/usr/bin/env node'}\n${source}\n`, { mode: 0o755 })
  return path
}

async function outputFiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter(name => name.startsWith(`${outputPrefix}${process.pid}-`))
}

function proofResult(value: unknown): ProofResult {
  return value as ProofResult
}

async function registeredCall(
  stateRoot: string,
  cliBin: string,
  args: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<{ result: Record<string, unknown>; facts: Awaited<ReturnType<typeof loadFactRegistry>>; attempts: number }> {
  let attempts = 0
  const tools: RegisteredTool[] = []
  const context = {
    tools: { register: (tool: unknown) => tools.push(tool as RegisteredTool) },
    systemPrompt: { variable: () => {} },
    on: () => () => {},
    get: () => undefined,
  } as unknown as Context
  const config: Config = {
    stateRoot,
    timeoutMs: 5_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'off',
  }
  const effect = makeProductionInterpreter({
    breakers: new Map(),
    sleep: async () => {},
    handlers: {
      FLYAI_SEARCH: async (params: unknown) => {
        attempts += 1
        return flyaiSearch({ ...(params as FlyaiQuery), cliBin, timeoutMs })
      },
    },
  })
  apply(context, config, { effect: effect as never })
  const tool = tools.find(candidate => candidate.name === 'gotry_flyai_search')
  assert.ok(tool, 'apply 应注册 gotry_flyai_search')
  const result = await tool.execute(args, null) as Record<string, unknown>
  const facts = await loadFactRegistry(stateRoot)
  return { result, facts, attempts }
}

async function assertSafeFailure(result: ProofResult, forbidden: string[]): Promise<void> {
  const text = `${result.error ?? ''}\n${result.evidence}`
  for (const value of forbidden) assert.equal(text.includes(value), false, `错误诊断不得泄露 ${value}`)
}

async function runCase(
  cliRoot: string,
  name: string,
  source: string,
  args: Record<string, unknown> = futureFlightArgs,
  timeoutMs = 5_000,
  scriptKind: 'node' | 'shell' = 'node',
): Promise<{ result: ProofResult; facts: Awaited<ReturnType<typeof loadFactRegistry>>; attempts: number; cliBin: string }> {
  const cliBin = join(cliRoot, name)
  const startMarker = join(cliRoot, `${name}.starts`)
  const marker = scriptKind === 'shell'
    ? `printf '1' >> ${shellQuote(startMarker)}`
    : `require('node:fs').appendFileSync(${JSON.stringify(startMarker)}, '1')`
  await writeCli(cliRoot, name, `${marker}\n${source}`, scriptKind)
  const stateRoot = await mkdtemp(join(tmpdir(), `flyai-process-state-${name}-`))
  try {
    const before = await outputFiles()
    const called = await registeredCall(stateRoot, cliBin, args, timeoutMs)
    const after = await outputFiles()
    assert.deepEqual(after, before, `${name} 结束后不得残留 FlyAI stdout 临时文件`)
    assert.equal(await readFile(startMarker, 'utf8'), '1', `${name} 应恰好启动一次 CLI 子进程`)
    return { result: proofResult(called.result), facts: called.facts, attempts: called.attempts, cliBin }
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

async function runBadArgs(cliRoot: string): Promise<void> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'flyai-process-state-bad-args-'))
  const marker = join(cliRoot, 'must-not-start')
  const cliBin = await writeCli(cliRoot, 'bad-args-cli', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`)
  try {
    const called = await registeredCall(stateRoot, cliBin, { kind: 'hotel' })
    assert.equal(called.attempts, 0, 'bad args 不应调用 production effect')
    assert.equal('process' in called.result, false, 'bad args 不得产生 process 诊断')
    await assert.rejects(access(marker), /ENOENT/, 'bad args 不应启动 CLI')
    assert.equal(called.facts.length, 0, 'bad args 不应写事实')
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

async function runTransientRetry(cliRoot: string): Promise<void> {
  const attemptsFile = join(cliRoot, 'transient-retry.starts')
  const cliBin = await writeCli(
    cliRoot,
    'transient-retry',
    `const fs = require('node:fs'); const p = ${JSON.stringify(attemptsFile)}; const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0; fs.writeFileSync(p, String(n + 1)); if (n === 0) { process.stderr.write('MCP HTTP 500 upstream temporary failure'); process.exit(1) } else { process.stdout.write(JSON.stringify({ data: { itemList: [] } })) }`,
  )
  const stateRoot = await mkdtemp(join(tmpdir(), 'flyai-process-state-transient-'))
  try {
    const before = await outputFiles()
    const called = await registeredCall(stateRoot, cliBin, futureFlightArgs)
    assert.deepEqual(await outputFiles(), before, '瞬时重试后不得残留 FlyAI stdout 临时文件')
    assert.equal(await readFile(attemptsFile, 'utf8'), '2', 'HTTP 500 瞬时错误应实际启动 CLI 两次')
    const result = proofResult(called.result)
    assert.equal(called.attempts, 2, 'HTTP 500 瞬时错误应保留 effect attempts=2')
    assert.equal(result.verdict, 'miss', '瞬时错误重试成功后应得到 miss')
    assert.equal(result.process?.exitCode, 0, '最终结果应保留第二次实际进程诊断')
    assert.equal(result.process?.signal, null)
    assert.equal(result.process?.timedOut, false)
    assert.equal(called.facts.length, 1)
    assert.equal(called.facts[0]?.kind, 'flight')
    assert.equal(called.facts[0]?.bookability, 'unavailable_exact_date')
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

export async function runFlyaiProcessProof(): Promise<void> {
  const cliRoot = await mkdtemp(join(tmpdir(), 'flyai-process-cli-'))
  const missingBin = join(cliRoot, 'missing-cli')
  try {
    await runBadArgs(cliRoot)

    const natural = await runCase(cliRoot, 'exit-23', 'process.exit(23)')
    assert.equal(natural.result.verdict, 'error')
    assert.equal(natural.result.process?.exitCode, 23)
    assert.equal(natural.result.process?.signal, null)
    assert.equal(natural.result.process?.timedOut, false)
    assert.ok((natural.result.process?.elapsedMs ?? 0) >= 0)
    assert.equal(natural.facts.length, 0)
    assert.equal(natural.attempts, 1, '自然非零退出不得重试')
    await assertSafeFailure(natural.result, [natural.cliBin, '北京', '上海'])

    const terminated = await runCase(
      cliRoot,
      'sigterm-after-429',
      "process.stdout.write('MCP HTTP 429 Trial limit reached'); process.kill(process.pid, 'SIGTERM')",
    )
    assert.equal(terminated.result.verdict, 'error', 'SIGTERM 优先于 stdout 429，仍为 error')
    assert.equal(terminated.result.process?.exitCode, null)
    assert.equal(terminated.result.process?.signal, 'SIGTERM')
    assert.equal(terminated.result.process?.timedOut, false)
    assert.equal(terminated.attempts, 1, 'SIGTERM 不得触发 timeout 文本重试')
    assert.equal(terminated.facts.length, 0)
    await assertSafeFailure(terminated.result, ['429', terminated.cliBin, '北京', '上海'])

    const deadlineMs = 1_000
    const timeoutCliSource = `exec ${shellQuote(process.execPath)} -e 'process.stderr.write("MCP HTTP 429 Trial limit reached"); setInterval(() => {}, 1_000)'`
    const timedOut = await runCase(cliRoot, 'timeout-sigkill', timeoutCliSource, futureFlightArgs, deadlineMs, 'shell')
    assert.equal(timedOut.result.verdict, 'error')
    assert.equal(timedOut.result.process?.exitCode, null)
    assert.equal(timedOut.result.process?.signal, 'SIGKILL')
    assert.equal(timedOut.result.process?.timedOut, true)
    assert.ok((timedOut.result.process?.elapsedMs ?? 0) >= deadlineMs, '超时诊断 elapsedMs 应至少达到显式 deadline')
    assert.ok((timedOut.result.process?.elapsedMs ?? Infinity) < 4_000, '超时子进程应有界收敛')
    assert.equal(timedOut.attempts, 1, '超时终止不得触发重试')
    assert.equal(timedOut.facts.length, 0)
    await assertSafeFailure(timedOut.result, [timedOut.cliBin, '北京', '上海', '429'])

    // The bounded shell wrapper launches a descendant before the deadline; the
    // wrapper exits while that descendant keeps stderr open.  The 2s/4s bounds
    // leave scheduler headroom on Node 22/24 without asserting startup speed.
    const heldStderr = await runCase(
      cliRoot,
      'exit-before-stderr-close',
      "node -e 'setTimeout(() => {}, 4000)' >&2 & printf '%s' '{\"data\":{\"itemList\":[]}}'; exit 0",
      futureFlightArgs,
      2_000,
      'shell',
    )
    assert.equal(heldStderr.result.verdict, 'miss', 'exit 0 后短暂持有 stderr pipe 仍应解析')
    assert.equal(heldStderr.result.process?.exitCode, 0)
    assert.equal(heldStderr.result.process?.signal, null)
    assert.equal(heldStderr.result.process?.timedOut, false, 'exit 已观察后不应误报 deadline')
    assert.ok((heldStderr.result.process?.elapsedMs ?? 0) >= 2_000, '应观察到 bounded stderr pipe 持有')
    assert.ok((heldStderr.result.process?.elapsedMs ?? Infinity) < 7_000)
    assert.equal(heldStderr.attempts, 1)
    assert.equal(heldStderr.facts.length, 1)
    assert.equal(heldStderr.facts[0]?.kind, 'flight')
    assert.equal(heldStderr.facts[0]?.bookability, 'unavailable_exact_date')

    const missing = await (async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), 'flyai-process-state-enoent-real-'))
      try {
        const before = await outputFiles()
        const called = await registeredCall(stateRoot, missingBin, futureFlightArgs)
        assert.deepEqual(await outputFiles(), before, 'ENOENT 后不得残留 FlyAI stdout 临时文件')
        return { result: proofResult(called.result), facts: called.facts, attempts: called.attempts }
      } finally {
        await rm(stateRoot, { recursive: true, force: true })
      }
    })()
    assert.equal(missing.result.verdict, 'error')
    assert.ok(missing.result.process?.exitCode === null || missing.result.process?.exitCode === -2, 'ENOENT 启动失败的 exitCode 应为空或 Node 的未启动哨兵值')
    assert.deepEqual(missing.result.process?.signal, null)
    assert.equal(missing.result.process?.timedOut, false)
    assert.equal(missing.result.process?.spawnErrorCode, 'ENOENT')
    assert.equal(missing.attempts, 1, 'ENOENT 不得重试')
    assert.equal(missing.facts.length, 0)
    await assertSafeFailure(missing.result, [missingBin, '北京', '上海', 'No such file or directory'])

    const empty = await runCase(cliRoot, 'empty-stdout', 'process.exit(0)')
    assert.equal(empty.result.verdict, 'error')
    assert.equal(empty.result.process?.exitCode, 0)
    assert.equal(empty.result.process?.signal, null)
    assert.equal(empty.result.process?.timedOut, false)
    assert.equal(empty.attempts, 1)
    assert.equal(empty.facts.length, 0)

    const trial = await runCase(
      cliRoot,
      'exit-1-429',
      "process.stderr.write('MCP HTTP 429 Trial limit reached'); process.exit(1)",
    )
    assert.equal(trial.result.verdict, 'needs-setup', '普通 exit1 + 429 保持 needs-setup')
    assert.equal(trial.result.process?.exitCode, 1)
    assert.equal(trial.result.process?.signal, null)
    assert.equal(trial.result.process?.timedOut, false)
    assert.equal(trial.attempts, 1)
    assert.equal(trial.facts.length, 0)

    await runTransientRetry(cliRoot)

    const hotelMixed1 = await runCase(
      cliRoot,
      'hotel-mixed-1',
      "process.stdout.write(JSON.stringify({ data: { itemList: [{ name: '大理 A', price: '¥7xx' }, { name: 42 }] } }))",
      futureHotelArgs,
    )
    assert.equal(hotelMixed1.result.verdict, 'error')
    assert.match(hotelMixed1.result.evidence, /1\/2/)
    assert.equal(hotelMixed1.facts.length, 0, 'hotel mixed1 不得落事实')
    assert.ok(hotelMixed1.result.process)

    const hotelMixed2 = await runCase(
      cliRoot,
      'hotel-mixed-2',
      "process.stdout.write(JSON.stringify({ data: { itemList: [{ name: '大理 B', price: '¥8xx' }, null] } }))",
      futureHotelArgs,
    )
    assert.equal(hotelMixed2.result.verdict, 'error')
    assert.match(hotelMixed2.result.evidence, /1\/2/)
    assert.equal(hotelMixed2.facts.length, 0, 'hotel mixed2 不得落事实')
    assert.ok(hotelMixed2.result.process)

    const miss = await runCase(cliRoot, 'miss', emptyPayload)
    assert.equal(miss.result.verdict, 'miss')
    assert.ok(miss.result.process, 'miss 必须保留 process')
    assert.equal(miss.result.process?.exitCode, 0)
    assert.equal(miss.facts.length, 1, 'miss 应落一条 exact-date negative fact')
    assert.equal(miss.facts[0]?.kind, 'flight')
    assert.equal(miss.facts[0]?.query_id, 'flyai:flight:北京-上海:2030-04-01')
    assert.equal(miss.facts[0]?.bookability, 'unavailable_exact_date')

    const hit = await runCase(cliRoot, 'hit', hitPayload)
    assert.equal(hit.result.verdict, 'hit')
    assert.ok(hit.result.process, 'hit 必须保留 process')
    assert.equal(hit.result.process?.exitCode, 0)
    assert.equal(hit.facts.length, 1, 'hit 应落一条 positive fact')
    assert.equal(hit.facts[0]?.kind, 'flight')
    assert.equal(hit.facts[0]?.query_id, 'flyai:flight:北京-上海:2030-04-01')
    assert.equal(hit.facts[0]?.bookability, 'bookable_exact_date')
    assert.equal(hit.facts[0]?.flight_no, 'G514')

    const argvChecked = await runCase(
      cliRoot,
      'argv-secret-check',
      "const a = process.argv.slice(2); if (a[0] !== '-y' || a[1] !== '@fly-ai/flyai-cli' || a[2] !== 'search-flight' || a[3] !== '--origin' || a[4] !== 'SECRET_ORIGIN' || a[5] !== '--destination' || a[6] !== 'SECRET_DEST' || a[7] !== '--dep-date' || a[8] !== '2030-04-03') process.exit(91); process.stdout.write(JSON.stringify({ data: { itemList: [] } }))",
      { kind: 'flight', from: 'SECRET_ORIGIN', to: 'SECRET_DEST', date: '2030-04-03' },
    )
    assert.equal(argvChecked.result.verdict, 'miss', 'CLI argv 应按生产契约传入')
    await assertSafeFailure(argvChecked.result, ['SECRET_ORIGIN', 'SECRET_DEST', argvChecked.cliBin])
    assert.equal(argvChecked.facts.length, 1)

    console.log('FLYAI PROCESS PROOF: bad-args/no-spawn; exit23; SIGTERM-over-429; timeout-SIGKILL; delayed-stderr-after-exit; ENOENT; empty stdout; exit1+429 needs-setup; HTTP500 retry; hotel mixed1/2 zero-fact; miss/hit process+fact; argv/secret-safe; subprocess/temp cleanup OK')
  } finally {
    await rm(cliRoot, { recursive: true, force: true })
  }
}

if (process.argv[1]?.endsWith('flyai-process-proof.ts')) await runFlyaiProcessProof()
