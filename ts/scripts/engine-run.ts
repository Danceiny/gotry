// TS 引擎直接跑洱海金标准用例,打印与 Python 相同结构的结果
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCandidate, parseRequest } from '../src/model.ts'
import { solve } from '../src/engine.ts'

const payload = JSON.parse(await readFile(join('..', 'data', 'golden_erhai.json'), 'utf-8'))
const req = parseRequest(payload['request'])
const candidates = (payload['candidates'] as Record<string, unknown>[]).map(parseCandidate)
const t0 = Date.now()
const result = await solve(req, candidates)
console.log(`(TS 引擎总耗时含 WASM init: ${Date.now() - t0}ms, recommended=${result['recommended']})\n`)
console.log(result['answer_md'])
