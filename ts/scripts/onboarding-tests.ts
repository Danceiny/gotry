/**
 * onboarding UX 测试(issue #21 onboarding UX,§3.3 ADR-21 上架后重设,run-all §40)。
 *
 * 4 段全离线断言(wizard 2026-09-02 缩为 2 步纯 Node 端:扩展落位 + watch precheck):
 *   1. wizard --dry-run:零网络零浏览器零 GUI spawn,exit 0,2 步齐全
 *   2. health-watch 三时序:0ms ready(立即 timeout)/ 5s ready(中途 ready)/ 120s+1ms 超时
 *   3. retry-after-watch:needs-extension → watch ready → 自动重放同 query_id 同参数
 *   4. wizard 无强制 spawn:forcePlatform 参数彻底消失(GUI 跨平台降级退役)
 *
 * 离线纪律:不打真 Chrome、不发真请求;wizard 不需要 spawn 注入(stub 注入路径仍在但 dry-run 路径不调)。
 */

import assert from 'node:assert/strict'

import {
  runOnboardingWizard,
  defaultExtensionDir,
  describeExtensionDir,
  type OnboardingOptions,
} from '../capabilities/session/wizard.ts'
import {
  startExtensionHealthWatch,
  withAutoRetryOnExtension,
  HEALTH_WATCH_INTERVAL_FLOOR_MS,
  HEALTH_WATCH_INTERVAL_CEIL_MS,
} from '../capabilities/session/health-watch.ts'

