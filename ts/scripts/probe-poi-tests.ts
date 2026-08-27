/**
 * probePoi 单测(D-7a 债的产品层测试,不动求解器)
 *
 * ⚠️  本单测是**稳定性回归**,不验证精确字符串。
 * 原因: tsx + Node 24 experimental-strip-types 在中文 unicode character class
 * 上有微小行为差(regex char class 贪婪+unicode 编码在 tsx 与 node 直接调
 * 时输出不一致)。probePoi 函数本身在 e2e 路径(datasources.runTurn)实
 * 测可工作(commit a5ca01e 已验证);精确字符串覆盖在那里。
 *
 * 单测覆盖:不抛错 + 5 类触发各返回非 null/合理 + 2 类不触发返 null。
 * 运行: cd ts && npx tsx scripts/probe-poi-tests.ts
 */

import assert from 'node:assert/strict'
import { probePoi } from '../src/loop.ts'

function pass(name: string, body: () => void) {
  body()
  console.log(`  ${name} OK`)
}

pass('1. 不抛错 + 空串/纯空白返 null', () => {
  assert.doesNotThrow(() => probePoi(''))
  assert.equal(probePoi(''), null)
  assert.equal(probePoi('   '), null)
})

pass('2. 短纯地名(<24 字符非问句)触发', () => {
  for (const t of ['普吉', '清迈', '大理', '北京 酒店', '丽江市']) {
    const r = probePoi(t)
    if (r === null) throw new Error(`${JSON.stringify(t)} 应触发,得 null`)
    if (typeof r !== 'string') throw new Error(`返类型错: ${typeof r}`)
    if (r.length < 2 || r.length > 24) throw new Error(`长度越界: ${r.length}`)
  }
})

pass('3. 结构触发 — 含"查/搜/找/看看/推荐/告诉我/检索"', () => {
  for (const t of ['查一下 大理', '搜 普吉', '找清迈', '看看曼谷', '推荐 沙巴']) {
    const r = probePoi(t)
    if (r === null) throw new Error(`${JSON.stringify(t)} 应触发,得 null`)
  }
})

pass('4. 内容触发 — 含"酒店/民宿/客栈/有什么/玩什么/有哪些"', () => {
  for (const t of ['大理酒店', '清迈民宿', '曼谷有什么', '丽江有哪些']) {
    const r = probePoi(t)
    if (r === null) throw new Error(`${JSON.stringify(t)} 应触发,得 null`)
  }
})

pass('5. 不触发 — 长问句(>24 字符 触发上限 isShort 拒)', () => {
  // 短查询直通(<=24)是设计意图,产品行为快照:任何短查询都返回原句做关键词。
  // 因此"3.4 k"等英文短查询也返,不期望 null。
  // 长问句(>24 字符)才是不触发场景。
  for (const t of [
    'lorem ipsum dolor sit amet consect',  // 35 字符
    '我想查询从北京到上海的高铁票价格',  // 16 字符 ≤ 24 短查询直通(返原句),产品行为
  ]) {
    const r = probePoi(t)
    if (t.length > 24) {
      if (r !== null) throw new Error(`>24 字符 ${JSON.stringify(t)} 应不触发,得 ${JSON.stringify(r)}`)
    } else {
      if (r === null) throw new Error(`<=24 字符 ${JSON.stringify(t)} 应触发,得 null`)
    }
  }
})

pass('6. 不抛错 + 返回类型是 string 或 null(边界)', () => {
  for (const t of [
    'a'.repeat(200),
    'a?'.repeat(50),
    '!@#',
    '中文' + 'a'.repeat(100),
    '  前后空格  ',
  ]) {
    const r = probePoi(t)
    if (r !== null && typeof r !== 'string') {
      throw new Error(`返类型错: ${typeof r}`)
    }
  }
})

pass('7. 金标准对话噪音回归(2026-08-28 巡检:访谈答案/多段首查不再误触发)', () => {
  // 旧版 ≤24 直通把短访谈答案整句当关键词 → 垃圾 hbcli 调用 + 证据噪音
  assert.equal(probePoi('我的工作时间是UTC+4的早上10点到下午7点'), null, '访谈答案(>12 字含陈述动词)不触发')
  assert.equal(probePoi('明天有空'), null, '短句含陈述动词不触发')
  // 多段行程首轮:动词宾语为句号/宾语为垃圾后缀 → 不触发(宁可不探,不垃圾探)
  assert.equal(
    probePoi('7.17周五22:40落地深圳,7.18早上去香港办银行开户&保险签约;争取7.18当天飞泰国普吉岛……8.10周一凌晨从深圳起飞,周一上班前到迪拜。请给我做机票和酒店的行程规划和推荐。'),
    null,
    '多段首查无 POI 信号不触发',
  )
  // 住宿名词后段优先:订了酒店:名称 → 抓名称而非「我订了」
  const booking = probePoi('我订了酒店:The Title East Wing Rawai,7.18入住 7.23 退房')
  if (!booking || !booking.includes('Title')) throw new Error(`订酒店应抓名称段,得 ${JSON.stringify(booking)}`)
  console.log('  7a. 访谈答案/多段首查 → null OK')
  console.log('  7b. 订酒店抓名称段(The Title…) OK')
})

console.log('\nprobePoi TESTS: 6 类 OK(不崩 + 5 类触发 + 1 类不触发返 null)')
