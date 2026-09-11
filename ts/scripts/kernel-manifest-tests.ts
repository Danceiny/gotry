/**
 * 内核清单冻结 + 运行模块证据 自测(issue #234;全离线,fixture 走临时目录,
 * 唯一真实 trace 在 §7 终检且 import-only 零状态写入)。
 *
 * 反证矩阵(issue #234 验收 3:反证必须失败):
 *   改核心(§5a)/删核心文件(§5b)/替换内核为废弃层(§4f)/未加载核心(§6b)/
 *   错 manifestHash(§6c)/错 evidenceHash(§6d)/错 candidateSHA(§6e)/
 *   缺路径覆盖-套件缺失(§5c)/缺路径覆盖-不再 import 内核(§5d)/
 *   schema 纪律-空依据/坏组/路径逃逸/重复条目(§4)。
 *
 * 运行:cd ts && npx tsx scripts/kernel-manifest-tests.ts
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  evidenceHash,
  importClosure,
  loadKernelManifest,
  MANIFEST_REL,
  manifestHash,
  validateEvidence,
  validateFunctionalCoverage,
  validateKernelIntegrity,
  validateManifestSchema,
  type KernelEvidence,
  type KernelManifest,
} from './kernel-manifest.ts'
import { buildEvidence } from './kernel-manifest-evidence.ts'
import { main as gateMain } from './kernel-manifest-gate.ts'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const KERNEL_FILES = ['ts/src/unified.ts', 'ts/src/model.ts', 'ts/src/state-ledger.ts', 'ts/src/bookable-facts.ts', 'ts/src/artifact-gate.ts']
const SUITE_FILES = ['ts/scripts/unified-tests.ts', 'ts/scripts/ledger-tests.ts', 'ts/scripts/fact-gate-tests.ts']

let section = 0
function head(title: string): void {
  section += 1
  console.log(`--- §${section} ${title}`)
}
function expectFinding(findings: { code: string }[], code: string, label: string): void {
  assert.ok(findings.some((f) => f.code === code), `${label}:期望出现 ${code},实际 [${findings.map((f) => f.code).join(', ')}]`)
}

/** 临时 fixture 仓库:根 package.json(无 files 面) + 内核文件 + 覆盖套件 + 冻结清单,全部从真实仓库逐字节拷贝。 */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotry-kernel-fixture-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gotry-kernel-fixture', private: true }, null, 2) + '\n')
  for (const rel of [...KERNEL_FILES, ...SUITE_FILES]) {
    const target = join(dir, rel)
    cpSync(join(repoRoot, rel), target)
  }
  cpSync(join(repoRoot, MANIFEST_REL), join(dir, MANIFEST_REL))
  return dir
}

function fakeTraceAll(): ReturnType<typeof import('./kernel-manifest.ts').runRuntimeTrace> {
  return { ok: true, nodeVersion: process.versions.node, moduleCount: KERNEL_FILES.length, repoModuleCount: KERNEL_FILES.length, loadedRepoModules: [...KERNEL_FILES].sort() }
}

function baseEvidence(fixture: string, manifest: KernelManifest): KernelEvidence {
  return buildEvidence(manifest, {
    repoRoot: fixture,
    manifestRel: MANIFEST_REL,
    now: '2026-09-11T00:00:00.000Z',
    candidateSHA: manifest.baseSHA,
    trace: fakeTraceAll(),
  })
}

// §1 真实仓库:冻结清单 schema 纪律绿。
head('真实仓库 冻结清单 schema 纪律')
const manifest = loadKernelManifest(repoRoot)
{
  const result = validateManifestSchema(manifest)
  assert.equal(result.ok, true, `真实清单 schema 应绿:${JSON.stringify(result.findings)}`)
  assert.ok(manifest.entries.length >= 5, '内核条目至少 5 项(宁窄勿宽,但必须覆盖引擎/账本/闸)')
  const groups = new Set(manifest.entries.map((e) => e.group))
  for (const g of ['engine', 'ledger', 'gate']) assert.ok(groups.has(g), `清单必须覆盖 group ${g}`)
  // 冻结清单哈希必须确定可复算(规范化 JSON 的哈希绑定)。
  assert.equal(manifestHash(manifest), manifestHash(loadKernelManifest(repoRoot)), 'manifestHash 必须确定')
}

