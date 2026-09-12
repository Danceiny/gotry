[English](lavish-local.md) | [简体中文](lavish-local.zh-CN.md)

# Lavish 本地会话适配器（#443，父需求 #438）

> 状态：**有界适配器切片（2026-09-12，issue #443）**。本文对应已落地的本地 `lavish-axi` 会话生命周期适配器
> `ts/capabilities/lavish-local.ts` 与测试 `ts/scripts/lavish-local-tests.ts`。产品注册（插件接线、六处状态面、
> `run-all-tests.sh`）属于 issue #442/#438，**刻意不属本切片**；真实浏览器反馈路径仍未验证，见 §7。
> §2 的每一条协议事实都读自已安装的 `lavish-axi@0.1.67` 包本体，而非文档描述。

## 1. 本切片回答什么

GoTry 需要把生成的 HTML 产物交给真人做视觉评审并取回反馈，同时不自建评审 UI。Lavish Editor 以一个本地 CLI
（`lavish-axi`）提供该 UI，并带真实可用的 open/poll/reply/end/stop 协议。本适配器就是让 GoTry 驱动该协议的接缝，
且**不**成为 Lavish 浏览器界面、 watcher、会话存储或 HTTP 控制面的第二个所有者。

适配器的边界刻意收窄：它只拥有自己启动的进程组、自己创建的 state 目录、自己分配的回环端口，别的一概不碰，见 §5。

## 2. 已核实的协议事实

上游 pin：`lavish-axi@0.1.67`（MIT，`engines.node >= 22`），发布包的 `bin` 指向 `dist/cli.mjs`。以下事实来自读源码与实跑：

- **输出是 TOON，用官方解码器解析。** `axi-sdk-js@0.1.11` 依赖 `@toon-format/toon@^2.1.0`，实际解析到 `2.3.1`；
  适配器按该精确版本引依赖。没有 `--json` 开关，也不是 YAML。**失败同样走 stdout**，形态为 TOON 的
  `{error, code, help?}` 对象并带非零退出码（`VALIDATION_ERROR` 为 2，其余为 1），因此适配器检查 `error` 键，
  而不是只信退出码。
- **命令集：** `open`、`poll`、`end`、`stop`、`server`。`update` 是 SDK 自升级，本适配器从不调用；`setup hooks`、
  `setup plugin`、`share`、`export` 同样从不调用。
- **`open`** 返回的 `session.status` 只有 `opened` 与 `user-ended`。只有用户主动结束才会阻止普通重开——适配器从不传 `--reopen`。
- **`poll`** 的状态为 `waiting`、`feedback`、`ended`、`browser_disconnected`。`waiting` 什么都没消费，可以安全地再轮询；
  而 `feedback` 的投递**本身即消费**。会话不存在时返回的是 `NOT_FOUND` 错误对象，不是某个状态。
- **`server`** 是长期运行的 HTTP 控制面。没有进程在跑时 `stop` 依然有明确定义（`server.status: not-running`）。
- **最后一个会话结束且无连接时，server 会自行退出。** 因此适配器把「自己启动的 server 已经不在」当作 `stop` 的正常结果，
  而不是错误。

## 3. 适配器 API

`LavishLocalSession.create(options)` 返回实例。每个方法最多执行一次 CLI 调用，并返回可判别结果——`ok: true` 的值，
或 `{ ok: false, code, detail }` 失败。适配器内部不重试。

| 方法 | 协议调用 | 结果 |
| --- | --- | --- |
| `open(path)` | `open <realpath> --no-open` | `opened` / `user-ended`，附回环会话 url |
| `poll(path, {timeoutMs})` | `poll <realpath> --timeout-ms <n>` | `waiting` / `feedback` / `ended` / `browser-disconnected` |
| `reply(path, text, {timeoutMs})` | `poll <realpath> --agent-reply <text> --timeout-ms <n>` | 与 `poll` 同形 |
| `end(path)` | `end <realpath>` | `ended` |
| `stop()` | 只对自己拥有的进程组，绝不调用 CLI 的 `stop` | `stopped` / `stopping` / `not-running` |

