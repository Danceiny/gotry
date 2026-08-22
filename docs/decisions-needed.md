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

## D-4:hotel-be place 链路 — RegisterInternalService 还是 RegisterService?

**位置**:
- `hotel-be/geography/service/google_service.go`(Google Places client 已接)
- `hotel-be/geography/service/interface.go:93`(`InternalExposedMethods` 白名单,加 string 即可)
- `hotel-be/api/routes.go:75 registerInternalServices`(中央注册点)
- `hotel-be/api/routes.go:218-222`(已经挂了 `/internal/:service/:method` 路由,只缺 places service 注册)
- `hotel-be/common/httpdispatcher/internal_dispatch.go:51 RegisterInternalService`(接受任意 method 形态)
- `hotel-be/common/httpdispatcher/service_dispatcher.go:204 analyzeService`(要求 `(ctx,*Req)(*Resp,error)` 契约)

**上下**: explorer agent 调研 + 我多次 tick 探场都明确:
1. geography 已经接了 Google Places v1 + 个人 API key(按次收费)
2. 白名单+配额封顶是必经之路(个人 key 不能滥用)
3. `api/` 与 `search/` 都没 place OpenAPI endpoint,**search 模块不能直接挂这条链路**

**架构岔路**(已调查清楚):

| 选项 | 路径 | 形态约束 | 鉴权 | 工作量 |
|---|---|---|---|---|
| **A. 走 `RegisterInternalService`**(`/internal/<svc>/<method>`) | geography 新增 PlacesService(`Service.Name()=="places"`)+ routes.go 加注册 | **任意 method 形态**(`(string,bool)`, no-ctx 等等都吃) | **无**(已 internal 组使用,nginx 禁公网) | geography.go 新增 ~150 行 + routes.go 加 1 行 |
| **B. 走 `RegisterService`**(对外 `/api/v1/places/...`) | master_places_api.go(go-zero rest route)+ JWT 鉴权层 | 必须 `(ctx,*Req)(*Resp,error)` 契约 | **需 RBAC**(公开面要鉴权) | master_places_api.go 新文件 + auth 中间件 + JWKS 配置 |

**我的建议**: **A (`RegisterInternalService`)**。理由:
- 与现有 geography `InternalExposedMethods` 同一 transport;register module 现成 dispatcher
- hbcli-go 通过 `mssvc.Client` 已在用 same route (`/internal/`)— 新增 just one service registration line
- 个人 API key 的计费/限流在内部层做更简单(产品边界单一)
- 公开 JWT/RBAC 是产品层 ticket,超出 place 接入范围

**风险**: B 路径未来要从 hotelbyte.com 公开访问 /api/v1/places/search 给一般 web 用户,可以升级;但 gotry 侧 hbcli 直连 hb-geography 的 private 路径已经够用。

**影响**: 选 A → 下个 tick 一气完成 geography PlacesService + 白名单 + routes.go 注册 + 全仓编译过 → hbcli 加 `search place / search place-reviews` 子命令 → gotry `capabilities/place.ts` 双轨接入。选 B → 工作量 × 2 ~ 3 倍。

---

## D-5:OpenSky 实时观测的产品定位 — 保留 / 改造 / 拆出?

**位置**:
- `ts/capabilities/opensky.ts`(上 tick 落地)
- dsh 工具 `gotry_flight_verify`
- `docs/data-sources.md:140`(语义: ADS-B 当前快照;OpenSky 匿名路径只支持实时,历史查需鉴权)

**上下**: 上 tick 修产品定位时发现 OpenSky 匿名路径只支持"当前 ADS-B"(/flights/airport 历史查需鉴权)。已把产品语义从"近 7 天历史校验"改为"当前观测命中"。**但** LLM 看来"实时"和"该航班一般几点飞"是两件事——前者回答"现在在天上飞吗",后者回答"今天这个航班排班飞吗"(应查 hbcli 班次+aviationstack)。

**需要你的回**: 拆?
- **A. 保留 gotry_flight_verify**: 仅"当前 ADS-B 命中",作为 LLM 引用但产品面有限
- **B. 拆出**: gotry_flight_verify 删,改由 dsh 工具链组合:`hbcli hotel-search` 提供班期表 + 飞机票存在性 + aviationstack(已批 M4)提供实时班次。LLM 不需要"飞机现在在天上"——它需要"我买的票成不成立"。

**我的建议**: B,但需要先把 hbcli 的 hotel/flight 操作们查清楚。M4-1 切到这个。

---

## D-6:M3 末最后一件数据源增量 — 是不是还要做 OSM Nominatim 兜底?

**位置**: `docs/data-sources.md:50-51`(已规划,详细能力层未落)

**上下**: hbcli place 链路无论选 D-4 的 A 或 B,Google key 失败/超配额 时必须降级到免费兜底(Nominatim/Overpass)。但 OSM Nominatim 有 fair-use 限制(每秒 1 req,需要 user-agent),NotRateLimit 违规会 IP-ban。

**我建议**: D-4 选了之后再考虑;现阶段占位,优先级低于 OpenSky/hbcli 接入。

---

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
