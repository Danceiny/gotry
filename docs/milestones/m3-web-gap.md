[English](m3-web-gap.md) | [简体中文](m3-web-gap.zh-CN.md)

# M3 segment 1: minimal web surface live test and gap list

> Status: frozen (historical memo, 2026-08-29)
> Test subject: `./gotry` (= dsh web profile + GoTry patch: persona + five tools + native DeepSeek).
> Test method: startup HTTP 200 confirmation, title/logs/indirect evidence (headless has verified the full five-tool + persona chain; web and headless share the same wiring).
> Judgment baseline: D1 product design's L1 promises (transparency cards / full cost / gates as multiple-choice / evidence chain).

## 1. Live test results

| Item | Status | Note |
|---|---|---|
| Web UI startup | ✅ HTTP 200, localhost:3080 | Title "DeepSeek Harness" |
| GoTry plugin loading | ✅ (same wiring verified in headless: five tools + persona) | web/headless share the cordis wiring |
| Skeleton validation reachable | ✅ (see [骨架:openflights] output in the startup logs) | the plugin import chain is alive |
| Conversation capability | ✅ verified in headless (Yunnan-with-parents full chain) | web is a UI shell over the same model |

## 2. Gaps vs product expectations (concretizing D-4)

| # | Gap | Severity | How M3 redeems it |
|---|---|---|---|
| G-1 | **The title is "DeepSeek Harness", not "GoTry"** — users see someone else's product | High (brand) | dsh web supports title customization or adding a login/cover page; or M3 builds its own thin shell (next row) |
| G-2 | **dsh web is a coding-agent UI, not a travel-product UI**: the conversation flow works, but transparency card/markdown table rendering is generic chat quality, not product grade (no card-style multiple-choice gates / no map slot / no budget bar) | High (product experience) | Direction A: go deep on dsh's `presentCall`/`presentResult` card mechanism (tools implemented but styling is generic); Direction B (tech-strategy §7-3): build a 3-5 page thin shell with assistant-ui + Vercel AI SDK. **2026-08-29 correction: the self-built thin-shell experiment (zero-dependency webui/) was withdrawn because UI quality fell below product grade (founder verdict); the workbench surface now goes through the host component dsh-better-sidebar (see G-3)** |
| G-3 | **Presentation of async "come back in an hour" in web mode**: dsh has no productized work-order progress view | Medium | Short term: in-conversation text progress; mid term: a read-only status page for gotry-state/async (a single /status route). **2026-08-29 minimal slice landed (issue #25)**: `gotry_artifacts_list/read` inside dsh discovers and reads work-order deliverables and working-directory md files with line numbers (read card); **2026-09-10 #285** added public keyed Web cards under `./client`, with fresh-profile E2E covering list→select/open→read→edit→updated-read; a full ledger-aware "Artifacts tab" is still not part of this slice. The dsh web right-side workbench (file tree/Markdown/Mermaid/PDF preview) continues as an additional workspace preview surface |
| G-4 | Session/state is dsh's session, not a product view of TripState (wish pool / motivation profile are visible nowhere) | Medium | Three pages of the self-built shell: conversation / wish pool / motivation profile (TripState already has the JSON); or mount read-only pages via better-sidebar's third-party Tab API (registerTab, client-half) |
| G-5 | No mobile | Low (M3 seed users are invite-only; desktop-first is acceptable) | After M4 |

## 3. Recommendation (for the §7-3 decision)

**Direction B (self-built thin shell) is the M3 mainline** — reasons:
1. dsh web's generality is double-edged: runnable ≠ product-like; brand (G-1) and experience (G-2) cannot be changed inside someone else's shell;
2. GoTry's L1 promises (transparency cards / multiple-choice gates / map slot) need a customization depth beyond what presentCall cards can give;
3. The shell is thin: conversation (bridged to dsh headless, or using LlmPort directly) + two read-only pages for wish pool / motivation profile — **everything core is reused; only the shell is new**;
4. dsh remains the runtime base (headless mode continues as the engine entry); shell and base decouple via the LlmPort contract — no conflict with the founder's "no in-house agent runtime" constraint (the shell is UI, not a runtime).

**If the founder picks Direction A (stay on dsh web)**: M3 does only G-1 (title/brand) and presentCall card styling polish, accepting the generic chat form — faster but weaker product feel.

Sources: live startup test (localhost:3080) + headless same-wiring acceptance (b0cfd97).
