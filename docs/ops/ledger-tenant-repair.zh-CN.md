[English](ledger-tenant-repair.md) | [简体中文](ledger-tenant-repair.zh-CN.md)

# 账本 Tenant 修复（Owner Gate）

> 定位：issue #254 人工修复被误记为 `local` 的历史事件的操作清单。
> 状态：living
> 上游：[`../architecture.md`](../architecture.zh-CN.md) §8.16 / §10.1 #254 边界，[`../design/milestone-delivery-plan.md`](../design/milestone-delivery-plan.zh-CN.md) Q-2
> 下游：`ts/src/ledger-repair-plan.ts`、`ts/src/ledger-repair-apply.ts`、`ts/scripts/state-cli.ts`
> 最近更新：2026-09-11
> 边界：fixture 绿的工程证明不是真实 repair 回执；测试不得打开 `ts/dsh-runtime/gotry-state/`。

## Schema

| Schema | 作用 |
|---|---|
| `gotry.ledger-repair-plan/1` | Dry-run 计划（`repair-plan`） |
| `gotry.ledger-repair-backup/1` | `<stateRoot>/.gotry-repair-backup/` 下带校验和的 backup manifest |
| `gotry.ledger-repair-apply/1` | Apply 结果对象 |
| `gotry.ledger-repair-applied/1` | `gotry-state/.gotry-repair-applied/` 下的幂等 applied stamp |
| `gotry.ledger-repair-receipt/1` | 脱敏回执（`--receipt-out`）；真实回执须私有存档 |

回执字段含 `planDigest`、`mappingSha256`、脱敏路径指纹、before/after census、受影响 seq、`authorizedBy`、可选 `gitHead`，以及 `mode`（`applied` \| `already_applied`）。

## Owner checklist（真实数据）

1. **盘点**：`npx tsx scripts/state-cli.ts repair-plan <root> --format json`（只读；不通过 SQLite 打开正本——先复制 db/`-wal`/`-shm`）。
2. **证据映射**：人工编写 JSON 数组 `{ seq, fromTenant, toTenant, evidence }`。空 evidence 一律拒绝。无映射条目的事件原地保留——不做归属推测。
3. **审 dry-run**：加 `--mapping <file>` 重跑；确认 `applyable=true`，逐条检查 `move`，记录 `plan-digest`。
4. **书面授权**：founder（或授权 owner）明确批准对该 root + digest 执行 apply。Agent 不得自行发明授权。
5. **只在已授权 root 上 apply**：  
   `repair-apply <root> --mapping <file> --plan-digest <hex> --i-authorize-apply [--receipt-out <私有路径>]`  
   优先在已校验副本上执行；founder 真账本仅在明确放行后。
6. **校验可见性**：目标 tenant 的 `log`/`stats`/fold 能看到被搬主体；`local` 与其他 tenant 不串读。
7. **归档回执**：SHA 绑定回执保存在**公开仓库之外**（或私有路径）。脱敏字段不得重新写入绝对路径。
8. **Backup 留存**：验证完成前保留 `<stateRoot>/.gotry-repair-backup/<stamp>-<digest>/`；需要时用  
   `repair-rollback <root> --backup <dir> --i-authorize-rollback` 还原；仅在 owner 确认后丢弃。

## 关闭 #254

仅工程合入**不等于**关闭 issue。满足其一即可关闭：

- **A**：founder 授权完成真实（或确认副本）repair，并产出私有、SHA 绑定回执；或  
- **B**：founder 书面确认无需真实搬移，并附上相关 root 上 `repair-plan` 零 move / 仅 retain 的证据。

## 硬性非目标

- 启发式 tenant 推断；自动扫 founder 账本；M5 receipt/outbox；把 tenant scope 当认证。
