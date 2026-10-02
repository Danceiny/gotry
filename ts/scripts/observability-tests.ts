/**
 * 服务运行时观测补齐测试(§73;#272/#511,2026-10-02 UAT 只读实查证实的两个
 * 证据留存缺口)。
 *
 * 全离线确定性(零网络、零真实供应商、零真实模型调用;所有进程与目录隔离在
 * /tmp 临时根,不写共享产品状态):
 *   ① #272 verdict 结构化日志:session-search 模块注入 fake search + verdictLog
 *      收集器,经真 createBackendServer HTTP 面结算——形状断言(键封闭
 *      ts/surface/supplier/verdict/latencyMs[+error])/error 摘要 ≤200 字符/
 *      cookie·ticket·凭据哨兵脱敏为 [REDACTED]/rates·evidence 回包面永不入日志/
 *      换行压平防日志注入/cooldown·异常路径也各落一行/status 结算面独立 verdict。
 *   ② #511 planner 子进程 boot 观测:临时 fixture worker 子进程走真
 *      ManagedDshRunPort JSON-lines 协议——boot 成功一行 HARNESS_BOOT_STAGE
 *      (initializeMs,mode=reused 不重复打)/worker 握手超时一行
 *      HARNESS_BOOT_TIMEOUT(闭集分类+elapsedMs+initializeMs 若可得)/
 *      注入 runPort 的 planner turn 结算 PLANNER_BOOT_TIMEOUT 分类行。
 *   ③ #511 gotry-backend 启动阶段行:startGotryBackendFromEnvironment(离线假
 *      env,booking-copilot 只做惰性配置解析不 spawn planner)——每个模块挂载一行
 *      CORE_BOOT_STAGE(module_mounted)+ listening 一行(port 与句柄一致);
 *      启动失败行 CORE_BOOT_FAILURE 形状与 200 字符有界。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionDidaResult } from '../capabilities/session-search.ts'
import { startSessionSearchModule } from '../src/backend/modules/session-search.ts'
import { closeBackend, createBackendServer } from '../src/backend/kernel.ts'
import { formatBackendBootFailure, startGotryBackendFromEnvironment } from '../src/gotry-backend.ts'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'
import { createDshEmbeddedBookingPlanner, type DshPlannerRunPort } from '../src/booking-surface/dsh-planner.ts'
import type { BookingCopilotTaskState } from '../src/booking-surface/runtime.ts'
import type { BookingWorkspaceSnapshot } from '../src/booking-surface/contracts.ts'

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

const VERDICT_PREFIX = '[session-search] verdict '

interface JsonResult {
  status: number
  body: Record<string, unknown>
}

async function jfetch(url: string, init: RequestInit = {}): Promise<JsonResult> {
  const r = await fetch(url, init)
  const text = await r.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: r.status, body }
}

/** 解析一条 verdict 行:前缀剥离 + JSON 校验 */
function parseVerdictLine(line: string): Record<string, unknown> {
  assert.ok(line.startsWith(VERDICT_PREFIX), `verdict 行必须以 ${VERDICT_PREFIX} 开头:${line}`)
  return JSON.parse(line.slice(VERDICT_PREFIX.length)) as Record<string, unknown>
}

