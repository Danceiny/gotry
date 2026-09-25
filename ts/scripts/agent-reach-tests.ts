/**
 * agent-reach web 读取(readUrl 薄壳)测试:
 *  readUrl = URL 校验 + 委托上游 WebChannel.read(反射桥) + Title 提取,自身无网络实现。
 *  上游真读已在 §15 wrapper 测试覆盖;本套只测薄壳行为:
 *  1. 非法 URL(不带 http) → 拒绝,不抛错,降级返回(离线确定性)
 *  2. 1ms 超时 → 桥被杀,降级 error(离线确定性)
 *  3. live 读 example.com → 成功时断言 Title/证据链;网络边界允许降级(不抛错)
 *
 * §4-§13 离线注入(deps.run/venvPython;issue #559 卡点#2 收尾:failure 人话面):
 *  4. Python traceback → error 人话(末行异常本体),evidence 保留原话
 *  5. 超时 → 人话超时,空错误串不可能
 *  6. 非零退出无 stderr → 退出码人话
 *  7. code=null 零输出 → 进程异常结束人话
 *  8. bridge error="" 空串陷阱 → 落人话,不透传空串
 *  9. bridge 结构化 error 人话透传保持
 * 10. exit-2 inventory 自描述路径不受影响
 * 11. check warn/off setup 透传路径不受影响
 * 12. humanizeBridgeFailure 纯函数单元(traceback 末行/普通 join/空兜底)
 * 13. 注入 run reject → 永不抛错的字面兑现(结构化降级)
 *
 * 运行: cd ts && npx tsx scripts/agent-reach-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { humanizeBridgeFailure, reach, readUrl, type ReachRunFn } from '../capabilities/agent-reach.ts'

// 1. 非法 URL(不带 scheme)
{
  const r = await readUrl({ url: 'example.com' })
  assert.equal(r.ok, false)
  assert.equal(r.via, 'r.jina.ai-error')
  assert.ok(r.evidence.includes('error'), 'evidence 带 error')
  console.log('1. 非法 URL 拒绝 OK')
}

// 2. 超时(1ms 杀掉反射桥进程)
{
  const r = await readUrl({ url: 'https://example.com', timeoutMs: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.via, 'r.jina.ai-error')
  assert.ok(r.latencyMs >= 0, '永不抛错')
  console.log('2. 超时降级 OK')
}

// 3. live 读 example.com(上游 Jina Reader;网络边界允许降级)
{
  const r = await readUrl({ url: 'https://example.com', timeoutMs: 30_000 })
  if (r.ok) {
    assert.ok(r.evidence.includes('[agent-reach:web.read@'), '证据链')
    assert.match(r.evidence, /\[agent-reach:web\.read@2\d{3}-\d{2}-\d{2}T/, '证据链带 ISO 时间戳')
    assert.ok(typeof r.content === 'string' && r.content.length > 0, 'content 非空')
    // live 内容会漂移(example.com 经 Jina 的 Title 曾从 Example Domain 变 Test Document),
    // 断言结构(非空标题被提取)而非精确文案
    assert.ok(typeof r.title === 'string' && r.title.length > 0, `Title 提取,实际 ${r.title}`)
    console.log(`3. readUrl example.com → ok (title=${r.title}) OK`)
  } else {
    assert.equal(r.via, 'r.jina.ai-error')
    console.log(`3. readUrl example.com → 降级(${r.error?.slice(0, 60)})(网络边界,合法) OK`)
  }
}

console.log('\nAGENT-REACH TESTS(§1-§3 readUrl 薄壳)OK\n')

// ---------------------------------------------------------------- §4-§13 离线注入
// issue #559 卡点#2 收尾:failure 人话面。全部走 deps 注入,零真进程零网络。

type RunOut = Awaited<ReturnType<ReachRunFn>>
function fakeRun(out: Partial<RunOut>): ReachRunFn {
  return async () => ({ code: 0, stdout: '', stderr: '', ...out }) as RunOut
}
const offlineDeps = (out: Partial<RunOut>) => ({
  run: fakeRun(out),
  venvPython: () => process.execPath, // 存在的任一文件,绕过 not-installed 早退
})

// 4. Python traceback → error 人话(末行异常本体),evidence 保留原话
{
  const r = await reach({ channel: 'web', method: 'read' }, offlineDeps({
    code: 1,
    stderr: 'Traceback (most recent call last):\n  File "agent-reach-bridge.py", line 42, in <module>\nKeyError: web_read',
  }))
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'error')
  assert.match(r.error ?? '', /agent-reach web\.read 报错:KeyError: web_read/, `实际 ${r.error}`)
  assert.ok(!/Traceback/i.test(r.error ?? ''), 'traceback 噪音不进 error')
  assert.ok(r.evidence.includes('Traceback'), '上游原话保留在 evidence(溯源契约)')
  assert.ok(r.evidence.includes('[agent-reach:web.read@error@'), '证据链前缀保持')
  console.log('4. Python traceback → error 人话 + evidence 原话 OK')
}

// 5. 超时 → 人话超时(timedOut 优先于 stderr 细节;空错误串不可能)
{
  const r = await reach({ channel: 'web', method: 'read' }, offlineDeps({
    code: null, stderr: 'partial stderr before kill', timedOut: true,
  }))
  assert.equal(r.verdict, 'error')
  assert.match(r.error ?? '', /超时.*降级处理/, `实际 ${r.error}`)
  assert.ok((r.error ?? '').length > 0, 'error 非空')
  assert.ok(!r.error?.includes('partial stderr'), '超时态不掺 stderr 细节')
  console.log('5. 超时 → 人话超时 OK')
}

// 6. 非零退出无 stderr → 退出码人话
{
  const r = await reach({ channel: 'v2ex', method: 'get_hot_topics' }, offlineDeps({ code: 3 }))
  assert.equal(r.verdict, 'error')
  assert.match(r.error ?? '', /退出码 3.*降级处理/, `实际 ${r.error}`)
  console.log('6. 非零退出 → 退出码人话 OK')
}

// 7. code=null 零输出 → 进程异常结束人话
{
  const r = await reach({ channel: 'web', method: 'read' }, offlineDeps({ code: null, stdout: '', stderr: '' }))
  assert.equal(r.verdict, 'error')
  assert.match(r.error ?? '', /未返回可判定结果.*进程异常结束/, `实际 ${r.error}`)
  console.log('7. code=null 零输出 → 进程异常结束人话 OK')
}

// 8. bridge error="" 空串陷阱 → 落人话,不透传空串(旧实现 `??` 只拦 nullish)
{
  const r = await reach({ channel: 'web', method: 'read' }, offlineDeps({
    code: 1, stdout: '{"ok":false,"error":""}\n',
  }))
  assert.equal(r.verdict, 'error')
  assert.ok((r.error ?? '').length > 0, `error 非空(实际 ${JSON.stringify(r.error)})`)
  assert.match(r.error ?? '', /agent-reach web\.read/, '空串落人话兜底')
  console.log('8. bridge 空错误串陷阱 → 人话兜底 OK')
}

// 9. bridge 结构化 error(人话形态)透传保持
{
  const r = await reach({ channel: 'web', method: 'read' }, offlineDeps({
    code: 1, stdout: '{"ok":false,"error":"上游 Jina Reader 超时"}\n',
  }))
  assert.equal(r.verdict, 'error')
  assert.equal(r.error, '上游 Jina Reader 超时', 'bridge 自报人话错误原样透传')
  console.log('9. bridge 结构化 error 透传 OK')
}

// 10. exit-2 inventory 自描述路径不受影响
{
  const r = await reach({ channel: 'nosuch', method: 'foo' }, offlineDeps({
    code: 2, stdout: '{"error":"unknown channel","channels":{"web":"WebChannel"}}\n',
  }))
  assert.equal(r.verdict, 'error')
  assert.equal(r.error, 'unknown channel')
  const channels = (r.inventory?.channels ?? {}) as Record<string, string>
  assert.equal(channels.web, 'WebChannel', 'inventory 带回渠道清单')
  console.log('10. exit-2 inventory 自描述路径保持 OK')
}

// 11. check warn/off setup 透传路径不受影响
{
  const r = await reach({ channel: 'xueqiu', method: 'get_stock_quote' }, offlineDeps({
    code: 1, stdout: '{"error":"no cookie","check":{"status":"warn","message":"configure cookies via agent-reach configure"}}\n',
  }))
  assert.equal(r.verdict, 'needs-setup')
  assert.equal(r.error, 'no cookie')
  assert.ok((r.setup ?? '').includes('configure'), 'setup 透传上游 check() 原话')
  console.log('11. check warn setup 透传路径保持 OK')
}

// 12. humanizeBridgeFailure 纯函数单元
{
  // traceback 末行提取
  const t = humanizeBridgeFailure('agent-reach web.read', {
    code: 1,
    stderr: 'Traceback (most recent call last):\n  File "x.py", line 1\nRuntimeError: boom',
  })
  assert.ok(t.includes('RuntimeError: boom') && !/Traceback/i.test(t), `traceback 末行,实际 ${t}`)
  // 普通 stderr 原样 join
  const p = humanizeBridgeFailure('agent-reach v2ex.x', { code: 1, stderr: 'some upstream note\nsecond line' })
  assert.ok(p.includes('some upstream note second line'), `普通 stderr,实际 ${p}`)
  // 全空 → code 兜底
  const e = humanizeBridgeFailure('agent-reach web.read', { code: null, stderr: '', stdout: '' })
  assert.ok(e.includes('进程异常结束'), `code=null 兜底,实际 ${e}`)
  // stdout 兜底(stderr 空时)
  const s = humanizeBridgeFailure('agent-reach web.read', { code: 1, stderr: '', stdout: 'weird non-json output' })
  assert.ok(s.includes('weird non-json output'), `stdout 兜底,实际 ${s}`)
  // 截断到只剩 traceback 首行 → 不放行噪音,回落退出码人话
  const t1 = humanizeBridgeFailure('agent-reach web.read', { code: 1, stderr: 'Traceback (most recent call last):' })
  assert.ok(!/traceback/i.test(t1) && t1.includes('退出码 1'), `截断首行回落,实际 ${t1}`)
  console.log('12. humanizeBridgeFailure 纯函数单元 OK')
}

// 13. 注入 run reject → 永不抛错的字面兑现(结构化降级)
{
  const boom: ReachRunFn = async () => { throw new Error('injected spawn explosion') }
  const r = await reach({ channel: 'web', method: 'read' }, { run: boom, venvPython: () => process.execPath })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'error')
  assert.match(r.error ?? '', /调用异常.*降级处理/, `实际 ${r.error}`)
  assert.ok(r.error?.includes('injected spawn explosion'), '异常消息截断保留(诊断面)')
  console.log('13. 注入 reject → 结构化降级不抛错 OK')
}

console.log(`\nAGENT-REACH TESTS: 13/13 OK(readUrl 薄壳 3 + #559 卡点#2 人话面注入 10;venvPython=${existsSync(process.execPath) ? 'ok' : 'missing'})`)
