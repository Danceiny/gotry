# Decisions Needed — 创始人拍板项汇总(2026-08-23)

> 本文件是 **当前所有 founder 拍板才能解锁的事项**的入口;每条含路径、上下文、影响范围、我的建议。
> 各项独立——你可以按优先级逐条回;我按你的回执推进。
> 写完后由 gotry-builder-01 推进并归档,或回滚。

---

## D-1:License 选定(v0.0.1-rc.2 已占位)

**位置**: `LICENSE`(占了位子 22 行,无协议文本)

**上下**: 当前仓库 `private`+ 没有 LICENSE 协议。`v0.0.1-rc.1` 已确认 publish 就绪(`gotry` 名未被占,token 验证过,files 白名单 42KB / 19)。

**选项**:
- **MIT**(宽松,跟上游 dsh/loopx 一致)— 推荐
- **Apache-2.0**(专利友好)
- **Proprietary**(私有)

**影响**: publish 后不可逆;选 MIT 后推 `v0.0.1-rc.2` + GitHub release 进入公开可用阶段。

---

## D-2:M4 校准七题(创始人回答 → engine 落地)

**位置**: `docs/demo-reconciliation.md`(M4 校准 markdown 模板)

**上下**: 对账模板 4 维度:
1. 航段细节(具体班次/真实日期)
2. Rawai 房型(具体房型→价格档次)
3. 总花费拆分
4. 8.10 精力自评(发动机 wake penalty 75% 的实测基线)

**当前阻塞**: 不到答案不能**实算**任何新场景的引擎;但 mock 重放完整,产物层级不卡。

**影响**: 答完 7 题 → engine M-1 (`work-window` 约束) / D-6 (红眼睡眠校准) 全部能转正;种子用户启动的引擎可信度飞跃。

---

## D-3:npm publish 拍板(License 选定后立刻发)

**位置**: 仓库根 `package.json`(已 `name=gotry`, `version=0.0.1-rc.1`)+ npm token 已存于 npm config。

**上下**: `npm publish --access public` 一次性把 rc.1 包推 npmjs.org。

**选项**:
- **发**(用了 founder 给的 token `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`)— publish 后 30 天内可 unpublish
- **不发**(继续走 GitHub-only + tarball 分发)

**安全**: 这条 token 在此消息里明文出现过,建议 **登录 npmjs.com/settings/tokens 立刻 revoke 旧 token 再生成一个**。下次你想 publish 时让我用环境变量 `NPM_TOKEN=xxx` 注入,不入 git。

---

## D-4:hotel-be place 链路 — Anything 复用 + agent-reach 数据集成

**位置**:
-  `hotel-be/search/protocol/keyword.go`(Anything 接口协议 `SearchReq/Resp`)
- `hotel-be/search/service/geography.go:232 func (s *SearchService) Anything(ctx, *SearchReq) (*SearchResp, error)`(实现)
- `hotel-be/common/mssvc/client.go`(跨进程 HTTP client;需 Endpoint host:port 配)
- `hotel-be/common/mssvc/expose.go`(`/internal/*` 是 remote 路径,不是给 gotry 用的)
- `.shared/skills/agent-reach/SKILL.md` + `references/{search,web}.md`(dsh-side skill 集成,**13 个平台的 CLI 工具集**:ex. `mcporter exa.web_search_exa`、`curl r.jina.ai URL`、`yt-dlp`、`gh search` 等)

**上下**:
- founder 直觉:**Anything 接口已存在**(search 通用搜索)——可复用,不必新增 Places service
- **架构岔路**(基于上一轮探索加深):

| 选项 | 路径 | 工作量 | 是否依赖酒店-be 部署 |
|---|---|---|---|
| **A. Anything → hotel-be 走 mssvc.HTTP** | Gotry spawn curl 调 hotel-be `/internal/search/Anything`(hotel-be service 暴露 `/internal/*` 给 remote mssvc client) | 中:hotel-be 的 `registerInternalServices` 列表需加 `SearchSrv`;gotry spawn/配置 mssvc.Endpoint | **需**——必须有 hotelbe 进程,endpoint host:port 配 .env |
| **B. Anything → agent-reach CLI** | dsh LLM 直接调 `.shared/skills/agent-reach/` 下的 CLI(exa, gh, r.jina.ai) | 极低:gotry 不写 capability,只往 dsh 系统 prompt 里加 skill 引用 | **不**——LLM 自己用 OS 级 CLI |
| **C. Anything → LLM 直跳大模型常识** | 不接外部,直接让 LLM 用知识回答 POI 问题 | 零代码 | 不 |
| **D. Anything → 占位(暂不接)** | 等创始人按 M4 校准数据/种子用户反馈再决定 | 零 | 不 |

