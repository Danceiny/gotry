/**
 * GoTry 内核清单冻结 + 运行模块证据(issue #234;M5 备产系列,父单 #136)。
 *
 * 把复用矩阵纪律「哪些模块属于 GoTry 内核(不允许被替换/绕过)」机械化为可校验清单:
 *   1. 冻结清单 ts/data/kernel-manifest.json(gotry_kernel_manifest_v1):预先冻结
 *      内核文件集合 + 文件 SHA256 + 每项依据,绑定 baseSHA——零 diff 证明 = 哈希相等,
 *      不存在「事后删文件制造零 diff」的空间(删文件即 kernel-file-missing 红)。
 *   2. 运行模块证据(gotry_kernel_evidence_v1):对真实产品运行面(ts/src/index.ts
 *      dsh 插件入口)做真实运行 import trace(node:module registerHooks 同步钩子,
 *      子进程离线),断言内核清单全部被运行加载;再对照功能路径覆盖(同引擎/账本/闸
 *      路径的 run-all 套件静态 import 闭包)。仅 LOC/字符串扫描不构成复用证明。
 *   3. 证据快照哈希绑定(manifestHash + evidenceHash),离线可复跑、可审计。
 *
 * 边界(诚实声明,对齐 issue #234 与 #137 门注):本面只输出工程复用证据,
 * 不冒充 traveler 效果或 M6 试点签约;精确运行模块证据成为实施门以 #136 M5 Exit
 * 与创始人 P6 批准记录在 #137 为前提——本面是 pre-entry 设计 + 确定性 fixture。
 *
 * 用法:
 *   npx tsx scripts/kernel-manifest-evidence.ts  生成证据快照(--out 或 stdout)
 *   npx tsx scripts/kernel-manifest-gate.ts      机械闸(默认 HEAD 全量校验)
 *   npx tsx scripts/kernel-manifest-tests.ts     反证自测(全离线)
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST_SCHEMA_VERSION = 'gotry_kernel_manifest_v1'
export const EVIDENCE_SCHEMA_VERSION = 'gotry_kernel_evidence_v1'
export const MANIFEST_REL = 'ts/data/kernel-manifest.json'
export const RUNTIME_ENTRY_REL = 'ts/src/index.ts'
export const TRACE_ENTRY_REL = 'ts/scripts/kernel-manifest-trace-entry.ts'
export const TRACE_HOOK_REL = 'ts/scripts/kernel-manifest-trace-hook.mjs'
/** registerHooks 需 Node ≥ 22.15(同步、主线程);低于此版本闸无法运行(exit 2)。 */
export const MIN_NODE_FOR_REGISTER_HOOKS = [22, 15, 0]

export const KERNEL_GROUPS = ['engine', 'ledger', 'gate'] as const
export type KernelGroup = (typeof KERNEL_GROUPS)[number]

export type KernelManifestEntry = {
  path: string
  group: string
  sha256: string
  rationale: string
  basis: string
}
export type KernelExclusion = { path: string; reason: string }
export type KernelFunctionalPath = {
  name: string
  group: string
  suite: string
  runAllSection: number
  kernelModules: string[]
}
export type KernelManifest = {
  schemaVersion: string
  issue: string
  frozenAt: string
  baseSHA: string
  entries: KernelManifestEntry[]
  excluded: KernelExclusion[]
  functionalPaths: KernelFunctionalPath[]
}

export type KernelEvidenceKernelItem = {
  path: string
  group: string
  sha256Frozen: string
  sha256Current: string
  loadedInTrace: boolean
  packagedForNpm: boolean
}
export type KernelEvidenceFunctionalPath = {
  name: string
  group: string
  suite: string
  runAllSection: number
  kernelModules: string[]
  suiteImportsVerified: boolean
}
export type KernelEvidence = {
  schemaVersion: string
  issue: string
  manifestRef: { path: string; sha256: string }
  baseSHA: string
  candidateSHA: string
  frozenAt: string
  generatedAt: string
  runtime: {
    node: string
    traceTool: string
    entry: string
    importTarget: string
    moduleCount: number
    repoModuleCount: number
    loadedRepoModules: string[]
  }
  kernel: KernelEvidenceKernelItem[]
  functionalPaths: KernelEvidenceFunctionalPath[]
  evidenceHash?: string
}

export type Finding = { code: string; detail: string }
export type ValidateResult = { ok: boolean; findings: Finding[] }

function toResult(findings: Finding[]): ValidateResult {
  return { ok: findings.length === 0, findings }
}