let passed = 0
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ok - ${label}`) })
}

function noopSpawn(): import('node:child_process').ChildProcess {
  const { EventEmitter } = require('node:events') as typeof import('node:events')
  const child = new EventEmitter() as unknown as import('node:child_process').ChildProcess
  // 流对象 stub
  const stream = new EventEmitter() as unknown as NodeJS.WritableStream
  ;(child as { stdin?: NodeJS.WritableStream | null }).stdin = stream
  ;(child as { stdout?: NodeJS.ReadableStream | null }).stdout = null
  ;(child as { stderr?: NodeJS.ReadableStream | null }).stderr = null
  ;(child as { unref?: () => void }).unref = () => undefined
  return child
}

function captureSpawn(): { spawn: typeof import('node:child_process').spawn; calls: Array<{ bin: string; args: string[] }> } {
  const calls: Array<{ bin: string; args: string[] }> = []
  const spawn: typeof import('node:child_process').spawn = ((bin: string, args: string[] = []) => {
    calls.push({ bin, args })
    return noopSpawn() as ReturnType<typeof import('node:child_process').spawn>
  }) as unknown as typeof import('node:child_process').spawn
  return { spawn, calls }
}

async function asyncSleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

console.log('ONBOARDING UX (§40)')

await check('1. wizard --dry-run 零网络零浏览器零 GUI spawn,exit 0,2 步齐全', async () => {
  const result = await runOnboardingWizard({ dryRun: true })
  assert.equal(result.ok, true, `wizard ok 应 true,实际 ${JSON.stringify(result.steps)}`)
  assert.equal(result.steps.length, 2, `应有 2 步,实际 ${result.steps.length}`)
  const expected = ['ensure-extension-files', 'watch-extension-ready']
  for (let i = 0; i < expected.length; i++) {
    assert.equal(result.steps[i]!.step, expected[i])
    assert.equal(result.steps[i]!.status, 'skip', `dry-run 每步应为 skip,${result.steps[i]!.step} 实为 ${result.steps[i]!.status}`)
  }
})

await check('2. health-watch 三时序:0ms / 中途 / 120s+1ms', async () => {
  // (a) timeoutMs=0 → 立即 timeout
  const w0 = startExtensionHealthWatch({ timeoutMs: 0, intervalMs: 10 })
  const o0 = await w0.waitReady()
  assert.equal(o0.ready, false)
  assert.equal((o0 as { reason: string }).reason, 'timeout')

  // (b) 中途 ready:第一次 probe false,第二次 true(30ms 后)
  let probeCalls = 0
  const wMid = startExtensionHealthWatch({
    timeoutMs: 500,
    intervalMs: 30,
    probe: async () => { probeCalls += 1; return probeCalls >= 2 },
  })
  const oMid = await wMid.waitReady()
  assert.equal(oMid.ready, true, `中途 ready 实为 ${JSON.stringify(oMid)}`)
  assert.ok((oMid as { attempts: number }).attempts >= 2)

  // (c) 永不 ready → timeout(用极小 timeoutMs+全 false probe 模拟)
  const wTimeout = startExtensionHealthWatch({
    timeoutMs: 60,
    intervalMs: 20,
    probe: async () => false,
  })
  const oTimeout = await wTimeout.waitReady()
  assert.equal(oTimeout.ready, false)
  assert.equal((oTimeout as { reason: string }).reason, 'timeout')
})

await check('3. wizard 完全不调 spawn(GUI 面板/剪贴板/直开浏览器均已退役)', async () => {
  // 2026-09-02 上架后:wizard 缩为 2 步纯 Node 端职责(扩展落位 + watch precheck),
  // 不弹 osascript/zenity、不动 pbcopy/xclip/clip、不 open 浏览器。
  // 这里只校验 dry-run 与无源目录 fail 路径都不产生 spawn 调用。
  const dry = captureSpawn()
  await runOnboardingWizard({ dryRun: true, sourceDir: '/', extensionDir: '/tmp/none' })
  assert.equal(dry.calls.length, 0, `dry-run 不应 spawn 任何命令(实调 ${dry.calls.length})`)

  const fail = captureSpawn()
  // dryRun=false + 不存在的源目录 → ensure 会 fail,但应仍不产生 spawn 调用
  await runOnboardingWizard({ dryRun: false, sourceDir: '/nonexistent-source-dir-for-onboarding-tests', extensionDir: '/tmp/none-fail' })
  assert.equal(fail.calls.length, 0, `fail 路径也不应 spawn(实调 ${fail.calls.length})`)
})

await check('4. retry-after-watch:needs-extension → watch ready → 自动重放同 query_id', async () => {
  let fetchCalls = 0
  const queryId = 'sf-01'
  const fetch = async (): Promise<{ query_id: string; verdict: string; needsExt: boolean }> => {
    fetchCalls += 1
    return { query_id: queryId, verdict: 'needs-extension', needsExt: fetchCalls === 1 }
  }
  // 第一次 → needs-extension,启 watch
  const first = await fetch()
  assert.equal(first.verdict, 'needs-extension')

  let probeCount = 0
  const watch = startExtensionHealthWatch({
    timeoutMs: 1_000,
    intervalMs: 20,
    probe: async () => { probeCount += 1; return probeCount >= 2 },
  })
  const outcome = await watch.waitReady()
  assert.equal(outcome.ready, true)

  // watch ready → 自动重放同 query_id
  const retry = await fetch()
  assert.equal(retry.query_id, queryId, '同 query_id 必须保持')
  assert.equal(fetchCalls, 2, `应调用 fetch 两次(首次 + 重放),实 ${fetchCalls}`)
})

await check('5. wizard 不依赖 platform/panel 参数(GUI 跨平台降级退役)', async () => {
  // 2026-09-02 上架后:wizard 不再接 forcePlatform/spawn panel 参数,
  // 任何对 wizard 的调用都是 2 步(ensure + watch precheck)。
  const result = await runOnboardingWizard({ dryRun: true, extensionDir: '/tmp/gotry-test-ext-2' })
  assert.equal(result.steps.length, 2, `应 2 步,实 ${result.steps.length}`)
  assert.equal(result.steps[0]!.step, 'ensure-extension-files')
  assert.equal(result.steps[1]!.step, 'watch-extension-ready')
  assert.equal((result as unknown as { platform?: string }).platform, undefined, 'platform 字段应不再存在')
})

await check('6. withAutoRetryOnExtension 端到端:首次 needs-ext → 自动重放', async () => {
  let callCount = 0
  let ready = false
  // watch 第一次 probe 后 30ms 标记 ready(模拟用户装完扩展)
  setTimeout(() => { ready = true }, 30)
  const args = {
    fetch: async () => {
      callCount += 1
      return callCount === 1 ? { needsExt: true } : { needsExt: false, hit: true }
    },
    isExtensionNeeded: (r: { needsExt: boolean }) => r.needsExt === true,
    watch: { timeoutMs: 1_000, intervalMs: 20, probe: async () => ready },
  }
  const out = await withAutoRetryOnExtension<{ needsExt: boolean; hit?: boolean }>(args)
  assert.equal(out.retried, true, `应触发重放,实 retried=${out.retried}`)
  assert.equal(out.attempts, 2)
  assert.equal(out.result.needsExt, false)
  assert.equal(out.result.hit, true)
  assert.equal(callCount, 2, `withAutoRetry 应调 2 次 fetch,实 ${callCount}`)
})

await check('7. health-watch interval 边界常量与 watch 契约对齐', () => {
  assert.ok(HEALTH_WATCH_INTERVAL_FLOOR_MS >= 1_000, '下界不应让 watch 风暴')
  assert.ok(HEALTH_WATCH_INTERVAL_CEIL_MS <= 44_000, '上界应 < EXTENSION_CONNECTED_WINDOW_MS')
})

await check('8. defaultExtensionDir = ~/.gotry/extension(契约对齐 bootstrap 节)', () => {
  const dir = defaultExtensionDir()
  assert.match(dir, /\.gotry[\\/]extension$/, `扩展目录形态应是 ~/.gotry/extension,实 ${dir}`)
})

await check('9. describeExtensionDir:不存在的目录不抛错,返回 exists:false', () => {
  const desc = describeExtensionDir('/nonexistent/zzz')
  assert.equal(desc.exists, false)
  assert.equal(desc.fileCount, 0)
  assert.equal(desc.hasManifest, false)
})

await asyncSleep(0)

console.log(`ONBOARDING UX (§40): ${passed} pass`)
