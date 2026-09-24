/**
 * Recall tick scheduler(issue #577,Phase D;研究决策见
 * docs/research/karpo-deck-web-research.md §3 Phase D;
 * seam 约束见 docs/design/external-event-seam.md §3.3/§4——**pull model,M5 前无 push**;
 * 自检 review 两轮修复见 PR #578 评论)。
 *
 * 设计契约:
 *   - TickSource:`next()` **运行中阻塞到下一个 tick 可用**;**未运行(未启动或已
 *     stop)返回 null = 流终结**——drain-loop 调用方安全退出,永不悬挂;
 *   - PeriodicTickSource:**默认 enabled=false**(显式 opt-in);start() 三态
 *     ('started'|'disabled'|'already-running');timer.unref()(不拽住事件循环);
 *     pending 有界(maxPending 默认 100,溢出丢最旧);**stop() 清空 pending 并把
 *     全部等待者以 null 唤醒**(终结核平——消费协程不泄漏,重启不吐陈旧 tick);
 *   - RecallTickScheduler:**永不抛错**——evaluate/toCard/deliver 全部容错:
 *     evaluate 抛错 → {delivered:0, failed:0, error};单卡 toCard/deliver 抛错 →
 *     只弃该卡(failed++ 并记 errors),余下继续;返回 {delivered, failed, errors?};
 *   - **不推送**:sink 是注入的下游,不是 notification/push 通道(seam §4)。
 */

export interface RecallTick {
  /** tick 发生的时刻 */
  at: Date
  /** 来源标记(fail-safe 渲染用;不参与逻辑) */
  source: string
}

export interface TickSource {
  /** 拉下一个 tick:**运行中**阻塞到可用;**未运行**(未启动/已 stop)返回 null = 流终结 */
  next(): Promise<RecallTick | null>
}

/** 测试用 InMemory tick source:预排好的一组 tick,按序返回,耗尽返回 null。
 *  构造与 next() 均防御式深拷贝(调用方改返回的 tick.at 不会污染队列快照)。 */
export class InMemoryTickSource implements TickSource {
  private queue: RecallTick[]
  constructor(ticks: RecallTick[]) {
    this.queue = ticks.map(t => ({ at: new Date(t.at.getTime()), source: t.source }))
  }
  async next(): Promise<RecallTick | null> {
    const t = this.queue.shift()
    if (t === undefined) return null
    return { at: new Date(t.at.getTime()), source: t.source }  // 返回副本,调用方可安全改
  }
}

export type PeriodicTickStartResult = 'started' | 'disabled' | 'already-running'

export interface PeriodicTickSourceOptions {
  /** tick 间隔(毫秒;必须为正数) */
  intervalMs: number
  /** **默认 false;显式 opt-in 才产生 tick**(纪律:不悄悄起后台循环) */
  enabled?: boolean
  /** 来源标记 */
  source?: string
  /** pending 队列上界(默认 100;溢出丢最旧——慢消费者不会无限积压过期 tick) */
  maxPending?: number
}

/**
 * 周期 tick source(默认关闭):封装 Node setInterval。
 * - enabled=false 构造默认,显式 opt-in;start() 三态返回(不混同);
 * - next() 语义:**运行中**阻塞到下个 tick;**未运行**(disabled/未 start/已 stop)
 *   立即返回 null(流终结——drain-loop 安全退出,永不悬挂);
 * - stop() 幂等:**清空 pending(重启不吐陈旧 tick)+ 把全部等待者以 null 唤醒**
 *   (消费协程不泄漏);
 * - timer.unref():忘了 stop() 也不拽住进程事件循环;
 * - pending 有界(maxPending,溢出丢最旧)。
 */
export class PeriodicTickSource implements TickSource {
  readonly enabled: boolean
  private intervalMs: number
  private sourceLabel: string
  private maxPending: number
  private timer: ReturnType<typeof setInterval> | null = null
  private pending: RecallTick[] = []
  private waiters: Array<(t: RecallTick | null) => void> = []