/** 规范化 JSON:键递归排序,消除键序对哈希的扰动(哈希绑定的基础)。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',')
  return `{${body}}`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 冻结清单的哈希绑定:清单内容(规范化)的 SHA256。 */
export function manifestHash(manifest: KernelManifest): string {
  return sha256Hex(canonicalJson(manifest))
}

/** 证据快照的哈希绑定:去掉 evidenceHash 字段后(规范化)的 SHA256。 */
export function evidenceHash(evidence: KernelEvidence): string {
  const { evidenceHash: _ignored, ...rest } = evidence
  return sha256Hex(canonicalJson(rest))
}

export function repoRelative(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).split(sep).join('/')
}

export function defaultRepoRoot(): string {
  // 本文件位于 <repo>/ts/scripts/,仓库根在其上两级。
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function loadKernelManifest(repoRoot: string, manifestRel = MANIFEST_REL): KernelManifest {
  const raw = JSON.parse(readFileSync(join(repoRoot, manifestRel), 'utf8')) as KernelManifest
  return raw
}

const SHA256_RE = /^[0-9a-f]{64}$/
const GIT_SHA_RE = /^[0-9a-f]{40}$/
/** 内核条目只允许产品运行面 ts/src/<module>.ts(宁窄勿宽,拒绝目录/逃逸/杂类)。 */
const KERNEL_PATH_RE = /^ts\/src\/[A-Za-z0-9_-]+\.ts$/
/** 废弃兼容层永远不得冒充内核(AGENTS.md:engine.ts / journey.ts deprecated)。 */
export const FORBIDDEN_KERNEL_PATHS: ReadonlySet<string> = new Set(['ts/src/engine.ts', 'ts/src/journey.ts'])

/** 计算文件当前 SHA256;文件缺失返回 null。 */
export function fileSha256(repoRoot: string, relPath: string): string | null {
  const abs = join(repoRoot, relPath)
  if (!existsSync(abs)) return null
  return sha256Hex(readFileSync(abs, 'utf8'))
}

/**
 * 静态 import 闭包:从 entryRel 出发,沿相对 .ts import(transitive)收集可达文件
 * (仓库相对路径)。仓库约定 import 带 .ts 扩展名;覆盖 `from '...'` 与 `import('...')`。
 */
export function importClosure(repoRoot: string, entryRel: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entryRel]
  const FROM_RE = /from\s+'([^']+)'/g
  const DYNAMIC_RE = /import\('([^']+)'\)/g
  while (queue.length > 0) {
    const current = queue.pop() as string
    if (seen.has(current)) continue
    seen.add(current)
    const abs = join(repoRoot, current)
    if (!existsSync(abs)) continue
    const content = readFileSync(abs, 'utf8')
    const specifiers = new Set<string>()
    for (const re of [FROM_RE, DYNAMIC_RE]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) specifiers.add(m[1])
    }
    for (const spec of specifiers) {
      if (!spec.startsWith('.') || !spec.endsWith('.ts')) continue
      const target = repoRelative(repoRoot, resolve(dirname(abs), spec))
      if (!target.startsWith('..')) queue.push(target)
    }
  }
  return seen
}

/** 当前 git HEAD(40 hex);非 git 环境/失败返回 null。 */
export function currentHeadSha(repoRoot: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  if (result.error || result.status !== 0) return null
  const sha = result.stdout.trim()
  return GIT_SHA_RE.test(sha) ? sha : null
}

function nodeVersionTuple(): [number, number, number] {
  return process.versions.node.split('.').map((n) => Number(n)) as [number, number, number]
}

/** 运行环境是否具备 registerHooks(同步钩子)能力。 */
export function nodeSupportsRegisterHooks(): boolean {
  const [maj, min, patch] = nodeVersionTuple()
  const [rMaj, rMin, rPatch] = MIN_NODE_FOR_REGISTER_HOOKS
  return maj > rMaj || (maj === rMaj && (min > rMin || (min === rMin && patch >= rPatch)))
}

export type RuntimeTrace = {
  ok: boolean
  error?: string
  nodeVersion: string
  moduleCount: number
  repoModuleCount: number
  loadedRepoModules: string[]
}

/**
 * 真实运行 import trace:子进程里对真实产品运行面(ts/src/index.ts)执行 import,
 * 用 node:module registerHooks 同步 load 钩子记录全部实例化模块;返回仓库内
 * ts/ 面的相对路径(排序)。import-only,零状态写入,全离线。
 */
