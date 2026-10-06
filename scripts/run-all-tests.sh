#!/usr/bin/env bash
# 全栈回归入口(D4 评测集 v0 的 CI 形态):任何提交前必须全绿。
# 覆盖:TS 三套件(engine/journey/unified)+ 对话循环重放(mock)
# + 异步工单跨进程闭环 + 插件 smoke + hbcli + 进程护栏 + 双路径稳定性。
# v0.0.1-rc.2 起去 Python oracle——运行此脚本无需 Python 运行时。
# 真 LLM 巡检(replay-real)见 ADR-11 巡检层。
set -euo pipefail
cd "$(dirname "$0")/.."
set +eu; source ~/.nvm/nvm.sh 2>/dev/null || true; set -eu  # nvm.sh 遇 npmrc prefix 冲突在 set -e 下会 exit 整个脚本(日工作具反复回写 prefix);source 期间放宽 -e/-u

FAIL=0

echo "=== 0. 全量测试运行时前置(一次 dist 构建 + 本地 tsx 路径;packaged/runtime E2E must not reuse stale generated JS) ==="
TSX_BIN="$PWD/ts/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "FAIL: 本地 tsx 不存在: $TSX_BIN"
  FAIL=1
else
  # Some proof suites spawn tsx directly. Keep the repository-local runner
  # ahead of ambient/npm-managed PATH so those children use the same binary.
  export PATH="$(dirname "$TSX_BIN"):$PATH"
fi
(node scripts/run-all-tests-wiring-tests.mjs) || FAIL=1
(node scripts/check-docs-i18n.mjs) || FAIL=1  # 双语对存在性+结构对等(不一致视为 bug)
(node scripts/check-doc-readability.mjs) || FAIL=1  # 读者入口可读性预算+防追加式 issue/date 台账
(node scripts/check-doc-readability.mjs --self-test) || FAIL=1  # 内部正面/反面夹具栅栏与多语标题回归
(node scripts/build-dist.mjs) || FAIL=1
(node scripts/build-dist-compat-tests.mjs) || FAIL=1

echo
echo "=== 0b. 发布工具链(预检/回拉校验/发布后文档/Release notes/发布脚本编排/构建守卫/OIDC 发布工具与工作流结构;全离线:无网络、无浏览器、无真 npm) ==="
(node scripts/release-preflight-tests.mjs) || FAIL=1
(node scripts/verify-published-tests.mjs) || FAIL=1
(node scripts/post-release-docs-tests.mjs) || FAIL=1  # 含「真实文档形状仍可被识别」的漂移守卫:改 README/路线图措辞要同步改它
(node scripts/release-notes-tests.mjs) || FAIL=1
(node scripts/publish-npm-tests.mjs) || FAIL=1  # 在 sh 与 dash 下各跑一遍(脚本是 POSIX sh)
(node scripts/build-dist-guard-tests.mjs) || FAIL=1
(node scripts/release-oidc-tests.mjs) || FAIL=1
(node scripts/npm-publish-workflow-tests.mjs) || FAIL=1  # 零点击发布工作流的结构纪律(最小权限/钉死 action/无机密);变异用例证明检查不是空的

echo
echo "=== 1. TS engine(洱海金标准,8 断言) ==="
# Z3 WASM race 已根治(2026-08-29,z3-shared.ts 单一实例+会话级互斥):不再需要「重试一次」
# 止血;并发形态的回归闸见 §30 z3-race-tests。
(cd ts && npx tsx scripts/engine-tests.ts) || FAIL=1

echo
echo "=== 2. TS journey(五段链,5 断言) ==="
(cd ts && npx tsx scripts/journey-tests.ts) || FAIL=1

echo
echo "=== 3. TS unified(统一模型+时区+工作窗口,4 断言) ==="
(cd ts && npx tsx scripts/unified-tests.ts) || FAIL=1

echo
echo "=== 3b. Issue #341 ground-transfer bounded public-map seam + 2026-09-11 wider D-39 边界冻结(模式/位置词汇封闭/回退完备性含矛盾路线事实/静态↔动态切换契约/证据标注完整/缓存有界;全离线) ==="
(cd ts && GOTRY_SESSION_LIVE=0 npx tsx scripts/ground-transfer-tests.ts) || FAIL=1

echo
echo "=== 4. 对话循环重放(mock,ADR-8/9/10 行为级回归,带终态断言) ==="
(cd ts && npx tsx scripts/replay.ts | tail -3) || FAIL=1

