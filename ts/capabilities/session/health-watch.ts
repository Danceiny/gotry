/**
 * 扩展健康检查 + 自动重放(issue #21 onboarding UX,P3.6 gotry-session-onboarding-goal,
 * RFC user-session-data-rfc.md §3.3)。
 *
 * 动机:首次 `sessionFlightSearch` 遇 `needs-extension` 时,旧版要求用户装完扩展后**自己重跑命令**;
 * 本模块把「用户手工重跑」改成「后台有界轮询 + 扩展一就位自动重放同一 query_id」——
 * 用户装完扩展零后续动作,gotry 自己感知到 ready 后立刻跑同一条 query。
 *
 * 形态:
 * - `startExtensionHealthWatch({ timeoutMs, intervalMs, probe })` 启后台轮询。
 *   probe 是异步检测函数(默认 GET http://127.0.0.1:{port}/status,扩展 ≤30s 心跳一次,
 *   1.5 倍容差 EXTENSION_CONNECTED_WINDOW_MS=45s;§38 已经验证扩展心跳节奏)。
 * - 命中 ready → 调用方自动重放(query_id / args 不变;同一证据文件覆盖)。
 * - 超时(timeoutMs 默认 120_000)→ 返回 'timeout',调用方降级回 `needs-extension` 错误面。
 *
 * 离线合同(run-all §40 onboarding-tests 5/5):
 * - 三时序分支:probe 0ms ready / 中途 ready / 120s+1ms 超时;
 * - 同 query_id 重放语义(参数透传);
 * - 取消语义(timeoutMs=0 立即 timeout;cancel() 立即返回 'cancelled');
 * - 重放上限(防止 watch 反复 ready/抖动导致无限重放;maxRetries 默认 1)。
 *
 * 纪律:
 * - 不引 GUI 依赖;只 spawn `node:http` 探活(已经在扩展桥验证过,§38 24 断言覆盖);
 * - 不持锁、不轮询文件、不读 dsh-runtime 共享状态;
 * - 不污染扩展桥 single-instance;probe 走独立短连接。
 */

import { request } from 'node:http'
import {
  BRIDGE_PORTS,
  EXTENSION_CONNECTED_WINDOW_MS,
  type SessionBridgeOptions,
} from './extension-bridge.ts'

export type HealthWatchOutcome =
  | { ready: true; attempts: number; waitedMs: number }
  | { ready: false; reason: 'timeout' | 'cancelled'; attempts: number; waitedMs: number }

export interface HealthWatchOptions extends SessionBridgeOptions {
  /** 最长等多久(默认 120s);0 = 立即 timeout(便于测试) */
  timeoutMs?: number
  /** 探活间隔(默认 5s);必须 < EXTENSION_CONNECTED_WINDOW_MS,否则抖动期漏心跳 */
  intervalMs?: number
  /** 探活函数:返回 true 即视为扩展就绪(测试可注入 fake probe)。
   * 默认走双因子:① 心跳 `/status` extensionConnected === true
   * + ② 业务探针 cookie-names 真回包(timeout 5s);二者同时通过才算真 ready。
   * 仅心跳通过但 cookie-names 失败 = 扩展 SW 跑着但 chrome.cookies 权限缺 → 不算 ready。 */
  probe?: () => Promise<boolean>
  /** 最大重放次数(默认 1);防止 ready 抖动反复触发 query 重放 */
  maxRetries?: number
  /** 取消信号(可选)——给调用方提供立刻终止 watch 的逃生口 */
  signal?: AbortSignal
  /** 时间源(测试可注入 fake clock) */
  now?: () => number
  /**
   * 是否启用业务探针(cookie-names)。wizard 默认 true(用户刚装扩展,首次需要双因子验证);
   * 上线 session 检索可传 false(快速心跳足矣,业务探针会另发一次请求)。
   */
  businessProbe?: boolean
}

export interface HealthWatchController {
  /** Promise:resolve 时扩展已 ready,可执行重放 */
  waitReady(): Promise<HealthWatchOutcome>
  /** 立刻取消;waitReady 立即 resolve {ready:false, reason:'cancelled'} */
  cancel(reason?: string): void
  /** 当前 ready 次数(供诊断/审计) */
  readonly readyCount: number
}