// §2 真实仓库:内核零 diff + 打包面绿。
head('真实仓库 内核零 diff + npm 打包面')
{
  const result = validateKernelIntegrity(manifest, repoRoot)
  assert.equal(result.ok, true, `真实内核零 diff 应绿:${JSON.stringify(result.findings)}`)
}

// §3 真实仓库:功能路径覆盖绿(套件存在 + 静态 import 闭包含内核)。
head('真实仓库 功能路径覆盖(同引擎/账本/闸路径)')
{
  const result = validateFunctionalCoverage(manifest, repoRoot)
  assert.equal(result.ok, true, `真实功能路径覆盖应绿:${JSON.stringify(result.findings)}`)
  for (const fp of manifest.functionalPaths) {
    const closure = importClosure(repoRoot, fp.suite)
    for (const km of fp.kernelModules) assert.ok(closure.has(km), `${fp.suite} 闭包应含 ${km}`)
  }
}

// §4 schema 纪律反证:空依据/坏组/路径逃逸/重复条目/废弃层冒充内核。
head('schema 纪律反证(全部必须红)')
{
  const clone = (overrides: Partial<KernelManifest>): KernelManifest => ({ ...manifest, ...overrides })
  const badGroup = validateManifestSchema(clone({ entries: [{ ...manifest.entries[0], group: 'misc' }] }))
  expectFinding(badGroup.findings, 'manifest-group', '坏 group')

  const noBasis = validateManifestSchema(clone({ entries: [{ ...manifest.entries[0], basis: '' }] }))
  expectFinding(noBasis.findings, 'manifest-basis-missing', '空依据')

  const noRationale = validateManifestSchema(clone({ entries: [{ ...manifest.entries[0], rationale: ' ' }] }))
  expectFinding(noRationale.findings, 'manifest-rationale-missing', '空 rationale')

  const escapePath = validateManifestSchema(clone({ entries: [{ ...manifest.entries[0], path: '../outside.ts' }] }))
  expectFinding(escapePath.findings, 'manifest-path-shape', '路径逃逸')

  const dup = validateManifestSchema(clone({ entries: [manifest.entries[0], { ...manifest.entries[0] }] }))
  expectFinding(dup.findings, 'manifest-duplicate-path', '重复条目')

  // 废弃兼容层(journey.ts)冒充内核:清单层面直接拒绝。
  const deprecated = validateManifestSchema(clone({ entries: [{ ...manifest.entries[0], path: 'ts/src/journey.ts' }] }))
  expectFinding(deprecated.findings, 'manifest-forbidden-path', '废弃层冒充内核')

  const empty = validateManifestSchema(clone({ entries: [] }))
  expectFinding(empty.findings, 'manifest-empty', '空清单')
}

