/**
 * staicli(hbcli)全流程端到端测试:二进制 → 隔离凭证面 → 真实 UAT 取票 →
 * 能力层真实 spawn → 效应解译层策略(ADR-18)→ 工具层 gotry_hotel_search。
 *
 * 账号与凭证纪律(红线):
 *   - 测试账号用 hotel-be 种子沙箱 API 账号 hotelbyte_api_demo/hotelbyte_api_demo
 *     (user/domain/predefined_user_demo.go,IsSandbox:true,专为 API 接入验证设计);
 *     正式集成方换自己申请的 hbk_ / hbs_ 前缀凭证对。
 *   - 凭证写进 mkdtemp 的隔离 STAICLI_HOME,全程不读不写用户默认 ~/.staicli
 *     (巡检状态纪律:测试不得触碰真实用户凭证与产品状态);
 *   - stateRoot 同样走临时目录,结束即删。
 *
 * SKIP 语义(同 §17 先例:能跑则跑,环境缺前置不红):
 *   - hbcli 未安装 → SKIP + 安装指引(npx gotry setup);
 *   - UAT(api-test.hotelbyte.com)不可达 → SKIP + 原因。
 * UAT 当前库存态(2026-08-30 实测):目的地/酒店参考数据为空,hotel-list 按名
 * 查询返回业务层 404——通道/鉴权/搜索编排(供应商 provenance+correlationId)均
 * 真实工作,故断言「通道真实性 + 降级诚实性」而非「有库存返回」。
 *
 * 运行: cd ts && npx tsx scripts/hbcli-e2e-tests.ts
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { listDestinations, searchHotels, hbcliBinCandidates } from '../capabilities/hbcli.ts'
import { makeProductionInterpreter } from '../capabilities/effect.ts'
import type { Context } from '@deepseek-ai/cordis'

const UAT = 'https://api-test.hotelbyte.com'
/** hotel-be 种子沙箱 API 账号(公开演示用,IsSandbox;真实集成方应换自己申请的 hbk_/hbs_ 前缀凭证对) */
const SANDBOX_APP_KEY = 'hotelbyte_api_demo'
const SANDBOX_APP_SECRET = 'hotelbyte_api_demo'

const GUIDANCE = [
  'staicli(hbcli)账号配置指引:',
  '  1. 安装 CLI(若缺):npx gotry setup(官方 install.sh → ~/.local/bin/hbcli)',
  '  2. 快速试用(沙箱演示账号,来自 hotel-be 种子,user/domain/predefined_user_demo.go):',
  '     hbcli auth set-credentials --app-key hotelbyte_api_demo --app-secret hotelbyte_api_demo',
  '  3. 正式接入:向 HotelByte 申请专属 appKey/appSecret(hbk_*/hbs_*),替换第 2 步凭证;',
  '     门户模式则 hbcli auth login --username <email>(权限更大,搜索场景无必要)',
  '  4. 自检:hbcli auth whoami(api_key.configured=true 即凭证就位;has_ticket 首次查询后为 true)',
]

interface HbcliLike { via: string; exitCode: number; evidence: string; error?: string; summary?: string; result?: unknown }

function probeBin(): string | null {
  for (const bin of hbcliBinCandidates('hbcli')) {
    const r = spawnSync(bin, ['version'], { timeout: 10_000, stdio: 'ignore' })
    if (!r.error && r.status === 0) return bin
  }
  return null
}

