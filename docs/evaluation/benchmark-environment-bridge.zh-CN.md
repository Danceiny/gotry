[English](benchmark-environment-bridge.md) | [简体中文](benchmark-environment-bridge.zh-CN.md)

# 外部 benchmark 环境桥

> 状态:活的工程台账(Phase 1 治疗接缝;default-off,非产品运行时依赖)。

本文档覆盖外部 benchmark harness 的可选 Phase 1 治疗接缝。它不是产品运行时依赖,自身不调度、不启动、不支出、不评分,也不主张 benchmark 提升。

## default-off 与 owner-local 配置

除非 `GOTRY_BENCHMARK_ENV_CONFIG` 指向一个绝对路径、常规文件、非符号链接、属主为当前 POSIX uid 的 JSON 文件,桥保持禁用。文件上限 64 KiB,且不得 group/world 可写。这是 opt-in 机制,必须留在受跟踪/公开的证据之外。声明不等于强制:禁写与断网必须由宿主 OS 或等效沙箱强制执行。

变量一旦设置,schema 非法或活跃子进程 provider 不可用,就在任何模型请求之前硬失败;显式 opt-in 绝不回退到无桥的普通 GoTry 运行。

## 冷启动工具面隔离

opt-in 是进程启动边界。agent 已存活时安装即失败;绝不热挂到既有会话。其后每个 benchmark agent 都被强制为 native 工具呈现,并被限制在桥注册后捕获的那个精确全局 `gotry_benchmark_environment` 定义上。仅匹配名称不够:agent 作用域的同名影子在分发时被拒绝。

最终权威的 `system-prompt/assemble` 结果必须恰好包含捕获的桥 schema。所有下游 `agent/pre-step` 监听器返回之后,注册表 schema 与定义身份再查一次。多出的 scoped 工具、schema 篡改、同名影子、或残留的 PTC `run_code` 传输,因此在模型请求之前失败。每 agent 的 guard/呈现/限制效果原子安装,部分安装即回滚。agent 释放时随之释放。若插件先卸载,存活 agent 保留一个 agent 自有的组装阻塞器及其 scoped guard/限制,作为 fail-closed 隔离:后续模型请求不再进入剩余组装链,桥/非桥分发都被拒绝,直至该 agent 或进程被释放。HMR 无法热挂到旧 agent。

## benchmark 启动组合隔离

owner-local 配置验证通过之后、任何可选宿主插件被解析或导入之前,CLI 把顶层 patch insert 序列投影为恰好一个 `gotry-tools` 项。calendar、map、ask-user、内联/重排的未知项、以及未来的非 GoTry insert,只在 benchmark opt-in 时被丢弃;default-off 启动保留普通 GoTry 组合。`gotry-tools` 缺失或重复即 fail-closed。

配置路径随后经恰好一个 `hbcliBin` 锚点注入该投影项。锚点缺失/重复,或已存在 config-path 字段,都在可选插件解析、dsh spawn、中继活动之前失败。错误信息稳定,不反映包路径、配置路径、插件名或 benchmark 内容。

## agent 一致性与终结闸

benchmark opt-in 仅限无头 one-shot 形态。GoTry 追加 agent 作用域的 native 执行合同,把 prompt 里对 CLI、shell、Python 或 `agent_env.cli` 的引用翻译为对唯一可见工具 `gotry_benchmark_environment` 的结构化调用。`action:"tools"` 仅用于发现。一个可计数 turn 必须发出一次被允许的 `action:"call"`,并收到其配对的具体结果或已声明领域结局,然后才能停止。调用形状是扁平的;已退役的嵌套 `query` 形态不被接受。领域结局可以支撑一个终结响应,或支撑此后模型自拟的参数修订,但桥不重试。更晚的基础设施失败会使此前仅领域的路径失效;更晚的具体结果可以挽回它。任何情况下,被接受的终结响应必须晚于最新的桥响应,过期终结无法掩盖更新的证据。

Round 11 把模型侧请求 schema 变为一个扁平对象:`action` 是 `tools|call|errors` 枚举,`tool` 是从冻结描述符集合派生的枚举,`arguments` 是通用对象。这只是 wire/schema 可见性变化。执行时桥仍按所选冻结描述符的 `input_schema` 精确校验 `arguments`;通用的模型侧 arguments 不削弱执行合同。

