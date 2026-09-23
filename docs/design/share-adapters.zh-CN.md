[English](share-adapters.md) | [简体中文](share-adapters.zh-CN.md)

# Share 适配器与 Share Token（issue #573）

> 定位：外发 share 缝合（outbound-share seam）的契约词汇、默认 stub 实现、HMAC share-token、consent 状态机与 shareDeck 主流程——**全是契约 + stub,不调真实 SDK、不挂 dsh 工具、不激活运行时**。
> 状态：内部切片（2026-09-23）。karpo-deck-web 借鉴路线图 Phase C。运行时激活（真适配器接线、dsh 工具注册、trigger 接线）属 M4 工作,不在本切片。
> 上游：issue #573；[karpo-deck-web 参考研究](../research/karpo-deck-web-research.zh-CN.md) §3 Phase C 决策；契约纪律借鉴单页入口——share 与 artifact entry 一样要求「显式、可审计、不偷偷做」；consent 模式借鉴 `ts/capabilities/session-consent.ts` 但保持独立模块（session 是「我能不能读你的浏览器」;share 是「我能不能替你外发到第三方」——语义与撤销粒度都不同）。
> 下游：`ts/scripts/share-tests.ts`（run-all §6h）；后续 M4 切片（trigger 驱动的外发、dsh 工具注册、真适配器 SDK 接线）。

## 速览（TL;DR）

- `ShareAdapter` 接口 + 4 个 no-op stub（`imessage` / `sms` / `slack` / `webhook`）——统一返回 `{ delivered: false, reason: 'not_activated' }`。无 SDK、无网络、无副作用。
- HMAC-SHA256 share-token：`signShareToken` / `verifyShareToken`——base64url body + sig,`timingSafeEqual` 验签,ttl 过期检查,结构化失败原因。
- `ShareConsentState` 状态机：`mode: 'ask' | 'allow' | 'off'` + 每 `share_id` 一张卡 + `revoked` 列表,显式区分 `consent_required` 与 `consent_revoked`。
- `shareDeck(token, payload, deps)`——纯异步编排：token → consent → channel → adapter。永不抛错。永远返回 `ShareResult`。
- 7 类 `ShareFailureReason` 闭集：`not_activated` / `unknown_channel` / `consent_required` / `consent_revoked` / `share_consent_off` / `token_invalid` / `token_expired`——每类在测试里都可达。

## 1. 契约

```ts
export type ShareChannel = 'imessage' | 'sms' | 'slack' | 'webhook'

export interface SharePayload {
  token: string  // 由 share-token.ts 签发
  target: { channel: ShareChannel; address: string }
  body: { html_path?: string; manifest_path?: string; qr_path?: string; note?: string }
}

export type ShareFailureReason =
  | 'not_activated' | 'unknown_channel'
  | 'consent_required' | 'consent_revoked' | 'share_consent_off'
  | 'token_invalid' | 'token_expired'

export type ShareResult =
  | { delivered: true; adapter_id: ShareChannel; sent_at: string }
  | { delivered: false; reason: ShareFailureReason }

export interface ShareAdapter {
  readonly id: ShareChannel
  send(payload: SharePayload): Promise<ShareResult>
}
```

`ADAPTERS` 是冻结的 record `{ imessage, sms, slack, webhook } → ShareAdapter`。扩通道 = 新增 `ShareChannel` 成员 + 新增 `ADAPTERS` 条目 +（M4 阶段）替换 no-op stub 为真实实现。闭集纪律防止字符串自由枚举漂移。

## 2. 三条硬纪律（继承自 artifact 入口）

1. **只传显式结构 payload**。`SharePayload.body` 携带路径,不携带原始 HTML。HTML / manifest / qr 文件本身是切片 3a 的产物,各自走自己的 O_CREAT|O_EXCL 纪律;share 只引用它们。每个被 share 的产物都可由 `gotry_artifacts_list` + `gotry_artifacts_read` 独立审计。
2. **token 闸先于 adapter 调用**。`shareDeck` 总是先跑 `verifyShareToken`,失败时拒绝分发到任何 adapter。签名不对 / 被篡改 / 过期 payload,adapter 永远见不到。
3. **adapter 永不抛错**。`adapter.send(payload): Promise<ShareResult>` 即便发送失败也返回 `ShareResult`。`shareDeck` 绝不让 adapter 异常逃出;契约出口是 `ShareResult` 联合。

## 3. Share token（HMAC-SHA256,base64url）

Token 形状：`<body>.<sig>`,其中 `body = base64url(JSON.stringify(payload))`,`sig = base64url(HMAC-SHA256(body, secret))`。

- `payload` = `{ share_id, created_at (ISO), ttl_seconds }`
- `secret` 默认为 `SHARE_HMAC_SECRET` env,缺省走 `DEFAULT_DEV_SHARE_SECRET`（`gotry-share-dev-secret-DO-NOT-USE-IN-PROD`）——dev / test 无需设 env。**生产必须设 `SHARE_HMAC_SECRET`**。
- `verifyShareToken(token, secret, now)`:
  - 格式检查（恰好一个 `.`）→ `token_invalid`
  - HMAC `timingSafeEqual` 比对（body 或 sig 任一不匹配）→ `token_invalid`
  - payload 形态校验（share_id / created_at / ttl_seconds 类型）→ `token_invalid`
  - 过期检查：`now > created_at + ttl_seconds * 1000` → `token_expired`（ttl=0 在下一瞬即过期）
  - 成功返回 `{ ok: true, payload }` 给调用方送进 `checkShareConsent`
