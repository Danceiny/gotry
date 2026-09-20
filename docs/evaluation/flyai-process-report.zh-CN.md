[English](flyai-process-report.md) | [简体中文](flyai-process-report.zh-CN.md)

# FlyAI 本地进程终止报告

> 角色：收口 #514——在既有证据允许的范围内归因离线酒店夹具的 `exit -1` 失败，并锁定原 helper 无法表达的本地终止分类。
> 状态：机制层已闭环；不宣称原始偶发原因已消除。
> 上游：[architecture](../architecture.md)、[effect 策略](../design/effect-interpreter.zh-CN.md)、[#514](https://github.com/Danceiny/gotry/issues/514)、[#516](https://github.com/Danceiny/gotry/issues/516)、[#517](https://github.com/Danceiny/gotry/issues/517)。
> 下游：能力维护者与 PR 审阅者。

## 发现与证据边界

一次 Node 22.23.2 完整回归在混合酒店夹具失败：预期的畸形比例 `1/2` 被替换为 `flyai@error ... exit -1`（`ts/scripts/flyai-tests.ts`）。该次执行退出码 1，耗时 1078.59 秒；完整日志 SHA-256 为 `ef84759ec88a6eeedcdc60ea32cc87a2121aaa5bf1127e65185a43035cef604b`。旧 helper 把 close 的 null 退出码折叠为 `-1`，同时丢弃信号与 5000 ms 时限是否触发，因此该日志无法区分测试时限击杀与其他终止形态。据此既不能认定为酒店解析器缺陷，也不能靠重跑变绿关闭本问题。

## 诊断史（冻结分支）

分支 `fix/flyai-exit-diagnostics-514`（`b520eef`、`1fa6921`）用插桩副本做过隔离有界对照：外部 SIGTERM 在 24 ms 内以 `exit -1` 公开返回；150 ms 受控时限在 153 ms 触发 SIGKILL，同样公开为 `exit -1`；原酒店夹具在 763 ms 返回预期的 `1/2` 比例；空输出对照进入解析失败分支。先打印额度文本再收 SIGTERM 的子进程证伪了旧分类：旧实现返回 needs-setup，插桩版返回 error 且保留信号（夹具 SHA-256 `88bca8c70612da31bc80a9c339ef5527565336828ec4e7508f6d4de47e7b2724`）。该分支的进程记录设计已被主干演进取代，未合入；上述实验及其边界仍是原始失败可归因的记录。

## 最终机制

主干经 [#523](https://github.com/Danceiny/gotry/pull/523) 的取消所有权与 [#531](https://github.com/Danceiny/gotry/pull/531) 的 FlyAI skill 集成（`38d56cf` 本地进程终止 fail-closed）吸收了本要求：

- spawn helper 保留退出码、`signal`、`timedOut`、`drainTimedOut` 与 `cancelled`；命令的其他信息不进入结果。
- `flyaiSearch` 把调用方取消分类为 verdict `cancelled`，本地时限触发分类为 verdict `timeout` 且 `localTermination: 'deadline'`，signal／spawn／empty-exit 终止分类为 `localTermination`——全部先于任何 HTTP 文本扫描，因此终止前打印的陈旧 429 输出不可能被归类为额度 needs-setup。
- 所有本地终止携带 `retryable: false`；效应层策略只重试 `retryable === true`，被终止的调用不会再次尝试，上游瞬时错误保留既有两次尝试预算。
- 畸形比例与零事实断言未变：畸形兄弟项仍使整体失败且不写库存事实；未放宽任何时限，未跳过任何测试。

## 本次收口新增的回归锁定

#514 的立案形状——终止携带陈旧额度文本——此前只有代码处理而没有自动化锁定。`ts/scripts/flyai-tests.ts` 用例 1c 现在运行一个受控 CLI：向 stderr 打印 `HTTP 429 Trial limit reached` 后自行终止；断言恰好一次尝试、verdict `error`、`localTermination: 'empty-exit'`、`retryable: false` 且无 `setup` 补配指引。若退回文本优先分类，该用例即红。

## 验证

收口树上的定向门禁：`npx tsc --noEmit` 退出 0；含用例 1b／1c 的 FlyAI 套件退出 0；完整回归（内置 i18n 与可读性检查）在相同的最终树上执行——耗时、退出状态与完整日志 SHA-256 记录于关联 PR 与 issue 评论。

## 复现

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/flyai-tests.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

## 剩余边界

原始偶发 `exit -1` 在插桩后从未复现；本报告宣称消除的是歧义，不是原因。若复发，最终树可在单次运行内归因——verdict `timeout`、`localTermination` 与解析失败三者可区分。后代继承的 stderr 由独立的 [#516](https://github.com/Danceiny/gotry/issues/516) 有界化。本文所有执行均未触及真实 FlyAI 网络端点、账号或模型。
