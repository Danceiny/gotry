[English](dsh-plugins-shortlist.md) | [简体中文](dsh-plugins-shortlist.zh-CN.md)

# dsh Community Plugin Selection (awesome-dsh-plugin.com research, issue #9)

> Status: frozen (selection research, 2026-08-29; issue #9; integrated items annotated in the body)
> The site lists 2176 DeepSeek Harness plugins (full pull of the schema.org ItemList; coarse screening into 8 categories by gotry
> roadmap-gap keywords; the 8 shortlisted ones each had their README pulled and verified). This document answers one question only:
> **which plugins are worth installing into gotry's dsh host to fill host-layer capabilities we do not want to build ourselves**.
> Integration goes through `dsh plugin add <name>` by default (host-layer install, not into gotry dependencies); the only exception is
> `dsh-map-tools`: its upstream rc peer is incompatible with the GoTry alpha.3 closure, so it is vendored in-band as an MIT payload.

## Worth trying immediately (directly fills known gaps)

| Plugin | Verified capability | Which gap it fills |
|---|---|---|
| [HorusJiang/dsh-map-tools](https://github.com/HorusJiang/dsh-map-tools) | Driving/transit/walking/cycling route planning, geocoding, reverse geocoding, POI search — **native tools**, called directly by the model, no MCP needed | ✅ **Integrated** (currently v0.5.1 MIT payload vendored in-band; the 7 `map_*` tools are locked by clean-tarball proof) |
| [STARDUSTLC666/dsh-calendar](https://github.com/STARDUSTLC666/dsh-calendar) | CalDAV calendar read/write, recurring events auto-expanded, 5 model-facing tools | ✅ **Integrated 2026-08-25** (v0.3.2; calendar_list/search/create/update/delete registered; once CalDAV is configured the work window is read automatically — plug and play pending configuration) |
| [omdsh-dev/DSH-better-sidebar](https://dshmarket.com/zh/p/omdsh-dev/DSH-better-sidebar/) | dsh web sidebar workbench: file tree + Markdown/Mermaid/PDF preview + editor + Git panel; third-party Tab API (registerTab/registerFileViewer); ★3083 / 189k weekly installs (dshmarket #1 UI) | ✅ **Integrated 2026-08-29** (v0.17.1; installed at the host layer via `gotry setup`; the artifact viewing surface of issue #25; verified loading under the web profile with the file workbench usable; a ledger-aware artifact Tab remains undone separately; #285's in-conversation public Client cards are already provided by GoTry's own adapter) |

## Product loop infrastructure (the reach host for the "next trip", M3→M5)

| Plugin | Verified capability | Use |
|---|---|---|
| [yangyongzhen/dsh-scheduler](https://github.com/yangyongzhen/dsh-scheduler) | cron/one-shot triggers, shell/webhook, can push to ServerChan/DingTalk/Feishu | **Proactive follow-up triggers** for wish pool entries (ping the user when window/season conditions are met) |
| [amlyczz/dsh-lark-link](https://github.com/amlyczz/dsh-lark-link) | Two-way Feishu/Lark bridge, online in 30 seconds via QR scan | Putting gotry into Feishu = an always-on reach surface for seed users |
| [huguangyu666/dsh-plugin-notify](https://github.com/huguangyu666/dsh-plugin-notify) | Desktop notifications / Chinese voice announcements, zero dependencies on Windows | Notification when asynchronous deep planning completes |

## Watchlist (not installed for now)

- [3403473060/dsh-inline-images](https://github.com/3403473060/dsh-inline-images) — inline rendering of local images in conversation; install when gotry actually produces attraction photos
- [Js2Hou/dsh-mcp-manager](https://github.com/Js2Hou/dsh-mcp-manager) — visual MCP management; re-evaluate if the MCP route is taken (at the #5 discussion)
- [coolbreezecoin/dsh-wechat-mp](https://github.com/coolbreezecoin/dsh-wechat-mp) — markdown → WeChat Official Account drafts; for the content-ops period

## Explicitly not outsourced: memory (self-built in M4)

Of the 2176 plugins, the 75 whose name contains memory/remember/rag/vector are **all UI-layer history records**
(chat-history/composer-history/input history); not one is real agent long-term memory.
M4 memory (motivation profile / preferences / cross-session state) stays self-built — this is gotry's product core,
not a host capability.

## Suggested rollout order

1. dsh-map-tools (already vendored in-band, and its 7 tools verified by the §49b clean-tarball proof; no external npm peer install needed)
2. dsh-calendar (together with the M4 memory kickoff: the calendar is the fact source of the work window)
3. scheduler + lark-link (when designing the M5 "next trip" closed loop)
