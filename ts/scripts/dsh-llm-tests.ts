/**
 * dsh-llm chat() 请求级超时 / 调用方取消 合同测试(run-all §88,issue #618)。
 * 全离线、确定性、零 API 花费:127.0.0.1 上的假 provider 夹具(收下连接却永不应答 / 响应头后正文卡死 /
 * 正常应答),fetch 间谍保证整套测试没有任何请求离开 127.0.0.1。
 *
 * 覆盖:
 *   - 预算解析:调用显式值 > GOTRY_LLM_TIMEOUT_MS > 默认 300000;非正整数忽略;超大值夹住(不溢出成 1ms);
 *   - 卡死 provider(无响应头 / 响应头后正文卡死 / 非 2xx 的错误正文卡死)在预算内落成
 *     LlmRequestError('timeout'),不挂起、usage 不动;
 *   - 调用方 signal(中途 abort / 已 abort / 自定义 reason / 带 signal 但先超时)落成 LlmRequestError('aborted'|'timeout');
 *   - 正常快应答:请求字节与应答处理逐字不变,usage 照常累计,缺 usage 仍计 responsesMissingUsage(fail-closed 语义不变);
 *   - 非 abort 失败(HTTP 500 / 连接被拒 / 缺 key)仍是原样的普通 Error,不被改写;
 *   - 调用方不吞:runTurn 与 nightly-evidence 对卡死 provider 抛类型化失败,且 nightly 零写入。
 * 所有等待都套 bounded():断言失败(含「修复被回退后永远挂起」)只会让对应用例失败,绝不会让本测试自己挂起。
 * 运行:cd ts && npx tsx scripts/dsh-llm-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 命名空间导入:被测模块的新符号缺失(修复被回退)时只会让对应用例失败(undefined),而不是整个文件在链接期崩掉,
// 这样红基线能如实显示「卡死用例被 bounded 截住」而不是一个无信息量的 SyntaxError。
import * as dshLlm from '../src/dsh-llm.ts'
import type { InterviewQuestion } from '../src/contracts.ts'
import { newState, runTurn } from '../src/loop.ts'
import { runNightlyEvidence } from './nightly-evidence.ts'

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createOpenAICompatLlm, LlmRequestError, resolveLlmTimeoutMs, DEFAULT_LLM_TIMEOUT_MS } = dshLlm

/** 超过它还没落定 = 挂起(正常卡死用例预算仅数百毫秒;留足慢机/高负载余量)。 */
const HANG_BOUND_MS = 6_000
/** 卡死用例统一的请求预算:够短让套件快,够长不被调度抖动误伤。 */
const STALL_TIMEOUT_MS = 400
const CLOCK = () => new Date('2026-10-05T00:00:00Z')
const QUESTION: InterviewQuestion = { key: 'workWindow', text: '你这两周的工作时间是几点到几点?', why: '决定每日可玩时段' }

// ---- 夹具:假 OpenAI 兼容 provider -----------------------------------------------------------

type Mode =
  | 'ok' // 带完整 usage(含缓存明细)的正常应答,正文含 <think> 块
  | 'ok-no-cache-detail' // usage 只有 prompt/completion tokens
  | 'ok-no-usage' // 没有 usage 字段 → 成本不可证
  | 'ok-json' // JSON 模式(extractFacts)的正常应答
  | 'error-500' // 立即 500 + 错误正文
  | 'stall' // 收下请求,永不应答(连响应头都不发)
  | 'stall-body' // 200 + 半截 JSON 后正文卡死
  | 'stall-error-body' // 500 + 半截错误正文后卡死

interface Hit {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

interface Provider {
  url: string
  mode: Mode
  hits: Hit[]
  closeAll(): Promise<void>
}

const OK_CONTENT = '<think>先想一想</think>  润色后的问句  '
const FACTS_CONTENT = JSON.stringify({ calendar: { year: 2026, assertedWeekdays: { '2026-10-05': 'mon' } } })

function completion(content: string, usage?: Record<string, number>): string {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], ...(usage ? { usage } : {}) })
}

