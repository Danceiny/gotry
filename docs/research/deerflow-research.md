[English](deerflow-research.md) | [简体中文](deerflow-research.zh-CN.md)

# DeerFlow Research → gotry Optimization Targets and Method (issue #10)

> Status: frozen (research working paper, 2026-08-25; issue #10)
> Subject: [bytedance/deer-flow](https://github.com/bytedance/deer-flow) (DeerFlow 2.0, SuperAgent
> harness; 1.x is the classic deep-research framework, version noted where each mechanism is cited). This document answers one question only:
> **which mechanisms gotry should borrow, in what shape, and which it explicitly does not borrow**. Every target maps to an existing issue/roadmap item; no castles in the air.

## Four mechanisms worth borrowing (ordered by gotry priority)

### T1. Automatic turn-capture memory (M4, the root fix for #1)〔borrow 2.0 memory〕
The point of DeerFlow 2.0 memory is not storage but **automaticness**: every dialogue turn automatically captures facts into long-term memory,
and recall is automatic too (optional OpenViking backend). gotry today: the motivation profile depends on explicit
`motivation_save` calls; issue #1's repeated budget question = no automatic sedimentation.
**Method**: M4 adds turn-capture at the plugin layer — new facts in each turn's tool results (budget/dates/window/
origin, structured fields first) merge automatically into motivation-profile.json; explicit save degrades into a confirmation;
at session start the profile is recalled automatically into the persona context. This is the root fix for #1 and the shared answer to the "maintained state" of #10 and #2.

### T2. Open decisions as multiple choice → structured clarification cards (D-4 follow-up)〔borrow 2.0 clarification cards〕
gotry contract (5) "open decision = multiple choice" is currently markdown text. DeerFlow's structured clarification cards:
when the agent requests clarification the UI shows a structured card; the user clicks an option or types freely. The dsh dependency tree already has
`dsh-tool-ask-user` (bundled with the host).
**Method**: upgrade open decision questions from plain text to structured ask-user calls (options = buttons); an incapable UI
automatically degrades back to text — a zero-cost upgrade with a large gain in product feel.

### T3. Sub-agents carrying deep research (long tasks)〔borrow 2.0 sub-agents "optimization, not default"〕
DeerFlow's stance: **sub-agents are an optimization, not the default response to complex requests** — scoped context + independent
termination conditions, results verified and synthesized by the lead. gotry is a single agent with 12 tools; long tasks like
"compare five destinations comprehensively for me" will blow up the main conversation context. dsh ships the `dsh-tool-subagent` infrastructure.
**Method**: spawn a subagent only for deep-research requests (restricted tool set: agent_reach/weather/
anything + solvers); artifacts return to the main conversation; ordinary requests never go through sub-agents (following DeerFlow's lesson).

### T4. Background investigation before planning (probePoi upgrade)〔borrow 1.x background investigation〕
DeerFlow 1.x's deep-research loop has a background investigation node before the planner — gather background quickly first,
then set the plan; plans never start from nothing. gotry's probePoi (D-7a) is already the embryo of this.
**Method**: before the feasibility verdict, run the "background trio" automatically: destination weather (climate mode) / exchange rate /
seasonality; the evidence chain ships with the verdict — blocking the old "LLM invents seasonal advice" failure at the pipeline layer.

## Explicitly not borrowed (honest boundaries)

- **Sandboxed execution** (Docker/K8s/E2B capacity policies): gotry has no code-execution need; the solver runs in-process at ~6ms;
- **Report/podcast/slide generation**: not core to a travel product; revisit when a content-ops scenario exists;
- **Full LangGraph migration**: gotry's host is dsh (cordis); switching frameworks = a rewrite with zero payoff.

## Suggested rollout order

T1 starts with the M4 memory kickoff (root fix for #1); T2 landed on 2026-08-22 (web cards + headless/TTY stdio terminal forms + CI text degradation, three forms); T3 waits until seed users actually produce long tasks;
T4 can be probePoi's next small iteration.

---
Sources: [bytedance/deer-flow](https://github.com/bytedance/deer-flow) ·
[deerflow.tech](https://deerflow.tech/) ·
[codebase teardown #1985](https://github.com/bytedance/deer-flow/discussions/1985)
