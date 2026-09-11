/**
 * G5 内部差旅桥机械闸(issue #348;governance/复用矩阵纪律的机械化,不是新政策)。
 *
 * 背景:G5 = 「内部差旅工具桥(T 系统侧,脱敏)」的创始人审批门,当前关闭
 * (docs/gotry-master-outline.md 决策门表 + #348)。复用矩阵纪律:内部资产只能
 * bridge/reference,桥接前必须有创始人显式授权。本脚本把该约束落成机械检查:
 *   1. 扫描全部 git-tracked 文件(排除第三方/生成物/创始人私有 state)中
 *      「G5 桥接引用」形状的标识符/配置/文案;
 *   2. 命中时要求 docs/g5-authorization-ledger.md 存在覆盖该路径的 GRANT 条目
 *      (含 issue/决策链接);没有 → exit 1,输出可操作指引。
 *
 * 边界(诚实声明):本闸只证明「无授权记录 → 桥接引用不落地」;
 * GRANT 条目只能由创始人侧维护,agent 自助授权不被本闸承认(作者身份靠
 * git review,机械不可证)。真实 G5 授权本身仍是创始人决策(#348)。
 *
 * 命名面豁免(NAMING_SURFACES):门定义/授权台账/guard 自身必须能「提到」
 * 这条关闭中的 lane,否则 tracker 无法描述自己的门。除此之外一律要求 GRANT。
 *
 * 用法:cd ts && npx tsx scripts/g5-guard.ts [--root <dir>]
 * 退出码:0 = 通过;1 = 存在未授权引用;2 = 闸自身无法运行(缺台账/git 失败)。
 * 自测:cd ts && npx tsx scripts/g5-guard-tests.ts(全离线,临时 fixture)。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LEDGER_REL = 'docs/g5-authorization-ledger.md'
export const ISSUE_348_URL = 'https://github.com/Danceiny/gotry/issues/348'

/**
 * 「G5 桥接引用」的机械形状:标识符/配置键/插件名/中英文邻接短语。
 * 边界用显式 lookaround 而非 `\b`:下划线是 word char,`\b` 会漏掉
 * snake_case(G5_BRIDGE_*)与 camelCase(G5Bridge)相邻形状。
 */
export const G5_BRIDGE_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'g5-adjacent-bridge-identifier', regex: /(?<![a-z0-9])g5[\s_-]{0,2}(bridge|bridged|bridging|adapter|adaptor|mcp)/i },
  { name: 'bridge-adjacent-g5-identifier', regex: /(?<![a-z0-9])(bridge|bridged|bridging|adapter|adaptor)[\s_-]{0,2}g5(?![0-9])/i },
  { name: 'internal-travel-mcp-plugin-id', regex: /\bcapability-travel-mcp\b/i },
  { name: 't-system-bridge-identifier', regex: /(?<![a-z0-9])t[-_ ]?system[\s_-]{0,2}(bridge|bridged|bridging|adapter|adaptor|mcp)/i },
  { name: 'bridge-adjacent-t-system', regex: /(?<![a-z0-9])(bridge|bridged|bridging|adapter|adaptor)[\s_-]{0,2}t[-_ ]?system/i },
  { name: 'chinese-g5-bridge-adjacency', regex: /g5\s*桥|桥\s*g5/i },
  { name: 'chinese-t-system-bridge-adjacency', regex: /T\s*系统\s*(桥|适配|接入)|(桥接|接入)\s*T\s*系统/ },
]

/**
 * 命名面豁免:这些文件被允许「提到」G5 lane(定义它/授权它/检测它),
 * 它们不是授权——真实桥接落在其它任何文件都仍需台账 GRANT。
 *  - master-outline 对:G5 门定义 + 复用矩阵 T 系统行(tracker 本体);
 *  - 授权台账对:授权面自身;
 *  - guard + 自测:检测器必须含有自己的检测串。
 */
export const NAMING_SURFACES: ReadonlySet<string> = new Set([
  'docs/gotry-master-outline.md',
  'docs/gotry-master-outline.zh-CN.md',
  'docs/g5-authorization-ledger.md',
  'docs/g5-authorization-ledger.zh-CN.md',
  'ts/scripts/g5-guard.ts',
  'ts/scripts/g5-guard-tests.ts',
])

/** 排除段:第三方闭包/生成物/创始人私有产品数据(只读红线目录也不扫)。 */
const EXCLUDED_SEGMENTS = ['node_modules', 'vendor', 'dist', '.git', 'dsh-runtime', 'gotry-state']
const LOCKFILE_BASENAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'uv.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'])
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.mov', '.zip', '.gz', '.tgz', '.bz2', '.7z', '.pdf', '.wasm', '.node', '.dylib', '.so', '.bin', '.icns',
])

export function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split('/')
  if (segments.some((s) => EXCLUDED_SEGMENTS.includes(s))) return true
  const base = segments[segments.length - 1]
  if (LOCKFILE_BASENAMES.has(base)) return true
  const dot = base.lastIndexOf('.')
  if (dot >= 0 && BINARY_EXTENSIONS.has(base.slice(dot).toLowerCase())) return true
  return false
}