`reply` 就是协议自身的 `poll --agent-reply` 调用：一次调用内既回答反馈又等待下一个状态。回复文本会被校验为非空、
且不是裸的 `--` 终止符，因为 CLI 的参数解析会静默丢弃这两种。

选项都可信且显式：`cliPackageRoot`（已安装包目录）、`cwd`、`allowedRoot`（默认取 `cwd`）。不存在任何接受命令文本、
shell 字符串、待劫持端口或环境态 state 目录的选项。

## 4. 信任边界：产物路径与反馈载荷

**产物路径按 realpath 走白名单。** 输入必须是 `.html`/`.htm` 文件；相对输入按 `cwd` 解析；随后要求规范路径落在
`allowedRoot` 内，且任何 `.git` 或 `node_modules` 路径段都被拒绝。由于包含性检查发生在**符号链接解析之后**，
指向根之外的符号链接会被拒绝而不是被跟随。适配器只消费路径——它没有写 API，从不改写产物，也从不为了「更新内容」
重跑 `open`。内容更新是调用方（或 watcher）的事，因为 CLI 自身的 `next_step` 契约就是 Lavish 会对已保存的产物自动 live-reload。

**反馈是数据，永远不是权威。** CLI 打印的关于用户的一切——prompt 文本、selector、tag、附件引用、artifact failure、
DOM 快照——都在标记为 `trust: 'untrusted'` 的 `LavishUntrustedFeedback` 值里返回，并带字节/数量上界与逐集合的截断标志。
适配器刻意丢弃 CLI 的 `next_step` 指令文本而不转发：那是直接写给 agent 的第三方措辞，不能以系统权威的身份抵达。
附件引用只投影 `id`/`name`：适配器对反馈**不做任何文件系统访问**，也从不跟随浏览器给出的路径。

**Prompt vs text：两个独立字段。** 每个投影出的 prompt 都同时携带 `text`（选中元素的上下文——自由输入时上游把它置为占位
字符串 `"Freeform message"`，批注时是元素的 `tagName` 小写加上 `el.innerText.trim()` 的选中片段）与 `prompt`（用户在聊天框里
实际提交的指令）。上游从 prompt 提炼聊天消息的过滤器是
`acceptedPrompts.filter((p) => p.tag === "message" && p.prompt)`（见 lavish-axi `dist/cli.mjs` 用户消息投影处，约 7720），
因此没有 `prompt` 字段就把请求丢在了地上。适配器**绝不**用 `text` 替代 `prompt`：缺字段或非字符串的 `prompt` 在投影中以
`prompt: ''` 呈现，并计入 `LavishUntrustedFeedback.promptsMalformed`，让丢弃可被审查。空串 `prompt`（合法的「不带文字、
只要附件」请求）按数据原样保留，**不**计为畸形。批注 tag 是真实的 HTML 元素名（`h1`、`div`…）——见上游 `context()` 约 5359——
并非字面量 `"text"`。

**什么都不打日志。** 适配器不含日志，不向 stdout 或 stderr 写任何字节。会话 url 内嵌不透明访问键，因此导出了
`redactLavishSessionUrl` 供需要展示的界面使用；失败详情在返回前即已打码；并有测试断言一次完整生命周期对两个流零写入。

## 5. 所有权：进程组、state 目录、端口

每个实例恰好拥有一个 `lavish-axi server` 子进程，以 **自己的进程组** 启动，参数用数组传、`shell: false`，
从不拼接命令字符串，因此回复文本或路径都无法被 shell 展开。清理时先向进程组发 `SIGTERM`，等待，再 `SIGKILL`，再等待；
每次 CLI 调用都在返回结果前完成回收——适配器不会留下任何 poll 或 server 残留。

每个实例还拥有一个 `mkdtemp` state 目录和一个**自己分配的、未被占用**的回环端口。子进程环境是从零构造而非继承：
只有 `PATH`、被重定向到自有 state 目录内的 `HOME`，以及六个显式 `LAVISH_AXI_*` 变量会到达子进程。调用方环境里的
`LAVISH_AXI_*`（含通配 host 白名单或 idle-timeout 覆盖）与任何 Tailscale 变量都被丢弃，因此全局 `~/.lavish-axi`
配置、hook 文件与 Tailscale 绑定都无法被触达。`LAVISH_AXI_TELEMETRY=0`、`LAVISH_AXI_NO_OPEN=1`、
`LAVISH_AXI_HOST=127.0.0.1`、`LAVISH_AXI_LINK_HOST=127.0.0.1` 恒被设置，因此会话 url 不会离开回环，也不会驱动浏览器。

