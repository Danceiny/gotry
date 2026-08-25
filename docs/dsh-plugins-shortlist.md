# dsh 社区插件选型(awesome-dsh-plugin.com 调研,issue #9)

> 站点收录 2176 个 DeepSeek Harness 插件(schema.org ItemList 全量拉取,按 gotry
> 路线图缺口关键词粗筛 8 类,入围 8 个逐一拉 README 核实)。本文只回答一个问题:
> **哪些插件值得装进 gotry 的 dsh 宿主,补我们不愿自建的宿主层能力**。
> 集成方式一律 `dsh plugin add <name>`(宿主层安装,不进 gotry 依赖,不动 vendored runtime)。

## 立即值得试(直接补已知缺口)

| 插件 | 核实能力 | 补哪个缺口 |
|---|---|---|
| [HorusJiang/dsh-map-tools](https://github.com/HorusJiang/dsh-map-tools) | 驾车/公交/步行/骑行路线规划、地理编码、逆地理编码、POI 搜索——**原生工具**,模型直接调,无需 MCP | **D-4 地图位**(词表内做不到的地图能力)+ probePoi 的 POI 增强 |
| [STARDUSTLC666/dsh-calendar](https://github.com/STARDUSTLC666/dsh-calendar) | CalDAV 读写日历,重复日程自动展开,5 个面向模型的工具 | **工作窗口自动读取**(现在首轮必问→读日历即得,issue #1 减负)+ 行程落日历 |

## 产品闭环基建(「下一次出发」的触达宿主,M3→M5)

| 插件 | 核实能力 | 用途 |
|---|---|---|
| [yangyongzhen/dsh-scheduler](https://github.com/yangyongzhen/dsh-scheduler) | cron/一次性触发,shell/webhook,可推 ServerChan/钉钉/飞书 | 愿望池条目的**主动回访触发**(窗口/季节条件满足时叫用户) |
| [amlyczz/dsh-lark-link](https://github.com/amlyczz/dsh-lark-link) | 飞书/Lark 双向桥接,扫码 30 秒上线 | 把 gotry 装进飞书=种子用户的常驻触达面 |
| [huguangyu666/dsh-plugin-notify](https://github.com/huguangyu666/dsh-plugin-notify) | 桌面通知/中文语音播报,Windows 零依赖 | 异步深度规划完成通知 |

## 观察名单(暂不装)

- [3403473060/dsh-inline-images](https://github.com/3403473060/dsh-inline-images) — 对话内联渲染本地图片;等 gotry 有景点图产出再装
- [Js2Hou/dsh-mcp-manager](https://github.com/Js2Hou/dsh-mcp-manager) — MCP 可视化管理;若走 MCP 路线(#5 讨论时)再评估
- [coolbreezecoin/dsh-wechat-mp](https://github.com/coolbreezecoin/dsh-wechat-mp) — markdown→公众号草稿;内容运营期用

## 明确不外包:记忆(M4 自建)

2176 个插件里 name 含 memory/remember/rag/vector 的 75 个**全是 UI 层历史记录**
(chat-history/composer-history/输入历史),没有一个是真正的 agent 长期记忆。
M4 记忆(动机画像/偏好/跨会话状态)继续自建——这本来就是 gotry 的产品核心,
不是宿主能力。

## 落地顺序建议

1. dsh-map-tools(下一 tick 可试装 + e2e 验证路线/POI 工具真调用)
2. dsh-calendar(M4 记忆启动时一起:日历=工作窗口的事实源)
3. scheduler + lark-link(M5「下一次出发」闭环设计时)
