#!/usr/bin/env node
/**
 * gotry try 离线 deck demo(issue #571,Phase A):免安装、免 LLM key、免 dsh 主机,
 * 直接 `npx tsx scripts/gotry-try-demo.ts` 就能渲染一个 deck HTML 到 tmpdir 并打印路径。
 *
 * 设计目标(研究文档 §3 决策点 P5):给 M3 种子用户漏斗一个「零配置即可看 deck」的入口。
 * 不动内核、不注册 dsh 工具、不激活运行时——纯 renderer 调用 + 一次落盘。
 *
 * 夹具内联、合成数据、无供应商证据;产物是「用户排期意图 + 0 条事实」的明确未核验计划样例。
 *
 * 运行(在 ts/ 下):
 *   npx tsx scripts/gotry-try-demo.ts
 * 退出码 0 + stdout 一行:deck 路径 + 字节数 + 幻灯页数。
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderItineraryDeck } from '../src/itinerary-deck.ts'

const FIXTURE = {
  title: '合成示例:深圳 → 普吉(Phase A gotry try fixture)',
  itinerary: {
    trip_start: '2027-07-16',
    trip_end: '2027-07-21',
    stays: [{ place: '普吉岛', check_in: '2027-07-17', check_out: '2027-07-20' }],
    od_segments: [
      { from: '广州南', to: '深圳北', date: '2027-07-16', mode: 'rail', legs: 1 },
      { from: 'SZX', to: 'HKT', date: '2027-07-17', mode: 'flight', legs: 1 },
      { from: 'HKT', to: 'PVG', date: '2027-07-20', mode: 'flight', legs: 1 },
    ],
  },
  facts: [],
}

function main(): void {
  const result = renderItineraryDeck(FIXTURE)
  if (!result.ok) {
    console.error('FAIL: 渲染器拒绝 fixture(这是合成数据,不应该失败):')
    for (const e of result.errors) console.error('  - ' + e)
    process.exit(1)
  }
  const home = mkdtempSync(join(tmpdir(), 'gotry-try-'))
  const path = join(home, 'gotry-try-deck.html')
  writeFileSync(path, result.html, 'utf-8')
  const bytes = Buffer.byteLength(result.html, 'utf8')
  const slideCount = (result.html.match(/<section class="slide/g) ?? []).length
  // 单行输出便于机器消费(human 友好:stdout 末尾换行)
  console.log(`${path}\t${bytes}B\t${slideCount}slides`)
}

main()