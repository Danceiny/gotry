/**
 * Issue #436 — 持久本地通道健康 → 真实路由建议(注册工具结果路径 E2E)。
 *
 * 真实执行面:在隔离临时 stateRoot 下 `apply(ctx, config, { effect })` 装载
 * gotry-tools 插件,取注册定义 `gotry_flyai_search` / `gotry_session_search` 的
 * execute 直接调用(与本仓库既有 registered-e2e 同构),断言工具结果里的 routing
 * 字段。持久健康事件由**独立子进程**写的 fixture 探针 tick 产生——子进程走真实
 * `evaluateProbeResults` + `recordChannelEvent`(channel-probe.ts 的映射与落盘),
 * 因此父进程里没有任何该通道的会话态:排除只能来自持久面读回。
 *
 * 覆盖(镜像 issue #436 验收面):
 *  1. 基线:无持久事件 → 非 hit 的 gotry_flyai_search 建议表含 session:ctrip-flight;
 *  2. 跨进程生产者写 down → 父进程 readLatestChannelEvents 读回 latest=down(证据);
 *  3. 产品结果:同一注册工具再调用 → 建议表排除 session:ctrip-flight(本进程会话态为空);
 *  4. 非会话通道:hbcli-hotel 持久 down → 酒店建议表排除它,同意图其余通道不动;
 *  5. 会话优先级:进程内会话失败 + 跨进程 'ok' 恢复事件 → 仍排除(持久恢复不解除会话失败);
 *  6. 恢复:产品路径 hit(gotry_session_search 注入 hit)→ 会话清除,持久 latest=ok → 通道回到建议表;
 *  7. 独立根:另一个 root 无事件 → 不受 root A 的 down 影响;
 *  8. 过期:40 天前 down(读方既有 limitDays 保留期)→ 不压制通道;
 *  9. 畸形行 / 未来时间戳各自独立不压制通道(两次独立写入,互不覆盖);
 *  9c. 有效 down 之后跟未来/缺/坏时间戳行 → 坏行不得顶掉有效 down(评审反例回归);
 *  9d. 保留期内的有效 ok 仍是恢复事件(latest-wins 不变);
 * 10. 同根追加新鲜 down → 再次排除(读回+投影在同一根内可重复)。
 *
 * 断言全部落在**注册工具结果**上;注入的 effect 夹具按产品真实操作标签登记
 * (FLYAI_SEARCH / SESSION_FLIGHT_SEARCH),并记录实际被请求的标签以防夹具错位。
 * 无网络、无供应商/浏览器调用、无真实 stateRoot 访问:全部临时根。
 *
 * 运行(在 ts/ 下):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/issue436-persisted-routing-e2e.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { makeMockInterpreter, type EffectInterpreter } from '../capabilities/effect.ts'
import { channelState, noteChannelVerdict, readLatestChannelEvents, resetChannelHealth } from '../capabilities/channel-health.ts'

const TS_ROOT = join(import.meta.dirname, '..')
const FUTURE_DATE = '2027-07-17'
const PRODUCER_TIMEOUT_MS = 60_000

interface ToolDef {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface RoutingView {
  verdict?: string
  routing?: { intent?: string; alternatives?: Array<{ channel?: string; tool?: string }> }
}

/** 产品真实操作标签 → 注入 observation(标签名与 capabilities/effect.ts 注册一致)。 */
const FIXTURES: Record<string, unknown> = {
  FLYAI_SEARCH: {
    ok: true, via: 'flyai', evidence: '[实时API:flyai@ts] 夹具回放:0 条', latencyMs: 1,
    verdict: 'miss', kind: 'flight',
  },
  SESSION_FLIGHT_SEARCH: {
    ok: true, via: 'session', evidence: '[会话:ctrip-flight@ts] 夹具回放:1 条', latencyMs: 1,
    verdict: 'hit', kind: 'flight',
    options: [{ flightNo: 'MU5101', airline: '东方航空', depDateTime: '2027-07-17T08:00:00', arrDateTime: '2027-07-17T10:30:00', price: 1280 }],
  },
}

/** 记录实际被请求的 effect 标签:证明走的是产品注册调用点,而不是夹具自证。 */
const requestedEffects: string[] = []
const recordingInterpreter: EffectInterpreter = async (fx) => {
  requestedEffects.push(fx.effect)
  return await makeMockInterpreter(FIXTURES)(fx)
}

