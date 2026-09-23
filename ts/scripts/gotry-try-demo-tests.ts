/**
 * gotry try 离线 deck demo 注册工具/CLI 验收(issue #571,Phase A):
 *
 * 验证 `npx tsx scripts/gotry-try-demo.ts` 一行跑通——输出文件存在 + 内容是有效 deck HTML。
 * 真实执行 demo 脚本(以子进程形式,模拟用户调用),断言:
 *   1. 退出码 0
 *   2. stdout 末行可解析(path / bytes / slides 三段)
 *   3. 落盘 deck HTML 含双面文案(scroll-snap / 证据边界 / 至少一张幻灯页)
 *
 * 全合成 fixture,无用户真实行程。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

let pass = 0
let fail = 0
const failures: string[] = []
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; return }
  fail++
  failures.push(msg)
}

// 从 ts/ 跑子进程,确保 tsx 能解析 tsconfig 的 paths/imports
const tsRoot = new URL('..', import.meta.url).pathname
const tsxBin = new URL('../node_modules/.bin/tsx', import.meta.url).pathname
const result = spawnSync(tsxBin, ['scripts/gotry-try-demo.ts'], {
  cwd: tsRoot,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

ok(result.status === 0, `§1 demo 退出码 0(实测 ${result.status}; stderr=${result.stderr?.trim() ?? ''})`)
const stdout = (result.stdout ?? '').trim()
ok(stdout.length > 0, '§2 demo stdout 非空')

// stdout 末行格式:`<path>\t<bytes>B\t<slides>slides`
const lastLine = stdout.split('\n').pop() ?? ''
const parts = lastLine.split('\t')
ok(parts.length === 3, `§3 stdout 末行三段 tab 分隔(实测 ${parts.length} 段: ${lastLine.slice(0, 120)})`)
const [pathPart, bytesPart, slidesPart] = parts
ok(typeof pathPart === 'string' && pathPart.length > 0 && pathPart.endsWith('.html'), `§4 path 段是 .html 文件路径(${pathPart?.slice(0, 60)})`)
ok(typeof bytesPart === 'string' && /^(\d+)B$/.test(bytesPart), `§5 bytes 段是 <n>B 格式(${bytesPart})`)
ok(typeof slidesPart === 'string' && /^(\d+)slides$/.test(slidesPart), `§6 slides 段是 <n>slides 格式(${slidesPart})`)

if (pathPart) {
  ok(existsSync(pathPart), `§7 落盘文件存在(${pathPart})`)
  const bytes = Number(bytesPart.replace('B', ''))
  const slides = Number(slidesPart.replace('slides', ''))

  const disk = readFileSync(pathPart, 'utf-8')
  const diskBytes = Buffer.byteLength(disk, 'utf8')
  ok(diskBytes === bytes, `§8 落盘字节 == stdout 报告(${bytes} B,磁盘 ${diskBytes} B)`)
  ok(disk.length > 0, '§9 落盘文件非空')

  // deck 形态契约
  ok(disk.includes('html{scroll-snap-type:y proximity}'), '§10 含纯 CSS scroll-snap(零脚本翻页)')
  ok(disk.includes('scroll-snap-align:start'), '§11 scroll-snap align 命中')
  ok(disk.includes('本文档只投影调用方给出的显式行程与已注册事实'), '§12 共享 evidence 边界声明')
  ok(disk.includes('计划面(明示日期与段落)与证据面(已注册事实)分开陈述'), '§13 双面声明')

  // 计数:stdout 报告的幻灯数 == 磁盘里 section.slide 的实际数
  const actualSlides = (disk.match(/<section class="slide/g) ?? []).length
  ok(actualSlides === slides, `§14 stdout 报告 ${slides} 张 = 磁盘实际 ${actualSlides} 张`)

  // 固定 fixture 的内容指纹(确定性)
  ok(disk.includes('合成示例:深圳 → 普吉(Phase A gotry try fixture)'), '§15 含 fixture title')
  ok(disk.includes('SZX') && disk.includes('HKT') && disk.includes('PVG'), '§16 三个机场代码出现在计划段')

  // 空事实列表 = 明确未核验
  ok(disk.includes('共 0 条事实'), '§17 空事实列表显式陈述 0')
  ok(disk.includes('该段没有匹配的已注册事实'), '§18 计划段显式标注未核验')
  ok(!disk.includes('class="badge ok"'), '§19 空事实文档没有任何 ok 徽章')

  // 零脚本 + 无远端依赖
  ok(!disk.includes('<script'), '§20 产物无 script')
  ok(!disk.includes('http://') && !disk.includes('https://'), '§21 产物无远端依赖')

  // 摘要(便于人类阅读)
  console.log(`\nGOTRY TRY DEMO TESTS: 落地路径=${pathPart}`)
}

console.log(`\nGOTRY TRY DEMO TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}