# M3 段 1:最小 Web 面实测与差距清单

> 实测对象:`./gotry`(= dsh web profile + GoTry patch:人格+五工具+DeepSeek 原生)。
> 实测方法:启动 HTTP 200 确认、标题/日志/间接证据(headless 已验五工具+人格全链,web 与 headless 共享同一组合)。
> 判定基准:D1 产品设计的 L1 承诺(透明卡片/全成本/gates 选择题/证据链)。

## 一、实测结果

| 项 | 状态 | 说明 |
|---|---|---|
| Web 界面启动 | ✅ HTTP 200,localhost:3080 | 标题「DeepSeek Harness」 |
| GoTry 插件加载 | ✅(headless 同组合已验五工具+人格) | web/headless 共享 cordis 组合 |
| 骨架校验可达 | ✅(启动日志见 [骨架:openflights] 输出) | 插件 import 链活着 |
| 对话能力 | ✅ headless 已验(云南带爸妈全链) | web 是同一模型的 UI 壳 |

## 二、与产品预期的差距(D-4 的具体化)

| # | 差距 | 严重度 | M3 内赎回方式 |
|---|---|---|---|
| G-1 | **标题是「DeepSeek Harness」不是「GoTry」**——用户看到的是别人的产品 | 高(品牌) | dsh web 支持 title 定制或加登录页/封面;或 M3 自建薄壳(下条) |
| G-2 | **dsh web 是编码 agent 界面,非旅行产品界面**:对话流可用,但透明卡片/markdown 表格的渲染是通用 chat 质量,非产品级(无卡片化选择题/无地图位/无预算条) | 高(产品体验) | 方向 A:深用 dsh 的 `presentCall`/`presentResult` 卡片机制(工具已实现但样式是 generic);方向 B(tech-strategy §7-3):assistant-ui+Vercel AI SDK 自建 3-5 页薄壳,`./gotry` 起本地服务 |
| G-3 | **异步「一小时后回来」在 web 模式的呈现**:dsh 无产品化的工单进度视图 | 中 | 短期:对话内文字进度;中期:gotry-state/async 的只读状态页(一条 /status 路由) |
| G-4 | 会话/状态是 dsh 的 session,非 TripState 的产品视图(wish pool/动机画像无处可看) | 中 | 自建壳的三个页面:对话/wish pool/动机画像(TripState 已有 JSON) |
| G-5 | 无移动端 | 低(M3 种子用户是邀请制桌面优先可接受) | M4 后 |

## 三、建议(呈 §7-3 决策)

**方向 B(自建薄壳)为 M3 主线**——理由:
1. dsh web 的通用性是双刃剑:能跑≠像产品;品牌(G-1)与体验(G-2)在别人的壳里改不动;
2. GoTry 的 L1 承诺(透明卡片/选择题/地图位)需要的定制深度超过 presentCall 卡片能给的;
3. 薄壳很薄:对话(桥到 dsh headless 或直接用 LlmPort)+ wish pool/动机画像两个只读页——**核心全部复用,只有壳是新的**;
4. dsh 仍是运行时底座(headless 模式继续作为引擎入口),壳与底座经 LlmPort 契约解耦——与「不自研 agent 运行时」的创始人约束不冲突(壳是 UI 不是运行时)。

**若创始人选方向 A(留在 dsh web)**:M3 只做 G-1(标题/品牌)与 presentCall 卡片样式打磨,接受通用 chat 形态——更快但产品感弱。

来源:启动实测(localhost:3080)+ headless 同组合验收(b0cfd97)。
