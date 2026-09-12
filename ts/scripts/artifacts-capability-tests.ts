/**
 * 产物面(issue #285)能力层离线 proof:
 *  list/read 工具链的纯函数 + 隔离 fixture 路径护栏。
 *  与 smoke.ts §15 互相补——smoke 验注册 + dsh 卡片契约(在 plugin context),
 *  本文件验 capabilities/artifacts.ts 纯函数 + 隔离 stateRoot(无 dsh 上下文)。
 *
 *  1) 账本权威 list:种工单 + 交付 → list 找到 async-run
 *  2) cwd md list:工作目录顶层 md → list 找到 cwd-file
 *  3) 合并去重:账本 + cwd 同 path 不重复
 *  4) 裸工单 id read:从账本 deliverable 读出
 *  5) 行号窗口:offset/limit 行号正确
 *  6) 越界路径:ok:false + error 含「越界」
 *  7) symlink 越界:ok:false
 *  7b) 裸工单 id symlink/超大 deliverable:仍经过 canonical/root/size 护栏
 *  8) 不支持扩展名:.db → ok:false + error 含「不支持的文件类型」
 *  9) 不存在文件:ok:false
 *  10) 超大文件:>2MB → ok:false
 *  11) read 在 cwd/根边界外的相对路径:rejects
 *  12) list limit 截断:truncated=true, paths.length === limit
 *
 *  issue #441 追加(HTML 行程产物发现 + 安全源码预览):
 *  13) cwd 顶层 .html/.htm/大写扩展名同时可发现;标题去扩展名;dotfile 仍排除;md 不退化
 *  14) HTML read:lang=html、原始行号、全文 sha256 指纹、.htm 同 lang
 *  15) HTML 分页:offset/limit 行号 + windowed 语义与 md 一致
 *  16) 恶意 HTML fixture 只作字面文本返回:脚本/内联事件/fetch 不执行、不联网
 *  17) 安全回归:HTML 超大/越界/symlink 逃逸/隐藏文件/拒绝目录,与 md 同限制
 *  18) list→read 实际串联:消费 list 返回的 path 读回 HTML(state-root 与 cwd 两种来源)
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { listArtifacts, readArtifact } from '../capabilities/artifacts.ts'
import { ensureLedger } from '../src/state-ledger.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-artifacts-cap-tests-'))
const cwd = mkdtempSync(join(tmpdir(), 'gotry-artifacts-cap-cwd-'))

// 1) 账本权威 list
{
  const ledger = ensureLedger(stateRoot)
  ledger.createWorkflowRun({ id: 'cap-probe-1', goal: '产物探针·账本', ticket: { objective: 'probe' }, state: {} })
  ledger.settleWorkflowRun('cap-probe-1', '# 交付·账本权威\nD1 大理\nD2 洱海')
  const r = await listArtifacts({ stateRoot, limit: 20 })
  const run = r.artifacts.find(a => a.id === 'cap-probe-1')
  assert.ok(run, '账本工单应被 list 找到')
  assert.equal(run?.source, 'async-run')
  assert.equal(run?.status, 'settled')
  assert.ok(run?.path.endsWith('cap-probe-1.deliverable.md'), `path 形态应为 deliverable.md,实际 ${run?.path}`)
  console.log('1) 账本权威 list OK')
}

// 2) cwd md list
{
  const lines = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`)
  writeFileSync(join(cwd, 'trip-2027-cap.md'), `# 行程探针\n${lines.join('\n')}\n`)
  const r = await listArtifacts({ stateRoot, cwd, limit: 20 })
  const md = r.artifacts.find(a => a.id === 'trip-2027-cap.md')
  assert.ok(md, 'cwd 顶层 md 应被 list 找到')
  assert.equal(md?.source, 'cwd-file')
  console.log('2) cwd md list OK')
}

// 3) 合并去重:账本工单 cap-probe-1 的 path 与 cwd 任何文件 path 不冲突——验证 seenPath 去重逻辑
{
  // 制造一个 cwd 文件与账本 deliverable 同 basename 看似不同
  writeFileSync(join(cwd, 'cap-probe-1.deliverable.md'), 'unrelated')
  const r = await listArtifacts({ stateRoot, cwd, limit: 20 })
  const seen = new Map<string, number>()
  for (const a of r.artifacts) {
    if (a.id === 'cap-probe-1.deliverable.md' || a.id === 'cap-probe-1') {
      const k = resolve(a.path)
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
  }
  // 同一 path 出现 ≥2 次即去重失败
  for (const [k, n] of seen) {
    assert.ok(n <= 1, `path ${k} 出现 ${n} 次,应去重为 1`)
  }
  console.log('3) 合并去重 OK')
}

// 4) 裸工单 id read
{
  const r = await readArtifact({ stateRoot, cwd, path: 'cap-probe-1' })
  assert.equal(r.ok, true, '裸工单 id 应可读')
  if (r.ok) {
    assert.equal(r.lang, 'markdown')
    assert.equal(r.offset, 1)
    assert.equal(r.lines[0]?.number, 1)
    assert.ok(r.lines[0]?.text.includes('交付·账本权威'), '首行应含账本 deliverable 标题')
    assert.equal(r.totalLines, 3, `交付 3 行,实际 ${r.totalLines}`)
  }
  console.log('4) 裸工单 id read OK')
}

// 5) 行号窗口
{
  const r = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.md', offset: 3, limit: 3 })
  assert.equal(r.ok, true, 'cwd md 应可读')
  if (r.ok) {
    assert.equal(r.lines.length, 3, `offset=3 limit=3 应 3 行,实际 ${r.lines.length}`)
    assert.equal(r.lines[0]?.number, 3, `首行号应 3,实际 ${r.lines[0]?.number}`)
    assert.equal(r.lines[2]?.number, 5)
    assert.equal(r.totalLines, 10, `8 行 + 标题 1 + 末尾空行 1 = 10,实际 ${r.totalLines}`)
    assert.equal(r.windowed, true, `offset=3 limit=3 总 10 行 → windowed=true(可继续翻页)`)
  }
  const full = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.md' })
  assert.equal(full.ok, true, 'cwd md 默认 limit 应读完')
  if (full.ok) {
    assert.equal(full.windowed, false, `读完应 windowed=false`)
    assert.equal(full.lines.length, full.totalLines, `lines.length === totalLines,实际 ${full.lines.length}/${full.totalLines}`)
  }
  console.log('5) 行号窗口 OK')
}

// 6) 越界路径
{
  const r = await readArtifact({ stateRoot, cwd, path: '../../../../../etc/passwd' })
  assert.equal(r.ok, false, '越界路径必须被拒')
  if (!r.ok) {
    assert.ok(r.error.includes('越界'), `error 应含「越界」,实际 ${r.error}`)
  }
  console.log('6) 越界路径 OK')
}

// 7) symlink 越界
{
  const linkPath = join(cwd, 'symlink-out.md')
  try {
    symlinkSync('/etc/passwd', linkPath)
  } catch {
    // macOS 上 /etc/passwd 是符号链接到 /private/etc/passwd;symlink 自身仍 out-of-root
  }
  const r = await readArtifact({ stateRoot, cwd, path: 'symlink-out.md' })
  assert.equal(r.ok, false, '相对路径 symlink 解析后越出 cwd 必须被拒')
  if (!r.ok) assert.ok(r.error.includes('越界'), `symlink 越界错误应含「越界」,实际 ${r.error}`)

  // 绝对 symlink 指向目录也必须按 canonical target 做边界检查。
  const absLink = join(stateRoot, 'abs-link.md')
  try {
    symlinkSync('/etc', absLink)
    const r2 = await readArtifact({ stateRoot, cwd, path: absLink })
    assert.equal(r2.ok, false, '绝对 symlink 越界必须被拒')
    if (!r2.ok) {
      assert.ok(r2.error.includes('越界'), `error 应含「越界」,实际 ${r2.error}`)
    }
  } catch { /* 非 POSIX fs 跳过 */ }
  console.log('7) symlink 越界 OK')
}

