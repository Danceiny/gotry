[English](sf-evidence-isolation-report.md) | [简体中文](sf-evidence-isolation-report.zh-CN.md)

# 会话航班证据目录隔离测试报告

> 定位：验证 issue #503 的跑批命令、证据落盘和汇总回读。
> 状态：2026-09-19 本地验证通过；真实供应商验收仍未完成。
> 上游：[数据源约定](../data-sources.zh-CN.md)、[issue #503](https://github.com/Danceiny/gotry/issues/503)。
> 下游：跑批维护者与隔离改动的审查者。

## 证据边界

本报告覆盖命令级端到端链路：真实跑批命令写入逐条记录与批次汇总，真实汇总命令读取这些文件并生成重建汇总。会话响应由临时源码副本中的确定性替身提供，FlyAI 进程被拦截，fetch 请求设有陷阱。本次测试不能证明真实供应商、登录、库存、票价或真实会话验收通过；这些验收条件仍由 issue #272 管理。

## 命令约定

跑批支持 `--evidence-root PATH` 和 `--evidence-root=PATH`。相对路径以调用者的工作目录为基准，含空格的路径保持原样。逐条记录与批次汇总使用同一目录和规范化的批次时间戳；汇总命令必须使用相同目录。

省略参数时保留 `~/.gotry/evidence/session`，兼容既有用户。自动化测试显式传入隔离目录；默认路径兼容测试则将 HOME 限定在临时目录。缺值、空白值、重复或未知参数在查询前失败。根目录是文件、或根目录位于文件下面时，也在查询前失败。`--help` 和 `-h` 显示用法，不查询、不写证据。

## 验证记录

已验证实现：`1d30362cea07563cb337a64ff8702b0f1650f16c`；基线：`20d728e3668d302821bad0f8687ca8ef55d29ed5`。最终验证期间，五个代码与测试文件的 SHA-256 均保持一致。报告提交位于该实现提交之后。

环境：macOS 26.6.2、arm64；两个包目录分别安装锁定依赖；TypeScript 5.9.3、tsx 4.23.13。验证截至 2026-09-19 09:15 UTC 完成。

| 检查 | 实际结果 |
|---|---|
| Node 22.23.2 的命令参数与「命令→文件→汇总」端到端测试 | 14 项参数用例和五项批次场景全部通过。 |
| Node 24.10.0 的相同定向命令 | 19 项全部通过。 |
| TypeScript 类型检查 | 退出 0。 |
| 完整 `scripts/run-all-tests.sh`，运行时初始化选用 Node 24.16.0 | 退出 0，输出 `ALL SUITES GREEN`；包含上述 19 项和 Booking Copilot 真实子进程与插件链路。 |
| 相同端到端测试换用固定旧版本跑批源码 | 按预期退出 1，失败点为显式目录下缺少汇总目录。 |
| 双语结构、可读性与空白检查 | 通过，覆盖 64 对文档和八个经过校准的读者入口文件。 |

完整回归日志 SHA-256：`d16eb3494a0375a54b92c5e7a3755183fa7e449315bc78635708ed0798086719`。当前完整入口已不运行历史 Python 对照实现。明确跳过项为真实 HotelByte UAT、外部 STAICLI 包验证（未提供产物）、七项可选 Agent Reach doctor 断言（未安装）和真实 Lavish 探针。真实供应商、会话登录及真实模型验收均未执行，不属于本次隔离验证通过的范围。

## 用例结果

| 场景 | 预期与实际结果 |
|---|---|
| 首条查询遇到挑战 | 一条记录、一次被拦截的对照进程调用；跑批以 `challenge_stop` 正常退出 0；重建汇总以 `fail_closed` 退出 1。 |
| 第二条查询遇到挑战 | 两条记录，后续查询没有产物；重建汇总保留不完整批次。 |
| 第八条查询遇到挑战 | 保留八条记录，但 `batch_complete=false`，重建汇总仍拒绝通过。 |
| 显式目录完整批次 | 八个查询文件、一份原始汇总，重建汇总通过；所有文件使用同一批次标识。 |
| 默认目录兼容 | 八条记录只写入临时 HOME，汇总回读通过，不创建显式目录。 |
| 命令参数边界 | 14 项通过：两种帮助参数、十种非法参数、两种非法文件系统目标；未观察到查询启动输出或 fetch 请求。 |

四个显式目录场景都使用 HOME 外的含空格目录；第一个场景还使用等号形式的相对路径。逐个查询文件与原始汇总对应记录做深比较，并检查两个命令之间的文件名、批次时间、选中批次标识、查询标识与记录数量。五个临时副本全部清理，并断言清理成功。

相同测试换用 `20d728e3668d302821bad0f8687ca8ef55d29ed5` 的跑批源码后退出 1：旧版本忽略新参数，预期显式目录中的汇总目录不存在。这个反向对照失败符合预期，不是修复后实现的失败。

## 复现方式

先在仓库根目录和 `ts/` 分别执行 `npm ci --no-audit --no-fund --strict-peer-deps` 安装锁定依赖，再运行：

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/sf-live-cli-tests.ts)
(cd ts && npx tsx scripts/sf-live-challenge-stop-tests.ts)
# Expected exit 1, requires the pinned historical commit to be available:
(cd ts && SF503_BASELINE=1 npx tsx scripts/sf-live-challenge-stop-tests.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 ./scripts/run-all-tests.sh
```

两个定向测试均已接入完整回归入口。跑批源码原样复制到临时副本，只替换会话供应方模块。生产查询节律保持不变，测试通过隔离子进程的计时器预加载加速，没有增加生产测试绕过开关。