owner-local 配置还声明一个通用的 tagged-JSON 终结信封。tag 是有界标识符,`max_bytes` 上限 1 MiB。合法终结响应是恰好一对匹配 tag,其 body 为一个 JSON 对象;散文、代码围栏、重复 tag、数组、标量、尾随文本、超限 body 一律 fail-closed。配对的推理块(`<think>…</think>`,大小写不敏感,任意位置)在本校验之前被剥离:当代推理模型即使被要求只用信封作答也会输出它;其余任何前导/尾随文本仍 fail-closed。这只是语法一致性:业务 schema 仍归外部适配器与官方评估器所有。

模型试图在没有真实桥调用时停止,或在成功调用后返回畸形终结响应时,GoTry 至多注入一次固定的一致性纠偏。终结格式纠偏必须复用既有工具结果,不得再次派发桥。第二次违规则以一个稳定错误终结 turn,该错误不反映 prompt、arguments、工具结果、路径或非法响应本身。父 CLI 另行缓冲有界 stdout,只有子进程成功退出且同一终结解析器接受时才释放;被拒绝的 assistant 文本绝不作为成功的 benchmark 结果转发。

示例(仅占位路径):

```json
{
  "schema_version": "gotry_benchmark_environment_bridge_v3",
  "enabled": true,
  "executable": "/OWNER-LOCAL/bin/node",
  "cwd": "/OWNER-LOCAL/harness",
  "argv_prefix": ["/OWNER-LOCAL/harness/runner.js"],
  "tools": [
    {
      "name": "lookup",
      "description": "Look up one city.",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "City name." }
        },
        "required": ["city"],
        "additionalProperties": false
      },
      "output_keys": ["city", "country"],
      "domain_outcomes": [
        { "status": "miss", "code": "NOT_FOUND", "recovery": "revise_arguments" }
      ]
    }
  ],
  "timeout_ms": 30000,
  "max_output_bytes": 65536,
  "terminal_output": {
    "tag": "output",
    "max_bytes": 65536
  },
  "isolation": {
    "mode": "host-enforced",
    "writes": "forbidden",
    "network": "denied"
  }
}
```

executable 与 cwd 绝对且固定。调用使用带配置前缀的 argv 列表;任意 shell 字符串、shell 插值、任意命令都不暴露。`tools` 是有界非空描述符集合,是发现、模型可见工具名枚举、精确 spawn 前校验的唯一来源。每个描述符必须有非空 description、闭合有界的对象 `input_schema`、非空且唯一的 `output_keys` 白名单、以及有限的精确 `domain_outcomes` 列表。开放嵌套对象、未知 schema 关键字、重复的名称/键/结局、无界数组、自由文本 recovery 值,在配置加载时失败。v1/v2 文件必须显式迁移;绝不以含糊行为被接受。

模型看到一个扁平对象根:`action` 是 `tools|call|errors` 枚举,`tool` 是描述符派生的名称枚举,`arguments` 是通用对象。在这条 provider 侧 wire 上,只有 `action` 无条件必填。任何子进程启动之前,执行层强制精确的 action 形状,并按所选冻结描述符的 `input_schema` 校验调用参数;空对象、嵌套 legacy `query`、混合 action、缺 call 字段、多出字段的对象一律 fail-closed。`tools` 返回冻结描述符。`errors` 返回完整的闭合桥协议/基础设施失败清单。这些失败使用 `{"ok":false,"error":"..."}`,区别于适配器领域结局——后者在精确的已声明 exit-zero 信封之后使用 `{"ok":true,"outcome":{...}}`。两类失败桥都不自动重试。

