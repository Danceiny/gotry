[English](m5-supplier-agreement-matrix.md) | [简体中文](m5-supplier-agreement-matrix.zh-CN.md)

# M5-0 HotelByte 供应链协议矩阵（issue #136，可填写草案）

> 定位：M5 Entry 第②组成项背后的可填写具名值矩阵——每个字段写明语义、谁填、示例格式；founder 与 HotelByte 给出之前，具名值一律留空。
> 状态：可填写草案（2026-10-02；所有具名值留空；§2 的工程事实为只读钉死；填满的矩阵仍不是已签协议；2026-10-05 founder 已将 #136 按 not planned 关闭，矩阵继续留空——文中凡写「在 #136」之处，一律读作在恢复 M5-0 的 issue 里，即链接 #136 的新 issue 或重新打开的 #136）。
> 上游：[milestone-delivery-plan.md](milestone-delivery-plan.zh-CN.md) §4 M5-0、[write-gate-production-design.md](write-gate-production-design.zh-CN.md) §14、issue #136 owner 评论（2026-09-08/09/10 准入矩阵）。
> 下游：#136 M5 Entry 验收；Entry 后 #231 → #232 → #233 实施顺序；[decisions-needed.md](../decisions-needed.zh-CN.md) 链接到此。

## 速览（TL;DR）

- M5 Entry 有两个并列组成项：M4 Exit（#20）与供应链协议——本矩阵是第二项的可填写面。
- A 块（协议与授权）与 C–J 块（Buyer/selector、路由、凭据、环境、商业字段、对账 SLA、UAT 护栏）每行都有 字段/语义/谁填/示例/具名值 五列。
- §2 钉死只读工程事实，具名值不得与之矛盾（发布物、超时、unknown 语义、OTP 边界）。
- §5 写明填满的矩阵如何流入 M5 Entry 验收；未填的格子保持闸门关闭。

## 1. 本矩阵怎么用

- 每行一个决策事实。「谁填」写明具名值由谁提供：founder、HotelByte、或 HotelByte 提案加 founder 确认。
- 具名值只含非秘密引用与决定——绝不写入密钥、密码或 OTP 材料。
- 示例格式只是形状，不是对真实取值的暗示。
- 对工程事实的更正走 issue #136 附证据，不就地改 §2。

## 2. 钉死的工程事实（只读，不可填）

- 实际发布物是 npm `staicli@0.0.3`（integrity `sha512-xGzw6KBQ4r5l+CXDbU/35p2nh6ia4t7Hjh+D34IxQEgtaOOkt9iUATmxlFwcspmXCo6NuHoYFhCJ/rJ3rso5fg==`）；不得硬绑定当前 master。
- CLI 30 秒 abort；后端恢复窗口 180 秒 Phase1、再最长 10 分钟 Phase2；迟到订单可能被自动取消；超时/进程退出/非 JSON 一律 unknown——先查单、尊重窗口、绝不并发重订。
- `customerReferenceNo` 不是永久幂等：后端按 Buyer+ref 复用在途/成功单；同一授权 intent 绑定不可变 attempt。
- 当前 CLI/后端没有 `tenantEntityId` selector 或 `DistributorOption`——首接固定一个已授权 Buyer 与一条路由（保守降级，不改写长期 selector 产品意图）。
- UAT ONLINE Book 要求全退政策加 OTP；CLI 无 OTP 通道；GoTry 绝不读 OTP、绝不绕过。
- exit0 不等于成功；book result.status 为 `verified|pending|failed`。

## 3. A 块——协议状态与授权

| 字段 | 语义 | 谁填 | 示例格式 | 具名值 |
|---|---|---|---|---|
| A1 协议状态 | 是否存在真实协议或内部授权（矩阵被填满本身不构成签署） | founder | `signed 2026-__-__` / `internal-auth #___` / `unsigned` | ____ |
| A2 授权主体与批准人 | HotelByte 侧由谁授权、GoTry 侧由谁批准 | founder | `姓名 / 角色 / 渠道` | ____ |
| A3 AK/SK 引用（非秘密） | 哪一对密钥授权本次接入——只写引用；秘密绝不进仓 | founder | `AK ref: hb-____` | ____ |
| A4 有效期与复审日期 | 授权持续多久、何时必须复审 | founder | `2026-__-__ → 2027-__-__` | ____ |

## 4. C–J 块——待填字段

| 字段 | 语义 | 谁填 | 示例格式 | 具名值 |
|---|---|---|---|---|
| C1 Buyer identity | 首接固定的唯一已授权 Buyer | HotelByte 提案，founder 确认 | `buyer: ____` | ____ |
| C2 tenantEntityId selector allowlist | 上游是否存在 selector；允许的 tenantEntityId 清单 | HotelByte | `allowlist: [____]` 或 `not available upstream` | ____ |
| C3 session-order binding | 会话如何绑定订单，使跨 Buyer 错配不可能 | HotelByte | `session key = ____` | ____ |
| C4 mismatch reason code | selector/binding 错配被拒时返回的类型化错误码 | HotelByte | `code: ____` | ____ |
| D Distributor route | 首接固定的唯一已授权供应路由 | HotelByte 提案，founder 确认 | `route: ____` | ____ |
| E 隔离 credential home | 凭据放在哪里、与用户全局环境隔离；不继承 process.env | 工程提案，founder 批准 | `dir: ____` | ____ |
| F 环境 | M5 跑哪个环境、边界在哪 | founder | `uat` / `prod` | ____ |
| G 路由 allowlist | 允许的路由集合；多路由必须先有上游 selector 加绑定加错配拒绝（当前不可得） | founder | `[____]` | ____ |
| H 商业字段 | 报价有效期窗口；取消政策字段；退款流程；佣金；售后责任——逐字段核出的真实值 | HotelByte | `字段=值，按合同` | ____ |
| I 人工对账 SLA | unknown 单由谁对账、响应窗口、证据留存 | founder 加 HotelByte | `SLA: __h / 责任人: ____` | ____ |
| J UAT 护栏 | UAT 测试主体与时窗；预算与订单上限；可撤销开关归属；紧急停止联系人 | founder | `上限: ¥__ / 停止: ____` | ____ |

## 5. 填满后如何流入 M5 Entry

1. 每个具名值对照 §2 工程事实与真实接口合同核验——矛盾在 #136 以证据解决，不在本文档内消化。
2. 签署或内部授权证据（A 块）附到 #136；仅填满的矩阵不等于已签协议。
3. M5 Entry 仅在两个并列组成项同时成立时开闸：M4 Exit（#20）与本协议；矩阵本身不开任何闸。
4. Entry 后按 #231 → #232 → #233 实施；在那之前只允许设计契约、只读调查、确定性 fixture 与 failing test——无业务网络、无 OTP、无真实 book/cancel/refund。
5. 未填的格子保持 M5 Entry 关闭；fixture 或沙箱证据永远不能替代。

## 6. 本矩阵不是什么

- 不是已签协议，本身也不是授权证据。
- 不是凭据仓库：秘密、密钥与 OTP 材料绝不进入本文件或仓库。
- 不是运行时开关：填格子不改变任何运行时路径；交易边界在 M5 Entry 前保持封存。