async function uatReachable(): Promise<boolean> {
  try {
    await fetch(`${UAT}/api/search/destinations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(8_000),
    })
    return true // 任何 HTTP 响应(含 401)都算可达
  } catch { return false }
}

async function main(): Promise<void> {
  console.log(GUIDANCE.join('\n'))
  const bin = probeBin()
  if (!bin) {
    console.log(`SKIP: 未安装 hbcli(候选 ${hbcliBinCandidates('hbcli').join(' / ')} 均不可执行)——npx gotry setup 可按官方脚本安装`)
    return
  }
  if (!(await uatReachable())) {
    console.log(`SKIP: UAT(${UAT})不可达——全流程端到端在有网环境跑,离线降级面已由 hbcli-tests.ts(§7)覆盖`)
    return
  }

  // 隔离凭证面:全程不触碰用户默认 ~/.staicli
  const staicliHome = mkdtempSync(join(tmpdir(), 'gotry-hbcli-e2e-'))
  const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-hbcli-e2e-state-'))
  process.env.STAICLI_HOME = staicliHome
  const fallbackPath = join(import.meta.dirname, '..', '..', 'data', 'hotels_2026.json')
  try {
    // 1) 沙箱账号写入隔离凭证面(hbcli auth set-credentials)
    const set = spawnSync(bin, ['auth', 'set-credentials', '--app-key', SANDBOX_APP_KEY, '--app-secret', SANDBOX_APP_SECRET],
      { timeout: 30_000, encoding: 'utf-8' })
    assert.equal(set.status, 0, `auth set-credentials 应成功,实际 ${set.status}: ${set.stderr?.slice(0, 200)}`)
    console.log(`1. 沙箱账号写入隔离 STAICLI_HOME(${staicliHome.replace(tmpdir(), '$TMPDIR')})OK`)

    // 1b) whoami 自检:api_key.configured=true(配置面就位,尚未取票)
    const who = spawnSync(bin, ['auth', 'whoami'], { timeout: 30_000, encoding: 'utf-8' })
    assert.equal(who.status, 0, 'whoami 应 exit 0')
    assert.match(who.stdout, /"configured": true/, 'whoami 应报 api_key.configured=true')
    console.log('1b. hbcli auth whoami 自检(api_key.configured=true)OK')

    // 2) 能力层真实 spawn:目的地列表(通道真实性——UAT 参考数据可为空,通道必须真实)
    const dest = await listDestinations({ timeoutMs: 30_000 }) as unknown as HbcliLike
    assert.equal(dest.via, 'hbcli-realtime', `destinations 应走实时通道,实际 ${dest.via}(${dest.error ?? ''})`)
    assert.equal(dest.exitCode, 0, 'destinations 应 exit 0')
    assert.match(dest.evidence, /\[实时API:hbcli@\d{4}-/, '证据链应带实时时间戳标注(L4 不变量)')
    assert.ok(dest.result !== null && typeof dest.result === 'object', '实时返回应可解析为 JSON')
    console.log(`2. 能力层实时通道(listDestinations → ${UAT})via=hbcli-realtime,证据链 OK`)

    // 3) hotel-list 全链路:UAT 无目的地参考数据 → 业务层 404 → 降级诚实性
    //    (真实失败不再是「工具坏了」,而是带上游原话的显式降级;issue #24 契约)
    const hotels = await searchHotels(
      { destination: '深圳', checkIn: '2026-09-18', checkOut: '2026-09-20', adults: 2 },
      { timeoutMs: 30_000, fallbackPath },
    ) as unknown as HbcliLike & { hotels?: unknown; summary: string }
    if (hotels.via === 'hbcli-error') {
      assert.ok(hotels.error, '降级结果应携带上游原话原因')
      assert.match(hotels.summary, /降级/, 'summary 应显式声明降级(不伪装成实时)')
      assert.match(hotels.summary, /静态包/, '降级路径应指明静态包来源')
      // 静态包含深圳块(data/hotels_2026.json)→ 降级应命中并标注「非实时」
      assert.ok(hotels.hotels !== null, '静态包深圳块应命中')
      assert.match(hotels.summary, /非实时/, '降级产物必须显式标注非实时(L4 反伪装红线)')
      console.log(`3. hotel-list 真实降级链(via=hbcli-error,原因:${String(hotels.error).slice(0, 60)}…;静态包命中+非实时标注)OK`)
    } else {
      // UAT 后续补齐目的地数据时走此分支:实时返回必须带证据链
      assert.equal(hotels.via, 'hbcli-realtime')
      assert.match(hotels.evidence, /\[实时API:hbcli@\d{4}-/)
      console.log('3. hotel-list 实时返回(UAT 已有目的地数据)证据链 OK')
    }

    // 4) 效应解译层(ADR-18)真实通道:HBCLI_HOTEL_SEARCH 策略=永不重试+熔断在册;
    //    独立 breakers Map,不污染产品单例
    const itp = await makeProductionInterpreter({ breakers: new Map() })({
      effect: 'HBCLI_HOTEL_SEARCH',
      params: { destination: '深圳', fallbackPath, timeoutMs: 30_000 },
    })
    assert.equal(itp.trace.attempts, 1, `hbcli 策略永不重试,实际 attempts=${itp.trace.attempts}`)
    assert.equal(itp.trace.channel, 'cli')
    assert.ok(itp.trace.evidence[0]?.startsWith('[效应:HBCLI_HOTEL_SEARCH@'), 'trace 应带解译层横切证据')
    assert.ok(itp.result !== null, '解译产物应原样透传渠道 observation(含降级形态)')
    const viaAfter = (itp.result as HbcliLike).via
    assert.ok(viaAfter === 'hbcli-error' || viaAfter === 'hbcli-realtime', `渠道 via 应保真,实际 ${viaAfter}`)
    console.log(`4. 效应解译层(attempts=1 永不重试,breaker=${itp.trace.breaker},via=${viaAfter})OK`)

    // 5) 工具层端到端:gotry_hotel_search 经效应解译器跑完整链(隔离 stateRoot)
    const { apply } = await import('../src/index.ts')
    const registered: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = []
    apply({ tools: { register: (t: unknown) => registered.push(t as never) } } as unknown as Context,
      { stateRoot, timeoutMs: 30_000, hbcliBin: 'hbcli', sessionAccess: 'ask' } as never)
    const tool = registered.find(t => t.name === 'gotry_hotel_search')
    assert.ok(tool, 'gotry_hotel_search 应已注册')
    const obs = await tool.execute({ query: { destination: '深圳' } }, null) as Record<string, unknown>
    assert.equal(obs.ok, true, '工具面应返回 ok 包络(永不抛错契约)')
    assert.ok(obs.via === 'hbcli-error' || obs.via === 'hbcli-realtime', `工具面 via 应与渠道一致,实际 ${obs.via}`)
    const ev = String(obs.evidence)
    if (obs.via === 'hbcli-error') {
      assert.match(ev, /静态包/, '降级时证据链应标注静态包(估算必须显式)')
    } else {
      assert.match(ev, /实时API:hbcli/, '实时时证据链应标注 hbcli 时间戳')
    }
    assert.ok(String(obs.summary).length > 0, 'summary 应存在')
    console.log(`5. 工具层端到端(gotry_hotel_search → 效应解译器 → ${UAT})via=${obs.via},evidence=${ev.slice(0, 46)}… OK`)

    console.log('HBCLI E2E TESTS: 5/5 OK(隔离凭证面/实时通道/降级诚实/解译策略/工具面全链)')
  } finally {
    process.env.STAICLI_HOME = undefined
    rmSync(staicliHome, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
