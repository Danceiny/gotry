/**
 * persona 表层护栏测试(issue #192/#2 回归锚;全离线,只读仓根 patch):
 *  1. (16) 域边界含表层规则句——gotry 能力一律是工具调用,绝不把 gotry_* 传给
 *     skill 加载器(dsh skill 面名合法域 ^[a-z0-9]+(-[a-z0-9]+)*$,下划线必抛
 *     invalid skill name,rc18 真实用户踩坑);
 *  2. 行为契约 22 条编号完整(防止后续编辑吞条目);
 *  3. skill 失败后的行为指引存在(改回 tool call,不换名重试 skill);
 *  4. (8) 候选时段示例枚举绑定锚点卡——澄清卡/访谈/选项不列已过节日
 *     (#2 rc18 真实复发:卡把已过的春节/清明/五一当「想用的时候」示例)。
 *
 * 运行: cd ts && npx tsx scripts/persona-surface-guard-tests.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const patch = readFileSync(join(process.cwd(), '..', 'cordis.gotry-patch.yml'), 'utf-8')

// 1. 表层规则句存在且仅一次
const guard = '表层规则:gotry 的全部能力一律是【工具调用】'
assert.equal((patch.match(new RegExp(guard, 'g')) ?? []).length, 1, '表层规则句应恰好出现一次')
assert.ok(patch.includes('绝不把 gotry_* 名字传给 skill 加载器'), '应显式禁止 gotry_* 进 skill 加载器')

// 2. 行为契约 22 条编号完整
const markers = new Set([...patch.matchAll(/\((\d{1,2})\)/g)].map((m) => Number(m[1])))
for (let i = 1; i <= 23; i += 1) {
  assert.ok(markers.has(i), `行为契约 (${i}) 应存在`)
}
assert.equal(markers.size, 23, `契约条目应恰为 23 条,实际 ${markers.size}`)

// 3. skill 用错面后的行为指引
assert.ok(patch.includes('改回 tool call'), '应指引失败后改回 tool call')

// 4. #2 复发回归锚:澄清卡示例枚举同样过锚点卡(契约 (8) 内部澄清,条数不变)
assert.ok(patch.includes('澄清卡/访谈/选项里向用户列出的候选时段示例'), '#2 回归:候选时段示例条款应存在')
assert.ok(patch.includes('已过的节日不进示例枚举'), '应禁止已过节日进澄清卡示例枚举')

// 5. #194 回归锚:子任务等待纪律((23) 新条)——子代理回执 id 不是 job id,
//    job_output/job_kill 轮询子代理 = unknown job 硬错误(rc.19 npm 用户实踩)。
assert.ok(patch.includes('(23)子任务等待纪律'), '#194 回归:子任务等待纪律条款应存在')
assert.ok(patch.includes('对子代理绝不调用 job_output/job_kill'), '应禁止对子代理调用 job_output/job_kill')
assert.ok(patch.includes("job_output/job_kill 只用于"), '应限定 job_output/job_kill 的适用面')

console.log('PERSONA SURFACE GUARD TESTS: 5/5 OK(表层规则句 / 23 条契约完整 / skill 失败行为指引 / 澄清卡示例过锚点卡 / 子任务等待纪律)')
