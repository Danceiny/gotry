/**
 * DSH 目标闭包契约(issue #268):读取仓库当前状态,断言已精确迁移到
 * @deepseek-ai/dsh 0.1.5-alpha.1 的 230 包闭包。这是 issue #268 的 failing-before
 * 契约——在起始 0.1.2-alpha.3/216 闭包上必须失败,迁移完成后必须通过。
 *
 * 断言面(任一不符即 FAIL):
 *  - 运行时 spawn guard 版本 = 目标;
 *  - 闭包常量 = 目标包数;
 *  - 根 manifest 全部 dsh* 依赖精确锁定目标版本,包数 = 目标;
 *  - 15 个新增 sentinel 在根 manifest 精确存在,移除项 dsh-tool-subagent-report 不存在;
 *  - 根 npm lock 闭包与 manifest 集合/版本/包数一致;
 *  - 根 pnpm lock 闭包 + root importer 与 manifest 集合/版本/包数一致;
 *  - ts/package.json 显式声明 @deepseek-ai/dsh-sdk-client@目标(GoTry 直接 import,
 *    不再由上游 main 图传递到达),且其所有显式 dsh* 依赖精确锁定目标版本;
 *  - ts/package.json overrides 的名称集合与根 230 包集合完全一致，值全部精确目标版本;
 *  - ts/package-lock.json 每个真实 DSH 条目(按最后包名段过滤,排除嵌套非 dsh 依赖)
 *    精确锁定目标版本,包数 = 目标,名称集合与根 230 完全一致,拒绝嵌套/混合版本;
 *  - ts/ 实际安装树:用 ts 包的 createRequire 上下文解析每个 dsh 包 package.json,
 *    全精确目标版本,解析路径直接位于 ts/node_modules/@deepseek-ai/ 下(非嵌套)。
 *
 * 仅根目录 230 证据不足——ts/ 是 GoTry 直接 import 的消费方,必须独立验证其三层闭包。
 *
 * 运行:cd ts && npx tsx scripts/dsh-target-closure-proof.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { REQUIRED_BENCHMARK_DSH_VERSION } from '../../bin/gotry-runtime-resolution.js'
import {
  parsePnpmDshLock,
  parsePnpmRootDshImporter,
  REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
  validateDshRuntimeClosure,
  validatePnpmRootDshImporter,
} from './dsh-runtime-closure.ts'

const TARGET_VERSION = '0.1.5-alpha.1'
const TARGET_PACKAGE_COUNT = 230

const ADDED_SENTINELS = [
  '@deepseek-ai/dsh-api-workspace-files',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-ui-open-in-app',
  '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-sidebar-textpreview',
  '@deepseek-ai/dsh-host-open-in-app',
  '@deepseek-ai/dsh-http-proxy',
  '@deepseek-ai/dsh-package-manifest',
  '@deepseek-ai/dsh-session-format',
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-session-format-v0-to-v1',
  '@deepseek-ai/dsh-session-format-v1-to-v2',
  '@deepseek-ai/dsh-session-format-v2-to-v3',
] as const

const REMOVED_SENTINELS = ['@deepseek-ai/dsh-tool-subagent-report'] as const

const repoRoot = join(import.meta.dirname, '..', '..')

type Pkg = { dependencies?: Record<string, string>; overrides?: Record<string, string> }
function readJson(filePath: string): Pkg {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Pkg
}

function dshDependencyNames(deps: Record<string, string>): string[] {
  return Object.keys(deps)
    .filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    .sort()
}

// 1. 运行时 spawn guard 与闭包常量必须已对齐目标。
assert.equal(
  REQUIRED_BENCHMARK_DSH_VERSION,
  TARGET_VERSION,
  `runtime spawn guard 必须锁定 ${TARGET_VERSION}(当前 ${REQUIRED_BENCHMARK_DSH_VERSION})`,
)
assert.equal(
  REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
  TARGET_PACKAGE_COUNT,
  `闭包常量必须为 ${TARGET_PACKAGE_COUNT}(当前 ${REQUIRED_DSH_RUNTIME_PACKAGE_COUNT})`,
)

// 2. 根 manifest:全部 dsh* 依赖精确锁定目标版本,包数 = 目标。
const rootPkg = readJson(join(repoRoot, 'package.json'))
const rootDeps = rootPkg.dependencies ?? {}
assert.equal(rootDeps['@deepseek-ai/dsh'], TARGET_VERSION, '根 manifest @deepseek-ai/dsh 未锁定目标版本')
const rootDshNames = dshDependencyNames(rootDeps)
for (const name of rootDshNames) {
  assert.equal(rootDeps[name], TARGET_VERSION, `根 manifest 版本漂移:${name}@${rootDeps[name]}(expected ${TARGET_VERSION})`)
}
for (const name of ADDED_SENTINELS) {
  assert.equal(rootDeps[name], TARGET_VERSION, `根 manifest 缺失目标新增 sentinel:${name}`)
}
for (const name of REMOVED_SENTINELS) {
  assert.ok(!(name in rootDeps), `根 manifest 必须移除:${name}`)
}
assert.equal(rootDshNames.length, TARGET_PACKAGE_COUNT, `根 manifest dsh 包数不符:${rootDshNames.length}(expected ${TARGET_PACKAGE_COUNT})`)

// 3. 根 npm lock 闭包与 manifest 集合/版本/包数一致。
const npmLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, { version?: string }>
}
const npmClosure = validateDshRuntimeClosure({
  dependencies: rootDeps,
  lockPackages: npmLock.packages ?? {},
  runtimeVersion: TARGET_VERSION,
  expectedPackageCount: TARGET_PACKAGE_COUNT,
})

// 4. 根 pnpm lock 闭包 + root importer 与 manifest 集合/版本/包数一致。
const pnpmLock = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
const pnpmClosure = validateDshRuntimeClosure({
  dependencies: rootDeps,
  lockPackages: parsePnpmDshLock(pnpmLock),
  runtimeVersion: TARGET_VERSION,
  expectedPackageCount: TARGET_PACKAGE_COUNT,
})
const pnpmImporter = validatePnpmRootDshImporter({
  dependencies: rootDeps,
  importerEntries: parsePnpmRootDshImporter(pnpmLock),
  runtimeVersion: TARGET_VERSION,
  expectedPackageCount: TARGET_PACKAGE_COUNT,
})

// 5. ts/package.json 必须显式声明 dsh-sdk-client@目标(GoTry 直接 import)。
const tsDir = join(repoRoot, 'ts')
const tsPkg = readJson(join(tsDir, 'package.json'))
assert.equal(
  tsPkg.dependencies?.['@deepseek-ai/dsh-sdk-client'],
  TARGET_VERSION,
  'ts/package.json 必须显式声明 @deepseek-ai/dsh-sdk-client@' + TARGET_VERSION,
)

// 6. ts/package.json:所有显式 dsh* 依赖必须精确锁定目标版本(不要求 230,ts/ 闭包是
//    传递性的;但显式声明的每个 dsh 依赖都必须精确,不允许 ^/~ 可变范围)。
const tsDeps = tsPkg.dependencies ?? {}
const tsExplicitDsh = dshDependencyNames(tsDeps)
for (const name of tsExplicitDsh) {
  assert.equal(
    tsDeps[name],
    TARGET_VERSION,
    `ts/package.json 显式 dsh 依赖版本漂移:${name}@${tsDeps[name]}(expected ${TARGET_VERSION})`,
  )
}

// 7. ts/package.json overrides 必须精确覆盖根 manifest 的完整 230 包集合。
//    这组 override 是修复 sdk-client peer range 漂移到 alpha.2 的关键约束；只验证
//    三个显式依赖或最终 lock 会遗漏 manifest 层的防漂移策略。
const tsOverrides = tsPkg.overrides ?? {}
const tsOverrideDshNames = dshDependencyNames(tsOverrides)
assert.deepEqual(
  tsOverrideDshNames,
  rootDshNames,
  'ts/package.json overrides 的 DSH 名称集合必须与根 230 包集合完全一致',
)
for (const name of tsOverrideDshNames) {
  assert.equal(
    tsOverrides[name],
    TARGET_VERSION,
    `ts/package.json override 版本漂移:${name}@${tsOverrides[name]}(expected ${TARGET_VERSION})`,
  )
}

// 8. ts/package-lock.json:每个真实 DSH 条目(按包名过滤,排除嵌套非 dsh 依赖)必须
//    精确锁定目标版本,包数 = 目标,名称集合与根 230 完全一致。
//    关键:lock 路径前缀 `node_modules/@deepseek-ai/dsh-skill-filesystem/node_modules/chokidar`
//    的最后包名段是 `chokidar`(非 dsh),不能按路径前缀过滤,必须按最后包名段过滤。
const tsNpmLock = JSON.parse(readFileSync(join(tsDir, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, { version?: string }>
}
const tsLockPackages = tsNpmLock.packages ?? {}

function lastPackageName(lockKey: string): string {
  const idx = lockKey.lastIndexOf('node_modules/')
  return idx >= 0 ? lockKey.slice(idx + 'node_modules/'.length) : lockKey
}

function isDshPackageName(name: string): boolean {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

const tsLockDshNames = new Set<string>()
for (const [key, entry] of Object.entries(tsLockPackages)) {
  if (key === '') continue // 根包自身
  const pkgName = lastPackageName(key)
  if (!isDshPackageName(pkgName)) continue
  // 拒绝嵌套 dsh 条目:路径包含多次 node_modules/ 且最后段是 dsh 包 → 嵌套副本。
  const nodeModulesCount = key.split('node_modules/').length - 1
  assert.equal(
    nodeModulesCount,
    1,
    `ts lock 拒绝嵌套/混合版本 dsh 条目:${key}(node_modules 深度 ${nodeModulesCount})`,
  )
  assert.equal(
    entry.version,
    TARGET_VERSION,
    `ts lock dsh 条目版本漂移:${pkgName}@${entry.version}(expected ${TARGET_VERSION})`,
  )
  assert.ok(!tsLockDshNames.has(pkgName), `ts lock 出现重复 dsh 条目:${pkgName}`)
  tsLockDshNames.add(pkgName)
}
assert.equal(
  tsLockDshNames.size,
  TARGET_PACKAGE_COUNT,
  `ts lock dsh 包数不符:${tsLockDshNames.size}(expected ${TARGET_PACKAGE_COUNT})`,
)
const rootDshNameSet = new Set(rootDshNames)
for (const name of tsLockDshNames) {
  assert.ok(rootDshNameSet.has(name), `ts lock dsh 包不在根 230 集合中:${name}`)
}
for (const name of rootDshNameSet) {
  assert.ok(tsLockDshNames.has(name), `根 230 dsh 包不在 ts lock 中:${name}`)
}

// 9. ts/ 实际安装树:用 ts 包的 createRequire 上下文解析每个 dsh 包的 package.json,
//    读取版本,断言全精确目标版本;解析路径必须直接位于 ts/node_modules/@deepseek-ai/
//    下(非嵌套),拒绝混合版本。
const tsRequire = createRequire(join(tsDir, 'package.json'))
const tsNodeModulesDshDir = join(tsDir, 'node_modules', '@deepseek-ai')
const tsInstalledNames = new Set<string>()
for (const name of rootDshNames) {
  const pkgJsonPath = tsRequire.resolve(join(name, 'package.json'))
  const entry = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string }
  assert.equal(
    entry.version,
    TARGET_VERSION,
    `ts 安装树版本漂移:${name}@${entry.version}(expected ${TARGET_VERSION})`,
  )
  // 解析路径必须直接位于 ts/node_modules/@deepseek-ai/<pkg>/package.json——非嵌套。
  assert.ok(
    pkgJsonPath.startsWith(tsNodeModulesDshDir + '/'),
    `ts 安装树解析路径不在直接 @deepseek-ai 目录下(嵌套/混合版本):${name} → ${pkgJsonPath}`,
  )
  const relative = pkgJsonPath.slice(tsNodeModulesDshDir.length + 1)
  assert.ok(
    !relative.includes('/node_modules/'),
    `ts 安装树出现嵌套 dsh 副本:${name} → ${relative}`,
  )
  tsInstalledNames.add(name)
}
assert.equal(
  tsInstalledNames.size,
  TARGET_PACKAGE_COUNT,
  `ts 安装树 dsh 包数不符:${tsInstalledNames.size}(expected ${TARGET_PACKAGE_COUNT})`,
)

console.log(
  `DSH TARGET CLOSURE PROOF: root ${npmClosure.names.length} npm / ${pnpmClosure.names.length} pnpm / ${pnpmImporter.names.length} importer, ` +
    `ts ${tsExplicitDsh.length} explicit / ${tsOverrideDshNames.length} overrides / ${tsLockDshNames.size} lock / ${tsInstalledNames.size} installed at ${TARGET_VERSION}`,
)
