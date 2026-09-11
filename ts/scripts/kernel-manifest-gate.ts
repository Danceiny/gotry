/**
 * 内核清单冻结机械闸(issue #234;g5-guard/dsh-target-closure-proof 同形态:
 * 清单冻结 + 机械校验,不是新政策)。对照真实运行面裁决,漂移即红:
 *   1. 冻结清单 schema/依据/路径形状纪律(宁窄勿宽,ts/src/ 内核面);
 *   2. 内核零 diff:当前文件 SHA256 == 冻结值(改核心/删文件 → 红,事后删文件
 *      制造零 diff 被封死);
 *   3. 打包面:内核 ⊆ npm 包 files 面(发布产物才可能内核一致);
 *   4. 真实运行 import trace(默认模式,子进程离线):内核清单全部被产品运行面
 *      ts/src/index.ts 实际加载(替换/绕过/未加载内核 → 红);
 *   5. 功能路径覆盖:同引擎/账本/闸路径的 run-all 套件存在且静态 import 闭包
 *      包含所声称内核模块(缺路径覆盖 → 红);
 *   6. 证据快照哈希绑定(--verify 审计历史快照):manifestHash/evidenceHash/
 *      candidateSHA/baseSHA 全对得上(错 SHA → 红)。
 *
 * 边界:只输出工程复用证据,不冒充 traveler 效果或 M6 试点签约(issue #234
 * 验收 4;#137 门注:M6 实施门以 #136 M5 Exit + P6 批准为前提)。
 *
 * 用法:cd ts && npx tsx scripts/kernel-manifest-gate.ts [--verify <snapshot.json>] [--out <file>] [--root <dir>] [--manifest <path>] [--manifest-hash <hex>] [--skip-trace]
 * 退出码:0 = 绿;1 = 漂移/反证成立;2 = 闸自身无法运行(环境/缺文件/trace 失败)。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  currentHeadSha,
  defaultRepoRoot,
  loadKernelManifest,
  manifestHash,
  MANIFEST_REL,
  nodeSupportsRegisterHooks,
  runRuntimeTrace,
  validateEvidence,
  validateFunctionalCoverage,
  validateKernelIntegrity,
  validateManifestSchema,
  type Finding,
  type KernelEvidence,
} from './kernel-manifest.ts'
import { buildEvidence } from './kernel-manifest-evidence.ts'

function printFindings(headline: string, findings: Finding[]): void {
  console.error(`${headline}(${findings.length} 处):`)
  for (const f of findings) console.error(`  [${f.code}] ${f.detail}`)
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const argOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const repoRoot = resolve(argOf('--root') ?? defaultRepoRoot())
  const manifestRel = argOf('--manifest') ?? MANIFEST_REL
  const verifyPath = argOf('--verify')
  const outPath = argOf('--out')
  const manifestHashPin = argOf('--manifest-hash')
  const skipTrace = argv.includes('--skip-trace')

  const manifestAbs = resolve(repoRoot, manifestRel)
  if (!existsSync(manifestAbs)) {
    console.error(`KERNEL MANIFEST GATE: FAIL(exit 2)— 冻结清单不存在:${manifestRel}`)
    return 2
  }
  const manifest = loadKernelManifest(repoRoot, manifestRel)
  const recomputedManifestHash = manifestHash(manifest)
  if (manifestHashPin && manifestHashPin !== recomputedManifestHash) {
    console.error(`KERNEL MANIFEST GATE: FAIL — manifestHash 与外部钉值不符:${manifestHashPin} ≠ ${recomputedManifestHash}`)
    return 1
  }

  if (verifyPath) {
    // 审计模式:历史快照 ↔ 当前树 ↔ 冻结清单 三方一致性。离线,不重跑 trace;
    // 快照里的 loadedRepoModules 即生成时刻的运行证据,当前树零 diff 由哈希面证明。
    let evidence: KernelEvidence
    try {
      evidence = JSON.parse(readFileSync(resolve(verifyPath), 'utf8')) as KernelEvidence
    } catch (err) {
      console.error(`KERNEL MANIFEST GATE: FAIL(exit 2)— 快照不可读/非法 JSON:${verifyPath}(${err instanceof Error ? err.message : String(err)})`)
      return 2
    }
    const result = validateEvidence(evidence, manifest, repoRoot, { requireLoadedCoverage: true })
    if (!result.ok) {
      printFindings(`KERNEL MANIFEST GATE: FAIL — 快照审计 ${verifyPath} 漂移`, result.findings)
      return 1
    }
    console.log(`KERNEL MANIFEST GATE: OK — 快照审计通过 ${verifyPath}(manifestHash ${recomputedManifestHash.slice(0, 12)}…,candidateSHA ${evidence.candidateSHA.slice(0, 12)}…,内核 ${evidence.kernel.length} 项对当前树零 diff,功能路径 ${evidence.functionalPaths.length} 条覆盖成立)`)
    return 0
  }

  // 默认模式:HEAD 全量校验 + 真实运行 import trace。
  const head = currentHeadSha(repoRoot)
  if (head === null) {
    console.error('KERNEL MANIFEST GATE: FAIL(exit 2)— 无法读取 git HEAD(需要 git 仓库)')
    return 2
  }
  if (!skipTrace && !nodeSupportsRegisterHooks()) {
    console.error(`KERNEL MANIFEST GATE: FAIL(exit 2)— Node ${process.versions.node} 缺少 node:module registerHooks(需 ≥ 22.15.0),无法产生运行模块证据;可用 --skip-trace 退化为静态面`)
    return 2
  }

  const staticFindings = [
    ...validateManifestSchema(manifest).findings,
    ...validateKernelIntegrity(manifest, repoRoot).findings,
    ...validateFunctionalCoverage(manifest, repoRoot).findings,
  ]
  if (staticFindings.length > 0) {
    printFindings('KERNEL MANIFEST GATE: FAIL — 内核清单静态面漂移', staticFindings)
    return 1
  }

  if (skipTrace) {
    // 静态退化面:零 diff + 打包 + 功能路径成立,但无运行加载证据(显式声明,不冒充完整证据)。
    console.log(`KERNEL MANIFEST GATE: OK(--skip-trace 静态面,无运行加载证据)— 内核清单零 diff(manifestHash ${recomputedManifestHash.slice(0, 12)}…),功能路径 ${manifest.functionalPaths?.length ?? 0} 条覆盖成立`)
    return 0
  }

  const trace = runRuntimeTrace(repoRoot)
  if (!trace.ok) {
    console.error(`KERNEL MANIFEST GATE: FAIL(exit 2)— ${trace.error}`)
    return 2
  }

  let evidence: KernelEvidence
  try {
    evidence = buildEvidence(manifest, { repoRoot, manifestRel, trace, candidateSHA: head })
  } catch (err) {
    console.error(`KERNEL MANIFEST GATE: FAIL(exit 2)— 证据组装失败:${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
  const result = validateEvidence(evidence, manifest, repoRoot, { requireLoadedCoverage: true, expectedCandidateSha: head })
  if (!result.ok) {
    printFindings('KERNEL MANIFEST GATE: FAIL — 运行模块证据面漂移', result.findings)
    return 1
  }
  if (outPath) {
    writeFileSync(resolve(outPath), JSON.stringify(evidence, null, 2) + '\n')
  }
  const notLoaded = evidence.kernel.filter((k) => !k.loadedInTrace)
  const unloadedNote = notLoaded.length === 0
    ? `内核 ${evidence.kernel.length}/${evidence.kernel.length} 被真实运行加载`
    : `内核 ${evidence.kernel.length - notLoaded.length}/${evidence.kernel.length} 被加载`
  console.log(`KERNEL MANIFEST GATE: OK — 内核清单零 diff(manifestHash ${recomputedManifestHash.slice(0, 12)}…),${unloadedNote},功能路径 ${evidence.functionalPaths.length} 条覆盖成立,candidateSHA ${head.slice(0, 12)}…${outPath ? `,快照 → ${resolve(outPath)}` : ''}`)
  return 0
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) process.exit(main())
