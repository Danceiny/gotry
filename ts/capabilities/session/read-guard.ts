/**
 * ReadGuard:会话检索面的只读物理隔离(RFC user-session-data-rfc.md §3.3)。
 *
 * 写不是「被禁止的行为」,是「不存在的原语」——WriteGate(L0-L4)的检索态前置:
 *   ① 网络层:route 拦截——命中硬支付模式(任意方法)或写方法+写URL模式 → abort + 审计落盘;
 *   ② DOM 层:提交类按钮文本黑名单,从快照/断言文本中剔除(模型看不到可点的提交件);
 *   ③ fail-closed:guard 未装上,session transport 不允许导航(openSession 装不上即整会话失败)。
 *
 * 审计:append-only JSONL(session-incidents.jsonl,对齐 incident-log 惯例),隔离 stateRoot。
 * 注意:搜索接口多为 POST(如携程 batchSearch),因此写判定必须「方法 × URL 模式」双因子,
 * 不能一刀切禁 POST——batchSearch 不含写词,放行。
 */

import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 硬支付模式:任意方法(含 GET)都视为写——进支付/收银面本身就是风险 */
const HARD_PAY_RE = /\/(pay|payment|cashier)(\/|\?|$)/i
/** 驼峰复合写词(OTA 常见 /submitOrder、/createOrder):段式正则漏接,单列 */
const WRITE_COMPOUND_RE = /(submitorder|createorder|placeorder|cancelorder|refundorder|orderconfirm|orderpay|confirmpay)/i
/** 写词 URL 模式:仅在写方法(POST/PUT/DELETE/PATCH)下触发 */
const WRITE_URL_RE = /\/(order|orders|submit|trade|booking|book|purchase|buy|create|cancel|refund)(\/|\?|$)/i
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])
/** DOM 提交件文本黑名单(§3.3-②):命中即从可交互面剔除 */
export const SUBMIT_TEXT_RE = /下单|去支付|支付|预订|订票|购买|提交订单|确认订单/

/** 网络层写判定(纯函数,测试锚点) */
export function classifyRequest(method: string, url: string): 'allow' | 'block' {
  if (HARD_PAY_RE.test(url) || WRITE_COMPOUND_RE.test(url)) return 'block'
  if (WRITE_METHODS.has(method.toUpperCase()) && WRITE_URL_RE.test(url)) return 'block'
  return 'allow'
}

/** DOM 层提交件过滤(纯函数,测试锚点):true=剔除 */
export function isSubmitText(text: string): boolean {
  return SUBMIT_TEXT_RE.test(text ?? '')
}

export interface GuardAuditEntry {
  ts: string
  kind: 'blocked-write-request'
  method: string
  url: string
}

export interface ReadGuardHandle {
  /** 被拦截的写请求数(测试断言锚点) */
  blockedCount(): number
  /** 经手的请求总数 */
  requestCount(): number
}

export interface RoutableContext {
  route(glob: string, handler: (route: { request(): { method(): string; url(): string }; abort(code?: string): Promise<void>; continue(): Promise<void> }) => Promise<void>): Promise<void>
}

/**
 * 装上网络层守卫(fail-closed 的「closed」在调用方:openSession 装不上 guard 即失败,不给无 guard 的会话)。
 * 审计落 auditPath(JSONL append);auditPath 缺省不落盘(仅内存计数)。
 */
export async function attachReadGuard(ctx: RoutableContext, auditPath?: string): Promise<ReadGuardHandle> {
  let blocked = 0
  let total = 0
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    total += 1
    const verdict = classifyRequest(req.method(), req.url())
    if (verdict === 'block') {
      blocked += 1
      if (auditPath) {
        const entry: GuardAuditEntry = { ts: new Date().toISOString(), kind: 'blocked-write-request', method: req.method(), url: req.url().slice(0, 400) }
        try {
          mkdirSync(dirname(auditPath), { recursive: true })
          appendFileSync(auditPath, JSON.stringify(entry) + '\n')
        } catch { /* 审计失败不阻塞拦截本身 */ }
      }
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  return {
    blockedCount: () => blocked,
    requestCount: () => total,
  }
}
