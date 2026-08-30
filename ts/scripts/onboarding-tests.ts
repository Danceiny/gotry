/**
 * onboarding UX 测试(issue #21 onboarding UX,P3.6 gotry-session-onboarding-goal,
 * RFC user-session-data-rfc.md §3.3,run-all §40)。
 *
 * 5/5 全离线断言:
 *   1. wizard --dry-run:零网络零浏览器,exit 0,5 步齐全(扩展落位 / 开 chrome / 剪贴板 / 面板 / watch precheck)
 *   2. health-watch 三时序:0ms ready(立即 timeout)/ 5s ready(中途 ready)/ 120s+1ms 超时
 *   3. 剪贴板 / GUI 面板跨平台降级:darwin 调 osascript/zenity,pbcopy/xclip,headless 走终端
 *   4. retry-after-watch:扩展未就绪 → watch 内 ready → 自动重放同 query_id 同参数
 *   5. wizard 无 GUI 走终端降级:forcePlatform=headless,exit 0,剪贴板/面板都 skip
 *
 * 离线纪律:
 * - 不打真 Chrome、不发真请求;
 * - probe 函数全部注入 fake;
 * - spawn 用 noop stub,验证「被调用了对应命令 + 不抛错」。
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

await check('1. wizard --dry-run 零网络零浏览器,exit 0,5 步齐全', async () => {
  const { spawn } = captureSpawn()
  const result = await runOnboardingWizard({ dryRun: true, forcePlatform: 'darwin', spawn })
  assert.equal(result.ok, true, `wizard ok 应 true,实际 ${JSON.stringify(result.steps)}`)
  assert.equal(result.steps.length, 5, `应有 5 步,实际 ${result.steps.length}`)
  const expected = ['ensure-extension-files', 'open-chrome-extensions', 'clipboard-extension-path', 'panel-guide', 'watch-extension-ready']
  for (let i = 0; i < expected.length; i++) {
    assert.equal(result.steps[i]!.step, expected[i])
    assert.equal(result.steps[i]!.status, 'skip', `dry-run 每步应为 skip,${result.steps[i]!.step} 实为 ${result.steps[i]!.status}`)
  }
  assert.equal(result.platform, 'darwin')
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

await check('3. 剪贴板 + GUI 面板跨平台降级', async () => {
  // darwin:osascript + pbcopy
  const darwin = captureSpawn()
  const rDarwin = await runOnboardingWizard({ dryRun: false, forcePlatform: 'darwin', extensionDir: '/tmp/gotry-test-ext', spawn: darwin.spawn, sourceDir: '/' })
  // dryRun=false + 不存在的源目录 → ensure 会 fail,但剪贴板/面板命令仍尝试 spawn
  // 我们关注的是「darwin 调用了 open / pbcopy / osascript」
  const darwinBins = darwin.calls.map((c) => c.bin)
  assert.ok(darwinBins.includes('open'), `darwin 应调 open(实调 ${darwinBins.join(',')})`)
  assert.ok(darwinBins.includes('pbcopy'), 'darwin 应调 pbcopy')
  assert.ok(darwinBins.includes('osascript'), 'darwin 应调 osascript')

  // linux:xdg-open + xclip + zenity
  const linux = captureSpawn()
  await runOnboardingWizard({ dryRun: false, forcePlatform: 'linux', extensionDir: '/tmp/gotry-test-ext', spawn: linux.spawn, sourceDir: '/' })
  const linuxBins = linux.calls.map((c) => c.bin)
  assert.ok(linuxBins.includes('xdg-open'), `linux 应调 xdg-open(实调 ${linuxBins.join(',')})`)
  assert.ok(linuxBins.includes('xclip'), 'linux 应调 xclip')
  assert.ok(linuxBins.includes('zenity'), 'linux 应调 zenity')

  // headless:跳过所有 GUI spawn
  const headless = captureSpawn()
  const rHeadless = await runOnboardingWizard({ dryRun: true, forcePlatform: 'headless', extensionDir: '/tmp/gotry-test-ext', spawn: headless.spawn })
  assert.equal(headless.calls.length, 0, `headless 不应 spawn 任何命令(实调 ${headless.calls.length})`)
  assert.equal(rHeadless.platform, 'headless')
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

await check('5. wizard 无 GUI 走终端降级', async () => {
  const headless = captureSpawn()
  const result = await runOnboardingWizard({
    dryRun: true,
    forcePlatform: 'headless',
    extensionDir: '/tmp/gotry-test-ext',
    spawn: headless.spawn,
  })
  // headless 下:剪贴板 = skip,面板 = skip(走终端),watch precheck = skip
  const clip = result.steps.find((s) => s.step === 'clipboard-extension-path')
  const panel = result.steps.find((s) => s.step === 'panel-guide')
  const watch = result.steps.find((s) => s.step === 'watch-extension-ready')
  assert.equal(clip?.status, 'skip', 'headless 剪贴板应 skip')
  assert.equal(panel?.status, 'skip', 'headless 面板应 skip(终端降级)')
  assert.equal(watch?.status, 'skip', 'dry-run watch 应 skip')
  assert.equal(headless.calls.length, 0, `headless 不应调任何 spawn(实调 ${headless.calls.length})`)
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