  constructor(opts: PeriodicTickSourceOptions) {
    this.enabled = opts.enabled === true
    this.intervalMs = opts.intervalMs
    this.sourceLabel = opts.source ?? 'periodic'
    this.maxPending = opts.maxPending ?? 100
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error(`PeriodicTickSource intervalMs 必须为正数(实测 ${this.intervalMs})`)
    }
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1) {
      throw new Error(`PeriodicTickSource maxPending 必须为 ≥1 整数(实测 ${this.maxPending})`)
    }
  }

  /** 启动内部 setInterval;三态返回(见类注释)。已启动时幂等。 */
  start(): PeriodicTickStartResult {
    if (!this.enabled) return 'disabled'
    if (this.timer !== null) return 'already-running'
    this.timer = setInterval(() => {
      const tick: RecallTick = { at: new Date(), source: this.sourceLabel }
      // 优先唤醒等待者;无等待者入有界队列(溢出丢最旧)
      const waiter = this.waiters.shift()
      if (waiter !== undefined) {
        waiter(tick)
        return
      }
      if (this.pending.length >= this.maxPending) this.pending.shift()
      this.pending.push(tick)
    }, this.intervalMs)
    // unref:不拽住事件循环(调用方忘了 stop() 也不会让进程赖着不死;测试进程自然退出)
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
    return 'started'
  }

  /** 停止(幂等):清 timer + **清空 pending(重启不吐陈旧 tick)+ 等待者全部以 null 唤醒**(终结核平) */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.pending = []
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w(null)
  }

  /** 当前 pending 队列长度(只读;测试与诊断用) */
  get pendingLength(): number {
    return this.pending.length
  }

  /** **运行中**阻塞到下一个 tick;**未运行**(disabled/未 start/已 stop)返回 null(流终结) */
  async next(): Promise<RecallTick | null> {
    if (this.timer === null) return null
    const queued = this.pending.shift()
    if (queued !== undefined) return queued
    return new Promise<RecallTick | null>(resolve => {
      this.waiters.push(resolve)
    })
  }
}

/** scheduler 的下游 sink:注入(测试用数组收集;M4 接 wish_pool_list / 对话面) */
export interface RecallSink {
  deliver(card: unknown): Promise<void> | void
}

/** 数组收集 sink(测试用) */
export class ArrayRecallSink implements RecallSink {
  readonly items: unknown[] = []
  deliver(card: unknown): void {
    this.items.push(card)
  }
}

export interface RecallTickSchedulerDeps<E, C> {
  /** tick 到来时的评估函数(evaluator;契约上纯函数) */
  evaluate: (tick: RecallTick) => E[]
  /** 评估结果到卡的转换(纯函数;签名带 tick——卡的 evaluated_at 应取 tick.at) */
  toCard: (evaluation: E, tick: RecallTick) => C
  /** 下游(注入;测试用 ArrayRecallSink) */
  sink: RecallSink
}

export interface RecallRunResult {
  /** 成功送出的卡数 */
  delivered: number
  /** toCard 或 deliver 抛错被跳过的卡数(不弃余下;不外泄异常) */
  failed: number
  /** 容错捕获的错误消息(前几条;诊断用,绝不外泄为异常) */
  errors?: string[]
}

/**
 * 编排器:拉 tick → 评估 → 转卡 → 送 sink。
 * 每次 run 处理一个 tick(调用方决定循环;scheduler 自己不循环——不悄悄长驻)。
 * **永不抛错**:evaluate 抛错 → {delivered:0, failed:0, error 记入 errors};
 * 单卡 toCard/deliver 抛错 → 只弃该卡(failed++/errors 记一条),余下继续。
 */
export class RecallTickScheduler<E, C> {
  private deps: RecallTickSchedulerDeps<E, C>

  constructor(deps: RecallTickSchedulerDeps<E, C>) {
    this.deps = deps
  }

  async run(tick: RecallTick): Promise<RecallRunResult> {
    const errors: string[] = []
    let evaluations: E[]
    try {
      evaluations = this.deps.evaluate(tick)
      if (!Array.isArray(evaluations)) evaluations = []
    } catch (err) {
      return { delivered: 0, failed: 0, errors: [`evaluate: ${(err as Error)?.message ?? String(err)}`] }
    }
    let delivered = 0
    let failed = 0
    for (const evaluation of evaluations) {
      let card: C
      try {
        card = this.deps.toCard(evaluation, tick)
      } catch (err) {
        failed++
        if (errors.length < 4) errors.push(`toCard: ${(err as Error)?.message ?? String(err)}`)
        continue
      }
      try {
        await this.deps.sink.deliver(card)
        delivered++
      } catch (err) {
        failed++
        if (errors.length < 4) errors.push(`deliver: ${(err as Error)?.message ?? String(err)}`)
      }
    }
    return errors.length > 0 ? { delivered, failed, errors } : { delivered, failed }
  }
}