具体结果要求:每个可见对象键——含数组与嵌套对象之下的键——都必须列在该描述符非空的 `output_keys` 中;因此每个标量叶都必须有已声明键的祖先。顶层记录数组可以通过;无键标量数组或混合数组 fail-closed 为 `{"ok":false,"error":"forbidden_output"}`,不回显其值。`terminal_output` 仍然必填:其标识符形态的 `tag` 定义唯一被接受的信封,其正数 `max_bytes` 上限 1 MiB。超时与输出上限由子进程接缝强制;非零退出、超时、截断、非法 JSON、未允许工具都返回结构化失败信封。子进程只接收选定的 `PATH`/locale/时区值,外加 Python no-user-site/no-bytecode 守卫;其余环境变量名一律显式移除。模型参数只序列化一次;UTF-8 大小、深度、结构计数超出桥上限,即在 spawn 前拒绝。

运行器输出必须是一个有界、精确的 `gotry_benchmark_tool_result_v1` 对象:要么 `{schema_version,status:"ok",result}`,要么 exit-zero 且描述符已声明的 `{schema_version,status:"miss"|"error",code,recovery}`。含糊字段或多出字段 fail-closed;非零进程退出永远是基础设施失败,即使 stdout 看似领域信封。桥递归拒绝与 gold、oracle、期望答案、参考答案、label、score、reward、ground truth、hidden query、loader 元数据相关联的 ASCII 键,且不向模型回显键或值。非 ASCII 键与标量顶层结果被拒绝,输出结构另设上界。benchmark 适配器只可提供已声明的可见工具面,其 query loader 与 Python/harness 运行时必须留在 GoTry 产品依赖图之外。产品运行时不新增任何 Python 依赖。

已验证配置的属主,是选择 executable、cwd 与固定 argv 前缀的权威。桥不主张每个被引用路径都归属主所有:root 属主的沙箱 executable 与 virtualenv 符号链接是合法部署选择。因此治疗准入必须栅定精确的适配器/harness 修订版,并审查其正向可见输出合同。递归键守卫是纵深防御,不是语义证明——防不住藏在其他合法字符串值里的秘密。

## 验证边界

校验器与注册合同可用以下命令离线检查:

```bash
cd ts
npx tsx scripts/benchmark-environment-bridge-tests.ts
npx tsx scripts/benchmark-environment-bridge-e2e.ts
```

E2E 只用环回合成模型中继、临时 owner-local 运行器、隔离的 `DSH_HOME` 与 cwd、以及合成 key。它始终演练 source checkout。设置 `GOTRY_BRIDGE_E2E_BIN` 时,额外演练该干净安装包 CLI。变量缺省时,标准回归自建临时干净 consumer;CI 则显式准备同一路由,因为历史上的 root npm lock 不是发布 consumer 的依赖闭包。

覆盖的行为:

- default-off 行为、环境隔离、私有配置拒绝、真实输出截断、真实 deadline、全局 `both` 模式被覆盖为单一 native 桥 schema,以及 source/安装包请求均不暴露其他模型工具。
- 干净包投影夹具,带可执行的内联/重排 future 插件:default-off 必须真的把 poison 插件加载进来,而 benchmark opt-in 必须记录零加载且仍到达桥。
- `gotry-tools` 缺失/重复、注入锚点缺失/重复、已存在的 config-path 字段,都必须在中继活动之前停止。
- 一致性用例:散文/无调用纠偏、一次真实 native 调用后接 tagged JSON、仅格式的一次重试、重试耗尽、父进程 stdout 抑制;配对推理块归一化;仅领域、领域转结果、领域转失败、过期终结时序。
- 描述符/结果用例:扁平 `tools|errors|call` 分支、完整桥失败清单、schema 的 max/max+1 边界、精确适配器信封、非空正向 output keys、标量/混合数组、以及声明 miss 后模型自拟的修订调用。
- 单元合同:存活 agent 拒绝、同名身份影子、最终组装/pre-step schema 漂移、agent 清理且不双重释放、插件卸载隔离。

以上均非 ChinaTravel 治疗证据。

## Round 台账

迄今所有冻结治疗均仅诊断:官方分数为 null,不主张任何提升或外部 benchmark 闭环。

### Round 2 — 首次冻结治疗

