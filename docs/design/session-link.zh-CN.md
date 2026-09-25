# Session Link 与 Plan-It 行动卡(issue #580)

> 状态: **契约层已落地(Phase E 切片 1)**。消费端(scheme handler / dsh Web UI 路由)
> 注册是 M4 激活;本文件界定链接词位、载荷 schema 与失败语义。
> 双语对:`session-link.md`(分歧即 bug,i18n checker 把关)。

## TL;DR

Session link 是签名、过期、**schema 闭集**的 token:命名一个不透明的本地
session 引用 + 闭集行动(`plan_it` | `open`)。它是 why-now 卡(issue #577,
Phase D)的一键闭环:「好,规划它」深链回本地 session 继续规划某条
wish——**只打开,永不写**。WriteGate 的 sealed 状态在链接层是结构性表达:
book/pay/confirm 在行动词位里不存在,写行动链接连构造都构造不出来
(sign 抛错),更过不了 verify。

- Token:`body.sig`——base64url(JSON payload)+ base64url(HMAC-SHA256)。
- 载荷:恰好 6 键(`link_id` / `session_ref` / `action` / `wish_id?` /
  `created_at` / `ttl_seconds`);未知键 verify 拒绝——
  *de-identified by construction* 的可测试字面真:链接只携带引用,
  不携带事实或记忆。
- `plan_it` ⇔ 非空 `wish_id`(双向成对);`open` 必须不带 `wish_id`。
- `session_ref` 是不透明引用、永不路径化:`/` `\` `..` NUL 与超 128 字符
  在 sign 与 verify **两层**都拒绝——「不写共享状态」的链接层版:链接
  永远无法命名 state 路径。
- 失败闭集 2 类（`link_invalid` | `link_expired`）；verify 永不抛错——
  production 缺 secret、非字符串运行期 secret 键（数字/对象/Symbol 等 JS
  畸形输入）与注入时钟失效（非有限时间或回调抛错）都是操作面错误，
  收敛为 `link_invalid`；消费端 fail-closed（非法链接什么都不打开）。
- URL 形态只在渲染期(`formatSessionLink(token, base?)`,默认
  `gotry://session/<token>`;本地 http 消费端可传
  `http://127.0.0.1:3080/session`);签名字节里不含宿主细节。

## 1. 为什么与 share token(Phase C)分立

Session link 与 share token 共享同一套 HMAC 硬化清单——恰一个点、
timingSafeEqual（先长度）、整数 ttl 上限 2^31-1、时钟注入（非有限或抛错的
时钟在 verify 即 invalid）、production fail-closed secret
（`SESSION_LINK_HMAC_SECRET`——刻意抛错保留在签发面；verify 把同一配置
错误、非字符串运行期键与任何 HMAC 计算异常收敛为 `link_invalid`）。
但两者**刻意不共享校验器**：

| 维度 | share token(Phase C) | session link(Phase E) |
|---|---|---|
| 载荷 schema | 必填字段 + 允许扩展(manifest 要长大) | **闭集**:未知键即 invalid(de-identified by construction) |
| 行动词位 | 无(它是投递目标,不是行动) | 仅 `plan_it`/`open`;写动词不可构造 |
| 失败闭集 | 8 类(含 adapter/consent) | 2 类(无 channel/consent 维度) |
| 威胁模型 | 换收件人重放 | 向 session 宿主注入事实/state 路径 |

两个独立 secret 面:dev 回落常量是不同字面量,生产各要各的 env var。

## 2. 行动词位 = WriteGate 的链接层封条

`SESSION_LINK_ACTIONS` 是双词闭集。封条是结构性的,不是流程性的:

- 闭集外行动 sign 直接抛错(构造层);
- 手工伪造的合法 HMAC token 带未知行动,verify 一样是 `link_invalid`;
- 没有 `book`/`pay`/`confirm` 词位可走私;新增词位 = 需 review 的契约变更。

`plan_it` 的语义是「回本地 session 继续规划这条 wish」。预订与付款在本
面按构造即不可能——不是注释里的策略,而是词位里没有这个字。(产品层
WriteGate seal 原样未动;本层不新增任何写路径。)

## 3. 载荷契约与护栏