**本适配器没有启动的 server，绝不被接管、抢占或关闭。** 启动前先探测自己端口上的健康端点，只要有应答就失败关闭。
启动后，只有当自有子进程仍存活**且**健康载荷报告 pin 住的 `app`/`version` 时，该 server 才算「我们的」；后续每条命令都受同一
检查约束，因此 CLI 的 `ensureServer` 总会复用我们的子进程，而不会自行另起一个 detached server。`stop` 只对自己进程组发信号，
当没有属于我们的东西可回收时报告 `not-running`。测试同时覆盖外来监听者与**既有同版本** `lavish-axi` server，并断言两者都未被发信号。

## 6. 有界行为与未知结果

两条流的响应都有字节上界，每次调用也有墙钟上界。poll 总是带显式 `--timeout-ms`（受 `maxPollTimeoutMs` 约束），
因此 poll 会以 `waiting` 干净返回而不是永久挂起；`waiting` 没有消费任何东西，可以再次轮询。

唯一危险的情形被刻意做成不静默：若适配器自身 deadline 触发并杀死 poll，结果就**真的未知**——投递可能已消费反馈，也可能没有。
适配器记录该状态，并以下一个 `poll` 返回 `poll-outcome-unknown` 的方式拒绝继续，而不是冒重复消费的风险；必须由调用方显式决定，
通常意味着新建实例。用户主动结束同样粘滞：一旦 `open` 返回 `user-ended`，或某次 poll 报告 `ended_by: 'user'`，实例即闭锁，
后续 `open` 以 `session-user-ended` 失败而不会重开。

## 7. 不在本切片内（显式 TODO）

- **真实浏览器反馈未验证。** `feedback` 载荷形状、`--agent-reply` 回显、`browser_disconnected` 宽限行为，目前只在合成
  fixture 载荷上演练过，从未经过真实浏览器会话。「真实浏览器反馈 E2E」在任何产品口径之前都是必需的，属 root 负责的 #438 后续。
- **无产品接线。** 本切片不触碰 `ts/src/index.ts`、client 界面、六处状态面与 `run-all-tests.sh`；接线是 #442/#438 的工作。
- **Lavish 不是产品依赖。** 只有解码器（`@toon-format/toon@2.3.1`）进入 manifest 与锁文件。适配器在运行时被交付一个已安装 CLI 路径；
  CLI 本身不被 vendor 进产品依赖树，DSH 客户端卡片注册（`tool.call.toolview`）也未被触碰。
- **不支持的反馈形状保持不透明。** whiteboard/excalidraw target 与附件只做有界化并标记为不可信，不做深度建模，
  因此产品界面不得依赖 `id`/`name`/`type` 之外的字段。

## 8. 证据与运行方式

`ts/scripts/lavish-local-tests.ts` 分两部分。离线部分确定性强且不需要网络：构造一棵合成的 `lavish-axi` 包树，覆盖
CLI 可信性拒绝（错包名、非 pin 版本、非 pin 入口、入口缺失、入口逃逸）、路径白名单、argv 形态、无 shell 保证、
字节/超时上界、畸形与意外 CLI 状态、反馈上界、进程组回收、user-ended 闭锁、外来端口拒绝、双实例隔离，以及零写入断言。

在线部分为显式启用（`GOTRY_LAVISH_LIVE=1`），从公共 registry 把 pin 版本安装进唯一的 `mkdtemp` npm 前缀
（`--no-save`、`--ignore-scripts`、绝不全局），然后在适配器自有端口上对合成 HTML 产物实跑真实 CLI 的
`open` / `poll --timeout-ms` / `end` / `stop` 协议，包括回收一个活着的自有 server。它会打印 argv 与退出码作为 transcript。

```
cd ts && npx tsx scripts/lavish-local-tests.ts
cd ts && GOTRY_LAVISH_LIVE=1 npx tsx scripts/lavish-local-tests.ts
```
