<!--
感谢 PR!提交前请读 CONTRIBUTING.md。合并条件:最终 SHA 本地 typecheck + 全栈回归证据、适用 E2E、CI 补充信号、维护者 review。
Thanks for your PR! Merge requires local final-SHA typecheck + full regression evidence, applicable E2E, CI as additional signal, and maintainer review.

本模板按 issue #225 program 贡献闸更新;如 #227(Node24 Z3 间歇 heap corruption)未解决,PR 必须保持 draft,并在下方 TODO 顶部编号列出该阻断与其它未结门槛。
-->

## 为什么改 · Why

<!-- 一句话说清动机;涉及 bug/issue 请附链接 -->

## 改了什么 · What

<!-- 关键文件/模块;行为变化的列点 -->

## 最终 SHA 本地证据 · Local final-SHA evidence

<!-- 必填:HEAD SHA、命令、exit code、关键末行。CI 只能补充,不能替代本地最终 SHA 证据。 -->

- HEAD:
- `cd ts && npx tsc --noEmit`: exit
- `GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh`: exit;末行:

## 最小 E2E · Minimal E2E

<!-- 必填。用户可见/业务效果变化贴实际路径证据;纯文档/索引改动写 N/A + burden-of-proof(例如链接/路径检查)。 -->

## 语义/架构/维护兼容 · Semantics / architecture / maintenance

<!-- 语义变更:用户可见差异;架构变更:ADR/设计让渡;维护改动:兼容/回滚/不改范围。无则写 N/A。 -->

## CI · Continuous integration

<!-- 粘贴 CI 链接或状态。CI 是补充信号,不是本地证据替代。 -->

## 自查清单 · Checklist

- [ ] 已在最终 SHA 本地跑 typecheck 与全栈回归,并在上方贴 exit code 与末行
- [ ] 已填写最小 E2E 行;N/A 时写明 burden-of-proof
- [ ] 分支从最新 `main` 切出,单一关注点;只暂存了本 PR 的具名文件(未用 `git add -A` / `git commit -am`)
- [ ] 未调用 deprecated 层(`engine.*` / `journey.*`);算术仅在 `model.ts`/`unified.py` evaluate 层,求解仅在 `unified.*`
- [ ] 行为/架构改动已立 ADR或更新设计让渡,或本改动无行为/架构变化
- [ ] 改变系统形态/状态/债务的,已同提交同步 6 处状态面(`architecture.md` §11),否则勾 N/A
- [ ] 未实现任何直接写操作(预订/支付类);涉写路径一律走 WriteGate
- [ ] 测试/巡检未写入共享运行时状态(写路径验证用了隔离 `stateRoot`)
- [ ] 未宣称未实际配置的分支保护、徽章或机器闸
- [ ] N/A 项:<!-- 无则填「无」 -->