interface InternalState {
  cancelled: boolean
  readyCount: number
  resolveOutcome: ((o: HealthWatchOutcome) => void) | null
}

/**
 * 双因子 probe(默认):心跳 + 业务探针(cookie-names)。
 * 心跳通过只能证 SW 跑着;业务探针通过证 chrome.cookies 权限齐——二者同过才算
 * 扩展真正 ready。wizard 必须双因子(用户刚装的扩展可能权限不全),上线 session
 * 检索可传 `businessProbe:false` 跳业务探针(避免每次检索额外打一次 cookie-names)。
 *
 * 不直接 import extension-channel.ts(避免环)—用 dynamic import 懒拿。
 */
export async function combinedProbe(opts: HealthWatchOptions, businessProbe: boolean): Promise<boolean> {
  if (!(await defaultProbe(opts))) return false
  if (!businessProbe) return true
  try {
    // 动态 import 避免 health-watch ↔ extension-channel 双向环
    const channel = await import('./extension-channel.ts')
    const bridge = await import('./extension-bridge.ts')
    // 双因子探针需要常驻桥(wizard 期间):keepBridge=true 透传到 bridge 单例
    bridge.getOrCreateSessionBridge({ keepBridge: opts.keepBridge === true })
    // 心跳已 ready(刚 defaultProbe 通过)= 扩展一定在线;cookie-names 超时给 8s,
    // 比心跳间隔 5s 长——保证 tick 间不会撞死 cookie job
    const cookie = await channel.extensionCookieNames({
      site: 'ctrip-flight',
      domain: 'ctrip.com',
      ticketNames: ['cticket', 'uid'],
      timeoutMs: 8_000,
    })
    // cookie-names.ok = true 表示扩展 SW 真能调 chrome.cookies.getAll(权限齐全);
    // cookie-names.ok = true + names = [] 也算 ok(用户没登携程但扩展权限齐)。
    // cookie-names.ok = false 分两类:bridge-unavailable/extension-not-connected(心跳 false 时) / timeout(扩展没回包)——
    // 后者更可能是 SW 卡了,不应当 ready。但 wizard 必须严格:让用户明确知道权限缺或登录缺。
    return cookie.ok
  } catch {
    return false
  }
}

/**
 * 默认 probe:GET http://127.0.0.1:{port}/status,看 extensionConnected: true
 * (扩展心跳 ≤30s 一刷,窗口 EXTENSION_CONNECTED_WINDOW_MS=45s 容差)。
 * 不在端口池内挑一个试——端口是已启动桥的事实,直接拿 opts.ports[0] 或 8791。
 * 测试可注入 fake probe 跳过网络。
 */
export async function defaultProbe(opts: HealthWatchOptions): Promise<boolean> {
  const ports = opts.ports ?? [...BRIDGE_PORTS]
  for (const port of ports) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: 2_000 },
        (res) => {
          if (!res.statusCode || res.statusCode >= 400) { resolve(false); return }
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => { buf += c })
          res.on('end', () => {
            try {
              const payload = JSON.parse(buf) as { extensionConnected?: boolean }
              resolve(payload.extensionConnected === true)
            } catch { resolve(false) }
          })
          res.on('error', () => resolve(false))
        },
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.end()
    })
    if (ok) return true
  }
  return false
}

