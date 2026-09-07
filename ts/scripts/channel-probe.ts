/**
 * 通道探针 tick(外部事件接缝落地第 1 段,docs/design/external-event-seam.md §6①;
 * issue #82 兼容方向)——外部事件作为健康面第二个生产者的本地形态。
 *
 * 设计边界(设计文档 §4,边界即信任):
 *  - 只读探测:每通道一个无副作用最小调用(whoami/免费公开 GET),不检索、不下单;
 *  - 本地生产者免鉴权(§3.2 本地可信):异常写 `down` 事件进
 *    <stateRoot>/gotry-state/channel-health.jsonl,routingAdvice/doctor 零改动受益;
 *  - 恢复走事件:探测通过且该通道此前处于 down → 写 'ok' 恢复事件
 *    (readLatestChannelEvents latest-wins 超越 down);此前健康则零写放大;
 *  - session:* 通道(需用户 Chrome 会话)无头不可探,显式 skip 不误报;
 *  - flyai 默认不探(匿名共享额度,探针烧额度弊大于利)——`--only flyai` 显式选入;
 *  - 不做常驻监听:tick 由 loopx/cron 驱动,一次运行一轮探测后退出。
 *
 * 用法(loopx/cron 驱动):
 *   npx tsx ts/scripts/channel-probe.ts --state-root <root>            # 探测+落账
 *   npx tsx ts/scripts/channel-probe.ts --dry-run                      # 只打印不落账
 *   npx tsx ts/scripts/channel-probe.ts --only hbcli-hotel,open-meteo  # 选通道
 *   npx tsx ts/scripts/channel-probe.ts --list                         # 列探测面
 *
 * @module scripts/channel-probe
 */

import { recordChannelEvent, readLatestChannelEvents, type ChannelEvent } from '../capabilities/channel-health.ts'

export interface ProbeOutcome {
  ok: true
  /** 探测耗时 ms(仅日志用) */
  ms: number
}

export interface ProbeFailure {
  ok: false
  /** 小写连字符原因(如 rate-limited / unreachable / auth-denied / timeout) */
  reason: string
  ms: number
}

export type ProbeResult = ProbeOutcome | ProbeFailure

export type ChannelProbe = {
  channel: string
  /** 无头可探=true 才会进默认探测面;session:* 面显式 false 并给 skip 原因 */
  probeable: boolean
  /** 不可探/不默认探的人话原因 */
  skipReason?: string
  run: () => Promise<ProbeResult>
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

async function fetchOk(url: string, what: string, ms = 8000): Promise<ProbeResult> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: timeout(ms), headers: { Accept: 'application/json' } })
    if (res.ok) return { ok: true, ms: Date.now() - t0 }
    return { ok: false, reason: `${what}-http-${res.status}`, ms: Date.now() - t0 }
  } catch (err) {
    const msg = err instanceof Error ? err.name : String(err)
    return { ok: false, reason: msg === 'TimeoutError' ? 'timeout' : 'unreachable', ms: Date.now() - t0 }
  }
}

function spawnOk(cmd: string, args: string[], what: string, ms = 10000): () => Promise<ProbeResult> {
  return async (): Promise<ProbeResult> => {
    const t0 = Date.now()
    try {
      const { spawn } = await import('node:child_process')
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] })
      const code = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')) }, ms)
        child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 1) })
        child.on('error', (e) => { clearTimeout(timer); reject(e) })
      })
      return code === 0 ? { ok: true, ms: Date.now() - t0 } : { ok: false, reason: `${what}-exit-${code}`, ms: Date.now() - t0 }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: msg === 'timeout' ? 'timeout' : 'spawn-failed', ms: Date.now() - t0 }
    }
  }
}