async function startProvider(): Promise<Provider> {
  const sockets = new Set<Socket>()
  const state = { mode: 'ok' as Mode }
  const hits: Hit[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      hits.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
      const json = (status: number, text: string): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(text)
      }
      switch (state.mode) {
        case 'ok':
          return json(200, completion(OK_CONTENT, { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 }))
        case 'ok-no-cache-detail':
          return json(200, completion(OK_CONTENT, { prompt_tokens: 50, completion_tokens: 10 }))
        case 'ok-no-usage':
          return json(200, completion(OK_CONTENT))
        case 'ok-json':
          return json(200, completion(FACTS_CONTENT, { prompt_tokens: 7, completion_tokens: 3 }))
        case 'error-500':
          return json(500, 'fixture upstream exploded')
        case 'stall':
          return // 永不应答
        case 'stall-body':
          response.writeHead(200, { 'content-type': 'application/json' })
          response.write('{"choices":[{"message":')
          return
        case 'stall-error-body':
          response.writeHead(500, { 'content-type': 'text/plain' })
          response.write('upstream says')
          return
      }
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    get mode() { return state.mode },
    set mode(next: Mode) { state.mode = next },
    hits,
    closeAll: () => new Promise<void>(resolveClose => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolveClose())
    }),
  }
}

// ---- 测试脚手架 ------------------------------------------------------------------------------

class TestHang extends Error {}

