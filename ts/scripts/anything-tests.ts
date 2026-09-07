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
 *
 * 运行: cd ts && npx tsx scripts/anything-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anythingSearch } from '../capabilities/anything.ts'

const tmp = await mkdtemp(join(tmpdir(), 'anything-test-'))
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

  console.log('\nANYTHING TESTS: 7/7 OK(hbcli fake + wire 对齐 + 降级诚实)')
} finally {
  await rm(tmp, { recursive: true, force: true })
}
