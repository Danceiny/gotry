/**
 * Recall tick scheduler(issue #577,Phase D;研究决策见
 * docs/research/karpo-deck-web-research.md §3 Phase D;
 * seam 约束见 docs/design/external-event-seam.md §3.3/§4——**pull model,M5 前无 push**)。
 *
 * 设计契约:
 *   - TickSource 抽象:时间驱动(InMemoryTickSource 测试用)或事件驱动(M4 接
 *     external-event seam 本地 producer);每个 tick 携带来源标记;
 *   - PeriodicTickSource:**默认 enabled=false**(显式 opt-in;M4 才接真 setInterval);
 *   - RecallTickScheduler 编排器:接 tick → 调 evaluator → 产 WhyNowCard → 送 sink;
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
  /** 拉下一个 tick;无可用 tick 返回 null(调用方可休眠或退出) */
  next(): Promise<RecallTick | null>
}

/** 测试用 InMemory tick source:预排好的一组 tick,按序返回,耗尽返回 null */
export class InMemoryTickSource implements TickSource {
  private queue: RecallTick[]
  constructor(ticks: RecallTick[]) {
    this.queue = [...ticks]
  }
  async next(): Promise<RecallTick | null> {
    return this.queue.shift() ?? null
  }
}

/**
 * 周期 tick source(默认关闭):封装 Node setInterval,**enabled=false 是构造默认,
 * 必须显式 opt-in**(本切片不接任何运行时——测试用 enabled=true + 手动 next())。
 * M4 阶段由 external-event seam 的 producer 段接通真实周期源。
 */
export interface PeriodicTickSourceOptions {
  /** tick 间隔(毫秒) */
  intervalMs: number
  /** **默认 false;显式 opt-in 才产生 tick**(纪律:不悄悄起后台循环) */
  enabled?: boolean
  /** 来源标记 */
  source?: string
}

export class PeriodicTickSource implements TickSource {
  readonly enabled: boolean
  private intervalMs: number
  private sourceLabel: string
  private timer: ReturnType<typeof setInterval> | null = null
  private pending: RecallTick[] = []

  constructor(opts: PeriodicTickSourceOptions) {
    this.enabled = opts.enabled === true
    this.intervalMs = opts.intervalMs
    this.sourceLabel = opts.source ?? 'periodic'
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error(`PeriodicTickSource intervalMs 必须为正数(实测 ${this.intervalMs})`)
    }
  }

  /** 启动内部 setInterval(仅 enabled=true 时生效;返回是否真的启动了) */
  start(): boolean {
    if (!this.enabled || this.timer !== null) return false
    this.timer = setInterval(() => {
      this.pending.push({ at: new Date(), source: this.sourceLabel })
    }, this.intervalMs)
    return true
  }

  /** 停止内部 setInterval(幂等) */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async next(): Promise<RecallTick | null> {
    return this.pending.shift() ?? null
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
  /** 评估结果到卡的转换(纯函数) */
  toCard: (evaluation: E, tick: RecallTick) => C
  /** 下游(注入;测试用 ArrayRecallSink) */
  sink: RecallSink
}

/**
 * 编排器:拉 tick → 评估 → 转卡 → 送 sink。
 * 每次 run 处理一个 tick(调用方决定循环;scheduler 自己不循环——不悄悄长驻)。
 */
export class RecallTickScheduler<E, C> {
  private deps: RecallTickSchedulerDeps<E, C>

  constructor(deps: RecallTickSchedulerDeps<E, C>) {
    this.deps = deps
  }

  async run(tick: RecallTick): Promise<number> {
    const evaluations = this.deps.evaluate(tick)
    for (const evaluation of evaluations) {
      const card = this.deps.toCard(evaluation, tick)
      await this.deps.sink.deliver(card)
    }
    return evaluations.length
  }
}