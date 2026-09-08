# M4 规划生命周期采集器

> 定位:Issue #228 的显式 opt-in 采集器使用合同,把首访/回访 planning flow 与外部等待边界脱敏成 #223 scorer 可消费的候选输入。
> 状态:active
> 上游:`memory-design.md` §7、GitHub #20/#223/#228。
> 纪律:只写显式传入的隔离 `stateRoot`;不读取 `ts/dsh-runtime/gotry-state/`、浏览器会话、历史用户资料或真实凭证;本文只记录工具合同,不记录真实 cohort 状态。

## 1. 边界

`ts/scripts/memory-lifecycle.ts` 是独立 CLI,背后纯逻辑在 `ts/src/memory-lifecycle.ts`。它不是常驻服务,不自动遥测,不接入产品会话。所有写操作必须同时提供:

- `--state-root <dir>`:隔离状态根;真实路径或任一受管父/叶子符号链接若指向 `.git` 或 `ts/dsh-runtime` 形态会 fail-closed。
- `--consent <statement>`:操作者显式同意声明;落盘仅保存 HMAC consent ref。
- `GOTRY_MEMORY_LIFECYCLE_HMAC_KEY`:至少 32 字符的本地密钥;不落盘、不输出。数据集创建后会保存域分离 verifier,换 key 读写/导出均拒绝。

CLI 使用真实系统时间,没有 `--at`;测试态需要时间注入时调用纯函数接口。

## 2. 命令

```bash
export GOTRY_MEMORY_LIFECYCLE_HMAC_KEY='32+ chars kept outside git'

npx tsx ts/scripts/memory-lifecycle.ts init \
  --state-root /tmp/gotry-m4-collector \
  --consent 'operator reviewed issue #228 scope' \
  --source synthetic_fixture \
  --dataset m4-demo \
  --wait-code tool_latency \
  --wait-code user_pause

npx tsx ts/scripts/memory-lifecycle.ts start \
  --state-root /tmp/gotry-m4-collector --consent 'operator reviewed issue #228 scope' \
  --subject 'local subject handle' --flow first-planning --eligible-planning

npx tsx ts/scripts/memory-lifecycle.ts wait-start \
  --state-root /tmp/gotry-m4-collector --consent 'operator reviewed issue #228 scope' \
  --subject 'local subject handle' --flow first-planning --wait w1 --code tool_latency
npx tsx ts/scripts/memory-lifecycle.ts wait-end \
  --state-root /tmp/gotry-m4-collector --consent 'operator reviewed issue #228 scope' \
  --subject 'local subject handle' --flow first-planning --wait w1

npx tsx ts/scripts/memory-lifecycle.ts complete \
  --state-root /tmp/gotry-m4-collector --consent 'operator reviewed issue #228 scope' \
  --subject 'local subject handle' --flow first-planning

npx tsx ts/scripts/memory-lifecycle.ts record-reflux \
  --state-root /tmp/gotry-m4-collector --consent 'operator reviewed issue #228 scope' \
  --experience er-hai-memory --kind recalled --evidence 'local evidence handle'

npx tsx ts/scripts/memory-lifecycle.ts record-preference \
  --state-root /tmp/gotry-m4-collector --consent 'operator reviewed issue #228 scope' \
  --assertion slow-pace --evidence 'local evidence handle' --consumer ranking

npx tsx ts/scripts/memory-lifecycle.ts export \
  --state-root /tmp/gotry-m4-collector --consent 'operator reviewed issue #228 scope' \
  --out /tmp/gotry-m4-collector/export.json

npx tsx ts/scripts/memory-value-report.ts /tmp/gotry-m4-collector/export.json
```

`observed_private` 只表示输入来自私有观测;collector 导出仍是 `source_review.state=candidate`,不会生成 `manual_attested`、`reviewer_ref` 或 `attestation_ref`。M4 Exit 仍需要真实 `observed_private` N≥5 repeat cohort 及人工 source-review attestation 合同。

## 3. 生命周期不变量

- 数据集初始化后冻结 `source_kind`、等待代码集合、consent ref 与 HMAC key verifier。
- 每个 subject 最多记录首访和下一次 eligible completed flow;第三条 eligible flow 拒绝。
- 同一 subject 不能有重叠 flow;returning start 必须晚于 first complete。
- 同一 flow 的 wait 不能重叠或倒序;wait code 必须来自 init 前声明的集合;flow complete 必须晚于所有已结束 wait。
- start/complete/wait/reflux/preference 均按 HMAC event ref 幂等;重复提交返回 `unchanged` 且不改变事件计数。

## 4. 持久化与恢复

状态位于 `<stateRoot>/gotry-state/memory-lifecycle/`:

- `manifest.json`:私有 0600 JSON,通过临时文件 + no-overwrite hard-link 发布;写入失败不留下阻断重试的半 manifest。
- `events.jsonl`:append-only JSONL,持 writer lock 时先做完整候选投影校验;fd 写入使用 write-all 循环,短写/0 字节返回不能误报成功;失败会回滚到此前已提交前缀。
- `.writer.lock`:只清理本进程创建的 lock;既有竞争者 lock 返回 `lock_busy`。
- export 输出同样使用完整临时文件 + no-overwrite 发布;既有目标文件不被覆盖,失败只清理本次临时文件。

恢复只处理可证明的末尾未提交片段:已提交前缀必须保持 byte-identical;损坏的已换行事件行不会被静默吞掉。

## 5. 验证入口

`GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh` 的 §55 会运行 `ts/scripts/memory-lifecycle-tests.ts`,覆盖显式 opt-in、非法输入零写、key/consent 绑定、倒序拒绝、路径隔离、短写/ENOSPC 故障注入、子进程 collect→export→#223 scorer 链。
