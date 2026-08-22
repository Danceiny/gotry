/**
 * GoTry dsh 插件(gotry-tools):把 GoTry 的领域能力注册为 dsh 工具。
 *
 * 对应总纲 3.2 插件清单中的三个最小集:
 *   - gotry_feasibility_check   可行性引擎(门到门全成本,bridge → Python Z3)
 *   - gotry_motivation_save     动机画像落盘(为什么出发;B2B 接缝的契约对象)
 *   - gotry_wish_pool_add       「下一次出发」清单(憧憬不被拒绝)
 *
 * 插件形态遵循 dsh 约定(name/inject/Config/apply + ctx.tools.register(defineTool(...))),
 * 对齐已发布 @deepseek-ai/dsh-tools@0.0.1-rc.1 的契约:
 * render 位于 output 对象内,参数属性是 ValueSchemaSpec(支持 type:'json')。
 *
 * @module @gotry/plugin
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callFeasibilityEngine, ensureStateDir, readJson, recordLatency, writeJson } from './bridge.ts'

export const name = 'gotry-tools'
export const inject = ['tools']

export interface Config {
  /** Python 解释器(仓库 .venv 内) */
  pythonBin: string
  /** 仓库 py/ 目录(作为 PYTHONPATH) */
  pythonPath: string
  /** 状态根目录(动机画像、wish pool、延迟日志) */
  stateRoot: string
  /** 引擎调用超时(ms) */
  timeoutMs: number
}

export const Config: z<Config> = z.object({
  pythonBin: z.string().default('.venv/bin/python'),
  pythonPath: z.string().default('py'),
  stateRoot: z.string().default('.'),
  timeoutMs: z.number().default(30_000),
})

interface FeasibilityResult {
  answer_md?: string
}

interface MotivationProfileInput {
  weights?: Record<string, number>
  evidence?: string[]
  hard?: Record<string, unknown>
}

interface WishPoolEntryInput {
  name?: string
  reason?: string
  conditions?: Record<string, unknown>
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
type JsonObject = { [k: string]: Json }

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'gotry_feasibility_check',
    description:
      'Check travel candidates against the user\'s motivation and hard constraints using the '
      + 'door-to-door true-cost engine (wake time, arrival state, energy, usable hours, money). '
      + 'Input is the structured request (motivation weights + hard constraints + window + budget + home hubs) '
      + 'and the candidate list (services/transfers/stay costs/min days), same shape as data/golden_erhai.json. '
      + 'Returns per-candidate verdicts, unsat cores with minimal-modification suggestions, '
      + 'a wish-pool entry for infeasible aspirations, and a ready-to-show markdown answer.',
    parameters: {
      payload: {
        type: 'json',
        required: true,
        description: 'The full engine payload: { request, candidates }.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: String((value as FeasibilityResult).answer_md ?? JSON.stringify(value)),
      }],
    },
    async execute(args: { payload: unknown }, _exec: unknown) {
      const { result, latencyMs } = await callFeasibilityEngine(args.payload, {
        pythonBin: config.pythonBin,
        pythonPath: config.pythonPath,
        timeoutMs: config.timeoutMs,
      })
      const dir = await ensureStateDir(config.stateRoot)
      await recordLatency(join(dir, 'bridge-latency.jsonl'), latencyMs, 'feasibility_check').catch(() => {})
      return { ...(result as Record<string, unknown>), latency_ms: latencyMs }
    },
    presentCall: args => ({ card: 'generic', title: 'GoTry 可行性检查(门到门全成本)', kind: 'other', rawInput: args.payload }),
  }))

  ctx.tools.register(defineTool({
    name: 'gotry_motivation_save',
    description:
      'Persist the traveler\'s motivation profile (the "why depart" contract object). '
      + 'This is the B2B reuse seam: downstream plugins consume only MotivationProfile + constraints, '
      + 'never the principal/sponsor distinction. Requires an evidence field: every weight must trace '
      + 'back to the user\'s own words (P0 anti-fabrication rule).',
    parameters: {
      profile: {
        type: 'json',
        required: true,
        description: '{ weights: {escape_rest: 0.7, ...}, evidence: [user quotes...], hard: {wake_not_before, min_arrival_energy_pct} }',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean' },
          path: { type: 'string' },
          profile: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `动机画像已保存:${String((value as { path?: string }).path ?? '')}` }],
    },
    async execute(args: { profile: unknown }, _exec: unknown) {
      const profile = (args.profile ?? {}) as MotivationProfileInput
      if (!profile.evidence?.length) {
        throw new Error('refusing to save a motivation profile without evidence (P0 anti-fabrication rule)')
      }
      const dir = await ensureStateDir(config.stateRoot)
      const path = join(dir, 'motivation-profile.json')
      // JSON 往返保证落盘值与输出值都是 JsonValue(输出 schema 的硬要求)
      const saved = JSON.parse(JSON.stringify({ ...profile, updated_at: new Date().toISOString() })) as JsonObject
      await writeJson(path, saved)
      return { saved: true, path, profile: saved }
    },
    presentCall: args => ({ card: 'generic', title: '保存动机画像', kind: 'other', rawInput: args.profile }),
  }))

  ctx.tools.register(defineTool({
    name: 'gotry_wish_pool_add',
    description:
      'Add an aspiration to the "next departure" wish pool — the graceful home for infeasible dreams. '
      + 'An entry carries its fulfilment conditions (days needed, budget, best months) so a future '
      + '"next departure" nudge can fire when the window matches. 憧憬不被拒绝。',
    parameters: {
      entry: {
        type: 'json',
        required: true,
        description: '{ name, reason, conditions: { days, budget_cny, best_months } }',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'boolean' },
          total: { type: 'integer' },
          path: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { total?: number; path?: string }
        return [{ type: 'text', text: `已加入「下一次出发」清单(共 ${v.total ?? '?'} 项):${v.path ?? ''}` }]
      },
    },
    async execute(args: { entry: unknown }, _exec: unknown) {
      const entry = (args.entry ?? {}) as WishPoolEntryInput
      if (!entry.name || !entry.conditions) {
        throw new Error('wish pool entry requires name and conditions (fulfilment conditions are the whole point)')
      }
      const dir = await ensureStateDir(config.stateRoot)
      const path = join(dir, 'wish-pool.json')
      const pool = (await readJson(path, [])) as Array<Record<string, unknown>>
      pool.push({ reason: '', ...entry, added_at: new Date().toISOString() })
      await writeJson(path, pool)
      return { added: true, total: pool.length, path }
    },
    presentCall: args => ({ card: 'generic', title: '加入「下一次出发」清单', kind: 'other', rawInput: args.entry }),
  }))
}
