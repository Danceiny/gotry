<!--
感谢 PR!提交前请读 CONTRIBUTING.md。合并条件:CI 全绿(Node 22/24,typecheck + §1-§34)+ 维护者 review。
Thanks for your PR! Merging requires green CI (Node 22/24, typecheck + full regression §1-§34) plus maintainer review.
-->

## 为什么改 · Why

<!-- 一句话说清动机;涉及 bug 请附 issue 链接 -->

## 改了什么 · What

<!-- 关键文件/模块;行为变化的列点 -->

## 测试证据 · Test evidence

<!-- 粘贴 `./scripts/run-all-tests.sh` 末行(ALL SUITES GREEN)或 CI 通过链接;行为改动另有金标准断言的请说明 -->

## 自查清单 · Checklist

- [ ] 本地全栈回归全绿(`./scripts/run-all-tests.sh`,§1-§34)
- [ ] 分支从最新 `main` 切出,单一关注点;只暂存了本 PR 的具名文件(未用 `git add -A` / `git commit -am`)
- [ ] 未调用 deprecated 层(`engine.*` / `journey.*`);算术仅在 `model.ts`/`unified.py` evaluate 层,求解仅在 `unified.*`
- [ ] 行为/架构改动已立 ADR(`docs/architecture.md` §8),或本改动无行为变化
- [ ] 改变系统形态/状态/债务的,已同提交同步 6 处状态面(`architecture.md` §11),否则勾 N/A
- [ ] 未实现任何直接写操作(预订/支付类);涉写路径一律走 WriteGate
- [ ] 测试/巡检未写入共享运行时状态(写路径验证用了隔离 `stateRoot`)
- [ ] N/A 项:<!-- 无则填「无」 -->
