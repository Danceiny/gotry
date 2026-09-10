/**
 * T1 合并守门层测试(纯函数,零状态,离线确定性):
 *  1. 追加不删史+幂等:同 evidence 不重复;既有依据永不移除(P0)
 *  2. 权重归一:P0 校验——改 weights 必须伴新 evidence,否则拒该部分
 *  3. 守卫:空补丁/无变化返 null;hard 覆盖后到优先
 *  4. (issue #338)homeCity 守门:同值幂等/改值须伴新证据/显式 null 清除/未传不触动
 *    + trim 后空白视为未传
 *    + homeCityPreference 三件套锁定(v/evidence/updated_at)
 *    + 无关补丁不改写 homeCityPreference
 *  5. (issue #338)resolveDefaultOrigin:显式 > home_default > missing 契约
 *    + 仅完整 typed preference 可产生 home_default;raw/坏 typed 数据一律 missing
 *    + validator 校验镜像、证据与 ISO-like timestamp
 */

import assert from 'node:assert/strict'
import { isValidHomeCityPreference, mergeProfile, resolveDefaultOrigin } from '../src/memory-capture.ts'

const T0 = '2026-09-10T00:00:00.000Z'
const T1 = '2026-09-10T01:00:00.000Z'
const T2 = '2026-09-10T02:00:00.000Z'

const cur = {
  weights: { escape_rest: 1 },
  evidence: ['用户原话:「想去湖边什么都不干」'],
  hard: { wake_not_before: '07:00' },
}

// 1) 追加不删史 + 幂等
{
  const m1 = mergeProfile(cur, { evidence: ['用户原话:「预算 5000 以内」', '用户原话:「想去湖边什么都不干」'] } as never, T0)
  assert.equal(m1?.evidence.length, 2, `追加新+跳过重复,实际 ${m1?.evidence.length}`)
  assert.ok(m1?.evidence[0].includes('湖边'), '既有 evidence 原位保留(P0)')
  const m2 = mergeProfile(m1 as never, { evidence: ['用户原话:「预算 5000 以内」'] } as never, T0)
  assert.equal(m2, null, '纯重复补丁应返 null(幂等)')
  console.log('1. 追加不删史 + 幂等 OK')
}

// 2) 权重归一与 P0 校验
{
  const m = mergeProfile(cur, { weights: { escape_rest: 0.5, curiosity: 0.5 }, evidence: ['用户原话:「这次既要躺平也要探索」'] } as never, T0)
  const sum = Object.values(m?.weights ?? {}).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 0.01, `权重应归一,实际 sum=${sum}`)
  const noEv = mergeProfile(cur, { weights: { escape_rest: 0.3, curiosity: 0.7 } } as never, T0)
  assert.equal(noEv?.weights.escape_rest, 1, '权重变更无新 evidence 应被拒(P0)')
  console.log('2. 权重归一 + P0 证据校验 OK')
}

// 2.5) 首次保存:current=null 视为空档案,补丁全量生效
{
  const first = mergeProfile(null, { weights: { escape_rest: 1 }, evidence: ['用户原话:「想去湖边」'] } as never, T0)
  assert.ok(first && first.evidence.length === 1 && Object.keys(first.weights).length === 1, '首存应生效')
  assert.equal(mergeProfile(null, null, T0), null, 'null 补丁仍守卫')
  console.log('2.5 首存语义(current=null→空档案) OK')
}

// 3) 守卫与 hard 覆盖
{
  assert.equal(mergeProfile(cur, null, T0), null, 'null 补丁')
  assert.equal(mergeProfile(cur, {} as never, T0), null, '空补丁')
  const m = mergeProfile(cur, { hard: { wake_not_before: '08:30', budget_cny: 5000 } } as never, T0)
  assert.equal((m?.hard as Record<string, unknown>)?.wake_not_before, '08:30', 'hard 后到优先')
  assert.equal((m?.hard as Record<string, unknown>)?.budget_cny, 5000, 'hard 新键并入')
  console.log('3. 空守卫 + hard 覆盖后到优先 OK')
}

console.log('\nMEMORY-MERGE TESTS: baseline merge guards OK')

