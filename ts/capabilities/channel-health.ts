/**
 * 通道健康面(channel health)——issue #106/#107/#108 编排设计
 * (docs/design/tool-orchestration-design.md §2.2)的会话瞬态态 + 持久事件面。
 *
 * 两个粒度,均从既有 verdict 流派生,不新增运行时:
 *  - 会话瞬态面:进程内 Map。检索通道 verdict≠hit 时记状态
 *    (down=本会话别再试 / cooldown=节律闸冷却中),后续同意图工具结果的
 *    routing 建议(channel-registry.routingAdvice)据此排除不可用通道;
 *    成功调用(hit)自动清除——补装 key/装完扩展后不被陈旧状态锁死。
 *    与断路器同先例(ADR-18):进程内瞬态,不是持久资产。
 *  - 持久事件面:down/cooldown 事件 append-only 落
 *    <stateRoot>/gotry-state/channel-health.jsonl,供 doctor(CLI 独立进程,
 *    看不到进程内 Map)显示「最近一次达限/不可用时间」。只记状态变化,
 *    不记成功(零写放大);落盘失败不阻塞检索主路径(事实侧车同纪律)。
 *
 * verdict → 状态映射的唯一入口是 noteChannelVerdict:
 *   needs-setup → down(quota-or-setup)   challenged → down(challenged)
 *   needs-login / needs-extension → down(同因,会话内改道;hit 即清除)
 *   cooldown → cooldown(默认 30s,会话节律闸同款)
 *   hit → 清除该通道全部状态
 *   其余 verdict(miss/error 等)不改变通道状态——那是业务结果,不是通道健康。
 *
 * @module capabilities/channel-health
 */

export type ChannelHealthState = 'down' | 'cooldown'

/**
 * 持久事件面的状态全集:会话瞬态(down/cooldown)之外,持久面还接受 'ok'
 * 恢复事件(外部事件接缝第 1 段,docs/design/external-event-seam.md §3.1/
 * §6①)——本地探针 tick 探测通过后写 'ok',readLatestChannelEvents 按
 * latest-wins 让它超越同通道更早的 down,消费方(doctor/metrics)据 state
 * 判定当前健康。会话瞬态 Map 不接受 'ok'(进程内 hit 即清除,语义已存在)。
 */
export type ChannelEventState = ChannelHealthState | 'ok'

export interface ChannelEvent {
  /** 通道 id(channel-registry.ts CHANNELS 的 id) */
  channel: string
  state: ChannelEventState
  /** 触发原因(小写连字符;人话渲染归消费方) */
  reason?: string
  /** ISO 时间戳 */
  at: string
}

interface SessionEntry {
  state: ChannelHealthState
  reason?: string
  /** cooldown 到期(epoch ms);down 无到期 */
  until?: number
  since: number
}

/** 会话瞬态面(进程内;与断路器状态同生命周期先例) */
const session = new Map<string, SessionEntry>()

/** 默认 cooldown = 会话节律闸同款 30s */
export const DEFAULT_COOLDOWN_MS = 30_000

export function markChannelDown(channel: string, reason: string, now = Date.now()): ChannelEvent {
  session.set(channel, { state: 'down', reason, since: now })
  return { channel, state: 'down', reason, at: new Date(now).toISOString() }
}

export function markChannelCooldown(channel: string, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now()): ChannelEvent {
  session.set(channel, { state: 'cooldown', until: now + cooldownMs, since: now })
  return { channel, state: 'cooldown', at: new Date(now).toISOString() }
}

/** 成功即清除(恢复信号:下一次成功调用自动解锁,不要求显式复位) */
export function clearChannel(channel: string): void {
  session.delete(channel)
}

