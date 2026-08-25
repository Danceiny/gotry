/**
 * hotelbyte-skills 契约对齐校验(issue #5 第二步):
 *   gotry 工具描述与 Danceiny/hotelbyte-skills 的 contracts/*.md 是同一事实源
 *   的两面——本测试抓取远端契约,断言关键参数形态/域边界措辞在 gotry 工具描述
 *   里可找到对应,防止 skills 仓演进后 gotry 静默漂移。
 *
 *   有 GitHub 凭证(keychain)→ 真校验;无凭证/网络不可达 → SKIP(退出码 0,
 *   不让 CI/离线环境红:对齐检查是「能跑则跑」,不是硬门槛)。
 *
 * 运行: cd ts && npx tsx scripts/skills-contract-tests.ts
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { apply } from '../src/index.ts'

async function main(): Promise<void> {
  // 1) 收集 gotry 工具描述(只读注册面,不 exec 任何工具)
  const registered: Array<{ name: string; description?: string; parameters?: { properties?: Record<string, { description?: string }> } }> = []
  apply({
    tools: { register: (t: unknown) => registered.push(t as never) },
  } as never, { stateRoot: '.', timeoutMs: 1000, hbcliBin: 'hbcli-not-on-path' } as never)
  // 工具 description + 参数层 description(JSON Schema properties.*.description)一起算「面向模型的形态」
  const desc = (n: string) => {
    const t = registered.find(x => x.name === n)
    if (!t) return ''
    const params = Object.values(t.parameters?.properties ?? {}).map(p => p.description ?? '').join(' ')
    return `${t.description ?? ''} ${params}`
  }
  const anythingDesc = desc('gotry_anything_search')
  const hotelsDesc = desc('gotry_hotel_search')

  // 2) 取 keychain 凭证;没有就 SKIP
  let token = ''
  try {
    const out = execFileSync('git', ['credential-osxkeychain', 'get'], {
      input: 'protocol=https\nhost=github.com\n',
    }).toString()
    token = (out.match(/^password=(.+)$/m) ?? ['', ''])[1].trim()
  } catch { /* 无 git/无凭证 */ }
  if (!token) {
    console.log('SKIP: 无 GitHub 凭证(契约对齐在有凭证环境跑)')
    return
  }

  // 3) 拉远端契约
  const get = async (path: string): Promise<string> => {
    const res = await fetch(`https://api.github.com/repos/Danceiny/hotelbyte-skills/contents/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    const j = await res.json() as { content?: string; encoding?: string }
    return Buffer.from(j.content ?? '', j.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
  }

  let anythingContract = ''
  let hotelsContract = ''
  try {
    ;[anythingContract, hotelsContract] = await Promise.all([get('contracts/anything.md'), get('contracts/hotels.md')])
  } catch (e) {
    console.log(`SKIP: 契约拉取失败(${(e as Error).message})——对齐检查跳过,不红`)
    return
  }

  // 4) 对齐断言:契约里的关键参数/域边界措辞必须在 gotry 工具描述有对应
  assert.ok(anythingContract.includes('contentType'), '契约应声明 contentType')
  assert.ok(anythingDesc.includes('contentType'), 'gotry_anything_search 描述应含 contentType(契约对齐)')
  assert.ok(anythingContract.includes('agent-reach'), '契约应声明与 agent-reach 的域边界')
  // 工具名是下划线形态(gotry_agent_reach),契约文档是连字符(agent-reach),两种都算对齐
  assert.ok(/agent[-_]reach/.test(anythingDesc), 'gotry_anything_search 描述应引域边界(agent[-_]reach)')
  for (const p of ['destination', 'checkIn', 'checkOut']) {
    assert.ok(hotelsContract.includes(p), `契约应声明 ${p}`)
    assert.ok(hotelsDesc.includes(p), `gotry_hotel_search 描述应含 ${p}(契约对齐)`)
  }
  assert.ok(anythingContract.includes('not-installed') || anythingContract.includes('三值'), '契约应声明三值降级')
  console.log('SKILLS CONTRACT TESTS: 2/2 OK(anything/hotels 契约与 gotry 工具描述对齐)')
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