provider 预检与规划器成功,但运行器在评估前返回 3:agent 只描述了想执行的 CLI/工具动作,没有结构化桥调用,也没有可解析的 tagged JSON。官方分数 null([证据](https://github.com/Danceiny/gotry/discussions/78#discussioncomment-18215707))。

### Round 3 — agent 一致性

新增 provider 无关的一致性层(prompt 中 CLI/shell/Python 引用映射到唯一 native 桥的 `query.action=call`;一次固定纠偏;tagged-JSON 终结闸)。新冻结治疗在运行器 spawn 一次后停止:planner/runner exit 1、释放的终结字节为零、未进入评估器、官方分数 null([证据](https://github.com/Danceiny/gotry/discussions/78#discussioncomment-18232139))。

### Round 4 — 启动组合隔离

CLI 在任何可选宿主插件解析之前,把 config 验证过的顶层 insert 投影为恰好一个 `gotry-tools` 项;锚点/名称唯一性在中继之前 fail-closed。SHA `5ebddb2` 的治疗 primary 预检通过,但 planner 与 runner 都在 30.968s 后 exit 1,释放的终结字节为零,从未进入评估器,官方分数 null。产品 Node 闸为 v24.20.0,而该治疗用 v26.3.0,故仅诊断。GitHub Node 22/24 §48 另行暴露 source default-off 下 30 秒生命周期挂起。

### Round 5 — 无头生命周期围堵 + 运行时解析

范围:移除 timer/keepalive 预载;把 root/package DSH `0.1.2-alpha.3` 闭包中全部 216 个包声明为精确直接依赖;要求 manifest、package lock 与 root pnpm importer 暴露同一个 216 名称集合;publish preverify 对遗漏、混版、range 声明失败;source checkout 中锁定运行时先于 legacy vendored 回退解析;source 普通模式在 `ts/dsh-runtime/gotry-state/` 下保持状态连续,benchmark opt-in 与 npm 包运行则使用调用目录;spawn 前拒绝非 alpha.3 的 benchmark 运行时;强制 Node 22.15+;新增 benchmark 专用结构化诊断管道,原因码白名单化且脱敏,stdout 仍 fail-closed。

代码 SHA `752e54c` 的冻结治疗在 140.715s 后以 `child_nonzero_exit` 停止,终结字节为零,评估器/官方分数 null。lock 一致性后继不重写该 UID 归因。

### Round 6 — 结构化终结诊断

在不读取原始 stderr 的前提下,收窄 `child_nonzero_exit` 的剩余歧义。benchmark 一致性只观察最终结构化 `turn/end.reason`,把白名单内的模型码或有限 HTTP status 值映射为闭合的 auth、capacity、server、transport、stream、request、generic runtime 族;blocked、max-token、aborted、interrupted 也是闭合枚举。每会话仲裁器至多写一次;面对更晚的通用终结错误,保留更具体的桥/一致性失败。在最终 turn 结束前自行恢复的瞬时模型错误不发任何失败。自由格式的 message、路径、prompt、request ID、凭证,既不检视也不回显。仅诊断:stdout、重试策略、prompt、工具、评估器行为、评分均不变。

代码 SHA `c61600b` 的冻结 ChinaTravel 治疗,使用干净安装 tarball 的 SHA-256 `8df65b69873034df282dfa126ab93171fa9f1d4177cf17c5f9c694e737ff1161`、UID `phase2_familiar_20250321040138918100_00001`、`deepseek-v4-flash`。它在 49.546s 后停止,父侧原因 `child_runtime_error`,终结字节为零,评估器/官方分数 null。泄漏扫描与本地凭证/端点扫描均为零。其后的仅文档后继不重写治疗归因。

### Round 7 — 最小内核

benchmark opt-in 是代码 SHA `edb9392896625adbb48abae4a2ecf968dbfc0349` 上的最小内核:保留工具预算、模型覆盖、单一 native 桥、隔离/一致性;产品 prompt 变量、进程守卫、consent 钩子、普通 GoTry 工具都不安装。默认路径不变。CLI 投影一个稳定、任务无关的 persona,只接受恰好一个规范根 `insert` 项与一个规范 `system-prompt` 项;缺失、重复、加引号、重排、flow、其他非规范根项一律 fail-closed。

该治疗使用 tarball SHA-256 `506f20f01966663cb30231df72e7163661402a61cf6d96691972c72cebb24e79`、UID `e20241028160248698752`(`easy`)、`deepseek-v4-flash`。预检通过,无回退;80.463s 后运行器 exit 1,终结输出为零/非法。评估器未进入,官方分数 null,case 不可计数。白名单原因为 `child_bridge_runner_failed`。下一个优化问题是通用桥工具 schema 与可恢复领域错误合同,不改 provider 路由,不改评分。

### Round 8 — 通用桥动作与恢复清单

桥 query blob 变成一个扁平、带类型的控制面:`action=tools|call|errors`,调用时带 `tool` 与结构化 `arguments`。`action=errors` 暴露完整闭合的桥协议/基础设施失败清单,附稳定恢复指引。这让发现、调用、恢复都与 provider 无关,且不改变 owner-local executable 边界。

### Round 9 — benchmark 治理预算与终结归一化

Round 9 经 `LLM_MAX_TOKENS` 钉定显式模型输出上限,并允许每次冻结 benchmark 运行设置经校验的软/硬预算,同时保留 60/120 秒默认值。它还在应用其余不变的严格终结校验器之前移除配对推理块。首个诊断治疗贯穿全链并实际演练 ChinaTravel 工具面,但未产出官方、可归因的 benchmark 分数,也未达成外部闭环。

### Round 10 — 每工具类型化结果合同加固

Round 10 保留 Round 8 的单一扁平协议,并为每个描述符派生一个精确 `call` schema。同一份闭合/有界的 `input_schema` 既展示给模型,也在 spawn 前应用;空协议对象或混合协议对象 fail-closed。描述符还要求非空 `output_keys` 与有限的精确 `domain_outcomes`。

适配器 stdout 必须是一个精确的 `gotry_benchmark_tool_result_v1` 信封。只有每个标量叶都位于已声明 output key 之下,具体结果才被接受。已声明领域结局是 exit-zero 的传输成功,模型可据此修订参数;桥绝不重试。非零退出、超时、截断、畸形 JSON、结果/领域歧义,仍属基础设施或一致性失败。tagged 终结输出必须晚于最新桥响应,旧终结无法掩盖更晚的领域或基础设施事实。

本轮不改 provider 路由、评分器、评估器、默认产品路径。冻结治疗与任何分数/提升主张,都需要单独的溯源绑定证据。

### Round 10 治疗诊断与 Round 11 — 扁平模型侧 wire

main `c843fae` 上的真实 `glm-5.3-flash` 治疗诊断出 provider/模型对顶层 `oneOf` 桥 schema 的可见性失败:该治疗发出 57 次空 `{}` 调用,未产出可计数分数。Round 11 因此只把模型侧桥 wire 改为一个扁平对象:`action` 枚举 `tools|call|errors`、描述符派生的 `tool` 枚举、通用对象 `arguments`。执行时校验仍按所选冻结描述符的 `input_schema` 精确执行。provider 路由、评分器、评估器、默认产品路径、外部 data/oracle/query/trajectory 输入、私有路径、凭证都不变;不主张任何分数或提升。

### Round 12 — 精确终结 schema 投影(#215)

wire 可用之后(Round 11),Round 11 冻结治疗暴露出下一个瓶颈:GoTry 只告诉模型「one JSON object」,模型于是添加根键、把 day 行写成直接 activities,官方评分器按约定 22 次拒绝 body 而未运行。

Round 12 收口结构半场(issue #215):桥配置携带不含数据值的闭合 `body_schema`;同一结构合同以一份确定性大纲投影进 system prompt 与唯一一次终结纠偏;每个被接受的终结 body 都按它 fail-closed 校验——多余根键、缺失 `day`/`activities`、错误类型、嵌套多余字段一律拒绝,无 autofix。配置面升至 v4;v3 及更旧配置 fail-closed。source 测试 + source/打包 E2E 覆盖合法的类 ChinaTravel 层级、Round 11 的五个拒绝类、单一来源投影。冻结重跑(同 case、同模型、同预算;仅合法终结到达钉定的官方评分器)是剩余段,在本 SHA 尚未运行;不主张任何治疗或提升。