/** 默认探测面(设计文档 §6①「关键通道」的无头子集;session 系与 flyai 显式 skip) */
export function defaultProbes(): ChannelProbe[] {
  return [
    {
      channel: 'hbcli-hotel',
      probeable: true,
      run: spawnOk('hbcli', ['auth', 'whoami'], 'auth-denied'),
    },
    {
      channel: 'open-meteo',
      probeable: true,
      run: () => fetchOk('https://api.open-meteo.com/v1/forecast?latitude=25.2048&longitude=55.2708&current=temperature_2m', 'weather'),
    },
    {
      channel: 'opensky',
      probeable: true,
      run: () => fetchOk('https://opensky-network.org/api/states/all?lamin=24.0&lomin=53.0&lamax=26.5&lomax=56.5', 'flights', 12000),
    },
    { channel: 'flyai', probeable: false, skipReason: 'anonymous-shared-quota——探针烧额度弊大于利;--only flyai 显式选入', run: async () => ({ ok: true, ms: 0 }) },
    { channel: 'session:ctrip-flight', probeable: false, skipReason: '需用户 Chrome 会话,无头不可探', run: async () => ({ ok: true, ms: 0 }) },
    { channel: 'session:ctrip-hotel', probeable: false, skipReason: '需用户 Chrome 会话,无头不可探', run: async () => ({ ok: true, ms: 0 }) },
    { channel: 'session:12306-train', probeable: false, skipReason: '需用户 Chrome 会话,无头不可探', run: async () => ({ ok: true, ms: 0 }) },
    { channel: 'anything-geo', probeable: false, skipReason: '静态包通道,无远端可探', run: async () => ({ ok: true, ms: 0 }) },
    { channel: 'static-hotel', probeable: false, skipReason: '静态包通道,无远端可探', run: async () => ({ ok: true, ms: 0 }) },
    { channel: 'web-read', probeable: false, skipReason: '依赖 agent-reach 装配态,探测意义低;--only 显式选入可探', run: async () => ({ ok: true, ms: 0 }) },
  ]
}

/**
 * 探测结果 → 事件序列(纯函数,测试锚点):
 *  - fail → down 事件(永远落,哪怕已 down——重申事实,消费方幂等);
 *  - ok 且此前处于 down → 'ok' 恢复事件(latest-wins 超越);
 *  - ok 且此前健康 → 不落(零写放大);
 *  - skip(probeable=false)→ 不产生事件。
 */
export function evaluateProbeResults(
  results: { probe: ChannelProbe; result: ProbeResult }[],
  priorDown: Set<string>,
  now = new Date(),
): ChannelEvent[] {
  const events: ChannelEvent[] = []
  for (const { probe, result } of results) {
    if (!probe.probeable) continue
    if (result.ok) {
      if (priorDown.has(probe.channel)) {
        events.push({ channel: probe.channel, state: 'ok', at: now.toISOString() })
      }
      continue
    }
    events.push({ channel: probe.channel, state: 'down', reason: result.reason, at: now.toISOString() })
  }
  return events
}

export function parseArgs(argv: string[]): { stateRoot?: string; only?: string[]; dryRun: boolean; list: boolean } {
  let stateRoot: string | undefined
  let only: string[] | undefined
  let dryRun = false
  let list = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--state-root') stateRoot = argv[++i]
    else if (a === '--only') only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--dry-run') dryRun = true
    else if (a === '--list') list = true
  }
  return { stateRoot, only, dryRun, list }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const all = defaultProbes()
  if (args.list) {
    for (const p of all) {
      console.log(`${p.probeable ? 'probe' : 'skip '}  ${p.channel}${p.skipReason ? `  # ${p.skipReason}` : ''}`)
    }
    return 0
  }
  const selected = args.only?.length ? all.filter((p) => args.only!.includes(p.channel)) : all.filter((p) => p.probeable)
  if (selected.length === 0) {
    console.error('[channel-probe] --only 未匹配任何通道;--list 查看探测面')
    return 2
  }
  const results: { probe: ChannelProbe; result: ProbeResult }[] = []
  for (const probe of selected) {
    const result = await probe.run()
    results.push({ probe, result })
    console.log(`[channel-probe] ${result.ok ? 'ok  ' : 'FAIL'} ${probe.channel} (${result.ms}ms)${result.ok ? '' : ` reason=${result.reason}`}`)
  }
  const failures = results.filter((r) => !r.result.ok).length
  if (args.dryRun || !args.stateRoot) {
    if (!args.stateRoot) console.log('[channel-probe] 未给 --state-root:只探测不落账(等价 --dry-run)')
    return failures > 0 ? 1 : 0
  }
  let priorDown = new Set<string>()
  try {
    const latest = await readLatestChannelEvents(args.stateRoot)
    priorDown = new Set([...latest.entries()].filter(([, ev]) => ev.state === 'down' || ev.state === 'cooldown').map(([ch]) => ch))
  } catch { /* 读不到按全健康处理 */ }
  for (const ev of evaluateProbeResults(results, priorDown)) {
    await recordChannelEvent(args.stateRoot, ev)
    console.log(`[channel-probe] 记录 ${ev.state} ${ev.channel}${ev.reason ? `(${ev.reason})` : ''}`)
  }
  return failures > 0 ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error('[channel-probe] fatal:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