echo
echo "=== 5. 异步深度规划:隔离 stateRoot 种工单 → 另一进程回收(跨进程闭环,不触真实产品状态) ==="
REPO_ROOT=$PWD
ASYNC_FIXTURE=$(mktemp -d)
mkdir -p "$ASYNC_FIXTURE/ts" "$ASYNC_FIXTURE/data"
ln -s "$REPO_ROOT/data/flights_2026.json" "$ASYNC_FIXTURE/data/flights_2026.json"
(cd "$ASYNC_FIXTURE/ts" && "$REPO_ROOT/ts/node_modules/.bin/tsx" "$REPO_ROOT/ts/scripts/replay-async.ts" --request-only > /dev/null) || FAIL=1
TICKET=$({ ls "$ASYNC_FIXTURE"/ts/gotry-state/async/*.json 2>/dev/null || true; } | while read -r f; do b="${f%.json}"; [ -f "$b.deliverable.md" ] || basename "$b"; done | sed -n '1p')  # sed 非 head:head -1 早关管道,pipefail 下未回收工单 ≥2 时 SIGPIPE 整脚本 141
if [ -z "$TICKET" ]; then echo "FAIL: 未种下待回收工单"; FAIL=1; else (cd ts && npx tsx scripts/async-collect.ts "$TICKET" "$ASYNC_FIXTURE/ts" > /dev/null) || FAIL=1; echo "工单 $TICKET 已在隔离 stateRoot 跨进程回收"; fi
rm -rf "$ASYNC_FIXTURE"

echo
echo "=== 6. 插件 smoke(注册/execute/红线断言) ==="
(cd ts && npx tsx scripts/smoke-session-gate-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/smoke.ts | tail -2) || FAIL=1

echo
echo "=== 6b. 产物视图能力与 Host 合同(客户端导出/运行时 block 卡片/路径护栏/版本更新,全离线) ==="
(cd ts && npx tsx scripts/artifact-client-contract-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/artifact-delivery-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/gotry-web-client-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/artifacts-capability-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/dsh-artifact-e2e.ts) || FAIL=1

echo
echo "=== 6c. 行程 HTML 渲染器与产物生成入口(#442/父 #438:纯渲染器有界契约/日期与枚举反例/计划面与证据面分离;注册工具 gotry_itinerary_render 从隔离事实注册表选 id→独占新建 HTML→落盘字节断言,未知/重复/超量 id 与畸形登记行拒绝、撞车不覆盖、符号链接与路径逃逸拒绝、非法输入零写入;全离线合成夹具) ==="
(cd ts && npx tsx scripts/itinerary-html-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/itinerary-artifact-tests.ts) || FAIL=1

echo "=== 6d. 行程 deck 渲染器与共享契约层(#564,研究决策 docs/research/karpo-deck-web-research.md #1:幻灯页确定性派生/纯 CSS scroll-snap 零脚本翻页;校验与证据卡单一事实源 itinerary-doc-shared,拒绝集与单页文档逐字一致的反漂移锁;纯度源检查双模块;逐字节确定性+共享字节上限;全离线合成夹具) ==="
(cd ts && npx tsx scripts/itinerary-deck-tests.ts) || FAIL=1

echo "=== 6e. 行程 deck 产物生成入口(#566,Phase B 切片 2:与 gotry_itinerary_render 对称的产品路径;共享 normalizeDocInput / 同一路径护栏 / gotry-deck- 命名前缀;注册工具 E2E——未知-重复-超量 id 拒绝/撞车不覆盖/符号链接与路径逃逸拒绝/进程 cwd 零新增/真实链路 list+read) ==="
(cd ts && npx tsx scripts/itinerary-deck-artifact-tests.ts) || FAIL=1

echo "=== 6f. 行程 deck 静态导出 bundle(#568 切片 3a + #569 切片 3b QR 真矩阵:在 host 给出的 target_dir 写三件 <basename>.html+<basename>.manifest.json+<basename>.qr.svg(qrcode 库渲染,target_url 或本地占位串);manifest 携带 sha256+bytes+facts 计数+source_tags+evidence_chain+target_url+share_intent.qr=generated;O_CREAT|O_EXCL bundle 三件任一存在即拒;拒绝符号链接跟随;进程 cwd 零新增) ==="
(cd ts && npx tsx scripts/itinerary-deck-export-tests.ts) || FAIL=1

echo "=== 6g. gotry try 离线 deck demo(#571,Phase A:免安装/免 LLM key/免 dsh 主机;子进程跑 scripts/gotry-try-demo.ts→stdout 落盘路径/字节/幻灯数;产物含 scroll-snap 与共享双面文案;全离线合成 fixture) ==="
(cd ts && npx tsx scripts/gotry-try-demo-tests.ts) || FAIL=1

echo "=== 6h. Share 契约层(#573,Phase C:adapters 4 个 stub + HMAC share token sign/verify + consent state machine + shareDeck 主流程;不接真实 SDK、不挂 dsh 工具面;7 类 ShareFailureReason 全部真实触发;全离线合成) ==="
(cd ts && npx tsx scripts/share-tests.ts) || FAIL=1

echo "=== 6i. Recall 触发契约层(#577,Phase D:tick source(InMemory + Periodic 默认关)+ evaluator 5 类 RecallReason 闭集 + why-now card(source tag 必现)+ wish-pool 只读编排 + RecallTickScheduler 端到端;产品代码零 setInterval 激活(测试启停有界 interval 验证契约);不推送、不 mutation wish-pool;全离线合成) ==="
(cd ts && npx tsx scripts/recall-tests.ts) || FAIL=1

echo "=== 6j. Session-link 契约层(#580,Phase E:HMAC 签名 token(schema 闭集未知键拒绝/plan_it⇔wish_id 成对/session_ref 路径护栏/action 词位无写动词)+ format/parse 互逆(query/hash 拒绝)+ plan-it 行动卡(wish_id 与 payload 同源);无 scheme handler 注册(消费端 M4 激活);不碰写路径 WriteGate 保持 sealed;全离线合成) ==="
(cd ts && npx tsx scripts/session-link-tests.ts) || FAIL=1

echo
echo "=== 7. hbcli 能力层(hotelbyte-cli 调用 + 降级封装 + ENOENT 人话化 + 候选路径,7 断言) ==="
(cd ts && npx tsx scripts/hbcli-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/spawn-bounded-abort-tests.ts) || FAIL=1

echo
echo "=== 7b. flyai 能力层(离线假 CLI,4 断言:Sentinel 非业务形状→error/空 itemList→miss/命中→hit/exit≠0→error;issue #24) ==="
(cd ts && npx tsx scripts/flyai-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/flyai-setup-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/gotry-web-api-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/flyai-setup-tool-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/flyai-tool-registration-contract-tests.ts) || FAIL=1

echo
echo "=== 7c. 外部依赖自举(check-only 探测/跳过开关/postinstall 非致命;真安装属发布前干净安装实测) ==="
(cd ts && npx tsx scripts/bootstrap-tests.ts) || FAIL=1

echo
echo "=== 7d. hbcli 全流程端到端(仅 GOTRY_HBCLI_LIVE=1 显式启用真实 UAT;默认零 binary/网络/凭证探测) ==="
(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" GOTRY_HBCLI_LIVE="${GOTRY_HBCLI_LIVE:-0}" GOTRY_HOTELBYTE_SKILLS_LIVE="${GOTRY_HOTELBYTE_SKILLS_LIVE:-0}" npx tsx scripts/hbcli-e2e-tests.ts) || FAIL=1

echo "=== 7f. hbcli live opt-in 隔离证明(可发现 fixture + blocked network:默认 binary=0/network=0/credential=0) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/hbcli-live-optin-tests.ts) || FAIL=1

echo
echo "=== 7e. hbcli release-contract(staicli@0.0.3 actual tarball bytes + packaged help/parser; test-only, no supplier request) ==="
if [ -n "${STAICLI_TARBALL:-}" ]; then
  (cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/hbcli-release-contract-tests.ts "$STAICLI_TARBALL") || FAIL=1
else
  echo "SKIP: STAICLI_TARBALL not set; targeted artifact proof requires a local staicli-0.0.3.tgz path"
fi

echo
echo "=== 8. 进程护栏(D-NEW,incident-log + uncaughtException 写盘 + guardToolExecute 异常隔离,3 断言) ==="
(cd ts && npx tsx scripts/incident-tests.ts) || FAIL=1

echo
echo "=== 9. 天气能力层(Open-Meteo 免费无 key,6 断言:地理/预报/气候/降级/WMO/地名别名阶梯;issue #24) ==="
(cd ts && npx tsx scripts/weather-tests.ts) || FAIL=1

echo
echo "=== 10. 航班实时观测(OpenSky 免费匿名,3 断言:observed 三值/降级/超时) ==="
(cd ts && npx tsx scripts/opensky-tests.ts) || FAIL=1

echo
echo "=== 11. Anything 能力层(hbcli search anything 5 断言:hit/miss/error/timeout/empty) ==="
(cd ts && npx tsx scripts/anything-tests.ts) || FAIL=1

echo
echo "=== 12. probePoi 单测(datasources 编排层,6 类覆盖) ==="
(cd ts && npx tsx scripts/probe-poi-tests.ts) || FAIL=1

echo
echo "=== 13. agent-reach web 读取(readUrl 薄壳,3 断言:非法/超时/live 降级容忍) ==="
(cd ts && npx tsx scripts/agent-reach-tests.ts) || FAIL=1

echo
echo "=== 14. agent-reach 深度(yt-dlp/gh 可选工具,4 断言:三值/not-installed/证据链/超时) ==="
(cd ts && npx tsx scripts/agent-reach-deep-tests.ts) || FAIL=1

echo
echo "=== 15. agent-reach wrapper(反射桥 + 真 doctor,7 断言) ==="
(cd ts && npx tsx scripts/agent-reach-wrapper-tests.ts) || FAIL=1

echo
echo "=== 15b. agent-reach 确定性失败面(fake python 注入,14 段:缺可执行/缺包/超时/坏 JSON/stderr 与凭证不漏/形状错型不抛错/readUrl 产品边界 + 透传回归锁) ==="
(cd ts && npx tsx scripts/agent-reach-error-tests.ts) || FAIL=1

echo
echo "=== 15c. doctor 可选依赖体检(注入式三态分级/LLM key 让渡/报告渲染/gotry_doctor 工具面落盘,6 段) ==="
(cd ts && npx tsx scripts/doctor-tests.ts) || FAIL=1

echo
echo "=== 16. 双路径稳定性(纯 TS,unified vs unified 同 spec) ==="
(cd ts && npx tsx scripts/diff-test.ts | tail -1) || FAIL=1

echo
echo "=== 17. hotelbyte-skills 契约对齐(本地描述离线校验;远端读取仅 GOTRY_HOTELBYTE_SKILLS_LIVE=1) ==="
(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" GOTRY_HBCLI_LIVE="${GOTRY_HBCLI_LIVE:-0}" GOTRY_HOTELBYTE_SKILLS_LIVE="${GOTRY_HOTELBYTE_SKILLS_LIVE:-0}" npx tsx scripts/skills-contract-tests.ts) || FAIL=1

echo
echo "=== 18. T1 记忆合并守门(M4,纯函数:追加不删史/P0 权重校验/幂等) ==="
(cd ts && npx tsx scripts/memory-capture-tests.ts) || FAIL=1

echo
echo "=== 18b. Issue #338 持久默认出发地 E2E(fresh stateRoot/真实 system-prompt 读回+exact evidence 绑定/显式优先/幂等/跨租户/显式清除/重建/不压算术;隔离临时 stateRoot 全离线) ==="
(cd ts && GOTRY_SESSION_LIVE=0 npx tsx scripts/issue-338-home-city-e2e.ts) || FAIL=1

echo
echo "=== 19. 时间感评测(时间锚点卡 + 槽位过期校验 + 评分器 + mock 回放管道,确定性;真模型巡检走 --real) ==="
(cd ts && npx tsx scripts/time-eval-tests.ts) || FAIL=1

echo
echo "=== 20. 旅行时间线(memory-design P1 守门面:必填/幂等/重叠冲突/交叉一致) ==="
(cd ts && npx tsx scripts/travel-timeline-tests.ts) || FAIL=1

echo
echo "=== 21. 同行人档案(memory-design P2 守门面:负面清单/合并/幂等) ==="
(cd ts && npx tsx scripts/companion-tests.ts) || FAIL=1

echo
echo "=== 22. 记忆效用指标投影(M4 北极星过程面,只读,空态优雅) ==="
(cd ts && npx tsx scripts/memory-metrics.ts) || FAIL=1

echo
echo "=== 23. 时间窗衰减(memory-design P3:分级窗口/单调/地板/上界/动机零衰减) ==="
(cd ts && npx tsx scripts/memory-decay-tests.ts) || FAIL=1

echo
echo "=== 23b. 发布前离线预验证(pack→解 tarball→依赖声明完整→入口文件→import 面静态检查;rc.9 教训的永久闸;原误标 25 与会话面重号,当日修正) ==="
(cd ts && npx tsx scripts/publish-preverify.ts) || FAIL=1
(cd ts && npx tsx scripts/dsh-runtime-closure-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/dsh-target-closure-proof.ts) || FAIL=1

echo
echo "=== 23a. Issue #289 DSH model-request retry contracts + native loopback request proof ==="
(cd ts && npx tsx scripts/issue-289-model-retry-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/issue-289-model-retry-real-tests.ts) || FAIL=1

echo
echo "=== 23c. Session V3 确定性迁移证明(#268:隔离临时目录文件字节——V2 编解码器编码→JSONL 写盘→catalog 读盘分类 migration-required→V3 恢复→独立 V3 继任者写盘→validation:current 完全解码→迁移后源文件字节比较不变) ==="
(cd ts && npx tsx scripts/dsh-session-v3-migration-proof.ts) || FAIL=1

echo
echo "=== 23d. dsh-subprocess-local 确定性证明(#268:仅公共 API 挂载 Cordis/provider+真实活跃父进程 spawn 非分离子进程+收集 stdout 观察 CHILD_PID+公共 terminate/waitForExit+进程组信号终止整组→子进程 PID 消失+真实 spawnTerminal 每平台输出 'pty-line' 与 exitCode=0;Darwin 预构建下额外断言 node-pty spawn-helper 0755 模式;非 Darwin 平台 helper 不适用,仅报告 platform-pty 事实而不伪造 stat 不存在的 helper;平台中立,不调用私有方法,不传整个环境变量) ==="
(cd ts && npx tsx scripts/dsh-subprocess-local-proof.ts) || FAIL=1
echo "=== 23f. issue #271 dsh child liveness(真实安装 dsh 五个既有 seam + 实际 bin/gotry-inner.js package-shaped inherited-pipe/nonzero/zero/TERM-resistant + benchmark stdout success 与 inherited-pipe/TERM-resistant proof;Node24 外部有界/fresh root/child group descendants/marker/stderr/产品 incident evidence) ==="
(cd ts && npx tsx scripts/issue-271-liveness-tests.ts) || FAIL=1

echo
echo "=== 23e. dsh-http-proxy 本地 SSE + 中毒代理反例(#268:真实 fetch 回环 SSE=200+中毒命中=0+proxyRouteFor 回环直接/非回环代理+proxyEnvironmentForChild NODE_USE_ENV_PROXY/NO_PROXY+finally await disposer+await 两服务器关闭+全局路由恢复直接) ==="
(cd ts && npx tsx scripts/dsh-http-proxy-sse-proof.ts) || FAIL=1

echo
echo "=== 23f. Issue #194 continuable subagent durable id 与 jobs id 边界(真实 dsh ToolRuntime 调用链+可恢复 pre-execute guard+direct-child ownership) ==="
(cd ts && npx tsx scripts/issue-194-job-id-guard-tests.ts) || FAIL=1

echo
echo "=== 24. 「下一次出发」回访骨架(nudge-digest:匹配/file 通道/可关闭/无命中不硬推/lark 缺 key 降级) ==="
NUDGE_FIXTURE=$(mktemp -d)
mkdir -p "$NUDGE_FIXTURE/gotry-state"
cat > "$NUDGE_FIXTURE/gotry-state/wish-pool.json" <<'EOF'
[{"wish_id":"wA","name":"普吉","conditions":{"days":5,"budget_cny":7000,"best_months":[11,12]},"added_at":"2026-08-01T00:00:00Z"},
 {"wish_id":"wB","name":"千岛湖","conditions":{"days":2,"budget_cny":1000,"best_months":[4,5]},"added_at":"2026-08-02T00:00:00Z"},
 {"wish_id":"wC","name":"洱海(休眠)","muted":true,"conditions":{"days":5,"budget_cny":4950,"best_months":[11]},"added_at":"2026-08-03T00:00:00Z"}]
EOF
(cd ts && GOTRY_NUDGE_CHANNEL=file GOTRY_NUDGE_FILE="$NUDGE_FIXTURE/digest.md" npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" --days 6 --budget 8000 --month 11 >/dev/null) || FAIL=1
grep -q "普吉" "$NUDGE_FIXTURE/digest.md" || { echo "FAIL: file 摘要应含命中的普吉"; FAIL=1; }
grep -q "洱海" "$NUDGE_FIXTURE/digest.md" && { echo "FAIL: muted 洱海不得召回"; FAIL=1; }
NUDGE_DISABLED_OUTPUT=$(cd ts && GOTRY_NUDGE_ENABLED=false npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE") || FAIL=1
grep -q "回访已关闭" <<<"$NUDGE_DISABLED_OUTPUT" || FAIL=1
NUDGE_NO_MATCH_OUTPUT=$(cd ts && npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" --days 1 --month 7) || FAIL=1
grep -q "不硬推" <<<"$NUDGE_NO_MATCH_OUTPUT" || FAIL=1
NUDGE_LARK_OUTPUT=$(cd ts && GOTRY_NUDGE_CHANNEL=lark npx tsx scripts/nudge-digest.ts --state-root "$NUDGE_FIXTURE" --days 6 --month 11) || FAIL=1
grep -q "降级" <<<"$NUDGE_LARK_OUTPUT" || FAIL=1
rm -rf "$NUDGE_FIXTURE"
echo "NUDGE SKELETON TESTS OK(0..1 匹配/muted 排除/可关闭/lark 缺 key 降级)"

echo
echo "=== 25. 会话数据面 P1-P2(ReadGuard/携程解析/节律闸 + #21 字段 fixture scorer/双源合同/waiting-attach no-spend + live FlyAI/会话;GOTRY_SESSION_LIVE=0 关闭全部 live 端点) ==="
(cd ts && npx tsx scripts/session-benchmark.ts) || FAIL=1
(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" npx tsx scripts/session-tests.ts) || FAIL=1

echo
echo "=== 25b. #279 机票 malformed 隔离扩展 fixture(纯离线,no-spend) ==="
(cd ts && GOTRY_SESSION_LIVE="${GOTRY_SESSION_LIVE:-0}" npx tsx scripts/flight-malformed-tests.ts) || FAIL=1

echo
echo "=== 26. action-cache 自愈层(会话数据面 P2:变量化key/指纹被动失效/miss回写/TTL/LRU/损坏容错,纯函数) ==="
(cd ts && npx tsx scripts/action-cache-tests.ts) || FAIL=1

echo
echo "=== 27. 会话面 P2-2 抽取层(a11y兜底抽取/提交件剔除/美团适配器骨架/金标准20 schema,纯函数) ==="
(cd ts && npx tsx scripts/session-extract-tests.ts) || FAIL=1

echo
echo "=== 28. 事务化状态账本(ADR-15:事务原子性/红线进事务/幂等物理化/fold 重建/rewind/one-shot 迁移/工单 exactly-once + 4/4/非4/4 机器终态/pending_writes saga) ==="
(cd ts && npx tsx scripts/ledger-tests.ts | tail -1) || FAIL=1

echo
echo "=== 29. 账本 CLI e2e(migrate 快照/stats/log/export 视图单向/forget 物理硬删带审计/pw-* saga 面) ==="
(cd ts && npx tsx scripts/state-cli-tests.ts | tail -1) || FAIL=1

echo
echo "=== 29b. 账本 tenant 修复计划(#254:只读 inventory/dry-run before-after/无证据零搬移/跨租户同 idem_key 同 wish_id 拒绝/重复 dry-run 幂等/正本零写) ==="
(cd ts && npx tsx scripts/ledger-repair-plan-tests.ts | tail -1) || FAIL=1

echo
echo "=== 29c. 账本 tenant 修复 apply(#254:授权门零写/CAS搬移/目标tenant可见不串读/幂等/注入失败回滚/backup rollback/隔离stateRoot) ==="
(cd ts && npx tsx scripts/ledger-repair-apply-tests.ts | tail -1) || FAIL=1

echo
echo "=== 30. Z3 WASM race 回归(engine/journey/unified 三形态同轮并发压测;修复验证面,run-all §1 止血移除的闸) ==="
(cd ts && npx tsx scripts/z3-race-tests.ts) || FAIL=1

echo
echo "=== 30b. Z3 生命周期局部守门(#227:冷初始化单 Context/低层 cleanup 队列/actual-native barrier/活对象保留/排队合同) ==="
(cd ts && npx tsx scripts/z3-lifecycle-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/z3-lifecycle-fault-tests.ts) || FAIL=1

echo
echo "=== 30c. Z3 race 独立进程重复(#227:多进程重复保存原始 stdout/stderr) ==="
(cd ts && npx tsx scripts/z3-race-repeat-tests.ts) || FAIL=1

echo
echo "=== 30d. 酒店日期输入闸(#283:founder 截图实证 gotry_hotel_search 空/缺/单侧/无法解析/倒序/同日日期仍发起 hbcli 按当前窗口价返回;闸失败 → input_required 不调 hbcli 不写 bridge-latency;通过 → 真实 apply→execute→临时 fixture hbcli 收到精确 argv;隔离 stateRoot + 临时 fixture hbcli,finally 中清理,无 HotelByte/凭证/共享用户数据写入;闸终消费层严格校验拦截 +N 算术溢出(NaN-NaN-NaN)与 JS 自动进位跨千年(10000-01-01)归 unresolved,不调 hbcli;断言数见脚本尾部自报) ==="
(cd ts && npx tsx scripts/hotel-date-gate-tests.ts) || FAIL=1

echo
echo "=== 31. 实时票价 overlay(flyai 实时桥 + 静态降级三值语义;纯离线注入,hit 覆写/error 降级/日期词表闸/求解集成) ==="
(cd ts && npx tsx scripts/realtime-pricing-tests.ts | tail -1) || FAIL=1

echo
echo "=== 32. i18n 目录(en 零缺键/默认 zh 金标准逐字节/en 切换数据不动/插值回退) ==="
(cd ts && npx tsx scripts/i18n-tests.ts | tail -1) || FAIL=1

echo
echo "=== 33. M3 cohort 指标合同(冻结阈值/脱敏 schema/真实与 fixture 分流) ==="
M3_FIXTURE_OUTPUT=$(cd ts && npx tsx scripts/product-metrics.ts --fixture data/product-metrics-fixture.json --format json) || FAIL=1
M3_FIXTURE_OUTPUT="$M3_FIXTURE_OUTPUT" node --input-type=module <<'NODE' || FAIL=1
import assert from 'node:assert/strict'
const summary = JSON.parse(process.env.M3_FIXTURE_OUTPUT ?? '{}')
assert.equal(summary.schema_version, 'gotry_m3_product_metrics_summary_v1')
assert.equal(summary.sample.participants, 5)
assert.equal(summary.sample.pass, false)
assert.deepEqual(summary.finalization, { numerator: 2, denominator: 5, rate: 0.4, pass: true })
assert.deepEqual(summary.nps, { promoters: 3, passives: 1, detractors: 1, denominator: 5, score: 40, pass: true })
assert.deepEqual(summary.poi_hallucination, { invalid_claims: 1, locked_claims: 200, rate: 0.005, pass: true })
assert.equal(summary.nightly.replayable_real_llm_runs, 1)
assert.equal(summary.nightly.cost_usd, 1.25)
assert.equal(summary.business_pass, false)
assert.match(summary.business_pass_reason, /synthetic_fixture/)
NODE
M3_TEST_ROOT=$(mktemp -d)
node --input-type=module - "$PWD/ts/data/product-metrics-fixture.json" "$M3_TEST_ROOT" <<'NODE' || FAIL=1
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const source = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const root = process.argv[3]
const positive = structuredClone(source)
positive.manifest.evidence_kind = 'real_seed_cohort'
positive.manifest.cohort_id = 'm3-real-contract-fixture'
positive.cohort = Array.from({ length: 50 }, (_, index) => ({
  ...structuredClone(source.cohort[index % 5]),
  participant_key: `hmac-sha256:${(index + 1).toString(16).padStart(64, '0')}`,
  plan_key: `hmac-sha256:${(index + 101).toString(16).padStart(64, '0')}`,
}))
writeFileSync(join(root, 'positive.json'), JSON.stringify(positive))
const pii = structuredClone(source)
pii.cohort[0].raw_email = 'must-not-enter-evidence@example.com'
writeFileSync(join(root, 'pii.json'), JSON.stringify(pii))
const relaxed = structuredClone(source)
relaxed.manifest.metrics.sample_size.minimum = 1
writeFileSync(join(root, 'relaxed.json'), JSON.stringify(relaxed))
const staleNightly = structuredClone(positive)
staleNightly.nightly_runs[0].executed_at = '2025-08-20T00:00:00Z'
writeFileSync(join(root, 'stale-nightly.json'), JSON.stringify(staleNightly))
NODE
M3_REAL_OUTPUT=$(cd ts && npx tsx scripts/product-metrics.ts --fixture "$M3_TEST_ROOT/positive.json" --format json) || FAIL=1
M3_REAL_OUTPUT="$M3_REAL_OUTPUT" node --input-type=module <<'NODE' || FAIL=1
import assert from 'node:assert/strict'
const summary = JSON.parse(process.env.M3_REAL_OUTPUT ?? '{}')
assert.equal(summary.evidence_kind, 'real_seed_cohort')
assert.deepEqual(summary.sample, { participants: 50, minimum: 50, maximum: 200, pass: true })
assert.equal(summary.finalization.rate, 0.4)
assert.equal(summary.nps.score, 40)
assert.equal(summary.poi_hallucination.rate, 0.005)
assert.equal(summary.business_pass, true)
NODE
if (cd ts && npx tsx scripts/product-metrics.ts --fixture "$M3_TEST_ROOT/pii.json" --format json >/dev/null 2>&1); then
  echo "FAIL: M3 evidence schema must reject undeclared/raw PII fields"
  FAIL=1
fi
if (cd ts && npx tsx scripts/product-metrics.ts --fixture "$M3_TEST_ROOT/relaxed.json" --format json >/dev/null 2>&1); then
  echo "FAIL: M3 acceptance thresholds must not be weakened by evidence input"
  FAIL=1
fi
M3_STALE_OUTPUT=$(cd ts && npx tsx scripts/product-metrics.ts --fixture "$M3_TEST_ROOT/stale-nightly.json" --format json) || FAIL=1
M3_STALE_OUTPUT="$M3_STALE_OUTPUT" node --input-type=module <<'NODE' || FAIL=1
import assert from 'node:assert/strict'
const summary = JSON.parse(process.env.M3_STALE_OUTPUT ?? '{}')
assert.equal(summary.nightly.replayable_real_llm_runs, 0)
assert.equal(summary.nightly.pass, false)
assert.equal(summary.business_pass, false)
NODE
rm -rf "$M3_TEST_ROOT"
echo "M3 PRODUCT METRICS TESTS OK(fixture fail-closed/50 人正向合同/PII 拒绝/阈值防篡改/nightly 窗口闸)"

echo
echo "=== 34. M4 memory value paired-cohort 合同(fixture:strict schema/source-review/active planning/reflux/溯源/P4 闸) ==="
(cd ts && npx tsx scripts/memory-value-tests.ts) || FAIL=1

echo "=== 35. M3 nightly evidence 生产器合同(封存价表保守换算/未知模型与usage缺失 fail-closed/run_key 确定性/无凭证 waiting 零写入/dry-run mock 全链零落盘;真跑花钱不进 CI) ==="
(cd ts && npx tsx scripts/nightly-evidence-tests.ts) || FAIL=1
NIGHTLY_DRY=$(cd ts && npx tsx scripts/nightly-evidence.ts --dry-run --format json) || FAIL=1
echo "$NIGHTLY_DRY" | grep -q '"state":"dry_run"' || { echo "FAIL: nightly dry-run must exercise the pipeline against mock"; FAIL=1; }
if [ -z "${LLM_API_KEY:-}" ] && [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  NIGHTLY_WAIT=$(cd ts && npx tsx scripts/nightly-evidence.ts --no-env-file --format json) || FAIL=1
  echo "$NIGHTLY_WAIT" | grep -q '"state":"waiting_external_evidence"' || { echo "FAIL: missing credential must report waiting_external_evidence"; FAIL=1; }
  echo "nightly CLI: dry-run 演练 + 无凭证等待态已验证(执行环境无真实凭证)"
else
  echo "SKIP: 执行环境存在真实 LLM 凭证,CLI 等待态跳过(真凭证不进 CI,fail-closed)"
fi

echo
echo "=== 36. 预订 saga 状态机(booking_saga_fsm.v1,issue #17 采纳:字母表/边表封闭性 + 主路径/吸收态 + 审计链校验 + 与账本 saga 基座物理对账/多租户,纯函数) ==="
(cd ts && npx tsx scripts/booking-saga-tests.ts | tail -1) || FAIL=1

echo
echo "=== 37. 效应解译器(effect_interpreter.v1,issue #16 采纳:注册表封闭性/指数退避链/断路三态+熔断后零执行/Sentinel 不重试/mock 夹具回放/SESSION 永不重试不熔断/真实 handler 静态包降级,纯离线) ==="
(cd ts && npx tsx scripts/effect-tests.ts) || FAIL=1

echo
echo "=== 38. 会话扩展桥(#21 传输层方案 C:manifest 合同与 key→固定 ID 派生/Node↔扩展常量防漂移/origin 白名单/长轮询取活幂等/心跳判定/提交-回包闭环/needs-extension no-spend/waiting_extension 双源合同;全离线,唯一慢例~6s 为 no-spend 语义本身) ==="
(cd ts && npx tsx scripts/extension-tests.ts) || FAIL=1

echo
echo "=== 39. 可下单事实模型+产物事实闸(issue #46:gotry_bookable_fact.v1 hit/miss 落账/负事实 fail-closed/航司→机场映射 FD=DMK·VZ=BKK/联程仅 protected_connection/时刻矛盾/夜数·O&D·预算不变式/issues #301/#302 finite hotel/policy read-side claim coverage/locked golden 2027 E2E,纯离线) ==="
(cd ts && npx tsx scripts/fact-gate-tests.ts | tail -1) || FAIL=1

echo
echo "=== 41. LLM 价格漂移监测(issue #49 长效机制:offline baseline 比对/fetch 首次写 fixture/up·down·new·removed 四向/坏 baseline SKIP/PR 段落含纪律注脚;零网络,纯离线合同) ==="
(cd ts && npx tsx scripts/price-drift-tests.ts | tail -1) || FAIL=1

echo
echo "=== 42. CHANGELOG 生成器(2026-08-30 owner 拍板补 changelog 机制:Conventional Commits → Keep a Changelog 1.1.0/类型映射/节结构/PR&sha 后缀/prepend 不覆盖历史/空列表/breaking change marker;纯函数) ==="
(cd ts && npx tsx scripts/changelog-tests.ts | tail -1) || FAIL=1

echo
echo "=== 43. 扩展分发通道(ADR-21 分发 A:GitHub Releases 下载链——稳定资产名/URL 合同 + package-extension.mjs 防漂移 / dist-manifest fail-closed / 版本比较 / 回环 e2e installed·up-to-date·check-only·坏SHA·无网·key漂移 / CLI 单行 JSON 契约;全离线) ==="
(cd ts && npx tsx scripts/extension-distribution-tests.ts | tail -1) || FAIL=1

echo
echo "=== 44. sf-live static golden(issue #67:CLI vendor 闭集/OpenFlights 固定修订 provenance/8 条路由覆盖/手工时刻价格带/失败明示回退/跨 provider 软评分;全离线) ==="
(cd ts && npx tsx scripts/static-golden-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/sf-soft-score-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/sf-manifest-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/sf-live-cli-tests.ts) || FAIL=1

echo
echo "=== 44b. sf-summary offline evidence selection(issue #335/#272:canonical filename batch/chronology/source provenance/missing-corrupt fail-closed/legacy unknown;temporary evidence roots only) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/sf-summary-tests.ts) || FAIL=1

echo
echo "=== 44c. sf-live evidence isolation + challenge stop(issue #503/#411/RFC §3.5:首个 challenged/guard 即截断批次/challenged 语义不被改写/部分批次+attempted·not_attempted 清单/普通八条批次保留/请求计数断言;真实 CLI runner+确定性 session 模块 overlay,临时根零网络) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 npx tsx scripts/sf-live-challenge-stop-tests.ts) || FAIL=1

echo "=== 44d. Dida live runner stop (#502/#504:真实 runner 入口 + 合成浏览器/session overlay；challenge/cooldown/login/extension/error/hit/throw 单次调用、assist cleanup、strict live gate；零供应商网络) ==="
(cd ts && npx tsx scripts/dida-runner-stop-tests.ts) || FAIL=1

package_e2e_bin="${GOTRY_BRIDGE_E2E_BIN:-${GOTRY_BUDGET_E2E_BIN:-}}"
package_e2e_dir=""
package_e2e_install_dir=""
cleanup_packaged_e2e_runtime() {
  if [ -n "$package_e2e_dir" ] && [ -n "$package_e2e_install_dir" ]; then
    rm -rf -- "$package_e2e_dir" "$package_e2e_install_dir"
  elif [ -n "$package_e2e_dir" ]; then
    rm -rf -- "$package_e2e_dir"
  fi
}
trap cleanup_packaged_e2e_runtime EXIT
if [ -n "${GOTRY_BRIDGE_E2E_BIN:-}" ] && [ -n "${GOTRY_BUDGET_E2E_BIN:-}" ] \
  && [ "$GOTRY_BRIDGE_E2E_BIN" != "$GOTRY_BUDGET_E2E_BIN" ]; then
  echo "FAIL: packaged E2E bins disagree"
  FAIL=1
fi
if [ -z "$package_e2e_bin" ]; then
  package_e2e_dir=$(mktemp -d)
  package_e2e_install_dir=$(mktemp -d)
  if npm pack --silent --pack-destination "$package_e2e_dir" >/dev/null; then
    package_e2e_tarballs=("$package_e2e_dir"/*.tgz)
    if [ "${#package_e2e_tarballs[@]}" -eq 1 ] \
      && [ -f "${package_e2e_tarballs[0]}" ] \
      && (cd "$package_e2e_install_dir" && npm init --yes >/dev/null) \
      && npx --yes --package=pnpm@11.5.0 pnpm --dir "$package_e2e_install_dir" add --ignore-scripts "${package_e2e_tarballs[0]}" >/dev/null \
      && npx tsx ts/scripts/pnpm-dsh-closure-proof.ts "$package_e2e_install_dir" \
      && [ -x "$package_e2e_install_dir/node_modules/.bin/gotry" ]; then
      package_e2e_bin="$package_e2e_install_dir/node_modules/.bin/gotry"
    else
      echo "FAIL: packaged E2E runtime preparation failed"
      FAIL=1
    fi
  else
    echo "FAIL: package creation failed"
    FAIL=1
  fi
fi

echo
echo "=== 45. Agent turn boundary(路由 quick/sync/deep→wall-clock 双出口 converge/handoff;handoff 落 gotry_turn_handoff.v1 工单;确定性路由表测 + Cordis integration + dsh headless E2E) ==="
(cd ts && npx tsx scripts/turn-policy-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/agent-planning-turn-deadline-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/turn-handoff-collect-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/turn-handoff-job-tests.ts) || FAIL=1
if [ -n "$package_e2e_bin" ] && [ -x "$package_e2e_bin" ]; then
  (cd ts && GOTRY_DEADLINE_E2E_BIN="$package_e2e_bin" npx tsx scripts/agent-planning-turn-deadline-e2e.ts) || FAIL=1
else
  echo "FAIL: turn-deadline packaged runtime unavailable"
  FAIL=1
fi

echo
echo "=== 46. Evaluation Phase 0 foundation(four v0 contracts/seven-source registry/diagnostic fixtures/test-only aggregate admission;no adapter,runner,Python,uplift claim) ==="
(cd ts && npx tsx scripts/evaluation-contract-tests.ts) || FAIL=1

echo
echo "=== 47. Evaluation cadence policy(PR/nightly/weekly/milestone admission/pass^k/budgets/calibration/stop signals;no scheduler,runner,spend,score,Agent round) ==="
(cd ts && npx tsx scripts/evaluation-cadence-tests.ts) || FAIL=1

echo
echo "=== 48. Benchmark environment bridge(default-off/allowlist/failure/env isolation/model-driven installed runtime;focused contract + packaged CLI E2E) ==="
(cd ts && npx tsx scripts/benchmark-environment-bridge-tests.ts) || FAIL=1
if [ -n "$package_e2e_bin" ] && [ -x "$package_e2e_bin" ]; then
  (cd ts && GOTRY_BRIDGE_E2E_BIN="$package_e2e_bin" npx tsx scripts/benchmark-environment-bridge-e2e.ts) || FAIL=1
else
  echo "FAIL: benchmark packaged runtime unavailable"
  FAIL=1
fi
echo
echo "=== 49. Booking Copilot embedded contract(canonical schema/npm subpath/closed read registry/task-scoped ledger/real dsh core/BFF-only SSE/production bin;local model fixture) ==="
(node scripts/build-dist.mjs) || FAIL=1
("$TSX_BIN" scripts/booking-surface-package-proof.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-surface-contract-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-gap-code-contract-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-intent-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-runtime-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-availability-policy-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-availability-ledger-binding-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-receipt-ledger-concurrency-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-operation-ledger-concurrency-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-event-sequence-concurrency-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-server-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-dsh-plugin-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-dsh-planner-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/managed-dsh-run-port-proof.ts) || FAIL=1
(cd ts && npx tsx scripts/managed-dsh-cleanup-diagnostic-proof.ts) || FAIL=1
(cd ts && npx tsx scripts/managed-dsh-terminal-proof.ts) || FAIL=1
(cd ts && npx tsx scripts/managed-dsh-close-failure-proof.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-startup-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-dsh-core-proof-tests.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-dsh-readiness-proof.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-dsh-warmer-proof.ts) || FAIL=1
(cd ts && npx tsx scripts/booking-copilot-bin-proof-tests.ts) || FAIL=1

echo
echo "=== 49b. dsh-map-tools vendored package proof(issue #202:clean tarball install + MIT license/provenance + alpha.3 settings closure + exactly seven map_* tools + network-free inline coordinates) ==="
(GOTRY_MAP_TOOLS_E2E_BIN="$package_e2e_bin" "$TSX_BIN" ts/scripts/map-tools-vendor-package-proof.ts) || FAIL=1
echo "=== 49c. Doctor onboarding + FlyAI installed product E2E (isolated setup, all eight search kinds, error recovery; controlled upstream) ==="
(node scripts/doctor-onboarding-tests.mjs "$package_e2e_bin") || FAIL=1
if [ -n "$package_e2e_bin" ] && [ -x "$package_e2e_bin" ]; then
  flyai_e2e_parent=$(mktemp -d)
  node scripts/flyai-product-e2e.mjs "$package_e2e_bin" "$flyai_e2e_parent/evidence" || FAIL=1
  echo "FlyAI product evidence: $flyai_e2e_parent/evidence"
else
  echo "FAIL: FlyAI packaged runtime unavailable"
  FAIL=1
fi
cleanup_packaged_e2e_runtime
trap - EXIT

echo
echo "=== 50. 通道注册表与健康面(docs/design/tool-orchestration-design.md,#106/#107/#108 编排设计:注册表封闭性/意图顺位=证据级×效率/routingAdvice 健康态驱动/flyai 达限即改道·hit 即恢复/verdict 映射闭集/persona 路由卡确定性/JSONL 持久面+坏行容忍/doctor 配额可见+calendar 三态/持久面 down 投影与会话态并集(#436);全离线) ==="
(cd ts && npx tsx scripts/channel-registry-tests.ts) || FAIL=1

echo
echo "=== 51. 指标面板只读聚合面(#138 第一切片:事实闸 verdict 分布与 blocked 率/通道健康 30 天窗/事故面 7 天窗/桥延迟百分位与 >500ms 复审锚点/坏行容忍/空根成型/stateRoot 零写入;全离线) ==="
(cd ts && npx tsx scripts/metrics-report-tests.ts) || FAIL=1

echo
echo "=== 52. 通道探针 tick(外部事件接缝第 1 段:evaluate 纯函数/latest-wins 'ok' 恢复语义/doctor 口径兼容/metrics ok 超越/CLI 探测面/严格时间戳 opt-in(#436:坏行不得顶掉更早有效 down,默认口径不变);全离线) ==="
(cd ts && npx tsx scripts/channel-probe-tests.ts) || FAIL=1

echo
echo "=== 53. 愿望池通道否证(外部事件接缝第 2 段:conditions.channels/down 否证召回/健康不加分/旧调用零破坏/畸形忽略/0..1 集成;全离线) ==="
(cd ts && npx tsx scripts/wish-channel-gate-tests.ts) || FAIL=1

echo
echo "=== 53b. 外部事件 inert W2A 合同(#432/#82:默认关闭/exact tuple admission/核心 envelope 投影/opaque 字段剥离/fetch spy未调用+permission子进程拒绝文件写入/子进程;纯函数无IO,无消费者注册) ==="
(cd ts && npx tsx scripts/external-event-tests.ts) || FAIL=1

echo
echo "=== 54. persona 表层护栏(#192/#2/#194 回归锚:表层规则句存在/13 条契约编号完整(2026-09-11 瘦身改锚)/skill 失败行为指引/动态变量注入面;全离线) ==="
(cd ts && npx tsx scripts/persona-surface-guard-tests.ts) || FAIL=1

echo

echo "=== 55. M4 planning lifecycle collector(issue #228:显式 stateRoot+consent+HMAC key/首返配对/等待边界/reflux+preference/source_review candidate/子进程 scorer 链;全离线) ==="
(cd ts && npx tsx scripts/memory-lifecycle-tests.ts) || FAIL=1

echo "=== 56. tz-resolver + IANA planning offsets(issue #343:China 出境/回程/DST gap/overlap/未知 zone/v1+v2 解析/legacy 兼容/反向日界线/跨日真实 UTC instant;纯离线) ==="
(cd ts && npx tsx scripts/tz-resolver-tests.ts) || FAIL=1

echo "=== 57. issue #343 real-entry adapter precedence(parse→merge→solve→render;dsh fetch fixture + mock shared helper;纯离线) ==="
(cd ts && npx tsx scripts/issue343-real-entry-e2e.ts) || FAIL=1

echo
echo "=== 58. G5 内部差旅桥机械闸(issue #348:tracked 文件零未授权内部桥引用,授权台账 docs/g5-authorization-ledger.md 仅创始人侧维护;含红→绿+exit2 自测,临时 git fixture 走 --root,全离线) ==="
(cd ts && npx tsx scripts/g5-guard.ts) || FAIL=1
(cd ts && npx tsx scripts/g5-guard-tests.ts) || FAIL=1
echo
echo "=== 59. 春节锚点表生成漂移闸(issue #274:lunar-typescript 构建期生成 2026-2099,表/生成块漂移即红;全离线) ==="
(cd ts && npx tsx scripts/gen-lunar-anchors.ts --check) || FAIL=1

echo
echo "=== 60. HotelByte 交易 bridge unknown 查单对账契约(issue #232:book 执行分类 exit0≠成功/种子 fail-closed/窗口内 miss 保 unknown/窗口届满非无订单证明/冲突显式人工/权威负证据才允许新 intent;纯函数契约层,非运行时激活,零真实供应商调用;spawn 级完整链路 E2E 已落地见 §66) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/hotelbyte-reconcile-tests.ts) || FAIL=1
echo
echo "=== 61. WriteGate 机制层否证(issue #231:持久化可信审批+原子 outbox;PreparedChallenge/一次性消费/双进程领取竞争/崩溃注入三崩溃点/物理 CHECK+外键+触发器红线/L4 撤回;全离线,零真实供应商调用,非运行时激活,M5 Entry 前产品运行时不实例化) ==="
(cd ts && npx tsx scripts/write-gate-tests.ts) || FAIL=1
echo
echo "=== 62. #233 取消/退款独立结果与佣金披露契约层(M5-4 pre-entry:双对象独立终态无合并成功态/serviceFee≠退款金额/refunded 绑权威证据/披露 digest 入指纹且口径变化即拒/unknown 不默认 none/账本分词与文案分词一致 480 组合;纯契约零真实调用) ==="
(cd ts && npx tsx scripts/issue-233-cancel-refund-commission-tests.ts) || FAIL=1

echo
echo "=== 63. 内核清单冻结+运行模块证据闸(issue #234:gotry_kernel_manifest_v1 哈希零 diff(改核心/删文件/废弃层冒充即红)/真实运行 import trace 全加载(未加载/替换内核即红)/同引擎·账本·闸路径功能覆盖(缺路径即红)/证据快照 manifestHash+evidenceHash 哈希绑定(错 SHA 即红);含反证自测,import-only 零状态写入,全离线) ==="
(cd ts && npx tsx scripts/kernel-manifest-gate.ts) || FAIL=1
(cd ts && npx tsx scripts/kernel-manifest-tests.ts) || FAIL=1

echo
echo "=== 64. sponsor 插件与同内核端到端复用证明(issue #235:三主体分离 fail-closed/激活默认关/越权路由+缺 session 绑定拒绝/同内核零拷贝零重声明/佣金不伪造用户效用/B2B fixture E2E 披露入指纹/B2C 同 runner 零渗入+saga 边逐格同/A-B 同业务 id 不串;全离线 fixture,非运行时激活,零真实调用) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/sponsor-reuse-tests.ts) || FAIL=1
echo
echo "=== 65. Booking Copilot unavailable/changed 恢复链契约(issue #142 非门控切片:检测分类复用 receipt status 闭集/受控恢复三轮计入 planner 三次调用预算/静默换房换航结构性拒绝/降级必携显式披露/审计链 saga 形态可对账;纯函数契约层,非运行时激活,零真实供应商调用) ==="
(cd ts && GOTRY_SESSION_LIVE=0 npx tsx scripts/booking-recovery-chain-tests.ts) || FAIL=1

echo
echo "=== 66. HotelByte 假 CLI spawn 级完整链路 E2E(issue #232 §5:本地 fixture 二进制经真实 child_process spawn 跑通 quote→approval→book→unknown→query-orders 全链/裸调用红基线 6 证伪/timeout→miss→迟到成功与迟到自动取消/exit0 垃圾·无绑定·部分确认不假成功/进程被杀/同 ref 多单冲突显式/窗口届满转人工不重订/探针失败不证明订单不存在;全离线 fixture,零真实 hbcli·网络·凭据,所有 spawn 有界超时) ==="
(cd ts && GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 npx tsx scripts/hotelbyte-spawn-e2e-tests.ts) || FAIL=1

echo
echo "=== 67. issue #436 持久健康面→注册工具 routing 建议 E2E(跨进程 fixture 探针子进程走真实 evaluateProbeResults+recordChannelEvent 写 channel-health.jsonl→真实注册工具 gotry_flyai_search/gotry_session_search 结果 \`routing\` 字段断言:持久 down 排除(本进程该通道会话态为空)/非会话通道同样生效/会话 down 优先于持久 'ok' 恢复/会话 hit 清除后有效持久 ok 恢复/独立根不串根/过期·未来·缺·坏时间戳均不压制且坏行不得在 latest-wins 前顶掉更早有效 down/同根追加可重复;夹具按产品真实操作标签登记并记录实际请求标签防错位;隔离临时 stateRoot+有界子进程,全离线无网络无真实供应商) ==="
(cd ts && npx tsx scripts/issue436-persisted-routing-e2e.ts) || FAIL=1

echo
echo "=== 67b. Issue #443 本地 Lavish Editor 会话适配器(offline:trust/path 白名单/argv 形状/字节与超时上界/状态机/进程组 reap/生命周期规则;GOTRY_LAVISH_LIVE=0 强锁,合成 lavish-axi 包树,零网络零真浏览器,ambient opt-in 也不得安装/调用外部 CLI) ==="
(cd ts && GOTRY_LAVISH_LIVE=0 npx tsx scripts/lavish-local-tests.ts) || FAIL=1

echo
echo "=== 67c. Registered Lavish review tools (issue #443: host authority, serialized lifecycle, terminal races, owned process cleanup; isolated offline fixtures) ==="
(cd ts && GOTRY_LAVISH_LIVE=0 npx tsx scripts/lavish-product-tools-tests.ts) || FAIL=1

echo
echo "=== 68. state-ledger 数据修复控制面(issue #254:只读 inventory 零写入/显式映射 plan 逐项校验+跨 tenant idem_key 冲突暴露/from 守卫受限 execute+backup SHA-256+journal 幂等+retarget/rollback 校验和验证+损毁拒绝/CLI --execute 闸与 founder 数据守卫;隔离 stateRoot fixture,全离线) ==="
(cd ts && npx tsx scripts/state-repair-tests.ts) || FAIL=1

echo
echo "=== 69. 桥作业账本(批次 A「桥作业账本化」:bridge.db 三表与 state-ledger 分库/write-before-submit 先写后派发·账本写失败即提交失败/领取与善果回包落账/claimed 超时→unresolved+节律冷却·未被领取超时→void/未知回包 404 unknown-job+孤儿 result 落库对账/recoverOnBoot 重排复活结算/bridge_clients upsert+login_sites 名字级/挂载路径模块接线与账本节律读判定;隔离 stateRoot,全离线) ==="
(cd ts && npx tsx scripts/bridge-ledger-tests.ts) || FAIL=1

echo
echo "=== 70. 桥事件上行(批次 B:POST /v1/session/bridge/events——bearer+扩展 Origin 白名单双校验与 /jobs 同链/缺 key 503·错 Origin 403/形状守卫 400/混合批次逐条裁决 accepted·rejected/bridge_events seq·ts·idem_key 部分唯一索引幂等·NULL 不去重/payload_json 原样落账/body >256KB 超限 400 零落账/无账本形态 503 fail-closed;真实 createBackendServer HTTP 面+隔离 stateRoot,全离线) ==="
(cd ts && npx tsx scripts/bridge-events-tests.ts) || FAIL=1

echo
echo "=== 71. Money/FX fact 契约(issue #344 契约切片,创始人 2026-10-02 授权提前·默认关闭:金额+币种+汇率证据(来源/抓取时刻/估值时点)全字段必填,未知/缺失一律 fail-closed 不猜汇率/主源+降级仅接口与数据形状 seam,注册表冻结为空+触发闸 false,触发前零浮动汇率源被咨询(D-26 边界不变)/同估值时点比较,混时点显式拒绝带证据/交叉汇率·零负值·精度·午夜切换·旧 rate·供应商币种变化反例;纯函数零网络零活体源) ==="
(cd ts && npx tsx scripts/fx-contract-tests.ts) || FAIL=1
echo "=== 72. 离线行政区划 atlas 加载器(issue #342 机制就绪·默认关闭:只读加载器 ts/capabilities/geo-atlas.ts 零调用方,数据面零切换;manifest schema/SHA-256 校验/缺 manifest·坏 JSON·错 schema·缺件·篡改·损坏·形状漂移·重复 id 全部 fail-closed/同名地 ambiguous 带候选不代选·layer 过滤/未知地区三值 miss 携快照 provenance/中文名命中·大小写空白归一/两次加载确定性/fetch spy 全程零网络;合成小 fixture 驱动,不依赖构建产物与网络) ==="
(cd ts && npx tsx scripts/geo-atlas-tests.ts) || FAIL=1
echo "=== 73. 服务运行时观测补齐(#272/#511,2026-10-02 UAT 只读实查证实的证据留存缺口:session-search verdict 结构化日志——形状/脱敏哨兵/≤200 摘要/单行化/rates·evidence 不入日志;planner 子进程 boot 观测——HARNESS_BOOT_STAGE 成功行含 initializeMs·reused 不重复打/HARNESS_BOOT_TIMEOUT 分类行/PLANNER_BOOT_TIMEOUT 结算行;gotry-backend 启动阶段行——CORE_BOOT_STAGE module_mounted×3+listening/CORE_BOOT_FAILURE 形状;全离线,fake search/runPort 注入+临时 fixture worker 子进程+隔离 stateRoot) ==="
(cd ts && npx tsx scripts/observability-tests.ts) || FAIL=1

echo
echo "=== 74. 会话双区记忆分区契约纯核(P4-1,design/session-dual-zone-memory-design.md §5:闭集 hot_context·trip_notebook 未知拒收/写侧负面清单证件·手机号·URL·凭证零入区/owner 确认引用闸/rev CAS 同 rev 幂等 no-op·stale_rev fail-closed 类型化/注入时钟分层 TTL 30min resource·24h intent 只自写入起算读不续命/确定性 fold 重建==直读;纯函数零 IO·零定时器·零网络,不接账本(P4-2)与会话(P4-3),内核 manifest 零漂移;全离线;编号 71→74:§71 FX/#606、§72 atlas/#608、§73 观测/#607 先后占号) ==="
(cd ts && npx tsx scripts/session-zones-tests.ts) || FAIL=1

echo
echo "=== 75. M3 种子 cohort 采集(issue #22,scripts/product-metrics.ts 评分器此前零生产方:显式 opt-in(无 HMAC key/无 consent/未 init 一律零写入)/HMAC-SHA256 假名 participant·plan·cohort_id·cohort-key-verifier 四类键全部按 evidence_kind 域分离/append-only 幂等重放 unchanged/乱序与越界 fail-closed 类型化(同人第二条 NPS 被写时拒)/ts/dsh-runtime·~/.dsh·~/.gotry·.git 状态根拒收·0600 文件 0700 目录/writer lock:活写者与不可读 pid 一律 lock_busy 零写入、记录 pid 已死的残锁被回收且 lock-status/unlock CLI 只清死锁/导出四文件全有或全无(半占用证据根零残留,预检四个目标后才落第一个字节) + 严格 gotry_m3_cohort_record_v1 形状 + 真实 product-metrics.ts 子进程消费/合成标签反证:(a) 全项达标的合成 cohort 仍 business_pass=false、(b) 模拟记录既不得入 real_seed_cohort 存储也不得入已 attest 为 real 的证据根、(c) PII 哨兵零落盘、(d) 单字段改标 real 以及三个摘要全部重算的完整伪造都被 attestation 的密钥 MAC 抓住(verify 必须持 key,错 key/无 key 均拒);(a)(b)(d) 各带红基线:同样数字手写成 real 时评分器单独会给 business_pass=true、伪造后的无密钥摘要逐一自洽;隔离 mkdtemp 状态根,全离线) ==="
(cd ts && npx tsx scripts/m3-cohort-tests.ts) || FAIL=1

echo
echo "=== 76. LLM persona 模拟 harness(issue #22 采集面验证,SYNTHETIC ONLY 永不计入 M3/M4:≥6 张有依据的人格卡闭集校验(卡片字段/枚举/重复 id/继续无话/nps 越界全拒)/无凭证且非 --dry-run = waiting_external_evidence 零写入零花费零请求(与 nightly-evidence.ts 同停机纪律)/--dry-run 本地 fixture OpenAI 兼容端点同时服务产品模型与人格模型,跑通真实会话链:确定性访谈→真 LLM 翻译 seam→规划窗口闸→真 solveUnified/候选求解→真注册 gotry_fact_gate 读隔离 stateRoot 事实注册表→claim 裁决→m3-cohort 记录→真评分器;产品 prompt 未能分类即 500 硬失败(dsh-llm.ts prompt 漂移会炸测试)/同冻结时钟两次导出字节一致/永不计入的两道独立保证分别验证:记录级(模拟参与者全部 test_or_staff=true→评分器合格样本 0、排除计数=交付数)与 manifest 级(同样 50 条未排除记录仍 business_pass=false);漏斗数字由 harness 纯函数 summarizeFunnel 自算(空分母 null 不报 0%)/被审计分母只计可裁决 claim:空注册表→locked=0、poi unavailable 而非好看的 0%/每条合成记录带 persona_id + prompt_digest provenance 且 attestation 经密钥 MAC 校验/预算在轮次之间判定(越限会话中途 budget_exceeded、批次停批但已付费记录照常导出)、未封存价目模型在任何花费前 fail-closed、provider 缺 usage = 成本不可证 fail-closed 零导出/真实批次必须同时给 state-root 与 evidence-root、不安全状态根在建任何目录前即拒/轮次按卡片 patience 有界、PII 哨兵零落盘、自有临时根必清/全程 fetch spy 对非 127.0.0.1 直接抛错阻断,零真实网络零凭证外泄) ==="
(cd ts && npx tsx scripts/persona-sim-tests.ts) || FAIL=1

echo
echo "=== 77. 会话双区记忆账本落点(P4-2,issue #255:六 kind 以日志类事件落**既有** events 表(零新表/零 schema 迁移/state-ledger.ts 零改动)/单事务{fold 读 rev;守门闸;INSERT}——stale_rev·负面清单·闭集·缺 owner 引用在插入前拒绝且账本零新行/双道幂等(守门层同 rev 重放 appended:false + UNIQUE 索引物理 no-op)/幂等键带生代使 drop→重捕获不被吞/真实子进程 kill -9 提交前崩溃 = 全无·正常提交 = 全有/forget 物理硬删 + 恰一行审计(会话级多主体仍一行)/state-cli export 两派生视图逐字节 == fold 且导出零新事件/读上界 log_truncated 在写路径·会话级遗忘·导出视图三处全 fail-closed(readEvents 丢最老事件,残缺 fold 会漏删主体/冒充全量)/capture_or_touch 过期笔记续命复活与同形观察续 TTL(纯 capture 仍 stale_rev)/生代碰撞 idem_collision 显式失败不报假幂等/坏行与伪造文档确定性跳过/与既有投影及租户互不干扰/账本零过期事件;隔离 mkdtemp stateRoot,全离线,有界子进程超时) ==="
(cd ts && npx tsx scripts/session-zone-ledger-tests.ts) || FAIL=1

echo
echo "=== 78. 会话双区记忆会话接线(P4-3,issue #255:sessionZones 总闸默认关——缺省/未知值 fail-closed 关、分区工具不注册、读回变量**连名字都不注册**(注入面清单与 main 逐项一致;§48 对产品模式变量清单逐项断言)、白名单 execute 不被包裹、不建库、既有工具清单逐项不变;开闸后捕获缝只投影形状字段(verdict/条数/价格带)——零名称零 URL零自由文本、证据只走指针(摘要 session_ref + 观察序号)、分区内永不出现宿主 session id 原文/负面清单端到端(证件·手机·URL·凭证零入区)/读回首访空串与条数字符双上界/propose 零落账(模型永不自晋升)+ owner 原话引用闸(宿主 schema 闸与代码闭集双道)/§3 路由:preference→动机闸·trip_fact→时间线闸·点名同行人的约束→同行人闸,缺路由载荷 routing_required 拒收,既有闸拒绝即同事务整笔回滚/路由逃逸两道闸:换 kind 声明或抹掉 companion_label 都绕不过既有闸、路由载荷与分类不符即拒/动机闸未落地该断言即整笔回滚(saved 二义性不可信,核对结果而非信 flag)/读回按组装 scope 隔离:同进程两会话互不可见对方 resource 层笔记、取不到 scope 即不出该段/捕获缝续命:同一检索过 TTL 再跑一次续命回读视图/CAS stale_rev 与更正即弃/过期源不得晋升;真实 apply() 注册面 + 注入离线 effect 夹具(零真实供应商/零 homedir 依赖) + mkdtemp 隔离 stateRoot,对 ts/dsh-runtime/gotry-state 零写入(前后快照断言),全离线) ==="
(cd ts && npx tsx scripts/session-zone-wiring-tests.ts) || FAIL=1

echo
echo "=== 79. 会话双区记忆观测面与可否证指标(P4-4,issue #255:形状计数(分层捕获·修订·弃用/笔记本三计数/过期年龄分桶/活笔记)零 id·零载荷·零时间戳逐键断言、坏时钟不猜、两次投影一致;计数接收器显式 opt-in(GOTRY_SESSION_ZONE_OBSERVE=1),默认全 0 no-op,接线面 propose·deny·confirm·读命中真的入账(无否决面则确认率恒 1 = 假指标),计数去重口径与指标 proposal_ref 一致(同一提议重复只记一次,确认只在真落条目时记);三可否证指标阈值**见数据前冻结**——样本线 5 与收益线 0.5 同 #20 已冻结值、确认率下界 0.5、失效率上界 0.1,夹具声明改一个数即 contract_invalid、样本不足 insufficient_sample、样本形状非法 bad_sample;夹具只证契约不证价值(synthetic exit_evidence_eligible/value_claimed 恒 false,observed_private 只到 candidate 且永不生成 reviewer/attestation);候选导出只带计数与 HMAC 假名引用(键集闭集断言零内容字段)、摘要绑定、缺同意·缺/弱 HMAC key fail-closed;观测路径零定时器零网络(fetch/setTimeout/setInterval 真实 spy);#20 scorer 冻结 p4 闸未被触碰;只读 CLI 不建库、--out 不覆盖;隔离 stateRoot,全离线) ==="
(cd ts && npx tsx scripts/session-zone-observation-tests.ts) || FAIL=1

echo
echo "=== 81. 触发演练:#82 world2agent sensor(simulated_trigger_drill——模拟外部触发只证明激活机制,不满足 #82 触发条件、不裁决 D-31:独立 OS 进程夹具 sensor 经 stdin+文件两种投递把 w2a/0.1 envelope 送进既有惰性适配面;default-off 全拒/精确四元组 source·package·version·type 单字段变更即拒/敌意语料 伪造发信声明·重放·超限·两万层深嵌套·原型污染键·自然语言注入·未知事件类型·时间戳偏移 在进程内与跨进程逐条判定一致/副作用隔离 Node 权限模型 fs 写·child_process·网络全 ERR_ACCESS_DENIED + 隔离根零文件 + 零 fetch 零定时器/激活路径溯源 已批准本地探针真达持久健康面而 w2a 元数据无 channel 词位且产品零调用方=契约边界据实上报不接线/callback 方决策模板 15 项可执行清单逐项 satisfied_by_contract 或 needs_real_party;全离线无真实 sensor·无桥·无回调方) ==="
(cd ts && npx tsx scripts/drill-w2a-sensor-tests.ts) || FAIL=1

echo
echo "=== 82. 触发演练:#275 D-15 多写者/多用户(simulated_trigger_drill——mkdtemp 夹具不构成生产证据,不满足第二真实用户·多机部署·AaaS 触发:真实子进程并发 冷开竞争安全面钉死+追加面幂等键去重·无丢更新·租户隔离·integrity_check/崩溃演练 事务内具名崩点与产品写路径定时变化 SIGKILL 后重开 all-or-nothing 与 fold==直读/陈旧领取 N dispatcher 竞争恰一赢家·fencing·租约过期不回 queued·存储层 forward-only 触发器·跨租户影响行数 0/写负载下 SQLite 在线备份→恢复 校验和+事件序前缀+fold 自洽/Litestream 与 cr-sqlite 未装记为 needs real trigger + dependency decision;state-ledger.ts 只读不改) ==="
(cd ts && npx tsx scripts/drill-multiuser-ledger-tests.ts) || FAIL=1

echo
echo "=== 83. 触发演练:#422 dsh SDK 后代清理再基线(simulated_trigger_drill——夹具 dshBin 不是真实产品调用面,不构成 #422 触发或上游归属裁决;dsh 家族 2026-10-02 升 0.2.0-rc.2 故按实测钉死:SDK 静态证据 spawn 无 detached·永不按进程组发信/不响应且忽略 TERM 的 runtime 走真实 close() 梯级 shutdown→stdin EOF→SIGTERM→SIGKILL/协作式 runtime 干净退出/DeepSeekHarness 高层同路径/缺二进制语义/close 幂等终态与禁止静默重生/对照组 bin/gotry-process-liveness.js 进程组清理零残留;每个钉死断言带「若翻转则 #422 前提已变」,所有夹具 pid 无论成败 finally 强制收尸) ==="
(cd ts && npx tsx scripts/drill-sdk-descendant-cleanup-tests.ts) || FAIL=1

echo
echo "=== 84. Anything 路径只读测量探针(#276/#345 触发演练的证据探针:GOTRY_UAT_READONLY=1 才会起 hbcli,缺省零进程零测量·exit 0 waiting_external_evidence/百分位最近秩·失败按原因计数且保留耗时/字段存在率空串·空数组·空对象不计/凭据形状脱敏·≤160 字符/突发阶段并发不超 5/只输出聚合不落原始回包;真实 hbcli 路径从不被测试使用,全离线;测量真实路径但不满足任一 tracker 的触发条件) ==="
(cd ts && npx tsx scripts/anything-path-measure-tests.ts) || FAIL=1

echo
echo "=== 85. 成交结果↔规划估算投影契约(issue #340 模拟触发演练,证据标签 simulated_trigger_drill/fixture_contract——真实触发未发生,tracker 保持 open 且默认关闭:plan estimate↔immutable quote↔attempt↔账本 intent 四必填关联键+确定性派生/闭集 pending·confirmed·failed·cancelled·refunded·unknown,unknown 与超时永不记成交也永不记零偏差(结构化 not_comparable 不返回数值)/本地账本词 compensated 拒作供应商终态(compensated≠refunded)·serviceFee 拒作退款额·refunded 必绑权威退款记录/append-only 可撤销投影:同幂等键同载荷重放零新条目·异载荷冲突·撤销本身是条目不删不改·确定性 fold 重建==直读/终态不回退(terminal→open regression、终态冲突)且迟到终态被接纳并标记/负面清单:敏感订单字段按名拒+凭证·手机·证件·邮箱·URL 值形扫描拒,证据只走摘要与指针——数字身份模式两侧锚定且逐叶扫描(嵌在字母数字串里的 15+ 位数字不算证件号,合法 SHA 摘要不被误拒;独立成串的任意长度数字仍拒,纯十进制不给豁免)/偏差只校准未来估算与排序(有界 ppm 钉上下界·薄样本回中性·indeterminate 只计数不计值),反证falsification:校准额永不能翻转用户预算硬约束(hard_budget_guard)/真实订单摄取缝触发闸冻结 false+注册表冻结空+fetch spy 零调用;纯函数零网络零子进程零 CLI,夹具只读复用 hotelbyte 假 CLI 词表,真实订单 E2E 待 M5+真实授权记录,明确不在本节范围) ==="
(cd ts && npx tsx scripts/outcome-projection-tests.ts) || FAIL=1

echo
echo "=== 86. 城市×场景分级机制(issue #339 模拟触发演练,证据标签 simulated_trigger_drill/fixture_contract——真实样本未到,tracker 保持 open:只交机制不交内容,CITY_SCENARIO_TIER_REGISTRY 源码级冻结为空 + 触发闸冻结 false,admitTierEntry 在任何校验之前拒收(不凭 fixture 造画像),词表提案只在演练报告里标注为未验证假设/版本化 taxonomy schema:每档强制 provenance(RFC S2 证据等级闭集·real_usage_sample 唯一准入来源·≥3 条可审样本引用·问责评审人·冻结时刻)与 retirement(淘汰条件+复审期限须晚于冻结)/semantic×bounded_modifier 有界整数 ppm 钉上下界,0·负·越界·小数·非数一律拒(下界>0 即结构上无法抹掉候选)/中性退回:触发未开·空注册表·未知城市·未知场景·冲突证据 五因均回 ×1.0 且冲突不代选(只暴露冲突 tier_id)·坏键是调用方错误不静默中性/语义分必须非负(乘法契约下负分会把加权反转成降权,一条负分即拒整次排序;零与负零为边界可用)/反证 falsification:modifier 只能重排永不能移除候选(含下界×零语义分·11×3 组合电池·结果形状零 exclude/filter/drop 字段·机械 no-hard-filter 检查自身可证伪)/确定性与稳定并列序,缺陷注册表读时拒绝不静默夹取;纯函数零 IO·零网络·产品面零调用方,不接 unified.ts 排序(内核钉住)) ==="
(cd ts && npx tsx scripts/city-scenario-tier-tests.ts) || FAIL=1

echo
echo "=== 87. D-39 活体路线供应商合规闸(issue #429 模拟触发演练,证据标签 simulated_trigger_drill/fixture_contract——以「具名用例+候选供应商」在契约层模拟,不触达任何真实路线供应商,各路径仍保持 open 且默认关闭,#341 既有窄范围不动:触发闸 D39_LIVE_ROUTE_TRIGGER_FIRED 冻结 false+准入注册表冻结空,consultRouteProvider 在触碰 adapter 之前拒绝(fetch spy 零调用)/mock adapter 八故障模式(unavailable·stale·mismatched_direction·mode_relabel·estimate_as_live_traffic·challenge·rate_limited·partial_result)驱动九条合规条款:方向绑定按响应回显校验(非由请求假定)·模式隔离(driving↔transit/rail 任一方向改标即拒)·证据级隔离(估算冒充 live_traffic 即拒,弱级填强承诺同样拒)·新鲜度合同·来源身份+source_sha·故障 fail-closed 无静默降级·静态回退与原价标签逐字保全·路线商永不自任票价权威·故障详情脱敏(响应体/标记/cookie/token/URL 零外泄)/闸自身可证伪:静默接受故障即该条款红、未探测条款不得记 pass、零探测不可准入/对既有 ts/capabilities/ground-transfer.ts 实跑适用条款——七条通过(其中故障详情脱敏是本次修复后才通过:GAP-429-3 产品可达泄漏已修,safeErrorMessage 改走共享 provider-detail-sanitize,历史 400 字符上界与空值文案保留;回归走真实解析路径断言出程·回程·聚合原因与 exposeGroundTransferEvidence 输出均不带 token/cookie/标记,另有五条本来安全的消息逐字原样通过),两条休眠缺口继续钉住 GAP-429-1/2(模式改标被静默丢弃、响应侧 O/D 不校验)且断言消息自带 FLIP 指引;细节与最小复现见 docs/evaluation/trigger-drill-report-contracts.md/模块唯一 import 是纯脱敏器、零网络零缓存零时钟(now 由调用方注入),不耦合 evaluate/solve 内核,合规闸自身产品面零调用方) ==="
(cd ts && npx tsx scripts/route-provider-conformance-tests.ts) || FAIL=1

echo
echo "=== 88. dsh-llm 请求级超时与调用方取消(issue #618:chat() 此前既无超时也不收 signal,provider 连上后不应答会让 nightly-evidence/replay-real/persona-sim 无限挂起;现为 AbortSignal.timeout(默认 300000ms,GOTRY_LLM_TIMEOUT_MS 或调用方显式值可改,非正整数忽略,超大值夹到 2^31-1 防 Node 溢出成 1ms)+调用方 signal 经 AbortSignal.any 合并,整段请求含正文读取同受约束;截断落成类型化 LlmRequestError(timeout|aborted,name 取平台既有 TimeoutError|AbortError,message 沿用 llm <kind>: 约定,cause 保留)而非挂起/吞错,非 abort 失败(HTTP 非 2xx/连接被拒/缺 key)原样不改;usage 累计与缺 usage 即成本不可证的 fail-closed 语义不变,截断调用不动 tracker;127.0.0.1 假 provider 夹具(收下连接永不应答/响应头后正文卡死/错误正文卡死/正常应答)+bounded 包装,回退修复时卡死用例只会失败不会挂起;runTurn 与 nightly-evidence 对卡死 provider 抛类型化失败且 nightly 零写入;全离线) ==="
(cd ts && npx tsx scripts/dsh-llm-tests.ts) || FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "REGRESSION FAILED"
  exit 1
fi
echo "ALL SUITES GREEN(明细见各节;真 LLM 巡检:replay-real.ts / time-eval-tests.ts --real,ADR-11 层)"
