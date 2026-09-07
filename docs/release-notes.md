# GoTry 发版记录

> 给用户和开发者看的更新日志。Latest 在最上面。

---

## v0.0.1-rc.20 · 2026-09-08

### What's New

- **修好 `npx @danceiny/gotry doctor --fix` 的整个安装链** — rc.19 实测三红一误报,根因各不相同:
  - **sidebar「1 项补装失败」是误报**:pnpm 11 的严格构建脚本策略让 dsh 安装器 exit 1,但 167 个包其实已完整落盘(复检本来就是绿的)。现在安装器按落盘状态判成功,并明示 node-pty(侧栏内嵌终端)的构建脚本被 pnpm 跳过、需要时用 `pnpm approve-builds` 补。
  - **地图/路线/POI 工具这次真的可用了(npm 安装形态)**:rc.19 说「正式进依赖」实际只对源码布局生效——npm 布局从未装上。依赖这条路被上游堵死:dsh-map-tools 的 peer 要求 `>=0.1.2-rc.1` 的 dsh 家族,而 gotry 锁定 `0.1.2-alpha.3`(semver 上 alpha < rc),npm 严格 peer 解析直接拒装,硬上会弄坏 `npx @danceiny/gotry` 主安装路径。rc.20 改为**随包内置分发**——装 gotry 即得地图工具,零 API key(OSM/OSRM)。
  - **ask-user 的 ❌ 是体检误报**:依赖一直在(npm 的提升布局里,运行时正常),体检的检查路径没覆盖该布局。现在体检与运行时解析同口径,说真话了。
- **`gotry help` 不再打印合并冲突标记**(rc.19 带入的脏文本,顺带清偿)。

### For Developers

