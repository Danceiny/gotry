/**
 * dsh artifact view isolated Host contract proof (issue #285).
 *
 * 真实执行:在临时 stateRoot/cwd 下装载 gotry-tools 插件,触发 gotry_artifacts_list
 * + gotry_artifacts_read 的 execute + output.presentationMeta + presentResult,断言
 * DSH 0.1.5-rc.1 的 Host ToolResult contract(SearchPathsResultView /
 * ReadResultView / GenericCallView.locations),并跑一次隔离 select → preview →
 * modify → view-updated 文件读取循环。
 *
 * 本脚本不代替 Web renderer E2E:它证明的是 DSH host 装载 → 真实 execute →
 * 持久化 meta → Host presenter contract。fresh-profile Web custom-card 路径由
 * 显式命令 `npx tsx scripts/dsh-artifact-web-e2e.ts` 另行覆盖；该浏览器命令
 * 不属于跨平台 full suite。
 *
 * 隔离:全临时目录;不写 gotry-state;结束即删。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

interface PresentResultView {
  card?: string
  shape?: string
  title?: string
  paths?: string[]
  total?: number
  truncated?: boolean
  path?: string
  offset?: number
  lines?: Array<{ number: number; text: string }>
  totalLines?: number
  lang?: string
  content?: Array<{ type?: string; text?: string }>
}
interface PresentCallView {
  card?: string
  kind?: string
  title?: string
  locations?: Array<{ path?: string; line?: number }>
  rawInput?: unknown
}
interface ToolDef {
  name: string
  description?: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  output: {
    render: (args: Record<string, unknown>, result: unknown) => Array<{ type?: string; text?: string }>
    presentationMeta?: (args: Record<string, unknown>, result: unknown) => unknown
  }
  presentResult?: (args: Record<string, unknown>, result: { isError: boolean; content: Array<{ type?: string; text?: string }>; meta?: unknown }) => PresentResultView | undefined
  presentCall?: (args: Record<string, unknown>) => PresentCallView | undefined
}

function toolResult(tool: ToolDef, args: Record<string, unknown>, value: unknown): { isError: false; content: Array<{ type?: string; text?: string }>; meta?: unknown } {
  return {
    isError: false,
    content: tool.output.render(args, value),
    meta: tool.output.presentationMeta?.(args, value),
  }
}

async function main(): Promise<void> {
  // ── 1) 隔离环境 ─────────────────────────────────────────────────────────────
  const home = mkdtempSync(join(tmpdir(), 'gotry-285-home-'))
  const stateRoot = join(home, 'state')
  const cwd = join(home, 'workspace')
  mkdirSync(stateRoot, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  // fixture:一个工作区 md,以及后续追加新内容
  const fixturePath = join(cwd, 'trip-2027.md')
  writeFileSync(fixturePath, [
    '# 行程 2027',
    '',
    'Day 1: 北京 → 曼谷',
    'Day 2: 曼谷 → 清迈',
    'Day 3: 清迈 → 清莱',
    'Day 4: 清莱 → 曼谷',
    'Day 5: 曼谷 → 北京',
  ].join('\n'))

  // ── 2) 装载 gotry-tools 插件(同 dsh host 装载路径:apply(ctx, config))─────
  const registered: ToolDef[] = []
  const sections: Array<{ name: string; text: string }> = []
  const variables: Record<string, () => string> = {}
  const preExecutes: Array<(exec: { name?: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>> = []
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t as ToolDef) },
    systemPrompt: {
      section: (s: { name: string; text: string }) => { sections.push(s) },
      variable: (name: string, provider: () => string) => { variables[name] = provider },
    },
    on: (event: string, fn: (exec: { name?: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>) => {
      if (event === 'tools/pre-execute') preExecutes.push(fn)
      return () => undefined
    },
  } as unknown as Context

  apply(ctx, {
    stateRoot,
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'off',
  })
  const exec = { agent: { session: { header: { cwd } } } }
  const byName = (n: string): ToolDef => {
    const t = registered.find(t => t.name === n)
    if (!t) throw new Error(`FAIL: 插件装载后未找到 ${n},已注册: ${registered.map(t => t.name).join(',')}`)
    return t
  }

  // ── 3) select 阶段:gotry_artifacts_list 真实 execute + presentResult ─────
  const listTool = byName('gotry_artifacts_list')
  const listPayload = await listTool.execute({ limit: 20 }, exec) as {
    ok?: boolean
    artifacts?: Array<{ source?: string; path?: string; title?: string }>
    total?: number
    truncated?: boolean
    summary?: string
  }
  assert.equal(listPayload.ok, true, 'list execute 应 ok')
  assert.ok(Array.isArray(listPayload.artifacts) && listPayload.artifacts.length >= 1, 'list 应发现 fixture md')
  const fixtureEntry = listPayload.artifacts!.find(a => a.path?.endsWith('/trip-2027.md'))
  assert.ok(fixtureEntry, `list 应包含 trip-2027.md,实际: ${listPayload.artifacts!.map(a => a.path).join(',')}`)
  console.log(`[1/4] SELECT  list.execute → ${listPayload.artifacts!.length} 项 (含 fixture trip-2027.md)`)

  const listView = listTool.presentResult?.({}, toolResult(listTool, {}, listPayload))
  assert.equal(listView?.card, 'search', 'list card 应为 "search" (SearchPathsResultView)')
  assert.equal(listView?.shape, 'paths', 'list shape 应为 "paths" (SearchPathsResultView)')
  assert.ok(Array.isArray(listView?.paths), 'list paths 应为数组(UI 渲染 deliverables 列表直接绑路径)')
  assert.deepEqual(listView?.paths, listPayload.artifacts!.map(a => a.path), 'list paths 数组应与 artifacts 顺序一致')
  assert.equal(listView?.total, listPayload.total, 'list total 应与 execute 一致')
  assert.equal(listView?.truncated, Boolean(listPayload.truncated), 'list truncated 应与 execute 一致')
  const listFallback = listTool.output.render({}, listPayload)
  assert.ok((listFallback[0]?.text ?? '').length > 0, 'list output.render 应带 summary,供无 search 卡能力的 UI fallback')
  console.log(`[1/4] CONTRACT list → SearchPathsResultView{ card:'search', shape:'paths', paths:[${listView!.paths!.length}], total=${listView!.total}, truncated=${listView!.truncated} }`)

  // ── 4) preview 阶段:gotry_artifacts_read 真实 execute + presentResult ───
  const readTool = byName('gotry_artifacts_read')
  const readCall = readTool.presentCall?.({ path: 'trip-2027.md' })
  assert.equal(readCall?.kind, 'read', 'read presentCall kind 应为 "read"(editor follow-along)')
  assert.ok(Array.isArray(readCall?.locations), 'read presentCall locations 应为数组')
  assert.equal(readCall?.locations?.[0]?.path, 'trip-2027.md', 'read locations[0].path 应等于目标路径')
  assert.equal(readCall?.locations?.[0]?.line, 1, 'read locations[0].line 应为 1(call 阶段就锁住身份)')
  console.log(`[2/4] PREVIEW read.presentCall → GenericCallView{ kind:'read', locations:[{path:'trip-2027.md',line:1}] }`)

  const read1Payload = await readTool.execute({ path: 'trip-2027.md' }, exec) as {
    ok?: boolean
    source?: string
    path?: string
    offset?: number
    lines?: Array<{ number: number; text: string }>
    totalLines?: number
    lang?: string
    content?: string
    windowed?: boolean
  }
  assert.equal(read1Payload.ok, true, 'read 应 ok')
  assert.equal(read1Payload.source, 'cwd', 'read 在 cwd 中应分类为 cwd source')
  assert.equal(read1Payload.totalLines, 7, 'fixture 7 行(标题+空行+5 day+空尾)')
  assert.equal(read1Payload.lines?.[0]?.number, 1, '首行 number 应为 1(file line numbering 保留)')
  assert.ok(read1Payload.lines?.[0]?.text.includes('行程 2027'), '首行应为标题')
  assert.equal(read1Payload.lang, 'markdown', '扩展名映射 lang=markdown')
  console.log(`[2/4] PREVIEW read.execute → { source:'${read1Payload.source}', totalLines:${read1Payload.totalLines}, lines:[${read1Payload.lines?.length}], lang:'${read1Payload.lang}' }`)

  const read1View = readTool.presentResult?.({ path: 'trip-2027.md' }, toolResult(readTool, { path: 'trip-2027.md' }, read1Payload))
  assert.equal(read1View?.card, 'read', 'read card 应为 "read" (ReadResultView)')
  assert.equal(read1View?.path, read1Payload.path, 'read view path 应等于 execute path')
  assert.equal(read1View?.offset, read1Payload.offset, 'read view offset 应保留(call→result 一致)')
  assert.equal(read1View?.lines?.length, read1Payload.lines?.length, 'read view lines 长度应等于 execute lines')
  assert.equal(read1View?.totalLines, read1Payload.totalLines, 'read view totalLines 应等于 execute totalLines')
  assert.equal(read1View?.lang, 'markdown', 'read view lang 应为 markdown')
  const identity = read1View?.content?.[0]?.text ?? ''
  assert.ok(identity.includes('source:'), 'read fallback content[0] 应含 source 身份行')
  assert.ok(identity.includes('cwd'), `read identity 应明示 source=cwd,实际: ${identity}`)
  assert.ok(identity.includes(read1Payload.path ?? ''), 'read identity 应含完整 path(便于 UI 高亮与跳转)')
  assert.ok((read1View?.content?.[1]?.text ?? '').includes('行程 2027'), 'read fallback content[1] 应为正文')
  console.log(`[2/4] CONTRACT read → ReadResultView{ card:'read', path:'${read1View!.path}', totalLines:${read1View!.totalLines}, identity:'${identity.slice(0, 80)}...' }`)

  // ── 5) modify 阶段:写入新内容到 fixture(模拟 agent/用户在侧栏修产物)──
  appendFileSync(fixturePath, '\nDay 6: 曼谷 → 普吉\nDay 7: 普吉 → 曼谷\nDay 8: 曼谷 → 北京')
  console.log(`[3/4] MODIFY  fixture 追加 3 行,模拟产物版本变更`)

  // ── 6) view-updated 阶段:再 read,断言看到新版本 ───────────────────────
  const read2Payload = await readTool.execute({ path: 'trip-2027.md' }, exec) as {
    ok?: boolean
    totalLines?: number
    lines?: Array<{ number: number; text: string }>
  }
  assert.equal(read2Payload.ok, true, 'view-updated read 应 ok')
  assert.equal(read2Payload.totalLines, 10, '新版本 totalLines 应为 10(原 7 + 3)')
  assert.ok(read2Payload.lines?.[0]?.text.includes('行程 2027'), 'view-updated 首行仍为标题')
  assert.ok(read2Payload.lines?.some(l => l.text.includes('Day 6')), 'view-updated 应包含新追加 Day 6')
  const read2View = readTool.presentResult?.({ path: 'trip-2027.md' }, toolResult(readTool, { path: 'trip-2027.md' }, read2Payload))
  assert.equal(read2View?.totalLines, 10, 'view-updated ReadResultView totalLines 应等于 10')
  assert.ok((read2View?.content?.[1]?.text ?? '').includes('Day 6'), 'view-updated fallback content 应含 Day 6(UI 重新打开产物拿到最新版本)')
  console.log(`[3/4] VIEW-UPDATED read.execute → { totalLines:${read2Payload.totalLines}, lines:[${read2Payload.lines?.length}] },ReadResultView.content 含 Day 6`)

  // ── 7) 边界:越界路径 / 非白名单扩展名 / 不存在文件 ────────────────────
  const outOfScope = await readTool.execute({ path: '../../../../etc/passwd' }, exec) as { ok?: boolean; error?: string }
  assert.equal(outOfScope.ok, false, '越界路径必须被拒')
  assert.ok(/scope|outside|workspace|越界/i.test(outOfScope.error ?? ''), `越界错误信息应明示 scope,实际: ${outOfScope.error}`)
  console.log(`[4/4] GUARDRAIL 越界路径拒 ok=false,error 含 scope 类字样`)

  const notFound = await readTool.execute({ path: 'never-written.md' }, exec) as { ok?: boolean; error?: string }
  assert.equal(notFound.ok, false, '不存在文件应 ok=false(不静默 ok)')
  assert.ok(/not found|不存在/i.test(notFound.error ?? ''), `不存在错误信息应明示 not found,实际: ${notFound.error}`)
  console.log(`[4/4] GUARDRAIL 不存在文件拒 ok=false,error 含 not-found 类字样`)

  // ── 8) issue #458:registered-plugin list → pagination/search → read → Host 演示 ──
  // >50 混合源(账本 + legacy + cwd)fixture,stable tie-break / dedupe / filtered total /
  // safe args,经 registerGuarded → defineTool 真实 execute + presentResult,证明
  // DSH host 装载的产物工具体表里 #458 的新参数(limit/offset/search)在 host presenter
  // 层面仍然保持 SearchPathsResultView contract(paths/total/truncated)。
  //
  // 注意:不重新 apply() —— 插件装载由外层统一完成,这里直接在外层已注册的工具上
  // 切换 session cwd/stateRoot;fixture 全部写入外层的 stateRoot / workspace,确保
  // 真实 execute 走到的就是同一份 list tool 闭包。
  try {
    const issue458Root = stateRoot
    const issue458Cwd = cwd
    // 账本 2:cap-mix-a / cap-mix-b
    const { ensureLedger } = await import('../src/state-ledger.ts')
    const ledger = ensureLedger(issue458Root)
    ledger.createWorkflowRun({ id: 'cap-mix-a', goal: '账本权威 a', ticket: { objective: 'mix' }, state: {} })
    ledger.settleWorkflowRun('cap-mix-a', '# mix a\nD1 大理\nD2 洱海\n')
    ledger.createWorkflowRun({ id: 'cap-mix-b', goal: '账本权威 b', ticket: { objective: 'mix' }, state: {} })
    ledger.settleWorkflowRun('cap-mix-b', '# mix b\nD1 西双版纳\nD2 普洱\n')
    // legacy 文件视图 2(无 ledger authority)
    mkdirSync(join(issue458Root, 'gotry-state', 'async'), { recursive: true })
    writeFileSync(join(issue458Root, 'gotry-state', 'async', 'legacy-1.deliverable.md'), '# legacy\n')
    writeFileSync(join(issue458Root, 'gotry-state', 'async', 'legacy-2.deliverable.md'), '# legacy\n')
    // cwd 60 fixture,带 mtime 严格递增 + 1 个 mtime 很老的"老产物"。
    // 注:外层 fixture(trip-2027.md)在 cwd 中,mtime 大约 = 此刻,会落在最新区段;
    // 这里特意让 note-* mtime 起点 = UTC 2026-01-01 00:00:00,小于 trip-2027.md,
    // 排序仍稳定(cwd-file source 同,按 id 词典序作 tie-break)。
    const { utimesSync } = await import('node:fs')
    for (let i = 0; i < 60; i++) {
      const name = `note-${String(i).padStart(3, '0')}.md`
      const p = join(issue458Cwd, name)
      writeFileSync(p, `# ${name}\nbody\n`)
      utimesSync(p, new Date(Date.UTC(2026, 0, 1, 0, 0, i)), new Date(Date.UTC(2026, 0, 1, 0, 0, i)))
    }
    writeFileSync(join(issue458Cwd, 'special-deliverable.md'), '# special\nbody\n')
    utimesSync(
      join(issue458Cwd, 'special-deliverable.md'),
      new Date('2020-01-01T00:00:00Z'),
      new Date('2020-01-01T00:00:00Z'),
    )

    const hostList = listTool
    const hostRead = readTool
    const hostExec = exec

    // a) 真实分页 — 不带 search,limit=20,offset=0 → page1
    const page1 = await hostList.execute({ limit: 20 }, hostExec) as {
      ok?: boolean
      artifacts?: Array<{ path?: string; source?: string }>
      total?: number
      truncated?: boolean
      nextOffset?: number
      offset?: number
      limit?: number
      summary?: string
    }
    assert.equal(page1.ok, true, 'page1 execute 应 ok')
    assert.equal(page1.artifacts?.length, 20, `page1 长度应 20,实际 ${page1.artifacts?.length}`)
    assert.equal(page1.total, 66, `page1 total 应 66(2 账本 + 2 legacy + 60 cwd + 1 老 + 1 trip-2027),实际 ${page1.total}`)
    assert.equal(page1.truncated, true, 'page1 truncated 应 true')
    assert.equal(page1.nextOffset, 20, `page1 nextOffset 应 20,实际 ${page1.nextOffset}`)
    assert.equal(page1.limit, 20, `page1 limit echo 应 20`)
    assert.equal(page1.offset, 0, `page1 offset echo 应 0`)
    const page1View = hostList.presentResult?.({}, toolResult(hostList, {}, page1))
    assert.equal(page1View?.card, 'search', '分页仍应保持 SearchPathsResultView card')
    assert.equal(page1View?.shape, 'paths', '分页仍应保持 SearchPathsResultView shape')
    assert.equal(page1View?.paths?.length, 20, 'presenter paths 长度应等于 page1.artifacts.length')
    assert.equal(page1View?.total, 66, 'presenter total 应等于 execute total')
    assert.equal(page1View?.truncated, true, 'presenter truncated 应等于 execute truncated')
    console.log(`[5/7] #458 page1 → 20 项 / total=65 / truncated=true / SearchPathsResultView contract OK`)

    // b) 翻页 — page2/3/4 拼起来必须唯一覆盖全部 65 条
    const page2 = await hostList.execute({ limit: 20, offset: 20 }, hostExec) as typeof page1
    const page3 = await hostList.execute({ limit: 20, offset: 40 }, hostExec) as typeof page1
    const page4 = await hostList.execute({ limit: 20, offset: 60 }, hostExec) as typeof page1
    const all = new Set<string>()
    for (const p of [page1, page2, page3, page4]) {
      for (const a of p.artifacts ?? []) all.add(String(a.path))
    }
    assert.equal(all.size, 66, `page1..page4 拼接后 66 个唯一 path,实际 ${all.size}`)
    assert.equal(page4.artifacts?.length, 6, `page4 应 6 条,实际 ${page4.artifacts?.length}`)
    assert.equal(page4.truncated, false, `page4 已无更多,truncated=false`)
    assert.equal(page4.nextOffset, undefined, `page4 无 nextOffset`)
    assert.equal(page4.offset, 60, `page4 offset echo 应回填请求值 60`)
    console.log(`[5/7] #458 page2/3/4 拼接唯一覆盖 66 条,page4=6 / truncated=false / offset=60 OK`)

    // c) search — 即使 limit=1,也能直接命中老产物
    const direct = await hostList.execute({ limit: 1, search: 'special-deliverable' }, hostExec) as typeof page1 & { search?: string }
    assert.equal(direct.total, 1, `search='special-deliverable' 应命中 1 条`)
    assert.equal(direct.artifacts?.length, 1)
    assert.equal(direct.truncated, false)
    assert.equal(direct.search, 'special-deliverable', 'search 应回填 trim 后值')
    assert.ok(direct.artifacts?.[0]?.path?.endsWith('/special-deliverable.md'), `应命中老产物 path`)
    const directView = hostList.presentResult?.({ search: 'special-deliverable' }, toolResult(hostList, { search: 'special-deliverable' }, direct))
    assert.equal(directView?.total, 1, 'search presentResult.total 应 = 1')
    assert.equal(directView?.paths?.length, 1, 'search presentResult.paths 应 = 1')
    console.log(`[5/7] #458 search='special-deliverable' → limit=1 直接命中老产物,total=1 / search echo OK`)

    // d) safe args:无效 offset / limit / search 经 execute 透传到能力层应被拒,
    //    registered tool 仍以 ok:false 包出(无未捕获 throw 越过 host 边界)。
    //    DSH host 的 schema 类型校验在最外层兜底,某些坏参会先由 schema 拒绝 →
    //    guardToolExecute 包成 ok:false + summary;另一些(超出 schema 范围但
    //    类型仍合法)则走 capability 层 normalize* 拒绝 → error 字段。两条路径
    //    都必须非 ok=true,且含相应字段名。
    const badOffset = await hostList.execute({ offset: -1 }, hostExec) as { ok?: boolean; error?: string; summary?: string }
    assert.equal(badOffset.ok, false, '负 offset 必须被拒 ok=false')
    assert.ok(/offset/i.test(String(badOffset.error ?? badOffset.summary ?? '')), `错误应含 offset 描述,实际 ${badOffset.error ?? badOffset.summary}`)
    // 字符串 limit:host schema 类型校验兜底(summary 路径)
    const badLimit = await hostList.execute({ limit: '20' as unknown as number }, hostExec) as { ok?: boolean; error?: string; summary?: string }
    assert.equal(badLimit.ok, false, '字符串 limit 必须被拒 ok=false')
    assert.ok(/limit/i.test(String(badLimit.error ?? badLimit.summary ?? '')), `错误应含 limit 描述,实际 ${badLimit.error ?? badLimit.summary}`)
    // 非字符串 search:host schema 同样兜底
    const badSearch = await hostList.execute({ search: 5 as unknown as string }, hostExec) as { ok?: boolean; error?: string; summary?: string }
    assert.equal(badSearch.ok, false, '非字符串 search 必须被拒 ok=false')
    assert.ok(/search/i.test(String(badSearch.error ?? badSearch.summary ?? '')), `错误应含 search 描述,实际 ${badSearch.error ?? badSearch.summary}`)
    console.log(`[5/7] #458 safe args:offset=-1 / limit='20' / search=5 全部 ok=false,error/summary 含字段名 OK`)

    // e) list→read 实际串联 — 用 search 结果的 path 走 readArtifact,断言 presentResult 仍 ok
    const listViewPath = direct.artifacts![0]!.path!
    const readByPath = await hostRead.execute({ path: listViewPath }, hostExec) as {
      ok?: boolean
      source?: string
      lang?: string
      totalLines?: number
    }
    assert.equal(readByPath.ok, true, 'list 串联 read 应 ok')
    assert.equal(readByPath.source, 'cwd', '老产物 source 应 cwd')
    assert.equal(readByPath.lang, 'markdown')
    const readView = hostRead.presentResult?.({ path: listViewPath }, toolResult(hostRead, { path: listViewPath }, readByPath))
    assert.equal(readView?.card, 'read', 'list→read 串联 read card 应仍 read')
    assert.equal(readView?.totalLines, readByPath.totalLines)
    console.log(`[5/7] #458 list→read 串联:search 命中的 path 经 readArtifact 返回 OK,ReadResultView contract 保持 OK`)

    // f) 越界 page(请求 offset=9999)→ 空页 + 已知 total + 无 nextOffset
    const beyond = await hostList.execute({ offset: 9999 }, hostExec) as typeof page1
    assert.equal(beyond.ok, true)
    assert.equal(beyond.artifacts?.length, 0, `越界应空页,实际 ${beyond.artifacts?.length}`)
    assert.equal(beyond.total, 66, `越界仍应回填 total=66,实际 ${beyond.total}`)
    assert.equal(beyond.truncated, false, `越界 truncated=false`)
    assert.equal(beyond.nextOffset, undefined, `越界无 nextOffset`)
    assert.equal(beyond.offset, 9999, `越界 offset echo 应回填请求值 9999`)
    const beyondSummary = String(beyond.summary ?? '')
    assert.ok(!/无在册产物/.test(beyondSummary), `越界 summary 不得误报「无在册产物」,实际: ${beyondSummary}`)
    assert.ok(beyondSummary.includes('空页') && beyondSummary.includes('66'), `越界 summary 应明示空页 + known total,实际: ${beyondSummary}`)
    console.log(`[5/7] #458 越界页:empty page + total=66 + 无 nextOffset + summary 明示空页/known total OK`)
  } catch (err) {
    throw err
  }

  // ── 清理 ────────────────────────────────────────────────────────────────
  rmSync(home, { recursive: true, force: true })
  console.log('\nDSH ARTIFACT HOST CONTRACT PROOF: list/read metadata, source identity, view-updated loop, guardrails OK; fresh-profile Web custom-card path covered separately by `npx tsx scripts/dsh-artifact-web-e2e.ts` (not part of the cross-platform full suite)')
}

await main()
