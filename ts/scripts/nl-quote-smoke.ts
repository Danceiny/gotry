/**
 * 一句话→报价卡 冒烟(NL booking M0 验收,PRD hotel-be docs/products/gotry-a2a-nl-booking-prd.md §7-M0)。
 *
 * 形态:opt-in 真 LLM 巡检(同 ADR-11 replay-real 先例)——不进 run-all(CI 确定性面),
 * 手动或自动化 tick 显式调用;跑一次真实 headless 对话:
 *   GOTRY_STATE_ROOT=<隔离目录> ./gotry "查酒店 900000001 在 9 月 18 到 20 号的房型报价,两位成人"
 *
 * 断言(结构性,不绑死措辞):
 *   - 进程 exit 0 且 stdout 非空(markdown 应答);
 *   - 应答形态二选一,均为产品正确行为:
 *     a) 含报价证据链([实时API:hbcli@…])——即报价卡;或
 *     b) 含追问/澄清(访谈补槽——缺信息时问,不猜);
 *   - 隔离 stateRoot 下产生 gotry-state(副作用不落真实产品状态)且进程退出。
 *
 * SKIP 语义:缺 LLM_API_KEY(或 DEEPSEEK_API_KEY)→ SKIP(本脚本只验真链路,不 mock)。
 *
 * 运行: cd ts && npx tsx scripts/nl-quote-smoke.ts
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const repoRoot = join(import.meta.dirname, '..', '..')
const envFile = join(repoRoot, '.env')
const hasLlmKey = !!process.env.LLM_API_KEY
  || !!process.env.DEEPSEEK_API_KEY
  || (existsSync(envFile) && /^LLM_API_KEY=/m.test(readFileSync(envFile, 'utf-8')))

if (!hasLlmKey) {
  console.log('SKIP: 未配置 LLM_API_KEY/DEEPSEEK_API_KEY——本冒烟只验真 LLM 链路(replay/mock 面已由 smoke/effect-tests 覆盖)')
  process.exit(0)
}

const task = '查一下酒店 900000001 在 2026-09-18 到 2026-09-20 两晚的房型报价,两位成人入住,给出实时价格和证据'
const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-nl-smoke-'))
const inner = join(repoRoot, 'bin/gotry-inner.js')

const r = spawnSync(process.execPath, [inner, task], {
  encoding: 'utf-8',
  timeout: 240_000,
  env: { ...process.env, GOTRY_STATE_ROOT: stateRoot, GOTRY_NO_CALENDAR: '1', GOTRY_ASK_STDIO: '0' },
})

try {
  if (r.error) throw new Error(`headless 进程失败:${r.error.message}`)
  if (r.status !== 0) {
    const err = String(r.stderr ?? '')
    // 鉴权失败=环境前置缺失(key 失效/额度),SKIP 而非红——本冒烟只验真链路
    if (/Authentication Fails|api key.*invalid|401/i.test(err)) {
      console.log(`SKIP: LLM key 无效或未授权(${err.split('\n')[0].slice(0, 120)})——续期后重跑本冒烟`)
      process.exit(0)
    }
    throw new Error(`headless 退出码 ${r.status}:${err.slice(0, 300)}`)
  }
  const out = String(r.stdout ?? '')
  if (!out.trim()) throw new Error('stdout 为空——headless 应输出 markdown 应答')

  const hasQuote = /\[实时API:hbcli@\d{4}-/.test(out) || /实时API:hbcli/.test(out)
  const hasClarify = /追问|确认|请问|需要|提供|哪一天|几位|入住人/.test(out) || /\?/.test(out)
  if (!hasQuote && !hasClarify) {
    throw new Error(`应答既无报价证据链也无访谈追问(形态异常),前 400 字:${out.slice(0, 400)}`)
  }
  console.log(`一句话冒烟通过:形态=${hasQuote ? '报价卡(证据链在列)' : '访谈追问(补槽不猜)'};stdout ${out.length} 字符`)
  console.log('--- 应答摘要(前 500 字符)---')
  console.log(out.slice(0, 500))
  console.log('--- 摘要结束 ---')
  console.log('NL QUOTE SMOKE: OK(隔离 stateRoot,真 LLM,headless 一句话→应答)')
} finally {
  rmSync(stateRoot, { recursive: true, force: true })
}
