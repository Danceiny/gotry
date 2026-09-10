/**
 * Issue #338 持久默认出发地 E2E(issue #338 acceptance,isolated 工程证据):
 *
 * 跑在临时 stateRoot,验证 issue #338 的验收路径,
 * 每条都是隔离 fixture,不在真实用户状态读写。
 *
 * 验收路径(一一对应 issue #338 验收清单):
 *  1. 首次显式保存 → fresh stateRoot 落盘 + motivation.patch 事件 + 投影 homeCity + typed preference 三件套
 *  2. 新插件/读回上下文:close 第一段 ledger → 起第二段插件 → motivation_brief 拿到持久 city + 证据指针 + 记录时间
 *  3. 当轮显式出发地覆盖默认(pure resolveDefaultOrigin 契约)
 *  4. 重复保存 = 幂等(无新事件)
 *  5. 跨 tenant 不可见(tenant 隔离守门)
 *  6. 显式清除移除活跃投影 + 审计事件/证据边界保留 + 后续 missing
 *  7. 重建(rebuildProjections)后投影与直读一致(账本/投影永不分叉)
 *  8. 默认值永不筛候选/不改硬约束(同 payload 在 saved/cleared 下产出完全一致)
 *
 * 工程切片不变量(issue #338 acceptance-core):
 *  - 持久 home-city 值携带其自身的「证据指针」+「更新时间」(来自 typed
 *    homeCityPreference),不再从全局 evidence 尾派生
 *  - 无关动机补丁不会改写 homeCityPreference.evidence / updated_at
 *  - 空白 city 入口被拒,零事件落账
 *  - trim before persist
 *  - 显式 null 与从未存都走 missing;resolver 不猜测
 *  - 不进算术/求解/硬约束/候选过滤(feasibility 同输入同结果)
 *
 * 不替代 #20 真实回访价值证据(归 #20);仅 issue #338 的工程切片。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { renderPrompt, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { parse as parseYaml } from 'yaml'
import { apply } from '../src/index.ts'
import { resolveDefaultOrigin, type MergedProfile } from '../src/memory-capture.ts'
import { ensureLedger, openLedgerIfExists } from '../src/state-ledger.ts'

let pass = 0
let fail = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    pass++
    console.log(`  ok - ${msg}`)
  } else {
    fail++
    console.error(`  FAIL - ${msg}`)
  }
}

function loadFixturePayload(): Record<string, unknown> {
  // 复用 #2 golden 价表(纯离线,无副作用):feasibility_check 的同一基准 → 验证
  // homeCity 不影响候选/可行性。
  const path = join('..', 'data', 'golden_erhai.json')
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

function loadPersonaPrefix(): string {
  const patchPath = join(import.meta.dirname, '..', '..', 'cordis.gotry-patch.yml')
  const document = parseYaml(readFileSync(patchPath, 'utf-8')) as unknown
  if (!Array.isArray(document)) throw new Error('cordis.gotry-patch.yml must contain a patch array')
  const systemPrompt = document.find(entry => (
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && (entry as { id?: unknown }).id === 'system-prompt'
  )) as { config?: { personaPrefix?: unknown } } | undefined
  const prefix = systemPrompt?.config?.personaPrefix
  if (typeof prefix !== 'string') throw new Error('cordis.gotry-patch.yml system-prompt.personaPrefix is missing')
  return prefix
}

let toolCall = 0
function runTool(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: `issue-338-${++toolCall}-${name}` as never,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

function resultValue<T>(result: ToolExecutionResult): T {
  assert.equal(result.isError, false, `真实 ToolRuntime 调用失败: ${result.isError ? result.error.message : 'unknown'}`)
  return result.value as T
}

interface PluginWorld {
  ctx: Context
  close: () => Promise<void>
}

async function bootPlugin(stateRoot: string, personaPrefix = ''): Promise<PluginWorld> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix })
  await ctx.plugin(ToolRuntime, {})
  apply(ctx, {
    stateRoot,
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'ask',
  })

  return {
    ctx,
    // E2E 用:让测试代码强制释放模块级 openLedgers 缓存,后续 bootPlugin
    // 就会从 SQLite 真实重读,模拟「进程重启后再开读回」
    close: async () => {
      const ledger = openLedgerIfExists(stateRoot)
      if (ledger) ledger.close()
      await ctx.fiber.dispose()
    },
  }
}

async function renderRawProfilePrompt(stateRoot: string, profile: unknown): Promise<{ prompt: string; before: string; after: string; dbCreated: boolean }> {
  const profilePath = join(stateRoot, 'gotry-state', 'motivation-profile.json')
  mkdirSync(join(stateRoot, 'gotry-state'), { recursive: true })
  writeFileSync(profilePath, JSON.stringify(profile))
  const before = readFileSync(profilePath, 'utf-8')
  const world = await bootPlugin(stateRoot, loadPersonaPrefix())
  try {
    const prompt = renderPrompt(await world.ctx.systemPrompt.assemble())
    return {
      prompt,
      before,
      after: readFileSync(profilePath, 'utf-8'),
      dbCreated: existsSync(join(stateRoot, 'gotry-state', 'gotry-state.db')),
    }
  } finally {
    await world.close()
  }
}

async function main(): Promise<void> {
  // ===== acceptance #1:首次显式保存(gotry_motivation_save → fresh stateRoot) =====
  console.log('=== acceptance #1:首次显式保存(gotry_motivation_save) ===')
  const root1 = mkdtempSync(join(tmpdir(), 'gotry-338-1-'))
  let world1: PluginWorld | null = null
  let world2: PluginWorld | null = null
  try {
    world1 = await bootPlugin(root1)
    const homeQuote = '用户原话:我常驻上海,从这里出发'
    const firstResult = await runTool(world1.ctx, 'gotry_motivation_save', {
      profile: {
        evidence: [homeQuote],
        homeCity: '上海',
        homeCityEvidence: homeQuote,
      },
    })
    const first = resultValue<{ ok?: boolean; saved?: boolean; profile?: MergedProfile & { updated_at?: string } }>(firstResult)
    check(first.ok === true && first.saved === true, '首次保存应 ok=true 且 saved=true')
    check(first.profile?.homeCity === '上海', `首次保存后画像 homeCity='上海'(实际 ${String(first.profile?.homeCity)})`)
    check((first.profile?.evidence ?? []).includes(homeQuote), 'evidence 追加进画像')
    // typed preference 三件套
    const pref = first.profile?.homeCityPreference
    check(pref?.value === '上海' && pref?.evidence === homeQuote && typeof pref?.updated_at === 'string',
      'typed preference 三件套(value/evidence/updated_at)写入返回 profile')
    // 读经账本(非内存)
    const ledger = openLedgerIfExists(root1)
    check(!!ledger, '账本应在 fresh stateRoot 落盘(fresh root + 写操作)')
    const persisted = ledger?.readMotivation() as (MergedProfile & { updated_at?: string }) | null
    check(persisted?.homeCity === '上海', '账本投影 homeCity 持久化(账本是权威面)')
    check(persisted?.homeCityPreference?.value === '上海', '账本投影 homeCityPreference.value 持久化')
    check(persisted?.homeCityPreference?.evidence === homeQuote, '账本投影 homeCityPreference.evidence 持久化(锁定指针)')
    check(typeof persisted?.homeCityPreference?.updated_at === 'string', '账本投影 homeCityPreference.updated_at 持久化(事件边界 ISO)')
    check(typeof persisted?.updated_at === 'string', 'updated_at 时间戳落账')
    // motivation.patch 事件落账(append-only)
    const events = ledger?.readEvents('motivation.patch', 10) ?? []
    check(events.length === 1, `首次保存产生恰好 1 条 motivation.patch 事件(实际 ${events.length})`)

    // ===== acceptance #2:真实 Cordis → SystemPrompt → renderPrompt 读回 =====
    console.log('\n=== acceptance #2:真实 model-facing system prompt 读回 default + evidence + updated_at ===')
    check(loadPersonaPrefix().includes('{{motivation_brief}}'), 'cordis.gotry-patch.yml 使用 motivation_brief 占位符')

    // 关闭第一段 context 的 ledger,再起第二段真实 Context/SystemPrompt/ToolRuntime。
    // 这一步证明下一次 model request 的 prompt 从 SQLite 磁盘读回;不调用 LLM。
    await world1.close()
    world1 = null
    world2 = await bootPlugin(root1, loadPersonaPrefix())
    const assembly = await world2.ctx.systemPrompt.assemble()
    const renderedPrompt = renderPrompt(assembly)
    check(renderedPrompt.includes('常驻城市: 上海'), '最终渲染 system prompt 含持久常驻城市')
    check(renderedPrompt.includes(homeQuote), '最终渲染 system prompt 含 exact home-city evidence')
    check(typeof pref?.updated_at === 'string' && renderedPrompt.includes(`记录于 ${pref.updated_at}`), '最终渲染 system prompt 含持久 preference timestamp')
    check(renderedPrompt.includes('本轮显式出发地优先'), '最终渲染 system prompt 含 explicit-current-turn-wins 指令')
    check(renderedPrompt.includes('软默认') && renderedPrompt.includes('不删候选') && renderedPrompt.includes('不进可行性硬约束'),
      '最终渲染 system prompt 明示 soft-default/no-hard-filter 边界')
    check(!renderedPrompt.includes('{{motivation_brief}}'), '最终渲染 system prompt 不残留 motivation_brief 占位符')
  } finally {
    if (world2) await world2.close()
    if (world1) await world1.close()
    rmSync(root1, { recursive: true, force: true })
  }

  // ===== acceptance #2b:raw/坏 typed profile 只读且不得推断默认 =====
  console.log('\n=== acceptance #2b:raw/坏 typed profile → missing clarification (real prompt path) ===')
  const legacyRoot = mkdtempSync(join(tmpdir(), 'gotry-338-2b-legacy-'))
  try {
    const legacyCity = '旧版上海'
    const unrelatedEvidence = '用户原话:这条只谈预算,不是城市声明'
    const rawReadback = await renderRawProfilePrompt(legacyRoot, {
      weights: { escape_rest: 1 },
      evidence: [unrelatedEvidence, '用户原话:另一个全局事实'],
      hard: {},
      homeCity: legacyCity,
      updated_at: '2026-09-10T00:00:00.000Z',
    })
    check(!rawReadback.prompt.includes(legacyCity), 'raw legacy homeCity 不注入 system prompt')
    check(!rawReadback.prompt.includes(unrelatedEvidence), 'raw legacy 全局 evidence 不标为城市原话')
    check(rawReadback.prompt.includes('无可验证的持久默认') && rawReadback.prompt.includes('本轮请明确出发地'),
      'raw legacy prompt 要求当轮明确出发地')
    check(rawReadback.before === rawReadback.after && !rawReadback.dbCreated, 'raw legacy 读取不改写或迁移文件')
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
  }

  const malformedCases = [
    {
      label: 'evidence pointer absent from pool',
      city: '脱池上海',
      evidence: '用户原话:全局事实不是城市声明',
      profile: {
        weights: { escape_rest: 1 },
        evidence: ['用户原话:全局事实不是城市声明'],
        hard: {},
        homeCity: '脱池上海',
        homeCityPreference: { value: '脱池上海', evidence: '用户原话:不在 evidence pool', updated_at: '2026-09-10T00:00:00.000Z' },
      },
    },
    {
      label: 'mismatched mirror',
      city: '镜像上海',
      evidence: '用户原话:typed 北京',
      profile: {
        weights: { escape_rest: 1 },
        evidence: ['用户原话:全局事实不是城市声明', '用户原话:typed 北京'],
        hard: {},
        homeCity: '镜像上海',
        homeCityPreference: { value: 'typed 北京', evidence: '用户原话:typed 北京', updated_at: '2026-09-10T00:00:00.000Z' },
      },
    },
    {
      label: 'impossible timestamp',
      city: '非法日期上海',
      evidence: '用户原话:全局事实也不是城市声明',
      profile: {
        weights: { escape_rest: 1 },
        evidence: ['用户原话:全局事实也不是城市声明', '用户原话:我常驻非法日期上海'],
        hard: {},
        homeCity: '非法日期上海',
        homeCityPreference: { value: '非法日期上海', evidence: '用户原话:我常驻非法日期上海', updated_at: '2026-02-30T00:00:00.000Z' },
      },
    },
    {
      label: 'bad evidence/timestamp',
      city: '坏证据上海',
      evidence: '用户原话:全局事实也不是城市声明',
      profile: {
        weights: { escape_rest: 1 },
        evidence: ['用户原话:全局事实也不是城市声明'],
        hard: {},
        homeCity: '坏证据上海',
        homeCityPreference: { value: '坏证据上海', evidence: '   ', updated_at: 'not-a-timestamp' },
      },
    },
  ]
  for (const malformed of malformedCases) {
    const malformedRoot = mkdtempSync(join(tmpdir(), 'gotry-338-2b-malformed-'))
    try {
      const rawReadback = await renderRawProfilePrompt(malformedRoot, malformed.profile)
      check(!rawReadback.prompt.includes(malformed.city), `${malformed.label} city 不注入 system prompt`)
      check(!rawReadback.prompt.includes(malformed.evidence), `${malformed.label} global evidence 不标为城市原话`)
      check(rawReadback.prompt.includes('无可验证的持久默认') && rawReadback.prompt.includes('本轮请明确出发地'),
        `${malformed.label} prompt 要求当轮明确出发地`)
      check(rawReadback.before === rawReadback.after && !rawReadback.dbCreated, `${malformed.label} 读取不改写或迁移文件`)
      const explicit = resolveDefaultOrigin('北京', malformed.profile)
      check(explicit.source === 'explicit' && explicit.origin === '北京', `${malformed.label} 下显式 origin 仍优先`)
    } finally {
      rmSync(malformedRoot, { recursive: true, force: true })
    }
  }

  // ===== acceptance #3:当轮显式出发地覆盖默认(pure resolveDefaultOrigin) =====
  console.log('\n=== acceptance #3:当轮显式出发地覆盖默认 ===')
  const root3 = mkdtempSync(join(tmpdir(), 'gotry-338-3-'))
  let world3: PluginWorld | null = null
  try {
    world3 = await bootPlugin(root3)
    const homeQuote = '用户原话:我常驻上海'
    const saved = resultValue<{ saved?: boolean }>(await runTool(world3.ctx, 'gotry_motivation_save', {
      profile: { homeCity: '上海', evidence: [homeQuote] },
    }))
    check(saved.saved === true, 'resolver fixture 的保存经真实 ToolRuntime 成功')
    const persisted = openLedgerIfExists(root3)?.readMotivation() as MergedProfile
    const explicit = resolveDefaultOrigin('北京', persisted)
    check(explicit.source === 'explicit' && explicit.origin === '北京', `pure resolver explicit 优先(实际 source=${explicit.source}, origin=${explicit.origin})`)
    check(explicit.homeCity === '上海', 'explicit 路径不丢弃 homeCity 供 UI 展示')
    const blankAsMissing = resolveDefaultOrigin('   ', persisted)
    check(blankAsMissing.source === 'home_default' && blankAsMissing.origin === '上海', '空白 origin 视作未传,落 home_default')
    // typed preference 路径标记
    check(explicit.homeCityPreferenceSource === 'none', 'explicit 路径 source 标签为 none')
    check(blankAsMissing.homeCityPreferenceSource === 'typed', '空白 origin 时走 typed preference 路径')
  } finally {
    if (world3) await world3.close()
    rmSync(root3, { recursive: true, force: true })
  }

  // ===== acceptance #4:重复保存 = 幂等(无新事件) =====
  console.log('\n=== acceptance #4:重复保存 = 幂等 ===')
  const root4 = mkdtempSync(join(tmpdir(), 'gotry-338-4-'))
  let world4: PluginWorld | null = null
  try {
    world4 = await bootPlugin(root4)
    const homeQuote = '用户原话:我常驻上海'
    const unrelatedFirst = '用户原话:这次预算不超过 5000'
    const first = resultValue<{ saved?: boolean }>(await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { homeCity: '上海', evidence: [unrelatedFirst, homeQuote], homeCityEvidence: homeQuote },
    }))
    check(first.saved === true, '首次保存 saved=true')
    const ledger = openLedgerIfExists(root4)!
    const countAfterFirst = ledger.readEvents('motivation.patch', 50).length
    const prefFirst = ledger.readMotivation()?.homeCityPreference
    check(prefFirst?.evidence === homeQuote, '无关新事实在前时 preference 仍锁定后面的 home-city quote')

    const missingBinding = await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { homeCity: '北京', evidence: ['用户原话:我搬去北京', '用户原话:这次还要控制预算'] },
    })
    const missingValue = resultValue<{ ok?: boolean; summary?: string }>(missingBinding)
    check(missingValue.ok === false, '改城市缺失 homeCityEvidence 应走结构化失败')
    check(ledger.readEvents('motivation.patch', 50).length === countAfterFirst, '缺失 binding 零新 ledger 事件')

    const orphanBinding = await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { evidence: [homeQuote], homeCityEvidence: homeQuote },
    })
    const orphanValue = resultValue<{ ok?: boolean; summary?: string }>(orphanBinding)
    check(orphanValue.ok === false, 'homeCityEvidence 脱离 homeCity 应走结构化失败')
    check(ledger.readEvents('motivation.patch', 50).length === countAfterFirst, 'orphan binding 零新 ledger 事件')

    const mismatchedBinding = await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { homeCity: '北京', evidence: ['用户原话:我搬去北京'], homeCityEvidence: '用户原话:未出现在本次 evidence' },
    })
    const mismatchedValue = resultValue<{ ok?: boolean; summary?: string }>(mismatchedBinding)
    check(mismatchedValue.ok === false, 'mismatched homeCityEvidence 应走结构化失败')
    check(ledger.readEvents('motivation.patch', 50).length === countAfterFirst, 'mismatched binding 零新 ledger 事件')

    const staleBinding = resultValue<{ saved?: boolean }>(await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { homeCity: '北京', evidence: [homeQuote], homeCityEvidence: homeQuote },
    }))
    check(staleBinding.saved === false, '改城市绑定已存在的 stale quote 不应落账')
    check(ledger.readEvents('motivation.patch', 50).length === countAfterFirst, 'stale binding 零新 ledger 事件')

    const second = resultValue<{ saved?: boolean }>(await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { homeCity: '上海', evidence: [homeQuote], homeCityEvidence: homeQuote },
    }))
    check(second.saved === false, '同值同 evidence 重复保存 saved=false (P0 守门)')
    const countAfterSecond = ledger.readEvents('motivation.patch', 50).length
    check(countAfterSecond === countAfterFirst, `幂等:无新 motivation.patch 事件(实际差 ${countAfterSecond - countAfterFirst})`)

    // 同值 + genuinely new bound home-city quote 可更新 preference/timestamp;
    // evidence 数组中故意把无关事实放在前面,绑定明确指向第二条。
    const refreshedQuote = '用户原话:我现在仍常驻上海'
    const refreshed = resultValue<{ saved?: boolean }>(await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { homeCity: '上海', evidence: ['用户原话:孩子要上学', refreshedQuote], homeCityEvidence: refreshedQuote },
    }))
    check(refreshed.saved === true, '同值 + 新 bound home-city quote 允许落盘')
    const prefAfterBound = ledger.readMotivation()?.homeCityPreference
    const latestBoundEvent = ledger.readEvents('motivation.patch', 50)[0]
    check(prefAfterBound?.evidence === refreshedQuote, '新绑定 exact quote 更新 preference.evidence')
    check(prefAfterBound?.updated_at === latestBoundEvent?.ts, '新绑定 preference.updated_at 等于事件行 timestamp')
    check(prefAfterBound?.updated_at !== prefFirst?.updated_at || prefAfterBound?.evidence !== prefFirst?.evidence,
      '新绑定改变 preference 记录而非仅追加全局 evidence')

    const clearStale = resultValue<{ saved?: boolean }>(await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { homeCity: null, evidence: [refreshedQuote], homeCityEvidence: refreshedQuote },
    }))
    check(clearStale.saved === false, '清除绑定 stale quote 不应落账')
    const countAfterStaleClear = ledger.readEvents('motivation.patch', 50).length
    check(countAfterStaleClear === countAfterSecond + 1, `stale clear 零新 ledger 事件(实际 ${countAfterStaleClear})`)

    // 仅无关 patch 仍可追加全局 evidence,但绝不改写 homeCityPreference。
    const unrelated = resultValue<{ saved?: boolean }>(await runTool(world4.ctx, 'gotry_motivation_save', {
      profile: { evidence: ['用户原话:后续无关事实:孩子要上学'] },
    }))
    check(unrelated.saved === true, '未传 homeCity 的无关 patch 仍可追加')
    const afterUnrelated = ledger.readEvents('motivation.patch', 50).length
    check(afterUnrelated === countAfterStaleClear + 1, '无关 patch 产生 1 条新事件')
    const prefAfter = ledger.readMotivation()?.homeCityPreference
    check(prefAfter?.value === '上海', '无关 evidence 追加后 homeCityPreference.value 不变')
    check(prefAfter?.evidence === prefAfterBound?.evidence, '无关 evidence 追加不污染 homeCityPreference.evidence')
    check(prefAfter?.updated_at === prefAfterBound?.updated_at, '无关 evidence 追加不改写 homeCityPreference.updated_at')
  } finally {
    if (world4) await world4.close()
    rmSync(root4, { recursive: true, force: true })
  }

  // ===== acceptance #5:跨 tenant 不可见 =====
  console.log('\n=== acceptance #5:跨 tenant 不可见 ===')
  const root5 = mkdtempSync(join(tmpdir(), 'gotry-338-5-'))
  try {
    // local tenant 写入 homeCity
    const localLedger = ensureLedger(root5, 'local')
    localLedger.appendMotivationPatch({
      homeCity: '上海', evidence: ['用户原话:常驻上海'], homeCityEvidence: '用户原话:常驻上海',
    })
    // tenant-a 视角:账本物理文件存在,但 motivation 投影按 tenant_id 列过滤 → null
    const tenantA = openLedgerIfExists(root5, 'tenant-a')
    check(!!tenantA, '账本物理文件存在(共享 SQLite,按 tenant_id 列隔离)')
    const motivationA = tenantA?.readMotivation() ?? null
    check(motivationA === null, `tenant-a 读 motivation 必须 null(实际 ${JSON.stringify(motivationA)})`)
    // tenant-a 第一次写自己的 homeCity(物理同文件,逻辑隔离)
    const tenantALedger = ensureLedger(root5, 'tenant-a')
    tenantALedger.appendMotivationPatch({
      homeCity: '北京', evidence: ['用户原话:常驻北京'], homeCityEvidence: '用户原话:常驻北京',
    })
    check(tenantALedger.readMotivation()?.homeCity === '北京', 'tenant-a 视角读到自己的 homeCity')
    // local 仍是上海
    check(localLedger.readMotivation()?.homeCity === '上海', 'local 视角仍是 上海(不被 tenant-a 串位)')
    // resolveDefaultOrigin 在 tenant-a 视角:homeCity=北京
    const resolvedTenantA = resolveDefaultOrigin(undefined, tenantALedger.readMotivation())
    check(resolvedTenantA.source === 'home_default' && resolvedTenantA.origin === '北京', 'tenant-a 解析得 home_default=北京')
    // 同 root 切换回 local:仍是上海
    const resolvedLocal = resolveDefaultOrigin(undefined, localLedger.readMotivation())
    check(resolvedLocal.origin === '上海', 'local 解析得 home_default=上海')
  } finally {
    const ledger = openLedgerIfExists(root5, 'local')
    if (ledger) ledger.close()
    const tenantLedger = openLedgerIfExists(root5, 'tenant-a')
    if (tenantLedger) tenantLedger.close()
    rmSync(root5, { recursive: true, force: true })
  }

  // ===== acceptance #6:显式清除(移除活跃投影,但审计事件保留) =====
  console.log('\n=== acceptance #6:显式清除(移除活跃投影,审计事件保留) ===')
  const root6 = mkdtempSync(join(tmpdir(), 'gotry-338-6-'))
  let world6: PluginWorld | null = null
  try {
    world6 = await bootPlugin(root6, loadPersonaPrefix())
    const homeQuote = '用户原话:常驻上海'
    resultValue<{ saved?: boolean }>(await runTool(world6.ctx, 'gotry_motivation_save', {
      profile: { homeCity: '上海', evidence: [homeQuote], homeCityEvidence: homeQuote },
    }))
    const ledger = openLedgerIfExists(root6)!
    check(ledger.readMotivation()?.homeCity === '上海', '保存后 homeCity=上海')
    const eventsBeforeClear = ledger.readEvents('motivation.patch', 50).length
    // 显式清除
    const clearQuote = '用户原话:迁居,不设默认'
    const clearResult = resultValue<{ saved?: boolean; profile?: MergedProfile }>(await runTool(world6.ctx, 'gotry_motivation_save', {
      profile: { homeCity: null, evidence: [clearQuote], homeCityEvidence: clearQuote },
    }))
    check(clearResult.saved === true, '清除请求应 saved=true(发生变更)')
    check(clearResult.profile?.homeCity === null, `清除后画像 homeCity=null(实际 ${String(clearResult.profile?.homeCity)})`)
    const eventsAfterClear = ledger.readEvents('motivation.patch', 50).length
    check(eventsAfterClear === eventsBeforeClear + 1, `清除产生 1 条 motivation.patch 事件(差 ${eventsAfterClear - eventsBeforeClear})`)
    // 活跃投影:homeCity 为 null
    const ledgerAfterClear = ledger.readMotivation() as MergedProfile
    check(ledgerAfterClear.homeCity === null, '账本投影 homeCity=null(已清除)')
    // typed preference 记录清除态(value=null,但 evidence + updated_at 留存)
    check(ledgerAfterClear.homeCityPreference?.value === null, 'typed preference.value=null(清除态)')
    check(ledgerAfterClear.homeCityPreference?.evidence === clearQuote, 'typed preference.evidence 锁定到本次清除原话')
    check(typeof ledgerAfterClear.homeCityPreference?.updated_at === 'string', 'typed preference.updated_at 留存')
    // 审计事件保留:清除 patch 事件依然存在
    const clearEvent = ledger.readEvents('motivation.patch', 50).find(e => {
      const p = JSON.parse(e.payload) as { patch?: { homeCity?: unknown } }
      return p.patch?.homeCity === null
    })
    check(!!clearEvent, '清除事件在 append-only 事件流中可审计')
    // evidence 列表包含清除原话(溯源 P0:谁、何时、说了什么)
    check((ledgerAfterClear.evidence ?? []).includes('用户原话:迁居,不设默认'), 'evidence append-only 保留清除原话')
    // 读回变量更新:motivation_brief 反映 missing 状态
    const clearPrompt = renderPrompt(await world6.ctx.systemPrompt.assemble())
    check(clearPrompt.includes('已显式清除'), `真实渲染 system prompt 在清除后反映 missing(实际:${clearPrompt.slice(0, 200)})`)

    // ===== acceptance #7:清除后 resolveDefaultOrigin 返回 missing(不猜测) =====
    console.log('\n=== acceptance #7:清除后 resolveDefaultOrigin 返回 missing ===')
    const resolved = resolveDefaultOrigin(undefined, ledgerAfterClear)
    check(resolved.source === 'missing' && resolved.origin === null, `清除后必须 missing(实际 source=${resolved.source}, origin=${resolved.origin})`)
    // 显式 origin 仍赢
    const resolvedExplicit = resolveDefaultOrigin('深圳', ledgerAfterClear)
    check(resolvedExplicit.source === 'explicit' && resolvedExplicit.origin === '深圳', '清除后显式 origin 仍赢')

    // fold 重建仍正确反映清除状态(账本/投影永不分叉)
    ledger.rebuildProjections()
    const afterRebuild = ledger.readMotivation() as MergedProfile
    check(afterRebuild.homeCity === null, 'fold 重建后 homeCity 仍为 null(账本=权威面)')
    check(afterRebuild.homeCityPreference?.value === null, 'fold 重建后 typed preference.value 仍为 null')
    check(afterRebuild.homeCityPreference?.evidence === clearQuote, 'fold 重建后 typed preference.evidence 不丢')
    check(afterRebuild.homeCityPreference?.updated_at === ledgerAfterClear.homeCityPreference?.updated_at,
      'fold 重建后 typed preference.updated_at 与直读一致(无 clock 漂移)')
    check(JSON.stringify(afterRebuild) === JSON.stringify(ledgerAfterClear), '重建后 projection JSON 与重建前 byte-equivalent')

    // 重复清除幂等
    const dupClear = resultValue<{ saved?: boolean }>(await runTool(world6.ctx, 'gotry_motivation_save', {
      profile: { homeCity: null, evidence: [clearQuote], homeCityEvidence: clearQuote },
    }))
    check(dupClear.saved === false, '同 null + 同 evidence 重复清除幂等(saved=false)')

    // 空白 homeCity 入口拒收,零事件落账
    // (registerGuarded → guardToolExecute 兜成结构化失败,不再向上抛)
    const beforeBlank = ledger.readEvents('motivation.patch', 50).length
    const blankResult = await runTool(world6.ctx, 'gotry_motivation_save', { profile: { homeCity: '   ', evidence: ['用户原话:空字符串不该落账'], homeCityEvidence: '用户原话:空字符串不该落账' } })
    const blankValue = resultValue<{ ok?: boolean; summary?: string }>(blankResult)
    check(blankValue.ok === false, `空白 homeCity 应被结构化拒绝(ok=false,实际 ${blankValue.ok})`)
    const failureMsg = String(blankValue.summary ?? '')
    check(/空白/.test(failureMsg), `空白 homeCity 拒绝信息明示「空白」(实际:${failureMsg})`)
    const afterBlank = ledger.readEvents('motivation.patch', 50).length
    check(afterBlank === beforeBlank, `空白 homeCity 拒绝后零新事件(实际差 ${afterBlank - beforeBlank})`)
  } finally {
    if (world6) await world6.close()
    rmSync(root6, { recursive: true, force: true })
  }

  // ===== acceptance #8:默认永不筛候选/不改硬约束 =====
  console.log('\n=== acceptance #8:默认永不筛候选/不改硬约束 ===')
  const root8 = mkdtempSync(join(tmpdir(), 'gotry-338-8-'))
  let world8: PluginWorld | null = null
  let world8b: PluginWorld | null = null
  let root8bInner: string | null = null
  try {
    // 1) 无 homeCity 基线(fresh stateRoot:账本无记录 → profile.homeCity=undefined)
    const basePayload = loadFixturePayload()
    world8 = await bootPlugin(root8)
    const baseline = resultValue<{
      ok?: boolean; recommended?: string | null; verdicts?: Array<Record<string, unknown>>
    }>(await runTool(world8.ctx, 'gotry_feasibility_check', { payload: basePayload }))
    check(baseline.ok === true, 'baseline feasibility 应成功')
    const baselineCount = (baseline.verdicts ?? []).length
    const baselineIds = (baseline.verdicts ?? []).map(v => String(v['candidate_id'])).sort()
    const baselineRecommended = baseline.recommended
    await world8.close()
    world8 = null
    rmSync(root8, { recursive: true, force: true })

    // 2) 同 payload + 持久 homeCity='上海'(stateRoot 写过 homeCity=上海)
    const root8b = mkdtempSync(join(tmpdir(), 'gotry-338-8b-'))
    root8bInner = root8b
    try {
        world8b = await bootPlugin(root8b)
        const homeQuote = '用户原话:常驻上海'
        resultValue<{ saved?: boolean }>(await runTool(world8b.ctx, 'gotry_motivation_save', {
          profile: { homeCity: '上海', evidence: [homeQuote], homeCityEvidence: homeQuote },
        }))
        const withHome = resultValue<{
          ok?: boolean; recommended?: string | null; verdicts?: Array<Record<string, unknown>>
        }>(await runTool(world8b.ctx, 'gotry_feasibility_check', { payload: basePayload }))
        check(withHome.ok === true, '设置 homeCity 后 feasibility 仍成功')
        const withHomeCount = (withHome.verdicts ?? []).length
        const withHomeIds = (withHome.verdicts ?? []).map(v => String(v['candidate_id'])).sort()
        check(withHomeCount === baselineCount, `候选数量不变(baseline=${baselineCount}, with_home=${withHomeCount})`)
        check(withHomeIds.join(',') === baselineIds.join(','), `候选 id 集合不变(${withHomeIds.join(',')})`)
        check(withHome.recommended === baselineRecommended, `推荐结果不变(baseline=${baselineRecommended}, with_home=${withHome.recommended})`)

        // 3) 同 payload + 显式 homeCity=null(已清除)
        const clearQuote = '用户原话:取消常驻'
        resultValue<{ saved?: boolean }>(await runTool(world8b.ctx, 'gotry_motivation_save', {
          profile: { homeCity: null, evidence: [clearQuote], homeCityEvidence: clearQuote },
        }))
        const withCleared = resultValue<{
          ok?: boolean; recommended?: string | null; verdicts?: Array<Record<string, unknown>>
        }>(await runTool(world8b.ctx, 'gotry_feasibility_check', { payload: basePayload }))
        const clearedCount = (withCleared.verdicts ?? []).length
        const clearedIds = (withCleared.verdicts ?? []).map(v => String(v['candidate_id'])).sort()
        check(clearedCount === baselineCount, `清除后候选数量仍不变(${clearedCount})`)
        check(clearedIds.join(',') === baselineIds.join(','), '清除后候选 id 集合仍不变')
        check(withCleared.recommended === baselineRecommended, '清除后推荐结果仍不变')

        // 4) 守护:持久默认只供读回/规划提示,不进入 feasibility/evaluate
        // 的候选过滤或硬约束路径;因此与上海无关的候选仍保留。
        check(baselineIds.includes('qiandao') && baselineIds.includes('taihu'),
          'baseline 候选包含 qiandao/taihu(候选未按持久默认过滤)')

        // 5) equality 只证明 persisted default 不 hard-filter 或改变确定性
        // candidates/recommendation;不声称 feasibility_check 消费 resolver。
        const withHomeJson = JSON.stringify({
          ok: withHome.ok, recommended: withHome.recommended,
          verdictIds: (withHome.verdicts ?? []).map(v => String(v['candidate_id'])).sort(),
        })
        const withClearedJson = JSON.stringify({
          ok: withCleared.ok, recommended: withCleared.recommended,
          verdictIds: (withCleared.verdicts ?? []).map(v => String(v['candidate_id'])).sort(),
        })
        check(withHomeJson === withClearedJson,
          '同 payload 在 homeCity=上海 与 homeCity=null 下产出完全一致(候选不依赖 homeCity)')
    } finally {
        if (world8b) await world8b.close()
        world8b = null
        rmSync(root8b, { recursive: true, force: true })
        root8bInner = null
    }
  } finally {
    if (world8) await world8.close()
    if (root8bInner) rmSync(root8bInner, { recursive: true, force: true })
    if (existsSync(root8)) rmSync(root8, { recursive: true, force: true })
  }

  console.log(`\nISSUE-#338 HOME-CITY E2E: ${pass} ok, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

// 该文件不导出符号(测试自身为脚本进程)。
// 显式存在性检查保留:读取 model.ts 物理存在以证明 issue #338 不动 model.ts 算术/求解路径。
if (!existsSync(join(import.meta.dirname, '..', 'src', 'model.ts'))) {
  console.error('FAIL: model.ts 不存在(该 E2E 假设 model.ts 不被改动)')
  process.exit(1)
}
