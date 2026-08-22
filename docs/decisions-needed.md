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

## D-4:hotel-be Anything 通用搜索接入 ✅ **2026-08-23 已落地**(点**

**位置**:
- `hotel-be/search/protocol/keyword.go`(Anything 接口协议 `SearchReq/Resp`)
- `hotel-be/search/service/geography.go:232` `func (s *SearchService) Anything(ctx, *SearchReq) (*protocol.SearchResp, error)`(实现)
- `hotel-be/search/service/geography.go:224-232`(@path: /api/search/anything + @auth: false + @method: POST)
- `hotel-be/external/hotelbyte-cli/src/commands/search.ts:102-117`(`search anything [keywords...] --content-type --parent-destination-id --filter-empty-cities --min-hotel-count`)
- `gotry/ts/capabilities/anything.ts`(能力层封装, 4 断言 5/5 OK)
- `gotry/ts/scripts/anything-tests.ts`(单测)
- `gotry/ts/src/index.ts`(挂插件工具 `gotry_anything_search`,七→八工具)
- `gotry/scripts/run-all-tests.sh`(§10 接入,11 套 exit=0 ALL SUITES GREEN)

**选定的路径**: **A** —— **hotel-be Anything 已存在 + 复用 + hbcli 当统一 transport**。理由(不再有岔路):

1. founder 直觉「Anything 已存在,为什么不复用」——**直接对**,Anything 不需新建 service。
2. founder 直觉「hotel-be 理论上要提供更好的搜索质量」——**也对**,Anything 是企业级 FuzzySearch + ranking 算法 + POI 缓存,LLM 知识远不及。
3. founder 提点「hotelbyte-cli 和 hotel-be 都是你的 workspace 范围」——**清楚**,我自己动了 hotel-be 主仓(加 `@path` 注解,使 Anything 从 internal 路径暴露到 `/api/search/anything` 公开面)。

**架构链路**(实测通):

```
dsh LLM
  └─(gotry_anything_search 工具)→ gotry capabilities/anything.ts
    └─(spawn hbcli search anything --json)─→ hotelbyte-cli
      └─(POST /api/search/anything)─→ hotel-be api/dispatcher
        └─(go-zero analyzer + @path注解)─→ search/service.Anything
          └─(混合 城市+酒店 search)─→ candidates[]
```

**实测**(5/5 断言 OK):
1. 真实候选 → verdict=hit(hotel/city/place 三种 type 都识别)
2. 候选空 → verdict=miss
3. exit≠0 → verdict=error (graceful degrade 不抛)
4. timeout → verdict=error(SIGTERM 后 +500ms SIGKILL 强杀;node spawn signal 偶发 60s,改 fake infinite loop 验证)
5. empty keyword → verdict=error

**commits**:
- `hotel-be`: search/service/geography.go 加 `@path/@method` 注解
- `hotelbyte-cli`: search.ts 加 anything 子命令
- `gotry`: `ts/capabilities/anything.ts` + `ts/scripts/anything-tests.ts` + `ts/src/index.ts` 挂工具 + `scripts/run-all-tests.sh` §10

**与 agent-reach 关系**: D-4 选了 A,agent-reach 作为 D-4a「fallback/补充」(LLM 在某些查询需要直接调 exa/gh 等 CLI 时仍可用),不冲突。

**遗留**(不挡 go-live):
- hotel-be `registerInternalServices` 列表也可加 `SearchSrv` 让 Anything 同时走 internal 路径(给 mssvc.Client 节点间调用)——M4 scale-up 后再说
- Anything 没有 `lat/lng` fallback 当 hotel 没坐标时:`region.latitude` 已挖出来,前端展示够用

---

## D-4a(派生):Anything 兜底链——agent-reach 是否启用?

**位置**: `.shared/skills/agent-reach/SKILL.md`

**当前**:`gotry_anything_search` 直接走 hbcli,hbcli 不可达时降级到 「unavailable」 verdict。**LLM 此时无 POI 答案**——必须靠大模型常识或 prompt 让用户重来。

**选项**:
- **A. 不动**——gotry 8 工具够覆盖常用路径;agent-reach 留给 dsh LLM 直接 OS 调用(由 founder 用 prompt 控制)。
- **B. gotry 9 工具: `gotry_web_search`(走 agent-reach)**——能力层封装 agent-reach 的几个 CLI(exa/web-reader/yt-dlp),零开发量(Panniantong 维护),LLM 在 hotel-be 不可达时降级路径。
- **C. prompt 加 skill 引用**——零代码,只改 dsh system-prompt 让 LLM 知道 agent-reach skill 可用。

**我的倾向**: **C**——零成本,但 LLM 直调 OS 命令需要谨慎(钓鱼/越权风险)。**选项 B 在 gotry 8→9 工具时引入**——单加一个 `gotry_web_search` 调 `r.jina.ai` 一个 url 就够覆盖大多数「读这个网页」场景。

不是阻塞项。留给下一个迭代。

---

## D-5:OpenSky 实时观测 — 保留 / 拆出 (已上 tick 的再次讨论)

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
