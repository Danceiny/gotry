# GoTry 发版记录

> 每个 tag 一条:内容、证据、闸勾稽。发布闸(AGENTS.md):① 全栈回归绿 ② §11 六状态面同步 ③ README 用法逐条实测 ④ License 明确 ⑤ 版本号在 tag 与全部文档间一致。
> 对外推送(remote)与 License 未定前,所有 tag 仅为本地候选。

## v0.0.1-rc2(候选,tag 待⑤闭合后打)

在 rc 之上的发布面修复:

- **fix `29318f4`**:`./gotry` 裸跑在 `set -u` 下崩溃(`$1` unbound)、`./gotry web` 把 "web" 当 prompt 传给 headless——README 三条用法两条是坏的;薄壳 server 从绑全接口 + CORS `*` 改为只绑 127.0.0.1、去 CORS 头(/state 暴露画像与历史、/chat 消费用户 key,不应对局域网/任意网页可见);README 补齐 dsh 运行时安装步(原缺,方式二/三对新用户不可用)。
- **docs `f2a01cc`**:AGENTS.md 发布纪律——对外发布单 owner + 五项发布闸。
- 验证:三分支实测(裸 `./gotry` 起薄壳并确认 127.0.0.1 绑定与 `/state` 应答;`./gotry web` dsh Web 起来;`./gotry "…"` headless 真实 LLM 应答);全栈回归绿。

## v0.0.1-rc(annotated tag @ `68f4fe1`,2026-08-22)

首个候选:种子用户前的工程面全通。

- 产品面:薄壳七段(品牌三页/意图路由三场景/休假语义/会话持久化/云南包/Markdown 渲染/UX),一键入口 `./gotry` 三模式;
- 能力面(M2 交付):OpenFlights 骨架(168 枢纽对,ODbL 署名在数据文件内,三值语义:检出=强肯定/枢纽对缺失=降级信号≠证伪/枢纽集外=无结论)+ OpenSky 校验桥 + hbcli 酒店桥(实时/静态降级,证据标注)+ bookedResources 锚点;
- 智能面:DeepSeek 原生 dsh 运行时(人格 + 五工具,全只读,WriteGate 留白未触);
- 验收:三场景(洱海候选/云南带爸妈/普吉 workation)E2E + 全栈回归绿;
- 已知留账:D-7(deprecated 层承重 + 洱海路由 hack)未清偿;种子用户启动等 remote 与 License 决策。