// ---- 4) issue #338:homeCity 守门(纯函数,零状态) ------------------------------
{
  const unrelatedFirst = '用户原话:这次预算不超过 5000'
  const homeQuote = '用户原话:我常驻上海'
  const saved = mergeProfile(cur, {
    homeCity: '上海',
    evidence: [unrelatedFirst, homeQuote],
    homeCityEvidence: homeQuote,
  } as never, T0)
  assert.ok(saved?.homeCity === '上海', `首存 homeCity='上海' 应生效,实际 ${String(saved?.homeCity)}`)
  // typed preference 三件套锁定(issue #338):value / evidence / updated_at
  assert.ok(saved?.homeCityPreference?.value === '上海', 'homeCityPreference.value 锁定')
  assert.equal(saved?.homeCityPreference?.evidence, homeQuote, 'homeCityPreference.evidence 锁定到显式 homeCityEvidence(不依赖数组顺序)')
  assert.equal(saved?.homeCityPreference?.updated_at, T0, 'homeCityPreference.updated_at = 调用方传入的 now(非再读时钟)')
  assert.ok((saved?.evidence.indexOf(unrelatedFirst) ?? -1) < (saved?.evidence.indexOf(homeQuote) ?? -1),
    'counterexample:无关新事实在前,home-city 原话在后仍按 typed binding 落账')
  // 缺失、mismatched、stale binding 都必须拒绝整个 home-city 操作(null→账本零事件)
  assert.equal(mergeProfile(saved as never, {
    homeCity: '北京', evidence: ['用户原话:搬去北京', '用户原话:这次还要控制预算'],
  } as never, T1), null, '改城市多条 evidence 缺失 homeCityEvidence 应拒绝')
  assert.equal(mergeProfile(saved as never, {
    homeCity: '北京', evidence: ['用户原话:搬去北京'], homeCityEvidence: '用户原话:没有出现在本次 evidence',
  } as never, T1), null, 'homeCityEvidence 与本次 evidence 不匹配应拒绝')
  assert.equal(mergeProfile(saved as never, {
    homeCity: '北京', evidence: [homeQuote], homeCityEvidence: homeQuote,
  } as never, T1), null, '改城市绑定旧 evidence(stale)应拒绝')
  assert.equal(mergeProfile(saved as never, { homeCity: '北京', evidence: [] } as never, T1), null,
    'homeCity 零 evidence 应拒绝')
  const singleQuote = '用户原话:我常驻深圳'
  const singleEvidence = mergeProfile(cur, { homeCity: '深圳', evidence: [singleQuote] } as never, T1)
  assert.equal(singleEvidence?.homeCityPreference?.evidence, singleQuote, '单条非空 evidence 可省略 homeCityEvidence')
  assert.equal(mergeProfile(cur, {
    homeCity: '广州', evidence: ['用户原话:我常驻广州', '用户原话:预算 3000'],
  } as never, T1), null, '多条 evidence 缺 binding 应拒绝,不按数组顺序推断')
  assert.equal(mergeProfile(cur, {
    evidence: [singleQuote], homeCityEvidence: singleQuote,
  } as never, T1), null, 'homeCityEvidence 不得脱离 homeCity 单独传入')
  // 幂等:同值同 evidence → null(零事件)
  const dup = mergeProfile(saved as never, { homeCity: '上海', evidence: [homeQuote], homeCityEvidence: homeQuote } as never, T1)
  assert.equal(dup, null, 'homeCity 同值同 evidence 应幂等(null)')
  // 同值 + genuinely new typed home-city quote → 更新 preference 与 timestamp
  const refreshedQuote = '用户原话:我现在仍常驻上海'
  const refreshed = mergeProfile(saved as never, {
    homeCity: '上海', evidence: ['用户原话:无关新事实', refreshedQuote], homeCityEvidence: refreshedQuote,
  } as never, T1)
  assert.ok(refreshed?.homeCity === '上海', '同值 + 新 bound quote 应保留 homeCity')
  assert.equal(refreshed?.homeCityPreference?.evidence, refreshedQuote, '同值新 bound quote 更新 preference.evidence')
  assert.equal(refreshed?.homeCityPreference?.updated_at, T1, '同值新 bound quote 更新 preference.updated_at')
  // 改值 + 新 explicit bound quote → 生效;三件套全部以本次事件边界为准
  const changedQuote = '用户原话:我搬去北京长期居住'
  const changed = mergeProfile(refreshed as never, {
    homeCity: '北京', evidence: [changedQuote], homeCityEvidence: changedQuote,
  } as never, T1)
  assert.ok(changed?.homeCity === '北京', `homeCity 改值伴新证据应生效,实际 ${String(changed?.homeCity)}`)
  assert.equal(changed?.homeCityPreference?.value, '北京', '改值后 preference.value 跟新值')
  assert.equal(changed?.homeCityPreference?.evidence, changedQuote, '改值后 preference.evidence 锁定到 explicit bound quote')
  assert.equal(changed?.homeCityPreference?.updated_at, T1, '改值后 preference.updated_at = 本次事件边界')
  assert.ok((changed?.evidence?.length ?? 0) > (saved?.evidence?.length ?? 0), '改值时 evidence 追加不删史(P0)')
  // 显式清除 without valid new bound quote → null(零事件)
  assert.equal(mergeProfile(changed as never, {
    homeCity: null, evidence: [changedQuote], homeCityEvidence: changedQuote,
  } as never, T2), null, '显式清除绑定旧 evidence(stale)应拒绝')
  // 显式清除:homeCity=null + 新 exact bound quote → null value + audit tuple
  const clearQuote = '用户原话:我已迁居,不设常驻默认'
  const cleared = mergeProfile(changed as never, {
    homeCity: null, evidence: [clearQuote], homeCityEvidence: clearQuote,
  } as never, T2)
  assert.equal(cleared?.homeCity, null, '显式 null 应清除 homeCity')
  assert.equal(cleared?.homeCityPreference?.value, null, '清除后 preference.value = null')
  assert.equal(cleared?.homeCityPreference?.evidence, clearQuote, '清除后 preference.evidence 锁定到 exact bound quote')
  assert.equal(cleared?.homeCityPreference?.updated_at, T2, '清除后 preference.updated_at = 本次事件边界')
  assert.ok((cleared?.evidence?.length ?? 0) > (changed?.evidence?.length ?? 0), '清除时 evidence 追加')
  // 清除后再清除同值同 evidence → null(幂等)
  const dupClear = mergeProfile(cleared as never, { homeCity: null, evidence: [clearQuote], homeCityEvidence: clearQuote } as never, T2)
  assert.equal(dupClear, null, 'homeCity 同 null 同 evidence 应幂等(null)')
  // 未传 homeCity → 不触动既有值;新 evidence 仍追加(P0:不删史);homeCityPreference 保持不变
  const untouched = mergeProfile(saved as never, { evidence: ['用户原话:后续无关新事实'] } as never, T1)
  assert.equal(untouched?.homeCity, '上海', 'patch 不传 homeCity 不应触动既有 homeCity')
  assert.ok((untouched?.evidence ?? []).includes('用户原话:后续无关新事实'), '无 homeCity 变化时新 evidence 仍追加(append-only)')
  assert.equal(untouched?.homeCityPreference?.evidence, homeQuote, '无关 patch 不改写 homeCityPreference.evidence')
  assert.equal(untouched?.homeCityPreference?.updated_at, T0, '无关 patch 不改写 homeCityPreference.updated_at')
  // trim 后空白视为未传(不触发 homeCity 变更;若只有 homeCity 改 + 空白则整批幂等)
  const whitespaceOnly = mergeProfile(saved as never, { homeCity: '   ', evidence: ['用户原话:再次无关事实'] } as never, T1)
  // 空白 homeCity 视为未传,但新 evidence 不重复 → 仍生效(以新 evidence 追加为准)
  assert.equal(whitespaceOnly?.homeCity, '上海', 'trim 空白 homeCity 不改变值')
  assert.equal(whitespaceOnly?.homeCityPreference?.evidence, '用户原话:我常驻上海', 'trim 空白 homeCity 不改写 preference.evidence')
  console.log('4. homeCity 守门(同值幂等/改值须伴新证据/null 显式清除/未传不触动/空白拒收/typed preference 锁定) OK')
}