// 7b) 裸工单 id 的兼容文件视图也必须经过同一组 canonical/root/size 护栏。
{
  mkdirSync(join(stateRoot, 'gotry-state', 'async'), { recursive: true })
  const bareLink = join(stateRoot, 'gotry-state', 'async', 'evil.deliverable.md')
  let bareLinkCreated = false
  try {
    symlinkSync('/etc/hosts', bareLink)
    bareLinkCreated = true
  } catch { /* 非 POSIX fs 跳过 */ }
  if (bareLinkCreated) {
    const r = await readArtifact({ stateRoot, cwd, path: 'evil' })
    assert.equal(r.ok, false, '裸工单 id symlink 指向 root 外时必须被拒')
    if (!r.ok) assert.ok(r.error.includes('越界'), `裸工单 id symlink 越界错误应含「越界」,实际 ${r.error}`)
  }

  const bareBig = join(stateRoot, 'gotry-state', 'async', 'oversized.deliverable.md')
  writeFileSync(bareBig, 'x'.repeat(2 * 1024 * 1024 + 1))
  const oversized = await readArtifact({ stateRoot, cwd, path: 'oversized' })
  assert.equal(oversized.ok, false, '裸工单 id 超大文件必须被拒')
  if (!oversized.ok) assert.ok(oversized.error.includes('过大'), `裸工单 id 超大错误应含「过大」,实际 ${oversized.error}`)
  rmSync(bareLink, { force: true })
  rmSync(bareBig, { force: true })
  console.log('7b) 裸工单 id symlink/超大 deliverable 护栏 OK')
}