export function runRuntimeTrace(repoRoot: string): RuntimeTrace {
  const nodeVersion = process.versions.node
  if (!nodeSupportsRegisterHooks()) {
    return {
      ok: false,
      error: `Node ${nodeVersion} 缺少 node:module registerHooks(需 ≥ ${MIN_NODE_FOR_REGISTER_HOOKS.join('.')});无法产生运行模块证据`,
      nodeVersion,
      moduleCount: 0,
      repoModuleCount: 0,
      loadedRepoModules: [],
    }
  }
  const tsDir = join(repoRoot, 'ts')
  const outDir = mkdtempSync(join(tmpdir(), 'gotry-kernel-trace-'))
  const outPath = join(outDir, 'trace.json')
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--import', join(tsDir, 'scripts', 'kernel-manifest-trace-hook.mjs'), join(tsDir, 'scripts', 'kernel-manifest-trace-entry.ts')],
    { cwd: tsDir, encoding: 'utf8', timeout: 180_000, env: { ...process.env, KR_TRACE_OUT: outPath } },
  )
  try {
    if (result.error) {
      return { ok: false, error: `trace 子进程失败:${result.error.message}`, nodeVersion, moduleCount: 0, repoModuleCount: 0, loadedRepoModules: [] }
    }
    if (result.status !== 0) {
      return { ok: false, error: `trace 子进程非零退出 ${result.status}:${(result.stderr ?? '').trim().slice(0, 400)}`, nodeVersion, moduleCount: 0, repoModuleCount: 0, loadedRepoModules: [] }
    }
    if (!(readFileSync(outPath, 'utf8') ?? '').includes('loaded')) {
      return { ok: false, error: 'trace 输出缺失或形状不符(load 钩子未记录任何模块)', nodeVersion, moduleCount: 0, repoModuleCount: 0, loadedRepoModules: [] }
    }
    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as { loaded: string[] }
    const repoModules = parsed.loaded
      .filter((url) => url.startsWith('file://'))
      .map((url) => repoRelative(repoRoot, fileURLToPath(url)))
      .filter((rel) => rel.startsWith('ts/') && !rel.includes('/node_modules/') && !rel.startsWith('ts/dsh-runtime/'))
      .sort()
    const seen = new Set(repoModules)
    return { ok: true, nodeVersion, moduleCount: parsed.loaded.length, repoModuleCount: repoModules.length, loadedRepoModules: [...seen] }
  } finally {
    try { rmSync(outDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响裁决 */ }
  }
}

/** 冻结清单本身的结构纪律(schema/依据/路径形状),与其余校验分离以便单独反证。 */
export function validateManifestSchema(manifest: KernelManifest): ValidateResult {
  const findings: Finding[] = []
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    findings.push({ code: 'manifest-schema-version', detail: `schemaVersion 必须是 ${MANIFEST_SCHEMA_VERSION}(当前 ${manifest.schemaVersion})` })
  }
  if (!GIT_SHA_RE.test(manifest.baseSHA ?? '')) {
    findings.push({ code: 'manifest-base-sha', detail: `baseSHA 必须是 40 位十六进制 git SHA(当前 ${JSON.stringify(manifest.baseSHA)})` })
  }
  if (!manifest.frozenAt || typeof manifest.frozenAt !== 'string') {
    findings.push({ code: 'manifest-frozen-at', detail: 'frozenAt 必须非空(冻结日期)' })
  }
  const entries = manifest.entries ?? []
  if (entries.length === 0) {
    findings.push({ code: 'manifest-empty', detail: '内核清单为空:宁窄勿宽,但不允许空清单冒充冻结面' })
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!KERNEL_PATH_RE.test(entry.path ?? '') || entry.path.includes('..') || isAbsolute(entry.path)) {
      findings.push({ code: 'manifest-path-shape', detail: `内核路径必须是 ts/src/<module>.ts 形状(当前 ${JSON.stringify(entry.path)})` })
    }
    if (FORBIDDEN_KERNEL_PATHS.has(entry.path ?? '')) {
      findings.push({ code: 'manifest-forbidden-path', detail: `废弃兼容层不得进入内核清单:${entry.path}(AGENTS.md:engine.*/journey.* deprecated)` })
    }
    if (seen.has(entry.path)) findings.push({ code: 'manifest-duplicate-path', detail: `内核路径重复:${entry.path}` })
    seen.add(entry.path)
    if (!(KERNEL_GROUPS as readonly string[]).includes(entry.group)) {
      findings.push({ code: 'manifest-group', detail: `group 必须属于 ${KERNEL_GROUPS.join('/')}(当前 ${JSON.stringify(entry.group)})` })
    }
    if (!SHA256_RE.test(entry.sha256 ?? '')) {
      findings.push({ code: 'manifest-sha-shape', detail: `sha256 必须是 64 位十六进制:${entry.path}` })
    }
    if (!entry.rationale || entry.rationale.trim().length === 0) {
      findings.push({ code: 'manifest-rationale-missing', detail: `内核条目缺 rationale(为什么属于内核):${entry.path}` })
    }
    if (!entry.basis || entry.basis.trim().length === 0) {
      findings.push({ code: 'manifest-basis-missing', detail: `内核条目缺 basis(依据:architecture §/ADR/AGENTS 条款):${entry.path}` })
    }
  }
  return toResult(findings)
}

