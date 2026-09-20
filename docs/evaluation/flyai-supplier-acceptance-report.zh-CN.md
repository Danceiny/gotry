[English](flyai-supplier-acceptance-report.md) | [简体中文](flyai-supplier-acceptance-report.zh-CN.md)

# FlyAI 供应商接入验收报告

> 定位：FlyAI 接入的产品验收证据与边界。
> 状态：frozen（2026-09-20）
> 上游：[供应商契约](../design/flyai-supplier-skill-design.zh-CN.md)、[#521](https://github.com/Danceiny/gotry/issues/521)。
> 下游：评审接入实现与回归门禁的维护者。

## 结论与环境

安装后产品的受控端到端测试通过了下表全部九个场景。它通过真实 GoTry 和 dsh 进程验证配置持久化、模型可见的工具及结果，以及库存错误边界。官方 CLI 的真实匿名调用是另一层辅助证据。本轮未验收正式 Key 权限、真实模型质量、预订或支付。

运行时代码：`e8925001084b9f1234ef09a504c04c183edaa81d`。Node `24.10.0`，安装包 `0.0.1-rc.24`，dsh `0.1.5-rc.1`，官方 FlyAI CLI 固定为 `1.0.16`。打包产物安装到独立临时 consumer，使用锁定依赖图；232 个 dsh 包均通过闭包验证。安装包 SHA-256：`a43794bf4d8cc082c6317473c69a51e9a9e96bb1111b4993bc177b8cd3f65970`。

每个场景使用独立的 HOME、DSH_HOME 和工作目录。受控 CLI 接收合成 Key 并验证来源；本地 SSE 模型服务发出真实工具调用，记录 dsh 实际返回的观测。进程级防休眠措施避免时间测量被系统休眠打断。没有修改创始人的真实状态或凭据。

## 安装后产品结果

| 场景 | 必须观察到的行为 | 结果 |
|---|---|---|
| 本机配置及重启 | 隐藏输入／stdin 候选先验证后保存；权限 0600；新进程 status 与 doctor 读到配置；模型 status/check 显示已验证；输出和历史无 Key | 通过 |
| 八类搜索 | 每类发出真实工具调用；固定版本 CLI 参数正确；结构化字段、图片、链接、单位与打码价可达模型 | 通过 |
| 中转航班 | 保留两段、最终抵达和总时长；摘要明确中转；持久化航班事实为 `nonstop:false` | 通过 |
| HTTP 401／403 | 分别只调用一次；保持 auth-error／forbidden；零库存事实 | 通过 |
| 试用 429 | 只调用一次；给出配置提示；零库存事实 | 通过 |
| 普通 429 恢复 | 调用两次；第二次成功后可写入正事实 | 通过 |
| 畸形响应／Sentinel | 分别只调用一次；保留错误；零库存事实 | 通过 |
| 合法空结果 | 只调用一次；保持 miss 并写入负库存事实 | 通过 |
| 本地超时 | 只调用一次；本地终止；零库存事实 | 通过 |

成功场景还执行一次配置检查，因此八类搜索对应九次产品侧供应商调用。加上八个异常／空结果场景，harness 共九个进程场景。夹具结果不代表实时库存。

## 官方匿名调用观测

2026-09-20 在隔离环境直接运行官方 CLI，航班、火车、酒店、景点、关键词、万豪酒店、万豪套餐各返回十条。航班含七条直达、三条中转。AI 搜索首次超过二十秒上限；随后用另一个更窄的问题，在四十五秒上限内成功返回字符串数据。首次超时保留，不计作通过。

adapter 对八类捕获形状做了离线回放，发现并修复了旧夹具对万豪字段及可空字段的错误假设；归一化结果保留官方名称、标识、图片、链接和价格文本。这些直接 CLI 调用不能证明安装后的 GoTry 全链路已通过真实服务或正式 Key 验收。

## 发现并复测的问题

- [#525](https://github.com/Danceiny/gotry/issues/525)：CLI 和畸形 JSON 诊断可能回显候选 Key；现使用脱敏通用错误，并保留旧配置。
- [#526](https://github.com/Danceiny/gotry/issues/526)：万豪酒店／套餐字段不同于旧夹具；真实形状回放与安装后观测现已通过。
- [#527](https://github.com/Danceiny/gotry/issues/527)：中转路线丢后续航段且可能标成直达；模型输出与持久化事实现已一致。
- [#528](https://github.com/Danceiny/gotry/issues/528)：首次实装运行发现模型只收到摘要；现保留结构化结果，且不重复输出供应商原始数据。
- [#529](https://github.com/Danceiny/gotry/issues/529)：后续实装运行把 401 写成负库存；现只有 hit/miss 能写入事实。
- [#517](https://github.com/Danceiny/gotry/issues/517)：本地非零退出本身不能授权重试，明确 HTTP 5xx 证据才可以；注册工具专项验证调用次数及最终错误零事实。

最初的一百毫秒超时夹具在 Node 写出事件前将进程终止。现改为挂起十五秒的夹具、两秒产品截止时间，仍严格断言只调用一次。此前失败保存在本地证据集中，没有改写为成功。

## 复现与合并门禁

[产品测试脚本](../../scripts/flyai-product-e2e.mjs) 保留逐场景模型请求、CLI 事件、标准输出、标准错误、事实文件路径和最终回执。将当前构建的安装包安装到干净 consumer 后执行：

```sh
caffeinate -s node scripts/flyai-product-e2e.mjs /absolute/consumer/node_modules/.bin/gotry /new/evidence-directory
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_BRIDGE_E2E_BIN=/absolute/consumer/node_modules/.bin/gotry GOTRY_BUDGET_E2E_BIN=/absolute/consumer/node_modules/.bin/gotry ./scripts/run-all-tests.sh
```

完整回归是独立的合并门禁：PR 必须记录最终提交本地类型检查、完整回归退出码及 `ALL SUITES GREEN`，并附 CI 与 review。本文不以专项测试替代该门禁，也不宣称已经发布 npm。
