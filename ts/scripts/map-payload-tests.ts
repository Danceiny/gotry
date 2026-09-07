/**
 * map-tools 自带 payload 测试(issue #202;全离线):
 *  1. payload 文件面在位(lib/index.js + MIT LICENSE)且 package.json files 携带
 *  2. ts/package.json 不再依赖 dsh-map-tools(peer 冲突根除,严格 npm ci 可解析)
 *  3. 三面解析候选(inner/bootstrap/doctor)都含 vendor payload 路径
 *  4. 插件 apply 注册恰好 7 个 map_* 工具(driving/transit/walking/bicycling + 地理编码 + POI)
 *  5. 根 lock 无 dsh-map-tools 残留
 *
 * 运行: cd ts && npx tsx scripts/map-payload-tests.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = join(process.cwd(), '..')

// 1. payload 文件面
const payloadLib = join(repoRoot, 'vendor', 'map-tools', 'lib', 'index.js')
const payloadLicense = join(repoRoot, 'vendor', 'map-tools', 'LICENSE')
const payloadPkg = JSON.parse(readFileSync(join(repoRoot, 'vendor', 'map-tools', 'package.json'), 'utf-8'))
assert.ok(readFileSync(payloadLib, 'utf-8').includes('export function apply'), 'payload lib/index.js 应在位')
assert.ok(readFileSync(payloadLicense, 'utf-8').includes('MIT'), 'payload 应携带 MIT LICENSE')
assert.equal(payloadPkg.name, '@danceiny/dsh-map-tools-payload', 'payload 包名应隔离 upstream')
assert.deepEqual(payloadPkg.dependencies, {}, 'payload 应零运行时依赖(适配后自带)')
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
assert.ok((rootPkg.files ?? []).includes('vendor/map-tools/'), 'npm files 应携带 payload')

// 2. ts 依赖根除
const tsPkg = JSON.parse(readFileSync(join(repoRoot, 'ts', 'package.json'), 'utf-8'))
assert.equal(tsPkg.dependencies?.['dsh-map-tools'], undefined, 'ts/package.json 不应再依赖 dsh-map-tools(peer 冲突源)')

// 3. 三面解析候选
for (const file of ['bin/gotry-inner.js', 'bin/gotry-bootstrap.js', 'ts/capabilities/doctor.ts']) {
  const text = readFileSync(join(repoRoot, file), 'utf-8')
  assert.ok(text.includes('vendor/map-tools'), `${file} 解析候选应含 vendor payload`)
}

// 5. lock 无残留
const lock = readFileSync(join(repoRoot, 'ts', 'package-lock.json'), 'utf-8')
assert.ok(!lock.includes('dsh-map-tools'), 'ts lock 不应残留 dsh-map-tools')

// 4. 插件 apply:注册恰好 7 个 map_* 工具(stub ctx,离线)
const registered: Array<{ name: string }> = []
const { apply } = await import(pathToFileURL(payloadLib).href) as unknown as {
  apply: (ctx: unknown, config: unknown) => void
}
apply({
  tools: { register: (t: { name: string }) => registered.push(t) },
  effect: (fn: () => unknown) => { void fn() },
  inject: (_deps: string[], _cb: (scope: unknown) => void) => { /* 无 webServer/settings 的离线 stub */ },
}, {})
const names = registered.map(t => t.name).sort()
assert.equal(names.length, 7, `应注册 7 个 map_* 工具,实际 ${names.length}:${names.join(',')}`)
assert.ok(names.every(n => n.startsWith('map_')), '全部工具应以 map_ 前缀命名')
assert.ok(names.includes('map_driving_route') && names.includes('map_transit_route')
  && names.includes('map_walking_route') && names.includes('map_bicycling_route'),
  '四类路线工具应在册')

console.log(`MAP PAYLOAD TESTS: 5/5 OK(文件面/MIT 携带/依赖根除/三面候选/7 工具注册:${names.join(',')})`)
