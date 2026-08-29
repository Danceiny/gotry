/**
 * 外部依赖韧性原语(issue #16 采纳,ADR-18):effect_interpreter.v1 解译器层的横切面。
 *
 * 对外通道的三类故障形态在此归一一处,能力层 handler(永不抛错契约)零改写:
 *   - 指数退避重试 withRetry:只对「瞬时类失败」按策略重试,不改变单次失败语义;
 *   - 断路器 CircuitBreaker:closed→open→half-open,连续失败达阈值即熔断,
 *     冷却后放行单探测——保护配额与上游,拒绝也是显式结构化观察(不抛错);
 *
 * 策略边界(issue #16 三个解译器主张在本仓的保守落法,详见 docs/effect-interpreter.md):
 *   - 重试只属于被判定「值得重试」的瞬时失败;风控/挑战/限流类上游明确说「不」的
 *     失败(如 FlyAI Sentinel)永不重试——重试是放大器,不是修复器;
 *   - 断路器状态是进程内瞬态(同 session-search 节律闸的先例),重启即重置;
 *     不把瞬态熔断写盘成持久资产。
 */

/** 判定一次尝试(返回值 result 或异常 error,二者恰一非空)是否值得退避重试 */
export type RetryablePredicate = (result: unknown, error: unknown) => boolean

export interface RetryPolicy {
  /** 总尝试次数上限(≥1;1 = 不重试) */
  maxAttempts: number
  /** 第 n 次失败后的等待 = min(baseDelayMs * 2^(n-1), maxDelayMs)(指数退避,封顶) */
  baseDelayMs: number
  maxDelayMs: number
  /** 瞬时类失败判定;未提供时缺省 = 抛错或结果 {ok:false} 即重试(免费源宽口径) */
  isRetryable?: RetryablePredicate
  /** 等待注入(测试即时放行,确定性);缺省真实 setTimeout */
  sleep?: (ms: number) => Promise<void>
}

export interface RetryOutcome<T> {
  /** 最终返回值(所有尝试都抛错时为 null) */
  result: T | null
  /** 最后一次捕获的异常(正常返回为 null) */
  error: unknown | null
  /** 实际执行次数(含失败的尝试) */
  attempts: number
  /** 累计回退等待(ms) */
  backoffMs: number
}

/** 第 failedAttempt 次失败后的等待时长(纯函数,单测锁定 500→1000→2000 封顶链) */
export function backoffDelayMs(policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>, failedAttempt: number): number {
  const raw = policy.baseDelayMs * 2 ** (Math.max(1, failedAttempt) - 1)
  return Math.min(raw, policy.maxDelayMs)
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 带指数退避的受控重试:handler 本身永不抛错(能力层契约),这里兼容抛错的
 * 「裸调用方」——异常按 isRetryable(result=null, error) 判定后并入同一计数。
 * 重试只针对瞬时失败;上限到点即返回最后结果,永不向上抛。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onBackoff?: (failedAttempts: number, delayMs: number) => void,
): Promise<RetryOutcome<T>> {
  const sleep = policy.sleep ?? defaultSleep
  const maxAttempts = Math.max(1, policy.maxAttempts)
  let attempts = 0
  let backoffMs = 0
  for (;;) {
    attempts += 1
    let result: T | null = null
    let error: unknown | null = null
    try {
      result = await fn()
    } catch (e) {
      error = e
    }
    const retryable = policy.isRetryable?.(result, error)
      ?? (error != null || (result as { ok?: unknown } | null)?.ok === false)
    if (attempts < maxAttempts && retryable) {
      const delay = backoffDelayMs(policy, attempts)
      onBackoff?.(attempts, delay)
      backoffMs += delay
      await sleep(delay)
      continue
    }
    return { result, error, attempts, backoffMs }
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerOptions {
  /** 连续失败阈值(达到即开闸);成功一次即清零 */
  failureThreshold: number
  /** open 冷却时长;到点转 half-open 放行单探测 */
  openMs: number
  /** 时钟注入(测试);缺省 Date.now */
  now?: () => number
}

/**
 * 断路器(每效应一个实例):
 *   closed    常态放行;连续失败达 failureThreshold → open;
 *   open      拒绝(new attempts=0,.fail-fast 保护上游/配额);冷却满 openMs → half-open;
 *   half-open 仅放行单个探测:onSuccess → closed 清零;onFailure → 重新 open(冷却重启)。
 * 「失败」按效应的 isFailure 语义计数(一次调用一次计数,重试耗尽才计,非每 attempt)。
 */
export class CircuitBreaker {
  private consecutiveFailures = 0
  private openedAt = 0
  private probeInFlight = false

  constructor(private readonly o: BreakerOptions) {}

  private threshold(): number {
    return Math.max(1, this.o.failureThreshold)
  }

  now(): number {
    return (this.o.now ?? Date.now)()
  }

  state(): BreakerState {
    if (this.openedAt > 0 && this.now() - this.openedAt >= this.o.openMs) return 'half-open'
    if (this.openedAt > 0) return 'open'
    return 'closed'
  }

  /** 发起一次调用前问闸:open 回 {allowed:false}(调用方须返回显式降级观察,不重试) */
  canAttempt(): { allowed: boolean; state: BreakerState } {
    const s = this.state()
    if (s === 'closed') return { allowed: true, state: s }
    if (s === 'open') return { allowed: false, state: s }
    // half-open:单探测语义——已有探测在途拒其余并发
    if (this.probeInFlight) return { allowed: false, state: s }
    this.probeInFlight = true
    return { allowed: true, state: s }
  }

  /** 一次解译调用成功(非 isFailure)——清零;half-open 探测成功即回 closed */
  onSuccess(): void {
    this.consecutiveFailures = 0
    this.openedAt = 0
    this.probeInFlight = false
  }

  /** 一次解译调用失败(含重试耗尽)——半开探测失败 = 重新开闸 */
  onFailure(): void {
    this.probeInFlight = false
    this.consecutiveFailures += 1
    if (this.openedAt > 0 || this.consecutiveFailures >= this.threshold()) {
      this.openedAt = this.now()
    }
  }
}