- **CI 双层修复(main 自 #197 起全红)**:①runner npm 升级后裸 `npm ci` 强制校验 peer,而 ts 的 lockfile 一直是 `--legacy-peer-deps` 模式生成——CI 与 CONTRIBUTING 显式带该旗标,并移除 dsh-map-tools 冗余依赖;②turn-deadline 的 5 个 tsc 错误 = 类型面隐性依赖 peer 意外物化(`session/event` 声明在 dsh-session 的 cordis Events augmentation 里,pnpm 隔离布局下 root 侧的 augmentation 合并进另一个 cordis 实例)——显式 `import type` + dsh-session@0.1.2-alpha.3 进 ts 依赖面,overrides 把 peer 闭包钉在 alpha.3 防 rc.1 混版本,ts lock 全量 resolved 指回 registry.npmjs.org。
- doctor 两面(CLI + 会话工具)改 createRequire 解析链,覆盖 npm/npx 提升布局;map-tools 解析 vendor 优先。
- 新增回归锚:doctor-tests §5b/5c(提升布局解析/vendor 布局)+ bootstrap-tests §11(安装器 exit 非 0 但落盘 = 按状态判成功)。

### 安装

- 没变化,跑 `npx @danceiny/gotry web`。rc.19 用户跑一次 `npx @danceiny/gotry doctor` 复检——地图/ask-user 两项应转绿。

---

## v0.0.1-rc.19 · 2026-09-07

### What's New

- **修了 rc18 的 `invalid skill name "gotry_motivation_save"` 硬错误** — 在「查余额 + 规划旅行」的交界场景里,模型会把 gotry 的工具名当成宿主 skill 传给 skill 加载器,当场报错。现在人格契约写死了表层规则:gotry 的全部能力一律是工具调用(gotry_ 前缀),绝不进 skill 加载器;skill 调用报 invalid/unknown 就改回工具调用。
- **地图/路线/POI 工具上线** — `dsh-map-tools` 正式进依赖(零 API key,走 OSM/OSRM 开放源)。此前这个插件一直被启动流程静默丢弃;现在 doctor 体检(对话内 `gotry_doctor` 与终端 `npx gotry doctor`)都会如实告诉你它是否就位。
- **外部事件接缝(前两段)** — 新增只读通道探针 tick:站点断/上游不可达这类「带外事实」现在会写进通道健康面,检索改道建议与 doctor 即时受益,不用等用户撞上失败;愿望池召回也会否证「依赖通道当前不可用」的憧憬——不再硬推当下走不通的行程。
- **booking planner 连续加固** — factRef 指针清洗泛化、截断 finalResponse 恢复、UI 预载 offers 容忍、surface-policy 违规重试等一组修复(#172-#188)。
- **doctor 两面同口径** — 终端 CLI 与会话工具面现在报同一份体检清单(此前 CLI 缺 map-tools/ask-user 两项)。

### For Developers

- 通道健康面新增 `'ok'` 恢复事件语义(latest-wins 超越 down);外部事件接缝设计 `docs/design/external-event-seam.md` 三段中前两段落地,第三段(world2agent 远程桥)待 D-31 拍板。
- run-all 新增 §52(通道探针)/§53(愿望池否证)/§54(persona 表层护栏);行为契约仍 22 条((16) 内部澄清)。
- Node 下界仍为 22.15(低于此版本启动即拒)。

### 安装

- 没变化,跑 `npx @danceiny/gotry web`。

---

---

## v0.0.1-rc.18 · 2026-09-02

### What's New

- **修了一个让你卡死在终端的 bug** — 之前 `gotry web` 启动时如果没设 LLM key，CLI 会直接打一段「缺少 LLM API key」然后退出，根本进不了 dsh。但 key 是 dsh 那边管的事，不该 gotry 来挡。现在启动期只剩静默委托 dsh。
- **`gotry setup` 不再替你管别的依赖** — 之前它会顺手装 hbcli / agent-reach / dsh-better-sidebar 一堆与 gotry 无关的工具，现在它只检查一件事：浏览器扩展装好了吗。其他事归各自的宿主生态。
- **文档同步卸 key 引导** — README 中英、`user-guide.md` 不再让你「在 .env 里写 LLM_API_KEY」。

### For Developers

- 这一版主要是「让 gotry 在 CLI 层更像个插件」—— 它不再假装自己是入口，也不再要求用户配它本不该管的事。

### 安装

- 没变化，跑 `npx @danceiny/gotry web`，dsh 那边该弹什么弹什么。

---

## v0.0.1-rc.17 · 2026-09-02

### What's New

- **GoTry Session Bridge 上架 [Chrome Web Store](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd)** — 浏览器扩展已通过 Google 审核发布，一键装、自动更新、零系统弹窗。
- **插件安装回到浏览器的事** — 之前 gotry 在终端里既开浏览器又动剪贴板又弹原生面板，让安装体验变得很糟糕。现在直接打开浏览器商店点「添加至 Chrome」就完成了。`gotry session` 工具在会话检索里碰到扩展未装的状态，会把商店链接直接呈现给你，点一下就到。
- **携程会话面安装少踩坑** — 之前如果没装扩展就调用携程会话检索会卡住；现在扩展一装好，对话会立刻自动继续。
- **GitHub Releases 通道保留** — 想自己控制更新节奏、或不想通过商店审核，照样可以在终端用 `npx gotry setup --extension-from=github` 拉取最新版本。

### For Developers

- **扩展安装提示做了无缝衔接** — 之前需要装扩展时让用户在终端跑一长串命令，现在 gotry 的工具返回结果里直接带上 Chrome 商店链接，你做的客户端界面可以直接渲染成可点的链接。
- **Chrome 商店版与本地加载版完全互通** — 双通道用的是同一个扩展、同一个数据桥，所以即使中途从开发者模式加载版换到商店版，或者反过来，会话都不会断。

### 安装

- 推荐：浏览器打开 [chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) → 「添加至 Chrome」。
- 安装完毕后启动 gotry，工具首次调用如果还需要扩展，会自动检测到，不用重启。

---

## v0.0.1-rc.16 · 2026-08-30

### What's New

- **新接入 MiniMax 模型家族的费率** — 之前费率表只覆盖一家供应商；现在 MiniMax 的几款模型也都接入了，会更准确地把每次对话的真实成本算给你看。模型升级时也会自动按新费率结算。
- **自动监控几大供应商的定价变更** — DeepSeek、MiniMax、OpenAI、Anthropic 四家主流供应商的定价被周期性扫描。如果你在用之前可能会自动重新核价，但**永远不会自动改你的配置** —— 这件事仍然需要人来确认。
- **更新日志从此机器化** — 这次的更新日志还有不少人工痕迹，从下一版开始会从代码提交记录自动生成。你看到的「What's New」会是开发过程中的真实变更，而不是事后整理。
- **修复了一个让你重新跑出错的扩展问题** — 之前某些情况下连续跑 gotry 会让端口占用冲突、得手动重启几次才能复现；现在不会了。

### For Developers

- **发布流程变的稳** — 现在每次发版前会自动跑全量测试、检查更新日志、跑干净安装确认无误；这些以前都是手工，容易漏。

---

## v0.0.1-rc.15 · 2026-08-29

### What's New

- **预订流程的状态机开始有了正式的词表** — 当 gotry 在做预订相关的多步操作时（比如改签、取消、确认），它现在只会用一套预先定义好的动作。这是为了之后让多步操作可以被完整回放、被安全审计，不会出现「它到底跑到哪一步了」的模糊地带。

### For Developers

- 这一版主要是给下一代「可下单」能力打地基，对终端用户来说没有可见变化。

---

## v0.0.1-rc.14 · 2026-08-29

### What's New

- **文档有了中英文分开版本** — 仓库根的 README 现在一份英文、一份中文，看你自己熟悉的语言。npm 主页展示英文。

---

## v0.0.1-rc.13 · 2026-08-29

### What's New

- **登录自动检测** — `gotry session` 工具每次需要复用你已经登录好的携程账号前，现在会先默默读一下「是否已登录」这个事实。如果已经登了，直接就能搜，不用每次都弹登录。如果没登，才会打开登录页让你登。
- **登录页态度更明确** — 之前登录页有时会开在你看不见的位置；现在它一定会把你的浏览器焦点切到你登录页上，登录完你知道在哪。
- **绝不主动开浏览器** — gotry 的自检流程再也不会因为跑测试就把你的浏览器闪退或反复打开了一堆窗口；除非你显式开 live 模式。
- **README 重排成普通人能看懂的版本** — 顶部推荐 30 秒上手，分组成「搜什么、用什么、怎么用」三段，关于账号授权与隐私的四条硬规则被单独拎出来强调。

---

## v0.0.1-rc.12 · 2026-08-29

### What's New

- **酒店搜索接到了 OTA（飞猪官方）** — 之前查酒店只能用 gotry 自己的内部数据；现在它可以直接搜到携程、飞猪上的实时报价。这是只读搜索，零凭证，不会替你下单。
- **OTA 工具面扁平** — 不再有「这是主路径、这是降级」这种内部概念区分；从前端看上去就是一堆并排的工具，每个都能用。
- **动用你账号的工具会先弹确认卡** — 任何用到「你在携程的账号」的工具，第一次在每个会话里调用时都会先和你打个招呼——批准后才能用、本会话内记住；如果你拒绝了，这个会话就不再弹、也就不再执行。
- **登录现在是一个工具** — 之前要登录会跳到命令行，现在 gotry 里直接调 `gotry_session_login`，它会在你自己的浏览器里开登录入口页面，登录你正常做完就行。**登录永远发生在携程官网，gotry 不会接触你的密码、验证码、cookie 值** —— 它只会看一眼「登没登录」这个布尔事实。

---

## v0.0.1-rc.11 · 2026-08-29

### What's New

- **Z3 计算引擎的并发竞态根治** — 之前在某些压力场景下，会出现反复求解失败、需要重试一次的隐藏问题；现在彻底修好了，可以并发跑。
- **实时票价可选开启** — 默认是关的。如果你的型号或场景需要用到实时报价，可以在环境里打开 `GOTRY_REALTIME_PRICING=1`，gotry 会去飞猪官方核实航班实际价格覆写进答案；找不到精确票价时会退回静态包，不会假装实时。
- **英文输出** — 现在 gotry 的中文/英文界面切换已经全部落地，`GOTRY_LOCALE=en` 切换。
- **README 之前四条「已知限制」清完了两条** — 实时票价的桥和英文界面都在这一版完成。

---

## v0.0.1-rc.10 · 2026-08-28

### What's New

- **Web 与本地一套账本语义** — 如果你之后想把 gotry 部署成供多人用的 Web 服务，它和你自己本地用同一套数据底座；用户是谁会在账本里有一等列，但单用户阶段你看不到区别。
- **一句话播报** — 上一版安装后首次启动的「装上了跑不起」问题，现在会引向 npm 完整安装流程而不是把崩溃栈糊你脸上。

### For Developers

- **rc.9 装的扩展跑不动的根治** — rc.9 装上的扩展有一个隐蔽 bug 让 npm 形态装完不能加载扩展；rc.10 同时根治并把这个检查固化进了发布前必跑的预验证脚本里。
- **依赖面补齐** — 包内多带了 SQLite（账本）、puppeteer-core（浏览器调试）、DeepSeek dsh 系列几个被 peer 钉住的版本依赖。

---

## v0.0.1-rc.9 · 2026-08-28

### What's New

- **17 个工具** — 记忆域（动机画像、旅行时间线、同行人、时间窗衰减）、事务化状态基座、会话面（携程官方 + 你自己的账号交叉验证）合流；这是开发主线 30 个 commit 一次性合入。
- **你现在去哪里过，过去去过的地方不再被推** — 动机画像和旅行历史开始进入推荐扣分。
- **节假日锚点扩到 2031** — 春节、中秋、国庆这些长假的「时间锚点」现在不会被预设漏掉了。

---

## 之前版本（rc.8 及更早）

rc.8 是首次带「记忆域 + 时间感硬化」骨架的发布；rc.7 是在真实用户对话数据上完成 7 题对账的终局版本；更早（rc.1 到 rc.6）属于内部迭代。如果你正在从更早跳上来，关键变化是：

- 当前推荐装法：`npx -y @danceiny/gotry@latest`（或 `@rc`）
- 携程会话检索需装浏览器扩展 —— 见上面 rc.17 那段
- 一切外部依赖安装统一收口到 `npx gotry setup`

---

## 还没解决的(仍可能影响你)

- **真实用户样本证据还没收完** — M3(内部里程碑代号,「产品基本可用」)要算真正完成,需要跨多个真实种子用户跑出来的定稿率、NPS、地理问答幻觉率;当前为 0。
- **会话面只覆盖携程(机/酒/火)** — 美团本地仍是盲区(匿名 403,登录态是硬前置)。
- **英文界面还存在小尾巴** — 切换到英文后,还有极少数角落的中文没有翻译完。
- **实时价格默认是关的** —— 打开后端到端比静态包慢一点;不在意的就开着。