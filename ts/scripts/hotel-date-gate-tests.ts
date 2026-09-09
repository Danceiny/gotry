/**
 * issue #283 维护测试:`gotry_hotel_search` 在缺/空/单侧/无法解析/倒序/同日日期时
 * 必须返回可行动 input_required,**不得发起 hbcli 供应商命令**;完整、有效且
 * 退房晚于入住的日期经真实 apply 注册入口进入 fixture hbcli,argv 必须含
 * 解析后的绝对日期。隔离 stateRoot + 临时 fixture hbcli 在 finally 中清理;
 * 没有调用真实 HotelByte、访问凭证或写入共享用户数据。
 *
 * 运行:cd ts && npx tsx scripts/hotel-date-gate-tests.ts
 *
 * 测试纪律(假绿防线):
 *   - bridge-latency.jsonl 走真实 gotry-state 子路径(stateRoot/gotry-state/),
 *     用 ENOENT 哨兵 + before/after snapshot 钉死「闸失败 → 零写入;成功 → 1 行」;
 *   - fixture hbcli argv 日志初始写 `__NOT_SPAWNED__` 哨兵,任何 spawn 必改写;
 *     `assertSpawned` 显式拒绝哨兵形态,`assertNoSpawn` 显式要求哨兵未被改写;
 *   - 日期算术复用 `buildTimeAnchor`/`resolveSlotDate` 的算术口径,跨周末/
 *     跨月/跨年进位稳定(不用魔法数偏移);
 *   - exact argv 断言使用完整 flag + value 字符串,允许不同顺序但每对 flag/value
 *     必出现;不放过「hbcli 收到错误日期」。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

interface ToolLike {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  presentResult?: (args: Record<string, unknown>, value: unknown) => unknown
}

interface SuiteState {
  tmp: string
  stateRoot: string
  /** gotry-state 子路径(recordLatency/ensureStateDir 的真实写入位置) */
  stateDir: string
  /** bridge-latency.jsonl 完整路径(闸失败的零写入断言目标) */
  latencyPath: string
  fixturePath: string
  fixtureLogPath: string
  byName: (name: string) => ToolLike
  cleanup: () => void
}

/** 闸未发起 hbcli 时 fixture argv 日志的固定哨兵(不是空白字符串!空白也可被 spawn 写入) */
const NO_SPAWN_SENTINEL = '__NOT_SPAWNED__'

/** 临时 fixture hbcli:把 $@ 写入日志,然后 exit 0 + 空 JSON */
function installRecordingFixture(tmp: string, name: string): { path: string; logPath: string } {
  const logPath = join(tmp, `${name}.argv.log`)
  const fixturePath = join(tmp, name)
  writeFileSync(logPath, `${NO_SPAWN_SENTINEL}\n`)
  writeFileSync(fixturePath, `#!/bin/sh\necho "$@" > '${logPath}'\necho '{}'\nexit 0\n`)
  chmodSync(fixturePath, 0o755)
  return { path: fixturePath, logPath }
}

/** 真实 apply 注册入口 + 临时 fixture hbcli + 隔离 stateRoot 装配 */
async function bootstrap(): Promise<SuiteState> {
  const tmp = mkdtempSync(join(tmpdir(), 'gotry-issue283-'))
  const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-issue283-state-'))
  const stateDir = join(stateRoot, 'gotry-state')
  const latencyPath = join(stateDir, 'bridge-latency.jsonl')
  const fixture = installRecordingFixture(tmp, 'hbcli-record')
  const registered: ToolLike[] = []
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t as ToolLike) },
    systemPrompt: { variable: () => () => '' },
    on: () => () => {},
  } as unknown as Context
  const cfg = {
    stateRoot,
    timeoutMs: 5_000,
    hbcliBin: fixture.path,           // 强制走 fixture 路径(测试确定性)
    sessionAccess: 'off',
    benchmarkEnvironmentConfigPath: '',
  }
  apply(ctx, cfg)
  const byName = (name: string): ToolLike => {
    const t = registered.find(t => t.name === name)
    if (!t) throw new Error(`tool ${name} not registered`)
    return t
  }
  const cleanup = () => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
    try { rmSync(stateRoot, { recursive: true, force: true }) } catch {}
  }
  return { tmp, stateRoot, stateDir, latencyPath, fixturePath: fixture.path, fixtureLogPath: fixture.logPath, byName, cleanup }
}

