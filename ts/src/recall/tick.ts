/**
 * Recall tick scheduler(issue #577,Phase D;研究决策见
 * docs/research/karpo-deck-web-research.md §3 Phase D;
 * seam 约束见 docs/design/external-event-seam.md §3.3/§4——**pull model,M5 前无 push**;
 * 自检 review 修复见 PR #578 评论)。
 *
 * 设计契约:
 *   - TickSource 抽象:`next()` **阻塞到下一个 tick 可用**(而非 drain-and-null)——
 *     drain-loop 调用方在首个 null 退出会永远错过后续 tick;阻塞语义让两种 source
 *     的消费者写法一致(InMemory 耗尽后仍返 null = 流终结);
 *   - PeriodicTickSource:**默认 enabled=false**(显式 opt-in);start() 返回
 *     'started' | 'disabled' | 'already-running'(三态,不混同);timer.unref()
 *     (不拽住进程事件循环);pending 队列有界(maxPending 默认 100,溢出丢最旧);
 *   - RecallTickScheduler 编排器:接 tick → 调 evaluator → 产卡 → 送 sink;
 *     **逐卡 try/catch**——单个 deliver 拒绝不弃余下卡,返 {delivered, failed};
 *   - **不推送**:sink 是注入的下游(测试用数组;M4 接 wish_pool_list 或对话面),
 *     不是 notification/push 通道——seam §4 明确「No push notifications」。
 */

export interface RecallTick {
  /** tick 发生的时刻 */
  at: Date
  /** 来源标记(fail-safe 渲染用;不参与逻辑) */
  source: string
}

export interface TickSource {
  /** 拉下一个 tick;**阻塞到可用**(周期源等下个间隔;InMemory 耗尽返 null = 流终结) */
  next(): Promise<RecallTick | null>
}

/** 测试用 InMemory tick source:预排好的一组 tick,按序返回,耗尽返回 null。
 *  构造时深拷贝每个 tick(防御式——调用方改返回的 tick.at 不会污染队列快照)。 */
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
 * - enabled=false 是构造默认,必须显式 opt-in(本切片不接任何运行时);
 * - start() 三态返回:'started'(真的启动)/'disabled'(没 opt-in)/'already-running'
 *   (重复 start 幂等)——不把两种「没启动」混成一个 false;
 * - timer.unref():不拽住进程事件循环(忘了 stop() 不会让进程赖着不死);
 * - next() 阻塞到下一个 tick 可用(drain-loop 安全);pending 有界,溢出丢最旧。
 */
export class PeriodicTickSource implements TickSource {
  readonly enabled: boolean
  private intervalMs: number
  private sourceLabel: string
  private maxPending: number
  private timer: ReturnType<typeof setInterval> | null = null
  private pending: RecallTick[] = []
  private waiters: Array<(t: RecallTick) => void> = []

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

  /** 停止内部 setInterval(幂等) */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 当前 pending 队列长度(只读;测试与诊断用) */
  get pendingLength(): number {
    return this.pending.length
  }

  /** 阻塞拉下一个 tick:有 pending 立即取;无则挂起等待下个间隔的回调唤醒 */
  async next(): Promise<RecallTick | null> {
    const queued = this.pending.shift()
    if (queued !== undefined) return queued
    return new Promise<RecallTick>(resolve => {
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
  /** tick 到来时的评估函数(evaluator;纯函数) */
  evaluate: (tick: RecallTick) => E[]
  /** 评估结果到卡的转换(纯函数;签名带 tick——卡的 evaluated_at 应取 tick.at) */
  toCard: (evaluation: E, tick: RecallTick) => C
  /** 下游(注入;测试用 ArrayRecallSink) */
  sink: RecallSink
}

export interface RecallRunResult {
  /** 成功送出的卡数 */
  delivered: number
  /** deliver 抛错被跳过的卡数(不弃余下;不外泄异常) */
  failed: number
}

/**
 * 编排器:拉 tick → 评估 → 转卡 → 送 sink。
 * 每次 run 处理一个 tick(调用方决定循环;scheduler 自己不循环——不悄悄长驻)。
 * **逐卡容错**:单个 sink.deliver 拒绝只弃该卡,余下继续;返回 {delivered, failed}
 * (调用方据此决定重试/告警;不抛错)。
 */
export class RecallTickScheduler<E, C> {
  private deps: RecallTickSchedulerDeps<E, C>

  constructor(deps: RecallTickSchedulerDeps<E, C>) {
    this.deps = deps
  }

  async run(tick: RecallTick): Promise<RecallRunResult> {
    const evaluations = this.deps.evaluate(tick)
    let delivered = 0
    let failed = 0
    for (const evaluation of evaluations) {
      const card = this.deps.toCard(evaluation, tick)
      try {
        await this.deps.sink.deliver(card)
        delivered++
      } catch {
        failed++
      }
    }
    return { delivered, failed }
  }
}