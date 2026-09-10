[English](e2e-prompts.md) | [简体中文](e2e-prompts.zh-CN.md)

# dsh e2e end-to-end verification (continuously updated; body §1-§11, 2026-08-26)

> Status: living (verification ledger, continuously updated)

Verification records of real-LLM sessions for the 12 tool personas + host plugins (map_*/calendar_*): §1-§6 the six base questions, §7-§8 the wrapper reflection surface, §9 the full-chain regression after five changes, §10 data-source routing + setup assistance, §11 pre-adjudication climate context. Each section captures one stdout archive; ad-hoc smoke runs from inspections are not itemized here (key findings go to release-notes/architecture).

## Usage

\`\`\`sh
# start dsh
./bin/gotry.js web --no-open &
sleep 22
curl -sS --max-time 3 http://127.0.0.1:3080 -o /dev/null -w "dsh=%{http_code}\\n"

# run a prompt
./bin/gotry.js "<你的 prompt>" > /tmp/e2e-NN.md 2>&1
\`\`\`

## Results (2026-08-24 live run)

### 1. Flight verification ("查一下深圳飞曼谷的航班,8月5日左右")
- Behavior: workflow discipline (motivation first) — asks about work window / existing bookings / budget; does not fabricate flight numbers
- The LLM cited [骨架:openflights], which triggered the schema, but gave no specific flights (no fabrication allowed before the data is complete)
- ✓ workflow discipline correct

### 2. Weather ("曼谷下周天气怎么样")
- Behavior: really called Open-Meteo — 8/30 26-30°C showers 78%; 8/31-9/6 falls back to the historical baseline
- Cited [实时API:open-meteo@2026-08-24] + [实时API:open-meteo-climate@2026-08-24]
- ✓ the landing side really uses the capability layer; no fabrication

### 3. Anything ("去上海有什么值得去")
- Behavior: workflow discipline (motivation first) — asks origin city / dates / work window / existing bookings
- The LLM walks through A/B/C options
- ✓ Anything not directly triggered (data incomplete)

### 4. Cross-domain — flights + landing advice ("上海明天天气,上海飞深圳最快")
- Behavior: **OpenFlights skeleton really triggered** — Hongqiao vs Pudong comparison, airline list, flight times; advice "门到门最快是虹桥"
- Cited [骨架:openflights]
- ✓ multi-tool coordination: weather (tomorrow) + flights (Hongqiao faster) + post-landing advice
- Honesty boundary: no fabricated schedules; pointed to "上航司 App"

### 5. agent-reach doctor ("跑一下 agent-reach doctor,看看 13 平台里哪些能用")
- Behavior: really spawned `agent-reach doctor` — output **4/15 channels ready** (V2EX, RSS, Jina, Bilibili search zero-config; gh/yt-dlp need install; 8 channels need cookies)
- Cited [agent-reach:@2026-08-24]
- ✓ agent-reach 100% follow landed

### 6. Cross-domain — Yunnan + flights + wish pool ("查下云南现在能玩什么,以及从昆明飞曼谷的航班")
- Behavior: workflow discipline (work window asked first) + three-direction A/B/C trade-off (summer-escape line / Bangkok line / Yunnan-reschedule wish pool)
- ✓ wish pool concept triggered: "如果这次窗口短,不如直接曼谷,云南留给下次(可以记进愿望池,条件合适提醒你)"

## wrapper surface re-verification (2026-08-22, after rc.6; wrapperization changed the gotry_agent_reach parameter surface; real-LLM sessions verified the reflection surface can be self-driven)

### 7. Reflexive v2ex call ("跑一下 agent-reach doctor 看渠道体检,然后用 agent_reach 工具的 v2ex 渠道拿今日热门话题前 5 条")
- Behavior: the doctor channel health table rendered faithfully (Bilibili/gh/yt-dlp/mcporter statuses as-is); **the LLM autonomously picked the real upstream name `v2ex.get_hot_topics` (no args)**, fetched 10 real items and returned the top 5 (correct date awareness for the day), and proactively knew `v2ex.search` was available (self-describing catalog in effect)
- Cited `[agent-reach:v2ex.get_hot_topics@2026-08-24T14:34:28Z]` (real invocation timestamp)
- ✓ the wrapper "decisions belong to the LLM" design holds

### 8. needs-setup verbatim passthrough ("用 agent_reach 查雪球 SH600519 实时股价;需要配置就原样告诉我上游的方法,不要自己编")
- Behavior: **quoted the upstream check() output verbatim in full** (`agent-reach configure --from-browser chrome --platform xueqiu`); no fabricated price, no paraphrase; proactively offered a recheck after configuration
- Cited `[agent-reach:xueqiu.get_stock_quote@needs-setup@2026-08-24T14:35:23Z]`
- ✓ "setup text = verbatim upstream passthrough" holds; the LLM degraded honestly

### 9. Full-chain regression (after the five-change guard/kind/result-card/wrapper streak, "8月10-11日两天窗口,深圳出发,湖边发呆,预算3000,千岛湖 vs 大理洱海")
- Behavior: in one round all 6 evidence-chain types fired together — adjudication [引擎:solveChoiceSegment@ts], two [实时API:open-meteo@ts] calls (Dali rainy season / Hangzhou humid heat), Erhai (洱海) guesthouse [静态包:估算], the skeleton honestly not overclaiming [骨架:openflights]; the infeasible candidate got a minimal modification (window 2→5 days + dry season + ¥4632) and was auto-saved to the wish pool (with surfacing conditions); **time awareness correct: 8/10-11 is already past relative to today, so it proactively intercepted and demanded date adjudication** (pending decision = 3-option multiple choice); closed by additionally asking about work window / existing bookings (motivation first)
- Conclusion: the changes across the five ticks — guardToolExecute wrapping / kind / result card / wrapper — caused zero regression on the LLM path
- Note: the demo data package's August dates are now in the past; the LLM handled this honestly; later prompts should anchor on future dates

### 10. Data-source routing + setup assistance (#4 behavior surface, "帮我看看小红书上关于千岛湖的笔记")
- Behavior: both paths tested — the web.read search page hit anti-scraping ([agent-reach:web.read@ts]), and the upstream channel health check returned xiaohongshu.check@off ([agent-reach:xiaohongshu.check@off@ts], reflexively calling the check method); **still delivered 6 real note titles + links** (obtained via the web side), honestly stating it would not fabricate note bodies; per contract (15) gave a three-way setup choice (desktop opencli / Cookie / leave it for now, each with trade-offs and exact upstream commands) and proactively offered to pull full texts once configured
- Conclusion: #4① (route agent-reach first, zero loss — degrade without giving up when a channel is unavailable) and ② (setup assistance) hold on the behavior surface

### 11. Pre-adjudication climate context (T4, all elements: "2027-01-16~22 深圳出发 ¥8000 对比三亚/清迈")
- Behavior: before adjudication it first produced the 「① 1月气候背景」 table, with Sanya/Chiang Mai each carrying [实时API:open-meteo@2026-08-25] evidence; climate differences entered the multiple-choice trade-off (Sanya overcast probability vs Chiang Mai dry and clear); engine adjudication table (wake-up / arrival energy / effective rest / total cost) + data disclosure (estimates / promo floor prices itemized; skeleton three-value semantics correct — SYX not covered ○ / CNX hub no direct flight ❌) + cross-session profile in effect (remembered the Dubai departure) + 2027 Spring Festival date conversion correct
- First-round motivation-first, split-round verification: when elements were missing it correctly issued structured inquiries (origin city with a "沿用迪拜" option / work window / existing bookings / 3-way specific-date choice)
- Conclusion: T4 (pre-adjudication background research) holds on the behavior surface; contracts (1) and (17) both online

### 12. M4 full-shape re-verification (2026-08-28, after motivation_brief/0..1/attribution ban/13 tools, "我想从上海出发,周末两天去千岛湖或太湖发呆休整,预算3000,不想早起赶车,哪个更合适?")
- Behavior: in one round, adjudication table (Qiandao Lake ❌ infeasible — sparse departures all collide with 「不想早起」 / Taihu ✅ recommended — 13:30 wake-up, door-to-door 2h50m, arrival energy 84%) + itemized evidence chains ([实时API:携程班次表] / [实时API:open-meteo 雷暴 75%] / [实时API:open-meteo-climate 气候基线] / [静态包:估算] honestly mixed-labeled); **the infeasible candidate entered the wish pool with its condition locked to the weather window** (「4-5 月/9-10 月晴天多」, 「天气对了再叫你」 — the conversational face of the 0..1 reach discipline); closed with three multiple-choice questions (weekend confirmation / existing bookings / work window)
- Conclusion: the 13-tool shape has no regression on the real model; the three M4 contracts — wish reach discipline, mixed evidence-chain labeling, motivation first — are all online; with hbcli absent, the Anything degradation path does not affect the main adjudication
- Note: this section is also the product-surface evidence for the main-line shape corresponding to the rc.8 artifacts (49 files)

### 13. Memory read-back real-chain verification (2026-08-28, "不看任何工具,只凭系统提示里「用户记忆」部分回答:我的动机画像里有哪些权重和硬约束?")
- Mechanism check: dsh variable substitution lives in `@deepseek-ai/dsh-system-prompt` (the string is absent from the lib bundle; found only in the pnpm store) — `variable(name, provider)` registers into the scope layer and assemble does strict `{{name}}` interpolation; the empty string is legal (first-visit state does not blow up), unregistered/undefined throws directly (failures are explicit, never silently swallowed)
- Evidence: headless (deepseek-chat) reported the profile verbatim — the 4 motivation weights each with 「证据 7 条」, wake_not_before=09:00, min_arrival_energy_pct=40%, and it proactively added the 「愿望池按条件召回(0..1)」 guidance = contract (6) online in the same session; content matched gotry-state/motivation-profile.json item by item
- Conclusion: write (mergeProfile) → read (motivation_brief) → interpolation (dsh-system-prompt) → model — all four hops pass; the profile content is the founder's real usage data (not a smoke stub), and the returning-visit experience works in a real session

### 14. Contract-compliance probe: self-driven 0..1 recall (2026-08-28, after contract (6) added 「新意图先查池」, "我11月有5天假,预算8000,从深圳出发,想出去走走")
- Before/after comparison: before the contract line, for a query that fully matched a real wish condition the model straight-up recommended fresh Chiang Mai/Lijiang options, with zero wish-pool queries; after adding one line — 「用户新出行意图可能命中已存憧憬时,先调 gotry_wish_pool_list 查询再答」 —
- Behavior: the model autonomously called wish_pool_list, found the pool's 「千岛湖发呆周末」 (2 days/1200) mismatched the 5-day November window, and **proactively verbalized instead of pushing it** (「跟这次窗口不太对味,先放着不打扰它」) — the 0..1 discipline is enforced semantically, not mechanically; opened by citing the memory brief (returning-visit experience), closed with three structured motivation-first multiple-choice questions; with no ask-user provider in headless mode it degraded to text multiple-choice per contract (5)
- Conclusion: all three segments of contract (6) semantics (pool entry / check pool first / 0..1 + attribution ban) are online on the real model; the wishlist route of "semantic execution > mechanical execution" is empirically confirmed

### 15. Multi-lane coexistence evidence (2026-08-28, 17-tool shape: memory-domain lane × session data-plane lane)
- Scenario: live re-verification after changes to the memory-domain lane (motivation brief / wish pool 0..1) and the session data-plane lane (flyai/session search, 17 tools) landed together in the same runtime persona ("我11月有5天假,预算8000,从深圳出发。有什么建议?")
- Behavior: opened by aligning with the memory brief (weights/hard constraints correct item by item) → **queried the wish pool autonomously**, and after finding the Qiandao Lake idle weekend mismatched the November window, proactively explained 「先不硬推它」 (contract (6) semantic execution) → weather evidence [实时API:open-meteo] + route evidence [实时API:flyai@ts] + [骨架:openflights], a three-source evidence chain coexisting; no crosstalk between session-plane tool tags and memory contracts
- Conclusion: ADR-13's flat envelope + single-persona composite source stays stable under parallel multi-lane evolution; both lanes' contracts (memory 0..1 / session ReadGuard read-only) were online simultaneously in a real-model session

## Summary

- **8 tool personas truly cooperating**: feasibility + skeleton + hotel + weather + flight + anything + web_search + agent_reach + motivation_save + wish_pool
- **The dsh LLM really uses the capability layer to fetch real data** (Open-Meteo, the OpenFlights skeleton, Anything routing — not mocks)
- **Workflow discipline landed**: motivation first / no fabricated data / wish pool / needs-setup degradation guidance
- **The only founder blockers**: npm publish 2FA (paths A/B written in docs/tokens.md) + agent-reach 7-channel cookies (can wait)


## 14. Session data-plane tool surface (2026-08-28, P3 slice 1/2; real-model inspection awaiting sign-in state)

- **smoke §12 evidence**: 17 tools registered including `gotry_flyai_search`/`gotry_session_search`; flyai live hit (Shanghai→Lijiang 2026-10-01, 10 items, evidence chain [实时API:flyai@ts]); session tool terminal state needs-login (sign-in state is a precondition contract; zero navigation, zero requests).
- **Persona contract (19)** is in the repo-root yml: three-level routing (official → session cross-validation → static package), direct/transfer bucketed comparison; stop immediately when challenged.
- **TODO**: once the founder's sign-in state is on disk, add one real-model session inspection case (the profile currently has 0 Cookies rows — diagnosed live in the 2026-08-28 tick; session-login needs a rerun with login completed within the window).
- **Gold-standard flyai baseline (fa-01..04, evening of 2026-08-28, via the capability layer)**: fa-01 Shanghai→Lijiang flight hit 10 items min ¥230 (cross-day transfer chain)/2.8s; fa-02 Beijing→Dali flight **miss 0 items** (a live case of three-value semantics: small-airport seasonal routes, miss≠error, degradation path correct)/4.5s; fa-03 Shanghai→Dali train hit 10 items/2.5s; fa-04 Beijing→Kunming train hit 10 items/2.6s. **Masked train-price finding**: unauthenticated Fliggy (飞猪) train entries carry prices in the "1xxx" form — flyai.ts now passes priceRaw through (the real price is what the jumpUrl landing page shows); flight prices are unaffected.