export function startExtensionHealthWatch(opts: HealthWatchOptions = {}): HealthWatchController {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 5_000
  const maxRetries = opts.maxRetries ?? 1
  const businessProbe = opts.businessProbe ?? true
  // 关键:wizard 期间需要常驻桥(keepBridge=true 透传到 getOrCreateSessionBridge),
  // 否则启桥后 wizard main 一退桥就退,扩展心跳发不进来。
  // 用 dynamic import 避免与 extension-bridge 顶层环(channel 也引 bridge,但 health-watch 引 channel/bridge 双向会死循环)
  const probe = opts.probe ?? (async () => {
    // 先确保桥存在 + keepBridge
    const bridge = await import('./extension-bridge.ts')
    await bridge.getOrCreateSessionBridge({ keepBridge: opts.keepBridge === true })
    return combinedProbe(opts, businessProbe)
  })
  const now = opts.now ?? Date.now
  const state: InternalState = { cancelled: false, readyCount: 0, resolveOutcome: null }

  const finish = (outcome: HealthWatchOutcome): void => {
    if (state.resolveOutcome) {
      const resolve = state.resolveOutcome
      state.resolveOutcome = null
      resolve(outcome)
    }
  }

  // 取消信号 -> 立刻 timeout-ish 终态(不进 ready 路径)
  const onAbort = (): void => {
    state.cancelled = true
    finish({ ready: false, reason: 'cancelled', attempts: state.readyCount, waitedMs: 0 })
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const waitReady = (): Promise<HealthWatchOutcome> => new Promise<HealthWatchOutcome>((resolve) => {
    if (state.cancelled) { resolve({ ready: false, reason: 'cancelled', attempts: 0, waitedMs: 0 }); return }
    if (timeoutMs === 0) { resolve({ ready: false, reason: 'timeout', attempts: 0, waitedMs: 0 }); return }
    state.resolveOutcome = resolve
    const deadline = now() + timeoutMs
    let attempts = 0
    let waitedMs = 0

    const tick = async (): Promise<void> => {
      if (state.cancelled || state.resolveOutcome === null) return
      attempts += 1
      try {
        const ready = await probe()
        if (ready && !state.cancelled) {
          state.readyCount += 1
          waitedMs = timeoutMs - Math.max(0, deadline - now())
          // readyCount > maxRetries → 视为抖动,继续等(避免一次性重放洪流)
          if (state.readyCount <= maxRetries) {
            finish({ ready: true, attempts, waitedMs: waitedMs > 0 ? waitedMs : 0 })
            return
          }
        }
      } catch { /* probe 失败继续轮询,不挡主流程 */ }
      waitedMs = timeoutMs - Math.max(0, deadline - now())
      if (now() >= deadline) {
        finish({ ready: false, reason: 'timeout', attempts, waitedMs })
        return
      }
      // 间隔 = intervalMs;若剩余时间 < intervalMs 则最后一次等剩余时间
      const remaining = deadline - now()
      const delay = Math.min(intervalMs, Math.max(0, remaining))
      if (delay <= 0) {
        finish({ ready: false, reason: 'timeout', attempts, waitedMs })
        return
      }
      setTimeout(tick, delay)
    }
    void tick()
  })

  return {
    waitReady,
    cancel: () => onAbort(),
    get readyCount() { return state.readyCount },
  }
}

/**
 * 自动重放 wrapper:首次调用走 fetch(返回 needs-extension) → 启 watch →
 * 扩展 ready → 同 query 重放。语义:用户侧**只看到一条 query 的最终结果**;
 * 中间产物(query_id 标记 + 尝试次数)落 evidence 文件,便于离线追溯。
 *
 * 这是 §3.3「用户零手工重跑」的对外契约:调用方把 fetch 包成 withAutoRetryOnExtension,
 * 用户装完扩展→自然出结果;用户不装→等 120s 后返回 needs-extension,而不是「再跑一次试试」。
 */
export async function withAutoRetryOnExtension<T>(args: {
  fetch: () => Promise<T>
  isExtensionNeeded: (result: T) => boolean
  /** watch 配置(测试可注入 fake probe) */
  watch?: HealthWatchOptions
  /** 重放 fetcher(默认复用 fetch) */
  retry?: () => Promise<T>
}): Promise<{ result: T; retried: boolean; attempts: number; outcome: HealthWatchOutcome }> {
  const first = await args.fetch()
  if (!args.isExtensionNeeded(first)) {
    return { result: first, retried: false, attempts: 1, outcome: { ready: true, attempts: 0, waitedMs: 0 } }
  }
  const watch = startExtensionHealthWatch(args.watch ?? {})
  const outcome = await watch.waitReady()
  if (!outcome.ready) {
    return { result: first, retried: false, attempts: 1, outcome }
  }
  const retriedResult = await (args.retry ?? args.fetch)()
  return { result: retriedResult, retried: true, attempts: 2, outcome }
}

/** 留作运行时只读检查,防止扩展心跳节律假设漂移(§38 防漂移同款语义) */
export const HEALTH_WATCH_INTERVAL_FLOOR_MS = 1_000
export const HEALTH_WATCH_INTERVAL_CEIL_MS = EXTENSION_CONNECTED_WINDOW_MS - 1_000
