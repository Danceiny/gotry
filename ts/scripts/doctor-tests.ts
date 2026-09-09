/**
 * doctor 能力层测试(离线,注入 repoRoot/homeDir/env,零安装零网络写路径):
 *  1. 空 tmp 环境 → agent-reach=missing / 扩展=missing / flyai=degraded(无 key)/ LLM key 恒 ok 且不进 broken
 *  2. 补齐假 .venv 双文件 → agent-reach=ok;只补 python → degraded(半可用态被显式区分)
 *  3. FLYAI_API_KEY 注入 → flyai=ok
 *  4. nodeOk 边界(22.14/22.15/23.0)
 *  5. renderDoctorReportMd:命令类 fix 加反引号、prose 类不加;报告含全部条目
 *  6. MCP 工具面:gotry_doctor 注册可执行,isolated stateRoot 落 doctor-report.md
 *
 *  issue #284 自助修复(repair action,7 段):
 *  7.  read-only call 不安装:action 缺省/=diagnose 时零调用 installer,verdict 保持旧口形
 *  8.  允许修复 → 只跑 auto-repairable → 复检决定 installed/failed
 *  9.  安装器报 ok 但复检仍坏 → failed + nextAction = doctor --fix
 *  10. 同 agent + 同 scope 复用审批;不同 scope 重问
 *  11. rejected/cancelled + unavailable 通道:零执行 + 结构化 verdict='approval-denied'
 *  12. user-action 项绝不安装;scope 过滤只考虑 items 范围内 id
 *  13. tool-level gotry_doctor 注册 + observable chain(diagnose → repair)
 *
 * 运行: cd ts && npx tsx scripts/doctor-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runDoctorChecks, renderDoctorReportMd, nodeOk, scopeKeyFor, createRepairApprovalGate, runDoctorRepair, type DoctorItem, type DoctorReport, type DoctorRepairOptions, type DoctorRepairApproval } from '../capabilities/doctor.ts'
import { apply } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

const tmp = await mkdtemp(join(tmpdir(), 'gotry-doctor-test-'))
const emptyRepo = join(tmp, 'repo-empty')
const emptyHome = join(tmp, 'home-empty')
await mkdir(emptyRepo, { recursive: true })
await mkdir(emptyHome, { recursive: true })

// 1. 空 tmp 环境:全部缺省态;LLM key 让渡面不进 broken 计数
const r1 = await runDoctorChecks({ repoRoot: emptyRepo, homeDir: emptyHome, env: {} })
const byId = (id: string) => r1.items.find(i => i.id === id)
assert.ok(byId('agent-reach'), 'agent-reach 项存在')
assert.equal(byId('agent-reach')!.status, 'missing', `空仓 agent-reach=missing,实际 ${byId('agent-reach')!.status}`)
assert.match(byId('agent-reach')!.fix ?? '', /npx @danceiny\/gotry doctor --fix/, 'missing 项带精确补装指引')
assert.equal(byId('extension')!.status, 'missing', '空 home 扩展=missing')
assert.equal(byId('flyai')!.status, 'degraded', '无 key flyai=degraded(有共享试用,非缺失)')
assert.equal(byId('llm-key')!.status, 'ok', 'LLM key 恒 ok(让渡面)')
assert.equal(r1.ok, false, '有 missing 项时报告 ok=false')
assert.match(r1.summary, /待处理/, 'summary 指明待处理项')
console.log('1. 空 tmp 环境 → missing/degraded 分级正确,LLM key 让渡 OK')

// 2. 假 .venv:双文件齐 → ok;只 python → degraded
const repoPartial = join(tmp, 'repo-partial')
await mkdir(join(repoPartial, '.venv/bin'), { recursive: true })
await writeFile(join(repoPartial, '.venv/bin/python'), '#!/bin/sh\n', { mode: 0o755 })
const r2a = await runDoctorChecks({ repoRoot: repoPartial, homeDir: emptyHome, env: {} })
assert.equal(r2a.items.find(i => i.id === 'agent-reach')!.status, 'degraded', '只 python → degraded(半可用显式区分)')
const repoFull = join(tmp, 'repo-full')
await mkdir(join(repoFull, '.venv/bin'), { recursive: true })
await writeFile(join(repoFull, '.venv/bin/python'), '#!/bin/sh\n', { mode: 0o755 })
await writeFile(join(repoFull, '.venv/bin/agent-reach'), '#!/bin/sh\n', { mode: 0o755 })
const r2b = await runDoctorChecks({ repoRoot: repoFull, homeDir: emptyHome, env: {} })
assert.equal(r2b.items.find(i => i.id === 'agent-reach')!.status, 'ok', 'python+agent-reach 齐 → ok')
console.log('2. .venv 三态(missing/degraded/ok)分级 OK')

// 3. FLYAI_API_KEY 注入 → ok
const r3 = await runDoctorChecks({ repoRoot: emptyRepo, homeDir: emptyHome, env: { FLYAI_API_KEY: 'test-key' } })
assert.equal(r3.items.find(i => i.id === 'flyai')!.status, 'ok', '有正式 key → flyai=ok')
console.log('3. FLYAI_API_KEY 注入 → flyai ok OK')

// 4. nodeOk 边界
assert.equal(nodeOk('22.14.0'), false, '22.14 不足')
assert.equal(nodeOk('22.15.0'), true, '22.15 达标')
assert.equal(nodeOk('23.0.0'), true, '23.x 达标')
console.log('4. nodeOk 边界 OK')

// 5. 报告渲染:命令类反引号、prose 类原样
const md = renderDoctorReportMd(r1)
assert.match(md, /# GoTry 依赖体检报告/, '报告标题')
assert.match(md, /`npx @danceiny\/gotry doctor --fix`/, '命令类 fix 加反引号')
assert.match(md, /flyai\.open\.fliggy\.com 控制台申请正式 key/, 'prose 类 fix 原样呈现')
assert.ok(!md.includes('`到 flyai'), 'prose 类 fix 不应整体包反引号')
assert.match(md, /LLM key/, '让渡面(LLM key)照常入表')
console.log('5. 报告渲染 OK')

// 5b. npm/npx 提升布局(2026-09-08 安装链修复):gotry 的依赖落在包目录外的同级提升位,
//     existsSync 硬编码候选在该布局全 miss——map/ask-user 必须经 createRequire 解析链
//     命中(此前把真实就位的 ask-user 误报 missing、map-tools 误报随包缺席)。
{
  const hoist = await mkdtemp(join(tmpdir(), 'gotry-doctor-hoist-'))
  const pkgRoot = join(hoist, 'node_modules', '@danceiny', 'gotry')
  await mkdir(pkgRoot, { recursive: true })
  await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@danceiny/gotry', version: '0.0.1-test' }), 'utf-8')
  // 提升位依赖(与真实 npx 缓存同形):裸名 map-tools + dsh 本体 + ask-user
  const stubPkg = async (dir: string, main: string) => {
    await mkdir(join(hoist, 'node_modules', dir, 'lib'), { recursive: true })
    await writeFile(join(hoist, 'node_modules', dir, 'package.json'), JSON.stringify({ name: dir, version: '0.0.0-test', main }), 'utf-8')
    await writeFile(join(hoist, 'node_modules', dir, main), '// stub\n', 'utf-8')
  }
  await stubPkg('dsh-map-tools', 'lib/index.js')
  await stubPkg('@deepseek-ai/dsh', 'lib/bin.js')
  await stubPkg('@deepseek-ai/dsh-tool-ask-user', 'lib/index.js')
  const rb = await runDoctorChecks({ repoRoot: pkgRoot, homeDir: join(hoist, 'home-empty'), env: {} })
  assert.equal(rb.items.find(i => i.id === 'map-tools')!.status, 'ok', '提升布局 map-tools 经包根解析链命中')
  assert.equal(rb.items.find(i => i.id === 'ask-user')!.status, 'ok', '提升布局 ask-user 经 dsh 上下文解析链命中(误报修复)')
  await rm(hoist, { recursive: true, force: true })
}
console.log('5b. npm 提升布局解析链(map-tools/ask-user 误报修复)OK')

// 5c. 随包 vendor 布局:tarball 里 ts/dsh-runtime/vendor/dsh-map-tools 直接命中
//     (npm 依赖形态因 peerDependencies ERESOLVE 不可用,vendor 是 npm 布局的分发面)
{
  const vend = await mkdtemp(join(tmpdir(), 'gotry-doctor-vendor-'))
  const vendorEntry = join(vend, 'ts/dsh-runtime/vendor/dsh-map-tools/lib/index.js')
  await mkdir(dirname(vendorEntry), { recursive: true })
  await writeFile(vendorEntry, '// stub\n', 'utf-8')
  const rc = await runDoctorChecks({ repoRoot: vend, homeDir: join(vend, 'home-empty'), env: {} })
  assert.equal(rc.items.find(i => i.id === 'map-tools')!.status, 'ok', 'vendor 副本命中(map-tools 随 tarball 分发)')
  await rm(vend, { recursive: true, force: true })
}
console.log('5c. 随包 vendor 布局(map-tools tarball 分发面)OK')

// 6. MCP 工具面:gotry_doctor 注册 + isolated stateRoot 报告落盘
const smokeRoot = await mkdtemp(join(tmpdir(), 'gotry-doctor-state-'))
const registered: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = []
const ctx = {
  tools: { register: (t: unknown) => registered.push(t as never) },
  systemPrompt: { variable: () => {} },
  on: () => () => {},
} as unknown as Context
apply(ctx, { stateRoot: smokeRoot, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'ask' } as never)
const doctorTool = registered.find(t => t.name === 'gotry_doctor')
assert.ok(doctorTool, 'gotry_doctor 已注册')
const out = await doctorTool!.execute({ query: {} }, null) as { ok?: boolean; verdict?: string; items?: unknown[]; report_path?: string; summary?: string }
assert.equal(out.ok, true, '体检工具 ok=true(体检本身成功,与依赖是否缺失无关)')
assert.equal(out.verdict, 'needs-attention', '注入环境外仍能出 verdict(本机真实状态,不判 all-clear)')
assert.ok(Array.isArray(out.items) && out.items.length >= 6, 'items 齐全')
assert.ok(out.report_path && out.report_path.includes(smokeRoot), `报告落在 isolated stateRoot: ${out.report_path}`)
const reportMd = await readFile(out.report_path!, 'utf-8')
assert.match(reportMd, /# GoTry 依赖体检报告/, '落盘报告可预览')
await rm(tmp, { recursive: true, force: true })
await rm(smokeRoot, { recursive: true, force: true })
console.log('6. gotry_doctor 工具面 + 报告落盘 OK')

// ---------------------------------------------------------------------------
// issue #284 自助修复测试(7 段),全部注入 fake installer / recheck / approval,
// 不跑真安装面、不动 ~/.gotry、不写 shared state。
// ---------------------------------------------------------------------------

// 合成 doctor items(与 bootstrap-tests §12 onboardingItems 同形态,稳定 id 锚点)。
const repairItems: DoctorItem[] = [
  { id: 'node', label: 'Node 运行时', status: 'ok', detail: 'Node 22.x' },
  { id: 'extension', label: 'GoTry Session Bridge 扩展', status: 'missing', detail: '未安装', fix: 'https://chromewebstore...' },
  { id: 'agent-reach', label: 'Agent Reach(网页/社媒读取)', status: 'missing', detail: '未装配', fix: 'npx @danceiny/gotry doctor --fix' },
  { id: 'hbcli', label: 'hbcli(酒店实时源)', status: 'missing', detail: '未安装', fix: 'npx @danceiny/gotry doctor --fix' },
  { id: 'flyai', label: 'FlyAI(飞猪官方检索)', status: 'degraded', detail: '未配 FLYAI_API_KEY', fix: '到 flyai 控制台申请 key' },
  { id: 'sidebar', label: 'dsh-better-sidebar(侧栏工作台)', status: 'missing', detail: '未安装', fix: 'npx @danceiny/gotry doctor --fix' },
  { id: 'calendar', label: 'dsh-calendar(日历工作窗口)', status: 'degraded', detail: '已挂载未配置', fix: 'cordis.patch.yml 覆盖 config' },
  { id: 'map-tools', label: 'dsh-map-tools(地图/路线/POI)', status: 'missing', detail: '未随包解析', fix: '重装 @danceiny/gotry' },
  { id: 'ask-user', label: 'dsh-tool-ask-user(结构化澄清卡)', status: 'missing', detail: '未解析', fix: '重装 @danceiny/gotry' },
  { id: 'llm-key', label: 'LLM key', status: 'ok', detail: '由 dsh 宿主管' },
]


// fakeRecheck helper: convert DoctorItem[] → BootstrapItem[] (level: 优先取合并字段,否则 status)
const toBootstrapItems = (items: DoctorItem[]) => items.map((i: any) => ({ label: i.label, level: i.level ?? i.status, detail: i.detail, fix: i.fix } as any))

// 假分类器桥(用于 §12 内的边界测试,生产路径用真 bootstrap.classifyDoctorGap 在 §7/§8 断言)。
function fakeBridge(env: NodeJS.ProcessEnv = {}): NonNullable<DoctorRepairOptions['bridge']> {
  return {
    classifyDoctorGap: (i: any, opts?: any) => {
      const e = opts?.env ?? env
      if (!i || i.level === 'ok') return 'ok'
      const label: string = i.label ?? ''
      if (label.startsWith('Agent Reach')) return e.GOTRY_SETUP_REACH === '0' ? 'unavailable' : 'auto'
      if (label.startsWith('hbcli')) return i.level === 'degraded' ? 'user-action' : (e.GOTRY_SETUP_HBCLI === '0' ? 'unavailable' : 'auto')
      if (label.startsWith('dsh-better-sidebar')) return e.GOTRY_SETUP_SIDEBAR === '0' ? 'unavailable' : 'auto'
      if (label.startsWith('GoTry Session Bridge')) return 'user-action'
      if (label.startsWith('FlyAI')) return 'user-action'
      if (label.startsWith('dsh-calendar')) return 'user-action'
      if (label.startsWith('dsh-map-tools')) return 'unavailable'
      if (label.startsWith('dsh-tool-ask-user')) return 'unavailable'
      if (label.startsWith('Node')) return 'unavailable'
      return 'unavailable'
    },
    buildOnboardingPlan: (items: any[], _opts?: any) => {
      const auto: any[] = []; const userAction: any[] = []; const unavailable: any[] = []
      for (const i of items ?? []) {
        const b = (fakeBridge(env).classifyDoctorGap as any)(i, { env })
        if (b === 'ok') continue
        if (b === 'auto') auto.push(i)
        else if (b === 'user-action') userAction.push(i)
        else unavailable.push(i)
      }
      return { promptable: auto.length > 0, auto, userAction, unavailable }
    },
  }
}

// 7. scopeKeyFor 纯函数 + runDoctorRepair 走真 bootstrap.classifyDoctorGap/buildOnboardingPlan
//    (regression for #284 blocker #2:直传 DoctorItem 会让 classifyDoctorGap 因 !item.level
//    把所有项分到 ok,plan 永远空。runDoctorRepair 内部调 toBootstrapItem 修复此点。)
{
  assert.equal(scopeKeyFor([]), '', '空 scope = 空 key')
  assert.equal(scopeKeyFor(['a']), 'a', '单元素 scope')
  assert.equal(scopeKeyFor(['b', 'a', 'a']), 'a,b', 'scope 排序去重(批准缓存命中)')

  const fakeInstallers = {
    hbcli: async () => ({ ok: true }),
    reach: async () => ({ ok: true }),
    sidebar: async () => ({ ok: true }),
  }
  const fakeRecheck = async () => toBootstrapItems(repairItems.map((i) => ({ ...i, level: i.id === 'agent-reach' || i.id === 'hbcli' || i.id === 'sidebar' ? 'ok' : i.status })))
  const fakeReport: DoctorReport = { ok: false, items: repairItems, summary: '合成' }
  const fakeAgent = { id: 'test-agent-7' }
  const gate = createRepairApprovalGate({
    approval: () => ({ request: async () => 'allowed-once' as const }),
  })
  const r = await runDoctorRepair(fakeReport, (k, _reason) => gate.request(fakeAgent, k, _reason), {
    bridge: fakeBridge(), installers: fakeInstallers, recheck: fakeRecheck,
  })
  // selected: 3 项 auto(agent-reach / hbcli / sidebar)—**这是 status→level 适配生效的证据**
  assert.equal(r.repairs.length, 3, '3 项 auto selected(真 buildOnboardingPlan 正确分桶)')
  assert.deepEqual(r.repairs.map((x) => x.id).sort(), ['agent-reach', 'hbcli', 'sidebar'])
  assert.ok(r.repairs.every((x) => x.status === 'installed'), 'recheck 全 ok → 全 installed')
  assert.equal(r.skipped.length, 5, 'skipped = 3 user-action + 2 unavailable')
  assert.equal(r.verdict, 'repaired')
}
console.log('7. scopeKeyFor + status→level 适配(plan 真实非空)OK')

// 8. **生产路径 regression**(#284 blocker #1):不传 bridge.runOnboardingFix 时,runDoctorRepair
//    走 bootstrap.runOnboardingFix 真导出。**直接 invoke 真 runOnboardingFix** 注入 fake installers/recheck
//    证明"production 路径真的会调到 bootstrap.runOnboardingFix"+"实际 installers 被触发 + recheck 决定结果"。
//    旧的 fake-classifier-only 测试无法发现"production 路径根本没接 installers"这种 bug。
{
  const url = new URL('../../bin/gotry-bootstrap.js', import.meta.url)
  const realMod = await import(url.href) as {
    runOnboardingFix: NonNullable<DoctorRepairOptions['runOnboardingFix']>
    buildOnboardingPlan: NonNullable<DoctorRepairOptions['bridge']>['buildOnboardingPlan']
    classifyDoctorGap: NonNullable<DoctorRepairOptions['bridge']>['classifyDoctorGap']
  }

  const installerCalls: string[] = []
  const bridgeInstallers = {
    hbcli: async () => { installerCalls.push('hbcli'); return { ok: true } },
    reach: async () => { installerCalls.push('reach'); return { ok: true } },
    sidebar: async () => { installerCalls.push('sidebar'); return { ok: true } },
  }
  const fakeRecheck = async () => toBootstrapItems(repairItems.map((i) => ({ ...i, level: i.id === 'agent-reach' || i.id === 'hbcli' || i.id === 'sidebar' ? 'ok' : i.status })))

  const fakeReport: DoctorReport = { ok: false, items: repairItems, summary: '合成' }
  const fakeAgent = { id: 'test-agent-8' }
  const gate = createRepairApprovalGate({
    approval: () => ({ request: async () => 'allowed-once' as const }),
  })

  const r = await runDoctorRepair(fakeReport, (k, _reason) => gate.request(fakeAgent, k, _reason), {
    runOnboardingFix: realMod.runOnboardingFix,
    installers: bridgeInstallers,
    recheck: fakeRecheck,
    bridge: { classifyDoctorGap: realMod.classifyDoctorGap, buildOnboardingPlan: realMod.buildOnboardingPlan },
  })

  assert.deepEqual(installerCalls.slice().sort(), ['hbcli', 'reach', 'sidebar'],
    '**production 路径真调到 bootstrap.runOnboardingFix**(三个 auto installer 各被触发一次)')
  assert.equal(r.verdict, 'repaired')
  assert.equal(r.approval, 'granted')
  assert.ok(r.repairs.every((x) => x.status === 'installed'), '3 项全 installed')
}
console.log('8. production 路径(bootstrap.runOnboardingFix 真导出 + 注入 installers/recheck → 真实触发 + recheck 决定结果)OK')

// 9. installer 报 ok 但 recheck 仍坏 → failed + nextAction = doctor --fix(verdict 不冒充 repaired)
{
  const url = new URL('../../bin/gotry-bootstrap.js', import.meta.url)
  const realMod = await import(url.href) as any
  const bridgeInstallers = {
    hbcli: async () => ({ ok: true }),
    reach: async () => ({ ok: true }),
    sidebar: async () => ({ ok: true }),
  }
  const fakeRecheck = async () => toBootstrapItems(repairItems.map((i) => ({ ...i, level: i.id === 'hbcli' ? i.status : 'ok' })))
  const fakeReport: DoctorReport = { ok: false, items: repairItems, summary: '合成' }
  const fakeAgent = { id: 'test-agent-9' }
  const gate = createRepairApprovalGate({
    approval: () => ({ request: async () => 'allowed-once' as const }),
  })
  const r = await runDoctorRepair(fakeReport, (k, _r2) => gate.request(fakeAgent, k, _r2), {
    runOnboardingFix: realMod.runOnboardingFix,
    installers: bridgeInstallers, recheck: fakeRecheck,
    bridge: { classifyDoctorGap: realMod.classifyDoctorGap, buildOnboardingPlan: realMod.buildOnboardingPlan },
  })
  assert.equal(r.verdict, 'partial-repair', '一项失败 → partial-repair(诚实,不冒充 repaired)')
  const hbcli = r.repairs.find((x) => x.id === 'hbcli')!
  assert.equal(hbcli.status, 'failed')
  assert.match(hbcli.nextAction ?? '', /doctor --fix/, '失败给可执行重试命令')
  assert.equal(r.repairs.find((x) => x.id === 'agent-reach')!.status, 'installed')
}
console.log('9. installer 报 ok 但 recheck 仍坏 → failed + retry 命令,partial-repair 不冒充 OK')

// 10. 同 agent + 同 scope 复用;不同 scope 重问;rejected/cancelled 在缓存里分开
{
  const agent = { id: 'test-agent-10' }
  const scopeA = 'agent-reach,sidebar'
  const scopeB = 'hbcli,sidebar'
  let requestCount = 0
  const gate = createRepairApprovalGate({
    approval: () => ({ request: async () => { requestCount += 1; return 'allowed-once' as const } }),
  })
  await gate.request(agent, scopeA, 'A1')
  await gate.request(agent, scopeA, 'A2')
  assert.equal(requestCount, 1, '同 agent + 同 scope 复用(只 1 次请求)')
  await gate.request(agent, scopeB, 'B1')
  assert.equal(requestCount, 2, '不同 scope 重问(共 2 次请求)')

  // rejected/cancelled 在缓存里分开记(has 返回具体 outcome,不合并)
  const cancelGate = createRepairApprovalGate({
    approval: () => ({ request: async () => 'cancelled' as const }),
  })
  const agent2 = { id: 'agent-cancel' }
  const scopeC = 'hbcli'
  const r1 = await cancelGate.request(agent2, scopeC, 'r1')
  const r2 = await cancelGate.request(agent2, scopeC, 'r2')
  assert.equal(r1, 'cancelled', '首次 cancelled → cancelled')
  assert.equal(r2, 'cancelled', '同 scope 后续请求复用 cancelled,不合并成 rejected')
  const rejGate = createRepairApprovalGate({
    approval: () => ({ request: async () => 'rejected' as const }),
  })
  assert.equal(await rejGate.request(agent2, 'sidebar', 'r3'), 'rejected')
}
console.log('10. 同 agent + 同 scope 复用;不同 scope 重问;rejected/cancelled 分开记 OK')

// 11. rejected/cancelled + unavailable 通道:零执行 + verdict='approval-denied'
{
  const fakeReport: DoctorReport = { ok: false, items: repairItems, summary: '合成' }
  const fakeAgent = { id: 'test-agent-11' }
  for (const outcome of ['rejected', 'cancelled'] as const) {
    const gate = createRepairApprovalGate({
      approval: () => ({ request: async () => outcome }),
    })
    const r = await runDoctorRepair(fakeReport, (k, _r2) => gate.request(fakeAgent, k, _r2), {
      bridge: fakeBridge(),
      installers: { hbcli: async () => { throw new Error('should not run') }, reach: async () => { throw new Error('should not run') }, sidebar: async () => { throw new Error('should not run') } },
      recheck: async () => toBootstrapItems(repairItems as any),
    })
    assert.equal(r.verdict, 'approval-denied', `${outcome} → approval-denied`)
    assert.equal(r.ok, false)
    assert.equal(r.approval, outcome)
    assert.equal(r.repairs.length, 0, `${outcome} → 零执行(零 repairs)`)
    assert.deepEqual(r.selected.map((i) => i.id), ['agent-reach', 'hbcli', 'sidebar'], `${outcome} 时仍保留待批准计划`)
    assert.equal(r.scopeKey, 'agent-reach,hbcli,sidebar', `${outcome} 时仍保留审计 scope`)
    assert.ok(r.summary.includes('拒绝') || r.summary.includes('吊销'), 'summary 含拒绝/吊销原因')
  }
  // unavailable:approval seam 缺席
  {
    const gate = createRepairApprovalGate({ approval: () => undefined })
    const r = await runDoctorRepair(fakeReport, (k, _r2) => gate.request(fakeAgent, k, _r2), {
      bridge: fakeBridge(),
      installers: { hbcli: async () => ({ ok: true }), reach: async () => ({ ok: true }), sidebar: async () => ({ ok: true }) },
      recheck: async () => toBootstrapItems(repairItems as any),
    })
    assert.equal(r.verdict, 'approval-denied')
    assert.equal(r.approval, 'unavailable', 'approval seam 缺席 → unavailable')
    assert.equal(r.repairs.length, 0, 'unavailable → 零执行')
    assert.equal(r.selected.length, 3, 'unavailable 时仍返回选定计划')
    assert.equal(r.scopeKey, 'agent-reach,hbcli,sidebar', 'unavailable 时仍返回 scope')
    assert.ok(r.summary.includes('无可用审批通道'), 'summary 显式说明通道缺席')
  }
}
console.log('11. rejected/cancelled + unavailable 通道 → 零执行 + verdict=approval-denied OK')

// 12. user-action / unavailable 项绝不安装(scope 过滤);全健康早退;未知 id 静默剔除
{
  const fakeReport: DoctorReport = { ok: false, items: repairItems, summary: '合成' }
  const calls: string[] = []
  const fakeInstallers = {
    hbcli: async () => { calls.push('hbcli'); return { ok: true } },
    reach: async () => { calls.push('reach'); return { ok: true } },
    sidebar: async () => { calls.push('sidebar'); return { ok: true } },
  }
  const recheckItems = repairItems.map((i) =>
    i.id === 'agent-reach' || i.id === 'hbcli' || i.id === 'sidebar' ? { ...i, level: 'ok' as const } : i)
  const fakeAgent = { id: 'test-agent-12' }
  const gate = createRepairApprovalGate({
    approval: () => ({ request: async () => 'allowed-once' as const }),
  })
  // scope 限制:agent-reach(可装)+ flyai/calendar(用户操作)
  const scopedReport: DoctorReport = {
    ...fakeReport,
    items: repairItems.filter((i) => i.id === 'agent-reach' || i.id === 'flyai' || i.id === 'calendar'),
  }
  const r = await runDoctorRepair(scopedReport, (k, _r2) => gate.request(fakeAgent, k, _r2), {
    bridge: fakeBridge(), installers: fakeInstallers, recheck: async () => recheckItems as any[],
  })
  assert.equal(r.repairs.length, 1, 'scope 限制后只 1 项 auto(agent-reach)')
  assert.equal(r.repairs[0].id, 'agent-reach')
  assert.deepEqual(calls, ['reach'], '只调一次 reach installer;user-action 项绝不装')
  assert.ok(r.skipped.some((s) => s.id === 'flyai'), 'flyai 进 skipped')
  assert.ok(r.skipped.some((s) => s.id === 'calendar'), 'calendar 进 skipped')

  // 全 healthy 报告 → plan 空 → verdict='no-repair-needed'(零审批请求,零安装)
  {
    const allOk = repairItems.map((i) => ({ ...i, status: 'ok' as const }))
    const r2 = await runDoctorRepair({ ok: true, items: allOk, summary: 'all ok' }, (k, _r3) => gate.request(fakeAgent, k, _r3), {
      bridge: fakeBridge(), installers: fakeInstallers, recheck: async () => allOk as any[],
    })
    assert.equal(r2.verdict, 'no-repair-needed')
    assert.equal(r2.approval, 'not-needed')
    assert.equal(r2.ok, true, '全健康所选范围无需修复且结果成功')
    assert.deepEqual(calls, ['reach'], 'all-ok 早退,installer 零额外调用')
  }
  // 未知 id → 静默剔除
  {
    const weirdReport: DoctorReport = {
      ...fakeReport,
      items: [...repairItems, { id: 'bogus-id' as unknown as DoctorItem['id'], label: 'Bogus', status: 'missing', detail: '?' }],
    }
    const r3 = await runDoctorRepair(weirdReport, (k, _r4) => gate.request(fakeAgent, k, _r4), {
      bridge: fakeBridge(), installers: fakeInstallers, recheck: async () => repairItems as any[],
    })
    assert.equal(r3.repairs.length, 3, 'bogus-id 不进 selected')
    assert.ok(!r3.repairs.some((x) => x.id === ('bogus-id' as unknown as DoctorItem['id'])))
  }
}
console.log('12. user-action 项绝不装(scope 过滤 + 分类器守住 + 未知 id 静默剔除 + 全健康早退)OK')

// 13. tool-level gotry_doctor 注册 + observable chain(diagnose + repair 两条路径)
{
  const smokeRoot2 = await mkdtemp(join(tmpdir(), 'gotry-doctor-repair-'))
  const registered: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = []
  const ctx2 = {
    tools: { register: (t: unknown) => registered.push(t as never) },
    systemPrompt: { variable: () => {} },
    on: () => () => {},
  } as unknown as Context
  apply(ctx2, { stateRoot: smokeRoot2, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'ask' } as never)
  const doctorTool = registered.find((t) => t.name === 'gotry_doctor')
  assert.ok(doctorTool, 'gotry_doctor 已注册')

  // 13a. read-only 默认路径
  const r1 = await doctorTool!.execute({ query: {} }, null) as {
    action?: string; verdict?: string; ok?: boolean; repairs?: unknown[]; summary?: string
  }
  assert.equal(r1.action, 'diagnose')
  assert.ok(['all-clear', 'needs-attention'].includes(r1.verdict ?? ''))
  assert.equal(r1.repairs, undefined, 'diagnose 路径不返回 repairs')

  await rm(smokeRoot2, { recursive: true, force: true })

  // 13b. 完整工具路径:真实注册/审批闸/bootstrap.runOnboardingFix，安装器与 HOME
  // 复检仅用注入 fixture；安装器退出后由复检状态决定结果，报告写复检态。
  const repairRoot = await mkdtemp(join(tmpdir(), 'gotry-doctor-repair-e2e-'))
  let healthy = false
  let approvalRequests = 0
  let installerCalls = 0
  const repairLabel = 'Agent Reach(网页/社媒读取)'
  const check = async (): Promise<DoctorReport> => ({
    ok: healthy,
    items: [{
      id: 'agent-reach', label: repairLabel,
      status: healthy ? 'ok' : 'missing',
      detail: healthy ? 'fixture 复检已就位' : 'fixture 未装配',
      ...(healthy ? {} : { fix: 'npx @danceiny/gotry doctor --fix' }),
    }],
    summary: healthy ? 'fixture 复检通过。' : 'fixture 诊断发现 1 项待处理。',
  })
  const registeredRepair: typeof registered = []
  const repairCtx = {
    tools: { register: (t: unknown) => registeredRepair.push(t as never) },
    systemPrompt: { variable: () => {} },
    on: () => () => {},
    get: (name: string) => name === 'approval' ? {
      request: async () => { approvalRequests += 1; return 'allowed-once' as const },
    } : undefined,
  } as unknown as Context
  apply(
    repairCtx,
    { stateRoot: repairRoot, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'ask' } as never,
    {
      doctor: {
        check,
        repair: {
          installers: {
            reach: async () => { installerCalls += 1; healthy = true; return { ok: true } },
          },
        },
      },
    },
  )
  const repairTool = registeredRepair.find((t) => t.name === 'gotry_doctor')
  assert.ok(repairTool, 'gotry_doctor repair fixture 已注册')
  const fakeAgent = { id: 'tool-test-agent' }
  const r2 = await repairTool!.execute(
    { query: { action: 'repair', items: ['agent-reach'] } },
    { agent: fakeAgent, callId: 'doctor-repair-e2e' },
  ) as {
    action?: string; verdict?: string; ok?: boolean
    plan?: { selected?: unknown[]; needs_user_action?: unknown[]; unavailable?: unknown[]; scope_key?: string }
    approval?: DoctorRepairApproval
    repairs?: Array<{ id: string; status: string; nextAction?: string }>
    skipped?: Array<{ id: string; bucket: string }>
    summary?: string
    diagnosis?: unknown
    recheck?: DoctorReport
    report_path?: string
  }
  assert.equal(r2.action, 'repair')
  assert.equal(approvalRequests, 1, '真实工具执行只请求一次 scope 审批')
  assert.equal(installerCalls, 1, '真实工具执行进入既有 bootstrap repair bridge')
  assert.equal(r2.verdict, 'repaired')
  assert.equal(r2.repairs?.[0]?.status, 'installed')
  assert.equal(r2.recheck?.ok, true, '工具结果显式返回安装后的实际复检')
  assert.ok(r2.plan, 'plan 字段存在')
  assert.ok(typeof r2.plan?.scope_key === 'string', 'scope_key 字段存在')
  assert.ok(r2.diagnosis, 'observable chain: diagnosis 已落')
  assert.ok((r2.summary ?? '').includes('[repair]'), 'summary 含 [repair] 标记')
  assert.ok((r2.summary ?? '').includes('verdict='), 'summary 含 verdict 字段')
  assert.ok(Array.isArray(r2.plan?.selected), 'selected 数组存在')
  assert.ok(Array.isArray(r2.plan?.needs_user_action), 'needs_user_action 数组存在')
  assert.ok(Array.isArray(r2.plan?.unavailable), 'unavailable 数组存在')
  assert.ok(typeof r2.approval === 'string', 'approval 字段存在')
  assert.ok(Array.isArray(r2.repairs), 'repairs 数组存在')
  assert.ok(Array.isArray(r2.skipped), 'skipped 数组存在')
  assert.ok(r2.report_path?.startsWith(repairRoot), '复检报告落隔离 stateRoot')
  assert.match(await readFile(r2.report_path!, 'utf8'), /fixture 复检已就位/, '报告内容是复检态，不是修复前诊断')

  await rm(repairRoot, { recursive: true, force: true })
}
console.log('13. tool-level gotry_doctor 注册 + observable chain(diagnose→repair→recheck)OK')

console.log('doctor-tests: 全部通过')
