/**
 * Session V3 确定性迁移契约(issue #268):在隔离临时目录下用真实发布的 V2 编解码器
 * 生成 V2 header/events,序列化为 JSONL 字节写入磁盘,保存确切源字节快照;通过
 * sessionFormatCatalog 从磁盘读取并解析这些字节,分类为 migration-required,迁移为
 * V3,编码独立 V3 继任者写入磁盘;然后用 catalog validation:current 完全解码 V3
 * 继任者;迁移后重新读取 V2 源文件做字节比较,证明迁移不修改源工件字节。
 *
 * 这是确定性格式兼容性证据(隔离文件字节,非内存 structuredClone),不是创始人状态
 * 迁移,也不是 M5/M6 准入。
 *
 * 运行:cd ts && npx tsx scripts/dsh-session-v3-migration-proof.ts
 */
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
} from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'

// 最小有效 V2 工件:一个 turn 包含一个 step,turn 正常完成。
// V2 事件处置要求 turn/start 需 ["turn"],step/start|step/end 需 ["turn","step"],
// turn/end 需 ["turn","reason"],reason.kind="completed" 是最简有效种类。
const v2Header: SessionFormatHeader = {
  version: 2,
  id: 's-min-v2',
  createdAt: 1700000000000,
  isSeeded: false,
  delegationDepth: 0,
}

const v2Events: readonly SessionFormatEvent[] = [
  { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 1700000000001, data: { turn: 1, step: 1 } },
  { type: 'step/end', seq: 2, time: 1700000000002, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 3, time: 1700000000003, data: { turn: 1, reason: { kind: 'completed' } } },
]

// 1. 用真实发布的 V2 编解码器编码 header + 事件行为 JSON 对象,序列化为 JSONL 字节。
const encodedHeader: SessionFormatJsonObject = releasedV2SessionFormatCodec.encodeHeader(v2Header, 0)
const encodedRows: SessionFormatJsonObject[] = v2Events.map((e) => releasedV2SessionFormatCodec.encodeEvent(e))

function toLine(obj: SessionFormatJsonObject): string {
  return JSON.stringify(obj)
}

const sourceLines = [toLine(encodedHeader), ...encodedRows.map(toLine)]
const sourceJsonl = sourceLines.join('\n') + '\n'

const tmp = mkdtempSync(join(tmpdir(), 'session-v3-migration-proof-'))
const sourcePath = join(tmp, 'source.v2.jsonl')
const successorPath = join(tmp, 'successor.v3.jsonl')

try {
  // 2. 写 V2 源字节到磁盘,保存确切源字节快照。
  writeFileSync(sourcePath, sourceJsonl, 'utf8')
  const sourceBytes = readFileSync(sourcePath)

  // 3. 从磁盘读取并解析 V2 源字节:首行 = header,其余 = 事件行。
  const parsedLines = readFileSync(sourcePath, 'utf8').split('\n').filter((l) => l.length > 0)
  assert.ok(parsedLines.length === sourceLines.length, `磁盘行数必须等于源行数(${parsedLines.length} vs ${sourceLines.length})`)
  const headerValue: unknown = JSON.parse(parsedLines[0])
  const rowValues: unknown[] = parsedLines.slice(1).map((l) => JSON.parse(l))

  // 4. catalog 当前版本 = 3;V2 header 分类为 migration-required。
  assert.equal(sessionFormatCatalog.currentVersion, 3, 'catalog 当前版本必须为 3')
  const headerRead = sessionFormatCatalog.readHeader(headerValue)
  assert.equal(
    headerRead.status,
    'migration-required',
    `V2 header 必须分类为 migration-required(当前 ${headerRead.status})`,
  )

  // 5. 创建恢复器,逐行解码,完成恢复为 V3 工件(validation:transformed,迁移后校验)。
  const restore = sessionFormatCatalog.createRestore(headerValue, {
    recovery: 'recoverable',
    validation: 'transformed',
  })
  for (const row of rowValues) {
    restore.decodeRow(row)
  }
  const artifact: SessionFormatArtifact = restore.finish()

  // 6. V3 工件版本 = 3,事件数 = V2 + 1(在 step/start 后插入 system head)。
  assert.equal(artifact.header.version, 3, '恢复后工件版本必须为 3')
  assert.equal(
    artifact.events.length,
    v2Events.length + 1,
    `V3 事件数必须 = V2 + 1(插入 system head),当前 ${artifact.events.length}`,
  )

  // 插入的 system head(原 step/start 后,索引 2)必须是 system/message。
  const inserted = artifact.events[2]
  assert.equal(inserted.type, 'system/message', `插入的事件必须是 system/message(当前 ${inserted.type})`)

  // 7. 编码 V3 继任者为 JSONL 字节,写入独立磁盘文件。
  const v3HeaderRecord = sessionFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount)
  const v3RowRecords: SessionFormatJsonObject[] = artifact.events.map((e) => sessionFormatCatalog.encodeCurrentEvent(e))
  const successorLines = [toLine(v3HeaderRecord), ...v3RowRecords.map(toLine)]
  const successorJsonl = successorLines.join('\n') + '\n'
  writeFileSync(successorPath, successorJsonl, 'utf8')

  // 8. 从磁盘读取 V3 继任者,用 catalog validation:current 完全解码。
  const successorParsed = readFileSync(successorPath, 'utf8').split('\n').filter((l) => l.length > 0)
  assert.ok(successorParsed.length === successorLines.length, `V3 磁盘行数必须等于继任者行数`)
  const successorHeaderValue: unknown = JSON.parse(successorParsed[0])
  const successorRowValues: unknown[] = successorParsed.slice(1).map((l) => JSON.parse(l))

  const successorRead = sessionFormatCatalog.readHeader(successorHeaderValue)
  assert.equal(successorRead.status, 'current', `V3 继任者必须重新打开为 current(当前 ${successorRead.status})`)

  const successorRestore = sessionFormatCatalog.createRestore(successorHeaderValue, {
    recovery: 'recoverable',
    validation: 'current',
  })
  for (const row of successorRowValues) {
    successorRestore.decodeRow(row)
  }
  const successorArtifact: SessionFormatArtifact = successorRestore.finish()
  assert.equal(successorArtifact.header.version, 3, 'V3 继任者完全解码后版本必须为 3')
  assert.equal(
    successorArtifact.events.length,
    artifact.events.length,
    'V3 继任者完全解码后事件数必须与迁移工件一致',
  )

  // 9. 迁移后重新读取 V2 源文件字节,与快照字节比较——证明迁移不修改源工件字节。
  const sourceBytesAfter = readFileSync(sourcePath)
  assert.ok(
    Buffer.compare(sourceBytes, sourceBytesAfter) === 0,
    '迁移后 V2 源文件字节必须与快照完全一致——迁移不修改源工件字节',
  )

  console.log(
    `SESSION V3 MIGRATION PROOF: V2 source ${sourceBytes.length}B (${v2Events.length} events) on disk → ` +
      `V3(${artifact.events.length} events, +system/message), successor ${successorJsonl.length}B reopens as current ` +
      `and fully decodes (${successorArtifact.events.length} events), source bytes unchanged after migration`,
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}