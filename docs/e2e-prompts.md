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

## 总结

- **8 工具人格真协同**: feasibility + skeleton + hotel + weather + flight + anything + web_search + agent_reach + motivation_save + wish_pool
- **dsh LLM 真用能力层调真数据**(Open-Meteo、OpenFlights 骨架、Anything 路由,不是 mock)
- **工作流纪律落地**: 动机先行 / 数据不编 / 走 wish pool / 走 needs-setup 降级指引
- **唯一 founder 阻塞**: npm publish 2FA(路径 A/B 写 docs/tokens.md) + agent-reach 7 渠道 cookie(可等)