| 字段 | 规则 |
|---|---|
| `link_id` | 非空字符串,调用方给的幂等 id |
| `session_ref` | 不透明引用,1..128 字符,禁 `/` `\` `..` NUL |
| `action` | `plan_it` \| `open`(闭集) |
| `wish_id` | `plan_it`:必填非空字符串;`open`:必须缺省 |
| `created_at` | 可解析日期字符串 |
| `ttl_seconds` | `[0, 2^31-1]` 整数 |

护栏**两层都跑**:sign 抛错(坏链接不出厂);verify 拒一切绕过 sign 的
东西(手工 HMAC 也会在形态检查上死掉)。过期判定用注入时钟对
`created_at + ttl_seconds * 1000`;`ttl_seconds = 0` 是合法的单时刻链接。
非有限或抛错的时钟本身就是 `link_invalid`——无效时间上绝不产生接受
（`NaN` 对任何上界比较恒 false，曾让过期链接静默通过）。

## 4. URL 渲染与反解

`formatSessionLink(token, base?)` 拼 `${base}/${token}`;默认 base
`gotry://session`。scheme/宿主选择属于渲染期的消费端——签名载荷不含宿主
细节,OS scheme handler 与本地 Web UI 共用同一 token 族。

`parseSessionLink(url)` 严格:取路径最后一段,且段本身须呈 `body.sig`
形态(裸 base 如 `gotry://session` 不会被误当 token);**带 query 或
hash 一律拒绝**——拼接歧义(`?x=../../etc`)fail-closed 为 null,绝不
尽力而为地抽取。parse 产物必送 `verifySessionLink` 终裁。

## 5. Plan-it 行动卡

`buildPlanItAction(card: WhyNowCard, deps)` 产出数据,不是 HTML:

```ts
interface PlanItAction {
  kind: 'plan_it'            // 构造级恒值
  label: string              // 封闭词汇「好,规划它」
  deep_link: string          // formatSessionLink(默认 base)
  wish_id: string            // 与 token payload 同一个值——同源构造
}
```

`wish_id` 来自卡的结构化字段(WhyNowCard 在本切片获得 `wish_id`——
Phase D 合同补齐:一键行动必须结构化命名目标,从 title 字符串反解不可
接受)。显示面与打开面不会漂移,因为构造时就是同一个值。卡无非空
`wish_id`、或 `session_ref` 路径化,直接抛错——行动层 fail-closed,
不产「点了不知道开什么」的链接。

`not_now` 是渲染面本地消解:无链接、无状态写。刻意不在本契约内。

## 6. 决策日志

1. **schema 闭集 verify(未知键拒绝)**——de-identified 承诺的可测试化;
   与 share token 的差异是刻意的(威胁模型不同)。
2. **行动词位作 WriteGate 封条**——结构性排除优于流程性检查;不存在的
   词位无法被利用。
3. **`plan_it` ⇔ `wish_id` 双向成对**——防无目标规划链接,也防 open
   链接夹带定向意图。
4. **`session_ref` 路径护栏双层**——「链接永远无法命名 state 路径」,
   无共享状态纪律的链接层版。
5. **token 渲染期才进 URL**——消费端自选 scheme/宿主;本地 http 与 OS
   scheme handler 共用 token 族。
6. **`parseSessionLink` 拒绝 query/hash**——拼接歧义 fail-closed,不尽力
   而为。
7. **WhyNowCard 增补 `wish_id`**——一键需求暴露了 Phase D 遗漏;结构化
   自指,不做 title 反解。
8. **顺修:recall 模块 publish 缺口**——`ts/src/recall/*.ts` 曾不在根
   package `files[]`(PR #578 发布清单缺口,与 #576 修的 QR 缺口同类);
   与 session-link 条目一并补上。

## 7. 切片状态与明确非声明

本切片落地:

- `ts/src/session-link/session-link.ts`——sign/verify/format/parse + 护栏
  （verify 期的 secret 解析与时钟读取在守卫体内；签发面保留刻意的配置抛错）。
- `ts/src/session-link/plan-it-action.ts`——一键行动卡。
- `ts/scripts/session-link-tests.ts`——96 断言，全离线（production 缺 secret
  在隔离子进程环境里验证）。
- WhyNowCard `wish_id`;`scripts/run-all-tests.sh` §6j 注册。

明确非声明:

- **不注册 scheme handler / dsh 路由**(M4 激活;verify 不过的消费端
  什么都不打开)。
- **不做托管分享服务**——独立 founder 决策(研究文档 open decision
  #1);static-first 仍是建议。
- **不接 outbound 投递**——why-now 卡 → 通知通道是 share/recall 契约
  的 M4 接线。
- **无任何写路径**——词位封条 + 原样的 WriteGate,预订/付款从本面
  按构造不可能。
- **不动内核。**

## 8. 交叉引用

- 研究:`docs/research/karpo-deck-web-research.md` §3 Phase E 行。
- why-now 卡生产端:`docs/design/recall-trigger.md`(issue #577)。
- share token(另一张 HMAC 面):`docs/design/share-adapters.md`
  (issue #573)。
- seam 权威:`docs/design/external-event-seam.md` §3.3/§4(pull 模型;
  M5 前无 push)。
- 里程碑:`docs/roadmap.md`(M4 拥有激活)。
