/**
 * 扩展车道客户端(RFC §2.2 通道 C,2026-08-29 PRIMARY;issue #21 传输层方案 B)。
 *
 * 三种 job 封装:search(被动嗅探 batchSearch)/ open-login(登录入口置前台)/
 * cookie-names(票据 cookie **名字**,协议面不存在值字段)。verdict 映射纯函数
 * `classifyBridgeFailure` 供回归覆盖:
 *   - extension-not-connected → 'needs-extension'(waiting no-spend,一次性安装指引;
 *     **不静默回退 CDP**——回退即重新引入逐连接权限框,正是本通道要消灭的摩擦);
 *   - bridge-unavailable(端口池全占等环境故障)→ 'error'(非用户门)。
 * 检索页无回包不是车道失败:与 CDP 车道同语义(到点无 hints 命中 ⇒ miss,页标题命挑战 ⇒ challenged)。
 */

import { getOrCreateSessionBridge, EXTENSION_STORE_URL, type SessionJobHandle } from './extension-bridge.ts'

/** 一次性用户门文案(needs-extension 统一指引,与 bootstrap setupExtension 输出同口径) */
export const NEEDS_EXTENSION_HINT =
  '需要一次性安装 GoTry Session Bridge 浏览器扩展(装完零弹窗):'
  + `推荐 Chrome 应用商店一键安装(自动更新) ${EXTENSION_STORE_URL} ;`
  + '免审核、版本更新更快的 GitHub 通道:npx gotry setup --extension-from=github(自动下载落位 ~/.gotry/extension;'
  + '手动下载 github.com/Danceiny/gotry/releases 标签 ext-* 的 gotry-session-bridge.tar.gz),'
  + '再在 chrome://extensions 开发者模式「加载已解压的扩展程序」指向解压目录'

export type BridgeFailureKind = 'bridge-unavailable' | 'extension-not-connected' | 'timeout' | 'job-error'

export interface BridgeFailure {
  ok: false
  kind: BridgeFailureKind
  summary: string
}

/** 桥故障 → 用户门 verdict 纯函数(测试锚点):只有「扩展未连接」是用户门(waiting),其余降级 error */
export function classifyBridgeFailure(kind: BridgeFailureKind): 'needs-extension' | 'error' {
  return kind === 'extension-not-connected' ? 'needs-extension' : 'error'
}

export interface SessionJobHandleRef {
  ok: true
  bridge: SessionJobHandle
}

function bridgeReady(b: { ok: true; bridge: SessionJobHandle } | { ok: false; summary: string }): b is SessionJobHandleRef {
  return b.ok === true
}

/** cookie-names job:票据 cookie 名存在性(名字级;协议不含值) */
export async function extensionCookieNames(q: { site: string; domain: string; ticketNames: string[]; timeoutMs?: number }): Promise<{ ok: true; tickets: string[] } | BridgeFailure> {
  const bridge = await getOrCreateSessionBridge()
  if (!bridgeReady(bridge)) return { ok: false, kind: 'bridge-unavailable', summary: bridge.summary }
  const outcome = await bridge.bridge.submit(
    { kind: 'cookie-names', site: q.site, timeoutMs: q.timeoutMs ?? 8_000 },
    { timeoutMs: q.timeoutMs ?? 8_000 },
  )
  if (!outcome.ok) return { ok: false, kind: outcome.reason, summary: outcome.summary }
  const names = Array.isArray(outcome.result.names) ? outcome.result.names.filter((n): n is string => typeof n === 'string') : []
  // 红线自证:隧道面只有名字(extension-tests §红线断言协议面无值字段)
  return { ok: true, tickets: names }
}

/** 登录入口置前台打开(#34 纪律:标签留给用户,扩展侧不 close) */
export async function extensionOpenLogin(q: { site: string; url: string; timeoutMs?: number }): Promise<{ ok: true; opened: boolean } | BridgeFailure> {
  const bridge = await getOrCreateSessionBridge()
  if (!bridgeReady(bridge)) return { ok: false, kind: 'bridge-unavailable', summary: bridge.summary }
  const outcome = await bridge.bridge.submit({ kind: 'open-login', site: q.site, url: q.url }, { timeoutMs: q.timeoutMs ?? 15_000 })
  if (!outcome.ok) return { ok: false, kind: outcome.reason, summary: outcome.summary }
  if (!outcome.result.opened) return { ok: false, kind: 'job-error', summary: outcome.result.error ?? '登录入口打开失败' }
  return { ok: true, opened: true }
}

export interface ExtensionSearchOutcome {
  ok: true
  /** NETWORK_HINTS 命中的响应原文;未命中/超时为空 */
  body: string
  /** 页标题(challenged 判定素材) */
  title: string
  /** 到点未见 hints 命中(站点无回包/风控拦截页) */
  timedOut: boolean
}

/** 检索 job:后台标签打开 entry,等 content hook 的嗅探回包;页无响应=timedOut(非车道失败) */
export async function extensionSearchJob(q: { site: string; url: string; timeoutMs?: number }): Promise<ExtensionSearchOutcome | BridgeFailure> {
  const bridge = await getOrCreateSessionBridge()
  if (!bridgeReady(bridge)) return { ok: false, kind: 'bridge-unavailable', summary: bridge.summary }
  const timeoutMs = q.timeoutMs ?? 30_000
  const outcome = await bridge.bridge.submit(
    { kind: 'search', site: q.site, url: q.url, timeoutMs },
    { timeoutMs: timeoutMs + 10_000 },
  )
  if (!outcome.ok) return { ok: false, kind: outcome.reason, summary: outcome.summary }
  return {
    ok: true,
    body: typeof outcome.result.body === 'string' ? outcome.result.body : '',
    title: typeof outcome.result.title === 'string' ? outcome.result.title : '',
    timedOut: outcome.result.timeout === true,
  }
}