/** 等 work 落定;超过 ms 仍未落定则抛 TestHang(挂起 = 测试失败,而不是测试自己挂起)。 */
async function bounded<T>(label: string, work: Promise<T>, ms = HANG_BOUND_MS): Promise<T> {
  work.catch(() => {}) // 输掉竞速的一方若稍后 reject,不得变成 unhandled rejection
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TestHang(`TEST HANG: ${label} had not settled after ${ms}ms (no request timeout / abort took effect)`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 断言 work 以拒绝收场,并返回拒绝原因与耗时;挂起原样上抛为 TestHang,正常返回则判失败。 */
async function rejection(label: string, work: Promise<unknown>): Promise<{ error: unknown; elapsedMs: number }> {
  const started = performance.now()
  try {
    await bounded(label, work)
  } catch (error) {
    if (error instanceof TestHang) throw error
    return { error, elapsedMs: performance.now() - started }
  }
  throw new assert.AssertionError({ message: `${label}: expected the call to reject, but it resolved` })
}

async function until(label: string, predicate: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label}: condition not reached within ${ms}ms`)
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 10))
  }
}

async function withEnv<T>(patch: Record<string, string | undefined>, body: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(patch)
  try {
    return await body()
  } finally {
    apply(saved)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function assertTimeoutFailure(error: unknown, timeoutMs: number): asserts error is dshLlm.LlmRequestError {
  assert.ok(error instanceof LlmRequestError, `expected LlmRequestError, got ${describe(error)}`)
  assert.equal(error.code, 'timeout')
  assert.equal(error.name, 'TimeoutError', 'platform name, so name-based classifiers (persona-sim, channel-probe) recognise it')
  assert.equal(error.timeoutMs, timeoutMs)
  assert.match(error.message, new RegExp(`^llm timeout: .*${timeoutMs}ms`), 'module `llm <kind>: <detail>` message convention')
  assert.equal((error.cause as { name?: string } | undefined)?.name, 'TimeoutError', 'original abort error is kept as cause')
}

function assertAbortedFailure(error: unknown): asserts error is dshLlm.LlmRequestError {
  assert.ok(error instanceof LlmRequestError, `expected LlmRequestError, got ${describe(error)}`)
  assert.equal(error.code, 'aborted')
  assert.equal(error.name, 'AbortError')
  assert.equal(error.timeoutMs, undefined)
  assert.match(error.message, /^llm aborted: /)
}

function assertUntouched(usage: dshLlm.LlmUsageTracker, label: string): void {
  assert.deepEqual(usage, { calls: 0, inputTokens: 0, outputTokens: 0, inputCacheHitTokens: 0, inputCacheMissTokens: 0, responsesMissingUsage: 0 }, `${label}: a call that produced no response must not touch the usage tracker`)
}

// ---- 用例 ------------------------------------------------------------------------------------

let passed = 0
const failures: string[] = []
async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body()
    passed += 1
    console.log(`  ok ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  FAIL ${name}\n    ${describe(error).split('\n').join('\n    ')}`)
  }
}

const provider = await startProvider()
const savedFetch = globalThis.fetch
const savedEnv = Object.fromEntries(['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'GOTRY_LLM_TIMEOUT_MS'].map(key => [key, process.env[key]]))
// 间谍:任何离开 127.0.0.1 的请求都直接抛错(不是仅记录),回归也带不走凭证
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (target.hostname !== '127.0.0.1') throw new Error(`TEST ESCAPE: request to ${target.hostname} left the loopback fixture`)
  return savedFetch(input, init)
}) as typeof fetch
process.env['LLM_API_KEY'] = 'fixture-key'
process.env['LLM_BASE_URL'] = provider.url
process.env['LLM_MODEL'] = 'fixture-model'
for (const alias of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'GOTRY_LLM_TIMEOUT_MS']) delete process.env[alias]

try {
  console.log('dsh-llm request timeout / abort contract (issue #618)')

  await test('timeout budget: default 300000; call > env > default; invalid ignored; huge value clamped', async () => {
    assert.equal(DEFAULT_LLM_TIMEOUT_MS, 300_000)
    assert.equal(resolveLlmTimeoutMs(), 300_000)
    assert.equal(resolveLlmTimeoutMs(1_500), 1_500)
    await withEnv({ GOTRY_LLM_TIMEOUT_MS: '45000' }, () => {
      assert.equal(resolveLlmTimeoutMs(), 45_000)
      assert.equal(resolveLlmTimeoutMs(1_500), 1_500, 'an explicit per-call value beats the env var')
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(resolveLlmTimeoutMs(bad), 45_000, `invalid per-call ${String(bad)} is ignored and falls through to the env var`)
      }
    })
    await withEnv({ GOTRY_LLM_TIMEOUT_MS: ' 45000 ' }, () => assert.equal(resolveLlmTimeoutMs(), 45_000, 'surrounding whitespace is tolerated'))
    for (const bad of ['0', '-5', '1.5', 'abc', '', '   ', '1e3', '12ms', '0x10', '+5', 'Infinity', 'NaN', '99999999999999999999999']) {
      await withEnv({ GOTRY_LLM_TIMEOUT_MS: bad }, () => assert.equal(resolveLlmTimeoutMs(), 300_000, `env ${JSON.stringify(bad)} is ignored -> default (never "no timeout")`))
    }
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(resolveLlmTimeoutMs(bad), 300_000, `invalid per-call ${String(bad)} with no env -> default`)
    }
    // Node 把 > 2^31-1 的定时器延迟溢出成 1ms(「配得越大越立刻超时」);必须夹住而不是透传
    assert.equal(resolveLlmTimeoutMs(2 ** 40), 2_147_483_647)
    await withEnv({ GOTRY_LLM_TIMEOUT_MS: '3000000000' }, () => assert.equal(resolveLlmTimeoutMs(), 2_147_483_647))
  })

  await test('stalled provider (accepts, never answers): per-call timeoutMs -> typed timeout inside the budget, usage untouched', async () => {
    provider.mode = 'stall'
    const before = provider.hits.length
    const port = createOpenAICompatLlm(undefined, CLOCK, { timeoutMs: STALL_TIMEOUT_MS })
    const { error, elapsedMs } = await rejection('stalled provider / per-call timeoutMs', port.polishQuestion(QUESTION))
    assertTimeoutFailure(error, STALL_TIMEOUT_MS)
    assert.ok(elapsedMs >= STALL_TIMEOUT_MS - 50, `rejected after ${elapsedMs.toFixed(0)}ms: must not fire before the budget`)
    assert.ok(elapsedMs < HANG_BOUND_MS, `rejected after ${elapsedMs.toFixed(0)}ms: must settle inside the budget, not at the hang bound`)
    assertUntouched(port.usage, 'stalled provider')
    await until('the stalled request reached the fixture (a real stall, not a refused connection)', () => provider.hits.length === before + 1)
  })

  await test('stalled provider: GOTRY_LLM_TIMEOUT_MS drives the default port', async () => {
    provider.mode = 'stall'
    await withEnv({ GOTRY_LLM_TIMEOUT_MS: String(STALL_TIMEOUT_MS) }, async () => {
      const port = createOpenAICompatLlm(undefined, CLOCK)
      const { error } = await rejection('stalled provider / env timeout', port.polishQuestion(QUESTION))
      assertTimeoutFailure(error, STALL_TIMEOUT_MS)
      assertUntouched(port.usage, 'env timeout')
    })
  })

  await test('per-call timeoutMs beats a generous GOTRY_LLM_TIMEOUT_MS', async () => {
    provider.mode = 'stall'
    await withEnv({ GOTRY_LLM_TIMEOUT_MS: '600000' }, async () => {
      const port = createOpenAICompatLlm(undefined, CLOCK, { timeoutMs: STALL_TIMEOUT_MS })
      const { error } = await rejection('stalled provider / per-call over env', port.polishQuestion(QUESTION))
      assertTimeoutFailure(error, STALL_TIMEOUT_MS)
    })
  })

  await test('timeout covers reading the body: 200 headers then a stalled body -> typed timeout', async () => {
    provider.mode = 'stall-body'
    const port = createOpenAICompatLlm(undefined, CLOCK, { timeoutMs: STALL_TIMEOUT_MS })
    const { error } = await rejection('stalled body', port.polishQuestion(QUESTION))
    assertTimeoutFailure(error, STALL_TIMEOUT_MS)
    assertUntouched(port.usage, 'stalled body')
  })

  await test('timeout covers the error body too: 500 headers then a stalled body -> typed timeout (not `llm 500`, not a hang)', async () => {
    provider.mode = 'stall-error-body'
    const port = createOpenAICompatLlm(undefined, CLOCK, { timeoutMs: STALL_TIMEOUT_MS })
    const { error } = await rejection('stalled error body', port.polishQuestion(QUESTION))
    assertTimeoutFailure(error, STALL_TIMEOUT_MS)
    assertUntouched(port.usage, 'stalled error body')
  })

  await test('caller abort mid-flight: rejects promptly with a typed `aborted` failure (default 300s budget is not what ended it)', async () => {
    provider.mode = 'stall'
    const controller = new AbortController()
    const port = createOpenAICompatLlm(undefined, CLOCK, { signal: controller.signal })
    const pending = port.polishQuestion(QUESTION)
    setTimeout(() => controller.abort(), 100)
    const { error, elapsedMs } = await rejection('caller abort', pending)
    assertAbortedFailure(error)
    assert.ok(elapsedMs < HANG_BOUND_MS, `abort took ${elapsedMs.toFixed(0)}ms`)
    assertUntouched(port.usage, 'caller abort')
  })

  await test('caller abort with a custom reason: still `aborted`, and the reason object survives as cause', async () => {
    provider.mode = 'stall'
    const controller = new AbortController()
    const reason = new Error('operator pressed ctrl-c')
    const port = createOpenAICompatLlm(undefined, CLOCK, { signal: controller.signal })
    const pending = port.polishQuestion(QUESTION)
    setTimeout(() => controller.abort(reason), 100)
    const { error } = await rejection('caller abort with reason', pending)
    assertAbortedFailure(error)
    assert.equal(error.cause, reason)
  })

  await test('already-aborted signal: rejects `aborted` without ever reaching the provider', async () => {
    provider.mode = 'ok'
    const controller = new AbortController()
    controller.abort()
    const before = provider.hits.length
    const port = createOpenAICompatLlm(undefined, CLOCK, { signal: controller.signal })
    const { error } = await rejection('pre-aborted signal', port.polishQuestion(QUESTION))
    assertAbortedFailure(error)
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 100))
    assert.equal(provider.hits.length, before, 'no request may be sent on behalf of a cancelled caller')
    assertUntouched(port.usage, 'pre-aborted')
  })

  await test('caller signal supplied but never aborted: the timeout still wins (AbortSignal.any composition)', async () => {
    provider.mode = 'stall'
    const controller = new AbortController()
    const port = createOpenAICompatLlm(undefined, CLOCK, { signal: controller.signal, timeoutMs: STALL_TIMEOUT_MS })
    const { error } = await rejection('signal + timeout', port.polishQuestion(QUESTION))
    assertTimeoutFailure(error, STALL_TIMEOUT_MS)
    assert.equal(controller.signal.aborted, false, 'the caller\'s own signal is not aborted by our timeout')
  })

  await test('normal fast response: request bytes and reply handling are unchanged, usage accumulates, missing usage still counts', async () => {
    provider.mode = 'ok'
    const port = createOpenAICompatLlm(undefined, CLOCK)
    const out = await bounded('fast response', port.polishQuestion(QUESTION))
    assert.equal(out, '润色后的问句', '<think> block stripped, text trimmed — same as before')
    const hit = provider.hits.at(-1)!
    assert.equal(hit.method, 'POST')
    assert.equal(hit.url, '/v1/chat/completions')
    assert.equal(hit.headers['content-type'], 'application/json')
    assert.equal(hit.headers['authorization'], 'Bearer fixture-key')
    const sent = JSON.parse(hit.body) as { model: string; messages: Array<{ role: string; content: string }>; temperature: number }
    assert.deepEqual(Object.keys(sent), ['model', 'messages', 'temperature'], 'same field set and order (no response_format outside JSON mode)')
    assert.equal(hit.body, JSON.stringify(sent), 'raw request bytes are exactly the canonical serialisation')
    assert.equal(sent.model, 'fixture-model')
    assert.equal(sent.temperature, 0.7)
    assert.equal(sent.messages[0]?.role, 'system')
    assert.deepEqual(sent.messages[1], { role: 'user', content: `【${QUESTION.key}】${QUESTION.text}(为什么问:${QUESTION.why})` })
    assert.deepEqual(port.usage, { calls: 1, inputTokens: 120, outputTokens: 30, inputCacheHitTokens: 100, inputCacheMissTokens: 20, responsesMissingUsage: 0 })

    provider.mode = 'ok-no-cache-detail' // 无缓存明细:全部输入按 miss 记
    await bounded('fast response / no cache detail', port.polishQuestion(QUESTION))
    assert.deepEqual(port.usage, { calls: 2, inputTokens: 170, outputTokens: 40, inputCacheHitTokens: 100, inputCacheMissTokens: 70, responsesMissingUsage: 0 })

    provider.mode = 'ok-no-usage' // 缺 usage:calls 照计,成本不可证由 responsesMissingUsage 标出(调用方 fail-closed)
    await bounded('fast response / no usage', port.polishQuestion(QUESTION))
    assert.deepEqual(port.usage, { calls: 3, inputTokens: 170, outputTokens: 40, inputCacheHitTokens: 100, inputCacheMissTokens: 70, responsesMissingUsage: 1 })

    // 显式给出(宽松的)选项不改变正常流程:请求字节与第一次逐字相同
    provider.mode = 'ok'
    const optioned = createOpenAICompatLlm(undefined, CLOCK, { timeoutMs: 30_000, signal: new AbortController().signal })
    assert.equal(await bounded('fast response / options', optioned.polishQuestion(QUESTION)), '润色后的问句')
    assert.equal(provider.hits.at(-1)!.body, hit.body, 'timeout/signal options must not leak into the request')
    assert.equal(optioned.usage.calls, 1)
  })

  await test('JSON mode request bytes are unchanged (response_format + temperature 0) and the reply still parses', async () => {
    provider.mode = 'ok-json'
    const port = createOpenAICompatLlm(undefined, CLOCK)
    const facts = await bounded('extractFacts', port.extractFacts([{ role: 'user', text: '我这两周在大理远程办公' }], newState()))
    assert.deepEqual(facts.calendar, { year: 2026, assertedWeekdays: { '2026-10-05': 'mon' } })
    const hit = provider.hits.at(-1)!
    const sent = JSON.parse(hit.body) as { response_format: unknown; temperature: number }
    assert.deepEqual(Object.keys(sent), ['model', 'messages', 'response_format', 'temperature'])
    assert.deepEqual(sent.response_format, { type: 'json_object' })
    assert.equal(sent.temperature, 0)
    assert.equal(hit.body, JSON.stringify(sent))
    assert.deepEqual(port.usage, { calls: 1, inputTokens: 7, outputTokens: 3, inputCacheHitTokens: 0, inputCacheMissTokens: 7, responsesMissingUsage: 0 })
  })

  await test('a huge GOTRY_LLM_TIMEOUT_MS does not overflow into an instant timeout (clamped, normal call succeeds)', async () => {
    provider.mode = 'ok'
    await withEnv({ GOTRY_LLM_TIMEOUT_MS: '3000000000' }, async () => {
      const port = createOpenAICompatLlm(undefined, CLOCK)
      assert.equal(await bounded('huge env timeout', port.polishQuestion(QUESTION)), '润色后的问句')
    })
  })

  await test('non-abort failures are untouched: HTTP 500 stays a plain `llm 500:` Error, refused connection stays a transport error, missing key stays the ADR-8 error', async () => {
    provider.mode = 'error-500'
    const port = createOpenAICompatLlm(undefined, CLOCK)
    const http = await rejection('http 500', port.polishQuestion(QUESTION))
    assert.ok(http.error instanceof Error && !(http.error instanceof LlmRequestError), `HTTP failure must not be rewritten: ${describe(http.error)}`)
    assert.equal((http.error as Error).message, 'llm 500: fixture upstream exploded')
    assertUntouched(port.usage, 'http 500')

    // 连接被拒:先占一个端口再关掉,保证确定性地「没人在听」
    const spare = createServer()
    await new Promise<void>(resolveListen => spare.listen(0, '127.0.0.1', () => resolveListen()))
    const deadPort = (spare.address() as AddressInfo).port
    await new Promise<void>(resolveClose => spare.close(() => resolveClose()))
    await withEnv({ LLM_BASE_URL: `http://127.0.0.1:${deadPort}/v1` }, async () => {
      const refused = await rejection('connection refused', createOpenAICompatLlm(undefined, CLOCK).polishQuestion(QUESTION))
      assert.ok(refused.error instanceof Error && !(refused.error instanceof LlmRequestError), `transport failure must not be rewritten: ${describe(refused.error)}`)
      assert.notEqual((refused.error as Error).name, 'TimeoutError')
      assert.notEqual((refused.error as Error).name, 'AbortError')
    })

    const before = provider.hits.length
    await withEnv({ LLM_API_KEY: undefined, DEEPSEEK_API_KEY: undefined }, async () => {
      const keyless = await rejection('missing key', createOpenAICompatLlm(undefined, CLOCK).polishQuestion(QUESTION))
      assert.match((keyless.error as Error).message, /LLM_API_KEY 未设置/)
      assert.ok(!(keyless.error instanceof LlmRequestError))
    })
    assert.equal(provider.hits.length, before, 'no request without a key')
  })

  await test('caller does not swallow it: loop.runTurn rejects with the typed timeout (no degraded "success" reply)', async () => {
    provider.mode = 'stall'
    const port = createOpenAICompatLlm(undefined, CLOCK, { timeoutMs: STALL_TIMEOUT_MS })
    const { error } = await rejection('runTurn over a stalled provider', runTurn(newState(), '我想去大理待两周', port, [], null, CLOCK()))
    assertTimeoutFailure(error, STALL_TIMEOUT_MS)
  })

  await test('caller does not swallow it: nightly-evidence rejects on a stalled provider and writes no evidence', async () => {
    provider.mode = 'stall'
    const evidenceParent = mkdtempSync(join(tmpdir(), 'dsh-llm-nightly-'))
    const evidenceRoot = join(evidenceParent, 'evidence', 'm3')
    const savedCwd = process.cwd()
    process.chdir(TS_ROOT) // nightly-evidence 的价表/提示集/航班包路径相对 ts/
    try {
      await withEnv({ GOTRY_LLM_TIMEOUT_MS: String(STALL_TIMEOUT_MS) }, async () => {
        const { error } = await rejection('nightly over a stalled provider', runNightlyEvidence({ evidenceRoot, dryRun: false, clock: CLOCK }))
        assertTimeoutFailure(error, STALL_TIMEOUT_MS)
      })
      assert.equal(existsSync(join(evidenceRoot, 'cohort.jsonl')), false, 'a timed-out run must not write a cost/evidence record')
      assert.equal(existsSync(evidenceRoot), false, 'and must not even create the evidence directory')
    } finally {
      process.chdir(savedCwd)
      rmSync(evidenceParent, { recursive: true, force: true })
    }
  })
} finally {
  globalThis.fetch = savedFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await provider.closeAll()
}

if (failures.length > 0) {
  console.log(`\nDSH-LLM TESTS: ${failures.length} FAILED, ${passed} passed`)
  for (const name of failures) console.log(`  - ${name}`)
  process.exitCode = 1
} else {
  console.log(`\nDSH-LLM TESTS OK: ${passed} cases (request timeout/abort contract; offline, loopback only)`)
}