/** 读通道状态;cooldown 过期惰性清除。无状态返回 undefined。 */
export function channelState(channel: string, now = Date.now()): { state: ChannelHealthState; reason?: string } | undefined {
  const e = session.get(channel)
  if (!e) return undefined
  if (e.state === 'cooldown' && (e.until ?? 0) <= now) {
    session.delete(channel)
    return undefined
  }
  return { state: e.state, reason: e.reason }
}

/** 测试隔离:清空全部会话态(生产路径不调) */
export function resetChannelHealth(): void {
  session.clear()
}

export interface ChannelVerdictNoteOptions {
  now?: number
  cooldownMs?: number
}

/**
 * verdict → 通道状态变化的唯一映射(工具层在拿到渠道结果后调用)。
 * 返回落盘事件(down/cooldown 才有;hit 清除与其余 verdict 返回 undefined)。
 */
export function noteChannelVerdict(channel: string, verdict: string, opts: ChannelVerdictNoteOptions = {}): ChannelEvent | undefined {
  const now = opts.now ?? Date.now()
  switch (verdict) {
    case 'hit':
    case 'found':
      clearChannel(channel)
      return undefined
    case 'needs-setup':
    case 'needs-login':
    case 'needs-extension':
    case 'needs-attach':
    case 'challenged':
      return markChannelDown(channel, verdict, now)
    case 'cooldown':
      return markChannelCooldown(channel, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS, now)
    default:
      return undefined
  }
}

/** 持久事件面:append-only JSONL(<stateRoot>/gotry-state/channel-health.jsonl)。永不抛错。 */
export async function recordChannelEvent(stateRoot: string, event: ChannelEvent): Promise<void> {
  try {
    const { mkdir, appendFile } = await import('node:fs/promises')
    const dir = `${stateRoot.replace(/\/+$/, '')}/gotry-state`
    await mkdir(dir, { recursive: true })
    await appendFile(`${dir}/channel-health.jsonl`, `${JSON.stringify(event)}\n`, 'utf-8')
  } catch { /* 证据侧车永不阻塞主路径 */ }
}

/**
 * 读最近事件(每通道取最新一条)——doctor(CLI 独立进程)的持久面输入。
 * 容忍坏行/空文件/缺文件;limitDays 过滤过旧事件(默认 30 天)。
 * latest-wins:'ok' 恢复事件可超越同通道更早的 down/cooldown(外部事件接缝
 * 第 1 段);消费方以 `state !== 'down'` 判当前健康,旧判定(`=== 'down'`)
 * 不受影响。
 * requireValidTimestamp(opt-in,#436 路由消费方):缺失/不可解析/未来时间戳的行
 * **在 latest-wins 覆盖之前**丢弃——否则一条坏时间戳的新行会顶掉同通道更早的
 * 有效 down,把通道错误地判回可用。默认 false,doctor/metrics/探针既有口径不变
 * (它们只消费状态与历史频率,不要求时间戳可信);保留期仍是同一个 limitDays。
 */
export async function readLatestChannelEvents(stateRoot: string, opts: { limitDays?: number; now?: number; requireValidTimestamp?: boolean } = {}): Promise<Map<string, ChannelEvent>> {
  const latest = new Map<string, ChannelEvent>()
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(`${stateRoot.replace(/\/+$/, '')}/gotry-state/channel-health.jsonl`, 'utf-8')
    const nowMs = opts.now ?? Date.now()
    const cutoff = nowMs - (opts.limitDays ?? 30) * 86_400_000
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const ev = JSON.parse(t) as ChannelEvent
        if (!ev || typeof ev.channel !== 'string' || typeof ev.state !== 'string') continue
        if (!['down', 'cooldown', 'ok'].includes(ev.state)) continue
        const atMs = Date.parse(ev.at ?? '')
        if (opts.requireValidTimestamp) {
          if (!Number.isFinite(atMs) || atMs > nowMs || atMs < cutoff) continue
        } else if (Number.isFinite(atMs) && atMs < cutoff) continue
        latest.set(ev.channel, ev)
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 无文件=无事件 */ }
  return latest
}
