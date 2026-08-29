# vendored dsh runtime(`vendor/`)

本目录是 [DeepSeek Harness(dsh CLI)](https://github.com/deepseek-ai/DeepSeek-Harness)
dsh 发布家族的全量 vendored 成员,pnpm workspace 方式参与安装
(`ts/dsh-runtime/pnpm-workspace.yaml` 声明 `vendor/*`,`linkWorkspacePackages: true`)。

## 当前版本

- 上游:`dsh-v0.1.2-alpha.1`(tag;alpha 面向 monorepo 内部,尚未发布到
  npm 公共 registry——npm latest 仍为 `0.1.1-rc.2`,等上游 publish 后本目录
  可整体换回 npm 依赖形态)。
- 源 commit:`cd5ef814`(/tmp 构建树为浅克隆同源;发布 tag 见上游 releases)。
- License:MIT © DeepSeek(upstream LICENSE);本仓 MIT 使用。

## 为什么 vendored(而不是 npm 依赖)

- 上游只挂 GitHub 预发布 tag;依赖闭包(dsh 家族 ~187 个内部包 + cordis/
  schemastery 等 vendor 家族)里 **dsh 家族全部 0.1.2-alpha.1 均不在公共
  npm**,外部环境不可安装。
- `ts/dsh-runtime` 只影响 repo 工作副本与 `./gotry`;npm 公共分发面
  (root `package.json`)仍钉 rc.2,不受影响;CI 不安装本目录。
- workspace 成员 + `linkWorkspacePackages: true` 让成员间
  `^0.1.2-alpha.1` 的 range 直接命中本地版本,干净克隆只依赖本仓文件 +
  公共 registry(第三方),不依赖内部镜像。

## 升级/复现流程(下个版本照抄)

1. `git clone --depth 1 --branch <tag> https://github.com/deepseek-ai/DeepSeek-Harness.git /tmp/dsh-<tag>`
2. `cd /tmp/dsh-<tag> && pnpm install && pnpm build:official`
3. `pnpm release:pack --family dsh --out dist/dsh`(产出 241 个 tarball)
4. 解包 tarball(`package/` 前缀剥掉)平铺进 `vendor/<kebab-name>/`
5. manifest 归一处:**删除各成员的 `devDependencies`**(上游 devDeps 引用
   未进发布家族的 experimental 私有包,npm 安装形态本就不装 devDeps;
   唯 `@deepseek-ai/dsh-subprocess-local` 的 `postinstall` 保
   留——恢复 node-pty spawn-helper 可执行位,终局面依赖);
   `scripts` 里 dev 期 `bundle/watch/build` 一并丢弃。
6. 更新 `package.json` 的 4 个直接依赖版本 + `pnpm install` 重新生成 lockfile
7. 验证:`./gotry help` 报版本;`cd ts && npx tsc --noEmit && npx tsx scripts/smoke.ts`;
   全量 `bash scripts/run-all-tests.sh` 全绿后才可提交。

## 纪律

- 本目录内容必须与上游 tag 的 tarball 逐字节一致(`devDependencies`/
  dev 期 `scripts` 除外);不得手改 vendor 内代码——补丁面一律走 gotry 侧
  (`cordis.gotry-patch.yml` / `bin/gotry-inner.js`)。
- `gotry-state/`、`node_modules/` 已 gitignore;`vendor/` 与三份 manifest
  (package.json / pnpm-lock.yaml / pnpm-workspace.yaml / .npmrc)入 git。