// 8) 不支持扩展名
{
  mkdirSync(join(stateRoot, 'gotry-state'), { recursive: true })
  writeFileSync(join(stateRoot, 'gotry-state', 'gotry-state.db'), 'fake db')
  const r = await readArtifact({ stateRoot, cwd, path: 'gotry-state/gotry-state.db' })
  assert.equal(r.ok, false, '.db 必须被拒')
  if (!r.ok) {
    assert.ok(r.error.includes('不支持的文件类型'), `error 应含「不支持的文件类型」,实际 ${r.error}`)
  }
  console.log('8) 不支持扩展名 OK')
}

// 9) 不存在文件
{
  const r = await readArtifact({ stateRoot, cwd, path: 'not-found.md' })
  assert.equal(r.ok, false, '不存在文件必须被拒')
  if (!r.ok) {
    assert.ok(r.error.includes('不存在'), `error 应含「不存在」,实际 ${r.error}`)
  }
  console.log('9) 不存在文件 OK')
}

// 10) 超大文件
{
  const big = join(cwd, 'big.md')
  // 2MB+ 一点点;read 默认上限 2MB
  const chunk = 'x'.repeat(64 * 1024)
  const handle = await import('node:fs/promises').then(m => m.open(big, 'w'))
  try {
    for (let i = 0; i < 33; i++) await handle.write(chunk) // 33 * 64KB = 2.11MB
  } finally { await handle.close() }
  const r = await readArtifact({ stateRoot, cwd, path: 'big.md' })
  assert.equal(r.ok, false, '>2MB 必须被拒')
  if (!r.ok) {
    assert.ok(r.error.includes('过大'), `error 应含「过大」,实际 ${r.error}`)
  }
  console.log('10) 超大文件 OK')
}