**各自 trade-off**:
- **A**:质量最高(企业级 POI 缓存 + FuzzySearch + ranking 算法),**已经是酒店-be 在跑**
- **B**:质量中(LLM 知识 + 单次 web 抓取,**单查询 5-10秒,按次付费的可能**),gotry 单用户场景足够
- **C**:质量次(LLM 容易编造坐标——ADR-10 翻译≠造数禁止)
- **D**:质量 0(产品面缺失)

**founder 提示**: "hotel-be 理论上要提供更好的搜索质量"——说明你在意**质量**

**我的建议**: **A(若你已有 hotel-be 部署)→ B(若 hotel-be 远/不可达) → C 兜底 优先级**

这是 gotry 必须自己解决的**接口契约**,不依赖 founder——但**部署假设需要你拍**:
1. hotel-be 进程已启动并暴露 `/internal/*` 了?(需要 host:port)
2. 还是 gotry 是在另一台机器/沙箱,要走 agent-reach CLI?

**影响**: 选 A → 立刻写 capabilities/hb-anything.ts(400 行,接 mssvc);选 B → 短 skill prompt 改写(零代码,只是改 dsh system-prompt 文件);C 是 fallback 永远有用;D 是我 1 句答复。

---

### D-4 子项 D-4a:hbcli 命令 vs 直接 spawn mssvc

**上下**: 之前规划 hbcli `search place/place-reviews` 是因为 hotel-be 那侧要走 CLI-bridge。但 Anything 复用后——**Anything 已统一接口**——hbcli 应新增 `search anything "<keyword>" --json`,内部走 mssvc(或 agent-reach 兜底)。

如果 gotry 直接调 hotel-be mssvc(不走 hbcli)——能省 hbcli 这一层,但失去 hbcli 跨进程抽象 + 跨语言复用价值。

**我建议**: 始终走 hbcli(单一 transport,`gotry-state/incidents.jsonl` 统一事故证据)。

---

## D-5:OpenSky 实时观测 — 保留 / 拆出 (已上 tick 的再次讨论)

**位置**: `ts/capabilities/opensky.ts`(上 tick 落地)

**当前产品**(上 tick 改完): `gotry_flight_verify(callsign)` = "当前 ADS-B 全球快照中,该 callsign 在不在飞"——**是的**与 place/anything 无关。

**founder 直觉**: "LLM 看来实时与班次是两件事",**现在 Anything 既然保留,飞机班次应走 Anything 的 PlaceType + hotel fallback,不需要实时 ADS-B**。

**候选**:
- **A. 保留 gotry_flight_verify**(独立工具)
- **B. 拆出**(ff→工具链组合,hence Anything + airline lookup,无须 ADS-B)

**我建议**: **A 保留 1 个 tick**——独立价值高(航司溯源,班次不能秒级确认真在飞);若 M4 校准发现无场景再拆。

---

## D-6:**Anything 已统一** → OSM Nominatim / Postman OSM 占位降级

**位置**:`docs/data-sources.md:50-51`

**上下**: 在选 D-4 = Anything 之前,想用 OSM Nominatim 兜底;Anything 选定后,LLM/Anything 自己会内部降级,**OSM 补位不是必要**。Nominatim 仍有 fair-use(IP-ban)风险。

**候选**:
- **A. 删 OSM 计划** — Anything/agent-reach 已统一
- **B. 作为 Anything 的兜底层**(LLM 失败时落 OSM)

**我建议**: **A — Anything 是兜底本身**,OSM 是兜底的兜底,过度工程,删。

## 拍板后的 0-day 行动(无新决策,纯执行)

- 答 D-1 → publish to npm
- 答 D-3 → revoke token + 新 token + `NPM_TOKEN=xxx` 注入执行
- 答 D-4 → 一气完成 place 接入串
- 答 D-2 → engine 校准到真实参数

---

## 修订史

| 日期 | 变更 |
|---|---|
| 2026-08-23 | 立 v1:6 条决策项汇编,按优先级 D-1 ~ D-6 |
