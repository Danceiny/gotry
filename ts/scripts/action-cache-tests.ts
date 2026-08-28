/**
 * action-cache 自愈层确定性测试(RFC P2;run-all §25):
 * 命中/指纹失配/TTL 过期/变量化 key/LRU 淘汰/损坏文件容错/持久化跨实例/幂等回写。
 * 全纯函数 + 临时目录,零浏览器零网络。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ActionCache, actionCachePath, fingerprint, templateKey } from '../capabilities/session/action-cache.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { pass += 1; console.log(`  ok - ${label}`) } else { fail += 1; console.log(`  FAIL - ${label}${detail !== undefined ? ' :: ' + String(detail) : ''}`) }
}

const iso = mkdtempSync(join(tmpdir(), 'gotry-actioncache-'))
const path = actionCachePath(iso)
const T0 = new Date('2026-08-28T10:00:00Z')
let clock = T0.getTime()
const now = () => new Date(clock)
const site = 'ctrip-flight'

console.log('A. templateKey(参数变量化)')
const k1 = templateKey(site, 'search', { from: '上海', to: '丽江', date: '2026-10-01' })
const k2 = templateKey(site, 'search', { from: '上海', to: '丽江', date: '2026-11-11' })
assert(k1 === k2 && k1 === 'ctrip-flight:search:上海|丽江|%date%', '同型查询共享模板 key(日期变量化),跨日期复用')

console.log('B. 命中与指纹失配(被动失效)')
const c = new ActionCache(path, { now })
const fpA = fingerprint('batchSearch v1 shape {"flightItineraryList":[]}')
const fpB = fingerprint('batchSearch v2 shape {"itineraries":[]}') // 接口改版
c.record(k1, fpA, { entryUrl: 'https://flights.ctrip.com/online/list/oneway-sha-ljg?depdate=%date%', parser: 'batchSearch.v1' }, site)
clock += 60_000
assert(c.lookup(k1, fpA, site)?.locator.parser === 'batchSearch.v1', '指纹一致 → 命中并回放确定性载荷')
assert(c.lookup(k1, fpA, site)?.hits === 2, '命中计 hits')
assert(c.lookup(k1, fpB, site) === null, '接口改版(指纹失配)→ miss 不误放(错误的缓存点击比慢更糟)')
assert(c.lookup(templateKey(site, 'search', { from: '北京', to: '大理', date: '2026-10-01' }), fpA, site) === null, 'key 不同 → miss')

console.log('C. miss 回写与幂等')
c.record(k1, fpB, { entryUrl: 'oneway-bjs-dlu?depdate=%date%', parser: 'batchSearch.v2' }, site)
assert(c.lookup(k1, fpB, site)?.locator.parser === 'batchSearch.v2', '改版后回写新载荷,下次命中')
const hitsBefore = c.lookup(k1, fpB, site)!.hits
c.record(k1, fpB, { parser: 'batchSearch.v2' }, site)
assert(c.lookup(k1, fpB, site)!.hits === hitsBefore + 1, '重复 record 幂等(hits/createdAt 保留,不重置)')

console.log('D. TTL 过期(48h 默认;注入时钟)')
clock += 49 * 3600_000
assert(c.lookup(k1, fpB, site) === null && c.size(site) === 0, '超 48h → 过期删除条目')

console.log('E. LRU 淘汰(每站点上限)')
const c2 = new ActionCache(path + '.lru', { now, maxEntriesPerSite: 3 })
for (let i = 0; i < 5; i++) {
  const key = `ctrip-flight:search:城${i}|丽江|%date%`
  c2.record(key, fingerprint(`shape-${i}`), { i: String(i) }, site)
  clock += 1_000
}
assert(c2.size(site) === 3, '超容 LRU 淘汰至 3 条')

console.log('F. 持久化跨实例 + 损坏文件容错')
const c3 = new ActionCache(path + '.p', { now })
c3.record('meituan:search:大理|民宿|%date%', fingerprint('mt-shape'), { url: 'https://www.meituan.com/...' }, 'meituan')
clock += 5_000
const c4 = new ActionCache(path + '.p', { now })
assert(c4.lookup('meituan:search:大理|民宿|%date%', fingerprint('mt-shape'), 'meituan') !== null, '跨实例:落盘后新实例可命中')
writeFileSync(path + '.broken', '{not json', 'utf8')
const c5 = new ActionCache(path + '.broken', { now })
assert(c5.size() === 0 && c5.lookup('any', 'any', site) === null, '损坏 JSON 按空缓存,不抛错')

console.log('G. fingerprint 敏感度')
assert(fingerprint('abc') !== fingerprint('abd') && fingerprint('abc') === fingerprint('abc'), '微改即变,同文稳定')

rmSync(iso, { recursive: true, force: true })
console.log(`\nACTION-CACHE: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