- `signShareToken` 对固定 `(payload, secret)` 字节级确定性——可由 `sha256(token)` 验证。

## 4. Share consent 状态机

- `mode: 'ask' | 'allow' | 'off'`——总开关。`off` 一律拒返 `share_consent_off`。`ask` 与 `allow` 都要求每 share_id 有 granted 卡（`allow` 是「安装时用户预授权」——无需每次弹卡,`ask` 是「每次弹」）。两种模式在「无卡」时共用 `consent_required` 原因（UI 走单条 prompt 路径）。
- `granted: ShareConsentCard[]`——卡的 append-only 历史（`card_id: UUID`,`share_id`,`granted_at: ISO`）。
- `revoked: string[]`——已撤销的 `card_id` 列表。`revoke` 幂等。
- `checkShareConsent(state, share_id, card_id?)`:
  - `mode === 'off'` → `share_consent_off`
  - 该 `share_id` 无任何 granted 卡 → `consent_required`（「从未发卡」——与已撤销区分）
  - 有 granted 卡但全部在 `revoked` → `consent_revoked`（「曾发卡,已撤」——与 required 区分）
  - 调用方给的 `card_id` 必须匹配存活卡 → `consent_revoked`（防伪造）
- 所有迁移纯函数：`grantShareConsent` / `revokeShareConsent` / `setShareConsentMode` 返回新 state,绝不原地改。

## 5. shareDeck 流程

```
1. verifyShareToken(token, secret, now) → 若 !ok:返回 reason
2. checkShareConsent(state, share_id) → 若 !ok:返回 reason
3. ADAPTERS[payload.target.channel] → undefined → 'unknown_channel'
4. adapter.send(payload) → 返回 result.delivered ? {...result, sent_at: result.sent_at ?? now()} : result
```

永不抛错。每个 `ShareFailureReason` 都是可达返回路径,由测试套件逐类触发（§5c 显式枚举全部七类并断言每类都被真实场景触发）。

## 6. 决策日志

- **为什么是 HMAC 而不是非对称签名**。token 是内部分享——同一 gotry runtime 内生产、消费。非对称签名会加一层密钥管理面而本场景没有对应对手模型。HMAC-SHA256 + 单 secret + `timingSafeEqual` 是这个权力级别的正解。未来 M4+ 若要给*外部*消费者生产 share token（例如托管 share URL）,可在 HMAC 之上叠加非对称签名;当前阶段内部 HMAC 足矣。
- **为什么 `consent_required` 与 `consent_revoked` 是不同的 reason**。UI 与审计需要区分「用户从未授权过这次 share」（弹窗）与「用户授权过又撤回了」（不重新发卡不重试）。混淆二者会让攻击者在用户撤销后无限重试成功。
- **为什么 Phase C 不接 SDK**。iMessage / SMS / Slack / webhook 的真集成牵涉凭据、速率限制、供应商侧状态。在一个非目标写明「不激活运行时」的切片里做这些事,会把两类风险面糅在一起。Phase C 只交付契约 + stub + 流程;M4 替换 stub。在那之前,所有 adapter 调用返 `not_activated`——这本身就是合法的 `ShareResult`。
- **为什么 `ttl_seconds` 嵌在 token payload,而不是独立字段**。把它放进签名 payload,意味着 ttl 被篡改会由 HMAC 验签拦截,不需要独立的校验步骤。一个事实来源、一条验签路径。
- **为什么 `payload.body` 只传路径**。HTML / manifest / qr 是切片 3a bundle 的产物;share 按路径引用,`gotry_artifacts_list` / `gotry_artifacts_read` 仍是唯一审计面,share 永不复制内容。若 share 内联 HTML,审计就要看两个地方。
- **为什么 `mode: 'allow'` 不绕过卡要求**。用户在安装时预授权「share 可以」,仍需每 share 绑定具体卡(才能撤销)。`allow` 的区别是 *哪条 UI 路径*提示用户(无 vs 一次性发卡),不是「per-share 卡是否存在」。

## 7. 切片状态与显式不主张

本切片落地：`ts/src/share/{adapters,share-token,share-consent,share-deck}.ts` + `ts/scripts/share-tests.ts`(54 断言,run-all §6h)。4 个 adapter stub 按设计 no-op。token 签发字节级确定。七类 `ShareFailureReason` 全部可达,套件已证明。

不在本切片：四通道的真 SDK 调用(M4);`gotry_share_*` dsh 工具注册(M4);wish-pool / external-event seam 触发的 share 事件(M4 / Phase D);托管 share URL 服务(研究 E.2)。缝合契约完整;M4 在不动本模块 API 的前提下接 adapter + 接 dsh 面。

## 8. 交叉引用

- `docs/research/karpo-deck-web-research.zh-CN.md` §3 Phase C——切片决策与本切片欠下的。
- `docs/design/itinerary-deck-renderer.md`——产物被 share 按路径引用的渲染器。
- `docs/code-map.md` 中 `ts/src/share/*` 各行——本切片模块清单。
- `ts/capabilities/session-consent.ts`——consent 模式参考（平行,不合并）。
