/**
 * 通道注册表 + 通道健康面测试(issue #106/#107/#108 编排设计落地,
 * docs/tool-orchestration-design.md §2/§3;全离线,隔离 tmp stateRoot):
 *  1. 注册表封闭性:id 唯一/quotaClass·tier·intent 闭集/静态包不可路由
 *  2. 意图顺位:证据级降序(官方API > 会话 > 网页兜底),同 tier 按效率
 *  3. routingAdvice:down 通道被排除/发起通道被排除/limit 截断;hit 即恢复
 *  4. noteChannelVerdict 映射:needs-setup→down/hit→清除/miss·error→不动/cooldown 过期
 *  5. persona 路由卡:确定性渲染,含改道规则与意图顺位行
 *  6. JSONL 持久面:record/readLatest 往返 + 坏行容忍 + limitDays 过滤
 *  7. doctor 集成:flyai 最近达限时间可见;calendar 三态(默认不挂载/opt-in 未配置/opt-in 已配置)
 *  8. apply 接线:channel_routing_card 变量已注册;参数级拒绝不带 routing 字段
 *
 * 运行: cd ts && npx tsx scripts/channel-registry-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHANNELS, channelsForIntent, routingAdvice, renderRoutingCard,
  INTENT_LABELS, type ChannelIntent, type ChannelQuotaClass, type EvidenceTier,
} from '../capabilities/channel-registry.ts'
import {
  noteChannelVerdict, channelState, clearChannel, resetChannelHealth,
  recordChannelEvent, readLatestChannelEvents,
} from '../capabilities/channel-health.ts'
import { runDoctorChecks } from '../capabilities/doctor.ts'
import { apply } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

const NOW = 1_700_000_000_000

// 1. 注册表封闭性
const QUOTA_CLASSES: readonly ChannelQuotaClass[] = ['user-session', 'user-key', 'anonymous-trial', 'free-public', 'static']
const TIERS: readonly EvidenceTier[] = ['realtime-api', 'session', 'best-effort', 'static']
const INTENTS = Object.keys(INTENT_LABELS) as readonly ChannelIntent[]
const ids = new Set<string>()
for (const c of CHANNELS) {
  assert.ok(!ids.has(c.id), `通道 id 重复:${c.id}`)
  ids.add(c.id)
  assert.ok(QUOTA_CLASSES.includes(c.quotaClass), `${c.id} quotaClass 越界`)
  assert.ok(TIERS.includes(c.tier), `${c.id} tier 越界`)
  assert.ok(c.intents.length > 0 && c.intents.every(i => INTENTS.includes(i)), `${c.id} intents 越界`)
  assert.ok(c.tool.startsWith('gotry_'), `${c.id} 工具名形态`)
  if (c.quotaClass === 'static') assert.equal(c.routable, false, '静态包不进模型可选路由')
}
assert.ok(CHANNELS.length >= 9, '注册表覆盖面(≥9 通道)')
console.log('1. 注册表封闭性 OK')

// 2. 意图顺位(证据级降序)
resetChannelHealth()
assert.deepEqual(channelsForIntent('search-flight').map(c => c.id), ['flyai', 'session:ctrip-flight', 'web-read'], '机票顺位')
assert.deepEqual(channelsForIntent('search-train').map(c => c.id), ['flyai', 'session:12306-train', 'web-read'], '火车顺位')
assert.deepEqual(channelsForIntent('search-hotel').map(c => c.id), ['flyai', 'hbcli-hotel', 'session:ctrip-hotel', 'web-read'], '酒店顺位')
assert.deepEqual(channelsForIntent('weather').map(c => c.id), ['open-meteo'], '单通道意图')
console.log('2. 意图顺位(证据级 > 效率)OK')

// 3. routingAdvice:健康面驱动
const base = routingAdvice('search-flight')
assert.equal(base.alternatives[0]!.channel, 'flyai', '健康时 flyai 首荐(零 setup 摩擦)')
assert.ok(base.alternatives[0]!.why.length > 4 && (base.alternatives[0]!.setup?.length ?? 0) > 0, 'why/setup 齐备')
noteChannelVerdict('flyai', 'needs-setup', { now: NOW })
const afterDown = routingAdvice('search-flight', { now: NOW })
assert.ok(!afterDown.alternatives.some(a => a.channel === 'flyai'), 'flyai 达限后从建议表排除(#108 病灶)')
assert.equal(afterDown.alternatives[0]!.channel, 'session:ctrip-flight', 'session 升首荐(优先级=健康面投影)')
const excl = routingAdvice('search-flight', { excludeChannel: 'session:ctrip-flight', now: NOW })
assert.ok(!excl.alternatives.some(a => a.channel === 'session:ctrip-flight'), '发起通道被排除')
assert.equal(routingAdvice('search-flight', { limit: 1, now: NOW }).alternatives.length, 1, 'limit 截断')
noteChannelVerdict('flyai', 'hit', { now: NOW })
assert.equal(routingAdvice('search-flight', { now: NOW }).alternatives[0]!.channel, 'flyai', 'hit 即恢复(#107:补 key 不被陈旧状态锁死)')
console.log('3. routingAdvice(down 排除/发起排除/limit/hit 恢复)OK')

// 4. noteChannelVerdict 映射闭集
resetChannelHealth()
assert.ok(noteChannelVerdict('x', 'needs-setup', { now: NOW }), 'needs-setup → down 事件')
assert.equal(channelState('x', NOW)?.state, 'down')
assert.equal(noteChannelVerdict('x', 'challenged', { now: NOW })?.reason, 'challenged', 'challenged → down')
assert.equal(noteChannelVerdict('x', 'needs-login', { now: NOW })?.reason, 'needs-login', 'needs-login → down')
assert.equal(noteChannelVerdict('x', 'needs-extension', { now: NOW })?.reason, 'needs-extension', 'needs-extension → down')
assert.equal(noteChannelVerdict('x', 'miss', { now: NOW }), undefined, '业务 miss ≠ 通道故障')
assert.equal(noteChannelVerdict('x', 'error', { now: NOW }), undefined, '业务 error ≠ 通道故障')
clearChannel('x')
assert.equal(channelState('x', NOW), undefined, '清除后无状态')
const cd = noteChannelVerdict('y', 'cooldown', { now: NOW, cooldownMs: 30_000 })
assert.equal(cd?.state, 'cooldown', 'cooldown → cooldown 事件')
assert.equal(channelState('y', NOW + 29_999)?.state, 'cooldown', '冷却未满仍在')
assert.equal(channelState('y', NOW + 30_001), undefined, '冷却满惰性过期')
console.log('4. noteChannelVerdict 映射闭集 OK')

// 5. persona 路由卡
const card1 = renderRoutingCard(new Date(NOW))
const card2 = renderRoutingCard(new Date(NOW))
assert.equal(card1, card2, '同刻渲染确定')
assert.match(card1, /检索通道顺位/, '卡头')
assert.match(card1, /verdict≠hit/, '改道规则在卡内')
assert.match(card1, /- 机票: .+gotry_flyai_search.+→.+gotry_session_search/, '机票顺位行')
assert.match(card1, /- 火车: .+12306 公开查询面.+kind=train/, '火车行带 kind 消歧')
assert.match(card1, /匿名试用=首次体验导流/, '额度口径脚注(D-7)')
assert.ok(!card1.includes('- 天气'), '单通道意图不上卡')
console.log('5. persona 路由卡 OK')

// 6. JSONL 持久面往返(事件时间用真实时钟——limitDays 窗口以读方时钟为基准)
const stateRoot = await mkdtemp(join(tmpdir(), 'gotry-channel-test-'))
const realNow = Date.now()
await recordChannelEvent(stateRoot, { channel: 'flyai', state: 'down', reason: 'needs-setup', at: new Date(realNow - 86_400_000).toISOString() })
await recordChannelEvent(stateRoot, { channel: 'flyai', state: 'down', reason: 'needs-setup', at: new Date(realNow).toISOString() })
await recordChannelEvent(stateRoot, { channel: 'session:ctrip-flight', state: 'cooldown', at: new Date(realNow).toISOString() })
const latest = await readLatestChannelEvents(stateRoot)
assert.equal(latest.get('flyai')?.at, new Date(realNow).toISOString(), '每通道取最新')
assert.equal(latest.get('session:ctrip-flight')?.state, 'cooldown')
await recordChannelEvent(stateRoot, { channel: 'legacy', state: 'down', at: new Date(realNow - 40 * 86_400_000).toISOString() } as never)
assert.ok(!((await readLatestChannelEvents(stateRoot)).has('legacy')), '40 天前事件被 limitDays 过滤')
const raw = `${stateRoot}/gotry-state/channel-health.jsonl`
await writeFile(raw, `${await readFile(raw, 'utf-8')}not-json\n{"half":true}\n`, 'utf-8')
assert.equal((await readLatestChannelEvents(stateRoot)).size, 2, '坏行容忍')
console.log('6. JSONL 持久面 OK')

// 7. doctor 集成:flyai 配额可见 + calendar 三态(setup 状态面,非 env)
const emptyRepo = join(stateRoot, 'repo')
const emptyHome = join(stateRoot, 'home')
await mkdir(emptyRepo, { recursive: true })
await mkdir(join(emptyHome, '.gotry'), { recursive: true })
const calStatePath = join(emptyHome, '.gotry', 'calendar.json')
const d1 = await runDoctorChecks({ repoRoot: emptyRepo, homeDir: emptyHome, env: {}, stateRoot })
assert.match(d1.items.find(i => i.id === 'flyai')!.detail, /最近一次试用达限/, '最近达限时间进 doctor(#107 可见性)')
assert.equal(d1.items.find(i => i.id === 'calendar')!.status, 'ok', 'calendar 默认不挂载=ok(D-9)')
assert.match(d1.items.find(i => i.id === 'calendar')!.detail, /默认未挂载/, '默认态人话')
await writeFile(calStatePath, JSON.stringify({ enabled: true }), 'utf-8')
const d2 = await runDoctorChecks({ repoRoot: emptyRepo, homeDir: emptyHome, env: {} })
assert.equal(d2.items.find(i => i.id === 'calendar')!.status, 'degraded', 'setup 开启但未配置 username=degraded')
assert.match(d2.items.find(i => i.id === 'calendar')!.fix ?? '', /npx gotry setup calendar/, 'fix 指向 setup 状态面')
const profileDir = join(emptyHome, '.dsh/profiles/web')
await mkdir(profileDir, { recursive: true })
await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: dsh-calendar\n  config:\n    username: someone\n', 'utf-8')
const d3 = await runDoctorChecks({ repoRoot: emptyRepo, homeDir: emptyHome, env: {} })
assert.equal(d3.items.find(i => i.id === 'calendar')!.status, 'ok', 'setup 开启且已配置=ok')
const d4 = await runDoctorChecks({ repoRoot: emptyRepo, homeDir: emptyHome, env: {} })
assert.ok(!/最近一次试用达限/.test(d4.items.find(i => i.id === 'flyai')!.detail), '无 stateRoot 不读持久面(向后兼容)')
console.log('7. doctor 集成(flyai 配额可见 + calendar setup 状态面三态)OK')

// 8. apply 接线:变量注册 + 参数级拒绝不带 routing
resetChannelHealth()
const variables: Record<string, () => string> = {}
const registered: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = []
const ctx = {
  tools: { register: (t: unknown) => registered.push(t as never) },
  systemPrompt: { variable: (name: string, provider: () => string) => { variables[name] = provider } },
  on: () => () => {},
} as unknown as Context
apply(ctx, { stateRoot, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'ask' } as never)
assert.equal(typeof variables.channel_routing_card, 'function', 'channel_routing_card 变量已注册')
assert.match(variables.channel_routing_card!(), /检索通道顺位/, '卡片可渲染')
const pastDate = await registered.find(t => t.name === 'gotry_flyai_search')!.execute(
  { query: { kind: 'flight', from: '深圳', to: '普吉', date: '2026-01-01' } }, null) as { routing?: unknown }
assert.ok(!('routing' in pastDate), '参数级预校验拒绝不带 routing(未发起检索,无改道语义)')
console.log('8. apply 接线 OK')

await rm(stateRoot, { recursive: true, force: true })
console.log('channel-registry-tests: 全部通过')