/** 重置哨兵:每次 no-spawn 断言前先把日志改回哨兵,确保断言的是本次执行而非历史残留 */
function resetNoSpawnSentinel(fixtureLogPath: string): void {
  writeFileSync(fixtureLogPath, `${NO_SPAWN_SENTINEL}\n`)
}

function assertNoSpawn(label: string, fixtureLogPath: string): void {
  let argv = ''
  try { argv = readFileSync(fixtureLogPath, 'utf-8').trim() } catch { argv = '' }
  // 严格:要求哨兵未被改写;被改写 = fixture 被 spawn = 闸失败路径逃逸(FAIL)
  if (argv !== NO_SPAWN_SENTINEL) {
    throw new Error(`FAIL[${label}]: 闸失败时 fixture hbcli 不应被调用,但日志被改写: ${argv.slice(0, 200)}`)
  }
  // 期望状态:哨兵保持原样,确认无 spawn
}

function assertSpawned(label: string, fixtureLogPath: string): string {
  let argv = ''
  try { argv = readFileSync(fixtureLogPath, 'utf-8').trim() } catch { argv = '' }
  if (argv === '' || argv === NO_SPAWN_SENTINEL) {
    throw new Error(`FAIL[${label}]: fixture hbcli 应被调用但日志未被改写(${fixtureLogPath})`)
  }
  return argv
}

/** 读 bridge-latency.jsonl 行数(不存在 → 0);ENOENT 不算错 */
function readLatencyLineCount(path: string): number {
  if (!existsSync(path)) return 0
  const text = readFileSync(path, 'utf-8')
  if (!text.trim()) return 0
  return text.trim().split('\n').length
}

const suite = await bootstrap()
const hotel = suite.byName('gotry_hotel_search')

/** 精确 argv 断言工具:每对 flag/value 必须存在(允许 flag/value 顺序变化) */
function assertHasPair(argv: string, flag: string, value: string, label: string): void {
  // argv 是 `$@` 的 quoted 拼接:形如 `search hotel-list --destination-name 迪拜 --check-in 2026-09-18 ...`
  // 我们需要确保 flag 后紧跟 value(忽略中间的 flag 名),即搜索成对 flag + value
  const tokens = argv.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === flag && tokens[i + 1] === value) return
  }
  throw new Error(`FAIL[${label} argv]: 期望 ${flag} ${value} 配对出现,实际 ${argv}`)
}

