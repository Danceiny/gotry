# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1-rc.16] - 2026-08-30

### Added

- 价表 provider-aware v2 + 价格漂移长机制(ADR-20)… (#68)
- 会话扩展 onboarding UX 闭环(点点点 + 装完零重跑)… (#66)
- 可下单事实单一数据源 + 产物事实闸(ADR-19)… (#53)
- 传输层定案扩展桥(issue #21 方案 C)——Chrome 144+ 逐连接 CDP 权限框实测不可产品化(founder「授权太频繁根本无法使用」;chrome-devtools-mcp #825:每连接必弹、无持久化批准),自研… (#52)
- staicli 全流程接入收口 + 端到端测试(run-all §7d)——全链路真打 UAT:官方脚本装 staicli→hotel-be 种子沙箱账号(hotelbyte_api_demo,predefined_user_demo.go… (#51)
- 效应解译器 effect_interpreter.v1——外部依赖隔离(issue #16 采纳… (#47)
