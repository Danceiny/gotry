/**
 * issue #283 维护测试:`gotry_hotel_search` 在缺/空/单侧/无法解析/倒序/同日/
 * 不存在的日历日日期时,必须返回可行动 input_required,**不得发起 hbcli**;
 * 完整、有效且退房晚于入住的日期经真实 apply 注册入口进入 fixture hbcli,
 * argv 必须含解析后的绝对日期。隔离 stateRoot + 临时 fixture hbcli 在 finally
 * 中清理;没有调用真实 HotelByte、访问凭证或写入共享用户数据。
 *
 * 运行:cd ts && npx tsx scripts/hotel-date-gate-tests.ts
 *
 * 测试纪律:
 *   - fixture hbcli argv 日志初始写 `__NOT_SPAWNED__` 哨兵,任何 spawn 必改写;
 *     `assertSpawned` 显式拒哨兵形态,`assertNoSpawn` 显式要求哨兵未被改写;
 *   - bridge-latency 走真实 `<stateRoot>/gotry-state/bridge-latency.jsonl`(与
 *     ensureStateDir 一致),用 before/after 快照钉死「闸失败 → 零写入」;
 *   - 自然日期回归使用固定 now(2026-09-09 周三),覆盖本周/跨周末/跨月/跨年,
 *     用 slot-spec 同一口径算术(`weekdayOffsetDays`),避开真实时钟周日退化;
 *   - exact argv 断言使用完整 flag + value 字符串,允许不同顺序但每对 flag/value
 *     必出现,不放过「hbcli 收到错误日期」;
 *   - presentResult 渲染层不暴露内部工程词(check_in_blank / 闸拒绝 / ISO 串),
 *     UI 只见「入住日/退房日」+ 具体日期示例。
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
  stateDir: string
  latencyPath: string
  fixturePath: string
  fixtureLogPath: string
  byName: (name: string) => ToolLike
  cleanup: () => void
}

/** 闸未发起 hbcli 时 fixture argv 日志的固定哨兵(非空白字符串!空白也可被 spawn 写入) */
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
    hbcliBin: fixture.path,
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
  if (argv !== NO_SPAWN_SENTINEL) {
    throw new Error(`FAIL[${label}]: 闸失败时 fixture hbcli 不应被调用,但日志被改写: ${argv.slice(0, 200)}`)
  }
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

/** 精确 argv 断言:flag 后紧跟 value(忽略中间 flag 名);flag/value 配对出现即通过 */
function assertHasPair(argv: string, flag: string, value: string, label: string): void {
  const tokens = argv.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === flag && tokens[i + 1] === value) return
  }
  throw new Error(`FAIL[${label} argv]: 期望 ${flag} ${value} 配对出现,实际 ${argv}`)
}

const suite = await bootstrap()
const hotel = suite.byName('gotry_hotel_search')