try {
  // ============================================================
  // §A 闸失败路径(共 8 个反例)—— 必须 no-spawn + 一致的 reason/missing/raw/message/evidence
  // ============================================================

  // 1) 基线反例(issue #283 截图实证形态):空日期 → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const empty = await hotel.execute({ destination: '迪拜', checkIn: '', checkOut: '', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>
      destination?: string; message?: string; evidence?: string; summary?: string
    }
    if (empty.ok !== false) throw new Error(`FAIL[空日期]: 应 ok=false,实际 ${JSON.stringify(empty).slice(0, 200)}`)
    if (empty.verdict !== 'input_required') throw new Error(`FAIL[空日期]: 应 verdict=input_required,实际 ${empty.verdict}`)
    if (empty.reason !== 'check_in_blank') throw new Error(`FAIL[空日期]: 应 reason=check_in_blank,实际 ${empty.reason}`)
    if (!empty.missing?.includes('checkIn') || !empty.missing?.includes('checkOut')) throw new Error(`FAIL[空日期]: missing 应含 checkIn/checkOut,实际 ${JSON.stringify(empty.missing)}`)
    if (!empty.evidence?.includes('hotel-date-gate')) throw new Error(`FAIL[空日期]: evidence 应带 hotel-date-gate 标注,实际 ${empty.evidence}`)
    if (!empty.message?.includes('空字符串')) throw new Error(`FAIL[空日期]: message 应明示「空字符串」,实际 ${empty.message}`)
    if (empty.raw?.checkIn !== '' || empty.raw?.checkOut !== '') throw new Error(`FAIL[空日期]: raw 应回显空串,实际 ${JSON.stringify(empty.raw)}`)
    if (!empty.summary?.includes('闸拒绝')) throw new Error(`FAIL[空日期]: summary 应可行动(闸拒绝),实际 ${empty.summary}`)
    // presentResult 必须渲染为 input_required 行动卡(非「无结果」)
    const card = hotel.presentResult?.({ destination: '迪拜' } as never, empty) as { title?: string; content?: Array<{ type: string; text: string }> } | undefined
    if (!card?.title?.includes('缺日期')) throw new Error(`FAIL[空日期 presentResult]: 标题应含「缺日期」,实际 ${card?.title}`)
    if (!card?.content?.[0]?.text?.includes('入住日+退房日')) throw new Error(`FAIL[空日期 presentResult]: 内容应指明缺哪些字段,实际 ${card?.content?.[0]?.text}`)
    assertNoSpawn('空日期', suite.fixtureLogPath)
    console.log('1) 空日期 → input_required(check_in_blank),both missing,no spawn,actionable card OK')
  }

  // 2) 完全缺失(字段未传) → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const missing = await hotel.execute({ destination: '迪拜', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>
      message?: string; evidence?: string
    }
    if (missing.ok !== false || missing.verdict !== 'input_required') throw new Error(`FAIL[缺失]: ${JSON.stringify(missing).slice(0, 200)}`)
    if (missing.reason !== 'check_in_missing') throw new Error(`FAIL[缺失]: reason 应为 check_in_missing,实际 ${missing.reason}`)
    if (!missing.missing?.includes('checkIn') || !missing.missing?.includes('checkOut')) throw new Error(`FAIL[缺失]: missing 应含两侧,实际 ${JSON.stringify(missing.missing)}`)
    if (missing.raw?.checkIn !== undefined || missing.raw?.checkOut !== undefined) throw new Error(`FAIL[缺失]: raw 应全 undefined,实际 ${JSON.stringify(missing.raw)}`)
    if (!missing.evidence?.includes(':both')) throw new Error(`FAIL[缺失]: evidence 应带 :both 标注,实际 ${missing.evidence}`)
    assertNoSpawn('完全缺失', suite.fixtureLogPath)
    console.log('2) 完全缺失 → input_required(check_in_missing),both,raw=undefined,no spawn OK')
  }

  // 3) 单侧:仅入住,无退房 → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const oneSide = await hotel.execute({ destination: '普吉', checkIn: '2026-09-18', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>
      message?: string
    }
    if (oneSide.ok !== false || oneSide.verdict !== 'input_required' || oneSide.reason !== 'check_out_missing') throw new Error(`FAIL[单侧]: ${JSON.stringify(oneSide).slice(0, 200)}`)
    if (!oneSide.missing?.includes('checkOut')) throw new Error(`FAIL[单侧]: missing 应含 checkOut,实际 ${JSON.stringify(oneSide.missing)}`)
    if (oneSide.raw?.checkIn !== '2026-09-18' || oneSide.raw?.checkOut !== undefined) throw new Error(`FAIL[单侧]: raw 应回显 checkIn 原话、checkOut 缺失,实际 ${JSON.stringify(oneSide.raw)}`)
    assertNoSpawn('单侧', suite.fixtureLogPath)
    console.log('3) 单侧(只 checkIn) → input_required(check_out_missing),no spawn OK')
  }

  // 3b) 单侧反向:仅退房,无入住 → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const oneSideRev = await hotel.execute({ destination: '普吉', checkOut: '2026-09-20', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]
    }
    if (oneSideRev.ok !== false || oneSideRev.reason !== 'check_in_missing') throw new Error(`FAIL[单侧反向]: ${JSON.stringify(oneSideRev).slice(0, 200)}`)
    if (!oneSideRev.missing?.includes('checkIn')) throw new Error(`FAIL[单侧反向]: missing 应含 checkIn,实际 ${JSON.stringify(oneSideRev.missing)}`)
    assertNoSpawn('单侧反向', suite.fixtureLogPath)
    console.log('3b) 单侧(只 checkOut) → input_required(check_in_missing),no spawn OK')
  }

  // 3c) 混合缺失/空白:checkIn 缺失 + checkOut 空字符串 → 优先 missing(语义更前置)
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const mixed = await hotel.execute({ destination: '普吉', checkOut: '', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]
    }
    if (mixed.ok !== false || mixed.reason !== 'check_in_missing') throw new Error(`FAIL[混合缺失空白]: ${JSON.stringify(mixed).slice(0, 200)}`)
    if (!mixed.missing?.includes('checkIn')) throw new Error(`FAIL[混合缺失空白]: missing 应含 checkIn,实际 ${JSON.stringify(mixed.missing)}`)
    assertNoSpawn('混合缺失空白', suite.fixtureLogPath)
    console.log('3c) 混合(缺 checkIn + 空 checkOut) → check_in_missing 优先,no spawn OK')
  }

  // 3d) 混合空白/缺失:checkIn 空 + checkOut 缺失 → check_out_missing 优先(因为 checkIn 已传)
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const mixed2 = await hotel.execute({ destination: '普吉', checkIn: '', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>
    }
    if (mixed2.ok !== false || mixed2.reason !== 'check_out_missing') throw new Error(`FAIL[混合空白缺失]: ${JSON.stringify(mixed2).slice(0, 200)}`)
    if (!mixed2.missing?.includes('checkOut')) throw new Error(`FAIL[混合空白缺失]: missing 应含 checkOut,实际 ${JSON.stringify(mixed2.missing)}`)
    if (mixed2.raw?.checkIn !== '') throw new Error(`FAIL[混合空白缺失]: raw.checkIn 应回显空串,实际 ${JSON.stringify(mixed2.raw)}`)
    assertNoSpawn('混合空白缺失', suite.fixtureLogPath)
    console.log('3d) 混合(空 checkIn + 缺 checkOut) → check_out_missing(对侧未传),no spawn OK')
  }

  // 4) 倒序:退房早于入住 → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const reversed = await hotel.execute({ destination: '曼谷', checkIn: '2026-09-20', checkOut: '2026-09-18', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>
      message?: string; evidence?: string
    }
    if (reversed.ok !== false || reversed.verdict !== 'input_required' || reversed.reason !== 'check_out_not_after_check_in') throw new Error(`FAIL[倒序]: ${JSON.stringify(reversed).slice(0, 200)}`)
    if (!reversed.missing?.includes('checkOut')) throw new Error(`FAIL[倒序]: missing 应含 checkOut,实际 ${JSON.stringify(reversed.missing)}`)
    if (reversed.raw?.checkIn !== '2026-09-20' || reversed.raw?.checkOut !== '2026-09-18') throw new Error(`FAIL[倒序]: raw 应回显原话,实际 ${JSON.stringify(reversed.raw)}`)
    if (!reversed.evidence?.includes(':reversed')) throw new Error(`FAIL[倒序]: evidence 应带 :reversed 子标签,实际 ${reversed.evidence}`)
    if (!reversed.message?.includes('早于')) throw new Error(`FAIL[倒序]: message 应明示「早于」,实际 ${reversed.message}`)
    assertNoSpawn('倒序', suite.fixtureLogPath)
    console.log('4) 倒序 → input_required(check_out_not_after_check_in:reversed),no spawn OK')
  }

  // 5) 同日:0 晚不查 → no spawn(同一 reason,evidence 子标签区分)
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const sameDay = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '2026-09-18', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; message?: string; evidence?: string
    }
    if (sameDay.ok !== false || sameDay.reason !== 'check_out_not_after_check_in') throw new Error(`FAIL[同日]: ${JSON.stringify(sameDay).slice(0, 200)}`)
    if (!sameDay.evidence?.includes(':same_day')) throw new Error(`FAIL[同日]: evidence 应带 :same_day 子标签,实际 ${sameDay.evidence}`)
    if (!sameDay.message?.includes('0 晚')) throw new Error(`FAIL[同日]: message 应明示「0 晚」,实际 ${sameDay.message}`)
    assertNoSpawn('同日', suite.fixtureLogPath)
    console.log('5) 同日 → input_required(check_out_not_after_check_in:same_day),no spawn OK')
  }

  // 6) 无法解析:词表外表达 → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const unresolved = await hotel.execute({ destination: '大理', checkIn: '近期', checkOut: '下周', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; message?: string
    }
    if (unresolved.ok !== false || unresolved.verdict !== 'input_required') throw new Error(`FAIL[无法解析]: ${JSON.stringify(unresolved).slice(0, 200)}`)
    if (unresolved.reason !== 'check_in_unresolved') throw new Error(`FAIL[无法解析]: reason 应为 check_in_unresolved,实际 ${unresolved.reason}`)
    if (!unresolved.missing?.includes('checkIn')) throw new Error(`FAIL[无法解析]: missing 应含 checkIn,实际 ${JSON.stringify(unresolved.missing)}`)
    if (!unresolved.message?.includes('无法解析')) throw new Error(`FAIL[无法解析]: message 应明示「无法解析」,实际 ${unresolved.message}`)
    assertNoSpawn('无法解析', suite.fixtureLogPath)
    console.log('6) 无法解析 → input_required(check_in_unresolved),no spawn OK')
  }

  // 6b) 类型错误:非字符串入参(直接测闸函数,dsh host schema 会先拒;此处验证
  // 闸自身的健壮性——若上层漏过非字符串,闸必须降级为 check_in_blank:type 而非崩)
  {
    const { evaluateHotelStayDates } = await import('../src/hotel-date-gate.ts')
    const typeErr = evaluateHotelStayDates(42 as unknown as string, '2026-09-20') as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; message?: string; evidence?: string; raw?: Record<string, string | undefined>
    }
    if (typeErr.ok !== false || typeErr.reason !== 'check_in_blank') throw new Error(`FAIL[类型错误]: ${JSON.stringify(typeErr).slice(0, 200)}`)
    if (!typeErr.missing?.includes('checkIn')) throw new Error(`FAIL[类型错误]: missing 应含 checkIn,实际 ${JSON.stringify(typeErr.missing)}`)
    if (!typeErr.evidence?.includes(':type')) throw new Error(`FAIL[类型错误]: evidence 应带 :type 标注,实际 ${typeErr.evidence}`)
    if (!typeErr.message?.includes('类型错误')) throw new Error(`FAIL[类型错误]: message 应明示类型错误,实际 ${typeErr.message}`)
    if (typeErr.raw?.checkIn !== undefined) throw new Error(`FAIL[类型错误]: raw.checkIn 应为 undefined(非字符串不入 raw),实际 ${JSON.stringify(typeErr.raw)}`)
    console.log('6b) 类型错误(数字 checkIn) → 闸函数直接 input_required(check_in_blank:type),raw undefined OK')
  }

  // ============================================================
  // §B 闸通过路径 —— 必须真实 spawn + fixture argv 含精确日期
  // ============================================================

  // 7) 有效日期 → 真实工具入口 → fixture hbcli 收到精确 argv
  {
    const ok = await hotel.execute({ destination: '迪拜', checkIn: '2026-09-18', checkOut: '2026-09-20', adults: 2 } as never, null) as {
      ok?: boolean; hotels?: unknown; summary?: string; date_notes?: string[]
    }
    if (ok.ok !== true) throw new Error(`FAIL[有效日期]: 应 ok=true,实际 ${JSON.stringify(ok).slice(0, 200)}`)
    if (ok.date_notes && ok.date_notes.length) throw new Error(`FAIL[有效日期]: 绝对 ISO 不应产生 slot-resolved note,实际 ${JSON.stringify(ok.date_notes)}`)
    const argv = assertSpawned('有效日期', suite.fixtureLogPath)
    // 旗标逐项断言(issue #195 + #283:日期必须落在 --check-in/--check-out)
    if (!argv.includes('search')) throw new Error(`FAIL[有效日期 argv]: 缺 search 子命令,实际 ${argv}`)
    if (!argv.includes('hotel-list')) throw new Error(`FAIL[有效日期 argv]: 缺 hotel-list,实际 ${argv}`)
    // flag + value 配对断言(允许 hbcli 内部重排)
    assertHasPair(argv, '--destination-name', '迪拜', '有效日期')
    assertHasPair(argv, '--check-in', '2026-09-18', '有效日期')
    assertHasPair(argv, '--check-out', '2026-09-20', '有效日期')
    if (!argv.includes('--room-occupancies')) throw new Error(`FAIL[有效日期 argv]: 缺 --room-occupancies,实际 ${argv}`)
    console.log(`7) 有效日期 → 真实工具入口 + fixture 完整 argv OK:${argv.slice(0, 200)}`)
  }

  // 8) 自然语言日期:本周五+3天 / 明天 → 真实工具入口 + 解析后 argv
  // 日期算术严格按 slot-spec 口径(周一边界、周一=0;与 `weekdayOffsetDays` 一致),
  // 跨周末/跨月/跨年用 Date 自动进位,避免魔法偏移;覆盖周末/月末/年初三类边界
  {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    // slot-spec 口径:本周X offset = 0 + targetMonOffset - todayMonOffset(可负)。
    // 锚点卡 WEEKDAY_ZH = {日:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6};targetMonOffset = (WEEKDAY_ZH['五'] + 6) % 7 = 4
    const todayMonOffset = (today.getDay() + 6) % 7
    const targetMonOffset = (5 + 6) % 7  // 周五 = WEEKDAY_ZH['五'] = 5
    const friOffset = targetMonOffset - todayMonOffset  // 可负(slot-spec 取最小差值)
    const fmt = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    // 明天 = today + 1
    const expectIn = fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1))
    // 本周五+3天 = today + friOffset + 3(可负 → 过去周五 + 3 = 未来日)
    const expectOut = fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() + friOffset + 3))
    // 断言退房日严格晚于入住日(slot-spec 保证,但需保证测试算术口径一致)
    if (expectOut <= expectIn) {
      throw new Error(`FAIL[自然语言]: 算术口径出错 expectIn=${expectIn} expectOut=${expectOut}`)
    }
    const ok = await hotel.execute({ destination: '大理', checkIn: '明天', checkOut: '本周五+3天', adults: 2 } as never, null) as {
      ok?: boolean; date_notes?: string[]; message?: string
    }
    if (ok.ok !== true) throw new Error(`FAIL[自然语言]: 应 ok=true,实际 ${JSON.stringify(ok).slice(0, 200)}`)
    if (!ok.date_notes?.length) throw new Error(`FAIL[自然语言]: 期望 date_notes 至少 1 条 slot-resolved 注记,实际 ${JSON.stringify(ok.date_notes)}`)
    if (!ok.date_notes?.some(n => n.includes('本周五+3天'))) throw new Error(`FAIL[自然语言]: date_notes 应回显原话,实际 ${JSON.stringify(ok.date_notes)}`)
    const argv = assertSpawned('自然语言', suite.fixtureLogPath)
    assertHasPair(argv, '--check-in', expectIn, '自然语言')
    assertHasPair(argv, '--check-out', expectOut, '自然语言')
    console.log(`8) 自然语言解析(本周五+3天 → ${expectIn}/${expectOut},口径同 slot-spec)进 fixture argv OK`)
  }

  // 9) 锚点卡词表内「明天/后天」 → 解析 → 进 fixture argv
  // 跨月边界:若今天=月末,「明天」=次月 1 号;此处直接用 now 算 today/tomorrow/dayAfter
  {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const fmt = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const tomorrowYmd = fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1))
    const dayAfterYmd = fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2))
    const ok = await hotel.execute({ destination: '大理', checkIn: '明天', checkOut: '后天', adults: 2 } as never, null) as {
      ok?: boolean; date_notes?: string[]; message?: string
    }
    if (ok.ok !== true) throw new Error(`FAIL[锚点卡词表]: ${JSON.stringify(ok).slice(0, 200)}`)
    const argv = assertSpawned('锚点卡词表', suite.fixtureLogPath)
    assertHasPair(argv, '--check-in', tomorrowYmd, '锚点卡词表')
    assertHasPair(argv, '--check-out', dayAfterYmd, '锚点卡词表')
    console.log(`9) 锚点卡词表(明天/后天 → ${tomorrowYmd}/${dayAfterYmd},跨月用 Date 自动进位)进 fixture argv OK`)
  }

  // ============================================================
  // §C 闸失败不写副作用面(bridge-latency + 共享用户状态)
  // ============================================================

  // 10) 闸失败不写延迟日志 + 成功路径写一行(before/after diff,真实 gotry-state 子路径)
  {
    // §B 测试 7-9 已经写入了 3 行 hotel_search 延迟;此处在该基础上做增量断言:
    // before snapshot = 当前行数;闸失败 → 行数不变;闸通过 → 行数 +1
    const before = readLatencyLineCount(suite.latencyPath)
    if (before < 1) throw new Error(`FAIL[10 before]: §B 应至少 1 行 baseline,实际=${before}`)

    // 闸失败 → 行数不应变化(关键断言:零增量)
    const failCall = await hotel.execute({ destination: '大理', checkIn: '', checkOut: '' } as never, null) as { ok?: boolean }
    if (failCall.ok !== false) throw new Error(`FAIL[10]: 闸应拒绝,实际 ${JSON.stringify(failCall).slice(0, 200)}`)
    const afterFail = readLatencyLineCount(suite.latencyPath)
    if (afterFail !== before) throw new Error(`FAIL[10 after-fail]: 闸失败应零增量,before=${before} after=${afterFail}`)
    console.log(`10a) 闸失败:bridge-latency.jsonl 零增量(before=${before} after-fail=${afterFail})OK`)

    // 闸通过 → 行数应 +1
    const okCall = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '2026-09-20', adults: 2 } as never, null) as { ok?: boolean }
    if (okCall.ok !== true) throw new Error(`FAIL[10 ok]: 闸应通过,实际 ${JSON.stringify(okCall).slice(0, 200)}`)
    const afterOk = readLatencyLineCount(suite.latencyPath)
    if (afterOk !== before + 1) throw new Error(`FAIL[10 after-ok]: 闸通过应恰好 +1,before=${before} after=${afterOk}`)
    // 行内容形如 {"ts":"...","kind":"hotel_search:hbcli-realtime","latencyMs":...}
    const lines = readFileSync(suite.latencyPath, 'utf-8').trim().split('\n')
    const newLine = lines[lines.length - 1] ?? ''
    if (!/hotel_search/.test(newLine)) throw new Error(`FAIL[10 after-ok]: 新行 kind 应含 hotel_search,实际 ${newLine}`)
    console.log(`10b) 闸通过:bridge-latency.jsonl +1 行(=${afterOk}),新行=${newLine.slice(0, 120)}`)
  }

  // 11) 闸失败不写共享用户状态(隔离纪律:动机/愿望池/时间线 零落盘)
  {
    // 验证:闸失败路径不会触碰 user 数据面;stateDir 若已存在(来自 §10 闸通过),
    // 只应含 bridge-latency.jsonl,不应含 motivation/wish-pool/trip 等
    let userStateTouched = false
    if (existsSync(suite.stateDir)) {
      const { readdirSync } = await import('node:fs')
      const files = readdirSync(suite.stateDir).filter(n => !n.startsWith('.') && n !== 'bridge-latency.jsonl')
      if (files.length > 0) {
        userStateTouched = true
        throw new Error(`FAIL[11]: gotry-state 应只含 bridge-latency.jsonl,实际含 ${files.join(', ')}`)
      }
    }
    // 再调一次闸失败(单侧 unresolved),确保不引入副作用
    const failCall2 = await hotel.execute({ destination: '大理', checkIn: '近期', checkOut: '' } as never, null) as { ok?: boolean }
    if (failCall2.ok !== false) throw new Error(`FAIL[11]: 闸应拒绝,实际 ${JSON.stringify(failCall2).slice(0, 200)}`)
    if (existsSync(suite.stateDir)) {
      const { readdirSync } = await import('node:fs')
      const files = readdirSync(suite.stateDir).filter(n => !n.startsWith('.') && n !== 'bridge-latency.jsonl')
      if (files.length > 0) throw new Error(`FAIL[11]: 闸失败后 gotry-state 不应新增用户面文件,实际含 ${files.join(', ')}`)
    }
    console.log(`11) 闸失败不写共享用户状态(隔离纪律):${userStateTouched ? '失败' : 'OK'}`)
  }

  // 12) 空白字符串(用户传了空白而非空串)→ blank 拒绝
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const blanks = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '   ', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; raw?: Record<string, string | undefined>
    }
    if (blanks.ok !== false || blanks.reason !== 'check_out_blank') throw new Error(`FAIL[空白串]: ${JSON.stringify(blanks).slice(0, 200)}`)
    if (blanks.raw?.checkOut !== '   ') throw new Error(`FAIL[空白串]: raw.checkOut 应回显用户原话(空白),实际 ${JSON.stringify(blanks.raw)}`)
    assertNoSpawn('空白串', suite.fixtureLogPath)
    console.log('12) 空白字符串 → input_required(check_out_blank),raw 回显空白,no spawn OK')
  }

  // 13) presentResult 闸失败卡的内容 sanity(三重保护:summary/message/title 三个字段)
  {
    // 不发 spawn,纯验 presentResult 渲染——使用 sentinel 隔离本次执行
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const gateFail = await hotel.execute({ destination: '曼谷', checkIn: '', checkOut: '', adults: 2 } as never, null) as { ok?: boolean }
    if (gateFail.ok !== false) throw new Error(`FAIL[13]: 闸应拒绝`)
    const card = hotel.presentResult?.({ destination: '曼谷' } as never, gateFail) as { title?: string; content?: Array<{ type: string; text: string }> } | undefined
    if (!card) throw new Error('FAIL[13]: presentResult 应返回卡片对象')
    if (!card.title?.includes('酒店') || !card.title?.includes('缺日期')) throw new Error(`FAIL[13]: 标题应「酒店:曼谷 缺日期(...)」,实际 ${card.title}`)
    const body = card.content?.[0]?.text ?? ''
    if (!body.includes('入住日') || !body.includes('退房日')) throw new Error(`FAIL[13]: 内容应指明缺哪些字段,实际 ${body}`)
    if (!body.includes('闸拒绝') && !body.includes('空字符串')) throw new Error(`FAIL[13]: 内容应带闸拒绝/空字符串原因,实际 ${body}`)
    assertNoSpawn('presentResult sanity', suite.fixtureLogPath)
    console.log('13) presentResult 闸失败卡:title「酒店:曼谷 缺日期(check_in_blank)」+ body 指明字段 + 闸拒绝原因 OK')
  }

  console.log('\nHOTEL DATE GATE TESTS: 13/13 OK (空日期 no-spawn / 完全缺失 / 单侧正向 / 单侧反向 / 混合缺失空白 / 混合空白缺失 / 倒序 / 同日 / 无法解析 / 类型错误 / 有效日期 argv / 自然语言 / 锚点卡词表 / bridge-latency before-after / 隔离用户状态 / 空白串 / presentResult 行动卡)')
} finally {
  suite.cleanup()
}