[English](trigger-drill-report-core.md) | [简体中文](trigger-drill-report-core.zh-CN.md)

# 触发演练报告：核心休眠跟踪单

> 定位：记录模拟外部触发对 #82、#275、#422 三个休眠跟踪单的激活机制证明了什么、又没有证明什么。
> 状态：living（2026-10-04）。仅模拟触发演练；三个跟踪单全部保持开启。
> 上游：[#82](https://github.com/Danceiny/gotry/issues/82)、[#275](https://github.com/Danceiny/gotry/issues/275)、[#422](https://github.com/Danceiny/gotry/issues/422)；[架构](../architecture.zh-CN.md) D-15 行与第 10 节；[外部事件接缝](../design/external-event-seam.zh-CN.md)；[回调方决策模板](../design/callback-party-decision-template.zh-CN.md)；[事务化状态 RFC](../rfc/transactional-state-rfc.zh-CN.md)。
> 下游：D-15 与 D-31 决策面；run-all §81、§82、§83 的审查者。

## 证据边界

**模拟触发不是真实触发。** 本文每一项结果在测试套件内部都带 `simulated_trigger_drill` ／ `synthetic` 标签。演练的目的是在真实触发到来之前先把激活路径跑通，它们**不**满足任何跟踪单的触发条件，**不**构成真实回调方、真实用户或真实供应商证据，也**不**改变任何准入闸。三个跟踪单全部保持开启。

这里算证据的东西：真实的 OS 子进程、`mkdtemp` 根上的真实 SQLite 文件、真实安装的 dsh SDK dispose 路径、真实的 `bin/gotry-process-liveness.js` 清理面、`ps` 给出的真实进程表事实，以及 OS 级的 Node 权限模型。

这里不算证据的东西：一个发 envelope 的夹具进程不是 sensor 供应链；N 个子进程不是第二个用户；一个夹具 `dshBin` 不是产品调用面。全程零网络、零模型、零凭证、零监听端口、零共享状态写入、零新依赖，也没有改动任何内核冻结文件。

## 演练 1——issue #82 模拟 world2agent sensor

套件：`ts/scripts/drill-w2a-sensor-tests.ts`，登记为 run-all §81。记录那次运行的结果：退出码 0，284 条断言通过。本文给出的断言条数是某一次运行的实测值，不是契约；套件以退出码为门，尤其多写者套件只在争用主机走到的分支上才追加断言。

**模拟的触发。** 一个独立 OS 进程扮演 sensor 加本地桥，它按固定的合成剧本重放 `w2a/0.1` envelope（NDJSON），并以两种方式投递：真实的进程间 stdin 管道，以及一个 spool 文件。第二个 OS 进程在 Node 权限模型（只读授权）下承载已落地的惰性适配入口 `ts/capabilities/external-event.ts`。

**跑通的激活路径。** 跨管道的默认关闭、精确的已审四元组、敌意语料、副作用隔离，以及真实激活会接在哪里的溯源。

- 默认关闭：不显式传开启参数时，所有被投递的 envelope（含良性那条）一律 `disabled-by-default` 拒绝，且不投射任何元数据。
- 精确四元组：`sensor_id`、`package`、`sensor_version`、`source_type` 任意单字段变更即 `tuple-not-allowed`；开启但 allowlist 为空仍然拒绝。
- 敌意语料，进程内与跨进程逐条判定一致：伪造发信声明（`authenticated`、`signature`、`verified_by` 与伪造的 `user_identity`）、同一 `signal_id` 重放、超限载荷、两万层深嵌套载荷、三个层级的原型污染键、`event.summary` 内的自然语言注入外加自造的 `event.instruction`、未知事件类型，以及时间戳偏移的两端极值。被接受的 envelope 恰好投射十个惰性字段并带 `trust: 'untrusted'`，且从不回显祈使句文本、身份声明、附件数据或不透明载荷。
- 副作用隔离：适配宿主以 `--permission` 加只读授权运行，因此 `fs` 写与 `child_process` 由 OS 以 `ERR_ACCESS_DENIED` 拒绝，而不是靠测试里的一个 promise。网络是更弱的论断，本文据实写明：在本仓运行的各 Node 版本之间，权限模型没有可移植的 `net` scope；即便在连接确实以 `ERR_ACCESS_DENIED` 被拒的 Node 26 主机上，`process.permission.has('net')` 仍报告该 scope 缺席。因此套件只对「没有任何出站连接成功」设门，同时接受 `ECONNREFUSED`，并且只有当 `has('net')` 报告 scope 已生效时才把这次拒绝记在权限模型账上。此外还有：零 `fetch` 调用、零定时器创建、原型链干净、隔离根下零文件新建，`gotry-state` 目录从未被创建。

**组合边界：据实上报而不接线。** 派工要求「仅在契约允许时」用良性模拟 sensor 事件做组合测试。契约不允许，于是套件证明原因，而不是自造一条路：

- 已批准的生产者确实能跑通。演练在隔离根上驱动已落地的本地探针路径（`evaluateProbeResults` → `recordChannelEvent` → `readLatestChannelEvents`），观察到持久 `down` 与 latest-wins 的 `'ok'` 恢复，而这正是 #436 下工具结果 routing 建议读取的输入。
- w2a 元数据在结构上到不了那里。被投射的字段没有一个是 `channel-registry` 的 id，惰性元数据里完全没有 `channel` 词位。把 `ingestExternalEvent` 组合进 `recordChannelEvent` 需要自造一个「事件类型 → 通道」映射加一条写路径。D-31 的 F 项把 GoTry 侧消费方钉在「零契约预设」，接缝已批准的 contract-only 切片声明 channel-health 写入不可达。因此演练只上报这条边界。
- 产品零调用方：对 `src`、`capabilities`、`scripts` 的 grep 显示，除模块自身与其测试套件之外，没有任何调用方。

**决策模板清单（可执行）。** 取自回调方决策模板的 15 项，每项都对一个可观察的仓内事实做断言：6 项 `satisfied_by_contract`，9 项 `needs_real_party`。

| 分类 | 条目 |
|---|---|
| `satisfied_by_contract` | 精确四元组钉死；自述身份零权重；事件降级为事实、绝不作为指令；无可达写动作；无常驻监听、无环境变量产品开关；不可验证事件 fail-closed 且每条一个稳定原因码 |
| `needs_real_party` | 通道形态；签名与通道绑定；令牌归属；公开 registry 与 provenance 边界；按源的完整性摘要；重放与 nonce 纪律；时钟与新鲜度窗口；按源的事件类型范围；GoTry 侧消费方登记 |

**只有真实触发才能提供的东西。** 一个具名 sensor 包，带公开 registry 条目、可识别的 owner 与可达的安全联系人；让已审四元组可核验的 provenance 与完整性摘要；通道形态、签名绑定与令牌归属的裁决（D-31）；一个重放或 nonce 存储——纯函数适配器不可能有；时钟与新鲜度策略；按源的事件类型范围；以及被选定的 GoTry 侧消费方。任何演练都给不出这些。

**发现的缺陷：无。** 在试过的全部敌意输入下，惰性契约的行为与文档完全一致。

## 演练 2——issue #275 D-15 第二用户与多写者

套件：`ts/scripts/drill-multiuser-ledger-tests.ts`，登记为 run-all §82。记录那次运行的结果：退出码 0，223 条断言通过（条数随主机产生的争用量变化，因为 liveness 分支只在被走到时才追加断言）。`ts/src/state-ledger.ts` 全程只读。

安全面与活性面是刻意分开的。设门的断言是任何主机、任何速度下都必须成立的那些：`integrity_check`、无重复 `(tenant_id, idem_key)`、账本恰好持有 worker 自认写入的那些行、覆盖每次尝试的记账恒等式、租户隔离，以及带非空行数的 fold 等于直读。慢速共享 runner 能跑完多少次尝试、看到哪些 SQLite 争用码，属于活性面，只经观察行上报、绝不设门——一条休眠且未准入的路径不该有能力把回归搞红。失败码按已知争用码集合校验而不钉死到某个字面量，因此集合之外的码仍会被读作新的失败模式。

两处让证据名副其实的机械细节。fold 校验把 `-wal` 与 `-shm` 边车连同数据库文件一起拷走：账本跑在 WAL 模式，而这些受害者是被 `SIGKILL` 的，没有任何 checkpoint 发生；只拷 `gotry-state.db` 会拿空投影去比空投影而空洞通过。因此每条 fold 断言都配一条与就地读取的事件数相等校验；在 `after-commit` 崩点下拷贝携带那一条已提交事件，这就是边车确实被拷走的证明。套件级时间上界是远高于真实开销的诊断兜底，不是性能断言；它的超时路径自己收尸并删除临时根，因为 `process.exit` 会跳过 `finally`，而其中两个 worker 按设计是无限循环的。

### 覆盖矩阵

| #275 验收条目 | 既有证明 | 本次演练后的状态 |
|---|---|---|
| 记录触发证据并选定一种部署拓扑 | 无 | GAP，需真实触发。演练选不了拓扑。 |
| 定义租户归属、fencing token 或 receipt、幂等、冲突解决、备份与恢复、回滚契约 | 租户归属见 `ts/src/state-ledger.ts` 与 `ts/scripts/ledger-tests.ts` §11；fencing 与 claim 见 `docs/design/write-gate-production-design.md` §5.3／§5.4 与 `ts/src/write-gate.ts`；幂等由 `events_idem` 唯一索引承担；冲突解决由 forward-only 派发触发器承担；备份与回滚见 `ts/scripts/state-repair-tests.ts` | PARTIAL。契约存在，但只覆盖单写者本地形态。多写者契约、复制语义与跨机回滚仍未定义。 |
| 以隔离 stateRoot 与崩溃／重开测试证明并发写者与陈旧 claim 拒绝 | `ts/scripts/write-gate-tests.ts` §4 的双进程领取竞争；`ts/scripts/booking-copilot-*-concurrency-proof-tests.ts` 的 receipt／operation／事件序竞争；`ts/scripts/ledger-tests.ts` §9 加 `ts/scripts/ledger-workflow-crash.ts` 的崩溃与恢复 | EXERCISED OFFLINE（模拟；不构成该条目的关闭）。本次演练新增：N 进程（不止两个）领取竞争；单租户与双租户下的 N 进程并发追加；单事务内的具名崩点；产品写路径上定时变化的 SIGKILL；以及冷开竞争。 |
| 端到端验证备份恢复与租户隔离；夹具不构成生产上线证据 | `ts/scripts/state-repair-tests.ts` 的离线文件拷贝备份与校验和回滚；`ts/scripts/ledger-tests.ts` §11 与 `ts/scripts/write-gate-tests.ts` §5 的租户隔离 | PARTIAL。本次新增写负载下的 SQLite 在线备份、带校验和验证的恢复、事件序前缀检查与 fold 自洽。端到端生产上线证据被该条目自身的措辞排除在外。 |
| 跑账本套件、隔离 smoke 与全栈回归；同步架构、路线图与现状面 | run-all §28、§29、§68 | 归整合者。演练只登记 §82；串行全栈回归与权威对账归整合者。 |
| Litestream 流式备份 | 无 | `needs real trigger + dependency decision`。未安装；演练断言其缺席，使任何文档都不能声称已有。 |
| cr-sqlite 多写者复制 | 无 | `needs real trigger + dependency decision`。未安装；缺席已断言。 |

### 演练实际跑了什么

- **冷开竞争（A0）。** 三轮、每轮六个进程、无发令枪地打开同一个全新账本。安全面每次都成立：`integrity_check` ok、无重复幂等键、fold 重建等于直读、至少一个进程建成账本。
- **N 并发写者（A）。** 每租户三个 worker 进程，分单租户与双租户两组，跑在已预建的账本文件上。追加式事件面：每个不同幂等键在每租户恰落一次，`(tenant_id, idem_key)` 从未出现两次，每次尝试都是插入或去重且零错误，每个租户恰好拥有并且只读到自己的行。读—改—写产品面（`appendWish` 共用同一愿望名）：每租户恰一次 `added`、其余转为更新，每租户一行投影且用稳定的名称派生 id，`integrity_check` ok，fold 等于直读。
- **崩溃演练（B）。** 经账本公开面构造的单事务内四个具名崩点，各两轮，每一次都是真实 `SIGKILL`：`before-transaction`、`after-event-insert`、`after-projection-write`、`after-commit`。三个提交前崩点下零事件、零投影行存活；`after-commit` 下各恰好存活一条。另加三次产品写路径上的定时变化 kill（确定性种子），之后已提交的 `wish.added` 条数始终等于投影行数，fold 始终等于直读。
- **带 fencing 的陈旧 claim（C）。** 四个 dispatcher 进程竞争同一条 queued outbox 意图：恰一个赢家、三个被封闭集原因拒绝、一行 outbox 处于 `dispatching`、一个不可变 `attempt_id`、一条领取事件、输家零写。赢家之后陈旧 dispatcher 重试被 `not-claimable` 拒绝；租约过期不让意图重新可领；直接 SQL 把状态改回 `queued` 被存储层 forward-only 触发器拒绝（不是应用层判断）；tenant-b 用同一 `idem_key` 领取得到 `missing-intent`。
- **备份与恢复（D）。** 在一个独立进程持续写入时，经 `better-sqlite3` 取 SQLite 在线备份，再以拷贝加校验和验证恢复。恢复后的快照通过 `integrity_check`，活体源仍然通过，快照从不领先于其源，无重复幂等键存活，快照事件序是源序列的前缀，恢复后的 fold 等于恢复后的直读。

### 发现的缺陷

**缺陷 D15-1（真实、已上报、未修复）：并发首次打开全新账本会从 `openDb` 抛出未分类的 `SQLITE_BUSY`。**

最小复现：跑 `ts/scripts/drill-multiuser-ledger-tests.ts` 的 A0 节，或派六个进程各自无协调地调用 `openDb(freshStateRoot, 'local')`。跨多次运行观察到：18 个进程中有 1 到 5 个失败，错误码恒为 `SQLITE_BUSY`，落在 `ts/src/state-ledger.ts` `openDb` 内两个调用点——`pragma('journal_mode = WAL')` 与 schema 迁移事务里的 `db.exec(SCHEMA)`。调用方拿到的是裸 SQLite 错误而非类型化拒绝，且不做任何重试。

相关的次序事实：在 `openDb` 里 `pragma('journal_mode = WAL')` 先于 `pragma('busy_timeout = 5000')` 执行，因此 WAL 切换取得的排他锁被持有时，其余连接还没装上 busy handler。

失败码并不是单一字面量。连续三次运行分别记录 18 个进程中成功打开 7、8、11 个，其中两次除 `SQLITE_BUSY` 外还产生了 `SQLITE_BUSY_SNAPSHOT`。本套件的早期版本把该码钉死为仅 `SQLITE_BUSY`，在那三次里会有两次变红——这正是现在改为接受已知争用码集合、并把与记录基线的偏离上报而不是据此失败的原因。

分类：这是 D-15 的决策输入，不是主干回归。D-15 明确多写者路径未准入，ADR-16 给的是单账本 owner 语义，所以单写者产品形态根本碰不到这条竞争。`ts/src/state-ledger.ts` 属内核冻结，演练不碰它；缓解手段（串行化首次打开，或把 `busy_timeout` 放在 `journal_mode` 之前）归 D-15 决策。演练用带明确翻转提示的方式钉死失败码，而不是把回归搞红——在一条休眠且未准入的路径上亮红灯只会阻塞整合者，保护不了任何已准入契约。

**缺陷 D15-2（真实、已上报、未修复）：读—改—写产品路径需要账本并不提供的调用方重试循环。**

`appendWish` 跑的是 DEFERRED 读—改—写事务，因此跨进程争用会把裸 `SQLITE_BUSY` 与 `SQLITE_BUSY_SNAPSHOT` 抛给调用方。本次演练中六个进程需要 6 到 9 次调用方重试才完成 12 次尝试；在没有重试循环的早期运行里，6 次中 2 次、12 次中 8 次未能恢复。安全面始终成立——`integrity_check` ok、每租户一行愿望、fold 等于直读——但既没有类型化拒绝也没有内建重试。分类同 D15-1：D-15 设计输入，单写者形态不受影响。

**观察，不是缺陷：fencing token 的单调性是空洞的。** forward-only 的派发状态触发器让第二次领取不可能发生，因此今天观察不到任何大于 1 的 `fencing_token`。设计文档所称的单调递增性质在当前形态下不可测；真正能第一次检验它的是跨机租约交接。

**只有真实触发才能提供的东西。** 触发证据本身（第二个真实用户、多机部署，或已立项的 AaaS）与被选定的部署拓扑；多写者与复制契约；Litestream 或 cr-sqlite 的依赖裁决及其后续运维证据；跨机时钟、租约与归属语义；一次能让 fencing token 真正递增的真实租约交接；以及生产上线证据——#275 明确说夹具不算。

## 演练 3——issue #422 dsh SDK 后代清理（再基线）

套件：`ts/scripts/drill-sdk-descendant-cleanup-tests.ts`，登记为 run-all §83。记录那次运行的结果：退出码 0，42 条断言通过。零 vendor 与 `node_modules` 改动，除本文记录外不提任何上游提案。

**模拟的触发，以及为什么这是一次再基线。** dsh 家族于 2026-10-02 从 0.1.5-rc.1 升到 0.2.0-rc.2，因此 #422 的前提需要在已安装版本上重新测量。演练按 `scripts/booking-surface-package-proof.ts` 的既有做法，以 `profile: 'sdk-minimal'` 与夹具 `dshBin` 驱动 SDK 直连传输。夹具 leader 启动后立即派一个忽略 `SIGTERM` 的后代，后代自己再派一个孙进程，因此只杀直接子进程的清理不可能侥幸通过。

**静态证据。** 已安装的 `@deepseek-ai/dsh-sdk-client` 是 0.2.0-rc.2。它的传输层 spawn 不传 `detached`，因此 runtime 不是进程组 leader；模块内没有 `process.kill(-pid)` 也没有 `setsid`，因此它从不按进程组发信号；dispose 梯级只对直接子进程句柄发信，先 `SIGTERM` 后 `SIGKILL`。SDK 自身的注释写明它运行在任何 harness 上下文之外，因此直接 spawn 而不经 `dsh-subprocess` 服务。

**结果：#422 的缺口在 0.2.0-rc.2 上被确认。**

| 分支 | 清理后的 leader | 后代 | 孙进程 | 有界 |
|---|---|---|---|---|
| SDK `HarnessClient.close()`，不响应且忽略 `SIGTERM` 的 runtime | 已收尸 | 存活 | 存活 | 913 ms |
| SDK `HarnessClient.close()`，响应 `shutdown` 并在 stdin EOF 退出的协作式 runtime | 干净退出 | 存活 | 存活 | 3 ms |
| SDK `DeepSeekHarness.start()` 后 `close()` | 已收尸 | 存活 | 不适用 | 有界 |
| 对照组：`bin/gotry-process-liveness.js` 的 `spawnOwnedChild` 加 `terminateOwnedChild` | 已收尸 | 已收尸 | 已收尸 | 1242 ms |

清理前进程表显示 leader、后代与孙进程共享演练自身的进程组（记录的那次运行里 pid 1947、1948、1949 的 `pgid` 均为 1915），证实 SDK 没有创建私有进程组。SDK dispose 之后，存活者被重新挂到 pid 1 并继续运行。对照组里同一个夹具 leader 成为自己的组 leader，整棵子树共享该私有组，清理前该组可观察为非空、清理后可观察为空，零进程存活。

协作式分支很关键：leader 干净退出同样留下后代在跑，所以缺口在于归属，而不在于信号强度。高层分支同样关键：`DeepSeekHarness` 继承同一缺口，所以缺口在传输层而不在 API 层。

**信号与退出语义、缺二进制语义、禁止不安全重试。** 缺失的 `dshBin` 在 29 ms 后以 `TransportClosedError` 报出，带 `JSON-RPC input closed` 与 `exit code: 1`；由于 `dshBin` 是以 `node <path>` 启动的，这并不是 spawn 的 `ENOENT`，真正的 `Cannot find module` 成因只存活在被保留的 stderr 尾部。只记录错误类名的直连产品调用面会把一次打包失败误诊成协议失败。`close()` 幂等且终态：第二次 `close()` 是空操作，之后 `start()` 以 `TransportClosedError` 被拒，整个生命周期恰好只存在一个 runtime pid，因此 SDK 从不静默重生。

**钉死的预期。** 上述每一项观察都带明确的 `IF THIS FLIPS, #422 premise changed` 提示，SDK 版本号本身也在内。若未来某版本上后代相关断言读到 false，说明后代清理已在上游修好，#422 可带证据关闭；若版本断言失败，套件内其余所有钉死结果作废，必须重新测量。

**泄漏纪律。** 套件记录它学到的每一个 pid，并在最终 `finally` 里不论哪条断言失败都强制收尸两轮，随后断言自己派生的进程无一存活。记录的那次运行追踪了 15 个夹具 pid，零存活。

**只有真实触发才能提供的东西。** 把直连形态放进运行时的那个具体产品调用面；关于后代清理上游归属的、已记录的架构与创始人裁决；修复究竟在上游、在 GoTry 侧包装层，还是拒绝使用直连传输；真实 dsh runtime 自身的后代行为——夹具无法代表；以及 #422 验收清单在激活前要求的包形态与全栈回归验证。

## 给整合者的对账备注

其他权威文档可能需要的事实列在这里，而不是直接改进共享文档：

- `docs/architecture.md` 第 10 节与 D-15 行：新增三个触发演练套件，位于 run-all §81、§82、§83；#422 的缺口在 dsh SDK 0.2.0-rc.2 上被再次确认；两个 D-15 缺陷（D15-1 冷开时从 `openDb` 抛出 `SQLITE_BUSY`，D15-2 DEFERRED 读—改—写路径无内建重试）连同最小复现记录在本文。
- 跟踪单自身状态不变：#82、#275、#422 全部保持开启，没有任何准入闸、依赖或 vendor 文件发生移动。