// §5 fixture 内核零 diff + 功能路径反证(红→绿)。
head('fixture 内核零 diff / 功能路径反证(红)')
{
  const fixture = makeFixtureRepo()
  try {
    const fx = loadKernelManifest(fixture, MANIFEST_REL)

    // 绿基线:逐字节拷贝的 fixture 必须零 diff、覆盖成立。
    assert.equal(validateKernelIntegrity(fx, fixture).ok, true, 'fixture 基线应绿')
    assert.equal(validateFunctionalCoverage(fx, fixture).ok, true, 'fixture 覆盖基线应绿')

    // (a) 改核心:哈希漂移必须红。
    writeFileSync(join(fixture, 'ts/src/model.ts'), readFileSync(join(fixture, 'ts/src/model.ts'), 'utf8') + '\n// 反证:核心被改动\n')
    const tampered = validateKernelIntegrity(fx, fixture)
    assert.equal(tampered.ok, false, '改核心必须红')
    expectFinding(tampered.findings, 'kernel-hash-mismatch', '改核心')

    // (b) 删核心文件:事后删文件制造零 diff 被封死。
    rmSync(join(fixture, 'ts/src/artifact-gate.ts'))
    const missing = validateKernelIntegrity(fx, fixture)
    expectFinding(missing.findings, 'kernel-file-missing', '删核心文件')

    // (c) 缺路径覆盖:覆盖套件缺失。
    const fxCov = loadKernelManifest(fixture, MANIFEST_REL)
    rmSync(join(fixture, 'ts/scripts/ledger-tests.ts'))
    const cov = validateFunctionalCoverage(fxCov, fixture)
    assert.equal(cov.ok, false, '套件缺失必须红')
    expectFinding(cov.findings, 'coverage-suite-missing', '套件缺失')

    // (d) 缺路径覆盖:套件不再 import 内核模块。
    writeFileSync(join(fixture, 'ts/scripts/fact-gate-tests.ts'), "import { ok } from 'node:assert/strict'\nconsole.log(ok)\n")
    const cov2 = validateFunctionalCoverage(fxCov, fixture)
    assert.equal(cov2.ok, false, '套件不再 import 内核必须红')
    expectFinding(cov2.findings, 'coverage-suite-not-importing-kernel', '覆盖断裂')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

// §6 证据快照哈希绑定 + 加载覆盖反证(红)。
head('证据快照哈希绑定 / 未加载核心 反证(红)')
{
  const fixture = makeFixtureRepo()
  try {
    const fx = loadKernelManifest(fixture, MANIFEST_REL)

    // 绿基线:完整证据(全加载)必须绿。
    const good = baseEvidence(fixture, fx)
    const goodResult = validateEvidence(good, fx, fixture, { requireLoadedCoverage: true, expectedCandidateSha: fx.baseSHA })
    assert.equal(goodResult.ok, true, `完整证据基线应绿:${JSON.stringify(goodResult.findings)}`)
    assert.equal(evidenceHash(good), good.evidenceHash, 'evidenceHash 必须自洽')

    // (a) 快照缺内核条目/出现清单外条目。
    const missingEntry = { ...good, kernel: good.kernel.slice(1) } as KernelEvidence
    missingEntry.evidenceHash = evidenceHash(missingEntry)
    const r0 = validateEvidence(missingEntry, fx, fixture, { requireLoadedCoverage: true })
    expectFinding(r0.findings, 'evidence-kernel-missing', '快照缺内核条目')

    // (b) 未加载核心:trace 缺一个内核模块必须红(issue #234「未加载核心」反证)。
    const partialTrace = { ...fakeTraceAll(), loadedRepoModules: fakeTraceAll().loadedRepoModules.filter((p) => p !== 'ts/src/state-ledger.ts') }
    const partial = buildEvidence(fx, { repoRoot: fixture, manifestRel: MANIFEST_REL, now: '2026-09-11T00:00:00.000Z', candidateSHA: fx.baseSHA, trace: partialTrace })
    const r1 = validateEvidence(partial, fx, fixture, { requireLoadedCoverage: true })
    assert.equal(r1.ok, false, '未加载核心必须红')
    expectFinding(r1.findings, 'kernel-not-loaded', '未加载核心')

    // (c) 错 manifestHash(冻结清单被改动/快照错绑)。
    const wrongManifestHash = { ...good, manifestRef: { ...good.manifestRef, sha256: '0'.repeat(64) } } as KernelEvidence
    wrongManifestHash.evidenceHash = evidenceHash(wrongManifestHash)
    const r2 = validateEvidence(wrongManifestHash, fx, fixture, { requireLoadedCoverage: true })
    expectFinding(r2.findings, 'manifest-hash-mismatch', '错 manifestHash')

    // (d) 快照内容被改动(evidenceHash 不再自洽)。
    const tamperedSnapshot = { ...good, generatedAt: '2030-01-01T00:00:00.000Z' } as KernelEvidence
    const r3 = validateEvidence(tamperedSnapshot, fx, fixture, { requireLoadedCoverage: true })
    expectFinding(r3.findings, 'evidence-hash-mismatch', '快照被改动')

    // (e) 错 candidateSHA(绑定面)。
    const r4 = validateEvidence(good, fx, fixture, { requireLoadedCoverage: true, expectedCandidateSha: 'a'.repeat(40) })
    expectFinding(r4.findings, 'evidence-candidate-sha-mismatch', '错 candidateSHA')

    // (f) 空 trace 冒充运行证据。
    const emptyTrace = buildEvidence(fx, { repoRoot: fixture, manifestRel: MANIFEST_REL, now: '2026-09-11T00:00:00.000Z', candidateSHA: fx.baseSHA, trace: { ok: true, nodeVersion: process.versions.node, moduleCount: 0, repoModuleCount: 0, loadedRepoModules: [] } })
    const r5 = validateEvidence(emptyTrace, fx, fixture, { requireLoadedCoverage: true })
    expectFinding(r5.findings, 'evidence-trace-empty', '空 trace')
    expectFinding(r5.findings, 'kernel-not-loaded', '空 trace 必然未加载')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

// §7 真实端到端:闸默认模式(真实运行 trace)→ 快照 → 审计 → 篡改快照必红。
head('真实端到端 闸 + 证据快照审计')
{
  const outSnapshot = join(mkdtempSync(join(tmpdir(), 'gotry-kernel-e2e-')), 'evidence.json')
  try {
    const exitGen = gateMain(['--out', outSnapshot])
    assert.equal(exitGen, 0, `闸默认模式(真实 trace)应绿且 exit 0,得到 ${exitGen}`)
    assert.ok(existsSync(outSnapshot), '闸应写出证据快照')

    const snapshot = JSON.parse(readFileSync(outSnapshot, 'utf8')) as KernelEvidence
    assert.equal(snapshot.schemaVersion, 'gotry_kernel_evidence_v1')
    assert.equal(snapshot.kernel.length, manifest.entries.length, '快照内核条目数与清单一致')
    for (const k of snapshot.kernel) assert.equal(k.loadedInTrace, true, `真实运行应加载内核:${k.path}`)
    assert.ok(snapshot.runtime.moduleCount > 0, 'trace 必须记录到真实模块')

    const exitVerify = gateMain(['--verify', outSnapshot])
    assert.equal(exitVerify, 0, `快照审计应绿,得到 ${exitVerify}`)

    // 篡改快照(错 SHA 面)必须红:exit 1。
    const tampered = { ...snapshot, kernel: snapshot.kernel.map((k, i) => (i === 0 ? { ...k, sha256Current: '0'.repeat(64) } : k)) } as KernelEvidence
    const tamperedPath = outSnapshot.replace(/evidence\.json$/, 'evidence-tampered.json')
    writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2) + '\n')
    const exitTampered = gateMain(['--verify', tamperedPath])
    assert.equal(exitTampered, 1, `篡改快照必须红,得到 ${exitTampered}`)

    // manifestHash 外部钉值校验:对偶面。
    assert.equal(gateMain(['--skip-trace', '--manifest-hash', manifestHash(manifest)]), 0, 'manifestHash 钉值匹配应绿')
    assert.equal(gateMain(['--skip-trace', '--manifest-hash', 'f'.repeat(64)]), 1, 'manifestHash 钉值不符必须红')
  } finally {
    rmSync(outSnapshot, { recursive: true, force: true })
  }
}

console.log(`KERNEL MANIFEST TESTS: GREEN(§1–§${section};反证矩阵 §4/§5/§6 全部按预期红,§7 真实运行 trace 端到端绿)`)
