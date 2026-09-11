/**
 * 内核运行模块证据生成器(issue #234):对当前工作区产出可审计的证据快照
 * (gotry_kernel_evidence_v1)——冻结清单哈希 + 当前文件哈希 + 真实运行 import
 * trace + 功能路径覆盖,全部哈希绑定(manifestHash / evidenceHash)。
 *
 * 用法:cd ts && npx tsx scripts/kernel-manifest-evidence.ts [--out <file>] [--root <dir>] [--manifest <path>]
 * 退出码:0 = 证据已产出(不等于闸通过,裁决在 kernel-manifest-gate.ts);2 = 环境/trace 失败。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  currentHeadSha,
  defaultRepoRoot,
  evidenceHash,
  EVIDENCE_SCHEMA_VERSION,
  fileSha256,
  importClosure,
  loadKernelManifest,
  manifestHash,
  MANIFEST_REL,
  runRuntimeTrace,
  TRACE_ENTRY_REL,
  RUNTIME_ENTRY_REL,
  type KernelEvidence,
} from './kernel-manifest.ts'

export type BuildEvidenceOptions = {
  repoRoot: string
  manifestRel?: string
  /** 测试注入固定时钟,保证 fixture 快照哈希确定;真实运行省略。 */
  now?: string
  /** 测试注入 trace 结果(fixture 无真实运行面);真实运行省略。 */
  trace?: ReturnType<typeof runRuntimeTrace>
  candidateSHA?: string
}

function packagedFor(npmFiles: string[], path: string): boolean {
  return npmFiles.some((f) => f === path || path.startsWith(f.endsWith('/') ? f : `${f}/`))
}

/** 组装证据快照:内核逐文件 当前哈希/加载位/打包位 + 功能路径覆盖位,末尾哈希绑定。 */
export function buildEvidence(manifest: ReturnType<typeof loadKernelManifest>, opts: BuildEvidenceOptions): KernelEvidence {
  const { repoRoot } = opts
  const trace = opts.trace ?? runRuntimeTrace(repoRoot)
  if (!trace.ok) {
    throw new Error(`运行模块 trace 失败(环境问题):${trace.error}`)
  }
  const rootPkgAbs = resolve(repoRoot, 'package.json')
  let npmFiles: string[] = []
  if (existsSync(rootPkgAbs)) {
    const pkg = JSON.parse(readFileSync(rootPkgAbs, 'utf8')) as { files?: string[] }
    if (Array.isArray(pkg.files)) npmFiles = pkg.files
  }
  const loaded = new Set(trace.loadedRepoModules)
  const kernel = (manifest.entries ?? []).map((entry) => {
    const current = fileSha256(repoRoot, entry.path)
    if (current === null) throw new Error(`内核文件缺失,证据无法产出:${entry.path}`)
    return {
      path: entry.path,
      group: entry.group,
      sha256Frozen: entry.sha256,
      sha256Current: current,
      loadedInTrace: loaded.has(entry.path),
      packagedForNpm: packagedFor(npmFiles, entry.path),
    }
  })
  const functionalPaths = (manifest.functionalPaths ?? []).map((fp) => ({
    name: fp.name,
    group: fp.group,
    suite: fp.suite,
    runAllSection: fp.runAllSection,
    kernelModules: fp.kernelModules,
    suiteImportsVerified: (fp.kernelModules ?? []).every((m) => importClosure(repoRoot, fp.suite).has(m)),
  }))
  let candidateSHA = opts.candidateSHA
  if (!candidateSHA) {
    const head = currentHeadSha(repoRoot)
    if (head === null) throw new Error('无法读取 git HEAD(需要 git 仓库)——candidateSHA 无法绑定')
    candidateSHA = head
  }
  const evidence: KernelEvidence = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    issue: manifest.issue,
    manifestRef: { path: opts.manifestRel ?? MANIFEST_REL, sha256: manifestHash(manifest) },
    baseSHA: manifest.baseSHA,
    candidateSHA,
    frozenAt: manifest.frozenAt,
    generatedAt: opts.now ?? new Date().toISOString(),
    runtime: {
      node: trace.nodeVersion,
      traceTool: 'node:module registerHooks (sync) + tsx/esm, import-only',
      entry: TRACE_ENTRY_REL,
      importTarget: RUNTIME_ENTRY_REL,
      moduleCount: trace.moduleCount,
      repoModuleCount: trace.repoModuleCount,
      loadedRepoModules: trace.loadedRepoModules,
    },
    kernel,
    functionalPaths,
  }
  return { ...evidence, evidenceHash: evidenceHash(evidence) }
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const argOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const repoRoot = resolve(argOf('--root') ?? defaultRepoRoot())
  const manifestRel = argOf('--manifest') ?? MANIFEST_REL
  const out = argOf('--out')
  try {
    const manifest = loadKernelManifest(repoRoot, manifestRel)
    const evidence = buildEvidence(manifest, { repoRoot, manifestRel })
    const text = JSON.stringify(evidence, null, 2) + '\n'
    if (out) {
      writeFileSync(resolve(out), text)
      console.log(`KERNEL EVIDENCE: 写出 ${resolve(out)}(evidenceHash ${evidence.evidenceHash?.slice(0, 12)}…,manifestHash ${evidence.manifestRef.sha256.slice(0, 12)}…,candidateSHA ${evidence.candidateSHA.slice(0, 12)}…,trace 模块 ${evidence.runtime.moduleCount},仓库模块 ${evidence.runtime.repoModuleCount})`)
    } else {
      process.stdout.write(text)
    }
    return 0
  } catch (err) {
    console.error(`KERNEL EVIDENCE: FAIL — ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) process.exit(main())