async function main(): Promise<void> {
  /* ================= ① #272 verdict 结构化日志 ================= */

  console.log('① session-search verdict 结构化日志(#272)')
  const verdictLines: string[] = []
  let fakeResult: SessionDidaResult = {
    ok: true, via: 'session-dida-portal', evidence: '[会话:dida-portal@fixture]', latencyMs: 42, verdict: 'hit', rates: [],
  }
  let fakeError: unknown
  const sessionModule = startSessionSearchModule({
    apiKey: () => 'observability-key',
    search: async () => {
      if (fakeError) throw fakeError
      return fakeResult
    },
    verdictLog: (line) => verdictLines.push(line),
  })
  const sessionBackend = await createBackendServer({ modules: [sessionModule], port: 0 })
  const base = `http://127.0.0.1:${sessionBackend.port}`
  const searchInit: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer observability-key' },
    body: JSON.stringify({ supplier: 'dida-portal' }),
  }
  try {
    await check('hit 结算:一行结构化 verdict,键封闭且值正确,回包内容不入日志', async () => {
      // rates 形状对断言无关紧要(仅作为「回包内容」哨兵载体)
      fakeResult = {
        ok: true, via: 'session-dida-portal', evidence: '[会话:dida-portal@SECRET-EVIDENCE]', latencyMs: 42, verdict: 'hit',
        rates: [{ hotelName: 'SECRET-HOTEL-RESPONSE-BODY', price: '100' }] as unknown as SessionDidaResult['rates'],
      }
      const before = verdictLines.length
      const r = await jfetch(`${base}/v1/session/search`, searchInit)
      assert.equal(r.status, 200)
      assert.equal(verdictLines.length - before, 1, 'hit 结算恰好一行')
      const line = verdictLines.at(-1)!
      assert.ok(!line.includes('\n'), 'verdict 行内部不得有换行(日志注入面)')
      assert.ok(!line.includes('SECRET-HOTEL-RESPONSE-BODY'), 'rates 回包内容不入日志')
      assert.ok(!line.includes('SECRET-EVIDENCE'), 'evidence 字段不入日志')
      const record = parseVerdictLine(line)
      assert.deepEqual(Object.keys(record).sort(), ['latencyMs', 'supplier', 'surface', 'ts', 'verdict'], '键封闭:ts/surface/supplier/verdict/latencyMs')
      assert.equal(record.verdict, 'hit')
      assert.equal(record.supplier, 'dida-portal')
      assert.equal(record.surface, 'search')
      assert.equal(record.latencyMs, 42)
      assert.ok(!Number.isNaN(Date.parse(String(record.ts))), 'ts 是可解析时刻')
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(String(record.ts)), 'ts 是 ISO 形状')
    })

    await check('error 结算:cookie/ticket/凭据哨兵脱敏为 [REDACTED],摘要 ≤200 字符,单行化', async () => {
      fakeResult = {
        ok: false, via: 'session-dida-portal-error', evidence: '[会话:dida-portal@fixture]', latencyMs: 7, verdict: 'error',
        error: 'extension job failed; cookie SESSION_TICKET=SECRET-TICKET-9F3A; ticket=SECRET-TICKET-2;\nAuthorization: Bearer sk-SECRET-KEY-1; body fragment ignored',
      }
      const before = verdictLines.length
      const r = await jfetch(`${base}/v1/session/search`, searchInit)
      assert.equal(r.status, 200)
      assert.equal(verdictLines.length - before, 1)
      const line = verdictLines.at(-1)!
      assert.ok(!line.includes('SECRET-TICKET-9F3A'), 'cookie 值不得入日志')
      assert.ok(!line.includes('SECRET-TICKET-2'), 'ticket 值不得入日志')
      assert.ok(!line.includes('sk-SECRET-KEY-1'), 'bearer 凭据值不得入日志')
      assert.ok(line.includes('[REDACTED]'), '被脱敏的值以 [REDACTED] 占位')
      assert.ok(!line.includes('\n'), '原始换行被压平(日志注入面)')
      const record = parseVerdictLine(line)
      assert.equal(record.verdict, 'error')
      assert.ok(typeof record.error === 'string' && record.error.length <= 200, `error 摘要 ≤200 字符,实际 ${String(record.error).length}`)
    })

    await check('超长 error 摘要被截断到 ≤200 字符', async () => {
      fakeResult = {
        ok: false, via: 'session-dida-portal-error', evidence: '', latencyMs: 3, verdict: 'error',
        error: `host copy prefix;${'x'.repeat(400)}`,
      }
      await jfetch(`${base}/v1/session/search`, searchInit)
      const record = parseVerdictLine(verdictLines.at(-1)!)
      assert.ok(typeof record.error === 'string' && record.error.length <= 200 && record.error.length >= 199, '截断后仍 ≤200 且保留信息量')
      assert.ok((record.error as string).endsWith('…'), '截断以省略号标记')
    })

    await check('cooldown 结算:429 + verdict 行 verdict=cooldown', async () => {
      fakeResult = {
        ok: false, via: 'session-dida-portal-error', evidence: '', latencyMs: 5, verdict: 'cooldown', error: '节律冷却中,30s 后重试',
      }
      const r = await jfetch(`${base}/v1/session/search`, searchInit)
      assert.equal(r.status, 429)
      const record = parseVerdictLine(verdictLines.at(-1)!)
      assert.equal(record.verdict, 'cooldown')
    })

    await check('异常结算:500 + verdict 行 verdict=error 且异常消息里的凭据脱敏', async () => {
      fakeError = new Error('search crashed cookie=LEAK-COOKIE-77')
      try {
        const r = await jfetch(`${base}/v1/session/search`, searchInit)
        assert.equal(r.status, 500)
      } finally {
        fakeError = undefined
      }
      const line = verdictLines.at(-1)!
      assert.ok(!line.includes('LEAK-COOKIE-77'), '异常消息里的 cookie 值不得入日志')
      const record = parseVerdictLine(line)
      assert.equal(record.verdict, 'error')
      assert.ok(typeof record.latencyMs === 'number' && record.latencyMs >= 0, 'latencyMs 非负')
    })

    await check('status 结算:surface=status,扩展未连接时 verdict=needs-extension', async () => {
      const before = verdictLines.length
      const r = await jfetch(`${base}/v1/session/status`, { headers: { authorization: 'Bearer observability-key' } })
      assert.equal(r.status, 200)
      assert.equal(verdictLines.length - before, 1)
      const record = parseVerdictLine(verdictLines.at(-1)!)
      assert.equal(record.surface, 'status')
      assert.equal(record.verdict, 'needs-extension')
      assert.equal(record.supplier, 'dida-portal')
      assert.ok(typeof record.latencyMs === 'number' && record.latencyMs >= 0)
    })

    await check('非 verdict 结算(鉴权失败 403)不落 verdict 行', async () => {
      const before = verdictLines.length
      const r = await jfetch(`${base}/v1/session/search`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: JSON.stringify({ supplier: 'dida-portal' }),
      })
      assert.equal(r.status, 403)
      assert.equal(verdictLines.length - before, 0, '鉴权拒绝不是检索结算')
    })
  } finally {
    await closeBackend(sessionBackend, [sessionModule])
  }

  /* ================= ② #511 planner 子进程 boot 观测 ================= */

  console.log('② planner 子进程 boot 观测(#511)')
  const bootScratch = mkdtempSync(join(tmpdir(), 'gotry-obs-boot-'))
  try {
    // fixture worker:真 ManagedDshRunPort JSON-lines 协议;首请求报 started 握手,
    // 后续报 reused(拒绝 HARNESS_BOOT_TIMEOUT 的独立 fixture 在下方)。
    const bootWorkerPath = join(bootScratch, 'boot-fixture-worker.mjs')
    writeFileSync(bootWorkerPath, [
      "import { createInterface } from 'node:readline'",
      "process.stdout.write(JSON.stringify({ lifecycle: 'worker_started', workerPid: process.pid, parentPid: process.ppid }) + '\\n')",
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity })",
      "input.on('line', (line) => {",
      '  const request = JSON.parse(line)',
      '  const first = !globalThis.__booted',
      '  globalThis.__booted = true',
      "  process.stdout.write(JSON.stringify({ id: request.id, boot: first ? { initializeMs: 531, mode: 'started' } : { initializeMs: 0, mode: 'reused' } }) + '\\n')",
      "  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { finalResponse: '', events: [], notifications: [] } }) + '\\n')",
      '})',
      '',
    ].join('\n'), { encoding: 'utf8' })

    await check('boot 成功:每个子进程一行 HARNESS_BOOT_STAGE(role+initializeMs);reused 不重复打', async () => {
      const bootLines: string[] = []
      const port = new ManagedDshRunPort({ workerPath: bootWorkerPath, cleanupRole: 'task', graceMs: 50, bootLog: (line) => bootLines.push(line) })
      try {
        await port.run('fixture', { sessionId: 'observability-boot' })
        assert.deepEqual(bootLines, ['HARNESS_BOOT_STAGE {"role":"task","initializeMs":531,"mode":"started"}'], '首启动恰好一行,含 initializeMs')
        assert.deepEqual(port.bootObservation(), { initializeMs: 531, mode: 'started' })
        await port.run('fixture-two', { sessionId: 'observability-boot' })
        assert.deepEqual(port.bootObservation(), { initializeMs: 0, mode: 'reused' })
        assert.equal(bootLines.length, 1, 'reused 没有再 boot,不再打行')
      } finally {
        await port.close()
      }
    })

    const timeoutWorkerPath = join(bootScratch, 'boot-timeout-fixture-worker.mjs')
    writeFileSync(timeoutWorkerPath, [
      "import { createInterface } from 'node:readline'",
      "process.stdout.write(JSON.stringify({ lifecycle: 'worker_started', workerPid: process.pid, parentPid: process.ppid }) + '\\n')",
      "const input = createInterface({ input: process.stdin, crlfDelay: Infinity })",
      "input.on('line', (line) => {",
      '  const request = JSON.parse(line)',
      `  process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: 'HARNESS_BOOT_TIMEOUT' }) + '\\n')`,
      '})',
      '',
    ].join('\n'), { encoding: 'utf8' })
    await check('worker 握手超时:HARNESS_BOOT_TIMEOUT 行(闭集分类+elapsedMs+initializeMs=null)', async () => {
      const bootLines: string[] = []
      const port = new ManagedDshRunPort({ workerPath: timeoutWorkerPath, cleanupRole: 'task', graceMs: 50, bootLog: (line) => bootLines.push(line) })
      try {
        await assert.rejects(() => port.run('fixture', { sessionId: 'observability-boot-timeout' }), /HARNESS_BOOT_TIMEOUT/)
        assert.equal(bootLines.length, 1)
        const line = bootLines[0]!
        assert.ok(line.startsWith('HARNESS_BOOT_TIMEOUT '), `行前缀必须是 HARNESS_BOOT_TIMEOUT:${line}`)
        const record = JSON.parse(line.slice('HARNESS_BOOT_TIMEOUT '.length)) as Record<string, unknown>
        assert.equal(record.role, 'task')
        assert.equal(record.initializeMs, null, '握手从未完成,initializeMs 不可得即为 null')
        assert.ok(typeof record.elapsedMs === 'number' && record.elapsedMs >= 0, 'elapsedMs 时刻差非负')
      } finally {
        await port.close()
      }
    })

    await check('planner 结算:boot 超时分类 PLANNER_BOOT_TIMEOUT 行(initializeMs/mode 不可得即 null)', async () => {
      const availability: BookingCopilotTaskState['availability'] = {
        initialized: true, recoveryStarted: false, availabilityPhase: 'need_offers', activeHotelOrdinal: 0,
        hotelRefs: [], hotels: {}, attempts: [], queryReservations: [],
      }
      const task: BookingCopilotTaskState = {
        schemaVersion: 'booking.surface',
        taskId: 'task-observability-boot-1',
        contextRef: 'ctx-observability-boot-1',
        surface: 'tenant',
        revision: 0,
        allowedActions: ['search.patch', 'search.run'],
        userTurnCount: 1,
        lastTurnId: 'turn-observability-boot-1',
        operationCount: 0,
        phase: 'planning',
        lastSequence: 0,
        availability,
      }
      const workspace: BookingWorkspaceSnapshot = {
        schemaVersion: 'booking.surface',
        contextRef: task.contextRef,
        surface: 'tenant',
        revision: 0,
        locale: 'zh-CN',
        currency: 'CNY',
        searchDraft: {},
        results: { status: 'idle' },
        visibleHotels: [],
        loadedOffers: [],
        shortlistedOfferRefs: [],
        capabilities: { surface: 'tenant', allowedActions: ['search.patch', 'search.run'] },
      }
      task.workspaceSnapshot = workspace
      const turn = {
        schemaVersion: 'booking.surface' as const,
        kind: 'user.turn' as const,
        taskId: task.taskId,
        turnId: task.lastTurnId!,
        workspace,
        request: { text: 'Find hotels' },
      }
      const captured: string[] = []
      const originalStderrWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: unknown): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
        return true
      }) as typeof process.stderr.write
      let planner: Awaited<ReturnType<typeof createDshEmbeddedBookingPlanner>> | undefined
      try {
        const factoryPort: DshPlannerRunPort = {
          run: () => Promise.reject(new Error('HARNESS_BOOT_TIMEOUT')),
          async close() {},
          bootObservation: () => undefined,
        }
        planner = await createDshEmbeddedBookingPlanner({ runPortFactory: () => factoryPort, turnTimeoutMs: 1_000 })
        const decisions = await planner.plannerFactory(task).next({ task, turn })
        assert.equal(decisions[0]?.kind, 'error')
        assert.equal((decisions[0] as { error?: { code?: string } }).error?.code, 'PLANNER_BOOT_TIMEOUT')
        await planner.close()
        planner = undefined
        const line = captured.find((value) => value.startsWith('PLANNER_BOOT_TIMEOUT '))
        assert.ok(line, '服务进程 stderr 必须出现 PLANNER_BOOT_TIMEOUT 行')
        const record = JSON.parse(line.slice('PLANNER_BOOT_TIMEOUT '.length).trim()) as Record<string, unknown>
        assert.deepEqual(record, { initializeMs: null, mode: null })
      } finally {
        process.stderr.write = originalStderrWrite
        await planner?.close().catch(() => undefined)
      }
    })
  } finally {
    rmSync(bootScratch, { recursive: true, force: true })
  }

  /* ================= ③ #511 gotry-backend 启动阶段行 ================= */

  console.log('③ gotry-backend 启动阶段行(#511)')
  const backendScratch = mkdtempSync(join(tmpdir(), 'gotry-obs-backend-'))
  let backendHandle: Awaited<ReturnType<typeof startGotryBackendFromEnvironment>> | undefined
  try {
    await check('启动:每模块一行 module_mounted + 一行 listening(port 与句柄一致)', async () => {
      const stageLines: string[] = []
      backendHandle = await startGotryBackendFromEnvironment({
        GOTRY_BACKEND_PORT: '0',
        GOTRY_BACKEND_SESSION_API_KEY: 'observability-session-key',
        GOTRY_BACKEND_STATE_ROOT: backendScratch,
        GOTRY_BOOKING_COPILOT_API_KEY: 'observability-copilot-key',
        GOTRY_BOOKING_COPILOT_STATE_ROOT: backendScratch,
        DEEPSEEK_API_KEY: 'offline-fake-key-planner-not-spawned-at-boot',
      }, (line) => stageLines.push(line))
      const records = stageLines.map((line) => {
        assert.ok(line.startsWith('CORE_BOOT_STAGE '), `启动阶段行前缀必须是 CORE_BOOT_STAGE:${line}`)
        return JSON.parse(line.slice('CORE_BOOT_STAGE '.length)) as Record<string, unknown>
      })
      const mounted = records.filter((record) => record.phase === 'module_mounted')
      assert.deepEqual(mounted.map((record) => record.module), ['booking-copilot', 'session-search', 'booking-executor'], '每个模块挂载一行,按挂载顺序')
      for (const record of mounted) {
        assert.ok(typeof record.elapsedMs === 'number' && record.elapsedMs >= 0, 'module_mounted 携带非负 elapsedMs')
      }
      const listening = records.at(-1)!
      assert.equal(listening.phase, 'listening')
      assert.equal(listening.port, backendHandle.port, 'listening 行端口与句柄一致')
      assert.equal(listening.modules, 'booking-copilot,session-search,booking-executor')
    })

    await check('启动失败行:CORE_BOOT_FAILURE 数组形状,error 摘要 ≤200 字符', () => {
      const line = formatBackendBootFailure(new Error('x'.repeat(500)))
      assert.ok(line.startsWith('CORE_BOOT_FAILURE '), '启动失败行前缀必须是 CORE_BOOT_FAILURE')
      const [record] = JSON.parse(line.slice('CORE_BOOT_FAILURE '.length)) as Array<{ phase: string; error: string }>
      assert.equal(record.phase, 'startup')
      assert.ok(record.error.length <= 200 && record.error.length === 200, '500 字符消息被截到 200')
      assert.ok(!line.includes('\n'), '失败行单行')
    })

    await check('启动失败(缺 booking-copilot key):同一函数落 CORE_BOOT_FAILURE 后原样抛出', async () => {
      const failureLines: string[] = []
      await assert.rejects(
        () => startGotryBackendFromEnvironment({
          GOTRY_BACKEND_PORT: '0',
          GOTRY_BACKEND_SESSION_API_KEY: 'observability-session-key',
          // GOTRY_BOOKING_COPILOT_API_KEY 缺失 → booking_copilot_api_key_required
        }, (line) => failureLines.push(line)),
        /booking_copilot_api_key_required/,
      )
      const line = failureLines.find((value) => value.startsWith('CORE_BOOT_FAILURE '))
      assert.ok(line, '模块挂载失败必须经启动函数落 CORE_BOOT_FAILURE(bin 包装层直接调本函数)')
      const [record] = JSON.parse(line.slice('CORE_BOOT_FAILURE '.length)) as Array<{ phase: string; error: string }>
      assert.equal(record.phase, 'startup')
      assert.ok(!line.includes('offline-fake-key'), '失败行不含密钥材料')
    })

    await check('健康面可达后干净关闭', async () => {
      const r = await jfetch(`http://127.0.0.1:${backendHandle!.port}/healthz`, { headers: { authorization: 'Bearer observability-copilot-key' } })
      assert.ok(r.status === 200 || r.status === 503, `healthz 探活可达(实际 ${r.status})`)
    })
  } finally {
    await backendHandle?.close().catch(() => undefined)
    rmSync(backendScratch, { recursive: true, force: true })
  }

  console.log(`\n§73 observability: ${passed} 段全绿`)
}

main().catch((error) => {
  console.error('FAIL:', error)
  process.exit(1)
})