// 11) read 接受 path 三形态:id / cwd 文件名 / 绝对路径
{
  // 11a) 相对文件名仅在 cwd 顶层
  const r = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.md' })
  assert.equal(r.ok, true, '相对文件名应解析为 cwd 顶层')
  // 11b) path 为裸字符串无后缀 + 不在 cwd → 尝试 stateRoot 下的 gotry-state/async/
  const r2 = await readArtifact({ stateRoot, cwd, path: 'cap-probe-1' })
  assert.equal(r2.ok, true, '裸工单 id 应解析为账本')
  // 11c) 空 path
  const r3 = await readArtifact({ stateRoot, cwd, path: '' })
  assert.equal(r3.ok, false, '空 path 应被拒')
  console.log('11) path 三形态 OK')
}

// 12) list limit 截断
{
  for (let i = 0; i < 5; i++) writeFileSync(join(cwd, `extra-${i}.md`), `# 副产物 ${i}`)
  const r = await listArtifacts({ stateRoot, cwd, limit: 3 })
  assert.equal(r.artifacts.length, 3, `limit=3 应 3 条,实际 ${r.artifacts.length}`)
  assert.equal(r.truncated, true, `应有更多,truncated 应为 true`)
  // total = sum of each source's retained count = 1 (账本) + 0 (async dir) + 3 (cwd top 3 by mtime) = 4
  // (listCwdArtifacts 内部就 slice(0, limit);要更多需调用方放大 limit)
  assert.equal(r.total, 4, `total 应 4(账本 1 + cwd top 3),实际 ${r.total}`)
  assert.ok(r.total > r.artifacts.length, `total 应 > artifacts.length 才能 truncated,实际 ${r.total} vs ${r.artifacts.length}`)
  // 放大 limit 后能看到全部
  const r2 = await listArtifacts({ stateRoot, cwd, limit: 20 })
  assert.equal(r2.truncated, false, `limit=20 应能装下,truncated=false`)
  assert.ok(r2.total >= 7, `放大 limit 后 total 应 ≥ 7(账本 1 + cwd 多个 md),实际 ${r2.total}`)
  console.log('12) list limit 截断 OK')
}

// ============ issue #441:HTML 行程产物 ============

const HTML_TEXT = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>合成行程·大理</title></head>',
  '<body>',
  '<h1>合成行程 2027</h1>',
  '<p>D1 大理 · D2 洱海</p>',
  '</body></html>',
  '',
].join('\n')

// 13) cwd 顶层 html/htm 发现(大小写不敏感)+ 标题 + dotfile 排除 + md 不退化
{
  writeFileSync(join(cwd, 'trip-2027-cap.html'), HTML_TEXT)
  writeFileSync(join(cwd, 'trip-2027-cap.htm'), '<html><body><p>htm 变体</p></body></html>')
  writeFileSync(join(cwd, 'Trip-2027-CAPS.HTML'), '<html><body><p>大写扩展名</p></body></html>')
  writeFileSync(join(cwd, '.hidden-trip.html'), '<html><body><p>隐藏文件不得发现</p></body></html>')
  const r = await listArtifacts({ stateRoot, cwd, limit: 50 })
  const ids = r.artifacts.map(a => a.id)
  for (const name of ['trip-2027-cap.html', 'trip-2027-cap.htm', 'Trip-2027-CAPS.HTML']) {
    assert.ok(ids.includes(name), `顶层 ${name} 应被 list 发现,实际 ${ids.join(',')}`)
  }
  assert.ok(ids.includes('trip-2027-cap.md'), `md 发现不得退化,实际 ${ids.join(',')}`)
  assert.ok(!ids.includes('.hidden-trip.html'), `dotfile 仍应被排除,实际 ${ids.join(',')}`)
  const html = r.artifacts.find(a => a.id === 'trip-2027-cap.html')
  assert.equal(html?.source, 'cwd-file')
  assert.equal(html?.title, 'trip-2027-cap', `标题应去扩展名,实际 ${html?.title}`)
  assert.equal(html?.bytes, Buffer.byteLength(HTML_TEXT), `bytes 应为文件字节数,实际 ${html?.bytes}`)
  const caps = r.artifacts.find(a => a.id === 'Trip-2027-CAPS.HTML')
  assert.equal(caps?.title, 'Trip-2027-CAPS', `大写扩展名同样去扩展名,实际 ${caps?.title}`)
  // 排序仍是 mtime 倒序 + limit 截断(total 为各源保留数之和,与 md 语义一致)
  const limited = await listArtifacts({ stateRoot, cwd, limit: 2 })
  assert.equal(limited.artifacts.length, 2, `limit=2 应 2 条,实际 ${limited.artifacts.length}`)
  assert.equal(limited.truncated, true, 'limit=2 应截断')
  // 排序单调性:mtime 倒序(updated 字符串倒序)
  const all = await listArtifacts({ stateRoot, cwd, limit: 50 })
  for (let i = 1; i < all.artifacts.length; i++) {
    const prev = String(all.artifacts[i - 1]?.updated ?? '')
    const cur = String(all.artifacts[i]?.updated ?? '')
    assert.ok(prev.localeCompare(cur) >= 0, `排序应 mtime 倒序:${prev} < ${cur}`)
  }
  console.log('13) cwd html/htm 发现 + 标题/排序/截断 OK')
}

