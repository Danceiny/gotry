# S1 契约走查结论(自查版,呈创始人一分钟确认)

> 走查方式:不是纸面审阅——契约已被两次真实实战使用(M1 exit 的 MiniMax-M2 三轮重放 `bb880f3`、真实 dsh 运行时端到端 `68ea364`),以下每个走查点都用实战证据回答。

## 走查点 ①:Gate 只允许选择题

- **契约**:`Gate = { id, question, options[≥2], answer? }`——`options` 是数组,结构上没有自由文本的位置。
- **实战证据**:M1 exit 重放第 3 轮的预算 gate 渲染为「经济(省钱…) / 舒适(办公质量…) / 便利优先(时间最省)」——三选项各带 trade-off;异步交付的不失望四条第 3 条(`待决问题全部是简单选择题`)在 `collectDeepPlanning` 里以 `g.options.length >= 2` 为断言,两次交付均 4/4 通过。
- **结论**:✅ 成立。类型约束 + 运行时断言双层保证。

## 走查点 ②:workWindow 必带 evidence

- **契约**:`WorkWindowProfile.evidence: string`(非空字段,无 `?`)。
- **实战证据**:重放第 2 轮用户说「工作时间 UTC+4 10:00-19:00」→ mock/真 LLM 均落 `evidence: '用户原话:我的工作时间是UTC+4的早上10点到下午7点'`;work-window 排除理由在渲染中引用了这个来源(「工作窗口(当地 13:00-22:00)」可追查到换算链:10:00 UTC+4 + (420−240)min = 13:00)。**注意**:插件工具 `gotry_motivation_save` 在 evidence 缺失时 throw(P0 反幻觉红线)——同一纪律在 contracts 与插件两侧成对存在。
- **结论**:✅ 成立。字段必填 + 消费端 throw 双保险。
- **已知边界**:契约的类型层无法强制「evidence 必须是用户原话」(只能靠 LLM 抽取纪律与插件 throw)——ADR-10 校验闸同族问题,接受此边界,靠重放夹具回归。

## 走查点 ③:spec_extract 的 assumptions 三分类

- **契约**:`SpecAssumption.source: 'user-verbatim' | 'inferred' | 'default'`。
- **实战证据**:ADR-10 落地后,`extractSpec` 的骨架 JSON 系统提示要求「锚点只放用户明说或必然的」;dsh E2E 中 M2 抽取的骨架锚点(arriveBy 等)全部来自行程原文;假设分类在 `extractFacts` 返回值里逐字段标注(`assumptions: [{field, source: 'user-verbatim'}]`)。**inferred/default 两值至今无运行时实例**——这是诚实缺口:三分类的类型面完备,但运行时只有第一类被走过。
- **结论**:✅ 类型成立;⚠️ 运行时覆盖不全(inferred/default 未实战)。建议:M3 种子用户前补一个「用户没说满、需要推断」的重放用例(如预算档从「住得舒服点」推断为 comfort)。

## 总结论

**建议:S1 冻结通过。** 三走查点全部有类型+实战双层证据;唯一的运行时覆盖缺口(③的 inferred/default)不阻塞冻结——它是测试覆盖问题不是契约设计问题,挂为 M3 前置事项即可。

**创始人只需回一句**:「S1 冻结通过」或指出任一走查点不成立。
