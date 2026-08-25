# hotelbyte-skills 架构设计(issue #5)

> 一句话:hotelbyte CLI 的能力知识从 gotry 代码里搬进一个**专用 skills 仓**,
> 成为所有 agent(dsh 用户/cis-cli 式内部工具/未来的 hotel-fe 侧)复用的单一
> 事实源;gotry 只留薄执行面。

## 动机(#5 指出的三个问题)

1. **知识散落**:gotry 的 `capabilities/hbcli.ts`/`anything.ts` 里硬编码了
   hbcli 子命令形态(`search anything`/酒店搜索)与降级策略——hotelbyte CLI 的
   能力知识活在 gotry 的 TypeScript 里。
2. **不可复用**:其他 dsh 用户/agent 想用酒店域搜索,只能重读 gotry 源码。
3. **升级耦合**:hbcli 加子命令/改参数,gotry 要发版。

## 目标形态

`Danceiny/hotelbyte-skills`(private,MIT 同 gotry):

```
hotelbyte-skills/
├── SKILL.md            # 能力声明:name/description/when_to_use(酒店域/
│                       # 目的地目录/Anything 旅行域检索)+ 与 agent-reach 的
│                       # 域边界(见 gotry 人格契约 16/17 的镜像)
├── contracts/          # 工具契约:hbcli 子命令 ↔ 输入/输出 JSON Schema ↔
│   ├── anything.md     #   降级语义(未装/超时/私有仓 401 → 三值)
│   └── hotels.md
├── examples/           # 每契约 2-3 个真实调用样例(带证据链标注格式)
└── CHANGELOG.md        # 版本化;hbcli 破坏性变更在此声明
```

## 与 gotry 的关系(两步迁移)

- **第一步(立档,零风险)**:仓建立 + SKILL.md/contracts 从 gotry 现有
  `hbcli.ts`/`anything.ts` 与 hotel-be `/api/search/anything` 注解反向提取。
- **第二步(对齐校验)**:gotry 的工具描述与契约文档对齐——加一个轻量测试:
  gotry 工具 description 里的参数形态必须能在 contracts/ 找到对应条目
  (防漂移;类似 agent-reach wrapper 的「知识单一事实源」哲学)。
- **不迁执行面**:`capabilities/*.ts` 的 hbcli spawn/降级/证据链逻辑留在 gotry
  (进程内性能 + L4 契约测试覆盖);skills 仓承载**知识**,不承载运行时。

## 域边界(与 #4/#6 联动)

| 域 | 归属 |
|---|---|
| 酒店库存/目的地目录/Anything 旅行域检索 | hotelbyte-skills → hbcli → hotel-be |
| 通用外部事实/内容平台/行情 | agent-reach(上游注册表) |
| 公司系统(差旅订单/假期) | cis-cli 等宿主 skill(人格契约 16) |

## 开放问题(founder 可一句话拍)

1. 分发形态:git clone 到 `~/.claude/skills/hotelbyte-skills`(最简)vs npm 包
   (gotry 依赖联动)——建议前者先行;
2. 仓可见性:private(现状建议)vs public(若 hotel-be OpenAPI 公开则可公开)。
