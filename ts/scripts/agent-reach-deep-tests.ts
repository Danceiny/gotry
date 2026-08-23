/**
 * agent-reach 深度能力层测试(yt-dlp + gh,系统装了就调,没装降级):
 *  1. yt-dlp:无论装没装,三值之一(found/not-installed/error)且不抛错
 *  2. gh 搜索:gh 已装的环境真实搜 agent-reach;未装环境走 not-installed
 *  3. 证据链标注含 [agent-reach:<bin>@
 *  4. 超时降级
 *
 * 运行: cd ts && npx tsx scripts/agent-reach-deep-tests.ts
 */

import assert from 'node:assert/strict'
import { videoSubtitle, githubSearch } from '../capabilities/agent-reach-deep.ts'

// 1. yt-dlp 三值
{
  const r = await videoSubtitle({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', timeoutMs: 15_000 })
  assert.ok(['found', 'not-installed', 'error', 'timeout'].includes(r.verdict), `verdict 三值之一: ${r.verdict}`)
  assert.ok(r.evidence.includes('[agent-reach:yt-dlp@'), '证据链前缀')
  console.log(`1. yt-dlp → ${r.verdict} (${r.latencyMs}ms) OK`)
}

// 2. gh 搜索(装了就真实搜,没装走 not-installed)
{
  const r = await githubSearch({ query: 'agent-reach', limit: 3 })
  assert.ok(['found', 'not-installed', 'error', 'timeout'].includes(r.verdict))
  if (r.verdict === 'found') {
    assert.ok((r.repos?.length ?? 0) > 0, 'found 应有 repos')
    const top = r.repos![0]!
    console.log(`2. gh search → found (top: ${top.name} ★${top.stars}) OK`)
  } else {
    console.log(`2. gh search → ${r.verdict} (${r.stderr?.slice(0, 60)}) OK`)
  }
}

// 3. 证据链格式
{
  const r = await githubSearch({ query: 'hello' })
  assert.match(r.evidence, /\[agent-reach:gh@/, 'gh 证据链')
  console.log('3. 证据链格式 OK')
}

// 4. 超时降级(1ms timeout)
{
  const r = await githubSearch({ query: 'hello', timeoutMs: 1 })
  assert.ok(['timeout', 'error', 'not-installed'].includes(r.verdict))
  console.log(`4. 超时 → ${r.verdict} OK`)
}

console.log('\nAGENT-REACH DEEP TESTS: 4/4 OK(yt-dlp/gh 可选工具,不装则降级)')
