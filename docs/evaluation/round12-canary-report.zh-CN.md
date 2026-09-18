[English](round12-canary-report.md) | [简体中文](round12-canary-report.zh-CN.md)

# Round 12 冻结 canary——首个可计数官方分数跑测报告（#203/#215 收官段）

> 定位：Round 12 冻结治疗（重建 harness，#203/#215 收官段）的完整跑测报告。与逐轮工程台账（`benchmark-environment-bridge.md` Round 12）及 Discussion #78 Round 12 评论互为引用。状态：冻结证据，不声称 uplift。

## 身份

| 字段 | 值 |
|---|---|
| GoTry SHA | `f6e76b88fd50504a1f27056a211014f6d8125b81` |
| Case | `phase2_extended_20250322201643676309_00001`（当前 HF 数据修订；2 天，深圳→上海，1 人） |
| 模型 | `MiniMax-M3`（owner relay 凭证；未入任何记录） |
| 桥 | `gotry_benchmark_environment_bridge_v4`——21 个冻结工具 descriptor、闭合 `body_schema` 由官方 `output_schema.json` 投影（config SHA-256 `762f4e5e4989ff0e…`） |
| 适配器 | `adapter-v1` 精确 `gotry_benchmark_tool_result_v1` 信封（SHA-256 `e6485036ac4ef0bf…`） |
| 预算 | soft 360 s / hard 600 s；桥超时 30 s；输出上限 64 KiB |
| 结果 | planner exit `0`；**terminal 4840 bytes**（SHA-256 `c9d039675208b934…`）；官方 schema 无条件必需键违例 **0** |

## 官方分数（pinned evaluator，b071db25 评估树）

```
{MicEPR: 33.33, MacEPR: 0.0, C-LPR: 0.0, FPR: 0.0, DAV: 0.0, ATT: 0.0, DDR: 0.0, overall: 3.33}
```

十二轮以来首次非 null 官方分数。单 case、无 matched-pair 基线——**不声称 uplift**。

## 逐约束发现（可行动的总结）

MicEPR 33.33 = 三组常识约束中一组通过。逐组发现：

1. **逐字誊写纪律（价格/房间）**：计划写入了与工具查询结果矛盾的住宿价格（`1092`）与房间数（`2`），以及数据库中不存在的餐厅价格（`434`）——模型查对了数据，但转写时靠推断而非逐字拷贝。
2. **市内交通段语义**：`goto` 工具返回多段 metro 行程（metro=三段）。模型把段落坍缩成单段 `walk`，其时长/距离与工具矛盾（如 `12:50` vs `12:59`、1 km vs 2.44 km）。正确行为：逐字拷贝工具的段列表。
3. **时间链纪律**：硬逻辑失败全部是链式时间违例——活动在到达交通落地前开始、交通在上一活动结束前出发、跨位置的住宿活动 `transports` 为空。
4. **通过面**：schema 结构（v4 闭合 `body_schema` 闸 0 违例）、第一组常识约束（景点/类别结构）、城际航班选择（工具真实输出 `CZ3588`/`CZ3589`）。

## 下一轮优化靶面

以上均为模型行为失败模式，可在产品合同层（persona/工具指引）解决，非桥缺陷：(a) 逐字誊写规则扩展到价格/房间数（现只覆盖名称）；(b) 交通段逐字拷贝 `goto` 输出；(c) 链式时间规则（上一结束 ≤ 下一开始）。基线配对与扩样属另行准入。
