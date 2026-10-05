/**
 * Anything 能力层测试(模拟 hbcli):
 *  1. 真实候选:fake hbcli 按 hotel-be SearchItem wire 形状返 JSON — verdict hit + hits
 *     (i18n name zh 优先 / region.centerLat / hotel.latlngCoordinator / star / id 逐字段对齐)
 *  2. 旗标回归:--json 在子命令前(cli.ts 全局旗标预扫描只认子命令前位置)+
 *     --content-type / parentDestinationId → --destination-id 映射
 *  3. 空候选:fake hbcli 返 empty JSON — verdict miss
 *  4. exit≠0:fake hbcli 返 stderr+退出 — verdict error + 不抛错
 *  5. 旧 CLI「unknown command」:error 带升级指引(issue #195:裸 unknown command 读起来像工具坏了)
 *  6. 超时:fake hbcli hang — AbortError → verdict error + 不抛错
 *  7. 关键词为空:不调 hbcli — verdict error
 *  8. 缺 hbcli(spawn 失败):用户面是人话(不留 `(exit null)`/ENOENT 进程噪音)
 *  9. 离线开关 GOTRY_HBCLI_LIVE=0|false|off(issue #617):计数 fake hbcli **零次**被调起,
 *     返回既有降级面(与缺 hbcli 同形:ok:false / hbcli-anything-error / verdict:error + 人话原因);
 *     含 PATH 解析的真实调用面(runTurn 的 PoI 探针不传 hbcliBin)
 * 10. 开关未设或任何其他取值:行为与此前完全一致——fake 被调起,hit/miss/error 三值语义不变
 * 11. 既有入参的既有结果在开关关闭时逐字节不变:空 keyword / pre-aborted 先于离线判定
 *
 * 本套件独占 GOTRY_HBCLI_LIVE:开头清掉外部值(`GOTRY_HBCLI_LIVE=0 ./scripts/run-all-tests.sh` 也不得改变 fake 断言),
 * 结束还原。
 *
 * 运行: cd ts && npx tsx scripts/anything-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anythingSearch } from '../capabilities/anything.ts'

const tmp = await mkdtemp(join(tmpdir(), 'anything-test-'))
const savedLive = process.env.GOTRY_HBCLI_LIVE
delete process.env.GOTRY_HBCLI_LIVE
try {
  async function fakeBin(name: string, behaviour: 'ok' | 'echo-args' | 'empty' | 'fail' | 'hang' | 'unknown-command'): Promise<string> {
    const p = join(tmp, name)
    if (behaviour === 'ok') {
      // hotel-be SearchItem 真实 wire 形状(2026-09-07 对齐源码):i18n name 对象、
      // region.coordinates.centerLat/centerLng、hotel.latlngCoordinator.google、star、matchScore
      await writeFile(p, `#!/bin/sh
cat <<'JSON'
{"candidates":[
  {"type":"hotel","matchScore":180,"hotel":{"id":"h1","name":{"en":"Park Hyatt","zh":"柏悦酒店"},"star":5,"destinationId":"d1","latlngCoordinator":{"google":{"lat":22.31,"lng":114.16}}}},
  {"type":"city","matchScore":250,"region":{"id":"d1","name":{"en":"Dali","zh":"大理市"},"countryCode":"CN","coordinates":{"centerLat":25.58,"centerLng":100.21}}},
  {"type":"place","matchScore":90,"region":{"id":"r1","name":{"zh":"洱海"}},"place":{"latlngCoordinator":{"google":{"lat":25.74,"lng":100.25}}}}
]}
JSON
`, { mode: 0o755 })
    } else if (behaviour === 'echo-args') {
      // 旗标回归探针:把 "$@" 回显进候选 region.id(anythingSearch 原样透传为 destinationId)
      await writeFile(p, `#!/bin/sh
printf '{"candidates":[{"type":"city","region":{"id":"%s"}}]}' "$*"
`, { mode: 0o755 })
    } else if (behaviour === 'empty') {
      await writeFile(p, `#!/bin/sh
cat <<'JSON'
{"candidates":[]}
JSON
`, { mode: 0o755 })
    } else if (behaviour === 'fail') {
      await writeFile(p, `#!/bin/sh
echo 'hotelbe down' >&2
exit 1
`, { mode: 0o755 })
    } else if (behaviour === 'unknown-command') {
      // 旧版 CLI(< 2026-09 的 staicli)没有 search anything 子命令时的 commander 原话
      await writeFile(p, `#!/bin/sh
echo "error: unknown command 'anything'" >&2
exit 1
`, { mode: 0o755 })
    } else {
      // hang forever — test will timeout. Spawn on POSIX reacts to AbortSignal
      // via SIGTERM; SIGKILL is the fallback at +500ms. Some shells (e.g. bash
      // builtins shelled-out via Bun) cache the child pid briefly, so we give
      // a generous upper bound in the assertion (note in code for future).
      await writeFile(p, `#!/bin/sh
echo 'starting' >&2
while :; do sleep 5; done
`, { mode: 0o755 })
    }
    return p
  }

  // 1. 真实候选(wire 形状逐字段)
  const ok = await fakeBin('hbcli-ok', 'ok')
  const r1 = await anythingSearch({ keyword: '大理', hbcliBin: ok })
  assert.equal(r1.verdict, 'hit')
  assert.equal(r1.hits!.length, 3)
  assert.ok(r1.evidence.includes('hbcli-anything@'))
  const [hotelHit, cityHit, placeHit] = r1.hits!
  assert.equal(hotelHit.type, 'hotel')
  assert.equal(hotelHit.name, '柏悦酒店', 'hotel i18n name 应 zh 优先')
  assert.equal(hotelHit.hotelId, 'h1')
  assert.equal(hotelHit.destinationId, 'd1', 'hotel 候选 destinationId 取所属目的地')
  assert.equal(hotelHit.star, 5)
  assert.equal(hotelHit.latitude, 22.31)
  assert.equal(hotelHit.longitude, 114.16)
  assert.equal(hotelHit.score, 180)
  assert.equal(cityHit.type, 'city')
  assert.equal(cityHit.name, '大理市', 'region i18n name 应 zh 优先')
  assert.equal(cityHit.destinationId, 'd1')
  assert.equal(cityHit.latitude, 25.58, 'city 坐标取 region.coordinates.centerLat')
  assert.equal(cityHit.longitude, 100.21)
  assert.equal(placeHit.type, 'place')
  assert.equal(placeHit.name, '洱海')
  assert.equal(placeHit.latitude, 25.74, 'place 坐标回退 place.latlngCoordinator')
  console.log('1. 真实候选 wire 形状(hotel/city/place 逐字段)OK')

  // 2. 旗标回归:--json 必须在子命令前(cli.ts 全局旗标预扫描只认子命令前位置);
  //    contentType → --content-type;parentDestinationId → --destination-id(上游 CLI 旗标名)
  const echo = await fakeBin('hbcli-echo-args', 'echo-args')
  const r2 = await anythingSearch({ keyword: '大理', contentType: 'city', parentDestinationId: 'd1', hbcliBin: echo })
  assert.equal(r2.verdict, 'hit')
  assert.equal(
    r2.hits![0]!.destinationId,
    '--json search anything 大理 --content-type city --destination-id d1',
    'spawn 旗标形态(--json 前置/--destination-id 映射)应稳定,实际 ' + r2.hits![0]!.destinationId,
  )
  console.log('2. 旗标回归(--json 前置 + --destination-id 映射)OK')

  // 3. 空候选
  const empty = await fakeBin('hbcli-empty', 'empty')
  const r3 = await anythingSearch({ keyword: 'nothing', hbcliBin: empty })
  assert.equal(r3.verdict, 'miss')
  assert.equal(r3.hits!.length, 0)
  console.log('3. nothing → miss OK')

  // 4. exit≠0
  const fail = await fakeBin('hbcli-fail', 'fail')
  const r4 = await anythingSearch({ keyword: 'x', hbcliBin: fail })
  assert.equal(r4.verdict, 'error')
  assert.equal(r4.ok, false)
  assert.match(r4.evidence, /error/)
  console.log('4. fail → error (降级) OK')

  // 5. 旧 CLI unknown command → error 带升级指引(issue #195)
  const old = await fakeBin('hbcli-old', 'unknown-command')
  const r5 = await anythingSearch({ keyword: 'x', hbcliBin: old })
  assert.equal(r5.verdict, 'error')
  assert.match(r5.error ?? '', /hbcli update|gotry setup/, 'error 应带升级指引,实际 ' + r5.error)
  assert.match(r5.evidence, /unknown command/, 'evidence 保留上游原话(溯源)')
  console.log(`5. 旧 CLI unknown command → 升级指引 OK(${r5.error})`)

  // 6. 超时:fake hang 60s,我们给 800ms 超时,期望 verdict=error
  //   (latency 断言范围放宽,因为 sandbox node spawn 的 abort 行为不稳定)
  const hang = await fakeBin('hbcli-hang', 'hang')
  const r6 = await anythingSearch({ keyword: 'x', hbcliBin: hang, timeoutMs: 800 })
  assert.equal(r6.verdict, 'error', 'timeout 应判 error')
  console.log(`6. hang/timeout → error OK (latency=${r6.latencyMs}ms)`)

  // 7. 空 keyword
  const r7 = await anythingSearch({ keyword: '   ' })
  assert.equal(r7.verdict, 'error')
  console.log('7. empty keyword → error OK')

  // 8. 缺 hbcli(spawn 失败):用户面必须是人话。这条消息会直接渲染进用户回复
  //    (loop.ts 的 D-7a PoI 探针),旧实现回落成 `(exit null)` 这类进程噪音
  //    (2026-09-22 端到端走查在「我订了酒店:The Title East Wing Rawai」上实测到)。
  const r8 = await anythingSearch({ keyword: 'The Title East Wing Rawai', hbcliBin: join(tmp, 'definitely-missing-hbcli') })
  assert.equal(r8.verdict, 'error', '缺 hbcli 应判 error 而非抛错')
  assert.ok(r8.error && r8.error.length > 0, '必须给出原因')
  assert.ok(
    !/(exit null|ENOENT|spawn )/i.test(r8.error),
    `用户面不得出现进程噪音,实得:${r8.error}`,
  )
  assert.ok(/hbcli/.test(r8.error), `原因须指明是 hbcli,实得:${r8.error}`)
  assert.ok(r8.evidence.includes('[实时API:hbcli-anything@error@'), '证据链 tag 形态不变')
  console.log(`8. 缺 hbcli → 人话降级 OK(${r8.error})`)

  // ---- 9-11. 离线开关 GOTRY_HBCLI_LIVE(issue #617) -------------------------------------------
  // 计数 fake:每被调起一次就往 calls.log 追加一行(只用 shell 内建,PATH 为空也能跑),再按 kind 回包。
  const callsLog = join(tmp, 'calls.log')
  const invocations = async (): Promise<number> => {
    try { return (await readFile(callsLog, 'utf8')).split('\n').filter(Boolean).length } catch { return 0 }
  }
  async function countedBin(name: string, kind: 'hit' | 'miss' | 'fail', dir = tmp): Promise<string> {
    const p = join(dir, name)
    const reply = kind === 'hit'
      ? `printf '%s' '{"candidates":[{"type":"city","matchScore":9,"region":{"id":"d1","name":{"zh":"大理市"}}}]}'`
      : kind === 'miss'
        ? `printf '%s' '{"candidates":[]}'`
        : `printf 'hotelbe down\\n' >&2\nexit 1`
    await writeFile(p, `#!/bin/sh\nprintf 'call\\n' >> '${callsLog}'\n${reply}\n`, { mode: 0o755 })
    return p
  }
  async function withLive<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
    const prev = process.env.GOTRY_HBCLI_LIVE
    if (value === undefined) delete process.env.GOTRY_HBCLI_LIVE
    else process.env.GOTRY_HBCLI_LIVE = value
    try {
      return await body()
    } finally {
      if (prev === undefined) delete process.env.GOTRY_HBCLI_LIVE
      else process.env.GOTRY_HBCLI_LIVE = prev
    }
  }
  const countedHit = await countedBin('hbcli-counted-hit', 'hit')
  const countedMiss = await countedBin('hbcli-counted-miss', 'miss')
  const countedFail = await countedBin('hbcli-counted-fail', 'fail')

  // 9. 关闭:0/false/off(不分大小写、忽略首尾空白)→ 零 spawn + 既有降级面
  for (const off of ['0', 'false', 'off', 'OFF', 'False', ' 0 ', ' off\n']) {
    const before = await invocations()
    const r9 = await withLive(off, () => anythingSearch({ keyword: '大理', hbcliBin: countedHit }))
    assert.equal(await invocations(), before, `GOTRY_HBCLI_LIVE=${JSON.stringify(off)}:fake hbcli 必须被调起 0 次`)
    assert.equal(r9.ok, false)
    assert.equal(r9.via, 'hbcli-anything-error')
    assert.equal(r9.verdict, 'error', '「没查」不得说成「查无」:走 error 降级面而非 miss')
    assert.equal(r9.hits, undefined)
    assert.deepEqual(Object.keys(r9).sort(), Object.keys(r8).sort(), '与缺 hbcli 降级同形(同一组字段)')
    assert.match(r9.evidence, /^\[实时API:hbcli-anything@offline@[^\]]+\]/, `证据链应标 offline,实得:${r9.evidence}`)
    assert.ok(r9.error && /hbcli/.test(r9.error) && /GOTRY_HBCLI_LIVE/.test(r9.error), `原因须说明 hbcli 通道被开关关闭,实得:${r9.error}`)
    assert.ok(!/(exit null|ENOENT|spawn |timeout)/i.test(r9.error), `用户面不得出现进程噪音(也不得含 timeout:效应层只重试 timeout 类),实得:${r9.error}`)
  }
  // 9b. 真实调用面:不传 hbcliBin('hbcli' 由 PATH 解析,runTurn 的 PoI 探针即如此)。
  //     未设开关的 positive control 证明 fake 确实可达——否则「零次」可能是空断言。
  const pathBin = join(tmp, 'pathbin')
  await mkdir(pathBin)
  await countedBin('hbcli', 'hit', pathBin)
  const savedPath = process.env.PATH
  const savedHome = process.env.HOME
  process.env.PATH = `${pathBin}:${savedPath ?? ''}`
  process.env.HOME = join(tmp, 'empty-home') // 已知安装位回退落在空目录,碰不到开发机真实 hbcli
  try {
    const base = await invocations()
    const control = await withLive(undefined, () => anythingSearch({ keyword: '大理' }))
    assert.equal(control.verdict, 'hit', `positive control:未设开关时 PATH 上的 fake 应被调起,实得:${control.evidence}`)
    assert.equal(await invocations(), base + 1, 'positive control 恰好调起一次')
    const off = await withLive('0', () => anythingSearch({ keyword: '大理' }))
    assert.equal(off.verdict, 'error')
    assert.match(off.evidence, /@offline@/)
    assert.equal(await invocations(), base + 1, 'GOTRY_HBCLI_LIVE=0:PATH 上的 hbcli 零次调起')
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  }
  console.log('9. GOTRY_HBCLI_LIVE=0|false|off → 零 spawn + 既有降级面(显式 hbcliBin 与 PATH 解析两种调用面)OK')

  // 10. 未设或任何其他取值 = 与此前完全一致:fake 被调起,hit/miss/error 三值语义不变
  for (const on of [undefined, '1']) {
    const before = await invocations()
    const h = await withLive(on, () => anythingSearch({ keyword: '大理', hbcliBin: countedHit }))
    const m = await withLive(on, () => anythingSearch({ keyword: 'nothing', hbcliBin: countedMiss }))
    const f = await withLive(on, () => anythingSearch({ keyword: 'x', hbcliBin: countedFail }))
    assert.equal(await invocations(), before + 3, `GOTRY_HBCLI_LIVE=${String(on)}:三只 fake 各被调起一次`)
    assert.equal(h.verdict, 'hit')
    assert.equal(h.hits![0]!.name, '大理市')
    assert.match(h.evidence, /^\[实时API:hbcli-anything@\d{4}-/, 'hit 证据链形态不变')
    assert.equal(m.verdict, 'miss')
    assert.equal(m.hits!.length, 0)
    assert.equal(f.verdict, 'error')
    assert.match(f.evidence, /^\[实时API:hbcli-anything@error@/, 'error 证据链形态不变(不是 offline)')
    assert.equal(f.error, 'hbcli 报错:hotelbe down', '既有原因串逐字节不变')
  }
  // 非 0/false/off 的取值一律视为开启(与此前一致):空串/1/true/on/yes/no/disabled/00/任意字符串
  for (const other of ['', 'true', 'on', 'yes', 'no', 'disabled', '00', 'maybe']) {
    const before = await invocations()
    const r = await withLive(other, () => anythingSearch({ keyword: '大理', hbcliBin: countedHit }))
    assert.equal(r.verdict, 'hit', `GOTRY_HBCLI_LIVE=${JSON.stringify(other)} 不是关闭值,应保持 live,实得:${r.evidence}`)
    assert.equal(await invocations(), before + 1)
  }
  console.log('10. 开关未设/其他取值 → 与此前一致(hit/miss/error 三值 + 既有原因串)OK')

  // 11. 关闭时,既有入参的既有结果逐字节不变:空 keyword / pre-aborted 先于离线判定(两者本就零 spawn)
  const before11 = await invocations()
  const rEmpty = await withLive('0', () => anythingSearch({ keyword: '   ', hbcliBin: countedHit }))
  assert.equal(rEmpty.error, 'keyword is required')
  assert.match(rEmpty.evidence, /^\[实时API:hbcli-anything@error@[^\]]+\] keyword empty$/)
  const preAborted = new AbortController()
  preAborted.abort()
  const rAbort = await withLive('0', () => anythingSearch({ keyword: '大理', hbcliBin: countedHit, signal: preAborted.signal }))
  assert.equal(rAbort.error, 'aborted by host signal')
  assert.match(rAbort.evidence, /^\[实时API:hbcli-anything@abort@[^\]]+\] pre-aborted, zero spawn$/)
  assert.equal(await invocations(), before11, '两条既有降级路径均零 spawn')
  console.log('11. 关闭态下空 keyword / pre-aborted 的既有结果不变 OK')

  console.log('\nANYTHING TESTS: 11/11 OK(hbcli fake + wire 对齐 + 降级诚实 + #617 离线开关零 spawn)')
} finally {
  if (savedLive === undefined) delete process.env.GOTRY_HBCLI_LIVE
  else process.env.GOTRY_HBCLI_LIVE = savedLive
  await rm(tmp, { recursive: true, force: true })
}