export type G5Hit = { path: string; line: number; pattern: string; text: string }

/** 单文件内容扫描:返回全部命中行(文件级,供 collectHits 逐文件调用)。 */
export function scanContent(relPath: string, content: string): G5Hit[] {
  const hits: G5Hit[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (const { name, regex } of G5_BRIDGE_PATTERNS) {
      if (regex.test(line)) {
        hits.push({ path: relPath, line: i + 1, pattern: name, text: line.trim().slice(0, 160) })
        break // 一行一次足矣,避免同 pattern 行内重复刷屏
      }
    }
  }
  return hits
}

export type Grant = { glob: string; description: string }
export type LedgerParse = { grants: Grant[]; malformed: number }

/** 台账 GRANT 行:`- GRANT: <glob> — <说明,必须含 issue/决策链接>`;code fence 内的行(模板/示例)不算数。 */
export function parseGrants(ledgerText: string): LedgerParse {
  const grants: Grant[] = []
  let malformed = 0
  let inFence = false
  for (const rawLine of ledgerText.split('\n')) {
    if (/^`{3,}/.test(rawLine.trim())) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = rawLine.match(/^-\s*GRANT:\s*(\S+)\s+—\s+(.+)$/)
    if (!match) continue
    // 无 issue/决策链接的 GRANT 视为不成立(fail closed),单独计数以便报错指引
    if (!/#\d+|https?:\/\//.test(match[2])) {
      malformed += 1
      continue
    }
    grants.push({ glob: match[1], description: match[2].trim() })
  }
  return { grants, malformed }
}

/** glob → 路径正则:`**` 跨段,`*` 单段内,`?` 单字符。 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export function grantCovers(grant: Grant, relPath: string): boolean {
  return globToRegExp(grant.glob).test(relPath)
}

function listTrackedFiles(root: string): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' })
  if (result.error || result.status !== 0) {
    console.error(`G5 GUARD: 无法枚举 git-tracked 文件(需要 git 仓库): ${result.error?.message ?? result.stderr?.toString().trim()}`)
    process.exit(2)
  }
  return result.stdout.toString().split('\0').filter(Boolean)
}

function main(): void {
  const args = process.argv.slice(2)
  const rootIndex = args.indexOf('--root')
  const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

  const ledgerPath = join(root, LEDGER_REL)
  if (!existsSync(ledgerPath)) {
    console.error(`G5 GUARD: 授权台账不存在: ${LEDGER_REL}(闸配置错误,exit 2;台账由创始人侧维护)`)
    process.exit(2)
  }
  const ledger = parseGrants(readFileSync(ledgerPath, 'utf8'))

  const hits: G5Hit[] = []
  let scanned = 0
  for (const relPath of listTrackedFiles(root)) {
    if (isExcludedPath(relPath)) continue
    if (NAMING_SURFACES.has(relPath)) continue
    const abs = join(root, relPath)
    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue // 不可读(权限/符号链接悬空):跳过,不属于闸的裁决面
    }
    if (content.includes('\0')) continue // 二进制内容:跳过
    scanned += 1
    hits.push(...scanContent(relPath, content))
  }

  if (hits.length === 0) {
    console.log(`G5 GUARD: OK — ${scanned} 个 tracked 文件中无未授权 G5 桥引用;台账 GRANT: ${ledger.grants.length}${ledger.malformed ? `(另有 ${ledger.malformed} 条缺 issue/决策链接的 GRANT 被拒)` : ''}`)
    process.exit(0)
  }

  const uncovered = hits.filter((hit) => !ledger.grants.some((grant) => grantCovers(grant, hit.path)))
  for (const hit of hits) {
    const covered = ledger.grants.some((grant) => grantCovers(grant, hit.path))
    console.error(`  ${hit.path}:${hit.line} [${hit.pattern}]${covered ? ' (已授权)' : ''} ${hit.text}`)
  }
  if (uncovered.length === 0) {
    console.log(`G5 GUARD: OK — ${hits.length} 处 G5 桥引用均被台账 GRANT 覆盖`)
    process.exit(0)
  }
  console.error(`G5 GUARD: FAIL — ${uncovered.length} 处未授权的 G5 内部差旅桥引用(共扫描 ${scanned} 个文件):`)
  console.error('G5 门当前关闭:桥接内部旅行系统(T 系统)前必须获得创始人显式授权,可执行其一:')
  console.error(`  1. 由创始人在 ${LEDGER_REL} 增加覆盖上述路径的 GRANT 条目(含 issue/决策链接;仅创始人侧维护,agent 不得自助授权);`)
  console.error('  2. 或移除引用,保持外部供应商路径(公共 MIT hotelbyte-cli 进程桥)。')
  console.error(`Tracker: ${ISSUE_348_URL}(复用矩阵:内部资产只能 bridge/reference,禁止代码/schema 搬运)`)
  process.exit(1)
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
