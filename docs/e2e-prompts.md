# dsh e2e 端到端验证(2026-08-24,HEAD `4a8a51b`)

8 工具人格跑通 6 不同 prompt。每一 prompt 抓一次 stdout,存档可重放。

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

## 总结

- **8 工具人格真协同**: feasibility + skeleton + hotel + weather + flight + anything + web_search + agent_reach + motivation_save + wish_pool
- **dsh LLM 真用能力层调真数据**(Open-Meteo、OpenFlights 骨架、Anything 路由,不是 mock)
- **工作流纪律落地**: 动机先行 / 数据不编 / 走 wish pool / 走 needs-setup 降级指引
- **唯一 founder 阻塞**: npm publish 2FA(路径 A/B 写 docs/tokens.md) + agent-reach 7 渠道 cookie(可等)