/**
 * 内核零 diff 校验:当前工作区每个内核文件存在且 SHA256 与冻结值一致。
 * 改核心 → kernel-hash-mismatch;删文件 → kernel-file-missing(事后删文件
 * 制造零 diff 的反证被此条封死)。
 */
export function validateKernelIntegrity(manifest: KernelManifest, repoRoot: string, opts: { packagingCheck?: boolean } = {}): ValidateResult {
  const findings: Finding[] = []
  for (const entry of manifest.entries ?? []) {
    const current = fileSha256(repoRoot, entry.path)
    if (current === null) {
      findings.push({ code: 'kernel-file-missing', detail: `内核文件缺失(冻结面不允许事后删文件):${entry.path}` })
      continue
    }
    if (current !== entry.sha256) {
      findings.push({ code: 'kernel-hash-mismatch', detail: `内核文件被改动:${entry.path}(frozen ${entry.sha256.slice(0, 12)}… → current ${current.slice(0, 12)}…)` })
    }
  }
  if (opts.packagingCheck !== false) {
    const rootPkgAbs = join(repoRoot, 'package.json')
    if (existsSync(rootPkgAbs)) {
      const pkg = JSON.parse(readFileSync(rootPkgAbs, 'utf8')) as { files?: string[] }
      if (Array.isArray(pkg.files) && pkg.files.length > 0) {
        for (const entry of manifest.entries ?? []) {
          const packaged = pkg.files.some((f) => f === entry.path || entry.path.startsWith(f.endsWith('/') ? f : `${f}/`))
          if (!packaged) {
            findings.push({ code: 'kernel-not-packaged', detail: `内核文件不在 npm 包 files 面内(发布产物无法内核一致):${entry.path}` })
          }
        }
      }
    }
  }
  return toResult(findings)
}

/**
 * 功能路径覆盖:同引擎/账本/闸路径各由一个 run-all 套件承载,套件必须真实存在
 * 且其静态 import 闭包包含所声称的内核模块(缺路径覆盖 → 红)。
 */
export function validateFunctionalCoverage(manifest: KernelManifest, repoRoot: string): ValidateResult {
  const findings: Finding[] = []
  const paths = manifest.functionalPaths ?? []
  const entries = manifest.entries ?? []

  const coveredGroups = new Set<string>()
  for (const fp of paths) {
    if (!(KERNEL_GROUPS as readonly string[]).includes(fp.group)) {
      findings.push({ code: 'coverage-group', detail: `功能路径 group 非法:${fp.name}(${JSON.stringify(fp.group)})` })
      continue
    }
    coveredGroups.add(fp.group)
    if (!Number.isInteger(fp.runAllSection) || fp.runAllSection <= 0) {
      findings.push({ code: 'coverage-runall-section', detail: `功能路径缺有效 runAllSection:${fp.name}` })
    }
    if (typeof fp.suite !== 'string' || !fp.suite.startsWith('ts/scripts/') || fp.suite.includes('..')) {
      findings.push({ code: 'coverage-suite-path', detail: `功能路径 suite 必须位于 ts/scripts/:${fp.name}(${JSON.stringify(fp.suite)})` })
      continue
    }
    if (!existsSync(join(repoRoot, fp.suite))) {
      findings.push({ code: 'coverage-suite-missing', detail: `功能路径套件缺失(缺路径覆盖):${fp.suite}` })
      continue
    }
    const closure = importClosure(repoRoot, fp.suite)
    for (const kernelPath of fp.kernelModules ?? []) {
      const entry = entries.find((e) => e.path === kernelPath)
      if (!entry) {
        findings.push({ code: 'coverage-foreign-module', detail: `功能路径声称覆盖的模块不在内核清单:${fp.name} → ${kernelPath}` })
        continue
      }
      if (entry.group !== fp.group) {
        findings.push({ code: 'coverage-group-mismatch', detail: `功能路径 group 与内核条目 group 不一致:${fp.name}(${fp.group}) → ${kernelPath}(${entry.group})` })
      }
      if (!closure.has(kernelPath)) {
        findings.push({ code: 'coverage-suite-not-importing-kernel', detail: `套件静态 import 闭包不含内核模块(路径覆盖断裂):${fp.suite} ↛ ${kernelPath}` })
      }
    }
  }
  for (const entry of entries) {
    if (!coveredGroups.has(entry.group)) {
      findings.push({ code: 'coverage-entry-without-path', detail: `内核条目无任何功能路径覆盖:${entry.path}(group ${entry.group})` })
    }
  }
  return toResult(findings)
}