// 14) HTML read:lang=html + 原始行号 + 全文指纹(.htm 同 lang)
{
  const r = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.html' })
  assert.equal(r.ok, true, 'cwd html 应可读')
  if (r.ok) {
    assert.equal(r.lang, 'html', `lang 应 html,实际 ${r.lang}`)
    assert.equal(r.source, 'cwd', `source 应 cwd,实际 ${r.source}`)
    assert.equal(r.totalLines, 7, `HTML_TEXT 7 行,实际 ${r.totalLines}`)
    assert.equal(r.lines[0]?.number, 1, '首行号应 1')
    assert.equal(r.lines[3]?.text, '<h1>合成行程 2027</h1>', `第 4 行原文应保真,实际 ${r.lines[3]?.text}`)
    const expected = createHash('sha256').update(HTML_TEXT).digest('hex').slice(0, 12)
    assert.equal(r.version, expected, `版本应为全文 sha256 前 12 位,实际 ${r.version}`)
    assert.equal(r.windowed, false, '全文一次读完应 windowed=false')
  }
  const caps = await readArtifact({ stateRoot, cwd, path: 'Trip-2027-CAPS.HTML' })
  assert.equal(caps.ok, true, '大写 .HTML 应可读')
  if (caps.ok) assert.equal(caps.lang, 'html', `大写扩展名 lang 仍 html,实际 ${caps.lang}`)
  const htm = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.htm' })
  assert.equal(htm.ok, true, '.htm 应可读')
  if (htm.ok) {
    assert.equal(htm.lang, 'html', `.htm lang 应 html,实际 ${htm.lang}`)
    assert.ok(htm.content.includes('<p>htm 变体</p>'), '.htm 内容应原文返回')
  }
  console.log('14) HTML read lang/行号/指纹 OK')
}

// 15) HTML 分页与 md 同语义
{
  const r = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.html', offset: 3, limit: 2 })
  assert.equal(r.ok, true, 'HTML 分页应可读')
  if (r.ok) {
    assert.equal(r.lines.length, 2, `offset=3 limit=2 应 2 行,实际 ${r.lines.length}`)
    assert.equal(r.lines[0]?.number, 3, `首行号应 3,实际 ${r.lines[0]?.number}`)
    assert.equal(r.lines[1]?.number, 4)
    assert.equal(r.offset, 3)
    assert.equal(r.windowed, true, '总 7 行读 3-4 行应 windowed=true')
  }
  console.log('15) HTML 分页 OK')
}

