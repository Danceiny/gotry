/**
 * D-30 普通模型 canary 运行器(issue #112 验收,tool-orchestration-design §4⑥)。
 *
 * 量什么:普通 LLM 面对投影后的工具 JSON Schema,能否**一次成型**产出合法参数——
 * 这是 typed 参数契约迁移(D-30)要解决的核心问题(blob 时代强弱模型差距全部
 * 暴露在「猜参数形状」上)。
 *
 * 怎么量:真实 LLM(env 三件套 LLM_API_KEY/LLM_BASE_URL/LLM_MODEL,或仓库 .env)
 * + 工具投影 schema(defineTool 后的 parameters,与模型所见完全一致)+ tool_choice
 * 强制单工具 → 模型出参 → `validateJsonSchemaValue`(与 dsh defineTool execute 前
 * 同款校验)→ 违例为零 = 该例一次成型。
 *
 * 不执行工具:零检索副作用、零站点请求——canary 只量参数形态,不量业务结果。
 *
 * 达标线:工具调用一次成型率 ≥90%(10 例容 1 失);语义正确性(城市/日期/kind)
 * 作为二级信号同报,不进门。
 *
 * 运行(在仓根或 ts/):LLM 三件套已配 → npx tsx ts/scripts/typed-contract-canary.ts
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// --- LLM 三件套:env 优先,回退仓库 .env(只取值,永不回显) ---
function loadEnvTriple(): { key: string; base: string; model: string } {
  const env = process.env
  let key = env.LLM_API_KEY ?? ''
  let base = env.LLM_BASE_URL ?? ''
  let model = env.LLM_MODEL ?? ''
  const envFile = join(ROOT, '.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (!m) continue
      const [, k, v] = m
      if (k === 'LLM_API_KEY' && !key) key = v.trim()
      if (k === 'LLM_BASE_URL' && !base) base = v.trim()
      if (k === 'LLM_MODEL' && !model) model = v.trim()
    }
  }
  assert.ok(key && base && model, 'LLM_API_KEY/LLM_BASE_URL/LLM_MODEL 必须已配(env 或 .env)')
  return { key, base, model }
}

// --- 捕获插件注册表(隔离 stateRoot:canary 不写任何共享状态;sessionAccess=off 免审批) ---
const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-canary-state-'))
const registered: Array<{ name: string; description: string; parameters: unknown; execute: (a: never, e: never) => Promise<unknown> }> = []
const ctx = {
  tools: { register: (t: unknown) => registered.push(t as never) },
  systemPrompt: { variable: () => () => '' },
  on: () => () => {},
} as unknown as Context
apply(ctx, { stateRoot, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'off' } as never)
const byName = (n: string): { name: string; description: string; parameters: unknown; execute: (a: never, e: never) => Promise<unknown> } => {
  const t = registered.find(x => x.name === n)
  assert.ok(t, `工具 ${n} 应已注册`)
  return t
}

// --- canary 用例:prompt → 期望工具(强制 tool_choice;量参数成型,不量路由) ---
interface Case { label: string; tool: string; prompt: string }
const CASES: Case[] = [
  { label: '机·票(城市对+日期)', tool: 'gotry_flyai_search', prompt: '帮我查一下 10 月 1 日从上海飞丽江的机票' },
  { label: '火车票', tool: 'gotry_flyai_search', prompt: '10 月 1 日上海到昆明的火车票帮我查一下' },
  { label: '酒店(带档期)', tool: 'gotry_flyai_search', prompt: '查一下大理 10 月 1 日入住、10 月 3 日退房的酒店' },
  { label: '酒店(摸底,无档期)', tool: 'gotry_flyai_search', prompt: '先看看大理有哪些酒店' },
  { label: '天气预报', tool: 'gotry_weather_check', prompt: '大理这几天天气怎么样' },
  { label: '酒店实时源(hbcli)', tool: 'gotry_hotel_search', prompt: '查一下大理的酒店,入住下周五,住三晚' },
  { label: '会话面机票(登录态)', tool: 'gotry_session_search', prompt: '用我的携程账号查 10 月 1 日上海到丽江的机票' },
  { label: '目的地候选库', tool: 'gotry_anything_search', prompt: '大连在你们的目的地库里吗?帮我查一下' },
  { label: 'GitHub 搜索', tool: 'gotry_github_search', prompt: '在 GitHub 上搜一下 agent-reach 这个项目' },
  { label: '网页读取', tool: 'gotry_web_search', prompt: '帮我读一下 https://example.com 这个页面的内容' },
]

// --- 真实 LLM 调用(OpenAI 兼容 chat/completions;强制单工具) ---
async function callLlm(cfg: { key: string; base: string; model: string }, c: Case): Promise<{ args: unknown; raw: string }> {
  const tool = byName(c.tool)
  const url = `${cfg.base.replace(/\/+$/, '')}/chat/completions`
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: '你是 GoTry 旅行助手。需要查数据时必须调用提供的工具,参数从用户话里取,不要编造。' },
      { role: 'user', content: c.prompt },
    ],
    tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
    tool_choice: { type: 'function', function: { name: tool.name } },
    temperature: 0,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const bodyText = await res.text()
  assert.equal(res.status, 200, `LLM HTTP ${res.status}: ${bodyText.slice(0, 200)}`)
  const j = JSON.parse(bodyText) as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> }
  const argsRaw = j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments
  assert.ok(argsRaw, '模型未返回工具调用参数')
  return { args: JSON.parse(argsRaw) as unknown, raw: argsRaw }
}

async function main() {
  const cfg = loadEnvTriple()
  console.log(`typed-contract canary:model=${cfg.model} 已配(值不回显);用例 ${CASES.length} 条,达标线 ≥90% 一次成型\n`)
  let pass = 0
  const failures: string[] = []
  for (const c of CASES) {
    const tool = byName(c.tool)
    process.stdout.write(`- ${c.label} → ${c.tool} … `)
    try {
      const { args } = await callLlm(cfg, c)
      const violations = validateJsonSchemaValue(tool.parameters as never, args)
      if (violations.length === 0) {
        pass++
        console.log(`PASS 一次成型 ${JSON.stringify(args).slice(0, 120)}`)
      } else {
        failures.push(`${c.label}: schema 违例 ${violations.join(';')}`)
        console.log(`FAIL schema 违例: ${violations.join(';').slice(0, 160)}`)
      }
    } catch (e) {
      failures.push(`${c.label}: ${(e as Error).message.slice(0, 160)}`)
      console.log(`FAIL ${(e as Error).message.slice(0, 140)}`)
    }
  }
  const rate = Math.round((pass / CASES.length) * 100)
  console.log(`\n一次成型率:${pass}/${CASES.length} = ${rate}%(达标线 90%)`)
  if (failures.length) console.log('失败明细:\n' + failures.map(f => `  - ${f}`).join('\n'))
  if (rate < 90) {
    console.error('TYPED CONTRACT CANARY FAIL(不达标不合入)')
    process.exit(1)
  }
  console.log('TYPED CONTRACT CANARY OK')
}

await main()
