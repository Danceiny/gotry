/**
 * agent-reach wrapper 确定性失败面测试(fake python 注入,零网络/零 venv):
 *  issue #559 第五缺口回归锁——用户面失败文案必须是人话:有原因、有源归属
 *  (agent-reach)、有受影响能力(channel.method)、有下一步(gotry_doctor/setup/清单);
 *  桥进程 stderr 与桥结构化异常原话(任意上游文本,可含凭证 URL/traceback)一律不透传;
 *  形状不对的桥 JSON(null/数组/字段错型)永不抛错;setup(上游 check() 原话)与
 *  inventory(上游注册表本体)透传契约不变。anything.ts failureReason 同构口径。
 *
 *  1. 成功数据回归锁:桥 ok JSON → found + data 原样
 *  2. stderr 噪音不降级:exit 0 + 好结果 + 库 warning → 仍 found
 *  3. needs-setup 锁:setup 原话透传;error 安全分类
 *  4. 未知渠道锁:inventory 透传;error 安全描述
 *  5. 缺可执行 python(pythonBin 指向不存在路径)→ not-installed + doctor 指引
 *  6. 可执行存在但解释器缺失(坏 shebang → spawn ENOENT)→ not-installed
 *  7. 缺 agent_reach 包(桥 exit 3 未装 JSON)→ not-installed
 *  8. 超时(桥挂死被 SIGKILL)→ error + 人话超时,不留空 error
 *  9. 输出不可解析(半截 JSON + traceback/凭证样 stderr)→ error 不漏原文
 *  10. 非零退出 + stderr(空 stdout)→ error 不漏 stderr 原文,有原因有下一步
 *  11. 空响应(exit 0 零输出零 stderr)→ error 有原因有下一步
 *  12. 桥结构化 error 含凭证样 URL → 不透传,分类安全文案
 *  13. 形状不对的桥 JSON(null/数组/error 数字或对象/check 错型)→ 永不抛错
 *  14. readUrl 产品边界:缺 venv 指引穿透(undefined 回归锁)/成功数据/凭证安全
 *
 * 运行: cd ts && npx tsx scripts/agent-reach-error-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reach, readUrl } from '../capabilities/agent-reach.ts'

const tmp = await mkdtemp(join(tmpdir(), 'agent-reach-err-test-'))
try {
  // fake python:模拟反射桥 agent-reach-bridge.py 的进程级行为(桥 JSON 由脚本原样打出)
  async function fakePython(name: string, behaviour:
    'ok' | 'ok-string' | 'ok-with-stderr-noise' | 'needs-setup' | 'not-installed-pkg' | 'unknown-channel'
    | 'hang' | 'bad-shebang' | 'truncated-json' | 'exit1-stderr' | 'empty'
    | 'cred-error' | 'json-null' | 'json-array' | 'error-number' | 'error-object'
    | 'check-string' | 'check-message-number'): Promise<string> {
    const p = join(tmp, name)
    let body = ''
    if (behaviour === 'ok') {
      body = `cat <<'JSON'
{"ok": true, "data": {"topics": [1, 2, 3]}}
JSON
`
    } else if (behaviour === 'ok-string') {
      // readUrl 成功面:上游 WebChannel.read 的 Jina 首行 Title 形态
      body = `cat <<'JSON'
{"ok": true, "data": "Title: Fake Page\\n\\nhello 正文"}
JSON
`
    } else if (behaviour === 'ok-with-stderr-noise') {
      // 上游库 warning 类 stderr 噪音:不得把好结果打成失败
      body = `echo 'DeprecationWarning: datetime.utcnow() is deprecated' >&2
cat <<'JSON'
{"ok": true, "data": "fine"}
JSON
`
    } else if (behaviour === 'needs-setup') {
      // 桥 exit 3:渠道调用抛错 + 上游 check() 结论(原话透传契约)
      body = `cat <<'JSON'
{"ok": false, "error": "CookieError: not logged in", "check": {"status": "off", "message": "configure cookies via agent-reach login xueqiu"}}
JSON
exit 3
`
    } else if (behaviour === 'not-installed-pkg') {
      // 桥 exit 3:上游 agent_reach 包未装
      body = `cat <<'JSON'
{"ok": false, "error": "agent_reach 未安装: No module named 'agent_reach'"}
JSON
exit 3
`
    } else if (behaviour === 'unknown-channel') {
      // 桥 exit 2:未知渠道 + 上游注册表
      body = `cat <<'JSON'
{"ok": false, "error": "未知渠道 'nosuch'", "channels": {"web": "WebChannel"}}
JSON
exit 2
`
    } else if (behaviour === 'hang') {
      // exec 让 SIGKILL 直接命中 sleep,不留孤儿
      body = `exec sleep 30\n`
    } else if (behaviour === 'bad-shebang') {
      // 文件在但解释器不存在 → spawn 报 ENOENT(venv python 装坏的真实形态)
      await writeFile(p, '#!/no/such/interpreter-xyz\nexit 0\n', { mode: 0o755 })
      return p
    } else if (behaviour === 'truncated-json') {
      // 半截 JSON + traceback/凭证样 stderr(用户面泄漏回归锁,#559)
      body = `printf '%s' '{"ok": true, "data": {"top'
echo 'Traceback (most recent call last):' >&2
echo '  File "agent_reach/channels.py", line 42, in read' >&2
echo 'ConnectionError: 502 for url https://r.jina.ai/?api_key=sk-SECRET-abc123' >&2
`
    } else if (behaviour === 'exit1-stderr') {
      // 进程级失败:非零退出 + 带凭证样片段的 stderr,stdout 全空
      body = `echo "python: can't open file 'agent-reach-bridge.py': cookie=SESSIONID=LEAK-xyz" >&2
exit 1
`
    } else {
      // empty:exit 0,stdout/stderr 全空
      body = `exit 0\n`
    }
    if (behaviour === 'cred-error') {
      // 桥 exit 3:渠道调用抛错,error 是任意上游异常原话(合成凭证 URL,不换行)
      body = `cat <<'JSON'
{"ok": false, "error": "RequestsError: 502 for url https://r.jina.ai/?api_key=sk-LEAK-987654"}
JSON
exit 3
`
    } else if (behaviour === 'json-null') {
      body = `printf 'null'\n`
    } else if (behaviour === 'json-array') {
      body = `printf '[1, 2, 3]'\n`
    } else if (behaviour === 'error-number') {
      body = `cat <<'JSON'
{"ok": false, "error": 987654}
JSON
exit 3
`
    } else if (behaviour === 'error-object') {
      body = `cat <<'JSON'
{"ok": false, "error": {"trace": "RequestsError for url https://r.jina.ai/?api_key=sk-OBJ-LEAK"}}
JSON
exit 3
`
    } else if (behaviour === 'check-string') {
      // check 是字符串(形状错)→ 不得据此判 needs-setup
      body = `cat <<'JSON'
{"ok": false, "check": "off", "error": "boom-raw"}
JSON
exit 3
`
    } else if (behaviour === 'check-message-number') {
      // check.status 合法但 message 非字符串 → 路由照旧,setup 不冒充原话
      body = `cat <<'JSON'
{"ok": false, "check": {"status": "off", "message": 12345}, "error": "boom2"}
JSON
exit 3
`
    }
    await writeFile(p, `#!/bin/sh\n${body}`, { mode: 0o755 })
    return p
  }

  // 1. 成功数据回归锁(分类不得碰成功路径)
  {
    const py = await fakePython('py-ok', 'ok')
    const r = await reach({ channel: 'probe', method: 'read', pythonBin: py })
    assert.equal(r.verdict, 'found')
    assert.deepEqual(r.data, { topics: [1, 2, 3] })
    assert.match(r.evidence, /\[agent-reach:probe\.read@2\d{3}-/, '证据链 tag 形态不变')
    console.log('1. 桥 ok JSON → found + data 原样 OK')
  }

  // 2. stderr 噪音不降级
  {
    const py = await fakePython('py-ok-noise', 'ok-with-stderr-noise')
    const r = await reach({ channel: 'probe', method: 'read', pythonBin: py })
    assert.equal(r.verdict, 'found', '库 warning 不得打成失败')
    console.log('2. stderr 噪音 + 好结果 → 仍 found OK')
  }

  // 3. needs-setup 锁:setup = 上游 check() 原话逐字透传;error 走分类安全文案(桥异常原话不透传)
  {
    const py = await fakePython('py-setup', 'needs-setup')
    const r = await reach({ channel: 'xueqiu', method: 'get_stock_quote', args: ['SH600519'], pythonBin: py })
    assert.equal(r.verdict, 'needs-setup')
    assert.equal(r.setup, 'configure cookies via agent-reach login xueqiu', 'setup = 上游 check() 原话')
    assert.ok(r.error && r.error.length > 0, 'error 必须非空(安全分类文案)')
    assert.ok(!r.error.includes('CookieError'), `桥异常原话不得进 error 面,实得:${r.error}`)
    assert.match(r.error ?? '', /xueqiu\.get_stock_quote/, 'error 须带受影响能力')
    assert.match(r.evidence, /@needs-setup@/)
    console.log('3. needs-setup:setup 原话透传 + error 安全分类 OK')
  }

  // 4. 未知渠道锁:inventory 带回上游注册表;error 用自身查询值给安全描述(桥报错文案是任意上游文本,不透传)
  {
    const py = await fakePython('py-unknown', 'unknown-channel')
    const r = await reach({ channel: 'nosuch', method: 'foo', pythonBin: py })
    assert.equal(r.ok, false)
    const channels = (r.inventory?.channels ?? {}) as Record<string, string>
    assert.equal(channels.web, 'WebChannel', 'inventory 带回上游注册表(本体不受影响)')
    assert.match(r.error ?? '', /nosuch\.foo/, '安全描述带受影响能力,实得:' + r.error)
    assert.match(r.error ?? '', /清单/, '安全描述指明按清单改正')
    assert.match(r.error ?? '', /重调/, '安全描述带下一步')
    assert.notEqual(r.error, "未知渠道 'nosuch'", '桥报错原文不透传')
    console.log('4. 未知渠道 → inventory 透传 + error 安全描述 OK')
  }

  // 5. 缺可执行 python(pythonBin 指向不存在路径;与 anything.ts hbcliBin 注入同构)
  {
    const r = await reach({ channel: 'web', method: 'read', pythonBin: join(tmp, 'definitely-missing-python') })
    assert.equal(r.verdict, 'not-installed')
    assert.match(r.setup ?? '', /doctor --fix/, '带补装指引')
    assert.match(r.evidence, /@not-installed@/)
    console.log('5. 缺 python → not-installed + doctor 指引 OK')
  }

  // 6. 可执行存在但解释器缺失(坏 shebang → spawn ENOENT)
  {
    const py = await fakePython('py-bad-shebang', 'bad-shebang')
    const r = await reach({ channel: 'web', method: 'read', pythonBin: py })
    assert.equal(r.verdict, 'not-installed', `实际 verdict=${r.verdict} error=${r.error}`)
    assert.match(r.setup ?? '', /doctor --fix/, '带补装指引')
    console.log('6. 坏 shebang(ENOENT)→ not-installed OK')
  }

  // 7. 缺 agent_reach 包(桥 exit 3 未装 JSON)
  {
    const py = await fakePython('py-nopkg', 'not-installed-pkg')
    const r = await reach({ channel: 'web', method: 'read', pythonBin: py })
    assert.equal(r.verdict, 'not-installed')
    assert.match(r.setup ?? '', /doctor --fix/, '带补装指引')
    console.log('7. 缺 agent_reach 包 → not-installed OK')
  }

  // 8. 超时:桥挂死被 SIGKILL → 人话超时(旧实现回落成空 error,无原因无下一步)
  {
    const py = await fakePython('py-hang', 'hang')
    const r = await reach({ channel: 'web', method: 'read', args: ['https://example.com'], timeoutMs: 400, pythonBin: py })
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'error')
    assert.ok(r.error && r.error.length > 0, `必须给出原因,实得:${JSON.stringify(r.error)}`)
    assert.ok(/超时/.test(r.error), `原因须指明超时,实得:${r.error}`)
    assert.ok(/agent-reach/.test(r.error), `须有源归属,实得:${r.error}`)
    assert.ok(/timeoutMs|稍后/.test(r.error), `须有下一步,实得:${r.error}`)
    assert.ok(!/(exit null|SIGKILL|ENOENT|spawn )/i.test(r.error), `用户面不得出现进程噪音,实得:${r.error}`)
    assert.match(r.evidence, /\[agent-reach:web\.read@error@/, '证据链 tag 形态不变')
    console.log(`8. 超时 → 人话降级 OK(${r.error})`)
  }

  // 9. 输出不可解析 + traceback/凭证样 stderr:原文不得进用户面(旧实现 slice(0,200) 直漏)
  {
    const py = await fakePython('py-truncated', 'truncated-json')
    const r = await reach({ channel: 'web', method: 'read', args: ['https://example.com'], pythonBin: py })
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'error')
    assert.ok(r.error && r.error.length > 0, `必须给出原因,实得:${JSON.stringify(r.error)}`)
    assert.ok(!r.error.includes('Traceback'), `不得漏 traceback,实得:${r.error}`)
    assert.ok(!r.error.includes('sk-SECRET-abc123'), `不得漏凭证样片段,实得:${r.error}`)
    assert.ok(!r.error.includes('channels.py'), `不得漏 stderr 原文,实得:${r.error}`)
    assert.ok(/无法解析/.test(r.error), `原因须指明输出不可解析,实得:${r.error}`)
    assert.ok(/agent-reach/.test(r.error), `须有源归属,实得:${r.error}`)
    assert.ok(/doctor/.test(r.error), `须有下一步,实得:${r.error}`)
    console.log(`9. 输出不可解析 → 人话降级 OK(${r.error})`)
  }

  // 10. 非零退出 + 带凭证样片段的 stderr:原文不得进用户面
  {
    const py = await fakePython('py-exit1', 'exit1-stderr')
    const r = await reach({ channel: 'v2ex', method: 'get_hot_topics', pythonBin: py })
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'error')
    assert.ok(r.error && r.error.length > 0, `必须给出原因,实得:${JSON.stringify(r.error)}`)
    assert.ok(!r.error.includes('LEAK-xyz'), `不得漏 stderr 原文,实得:${r.error}`)
    assert.ok(!r.error.includes("can't open file"), `不得漏进程噪音,实得:${r.error}`)
    assert.ok(/未返回可判定结果/.test(r.error), `原因须说清未返回结果,实得:${r.error}`)
    assert.ok(/退出码 1/.test(r.error), `可带退出码这一安全诊断,实得:${r.error}`)
    assert.ok(/doctor/.test(r.error), `须有下一步,实得:${r.error}`)
    console.log(`10. 非零退出 + stderr → 人话降级 OK(${r.error})`)
  }

  // 11. 空响应(exit 0 零输出):旧实现回落成空 error
  {
    const py = await fakePython('py-empty', 'empty')
    const r = await reach({ channel: 'v2ex', method: 'get_hot_topics', pythonBin: py })
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'error')
    assert.ok(r.error && r.error.length > 0, `必须给出原因,实得:${JSON.stringify(r.error)}`)
    assert.ok(/未返回可判定结果/.test(r.error), `原因须说清未返回结果,实得:${r.error}`)
    assert.ok(/agent-reach/.test(r.error), `须有源归属,实得:${r.error}`)
    assert.ok(/doctor/.test(r.error), `须有下一步,实得:${r.error}`)
    console.log(`11. 空响应 → 人话降级 OK(${r.error})`)
  }

  // 12. 桥 exit 3 结构化 error 是任意上游异常原话(可含凭证 URL/traceback):不透传,走分类安全文案
  {
    const py = await fakePython('py-cred-error', 'cred-error')
    const r = await reach({ channel: 'web', method: 'read', args: ['https://example.com'], pythonBin: py })
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'error')
    assert.ok(r.error && r.error.length > 0, `必须给出原因,实得:${JSON.stringify(r.error)}`)
    assert.ok(!r.error.includes('sk-LEAK-987654'), `凭证样 URL 不得进 error 面,实得:${r.error}`)
    assert.ok(!r.error.includes('RequestsError'), `桥异常原话不得透传,实得:${r.error}`)
    assert.ok(/调用失败/.test(r.error), `原因须说清渠道调用失败,实得:${r.error}`)
    assert.ok(/web\.read/.test(r.error), `须带受影响能力,实得:${r.error}`)
    assert.ok(/doctor|check\(\)/.test(r.error), `须有下一步,实得:${r.error}`)
    console.log(`12. 桥结构化 error 带凭证 → 分类安全文案 OK(${r.error})`)
  }

  // 13. JSON 合法但形状不对(null/数组/error 非字符串/check 非对象):永不抛错,按不可解析/安全文案处理
  {
    // 13a. null → parsed 形状闸兜住
    const rA = await reach({ channel: 'v2ex', method: 'get_hot_topics', pythonBin: await fakePython('py-json-null', 'json-null') })
    assert.equal(rA.verdict, 'error')
    assert.ok(rA.error && /无法解析/.test(rA.error), `null 输出须人话降级,实得:${JSON.stringify(rA.error)}`)
    // 13b. 数组 → 同上
    const rB = await reach({ channel: 'v2ex', method: 'get_hot_topics', pythonBin: await fakePython('py-json-array', 'json-array') })
    assert.equal(rB.verdict, 'error')
    assert.ok(rB.error && /无法解析/.test(rB.error), `数组输出须人话降级,实得:${JSON.stringify(rB.error)}`)
    // 13c. error 是数字 → 不得把数字透传成 error,也不得抛错
    const rC = await reach({ channel: 'v2ex', method: 'get_hot_topics', pythonBin: await fakePython('py-error-number', 'error-number') })
    assert.equal(rC.verdict, 'error')
    assert.ok(rC.error && rC.error.length > 0 && /调用失败/.test(rC.error), `error 为数字须安全分类,实得:${JSON.stringify(rC.error)}`)
    assert.ok(!rC.error.includes('987654'), `数字原值不得透传,实得:${rC.error}`)
    // 13d. error 是对象(内嵌凭证样 URL)→ 不透传不抛错
    const rD = await reach({ channel: 'v2ex', method: 'get_hot_topics', pythonBin: await fakePython('py-error-object', 'error-object') })
    assert.equal(rD.verdict, 'error')
    assert.ok(rD.error && /调用失败/.test(rD.error), `error 为对象须安全分类,实得:${JSON.stringify(rD.error)}`)
    assert.ok(!rD.error.includes('sk-OBJ-LEAK'), `对象内凭证样片段不得泄漏,实得:${rD.error}`)
    // 13e. check 是字符串 → 不冒充 needs-setup(形状闸),走安全 error
    const rE = await reach({ channel: 'xueqiu', method: 'get_stock_quote', args: ['SH600519'], pythonBin: await fakePython('py-check-string', 'check-string') })
    assert.equal(rE.verdict, 'error', `check 非对象不得判 needs-setup,实得:${rE.verdict}`)
    assert.ok(rE.error && /调用失败/.test(rE.error), `实得:${JSON.stringify(rE.error)}`)
    assert.ok(!rE.error.includes('boom-raw'), `桥原话不得透传,实得:${rE.error}`)
    // 13f. check.message 非字符串 → verdict 照常走 check.status,但 setup 不冒充原话
    const rF = await reach({ channel: 'xueqiu', method: 'get_stock_quote', args: ['SH600519'], pythonBin: await fakePython('py-check-msg-num', 'check-message-number') })
    assert.equal(rF.verdict, 'needs-setup', 'check.status 合法仍按上游体检结论路由')
    assert.equal(rF.setup, undefined, 'message 非字符串不冒充上游原话')
    assert.ok(rF.error && rF.error.length > 0 && !rF.error.includes('boom2'), `error 须安全非空,实得:${JSON.stringify(rF.error)}`)
    console.log('13. 形状不对的桥 JSON(null/数组/error 数字或对象/check 错型)→ 永不抛错 + 人话降级 OK')
  }

  // 14. readUrl 产品边界(gotry_web_search 渲染 ${r.error}):缺 venv 的 not-installed 指引必须穿过来,不留 undefined
  {
    // 14a. 缺 .venv python(pythonBin 指向不存在路径,不碰真实 venv):旧实现 error=undefined → 工具面渲染 unavailable (undefined)
    const rA = await readUrl({ url: 'https://example.com', pythonBin: join(tmp, 'definitely-missing-python') })
    assert.equal(rA.ok, false)
    assert.equal(rA.via, 'r.jina.ai-error')
    assert.ok(rA.error && rA.error.length > 0, `缺 venv 时 error 不得为 undefined,实得:${JSON.stringify(rA.error)}`)
    assert.match(rA.error, /doctor --fix/, '须带补装指引')
    assert.ok(!String(rA.error).includes('undefined'), '不得渲染 undefined')
    // 14b. 成功数据穿 readUrl(确定性 fake,零网络)
    const rB = await readUrl({ url: 'https://example.com', pythonBin: await fakePython('py-ok-string', 'ok-string') })
    assert.equal(rB.ok, true)
    assert.equal(rB.via, 'r.jina.ai')
    assert.equal(rB.title, 'Fake Page', 'Title 提取')
    assert.ok(rB.content?.includes('正文'), 'content 透传')
    // 14c. 桥 error 对象(内嵌凭证)穿 readUrl → 安全文案
    const rC = await readUrl({ url: 'https://example.com', pythonBin: await fakePython('py-readurl-obj', 'error-object') })
    assert.equal(rC.ok, false)
    assert.ok(rC.error && rC.error.length > 0 && /调用失败/.test(rC.error), `readUrl error 须安全非空,实得:${JSON.stringify(rC.error)}`)
    assert.ok(!rC.error.includes('sk-OBJ-LEAK'), `凭证样片段不得穿 readUrl,实得:${rC.error}`)
    // 14d. needs-setup 的具体上游动作必须穿过 readUrl，不能只说「按 setup 指引」。
    const rD = await readUrl({ url: 'https://example.com', pythonBin: await fakePython('py-readurl-setup', 'needs-setup') })
    assert.equal(rD.ok, false)
    assert.match(rD.error ?? '', /configure cookies via agent-reach login xueqiu/, '保留具体上游配置动作')
    assert.match(rD.error ?? '', /web.read 调用失败/, '保留安全的能力与失败原因')
    assert.ok(!rD.error?.includes('CookieError'), '不夹带桥异常原文')
    console.log('14. readUrl 产品边界：缺依赖和配置指引穿透＋成功数据＋凭证安全 OK')
  }

  console.log('\nAGENT-REACH ERROR TESTS: 14/14 OK(确定性失败面,人话降级 + 透传契约回归锁)')
} finally {
  await rm(tmp, { recursive: true, force: true })
}