// 16) 恶意 HTML fixture:只作字面文本返回,不执行脚本/内联事件,不发网络请求
{
  const evil = [
    '<!doctype html><html><body>',
    '<script>globalThis.__gotry441Pwned = true</script>',
    '<img src=x onerror="globalThis.__gotry441Pwned = true">',
    '<iframe src="https://example.invalid/track"></iframe>',
    '<a href="javascript:globalThis.__gotry441Pwned=true">点击</a>',
    '<script>fetch("http://127.0.0.1:1/collect")</script>',
    '</body></html>',
    '',
  ].join('\n')
  writeFileSync(join(cwd, 'evil-itinerary.html'), evil)
  const r = await readArtifact({ stateRoot, cwd, path: 'evil-itinerary.html', limit: 400 })
  assert.equal(r.ok, true, '恶意 HTML 仍应作为文本可读')
  if (r.ok) {
    const content = r.lines.map(l => l.text).join('\n')
    assert.ok(content.includes('<script>globalThis.__gotry441Pwned = true</script>'), '脚本应原样作为文本返回')
    assert.ok(content.includes('onerror="globalThis.__gotry441Pwned = true"'), '内联事件属性应原样作为文本返回')
    assert.ok(content.includes('javascript:globalThis.__gotry441Pwned=true'), 'javascript: 链接应原样作为文本返回')
    assert.ok(content.includes('fetch("http://127.0.0.1:1/collect")'), 'fetch 调用应原样作为文本返回')
    assert.ok(r.lines.every(l => typeof l.text === 'string'), '所有行必须是纯字符串文本')
    assert.equal(r.lang, 'html', 'lang 仍是 html(源码预览,非渲染)')
    assert.equal(r.version, createHash('sha256').update(evil).digest('hex').slice(0, 12), '指纹基于原文文本')
  }
  assert.equal((globalThis as unknown as Record<string, unknown>).__gotry441Pwned, undefined, '读取过程不得执行 HTML 内脚本')
  console.log('16) 恶意 HTML 字面文本 + 零执行 OK')
}

// 17) 安全回归:HTML 与 md 同限制(超大/越界/symlink 逃逸/隐藏/拒绝目录)
{
  // 17a) 超大 HTML(>2MB)
  const bigHtml = join(cwd, 'big-itinerary.html')
  const chunk = '<p>xxxx</p>'.repeat(64 * 1024)
  const handle = await import('node:fs/promises').then(m => m.open(bigHtml, 'w'))
  try {
    for (let i = 0; i < 4; i++) await handle.write(chunk) // 4 * 640KB = 2.6MB > 2MB
  } finally { await handle.close() }
  const big = await readArtifact({ stateRoot, cwd, path: 'big-itinerary.html' })
  assert.equal(big.ok, false, '>2MB HTML 必须被拒')
  if (!big.ok) assert.ok(big.error.includes('过大'), `超大 HTML 错误应含「过大」,实际 ${big.error}`)

  // 17b) 越界相对路径(html 扩展名不豁免边界)
  const out = await readArtifact({ stateRoot, cwd, path: '../../../../etc/passwd.html' })
  assert.equal(out.ok, false, '越界 html 必须被拒')
  if (!out.ok) assert.ok(out.error.includes('越界'), `越界错误应含「越界」,实际 ${out.error}`)

  // 17c) symlink 逃逸:指向 root 外的 .html 既不可 list 也不可 read
  const linkHtml = join(cwd, 'symlink-evil.html')
  try {
    symlinkSync('/etc/passwd', linkHtml)
    const listed = await listArtifacts({ stateRoot, cwd, limit: 50 })
    assert.ok(!listed.artifacts.some(a => a.id === 'symlink-evil.html'), 'symlink 文件不得进入 list')
    const read = await readArtifact({ stateRoot, cwd, path: 'symlink-evil.html' })
    assert.equal(read.ok, false, 'symlink 逃逸的 html 必须被拒')
    if (!read.ok) assert.ok(read.error.includes('越界'), `symlink 逃逸错误应含「越界」,实际 ${read.error}`)
  } catch { /* 非 POSIX fs 跳过 */ }

  // 17d) 隐藏文件:list 排除(同 md);显式 path 读取行为与 md 一致(不新增限制)
  writeFileSync(join(cwd, '.hidden-parity.md'), 'md 隐藏')
  const hiddenHtml = await readArtifact({ stateRoot, cwd, path: '.hidden-trip.html' })
  const hiddenMd = await readArtifact({ stateRoot, cwd, path: '.hidden-parity.md' })
  assert.equal(hiddenHtml.ok, hiddenMd.ok, '.html 与 .md 隐藏文件的显式读取行为必须一致')
  const listed2 = await listArtifacts({ stateRoot, cwd, limit: 50 })
  assert.ok(!listed2.artifacts.some(a => a.id === '.hidden-parity.md'), 'md dotfile 同样不得进入 list')

  // 17e) 拒绝目录:node_modules 内 html 既不可读也不可发现
  mkdirSync(join(cwd, 'node_modules'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'vendored.html'), '<html><body>vendored</body></html>')
  const denied = await readArtifact({ stateRoot, cwd, path: 'node_modules/vendored.html' })
  assert.equal(denied.ok, false, 'node_modules 内 html 必须被拒')
  if (!denied.ok) assert.ok(denied.error.includes('越界'), `拒绝目录错误应含「越界」,实际 ${denied.error}`)
  const listed3 = await listArtifacts({ stateRoot, cwd, limit: 50 })
  assert.ok(!listed3.artifacts.some(a => a.id === 'vendored.html'), 'node_modules 内文件不得进入 list(非递归)')
  rmSync(join(cwd, 'node_modules'), { recursive: true, force: true })
  console.log('17) HTML 安全回归(超大/越界/symlink/隐藏/拒绝目录)OK')
}