function loadTools(stateRoot: string): Map<string, ToolDef> {
  assert.ok(stateRoot.startsWith(tmpdir()), 'stateRoot 必须是隔离临时根(绝不触真实 stateRoot)')
  const registered: ToolDef[] = []
  const ctx = {
    tools: { register: (t: unknown) => { registered.push(t as ToolDef) } },
    systemPrompt: { variable: () => { /* 本测试不消费 persona 变量 */ } },
    on: () => () => { /* 授权闸/守卫注册即忽略:execute 直调不走 pre-execute */ },
  } as unknown as Context
  apply(ctx, { stateRoot, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'ask' } as never, {
    effect: recordingInterpreter as never,
  })
  return new Map(registered.map(t => [t.name, t]))
}

/** tsx CLI 文件(直接以 process.execPath 启动,不经 npx/shell 孙进程)。 */
function resolveTsxCli(): string {
  const req = createRequire(join(TS_ROOT, 'package.json'))
  const pkgPath = req.resolve('tsx/package.json')
  const binField = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { bin?: string | { tsx?: string } }).bin
  const bin = typeof binField === 'string' ? binField : binField?.tsx
  assert.ok(bin, 'tsx package.json 必须有 bin 入口')
  return join(dirname(pkgPath), bin)
}

/**
 * fixture 探针 tick(子进程执行):镜像 channel-probe.ts 的映射与落盘——
 * readLatestChannelEvents → evaluateProbeResults → recordChannelEvent。
 */
function writeProducer(producerPath: string): void {
  const health = pathToFileURL(join(TS_ROOT, 'capabilities', 'channel-health.ts')).href
  const probe = pathToFileURL(join(TS_ROOT, 'scripts', 'channel-probe.ts')).href
  writeFileSync(producerPath, [
    `import { readLatestChannelEvents, recordChannelEvent } from ${JSON.stringify(health)}`,
    `import { evaluateProbeResults } from ${JSON.stringify(probe)}`,
    `const [stateRoot, channel, mode, reason] = process.argv.slice(2)`,
    `const prior = await readLatestChannelEvents(stateRoot)`,
    `const priorDown = new Set([...prior].filter(([, ev]) => ev.state === 'down' || ev.state === 'cooldown').map(([ch]) => ch))`,
    `const result = mode === 'down' ? { ok: false, reason, ms: 1 } : { ok: true, ms: 1 }`,
    `const events = evaluateProbeResults([{ probe: { channel, probeable: true, run: async () => result }, result }], priorDown)`,
    `for (const ev of events) await recordChannelEvent(stateRoot, ev)`,
    `console.log(JSON.stringify(events))`,
  ].join('\n'), 'utf-8')
}

/** 子进程生产一批持久事件;返回子进程实际落盘的事件(证据)。带上限超时 + SIGKILL 兜底。 */
function runProbeChild(tsxCli: string, producerPath: string, stateRoot: string, channel: string, mode: 'down' | 'ok', reason = 'fixture'): unknown[] {
  const res = spawnSync(process.execPath, [tsxCli, producerPath, stateRoot, channel, mode, reason], {
    cwd: TS_ROOT, encoding: 'utf-8', timeout: PRODUCER_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  })
  assert.ok(!res.error, `探针子进程不得超时/启动失败:${res.error instanceof Error ? res.error.message : res.error}`)
  assert.equal(res.status, 0, `探针子进程必须成功退出:status=${res.status} signal=${res.signal} stderr=${res.stderr}`)
  return JSON.parse(res.stdout.trim()) as unknown[]
}

const channels = (r: RoutingView): string[] => (r.routing?.alternatives ?? []).map(a => a.channel ?? '')

async function searchFlight(tools: Map<string, ToolDef>): Promise<RoutingView> {
  return await tools.get('gotry_flyai_search')!.execute(
    { kind: 'flight', from: '深圳', to: '普吉', date: FUTURE_DATE }, null) as RoutingView
}

