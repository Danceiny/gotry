[English](clean-consumer-boot-diagnostics-report.md) | [简体中文](clean-consumer-boot-diagnostics-report.zh-CN.md)

# 干净消费端 SDK 启动诊断报告

> 定位：推进 [#511](https://github.com/Danceiny/gotry/issues/511)——干净消费端的 SDK 启动失败必须留下可归类的记录，而不是只剩裸栈尾；同时用有界复现检验残余的超时假设。
> 状态：诊断已加固并锁进回归；原始 20 088 ms 超时**未**复现（30 次有界启动），因此 #511 保持打开。
> 上游：[architecture](../architecture.md)、[#511](https://github.com/Danceiny/gotry/issues/511)、[#506](https://github.com/Danceiny/gotry/issues/506)、[#488](https://github.com/Danceiny/gotry/issues/488)、[#518](https://github.com/Danceiny/gotry/issues/518)。
> 下游：Booking Copilot／包验证维护者与 PR 评审者。

## 证据边界

下文全部在隔离的 `HOME` 与隔离的消费端根目录下，用打包后的干净消费端打本地 HTTP／SSE 夹具。不触碰任何真实供应商、模型、账号或密钥，也不写入创始人的运行时状态。这些是本地运行时验证，不是浏览器 UAT、真实供应商验收或生产时延承诺。

## 为什么之前的诊断仍会失明

此前的埋点只在**被捕获**的路径上记录阶段、请求数与封闭错误分类。仍有三处缺口，第一处与被记录的失败形态完全吻合。

| 观测到的形态 | 之前的行为 | 缺口 |
| --- | --- | --- |
| 退出码 1、stdout 0 字节、约 731 字节裸 stderr | 异步抛出（在 await 调用之外）的错误绕过了钩子，Node 打印自己的栈 | 阶段与请求数丢失，`recordFailure` 根本不执行 |
| 两条及以上失败记录 | 结尾只打印一个聚合 JSON 数组 | 父进程只保留有界 stderr 尾部，会把头部截掉——那正是根因记录 |
| 任何 JSON-RPC 错误响应产生的 `JsonRpcResponseError` | 不在安全名单内 | 退化为 `"error":"unknown"`，丢掉唯一有用的信息 |

## 改动内容

`scripts/booking-surface-package-proof.ts` 里的干净消费端脚本现在**在第一个 `await` 之前**就装好失败处理，所以最早的失败同样能被归类：

- 阶段按 issue 的措辞排列：`boot` → `initialize` → `model_run` → `complete` → `cleanup`；
- `uncaughtException` 与 `unhandledRejection` 产出与被捕获路径同样的记录形状，并附带 `hook` 字段，随后以退出码 1 结束；
- 每条记录在发生时立即单独成行刷出；当失败多于一条时，根因会以 `CORE_BOOT_FAILURE_ROOT` 在最后重发一次，因此有界尾部始终同时带有根因**与**阶段；
- 安全名单补入 `JsonRpcResponseError`（SDK 对错误响应实际抛出的类），并在存在时记录数值型 `errorCode`。

验证脚本同时多跑一次**故意注入故障**的消费端启动，并断言其诊断：退出码非零；能解析出带阶段、`hook`、安全错误名、耗时与请求数的记录；以及本次回归的重点——该记录及其阶段能在父进程 256 字节 stderr 尾部中存活。

## 有界复现尝试

在三种负载条件下对打包消费端共执行 30 次有界启动，每次运行使用全新的 `dsh-home`。没有任何一次启动失败，因此纯 CPU 饱和假设未获证实。

| 条件 | 次数 | 结果 | 启动耗时 |
| --- | --- | --- | --- |
| 空闲主机，负载约 7 | 10 | 10/10 通过 | 366–388 ms（首轮 1 909 ms） |
| 空闲主机，负载约 14 | 10 | 10/10 通过 | 350–385 ms（首轮 1 144 ms） |
| 饱和主机，负载 150–250 | 10 | 10/10 通过 | 1 120–9 245 ms |

时延对负载高度敏感（空闲与饱和之间约 15–25 倍），而正确性始终成立，因此这里记录的是有界否定结论，而不是修复。饱和阶段跑在钩子顺序调整之前的产物上；该调整只是把钩子注册提前，不改变正常路径。

复现过程中另有一处观察属于工装假象、而非 #511 的缺陷：在**热** `dsh-home` 上用同一会话 id 重跑消费端，会快速失败并报 `JsonRpcResponseError: session "package-proof-core" already exists`。正是它的发现暴露出上面那条 `unknown` 归类缺口。每次调用的消费端根目录互不相同，因此验证脚本不受影响。

## 验证

实现基线：`dbaf06fe1647c8d67559bb8274d07611bbf93cae`。环境：macOS 27.2、arm64；两处包根目录均为锁定安装；dsh 0.1.5-rc.1、TypeScript 5.9.3、tsx 4.23.13。

| 检查项 | 结果 |
| --- | --- |
| 全量回归，Node 26.9.0，最终树 | 退出码 0，ALL SUITES GREEN，864 s；包验证的注入启动断言即在此次回归内执行 |
| 包验证，Node 22.23.2，最终树 | 退出码 0，46 s |
| `tsc --noEmit`（ts 工程） | 退出码 0 |
| 隔离 `smoke` | SMOKE OK |
| 双语文档门禁 | 随交付提交一并执行 |

全量回归日志 SHA-256：`321b03611ccd900d39df6fbfc1ceeb43ff8dd507deecb3a8e0bddc969934ead7`。Node 22 包验证日志 SHA-256：`0ddd53c3dee9393c85abb074f1adf4fabeca8be2c4c5272c48a73acc5a7975ad`。空闲复现日志 SHA-256：`88d1ad5d1a588e4ce232f2ff1d59b6c36ab504fe341b89d0d503b08d1f7d829f`。饱和复现日志 SHA-256：`80f24eb07d314d82836f49329b8b1b6a16fd8605306fb6ae6fed9c1ede3158ab`。2026-09-19 的原始失败日志 SHA-256 仍为 `05112150d9ac3fb6f31344f81db33a9fc2f2f54d0838c5daa1af3a8948bdfd52`；其内容从未归档，无法事后重新归类。

## 复现入口

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/smoke.ts)
node scripts/build-dist.mjs
npx tsx scripts/booking-surface-package-proof.ts
bash scripts/run-all-tests.sh
```

## 残余边界

- 原始原因仍然未知。已记录的形态（20 088 ms 时退出码 1、stdout 为空、约 731 字节裸 stderr）无法凭残留证据归因；加固后的记录正是为把复发归因到具体阶段、请求数与错误类而存在。
- 本轮只改变主机负载。沙箱状态、文件系统时延与 SDK 内部重试行为均保持不变；验证脚本未给 SDK 请求设置期限，因此一旦停摆会表现为阶段记录，而不是超时错误。
- 注入故障发生在 `harness.start()` 之前，因此不会派生运行时子进程，也不会有孤儿残留。要在运行进行中证明同一归类能力，需要验证脚本目前并未断言的清理保证。
- 安全名单之外的错误类仍归类为 `unknown`；扩大名单是一个独立的、需刻意作出的决定。