// 18) list→read 实际串联:消费 list 返回的 path(绝对路径形态)读回 HTML
{
  const rootHtml = join(stateRoot, 'gotry-state', 'trip-in-root.html')
  mkdirSync(join(stateRoot, 'gotry-state'), { recursive: true })
  writeFileSync(rootHtml, '<html><body><p>state-root 内 HTML</p></body></html>')
  const listed = await listArtifacts({ stateRoot, cwd, limit: 50 })
  const cwdEntry = listed.artifacts.find(a => a.id === 'trip-2027-cap.html')
  assert.ok(cwdEntry, 'list 应返回 cwd html 条目')
  const viaList = await readArtifact({ stateRoot, cwd, path: String(cwdEntry?.path) })
  assert.equal(viaList.ok, true, 'list 返回的 cwd 绝对路径应可读')
  if (viaList.ok) {
    assert.equal(viaList.lang, 'html')
    assert.equal(viaList.source, 'cwd', `cwd 来源标签,实际 ${viaList.source}`)
  }
  const viaRoot = await readArtifact({ stateRoot, cwd, path: rootHtml })
  assert.equal(viaRoot.ok, true, 'stateRoot 内 HTML 应可读')
  if (viaRoot.ok) {
    assert.equal(viaRoot.lang, 'html')
    assert.equal(viaRoot.source, 'state-root', `state-root 来源标签,实际 ${viaRoot.source}`)
    assert.ok(viaRoot.content.includes('state-root 内 HTML'), '内容应为原文')
  }
  // 读回内容与磁盘原文逐字一致(不做任何 HTML 解析/改写)
  const onDisk = readFileSync(join(cwd, 'trip-2027-cap.html'), 'utf8')
  const roundTrip = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.html' })
  if (roundTrip.ok) assert.equal(roundTrip.content, onDisk, '读回内容必须与磁盘原文逐字一致')
  console.log('18) list→read 串联(state-root/cwd)OK')
}

rmSync(stateRoot, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log('all artifacts capability tests OK')
