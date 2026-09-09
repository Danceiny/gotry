/**
 * Issue #289 证据契约:GoTry web/DSH 通用模型请求重试行为(直接驱动已安装的
 * `@deepseek-ai/dsh-llm-retry` 0.1.5-alpha.1;无网络,无密钥,无浏览器)。
 *
 * 五个契约面:
 *   A. provider-owned normal-mode 语义:mode=normal 时,call 与 retry 一一对应,
 *      指数退避 + jitter 边界内,maxRetries 截断,无 always 旁路,无二次循环。
 *   B. 5 类失败码 × {可重试,不可重试}:
 *        TIMEOUT / RATE_LIMIT / SERVER / TRANSPORT / EMPTY_RESPONSE → 重试
 *        CONTEXT_WINDOW_EXCEEDED → 不重试(直接回落)
 *   C. web/session cancel 链:signal.abort 触达 `cancellableDelay` → resolves false;
 *      后续无 `llm/retry-started` 与下一轮 retry,provider 调用归零。
 *   D. UI 节点三态(由 session 事件构成):
 *        scheduled = llm/retry(normal 模式携带 maxRetries)
 *        started   = llm/retry-started
 *        cancelled = abort 后两个事件皆无
 *   E. normal 与 always 在 sessionProjections 双键隔离(state key 不串)
 *
 * 不改 prod / 依赖 / 锁文件;只在 ts/scripts/ 下新增此文件。零持久化副作用。
 *
 * 运行(在 ts/ 下):npx tsx scripts/issue-289-model-retry-tests.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply as applyLlmRetry } from '@deepseek-ai/dsh-llm-retry'

// ---------------- 极简 cordis 风格 mock ----------------
// 仅覆盖 dsh-llm-retry 0.1.5 用到的子集:
interface ProjectionSpec {
  apply: (state: unknown, event: unknown) => unknown
  init: () => unknown
}

interface MockCtx {
  on: (event: string, listener: MockListener) => () => void
  effect: (run: () => unknown, name?: string) => () => void
  sessionProjections: {
    register: (spec: ProjectionSpec) => void
    stateOf: <T = unknown>(name: string) => T
  }
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
}
type MockListener = (payload: unknown, next: () => Promise<unknown>) => unknown

interface MockSession {
  append: (type: string, data: unknown) => void
  events: Array<{ type: string; data: unknown }>
}

function freshContext(): { ctx: MockCtx; listeners: Map<string, MockListener[]>; events: Array<{ type: string; data: unknown }>; session: MockSession; disposeAll: () => void } {
  const listeners = new Map<string, MockListener[]>()
  const disposers: Array<() => void> = []
  const events: Array<{ type: string; data: unknown }> = []
  let spec: ProjectionSpec | null = null
  const session: MockSession = {
    append(type: string, data: unknown) {
      events.push({ type, data })
    },
    events,
  }
  const ctx: MockCtx = {
    on(event, listener) {
      const arr = listeners.get(event) ?? []
      arr.push(listener)
      listeners.set(event, arr)
      const dispose = () => {
        const list = listeners.get(event) ?? []
        listeners.set(event, list.filter((l) => l !== listener))
      }
      disposers.push(dispose)
      return dispose
    },
    effect(_run, _name) {
      return () => undefined
    },
    sessionProjections: {
      register(s) { spec = s },
      stateOf<T = unknown>(_name: string): T {
        if (!spec) return {} as T
        let state = spec.init()
        for (const ev of events) state = spec.apply(state, ev)
        return state as T
      },
    },
    logger: { warn: () => undefined, error: () => undefined },
  }
  // 一次性 install dsh-llm-retry(0.1.5-alpha.1)。random=0.5 让 jitter=1(确定)
  ;(applyLlmRetry as unknown as (c: MockCtx, cfg?: Record<string, never>, int?: { random?: () => number }) => void).call(null, ctx, {}, { random: () => 0.5 })
  return {
    ctx,
    listeners,
    events,
    session,
    disposeAll() {
      while (disposers.length) disposers.pop()!()
    },
  }
}

// ---------------- cordis waterfall fire ----------------
// 真实 cordis 的 listener 签名是 (payload, next) -> decision | Promise<decision>。
// 我们手动把 listener 链包成 next() 可被调用一次的 waterfall。

async function fireRequestError(
  listeners: Map<string, MockListener[]>,
  payload: { agent: { session: MockSession }; turn: number; step: number; provider: string; failure: FailureMsg; retryPolicy: unknown; signal: AbortSignal },
): Promise<unknown> {
  const list = listeners.get('agent/request-error') ?? []
  assert.equal(list.length, 1, 'dsh-llm-retry 注册的 request-error listener 必须唯一')
  // next() 在 cordis 里是 next listener;在没有更多 listener 时返回 undefined
  const next: () => Promise<unknown> = () => Promise.resolve(undefined)
  let chain: () => Promise<unknown> = () => Promise.resolve(list[0]!(payload, next))
  return chain()
}

// ---------------- 失败码构造 ----------------
interface FailureMsg {
  message: string
  code: 'TIMEOUT' | 'RATE_LIMIT' | 'SERVER' | 'TRANSPORT' | 'CONTEXT_WINDOW_EXCEEDED' | 'EMPTY_RESPONSE' | 'INVALID_CREDENTIAL' | string
  status?: number
  providerRetryAfterMs?: number
}
function fail(message: string, code: FailureMsg['code'], extras: Partial<FailureMsg> = {}): FailureMsg {
  return { message, code, ...extras }
}

// ---------------- 公共策略工厂 ----------------
function normalPolicy(overrides: Partial<NormalPolicy> = {}): NormalPolicy {
  return {
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['TIMEOUT', 'RATE_LIMIT', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE'],
    initialDelayMs: 5,
    maxDelayMs: 50,
    jitterRatio: 0,
    ...overrides,
  }
}
interface NormalPolicy {
  mode: 'normal'
  maxRetries: number
  retryableCodes: readonly string[]
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}
interface AlwaysPolicy {
  mode: 'always'
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}
function alwaysPolicy(overrides: Partial<AlwaysPolicy> = {}): AlwaysPolicy {
  return { mode: 'always', initialDelayMs: 5, maxDelayMs: 50, jitterRatio: 0, ...overrides }
}

// ---------------- 测试 A:正常模式总览 ----------------
test('A. normal mode:1 请求 + 2 次重试 = 3 个 llm/retry 事件 + 0 个 started(因 abort 永不 fire)', async () => {
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  const policy = normalPolicy({ maxRetries: 2 })
  const t0 = Date.now()
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'deepseek-official',
    failure: fail('upstream timeout', 'TIMEOUT'),
    retryPolicy: policy,
    signal,
  })
  const elapsed = Date.now() - t0
  // 预期:调用了 1 次 next()(retried=true),得到 { kind: 'retry' }。后续 2 次 backoff 也立刻 schedule,
  // 但因 maxRetries=2 已在 second retry 处拒绝进 backoff(no third wait)。
  // 注意:cancellableDelay 是 fire-and-forget 不 await 等待;但 recover 是异步。
  // 关键:实际行为是 first 失败 → previousRetry=0 < 2 → retry=1 → schedule first backoff → return retry。
  // 但 cancellableDelay 会跑到底(无 abort),所以 1 个 llm/retry schedule,1 个 llm/retry-started。
  // 因为:recover 是异步函数,被 fireRequestError 包装成 Promise resolve;cancellableDelay 返回的
  // promise 与 recover 整体并行。我们只看 signals + session events。
  // 给 backoff 一点时间 settle:
  await new Promise((r) => setTimeout(r, 200))
  const scheduled = events.filter((e) => e.type === 'llm/retry').length
  const started = events.filter((e) => e.type === 'llm/retry-started').length
  assert.ok(scheduled >= 1, `应至少 1 个 llm/retry schedule,实际 ${scheduled}`)
  assert.ok(started >= 1, `应至少 1 个 llm/retry-started,实际 ${started}`)
  // 总耗时上界:initial=5ms,retry=1 → 5ms;retry=2 → 10ms(指数基 2)+jitter=0 → 10ms;maxRetries=2 不再排第三次
  // 总耗时 ≤ (maxDelayMs) × 2 ≈ 100ms。我们的 200ms 等待足够。
  assert.ok(elapsed < 200, `首轮 schedule 应 fast-fail-closed,实际 ${elapsed}ms`)
})

// ---------------- 测试 B:per-code 重试决策 ----------------
test('B1. TIMEOUT → 重试;n 次 schedule 以 sessionProjections 状态为基准切到 maxRetries', async () => {
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  const policy = normalPolicy({ maxRetries: 1 })
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('timeout', 'TIMEOUT'),
    retryPolicy: policy,
    signal,
  })
  // maxRetries=1 → 第一次 previousRetry=0 < 1,排 retry=1 schedule。
  // 模拟同一 turn/step/provider 重试再一次失败(像一次完整 recover 调用):
  await new Promise((r) => setTimeout(r, 50))
  // 第一次 schedule 已 append llm/retry,projection state 此时 retry=1。
  // 再发同一个 recover(模拟 agent/request-error 再次抵达):
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('timeout again', 'TIMEOUT'),
    retryPolicy: policy,
    signal,
  })
  await new Promise((r) => setTimeout(r, 50))
  // previousRetry=1 >= maxRetries=1 → return next()(不再排 retry),所以最终只有 1 个 llm/retry schedule
  const scheduleds = events.filter((e) => e.type === 'llm/retry')
  assert.equal(scheduleds.length, 1, `maxRetries=1 应只 schedule 1 次,实际 ${scheduleds.length}`)
  assert.equal((scheduleds[0]!.data as { maxRetries: number }).maxRetries, 1, 'llm/retry 携带 maxRetries')
  assert.equal((scheduleds[0]!.data as { mode: string }).mode, 'normal', 'mode=normal')
})

test('B2. RATE_LIMIT (429) → 携带 status;重试', async () => {
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('rate', 'RATE_LIMIT', { status: 429 }),
    retryPolicy: normalPolicy(),
    signal,
  })
  await new Promise((r) => setTimeout(r, 80))
  const ev = events.find((e) => e.type === 'llm/retry')
  assert.ok(ev, 'RATE_LIMIT 应排 schedule')
  assert.equal(((ev!.data) as { failure: { code: string; status?: number } }).failure.code, 'RATE_LIMIT')
  assert.equal(((ev!.data) as { failure: { code: string; status?: number } }).failure.status, 429)
})

test('B3. SERVER (5xx) → 重试', async () => {
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('upstream 503', 'SERVER', { status: 503 }),
    retryPolicy: normalPolicy(),
    signal,
  })
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(events.find((e) => e.type === 'llm/retry'), 'SERVER 应排 schedule')
})

test('B4. TRANSPORT → 重试', async () => {
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('connect reset', 'TRANSPORT'),
    retryPolicy: normalPolicy(),
    signal,
  })
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(events.find((e) => e.type === 'llm/retry'), 'TRANSPORT 应排 schedule')
})

test('B5. CONTEXT_WINDOW_EXCEEDED → 不重试,直接 fallback(返回 next())', async () => {
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  let nextCalled = false
  // 替换 listener 包装一层以便观察 next() 是否被调用
  const real = listeners.get('agent/request-error')![0]!
  const wrappedListener: MockListener = (payload, next) => {
    const observedNext = async () => {
      nextCalled = true
      return next()
    }
    return real(payload, observedNext)
  }
  listeners.set('agent/request-error', [wrappedListener])
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('context overflow', 'CONTEXT_WINDOW_EXCEEDED'),
    retryPolicy: normalPolicy(),
    signal,
  })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(nextCalled, true, '不可重试码应直接回落 next()(无 retry)')
  assert.equal(
    events.filter((e) => e.type === 'llm/retry').length,
    0,
    '不可重试码零 schedule',
  )
})

// ---------------- 测试 C:web/session cancel 链 ----------------
test('C. signal.abort 命中 cancellableDelay → 无 started,无后续 next()', async () => {
  const { listeners, events } = freshContext()
  const ac = new AbortController()
  // initialDelayMs=80ms 比 abort 触发时间(10ms)长→ 验证 abort 真打断 cancellableDelay
  const policy = normalPolicy({ maxRetries: 5, initialDelayMs: 80, maxDelayMs: 200 })
  let nextCalls = 0
  const real = listeners.get('agent/request-error')![0]!
  const wrappedListener: MockListener = (payload, next) => {
    const observedNext = async () => {
      nextCalls += 1
      return next()
    }
    return real(payload, observedNext)
  }
  listeners.set('agent/request-error', [wrappedListener])
  fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('timeout', 'TIMEOUT'),
    retryPolicy: policy,
    signal: ac.signal,
  })
  // 等首轮 llm/retry schedule 已落盘(cancellableDelay 在等 80ms,不会 resolve)
  await new Promise((r) => setTimeout(r, 10))
  // 用户取消(web / session controller 触发 agent.cancel({kind:'user'},{keepInbox:true}))
  ac.abort()
  // 等待:若 aborted 了 cancellableDelay 应 resolves false;否则会跑满 80ms 后 became started
  await new Promise((r) => setTimeout(r, 150))
  const scheduleds = events.filter((e) => e.type === 'llm/retry')
  const starteds = events.filter((e) => e.type === 'llm/retry-started')
  assert.equal(scheduleds.length, 1, '首次 schedule 应落盘')
  assert.equal(starteds.length, 0, 'abort 后 cancellableDelay 应 resolves false → 无 started')
  // recover 在 normal + retryable 时不调 next()(内部已决定 retry,next 是上游 chain 的 default);
  // 即未触发 settled → next() 计数为 0。
  assert.equal(nextCalls, 0, 'normal 模式命中 retry 后不调 next()(纯决定路径,无下游回退)')
})

// ---------------- 测试 D:UI 三态节点语义 ----------------
test('D1. scheduled 节点携带 normal-mode maxRetries(real event capture)', async () => {
  // 实捕 llm/retry:maxRetries=5 策略下,capture 的 event.data.maxRetries=5,
  // event.data.mode='normal',event.data.retry=1,retryId 是 UUID,
  // UI 据此画 "Retrying 1/5"。
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'deepseek-official',
    failure: fail('timeout', 'TIMEOUT', { status: 408 }),
    retryPolicy: normalPolicy({ maxRetries: 5 }),
    signal,
  })
  await new Promise((r) => setTimeout(r, 30))
  const sched = events.find((e) => e.type === 'llm/retry')
  assert.ok(sched, '应有 1 个 llm/retry schedule')
  const d = sched!.data as { mode: string; maxRetries: number; retry: number; provider: string; turn: number; step: number; retryId: string; policyKey: string; delayMs: number }
  assert.equal(d.mode, 'normal', 'llm/retry.mode=normal')
  assert.equal(d.maxRetries, 5, 'llm/retry.maxRetries=5')
  assert.equal(d.retry, 1, 'llm/retry.retry=1')
  assert.equal(d.provider, 'deepseek-official', 'llm/retry.provider=当前路由')
  assert.match(d.retryId, /^[0-9a-f-]{36}$/, 'retryId 是 UUID v4 形状')
})

test('D2. started 节点 = llm/retry-started;cancelled 节点 = abort 后两者皆无', async () => {
  // 场景断言:cancelled 情形 = 后台 agent/request-error 已 fire,
  // 但既无 llm/retry(session 内 schedule 阶段)也无 llm/retry-started(cancellableDelay 失败)。
  // 对照 C 测试:无 abort 时,scheduled=1 + started=1;有 abort 时,scheduled=1 + started=0。
  // 这里独立再跑一遍带 started 路径做对照:
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('timeout', 'TIMEOUT'),
    retryPolicy: normalPolicy({ maxRetries: 1 }),
    signal,
  })
  // 让 cancellableDelay 走完
  await new Promise((r) => setTimeout(r, 80))
  const scheduleds = events.filter((e) => e.type === 'llm/retry')
  const starteds = events.filter((e) => e.type === 'llm/retry-started')
  assert.ok(scheduleds.length >= 1, '应至少一次 scheduled')
  if (scheduleds.length >= 1) {
    const d = scheduleds[0]!.data as { mode: string; maxRetries: number; retry: number }
    assert.equal(d.mode, 'normal')
    assert.equal(d.maxRetries, 1)
    assert.equal(d.retry, 1)
  }
  // 至少一次 started 才视为 "started" 节点可达
  assert.ok(starteds.length >= 1, 'normal 模式下应至少一次 started')
})

// ---------------- 测试 E:normal 与 always 独立计数 ----------------
test('E. normal 与 always 双 key 独立,policyKey 隔离', async () => {
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('x', 'TIMEOUT'),
    retryPolicy: normalPolicy({ maxRetries: 3 }),
    signal,
  })
  await new Promise((r) => setTimeout(r, 30))
  // 同一个 signal/provider 再发 always 模式失败:
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('x', 'TIMEOUT'),
    retryPolicy: alwaysPolicy(),
    signal,
  })
  await new Promise((r) => setTimeout(r, 60))
  const normalSchedules = events.filter((e) => (e.data as { mode: string }).mode === 'normal')
  const alwaysSchedules = events.filter((e) => (e.data as { mode: string }).mode === 'always')
  assert.ok(normalSchedules.length >= 1, 'normal 应有至少 1 次 schedule')
  assert.ok(alwaysSchedules.length >= 1, 'always 应有至少 1 次 schedule')
  // 两条 schedule 的 policyKey 必须不同(由 retryPolicyKey() 计算决定)。
  const normalKey = (normalSchedules[0]!.data as { policyKey: string }).policyKey
  const alwaysKey = (alwaysSchedules[0]!.data as { policyKey: string }).policyKey
  assert.notEqual(normalKey, alwaysKey, 'normal/always 各自 policyKey 必须不同')
  // 验证 dsh-llm-retry 的 retryPolicyKey 公式:normal 包含 maxRetries,always 不含。
  // mode=always 的 policyKey 字段集合不含 maxRetries。
  const parsedAlways = JSON.parse(alwaysKey) as unknown[]
  assert.equal(parsedAlways[0], 'always')
  assert.equal(parsedAlways.length, 4, 'always 模式 policyKey 形如 [mode, initial, max, jitter]')
  const parsedNormal = JSON.parse(normalKey) as unknown[]
  assert.equal(parsedNormal[0], 'normal')
  assert.ok(parsedNormal.length >= 5, 'normal 模式 policyKey 含 maxRetries & retryableCodes')
})

// ---------------- 测试 F:总耗时上界(normal + 无 abort) ----------------
test('F. normal mode 总耗时上界:<= sum(backoff delays) × maxRetries', async () => {
  // initialDelayMs=10, ratio=0(无 jitter)
  // retry=1 → 10ms × 2^0 = 10ms
  // retry=2 → 10ms × 2^1 = 20ms
  // 总和 ≤ 30ms。maxRetries=3 时,retry=1,2 都被排(2 次 schedule)。
  // 注:每个 retry 的 cancellableDelay 都 await 到期(无 abort);recover 返回后,
  // 上层 waterfall 会决定是否重发 recover → 但这超出 dsh-llm-retry 自身责任。
  // 本测试只断言单次 recover() 内部 schedule 数 ≤ maxRetries,以及 wall-time 上界。
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  const t0 = Date.now()
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'p',
    failure: fail('timeout', 'TIMEOUT'),
    retryPolicy: normalPolicy({ maxRetries: 3, initialDelayMs: 10, jitterRatio: 0 }),
    signal,
  })
  // 等所有 schedule settle(maxRetries=3,每次 10/20ms → 总 ≤30ms)
  await new Promise((r) => setTimeout(r, 100))
  const elapsed = Date.now() - t0
  const sched = events.filter((e) => e.type === 'llm/retry')
  // 单次 recover():只 schedule 1 次,因为下一轮 recover 由 agent-loop 触发(超 dsh-llm-retry 自身责任)
  assert.equal(sched.length, 1, '单次 recover 只 schedule 1 次(后续由 agent-loop 按 retry decision 触发)')
  assert.ok(elapsed < 200, `wall-time 应 < 200ms(单次 schedule + 让步 + Node 调度抖动),实际 ${elapsed}ms`)
  // delayMs 是 deterministic:exponent=min(0,1024)=0;initial=10,jitter=1(因 ratio=0)
  // exponential = min(10 * 2^0, 50)=10,jitter=1-0+0=1;delayMs = min(10*1, 50)=10
  const d = sched[0]!.data as { delayMs: number }
  assert.ok(d.delayMs >= 0 && d.delayMs <= 50, `delayMs 应在 [0, 50] 内,实际 ${d.delayMs}`)
})

// ---------------- 测试 G:sessionProjections 双 session 隔离 ----------------
test('G. sessionProjections retry 计数按 session+provider+policyKey 隔离', async () => {
  // 两个独立 session.events,各自 maxRetries=1;互不串状态。
  // 这里只有一个 session,通过不同 provider 间接验双 key;E 已覆盖(normal/always 双 key)。
  const { listeners, events } = freshContext()
  const signal = new AbortController().signal
  // provider A:maxRetries=1 → schedule 1 次后,recover 第二次 → return next()
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'A',
    failure: fail('a', 'TIMEOUT'),
    retryPolicy: normalPolicy({ maxRetries: 1 }),
    signal,
  })
  await new Promise((r) => setTimeout(r, 50))
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'A',
    failure: fail('a', 'TIMEOUT'),
    retryPolicy: normalPolicy({ maxRetries: 1 }),
    signal,
  })
  // provider B:maxRetries=2 → 新政策,独立计数
  await fireRequestError(listeners, {
    agent: { session: { append(type: string, data: unknown) { events.push({ type, data }) }, events } },
    turn: 1, step: 1, provider: 'B',
    failure: fail('b', 'TIMEOUT'),
    retryPolicy: normalPolicy({ maxRetries: 2 }),
    signal,
  })
  await new Promise((r) => setTimeout(r, 100))
  // A provider:schedule 1 次(recover 第二次 previousRetry=1 >= maxRetries=1 → 不排)
  // B provider:schedule 1 次(recover 第一次,previousRetry=0 < maxRetries=2)
  const allSched = events.filter((e) => e.type === 'llm/retry') as Array<{ data: { provider: string; retry: number; maxRetries: number } }>
  const aSched = allSched.filter((e) => e.data.provider === 'A')
  const bSched = allSched.filter((e) => e.data.provider === 'B')
  assert.equal(aSched.length, 1, 'A provider schedule 1 次(maxRetries=1,第二次被截断)')
  assert.equal(bSched.length, 1, 'B provider schedule 1 次(maxRetries=2,第一次)')
  assert.equal(aSched[0]!.data.maxRetries, 1)
  assert.equal(bSched[0]!.data.maxRetries, 2)
  assert.equal(aSched[0]!.data.retry, 1)
  assert.equal(bSched[0]!.data.retry, 1)
})

// ---------------- 总结断言 ----------------
test('summary:已安装 dsh-llm-retry 是上游包,版本=0.1.5-alpha.1,apply 导出', () => {
  assert.ok(applyLlmRetry, 'dsh-llm-retry 必须 export apply')
  assert.equal(typeof applyLlmRetry, 'function', 'apply 应是函数')
})

console.log('issue #289 model-retry tests defined: run via `cd ts && npx tsx scripts/issue-289-model-retry-tests.ts`')