async function searchHotel(tools: Map<string, ToolDef>): Promise<RoutingView> {
  return await tools.get('gotry_flyai_search')!.execute({ kind: 'hotel', to: '大理' }, null) as RoutingView
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gotry-436-persisted-routing-'))
  const rootA = join(home, 'state-a')
  const rootB = join(home, 'state-b')
  const producerPath = join(home, 'fixture-probe-tick.mts')
  const tsxCli = resolveTsxCli()
  writeProducer(producerPath)

  try {
    const toolsA = loadTools(rootA)
    const msgs: string[] = []

    // 1. 基线:无持久事件 → session:ctrip-flight 在建议表内(flyai 是发起通道,被排除)
    const base = await searchFlight(toolsA)
    assert.equal(base.verdict, 'miss', '夹具=飞猪非 hit')
    assert.ok(channels(base).includes('session:ctrip-flight'), '基线:无持久 down 时 session 通道在建议表内')
    assert.ok(!channels(base).includes('flyai'), '发起通道仍被排除')
    assert.equal(channelState('session:ctrip-flight'), undefined, '基线:本进程无该通道会话态')
    msgs.push(`1. 基线 OK (${channels(base).join(',')})`)

    // 2. 跨进程生产:fixture 探针 tick 写 down
    const produced = runProbeChild(tsxCli, producerPath, rootA, 'session:ctrip-flight', 'down', 'challenged')
    assert.equal(produced.length, 1, '子进程写出 1 条 down 事件')
    const ev0 = produced[0] as { channel?: string; state?: string; reason?: string }
    assert.equal(ev0.channel, 'session:ctrip-flight')
    assert.equal(ev0.state, 'down')
    assert.equal(ev0.reason, 'challenged')
    const readBack = await readLatestChannelEvents(rootA)
    assert.equal(readBack.get('session:ctrip-flight')?.state, 'down', '父进程读回 latest=down(跨进程生产者→读者)')
    msgs.push(`2. 跨进程生产者 OK (state=${readBack.get('session:ctrip-flight')?.state})`)

    // 3. 产品结果:注册工具的非 hit 结果排除持久 down 通道(本进程会话态仍为空)
    const afterPersistedDown = await searchFlight(toolsA)
    assert.equal(channelState('session:ctrip-flight'), undefined, '排除不可能来自会话态(仍是空)')
    assert.ok(!channels(afterPersistedDown).includes('session:ctrip-flight'), '持久 down → 工具结果 routing 排除该通道')
    assert.ok(channels(afterPersistedDown).includes('web-read'), '同意图其余通道不受影响')
    msgs.push(`3. 注册工具结果排除持久 down OK (${channels(afterPersistedDown).join(',')})`)

    // 4. 非会话通道同样生效(hotel 意图,hbcli-hotel 无会话态可言)
    runProbeChild(tsxCli, producerPath, rootA, 'hbcli-hotel', 'down', 'auth-denied')
    const hotel = await searchHotel(toolsA)
    assert.equal(hotel.verdict, 'miss', '酒店夹具=非 hit')
    assert.ok(!channels(hotel).includes('hbcli-hotel'), '持久 down 的非会话通道被排除')
    assert.ok(channels(hotel).includes('session:ctrip-hotel'), '同意图其余通道保留')
    msgs.push(`4. 非会话通道持久 down OK (${channels(hotel).join(',')})`)

    // 5. 会话优先级:进程内会话失败 + 跨进程 'ok' 恢复事件 → 仍排除
    noteChannelVerdict('session:ctrip-flight', 'challenged')
    assert.equal(channelState('session:ctrip-flight')?.state, 'down', '会话态已 down(产品 noteChannel 入口)')
    runProbeChild(tsxCli, producerPath, rootA, 'session:ctrip-flight', 'ok')
    assert.equal((await readLatestChannelEvents(rootA)).get('session:ctrip-flight')?.state, 'ok', '持久 latest 已是恢复事件')
    const sessionWins = await searchFlight(toolsA)
    assert.ok(!channels(sessionWins).includes('session:ctrip-flight'), '持久 ok 不能解除本会话刚发生的失败')
    assert.equal(channelState('session:ctrip-flight')?.state, 'down', '会话态未被持久面改写')
    msgs.push(`5. 会话优先级 OK (${channels(sessionWins).join(',')})`)

    // 6. 恢复:产品路径 hit 清会话态;持久 latest=ok → 通道回到建议表
    const hit = await toolsA.get('gotry_session_search')!.execute(
      { kind: 'flight', from: '深圳', to: '普吉', date: FUTURE_DATE }, null) as RoutingView
    assert.equal(hit.verdict, 'hit', '会话工具夹具=hit')
    assert.equal(channelState('session:ctrip-flight'), undefined, 'hit 即清除会话态')
    const recovered = await searchFlight(toolsA)
    assert.ok(channels(recovered).includes('session:ctrip-flight'), '会话清除 + 持久 ok → 通道恢复进建议表')
    msgs.push(`6. 恢复 OK (${channels(recovered).join(',')})`)

    // 夹具错位防护:注册工具真实请求过的标签必须都在预期集合内(无 unknown-effect 退化)
    assert.ok(requestedEffects.includes('FLYAI_SEARCH'), 'FLYAI_SEARCH 走产品注册调用点')
    assert.ok(requestedEffects.includes('SESSION_FLIGHT_SEARCH'), 'SESSION_FLIGHT_SEARCH 走产品注册调用点')
    for (const tag of requestedEffects) assert.ok(tag in FIXTURES, `未登记夹具的效应标签=${tag}`)
    msgs.push(`6b. 效应标签真实 OK (${[...new Set(requestedEffects)].join(',')})`)

    // 7. 独立根:rootB 无任何事件 → 不受 rootA 影响
    const toolsB = loadTools(rootB)
    const rootBFresh = await searchFlight(toolsB)
    assert.ok(channels(rootBFresh).includes('session:ctrip-flight'), '独立根无事件 → 不排除(不串根)')
    msgs.push('7. 独立根隔离 OK')

    // 8. 过期:40 天前 down 落在读方既有保留期外 → 不压制
    const expiredAt = new Date(Date.now() - 40 * 86_400_000).toISOString()
    mkdirSync(join(rootB, 'gotry-state'), { recursive: true })
    const rawPath = join(rootB, 'gotry-state', 'channel-health.jsonl')
    writeFileSync(rawPath, `${JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'stale', at: expiredAt })}\n`, 'utf-8')
    const afterExpired = await searchFlight(toolsB)
    assert.ok(channels(afterExpired).includes('session:ctrip-flight'), '过期(limitDays 外)down 不压制通道')
    msgs.push('8. 过期事件不压制 OK')

    // 9a. 未来时间戳(独立写入,文件内只有这一条)
    const futureAt = new Date(Date.now() + 86_400_000).toISOString()
    writeFileSync(rawPath, `${JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'clock-skew', at: futureAt })}\n`, 'utf-8')
    const afterFuture = await searchFlight(toolsB)
    assert.ok(channels(afterFuture).includes('session:ctrip-flight'), '未来时间戳 down 不压制通道')
    msgs.push('9a. 未来时间戳不压制 OK')

    // 9b. 畸形输入(坏 JSON 行 + 缺时间戳事件,各自独立文件状态)
    writeFileSync(rawPath, `${JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'no-at' })}\nnot-json\n{"half":true}\n`, 'utf-8')
    const afterNoAt = await searchFlight(toolsB)
    assert.ok(channels(afterNoAt).includes('session:ctrip-flight'), '缺时间戳 down 不压制通道')
    writeFileSync(rawPath, 'not-json\n{"half":true}\n', 'utf-8')
    const afterGarbage = await searchFlight(toolsB)
    assert.ok(channels(afterGarbage).includes('session:ctrip-flight'), '纯坏行文件不压制通道(读方容忍)')
    msgs.push('9b. 畸形输入不压制 OK')

    // 9c. 有效 down 之后跟不可用时间戳的行:坏行不得在 latest-wins 覆盖前顶掉有效 down(评审反例)
    const validDownRow = JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'challenged', at: new Date(Date.now() - 60_000).toISOString() })
    const unusableRows: Array<[string, string]> = [
      ['未来 down', JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'clock-skew', at: futureAt })],
      ['未来 ok', JSON.stringify({ channel: 'session:ctrip-flight', state: 'ok', at: futureAt })],
      ['缺时间戳 ok', JSON.stringify({ channel: 'session:ctrip-flight', state: 'ok' })],
      ['坏时间戳 down', JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'bad-at', at: 'not-a-date' })],
      ['过期 down', JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'stale', at: expiredAt })],
    ]
    for (const [label, badRow] of unusableRows) {
      writeFileSync(rawPath, `${validDownRow}\n${badRow}\n`, 'utf-8')
      const r = await searchFlight(toolsB)
      assert.ok(!channels(r).includes('session:ctrip-flight'), `有效 down 之后的${label}行不得顶掉它`)
      assert.equal((await readLatestChannelEvents(rootB, { requireValidTimestamp: true })).get('session:ctrip-flight')?.state, 'down',
        `严格读取口径下 latest 仍是有效 down(${label})`)
    }
    msgs.push('9c. 有效 down 不被后续坏时间戳行顶掉 OK')

    // 9d. 保留期内的有效 ok 仍是恢复事件(latest-wins 语义不变)
    writeFileSync(rawPath, `${validDownRow}\n${JSON.stringify({ channel: 'session:ctrip-flight', state: 'ok', at: new Date(Date.now() - 30_000).toISOString() })}\n`, 'utf-8')
    const afterValidRecovery = await searchFlight(toolsB)
    assert.ok(channels(afterValidRecovery).includes('session:ctrip-flight'), '有效 ok 恢复事件仍能把通道放回建议表')
    msgs.push('9d. 有效恢复事件恢复 OK')

    // 10. 同根追加新鲜 down → 再次排除(读回+投影可重复)
    writeFileSync(rawPath, `${JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'fresh', at: new Date().toISOString() })}\n`, 'utf-8')
    const afterFresh = await searchFlight(toolsB)
    assert.ok(!channels(afterFresh).includes('session:ctrip-flight'), '新鲜 down 在同一根内再次排除')
    msgs.push('10. 同根重复生效 OK')

    for (const m of msgs) console.log(m)
    console.log('issue436-persisted-routing-e2e: 全部通过')
  } finally {
    resetChannelHealth()
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[issue436-e2e] fatal:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
