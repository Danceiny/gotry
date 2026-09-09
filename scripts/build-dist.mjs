#!/usr/bin/env node
/**
 * 预编译插件为纯 JS dist/(构建期走声明的 TypeScript 编译器):
 *
 * 为什么:Node 拒绝对 node_modules 下的 .ts 做 type-stripping
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)——npm 安装后 dsh 加载
 * gotry-tools 插件必炸。发布前把 ts/{src,capabilities,scripts} 编成
 * dist/ 纯 JS,bin/gotry-inner.js 在 npm 模式和无 tsx loader 的源码模式下
 * 指向 dist/src/index.js；显式 tsx loader 才直载 .ts(D-27 后无 legacy vendored 形态)。
 *
 * 运行: node scripts/build-dist.mjs(发布脚本自动调)
 */

import { copyFileSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, dirname, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = ['ts/src', 'ts/capabilities', 'ts/scripts']
const DATA = ['session-golden-20.json', 'sf-golden-manifest.json', 'sf-static-routes.json']
const OUT = join(root, 'dist')
const TYPESCRIPT_VERSION = '5.9.3'

// Build tooling is intentionally rooted at this package. Do not silently pick
// up a global compiler, a parent-workspace hoist, or ts/node_modules: byte and
// syntax output must stay bound to the exact root declaration.
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (rootManifest.devDependencies?.typescript !== TYPESCRIPT_VERSION) {
  throw new Error(`root devDependency typescript must be exactly ${TYPESCRIPT_VERSION}`)
}
const typescriptEntry = fileURLToPath(import.meta.resolve('typescript'))
const compilerRelative = relative(join(root, 'node_modules'), typescriptEntry)
if (compilerRelative === '..' || compilerRelative.startsWith(`..${sep}`) || isAbsolute(compilerRelative)) {
  throw new Error(`TypeScript must resolve within root node_modules, got ${typescriptEntry}`)
}
if (ts.version !== TYPESCRIPT_VERSION) {
  throw new Error(`TypeScript ${TYPESCRIPT_VERSION} required, loaded ${ts.version}`)
}

// 先清后建:源码删除的文件(如 session-attach-*.ts)其陈旧编译产物会残留并进 tarball
rmSync(OUT, { recursive: true, force: true })

function walk(dir, extension = '.ts') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, extension))
    else if (name.endsWith(extension)) out.push(p)
  }
  return out
}

function rewriteRelativeTypeScriptSpecifiers(source) {
  return source.replace(/(['"])(\.[^'"]*?)\.ts\1/g, '$1$2.js$1')
}

// 非 JS 支撑资产逐字节随 dist 分发(files 白名单已含 dist/)。agent-reach
// wrapper 在 dist/capabilities/ 找 Python 反射桥；sf-live runner 与 static
// provider 从 dist/data/ 读取同一组 benchmark 输入。
mkdirSync(join(OUT, 'capabilities'), { recursive: true })
copyFileSync(join(root, 'ts/capabilities/agent-reach-bridge.py'), join(OUT, 'capabilities/agent-reach-bridge.py'))
mkdirSync(join(OUT, 'data'), { recursive: true })
for (const file of DATA) {
  copyFileSync(join(root, 'ts/data', file), join(OUT, 'data', file))
}

let n = 0
for (const dir of SRC) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(join(root, 'ts'), file).replace(/\.ts$/, '.js')
    const target = join(OUT, rel)
    // Keep generated output reproducible: absolute temp/worktree paths would
    // leak into source maps and make the release manifest vary per machine.
    const sourceUrl = relative(root, file).split(sep).join('/')
    const transformed = ts.transpileModule(readFileSync(file, 'utf-8'), {
      fileName: sourceUrl,
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        sourceMap: false,
        inlineSourceMap: false,
        inlineSources: false,
        importHelpers: false,
      },
      reportDiagnostics: true,
    })
    if (transformed.diagnostics?.length) {
      const host = {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }
      const message = ts.formatDiagnosticsWithColorAndContext(transformed.diagnostics, host)
      throw new Error(`TypeScript transpile failed for ${sourceUrl}\n${message}`)
    }
    let js = transformed.outputText
    // 相对 `.ts` 字符串说明符统一改为 `.js`，同时覆盖静态 import、
    // re-export 与先绑定字符串再传给动态 import 的路径。
    js = rewriteRelativeTypeScriptSpecifiers(js)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, js)
    n++
  }
}

// Runtime JS assets live next to their TypeScript callers. Preserve their text
// except for the same required relative `.ts` -> `.js` specifier rewrite.
let jsAssets = 0
for (const dir of SRC) {
  for (const extension of ['.js', '.mjs']) {
    for (const file of walk(join(root, dir), extension)) {
      const rel = relative(join(root, 'ts'), file)
      const target = join(OUT, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, rewriteRelativeTypeScriptSpecifiers(readFileSync(file, 'utf8')))
      jsAssets++
    }
  }
}
console.log(`dist built: ${n} TS files + ${jsAssets} JS assets + ${DATA.length} data files → ${relative(root, OUT)}/`)
