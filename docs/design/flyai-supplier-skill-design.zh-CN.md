[English](flyai-supplier-skill-design.md) | [简体中文](flyai-supplier-skill-design.zh-CN.md)

# FlyAI 供应商技能集成

> 定位：FlyAI 接入的公开能力、凭据和证据契约。
> 状态：active
> 上游：[架构](../architecture.zh-CN.md)、[#521](https://github.com/Danceiny/gotry/issues/521)。
> 下游：适配器、模型工具、本机设置命令和验收测试。

## 能力边界

适配器使用 MIT 许可的公开包 `@fly-ai/flyai-cli@1.0.16`。这是对公开接口的技术集成，不表示已获合作背书。八个命令全部只读，预订与支付仍由人在上游链接完成。

| 工具类型 | 公开 CLI 命令 | 查询参数 |
|---|---|---|
| flight | search-flight | 出发地，可选目的地、日期或范围，返程、舱位、路线、时段、价格、排序 |
| train | search-train | 出发地，可选目的地、日期或范围，坐席、车次、时段、价格、排序 |
| hotel | search-hotel | 目的地、日期、关键词、景点、星级、床型、类型、价格、排序 |
| poi | search-poi | 城市、等级、关键词、公开类别 |
| keyword | keyword-search | 查询词 |
| ai | ai-search | 自然语言查询；保留数据，不猜测库存事实 |
| marriott-hotel | search-marriott-hotel | 目的地、日期、品牌、酒店名、床型、价格、排序 |
| marriott-package | search-marriott-package | 关键词、价格排序 |

对于 `marriott-hotel`，`destName` 映射为 `--dest-name`；`hotelBrands` 和 `hotelName` 与 `keyWords` 合并后映射为 CLI 唯一的 `--key-words` 值，床型、日期、最高价和排序筛选使用各自的官方参数。该 kind 拒绝通用的 `hotelTypes` 和 `hotelStars` 筛选。对于 `marriott-package`，`keyword` 映射为唯一的 `--keyword` 维度，`sortType` 仅接受 `price_asc` 或 `price_desc`。

平铺的 `gotry_flyai_search` 保留 `from/to/date/checkIn/checkOut` 别名。打码价原样展示，绝不转换成数值报价。只有包含出发地、目的地和单个出发日期的精确机票／火车查询，或包含目的地及成对入住日期的酒店查询，才可在合法命中或空结果时写入库存事实。探索结果和全部错误均不写入。

## 凭据归属

本机 `gotry setup flyai` 支持隐藏输入和 `--stdin`，先验证候选密钥再保存，并提供 `--status`、`--clear`。密钥不进入命令参数或模型参数。验证或存储失败保留旧配置。沿用官方路径 `~/.flyai/config.json`，目录和文件权限为 `0700/0600`。

解析顺序是非空的 `FLYAI_API_KEY`、`DEBUG_FLYAI_API_KEY`、配置文件、匿名共享试用。调试 endpoint 明确标注，隐藏用户信息和查询参数。验证回执绑定密钥哈希、来源与完整 endpoint 指纹；任何一项变化都会使回执失效。非空密钥只能证明已配置，调试验证仅证明该 endpoint。

模型工具 `gotry_flyai_setup` 只接受 `status/check`。检查执行只读查询，可更新验证回执，绝不修改凭据。匿名检查不承诺正式密钥有效或额度无限。

## 错误与取消契约

鉴权失败、禁止访问、试用达限、Sentinel、畸形响应和本地进程终止均不重试。普通限流和明确分类的上游网络或 HTTP 5xx 故障最多重试一次。非零退出码本身不能决定重试策略。只有合法空结果才表示未命中，错误不能变成负库存事实。

宿主取消沿用主线效应解译器的所有权和退避契约。取消查询会终止所属 CLI 进程组，并释放自己的熔断探测权，不清除既有失败计数。

## 取舍与验收

拒绝模型保存密钥，因为参数和历史会持久化。拒绝把打码价转成数字、把畸形响应当空结果，因为都会伪造库存证据。拒绝隐藏切换供应商，因为会破坏来源归属。

验收包括隔离环境设置、新进程状态与体检、安装产品内八类模型工具调用、失败恢复、敏感信息扫描和全量回归。受控模型与供应商响应验证产品接线，不证明真实供应商可用或正式密钥授权；测试报告必须分别列出这些边界。
