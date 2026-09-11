/**
 * 春节锚点表生成器(issue #274,D-9 清偿:手抄常量表已被否决——「换个日子的同款债务」)。
 *
 * 用 lunar-typescript(devDependency,MIT,零传递依赖,不进 runtime bundle)在构建期把
 * 正月初一锚点机械生成到 SPRING_FESTIVAL 表,回写 ../src/time-anchor.ts 的生成块
 * ([gen:lunar-anchors:begin/end] 标记之间);首次运行会把旧手抄表原位迁移为生成块。
 * 扩表/换库 = 重跑本命令;表未变则为无 diff 幂等(生成时间只在表真变时刷新)。
 *
 * 运行(在 ts/ 下):
 *   npx tsx scripts/gen-lunar-anchors.ts           # 生成并回写(全离线,不访问网络)
 *   npx tsx scripts/gen-lunar-anchors.ts --check   # 只比对不写:表/库版本漂移即非零退出
 *                                                  # (挂 run-all-tests.sh §58 漂移闸)
 *
 * 交叉验证不在这里做:2026-2031 旧表 6 条 + 港天文台 2032-2040 核实 9 条已固化为
 * time-eval §7 的双 oracle 断言(红→绿:生成前 oracle B 必红)。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Lunar } from 'lunar-typescript'

const TARGET = join(import.meta.dirname, '..', 'src', 'time-anchor.ts')
const BEGIN = '// [gen:lunar-anchors:begin] 生成块起点——手改会被下次生成覆盖'
const END = '// [gen:lunar-anchors:end]'
const START_YEAR = 2026
const END_YEAR = 2099

/** 正月初一 → 公历 YYYY-MM-DD(lunar-typescript:农历年 y 正月初一 的 Solar)。 */
function springFestivalOf(lunarYear: number): string {
  return Lunar.fromYmd(lunarYear, 1, 1).getSolar().toYmd()
}

function buildTable(): Record<number, string> {
  const table: Record<number, string> = {}
  for (let y = START_YEAR; y <= END_YEAR; y++) table[y] = springFestivalOf(y)
  return table
}

function libVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'node_modules', 'lunar-typescript', 'package.json'), 'utf-8')) as { version: string }
  return pkg.version
}

function renderBlock(table: Record<number, string>, generatedAt: string): string {
  const entries = Object.keys(table).map(y => `  ${y}: '${table[Number(y)]}',`).join('\n')
  return `/**
 * 春节锚点表(正月初一;仅此节日漂移大,故表驱动;元旦/国庆固定月日按「下一次发生」算)。
 * 本块由构建期生成器机械生成,禁止手改(issue #274:手抄常量表=换个日子的同款债务,已否决)。
 * provenance:lunar-typescript@${libVersion()}(MIT,零传递依赖,devDependency 不进 runtime)· 生成时间 ${generatedAt}
 * 命令:cd ts && npx tsx scripts/gen-lunar-anchors.ts(扩表/换库=重跑;--check=漂移闸,run-all §58)
 * 交叉验证:2026-2031 旧表 6 条 + 港天文台 2032-2040 核实 9 条逐条一致(time-eval §7 双 oracle)。
 * 到期守卫:springFestivalHorizonOk——最晚锚点年份 < 当前年+3 测试即红(临近耗尽先红于静默缺失)。
 */
${BEGIN}
export const SPRING_FESTIVAL: Record<number, string> = {
${entries}
}
${END}`
}

/** 提取文件中现有生成块;无标记则匹配旧手抄声明(含其上一行单行 doc 注释)原位迁移。 */
function extractExisting(src: string): { block: string | null; replaceFrom: (block: string) => string } {
  const b = src.indexOf(BEGIN)
  const e = src.indexOf(END)
  if (b !== -1 && e !== -1) {
    const end = e + END.length
    return { block: src.slice(b, end), replaceFrom: next => src.slice(0, b) + next + src.slice(end) }
  }
  const legacy = src.match(/(?:\/\*\*[^\n]*\*\/\n)?(?:export )?const SPRING_FESTIVAL: Record<number, string> = \{\n(?:  \d{4}: '\d{4}-\d{2}-\d{2}',\n)+\}/)
  if (!legacy) throw new Error('未找到 SPRING_FESTIVAL 表(既无生成标记也无手抄声明)')
  const m = legacy[0]
  return { block: null, replaceFrom: next => src.replace(m, next) }
}

/** 从块文本解析 年→日期 映射(--check 与幂等判定用,生成时间/库版本不参与比较)。 */
function parseTable(block: string | null): Record<number, string> {
  const table: Record<number, string> = {}
  if (!block) return table
  for (const m of block.matchAll(/(\d{4}): '(\d{4}-\d{2}-\d{2})'/g)) table[Number(m[1])] = m[2]
  return table
}

function tablesEqual(a: Record<number, string>, b: Record<number, string>): boolean {
  const ka = Object.keys(a); const kb = Object.keys(b)
  return ka.length === kb.length && ka.every(k => a[Number(k)] === b[Number(k)])
}

const check = process.argv.includes('--check')
const table = buildTable()
const src = readFileSync(TARGET, 'utf-8')
const { block, replaceFrom } = extractExisting(src)

if (block && tablesEqual(parseTable(block), table)) {
  console.log(`lunar-anchors:表已是最新(${START_YEAR}-${END_YEAR},共 ${Object.keys(table).length} 条),无 diff`)
  process.exit(0)
}

const next = renderBlock(table, new Date().toISOString())
if (check) {
  console.error(`lunar-anchors:漂移!${TARGET} 与生成器输出不一致(表内容或生成块缺失),应重跑:cd ts && npx tsx scripts/gen-lunar-anchors.ts`)
  if (block) {
    const have = parseTable(block); const want = table
    for (let y = Math.min(START_YEAR, ...Object.keys(have).map(Number)); y <= END_YEAR; y++) {
      if (have[y] !== want[y]) console.error(`  ${y}: 文件=${have[y] ?? '(缺)'} 生成=${want[y] ?? '(缺)'}`)
    }
  }
  process.exit(1)
}

writeFileSync(TARGET, replaceFrom(next))
const diffYears = Object.keys(table).filter(y => !block || parseTable(block)[Number(y)] !== table[Number(y)])
console.log(`lunar-anchors:已回写 ${TARGET}(覆盖 ${START_YEAR}-${END_YEAR},共 ${Object.keys(table).length} 条;本次新增/变更 ${diffYears.length} 条)`)