// ---- 5) issue #338:resolveDefaultOrigin 契约 -----------------------------------
{
  // 5a.typed preference 路径:证据来自完整 preference,而非全局 evidence tail
  const profileWithHome = {
    homeCity: '上海',
    evidence: ['用户原话:无关历史行程 1', '用户原话:无关历史行程 2', '用户原话:我常驻上海'],
    homeCityPreference: { value: '上海', evidence: '用户原话:我常驻上海', updated_at: T0 },
  }
  const profileCleared = {
    homeCity: null,
    evidence: ['用户原话:无关历史行程 1', '用户原话:注销常驻'],
    homeCityPreference: { value: null, evidence: '用户原话:注销常驻', updated_at: T2 },
  }
  const profileNone = { homeCity: undefined, evidence: [] }

  // 显式当轮 origin 永远赢
  const explicit = resolveDefaultOrigin('北京', profileWithHome)
  assert.equal(explicit.origin, '北京', '当轮显式 origin 必须赢')
  assert.equal(explicit.source, 'explicit', 'source 必须为 explicit')
  assert.equal(explicit.homeCityPreferenceSource, 'none', 'explicit 路径 source=none')
  // 当轮 origin 是空白 → 视为未传
  const blank = resolveDefaultOrigin('   ', profileWithHome)
  assert.equal(blank.source, 'home_default', '空白 origin 应视作未传,落到 home_default')
  assert.equal(blank.origin, '上海', '空白 origin 时 homeCity 应被使用')

  // 未传 origin → 用持久 homeCity + typed preference 的锁定证据(不是全局 evidence tail)
  const homeDefault = resolveDefaultOrigin(undefined, profileWithHome)
  assert.equal(homeDefault.origin, '上海', '未传 origin 且有 homeCity → 上海')
  assert.equal(homeDefault.source, 'home_default', 'source=home_default')
  assert.equal(homeDefault.homeCityPreferenceSource, 'typed', 'typed preference 路径来源标签')
  assert.deepEqual(homeDefault.homeCityEvidence, ['用户原话:我常驻上海'], 'homeCityEvidence 携带 preference 锁定指针')

  // 关键不变量:无关 evidence 追加不进 homeCityEvidence——重新 resolve 后仍锁定
  // preference.evidence,不读取全局 evidence tail
  const driftEvidence = {
    ...profileWithHome,
    evidence: [...profileWithHome.evidence, '用户原话:不相关的新事实:孩子要上学'],
  }
  const afterDrift = resolveDefaultOrigin(undefined, driftEvidence)
  assert.deepEqual(afterDrift.homeCityEvidence, ['用户原话:我常驻上海'], '无关 evidence 追加不污染 homeCityEvidence(锁定到 preference)')

  // 显式 null 清除 → missing(source 标签为 missing,不再渲染 preference)
  const missingCleared = resolveDefaultOrigin(undefined, profileCleared)
  assert.equal(missingCleared.origin, null, '显式清除后必须 missing(不猜测)')
  assert.equal(missingCleared.source, 'missing', 'source=missing')
  assert.equal(missingCleared.homeCityPreferenceSource, 'none', 'missing 路径不渲染 preference')

  // 从未存 → missing
  const missingNone = resolveDefaultOrigin(undefined, profileNone)
  assert.equal(missingNone.source, 'missing', '从未存 homeCity 必须 missing')
  assert.equal(missingNone.origin, null, 'never-saved 必须 null,绝不猜测')

  // 空字符串/纯空白都视作未传
  const emptyStr = resolveDefaultOrigin('', profileWithHome)
  assert.equal(emptyStr.source, 'home_default', '空字符串 origin 应视作未传')

  // 5b.raw/坏 typed profile:不可产生默认,也不暴露全局 evidence 作为城市原话
  const legacyProfile = {
    homeCity: '上海',
    evidence: ['用户原话:无关历史行程 1', '用户原话:无关历史行程 2', '用户原话:旧版我常驻上海'],
  }
  const legacyResolved = resolveDefaultOrigin(undefined, legacyProfile)
  assert.equal(isValidHomeCityPreference(legacyProfile), false, 'raw legacy homeCity 无 typed preference 应无效')
  assert.equal(legacyResolved.source, 'missing', 'raw legacy homeCity 必须 missing')
  assert.equal(legacyResolved.origin, null, 'raw legacy homeCity 不得推断 origin')
  assert.equal(legacyResolved.homeCity, undefined, 'raw legacy homeCity 不得泄漏为 resolver 值')
  assert.equal(legacyResolved.homeCityEvidence, undefined, 'raw legacy evidence 不得成为城市证据')

  const validPreference = profileWithHome.homeCityPreference
  assert.equal(isValidHomeCityPreference(profileWithHome), true, '完整 typed preference 应有效')
  assert.equal(isValidHomeCityPreference({
    homeCity: '上海', homeCityPreference: validPreference,
  }), false, '缺失全局 evidence pool 应无效')
  assert.equal(isValidHomeCityPreference({
    homeCity: '上海', evidence: validPreference.evidence,
    homeCityPreference: validPreference,
  }), false, '非数组 evidence pool 应无效')
  const unboundEvidence = {
    homeCity: '上海', evidence: ['用户原话:全局无关事实'],
    homeCityPreference: { ...validPreference, evidence: '用户原话:不在 evidence pool' },
  }
  assert.equal(isValidHomeCityPreference(unboundEvidence), false, 'typed evidence 不在全局 pool 应无效')
  assert.equal(resolveDefaultOrigin(undefined, unboundEvidence).source, 'missing', '不在 pool 的 typed evidence 必须 missing')
  const impossibleTimestamp = {
    ...profileWithHome,
    homeCityPreference: { ...validPreference, updated_at: '2026-02-30T00:00:00.000Z' },
  }
  assert.equal(isValidHomeCityPreference(impossibleTimestamp), false, '不存在的日历日期 timestamp 应无效')
  assert.equal(resolveDefaultOrigin(undefined, impossibleTimestamp).source, 'missing', '不存在的日历日期必须 missing')
  assert.equal(isValidHomeCityPreference({
    homeCity: '上海', evidence: ['用户原话:镜像不一致'],
    homeCityPreference: { ...validPreference, value: '北京' },
  }), false, 'typed value 与 raw homeCity 镜像不一致应无效')
  assert.equal(isValidHomeCityPreference({
    homeCity: '上海', homeCityPreference: { ...validPreference, evidence: '   ' },
  }), false, 'typed evidence 空白应无效')
  assert.equal(isValidHomeCityPreference({
    homeCity: '上海', homeCityPreference: { ...validPreference, updated_at: 'not-a-timestamp' },
  }), false, 'typed updated_at 非 ISO-like 应无效')
  assert.equal(isValidHomeCityPreference({
    homeCity: '上海', homeCityPreference: { ...validPreference, updated_at: '' },
  }), false, 'typed updated_at 空白应无效')
  const mismatched = resolveDefaultOrigin(undefined, {
    homeCity: '上海', evidence: ['用户原话:全局无关证据'],
    homeCityPreference: { ...validPreference, value: '北京', evidence: '用户原话:北京' },
  })
  assert.equal(mismatched.source, 'missing', '坏 typed 镜像必须 missing')
  assert.equal(resolveDefaultOrigin(undefined, {
    homeCity: '上海', evidence: ['用户原话:全局无关证据'],
    homeCityPreference: { ...validPreference, evidence: '用户原话:北京', updated_at: 'bad' },
  }).source, 'missing', '坏 typed evidence/timestamp 必须 missing')
  const explicitInvalid = resolveDefaultOrigin('北京', impossibleTimestamp)
  assert.equal(explicitInvalid.source, 'explicit', '无效 typed preference 下显式 origin 仍赢')
  assert.equal(explicitInvalid.origin, '北京', '无效 typed preference 不得覆盖显式 origin')
  const explicitMalformed = resolveDefaultOrigin('北京', legacyProfile)
  assert.equal(explicitMalformed.source, 'explicit', 'malformed profile 下当轮显式 origin 仍赢')
  assert.equal(explicitMalformed.origin, '北京', 'malformed profile 不得覆盖显式 origin')

  // 解析器不改候选/可行性语义:它只产出 origin 字符串 + source 标签
  // (硬保证:本函数不读 candidates/hard/budget,不构造 evaluate/solve 路径)
  console.log('5. resolveDefaultOrigin:explicit > home_default > missing;strict typed validator OK')
}

console.log('\nMEMORY-MERGE TESTS: OK(T1 合并守门层 + issue #338 homeCity)')