try {
  // ============================================================
  // §A 闸失败路径(共 N 个反例)—— 必须 no-spawn + 一致的 reason/missing/raw/message/evidence
  // ============================================================

  // 1) 基线反例:空字符串两侧 → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const empty = await hotel.execute({ destination: '迪拜', checkIn: '', checkOut: '', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>
      destination?: string; message?: string; evidence?: string; summary?: string
    }
    if (empty.ok !== false) throw new Error(`FAIL[空日期]: 应 ok=false,实际 ${JSON.stringify(empty).slice(0, 200)}`)
    if (empty.verdict !== 'input_required') throw new Error(`FAIL[空日期]: 应 verdict=input_required,实际 ${empty.verdict}`)
    if (!empty.reason?.startsWith('check_') || !empty.reason.endsWith('_blank')) throw new Error(`FAIL[空日期]: reason 应为 check_*_blank 形态,实际 ${empty.reason}`)
    if (!empty.missing?.includes('checkIn') || !empty.missing?.includes('checkOut')) throw new Error(`FAIL[空日期]: missing 应含 checkIn/checkOut,实际 ${JSON.stringify(empty.missing)}`)
    if (!empty.evidence?.includes('hotel-date-gate')) throw new Error(`FAIL[空日期]: evidence 应带 hotel-date-gate 标注,实际 ${empty.evidence}`)
    if (empty.raw?.checkIn !== '' || empty.raw?.checkOut !== '') throw new Error(`FAIL[空日期]: raw 应回显空串,实际 ${JSON.stringify(empty.raw)}`)
    assertNoSpawn('空日期', suite.fixtureLogPath)
    console.log('1) 空日期 → input_required(check_*_blank),both missing,no spawn OK')
  }

  // 2) 完全缺失(字段未传) → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const missing = await hotel.execute({ destination: '迪拜', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>
      message?: string; evidence?: string
    }
    if (missing.ok !== false || missing.verdict !== 'input_required') throw new Error(`FAIL[缺失]: ${JSON.stringify(missing).slice(0, 200)}`)
    if (!missing.missing?.includes('checkIn') || !missing.missing?.includes('checkOut')) throw new Error(`FAIL[缺失]: missing 应含两侧,实际 ${JSON.stringify(missing.missing)}`)
    if (missing.raw?.checkIn !== undefined || missing.raw?.checkOut !== undefined) throw new Error(`FAIL[缺失]: raw 应全 undefined,实际 ${JSON.stringify(missing.raw)}`)
    assertNoSpawn('完全缺失', suite.fixtureLogPath)
    console.log('2) 完全缺失 → input_required, 两侧 missing, raw=undefined, no spawn OK')
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

  // 3c) 混合(缺失 + 空串)→ 一次报齐两侧(避免两轮往返);原 3c 期望 reason=check_in_missing,
  //     现两侧均报缺(missing 含 checkIn+checkOut),evidence 带 :both
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const mixed = await hotel.execute({ destination: '普吉', checkOut: '', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>; evidence?: string
    }
    if (mixed.ok !== false || mixed.verdict !== 'input_required') throw new Error(`FAIL[混合缺失空白]: ${JSON.stringify(mixed).slice(0, 200)}`)
    if (!mixed.missing?.includes('checkIn') || !mixed.missing?.includes('checkOut')) throw new Error(`FAIL[混合缺失空白]: missing 应含 checkIn+checkOut(一次报齐),实际 ${JSON.stringify(mixed.missing)}`)
    if (!mixed.evidence?.includes(':both')) throw new Error(`FAIL[混合缺失空白]: evidence 应带 :both 标注,实际 ${mixed.evidence}`)
    assertNoSpawn('混合缺失空白', suite.fixtureLogPath)
    console.log('3c) 混合(checkIn 缺 + checkOut 空) → 一次报齐两侧,no spawn OK')
  }

  // 3d) 混合(空串 + 缺失)→ 一次报齐两侧
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const mixed2 = await hotel.execute({ destination: '普吉', checkIn: '', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>; evidence?: string
    }
    if (mixed2.ok !== false || mixed2.verdict !== 'input_required') throw new Error(`FAIL[混合空白缺失]: ${JSON.stringify(mixed2).slice(0, 200)}`)
    if (!mixed2.missing?.includes('checkIn') || !mixed2.missing?.includes('checkOut')) throw new Error(`FAIL[混合空白缺失]: missing 应含 checkIn+checkOut(一次报齐),实际 ${JSON.stringify(mixed2.missing)}`)
    if (mixed2.raw?.checkIn !== '' || mixed2.raw?.checkOut !== undefined) throw new Error(`FAIL[混合空白缺失]: raw 应回显 checkIn 空串+checkOut 缺失,实际 ${JSON.stringify(mixed2.raw)}`)
    if (!mixed2.evidence?.includes(':both')) throw new Error(`FAIL[混合空白缺失]: evidence 应带 :both 标注,实际 ${mixed2.evidence}`)
    assertNoSpawn('混合空白缺失', suite.fixtureLogPath)
    console.log('3d) 混合(checkIn 空 + checkOut 缺) → 一次报齐两侧,no spawn OK')
  }

  // 4) 倒序:退房早于入住 → no spawn
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const reversed = await hotel.execute({ destination: '曼谷', checkIn: '2026-09-20', checkOut: '2026-09-18', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; raw?: Record<string, string | undefined>
      message?: string; evidence?: string
    }
    if (reversed.ok !== false || reversed.verdict !== 'input_required' || reversed.reason !== 'check_out_not_after_check_in') throw new Error(`FAIL[倒序]: ${JSON.stringify(reversed).slice(0, 200)}`)
    if (!reversed.missing?.includes('checkOut')) throw new Error(`FAIL[倒序]: missing 应含 checkOut(指明需更正的一侧),实际 ${JSON.stringify(reversed.missing)}`)
    if (reversed.raw?.checkIn !== '2026-09-20' || reversed.raw?.checkOut !== '2026-09-18') throw new Error(`FAIL[倒序]: raw 应回显原话,实际 ${JSON.stringify(reversed.raw)}`)
    if (!reversed.evidence?.includes(':reversed')) throw new Error(`FAIL[倒序]: evidence 应带 :reversed 子标签,实际 ${reversed.evidence}`)
    assertNoSpawn('倒序', suite.fixtureLogPath)
    console.log('4) 倒序 → input_required(check_out_not_after_check_in:reversed),no spawn OK')
  }

  // 5) 同日:0 晚不查
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const sameDay = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '2026-09-18', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; message?: string; evidence?: string
    }
    if (sameDay.ok !== false || sameDay.reason !== 'check_out_not_after_check_in') throw new Error(`FAIL[同日]: ${JSON.stringify(sameDay).slice(0, 200)}`)
    if (!sameDay.evidence?.includes(':same_day')) throw new Error(`FAIL[同日]: evidence 应带 :same_day 子标签,实际 ${sameDay.evidence}`)
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
    if (!unresolved.message?.includes('合法的具体日期')) throw new Error(`FAIL[无法解析]: message 应明示「合法的具体日期」,实际 ${unresolved.message}`)
    assertNoSpawn('无法解析', suite.fixtureLogPath)
    console.log('6) 无法解析 → input_required(check_in_unresolved),no spawn OK')
  }

  // 6b) 不存在的日历日(2026-02-30 / 2026-13-01)→ 闸拒绝(原闸 1 维护回归反例)
  // issue #283 红线:无效日历日期不能伪装成合法,不发供应商命令
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const invalidDate = await hotel.execute({ destination: '大理', checkIn: '2026-02-30', checkOut: '2026-09-20', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; message?: string; raw?: Record<string, string | undefined>
    }
    if (invalidDate.ok !== false || invalidDate.verdict !== 'input_required') throw new Error(`FAIL[不存在的日历日]: ${JSON.stringify(invalidDate).slice(0, 200)}`)
    if (invalidDate.reason !== 'check_in_unresolved') throw new Error(`FAIL[不存在的日历日]: reason 应为 check_in_unresolved,实际 ${invalidDate.reason}`)
    if (!invalidDate.missing?.includes('checkIn')) throw new Error(`FAIL[不存在的日历日]: missing 应含 checkIn,实际 ${JSON.stringify(invalidDate.missing)}`)
    if (!invalidDate.message?.includes('合法')) throw new Error(`FAIL[不存在的日历日]: message 应明示「合法」,实际 ${invalidDate.message}`)
    if (invalidDate.raw?.checkIn !== '2026-02-30') throw new Error(`FAIL[不存在的日历日]: raw 应回显原话 2026-02-30,实际 ${JSON.stringify(invalidDate.raw)}`)
    assertNoSpawn('不存在的日历日', suite.fixtureLogPath)
    console.log('6b) 不存在的日历日(2026-02-30) → input_required(check_in_unresolved),no spawn OK')
  }

  // 6c) 月份越界(2026-13-01)
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const monthOut = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '2026-13-01', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string
    }
    if (monthOut.ok !== false || monthOut.verdict !== 'input_required' || monthOut.reason !== 'check_out_unresolved') {
      throw new Error(`FAIL[月份越界]: ${JSON.stringify(monthOut).slice(0, 200)}`)
    }
    assertNoSpawn('月份越界', suite.fixtureLogPath)
    console.log('6c) 月份越界(2026-13-01) → input_required(check_out_unresolved),no spawn OK')
  }

  // 6d) 闰年错日(2025-02-29)
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const leap = await hotel.execute({ destination: '大理', checkIn: '2025-02-29', checkOut: '2025-03-02', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string
    }
    if (leap.ok !== false || leap.verdict !== 'input_required' || leap.reason !== 'check_in_unresolved') {
      throw new Error(`FAIL[闰年错日]: ${JSON.stringify(leap).slice(0, 200)}`)
    }
    assertNoSpawn('闰年错日', suite.fixtureLogPath)
    console.log('6d) 闰年错日(2025-02-29) → input_required(check_in_unresolved),no spawn OK')
  }

  // 6e) +N 算术溢出(2026-09-18+100000000)→ 闸拒绝(issue #283 第二层红线)
  // resolveSlotDate 的 addDaysYmd 溢出产生 Invalid Date("NaN-NaN-NaN"),
  // 闸终消费层 isStrictIsoYmd 拒掉非 YYYY-MM-DD 格式,归 unresolved 拒绝发供应商命令
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const bigPlus = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '2026-09-18+100000000', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]
      raw?: Record<string, string | undefined>; message?: string
    }
    if (bigPlus.ok !== false || bigPlus.verdict !== 'input_required') throw new Error(`FAIL[+N 溢出]: ${JSON.stringify(bigPlus).slice(0, 200)}`)
    if (bigPlus.reason !== 'check_out_unresolved') throw new Error(`FAIL[+N 溢出]: reason 应为 check_out_unresolved,实际 ${bigPlus.reason}`)
    if (!bigPlus.missing?.includes('checkOut')) throw new Error(`FAIL[+N 溢出]: missing 应含 checkOut,实际 ${JSON.stringify(bigPlus.missing)}`)
    if (bigPlus.raw?.checkOut !== '2026-09-18+100000000') throw new Error(`FAIL[+N 溢出]: raw 应回显原话,实际 ${JSON.stringify(bigPlus.raw)}`)
    if (!bigPlus.message?.includes('合法')) throw new Error(`FAIL[+N 溢出]: message 应明示「合法」,实际 ${bigPlus.message}`)
    assertNoSpawn('+N 溢出', suite.fixtureLogPath)
    console.log('6e) +N 算术溢出(2026-09-18+100000000 → NaN-NaN-NaN)→ input_required(check_out_unresolved),no spawn OK')
  }

  // 6f) JS 自动进位跨千年(9999-12-31+1 → "10000-01-01")→ 闸拒绝
  // 闸终消费层 isStrictIsoYmd 拒掉 5 位数年份(> 9999),归 unresolved
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const year10k = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '9999-12-31+1', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; raw?: Record<string, string | undefined>
    }
    if (year10k.ok !== false || year10k.verdict !== 'input_required') throw new Error(`FAIL[跨千年]: ${JSON.stringify(year10k).slice(0, 200)}`)
    if (year10k.reason !== 'check_out_unresolved') throw new Error(`FAIL[跨千年]: reason 应为 check_out_unresolved,实际 ${year10k.reason}`)
    if (year10k.raw?.checkOut !== '9999-12-31+1') throw new Error(`FAIL[跨千年]: raw 应回显原话,实际 ${JSON.stringify(year10k.raw)}`)
    assertNoSpawn('跨千年', suite.fixtureLogPath)
    console.log('6f) JS 自动进位跨千年(9999-12-31+1 → 10000-01-01)→ input_required(check_out_unresolved),no spawn OK')
  }

  // 7) 类型错误:非字符串入参(直接测闸函数)→ 闸降级为 *_blank:type
  {
    const { evaluateHotelStayDates } = await import('../src/hotel-date-gate.ts')
    const typeErr = evaluateHotelStayDates(42 as unknown as string, '2026-09-20') as {
      ok?: boolean; verdict?: string; reason?: string; missing?: string[]; message?: string; evidence?: string; raw?: Record<string, string | undefined>
    }
    if (typeErr.ok !== false || typeErr.reason !== 'check_in_blank') throw new Error(`FAIL[类型错误]: ${JSON.stringify(typeErr).slice(0, 200)}`)
    if (!typeErr.missing?.includes('checkIn')) throw new Error(`FAIL[类型错误]: missing 应含 checkIn,实际 ${JSON.stringify(typeErr.missing)}`)
    if (!typeErr.evidence?.includes(':type')) throw new Error(`FAIL[类型错误]: evidence 应带 :type 标注,实际 ${typeErr.evidence}`)
    if (typeErr.raw?.checkIn !== undefined) throw new Error(`FAIL[类型错误]: raw.checkIn 应为 undefined(非字符串不入 raw),实际 ${JSON.stringify(typeErr.raw)}`)
    console.log('7) 类型错误(数字 checkIn) → 闸函数直接 input_required(check_in_blank:type),raw undefined OK')
  }

  // ============================================================
  // §B 闸通过路径 —— 必须真实 spawn + fixture argv 含精确日期
  // ============================================================

  // 8) 有效日期(绝对 ISO) → 真实工具入口 → fixture hbcli 收到精确 argv
  {
    const ok = await hotel.execute({ destination: '迪拜', checkIn: '2026-09-18', checkOut: '2026-09-20', adults: 2 } as never, null) as {
      ok?: boolean; hotels?: unknown; summary?: string; date_notes?: string[]
    }
    if (ok.ok !== true) throw new Error(`FAIL[有效日期]: 应 ok=true,实际 ${JSON.stringify(ok).slice(0, 200)}`)
    if (ok.date_notes && ok.date_notes.length) throw new Error(`FAIL[有效日期]: 绝对 ISO 不应产生 slot-resolved note,实际 ${JSON.stringify(ok.date_notes)}`)
    const argv = assertSpawned('有效日期', suite.fixtureLogPath)
    if (!argv.includes('search')) throw new Error(`FAIL[有效日期 argv]: 缺 search 子命令,实际 ${argv}`)
    if (!argv.includes('hotel-list')) throw new Error(`FAIL[有效日期 argv]: 缺 hotel-list,实际 ${argv}`)
    assertHasPair(argv, '--destination-name', '迪拜', '有效日期')
    assertHasPair(argv, '--check-in', '2026-09-18', '有效日期')
    assertHasPair(argv, '--check-out', '2026-09-20', '有效日期')
    if (!argv.includes('--room-occupancies')) throw new Error(`FAIL[有效日期 argv]: 缺 --room-occupancies,实际 ${argv}`)
    console.log(`8) 有效日期 → 真实工具入口 + fixture 完整 argv OK:${argv.slice(0, 200)}`)
  }

  // 9) 自然语言日期 slot-spec 口径:固定时钟 2026-09-09(周三)+ 锚点卡词表「明天/下周五+3天」
  // 闸函数直接调,注入 fixed now;真实 execute 路径见 10(避免真实时钟周日退化撞 same_day)
  // 固定 now 保证 todayDow=3,「下周五」= today+9(不会退化到 today+0 撞 same_day)
  {
    const fixedNow = new Date(2026, 8, 9)  // 2026-09-09(本地时区,周三)
    const { evaluateHotelStayDates } = await import('../src/hotel-date-gate.ts')
    const probe = evaluateHotelStayDates('明天', '下周五+3天', { now: fixedNow }) as
      { ok?: boolean; checkIn?: string; checkOut?: string; notes?: string[] }
    if (probe.ok !== true) throw new Error(`FAIL[自然语言预演]: 闸应通过,实际 ${JSON.stringify(probe).slice(0, 200)}`)
    // 明天 = today + 1 = 2026-09-10;下周五 = today + 9 = 2026-09-18;+3 天 = 2026-09-21
    if (probe.checkIn !== '2026-09-10' || probe.checkOut !== '2026-09-21') {
      throw new Error(`FAIL[自然语言预演]: 期望 checkIn=2026-09-10 checkOut=2026-09-21,实际 ${probe.checkIn}/${probe.checkOut}`)
    }
    console.log('9) 自然语言(明天/下周五+3天 → 2026-09-10/2026-09-21,固定时钟周三 2026-09-09,slot-spec 口径)闸预演 OK')
  }

  // 10) 真实 execute + 自然语言(真实时钟):下个月初/下个月中旬
  // 不管今天是几号,「下个月初」必然是下月 1 号、「下个月中旬」必然是下月 11 号,
  // 退房永远晚于入住,不撞 same_day;跨月/跨年用 Date 自动进位(同 slot-spec 口径)
  // 计算期望:以真实 today 出发,「下个月初」= (today 年/月+1)/01;「下个月中旬」= (today 年/月+1)/11
  {
    const realNow = new Date()
    const nextMonthFirst = new Date(realNow.getFullYear(), realNow.getMonth() + 1, 1)
    const nextMonthMid = new Date(realNow.getFullYear(), realNow.getMonth() + 1, 11)
    const fmt = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const expectIn = fmt(nextMonthFirst)
    const expectOut = fmt(nextMonthMid)
    if (expectOut <= expectIn) throw new Error(`FAIL[锚点卡跨月]: 算术口径出错 expectIn=${expectIn} expectOut=${expectOut}`)
    const ok = await hotel.execute({ destination: '大理', checkIn: '下个月初', checkOut: '下个月中旬', adults: 2 } as never, null) as {
      ok?: boolean; date_notes?: string[]
    }
    if (ok.ok !== true) throw new Error(`FAIL[锚点卡跨月]: 应 ok=true,实际 ${JSON.stringify(ok).slice(0, 200)}`)
    const argv = assertSpawned('锚点卡跨月', suite.fixtureLogPath)
    assertHasPair(argv, '--check-in', expectIn, '锚点卡跨月')
    assertHasPair(argv, '--check-out', expectOut, '锚点卡跨月')
    console.log(`10) 真实 execute + 锚点卡跨月(下个月初/下个月中旬 → ${expectIn}/${expectOut},用 Date 自动进位)进 fixture argv OK`)
  }

  // ============================================================
  // §C 闸失败不写副作用面(bridge-latency + 共享用户状态)
  // ============================================================

  // 11) 闸失败不写延迟日志 + 成功路径写一行(before/after diff,真实 gotry-state 子路径)
  {
    const before = readLatencyLineCount(suite.latencyPath)
    if (before < 1) throw new Error(`FAIL[11 before]: §B 应至少 1 行 baseline,实际=${before}`)

    const failCall = await hotel.execute({ destination: '大理', checkIn: '', checkOut: '' } as never, null) as { ok?: boolean }
    if (failCall.ok !== false) throw new Error(`FAIL[11]: 闸应拒绝,实际 ${JSON.stringify(failCall).slice(0, 200)}`)
    const afterFail = readLatencyLineCount(suite.latencyPath)
    if (afterFail !== before) throw new Error(`FAIL[11 after-fail]: 闸失败应零增量,before=${before} after=${afterFail}`)
    console.log(`11a) 闸失败:bridge-latency.jsonl 零增量(before=${before} after-fail=${afterFail})OK`)

    const okCall = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '2026-09-20', adults: 2 } as never, null) as { ok?: boolean }
    if (okCall.ok !== true) throw new Error(`FAIL[11 ok]: 闸应通过,实际 ${JSON.stringify(okCall).slice(0, 200)}`)
    const afterOk = readLatencyLineCount(suite.latencyPath)
    if (afterOk !== before + 1) throw new Error(`FAIL[11 after-ok]: 闸通过应恰好 +1,before=${before} after=${afterOk}`)
    const lines = readFileSync(suite.latencyPath, 'utf-8').trim().split('\n')
    const newLine = lines[lines.length - 1] ?? ''
    if (!/hotel_search/.test(newLine)) throw new Error(`FAIL[11 after-ok]: 新行 kind 应含 hotel_search,实际 ${newLine}`)
    console.log(`11b) 闸通过:bridge-latency.jsonl +1 行(=${afterOk}),新行=${newLine.slice(0, 120)}`)
  }

  // 12) 闸失败不写共享用户状态(隔离纪律:动机/愿望池/时间线 零落盘)
  {
    let userStateTouched = false
    if (existsSync(suite.stateDir)) {
      const { readdirSync } = await import('node:fs')
      const files = readdirSync(suite.stateDir).filter(n => !n.startsWith('.') && n !== 'bridge-latency.jsonl')
      if (files.length > 0) {
        userStateTouched = true
        throw new Error(`FAIL[12]: gotry-state 应只含 bridge-latency.jsonl,实际含 ${files.join(', ')}`)
      }
    }
    const failCall2 = await hotel.execute({ destination: '大理', checkIn: '近期', checkOut: '' } as never, null) as { ok?: boolean }
    if (failCall2.ok !== false) throw new Error(`FAIL[12]: 闸应拒绝,实际 ${JSON.stringify(failCall2).slice(0, 200)}`)
    if (existsSync(suite.stateDir)) {
      const { readdirSync } = await import('node:fs')
      const files = readdirSync(suite.stateDir).filter(n => !n.startsWith('.') && n !== 'bridge-latency.jsonl')
      if (files.length > 0) throw new Error(`FAIL[12]: 闸失败后 gotry-state 不应新增用户面文件,实际含 ${files.join(', ')}`)
    }
    console.log(`12) 闸失败不写共享用户状态(隔离纪律):${userStateTouched ? '失败' : 'OK'}`)
  }

  // 13) 空白字符串(用户传了空白而非空串)→ blank 拒绝
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const blanks = await hotel.execute({ destination: '大理', checkIn: '2026-09-18', checkOut: '   ', adults: 2 } as never, null) as {
      ok?: boolean; verdict?: string; reason?: string; raw?: Record<string, string | undefined>
    }
    if (blanks.ok !== false || blanks.reason !== 'check_out_blank') throw new Error(`FAIL[空白串]: ${JSON.stringify(blanks).slice(0, 200)}`)
    if (blanks.raw?.checkOut !== '   ') throw new Error(`FAIL[空白串]: raw.checkOut 应回显用户原话(空白),实际 ${JSON.stringify(blanks.raw)}`)
    assertNoSpawn('空白串', suite.fixtureLogPath)
    console.log('13) 空白字符串 → input_required(check_out_blank),raw 回显空白,no spawn OK')
  }

  // 14) presentResult 闸失败卡:用户可行动中文 + 不暴露内部工程词
  {
    resetNoSpawnSentinel(suite.fixtureLogPath)
    const gateFail = await hotel.execute({ destination: '曼谷', checkIn: '', checkOut: '', adults: 2 } as never, null) as { ok?: boolean }
    if (gateFail.ok !== false) throw new Error(`FAIL[14]: 闸应拒绝`)
    const card = hotel.presentResult?.({ destination: '曼谷' } as never, gateFail) as { title?: string; content?: Array<{ type: string; text: string }> } | undefined
    if (!card) throw new Error('FAIL[14]: presentResult 应返回卡片对象')
    if (!card.title?.includes('酒店') || !card.title?.includes('曼谷')) throw new Error(`FAIL[14]: 标题应含「酒店:曼谷」,实际 ${card.title}`)
    if (card.title?.includes('check_') || card.title?.includes('闸拒')) throw new Error(`FAIL[14]: 标题不应暴露工程词,实际 ${card.title}`)
    const body = card.content?.[0]?.text ?? ''
    if (!body.includes('入住日') || !body.includes('退房日')) throw new Error(`FAIL[14]: 内容应指明需补哪些字段,实际 ${body}`)
    if (!body.includes('2026-09-18') && !body.includes('2026-09-20')) throw new Error(`FAIL[14]: 内容应给具体日期示例,实际 ${body}`)
    if (body.includes('闸拒') || body.includes('check_') || body.includes('ISO')) throw new Error(`FAIL[14]: 内容不应暴露工程词,实际 ${body}`)
    assertNoSpawn('presentResult sanity', suite.fixtureLogPath)
    console.log('14) presentResult 闸失败卡:title「酒店:曼谷 需要入住日和退房日」+ body 给具体日期示例,无工程词 OK')
  }

  console.log('\nHOTEL DATE GATE TESTS: 16/16 OK')
} finally {
  suite.cleanup()
}
