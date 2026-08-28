# dsh e2e 端到端验证(持续更新;正文 §1-§11,2026-08-26)

12 工具人格 + 宿主插件(map_*/calendar_*)真 LLM 会话验证记录:§1-§6 基础六题,
§7-§8 wrapper 反射面,§9 五连改全链回归,§10 数据源路由+setup 协助,§11 判定前
气候背景。每节抓一次 stdout 存档;巡检产生的临时冒烟不逐条入册(关键发现走
release-notes/architecture)。

## 用法

\`\`\`sh
# 启 dsh
./bin/gotry.js web --no-open &
sleep 22
curl -sS --max-time 3 http://127.0.0.1:3080 -o /dev/null -w "dsh=%{http_code}\\n"

# 跑 prompt
./bin/gotry.js "<你的 prompt>" > /tmp/e2e-NN.md 2>&1
\`\`\`

## 结果(2026-08-24 实跑)

### 1. 航班验证 ("查一下深圳飞曼谷的航班,8月5日左右")
- 行为:工作流纪律(动机先行)— 问工作窗口/已订/预算,不编班次数字
- LLM 引用 [骨架:openflights] 触发了 schema,但没给具体班次(数据没齐前不让编)
- ✓ 工作流纪律正确

### 2. 天气 ("曼谷下周天气怎么样")
- 行为:真调 Open-Meteo — 8/30 26-30°C 阵雨 78%;8/31-9/6 走历史基线
- 引用 [实时API:open-meteo@2026-08-24] + [实时API:open-meteo-climate@2026-08-24]
- ✓ 落地端真用能力层,无编造

### 3. Anything ("去上海有什么值得去")
- 行为:工作流纪律(动机先行)— 问出发城市/日期/工作窗口/已订
- LLM 引导 A/B/C 选项
- ✓ Anything 没直接触发(数据未齐)

### 4. 跨域 — 飞机 + 落地建议 ("上海明天天气,上海飞深圳最快")
- 行为:**真触发了 OpenFlights 骨架** — 虹桥 vs 浦东对比,航司列表,飞行时间,建议"门到门最快是虹桥"
- 引用 [骨架:openflights]
- ✓ 多工具协调: 天气(明天) + 飞机(虹桥快) + 落地后建议
- 诚实边界:具体班次时刻没编,指"上航司 App"

### 5. agent-reach doctor ("跑一下 agent-reach doctor,看看 13 平台里哪些能用")
- 行为:真 spawn `agent-reach doctor` — 输出 **4/15 渠道 ready**(V2EX、RSS、Jina、B站搜索 零配置;gh/yt-dlp 需装;8 渠道需 cookie)
- 引用 [agent-reach:@2026-08-24]
- ✓ agent-reach 100% follow 落地

### 6. 跨域 — 云南 + 飞机 + wish pool ("查下云南现在能玩什么,以及从昆明飞曼谷的航班")
- 行为:工作流纪律(先问工作窗口)+ A/B/C 三方向 trade-off(避暑线/曼谷线/云南改期 wish pool)
- ✓ wish pool 概念触发: "如果这次窗口短,不如直接曼谷,云南留给下次(可以记进愿望池,条件合适提醒你)"

## wrapper 面复验(2026-08-22,rc.6 后;wrapper 化改了 gotry_agent_reach 参数面,真 LLM 会话验证反射面可被自主驱动)

### 7. 反射调用 v2ex ("跑一下 agent-reach doctor 看渠道体检,然后用 agent_reach 工具的 v2ex 渠道拿今日热门话题前 5 条")
- 行为:doctor 渠道体检表如实渲染(B站/gh/yt-dlp/mcporter 状态原样);**LLM 自主选对上游真名 `v2ex.get_hot_topics`(无参)**,取回 10 条真数据、给前 5(当天日期感知正确),还主动知道 `v2ex.search` 可用(自描述清单生效)
- 引用 `[agent-reach:v2ex.get_hot_topics@2026-08-24T14:34:28Z]`(真调用时间戳)
- ✓ wrapper「决策归 LLM」设计成立

### 8. needs-setup 原话透传 ("用 agent_reach 查雪球 SH600519 实时股价;需要配置就原样告诉我上游的方法,不要自己编")
- 行为:**上游 check() 原话整段引用**(`agent-reach configure --from-browser chrome --platform xueqiu`),不编股价、不转述、配置后主动提出复查
- 引用 `[agent-reach:xueqiu.get_stock_quote@needs-setup@2026-08-24T14:35:23Z]`
- ✓ 「setup 文案=上游原话透传」成立,LLM 诚实降级

### 9. 全链回归(guard/kind/结果卡/wrapper 五连改后,"8月10-11日两天窗口,深圳出发,湖边发呆,预算3000,千岛湖 vs 大理洱海")
- 行为:一轮内 6 类证据链齐发——判定 [引擎:solveChoiceSegment@ts]、大理雨季/杭州湿热两次 [实时API:open-meteo@ts]、洱海民宿 [静态包:估算]、骨架诚实不覆盖 [骨架:openflights];不可行候选给最小修改(窗口 2→5 天+旱季+¥4632)并自动存愿望池(带浮出条件);**时间感知正确:8/10-11 相对今天已过,主动拦截要日期裁决**(待决=选择题 3 选项);末尾补问工作窗口/已订资源(动机先行)
- 结论:guardToolExecute 包装/kind/结果卡/wrapper 五个 tick 的改动对 LLM 路径零回归
- 附注:demo 数据包的 8 月日期已入过去时,LLM 诚实处理;后续 prompt 应锚定未来日期

### 10. 数据源路由 + setup 协助(#4 行为面,"帮我看看小红书上关于千岛湖的笔记")
- 行为:两条路实测——web.read 搜索页吃反爬([agent-reach:web.read@ts])、上游渠道体检 xiaohongshu.check@off([agent-reach:xiaohongshu.check@off@ts],反射调 check 方法);**仍交付 6 条真实笔记标题+链接**(web 侧拿到),诚实声明不编造正文;按契约 (15) 给三选一 setup 方案(桌面 opencli / Cookie / 先不折腾,各带 trade-off 与精确上游命令)并主动提出配好后拉全文
- 结论:#4①(路由优先 agent-reach、零折损——渠道不可用时降级不放弃)与 ②(setup 协助)行为面成立

### 11. 判定前气候背景(T4,全要素:"2027-01-16~22 深圳出发 ¥8000 对比三亚/清迈")
- 行为:判定前先出「① 1月气候背景」表,三亚/清迈各自带 [实时API:open-meteo@2026-08-25] 证据;气候差异进选择题 trade-off(三亚阴天概率 vs 清迈干燥晴好);引擎判定表(起床/到达精力/有效休整/全成本)+ 数据披露(估算/促销底价逐项标注,骨架三值语义正确——SYX 不覆盖○/CNX 枢纽无直飞❌)+ 跨会话画像生效(记住迪拜出发)+ 2027 春节日期换算正确
- 首轮动机先行的分轮验证:缺要素时正确发结构化问询(出发城市含"沿用迪拜"选项/工作窗口/已订资源/具体日期 3 选)
- 结论:T4(判定前背景调查)行为面成立;契约 (1)(17) 双双在线

### 12. M4 形态全量复验(2026-08-28,motivation_brief/0..1/归因禁令/13 工具后,"我想从上海出发,周末两天去千岛湖或太湖发呆休整,预算3000,不想早起赶车,哪个更合适?")
- 行为:一轮内判定表(千岛湖 ❌ 不可行——班次稀少全撞「不想早起」/太湖 ✅ 推荐——13:30 起床、门到门 2h50m、到达精力 84%)+ 逐项证据链([实时API:携程班次表]/[实时API:open-meteo 雷暴 75%]/[实时API:open-meteo-climate 气候基线]/[静态包:估算] 诚实混标);**不可行候选进 wish pool 且条件锁定天气窗口**(「4-5 月/9-10 月晴天多」,「天气对了再叫你」——0..1 触达纪律的对话面兑现);收尾三道选择题(周末确认/已订资源/工作窗口)
- 结论:13 工具形态真模型无回归;wish 触达纪律、证据链混标、动机先行三项 M4 契约全部在线;hbcli 缺席时 Anything 降级路径不影响主判定
- 附注:本节同时是 rc.8 工件(49 文件)对应 main 形态的产品面证据

### 13. 记忆读回真实链路验证(2026-08-28,"不看任何工具,只凭系统提示里「用户记忆」部分回答:我的动机画像里有哪些权重和硬约束?")
- 机制核查:dsh 变量替换实现在 `@deepseek-ai/dsh-system-prompt`(lib bundle 内无此串,pnpm store 才找到)——`variable(name, provider)` 注册进作用域层,assemble 时严格 `{{name}}` 插值;空串合法(首访态不炸),未注册/undefined 直接抛错(故障显性,不会静默吞)
- 实证:headless(deepseek-chat)逐字报出画像——4 个动机权重带「证据 7 条」、wake_not_before=09:00、min_arrival_energy_pct=40%,且主动补充「愿望池按条件召回(0..1)」指引=契约 (6) 同场在线;内容与 gotry-state/motivation-profile.json 逐项一致
- 结论:写(mergeProfile)→读(motivation_brief)→插值(dsh-system-prompt)→模型,四跳全通;profile 内容为创始人真实使用数据(非 smoke 桩),回访体验在真实会话生效

### 14. 契约遵从探测:0..1 召回的自主驱动(2026-08-28,契约 (6) 补「新意图先查池」后,"我11月有5天假,预算8000,从深圳出发,想出去走走")
- 前/后对照:补契约前,模型对完全命中真实 wish 条件的查询直接新推清迈/丽江,愿望池零查询;补一行「用户新出行意图可能命中已存憧憬时,先调 gotry_wish_pool_list 查询再答」后——
- 行为:模型自主调 wish_pool_list,发现池中「千岛湖发呆周末」(2 天/1200)与 11 月 5 天窗口不匹配,**主动 verbalize 不硬推**(「跟这次窗口不太对味,先放着不打扰它」)——0..1 纪律不是机械执行而是语义执行;开场引记忆 brief(回访体验),动机先行三道结构化选择题收尾;headless 无 ask-user 提供方时按契约 (5) 退化文本选择题
- 结论:契约 (6) 三段语义(入池/先查池/0..1+归因禁令)全部真模型在线;wishlist 的「语义执行>机械执行」路线得到实证

### 15. 多 lane 共存实证(2026-08-28,17 工具形态:记忆域 lane × 会话数据面 lane)
- 场景:记忆域 lane(动机 brief/愿望池 0..1)与会话数据面 lane(flyai/session 检索,17 工具)的改动在同一 runtime persona 协同后的 live 复验("我11月有5天假,预算8000,从深圳出发。有什么建议?")
- 行为:开场先对齐记忆 brief(权重/硬约束逐项正确)→ **自主查愿望池**,千岛湖发呆周末与 11 月窗口不匹配后主动说明「先不硬推它」(契约 (6) 语义执行)→ 天气底牌 [实时API:open-meteo] + 航线底牌 [实时API:flyai@ts] + [骨架:openflights] 三源证据链并存,会话面工具标签与记忆契约无串扰
- 结论:ADR-13 平铺 envelope + 单一 persona 组合源在多 lane 并行演进下稳定;两条 lane 的契约(记忆 0..1 / 会话 ReadGuard 只读)在真模型会话中同时在线

## 总结

- **8 工具人格真协同**: feasibility + skeleton + hotel + weather + flight + anything + web_search + agent_reach + motivation_save + wish_pool
- **dsh LLM 真用能力层调真数据**(Open-Meteo、OpenFlights 骨架、Anything 路由,不是 mock)
- **工作流纪律落地**: 动机先行 / 数据不编 / 走 wish pool / 走 needs-setup 降级指引
- **唯一 founder 阻塞**: npm publish 2FA(路径 A/B 写 docs/tokens.md) + agent-reach 7 渠道 cookie(可等)


## 14. 会话数据面工具面(2026-08-28,P3 切片1/2;真模型巡检待登录态)

- **smoke §12 实证**:17 工具注册含 `gotry_flyai_search`/`gotry_session_search`;flyai live hit(上海→丽江 2026-10-01,10 条,证据链 [实时API:flyai@ts]);session 工具终态 needs-login(登录态存在前提合同,零导航零请求)。
- **人格契约 (19)** 已入仓根 yml:三级路由(官方→会话交叉验证→静态包),直达/中转分桶比对;challenged 即停手。
- **待办**:founder 登录态落盘后补真模型会话巡检一例(当前 profile Cookies 0 行——2026-08-28 tick 实测诊断,session-login 需重跑并在窗口内完成登录)。
- **金标准 flyai 基线(fa-01..04,2026-08-28 傍晚,经能力层)**:fa-01 上海→丽江 flight hit 10 条 min ¥230(中转跨天链)/2.8s;fa-02 北京→大理 flight **miss 0 条**(三值语义活案例:小机场季节性线路,miss≠错误,降级路径正确)/4.5s;fa-03 上海→大理 train hit 10 条/2.5s;fa-04 北京→昆明 train hit 10 条/2.6s。**火车价打码发现**:未鉴权态飞猪火车条目 price 为 "1xxx" 形态——flyai.ts 已加 priceRaw 透传(真实价以 jumpUrl 落地页为准),机票价不受影响。