/** 证据快照 ↔ 当前树 ↔ 冻结清单 三方一致性(requireLoadedCoverage=false 用于离线审计无 trace 面)。 */
export function validateEvidence(
  evidence: KernelEvidence,
  manifest: KernelManifest,
  repoRoot: string,
  opts: { requireLoadedCoverage?: boolean; expectedCandidateSha?: string | null } = {},
): ValidateResult {
  const findings: Finding[] = []
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    findings.push({ code: 'evidence-schema-version', detail: `schemaVersion 必须是 ${EVIDENCE_SCHEMA_VERSION}(当前 ${evidence.schemaVersion})` })
  }
  if (!GIT_SHA_RE.test(evidence.candidateSHA ?? '')) {
    findings.push({ code: 'evidence-candidate-sha', detail: `candidateSHA 必须是 40 位十六进制(当前 ${JSON.stringify(evidence.candidateSHA)})` })
  }
  if (opts.expectedCandidateSha && evidence.candidateSHA !== opts.expectedCandidateSha) {
    findings.push({ code: 'evidence-candidate-sha-mismatch', detail: `candidateSHA 与当前 HEAD 不一致:${evidence.candidateSHA} ≠ ${opts.expectedCandidateSha}` })
  }
  if (evidence.baseSHA !== manifest.baseSHA) {
    findings.push({ code: 'evidence-base-sha-mismatch', detail: `baseSHA 与冻结清单不一致:${evidence.baseSHA} ≠ ${manifest.baseSHA}` })
  }
  if (evidence.manifestRef?.sha256 !== manifestHash(manifest)) {
    findings.push({ code: 'manifest-hash-mismatch', detail: `manifestHash 与冻结清单不符(清单被改动或快照错绑):${JSON.stringify(evidence.manifestRef?.sha256)} ≠ ${manifestHash(manifest).slice(0, 12)}…` })
  }
  if (evidence.evidenceHash !== evidenceHash(evidence)) {
    findings.push({ code: 'evidence-hash-mismatch', detail: `evidenceHash 与快照内容不符(快照被改动):${JSON.stringify(evidence.evidenceHash)} ≠ ${evidenceHash(evidence).slice(0, 12)}…` })
  }

  const integrity = validateKernelIntegrity(manifest, repoRoot)
  findings.push(...integrity.findings)
  const coverage = validateFunctionalCoverage(manifest, repoRoot)
  findings.push(...coverage.findings)

  const manifestPaths = new Set((manifest.entries ?? []).map((e) => e.path))
  const evidenceKernel = evidence.kernel ?? []
  const evidencePaths = new Set(evidenceKernel.map((k) => k.path))
  for (const path of manifestPaths) {
    if (!evidencePaths.has(path)) findings.push({ code: 'evidence-kernel-missing', detail: `证据快照缺内核条目:${path}` })
  }
  for (const item of evidenceKernel) {
    if (!manifestPaths.has(item.path)) {
      findings.push({ code: 'evidence-kernel-foreign', detail: `证据快照出现清单外内核条目:${item.path}` })
      continue
    }
    const entry = (manifest.entries ?? []).find((e) => e.path === item.path) as KernelManifestEntry
    if (item.sha256Frozen !== entry.sha256) {
      findings.push({ code: 'evidence-frozen-sha-mismatch', detail: `证据快照冻结哈希与清单不符:${item.path}` })
    }
    const current = fileSha256(repoRoot, item.path)
    if (current !== null && item.sha256Current !== current) {
      findings.push({ code: 'evidence-current-sha-stale', detail: `证据快照当前哈希与工作区不符(快照未重算):${item.path}` })
    }
  }

  const loaded = new Set(evidence.runtime?.loadedRepoModules ?? [])
  if (opts.requireLoadedCoverage !== false) {
    if (loaded.size === 0) {
      findings.push({ code: 'evidence-trace-empty', detail: '运行模块 trace 为空:缺真实运行 import 证据' })
    }
    for (const entry of manifest.entries ?? []) {
      if (!loaded.has(entry.path)) {
        findings.push({ code: 'kernel-not-loaded', detail: `内核模块未被真实运行加载(替换/绕过内核的形状):${entry.path}` })
      }
    }
  }
  return toResult(findings)
}
