# DeerFlow 研究 → gotry 优化目标与方法(issue #10)

> 对象:[bytedance/deer-flow](https://github.com/bytedance/deer-flow)(DeerFlow 2.0,SuperAgent
> harness;1.x 为经典深研框架,机制注处标版本)。本文只回答:**哪些机制值得 gotry 借,
> 借成什么样,哪些明确不借**。所有目标映射到现有 issue/路线图,不新增空中楼阁。

## 值得借的四个机制(按 gotry 优先级排序)

### T1. 自动回合捕获式记忆(M4,#1 的根治)〔借 2.0 memory〕
DeerFlow 2.0 记忆的要点不是「存」,是**自动**:每轮对话自动捕获事实进长期记忆,
召回也自动(可选 OpenViking 后端)。gotry 现状:动机画像靠 `motivation_save` 显式
调用,#1 的重复问预算 = 没有自动沉淀。
**方法**:M4 在插件层加 turn-capture——每轮工具结果里的新事实(预算/日期/窗口/
出发地,结构化字段优先)自动并入 motivation-profile.json,显式 save 退化为确认;
会话开始自动召回画像进人格上下文。这是 #1 的根治,#10 与 #2 的「维护状态」同解。

### T2. 待决选择题 → 结构化澄清卡(D-4 后续)〔借 2.0 clarification cards〕
gotry 契约 (5)「待决=选择题」目前是 markdown 文本。DeerFlow 的结构化澄清卡:
agent 请求澄清时 UI 出结构化卡片,用户点选或自由输入。dsh 依赖树里已有
`dsh-tool-ask-user`(宿主自带)。
**方法**:待决问题从纯文本升级为 ask-user 结构化调用(选项=按钮), incapable UI
自动降级回文本——零成本升级,产品观感大增。

### T3. 子代理承载深度调研(长任务)〔借 2.0 sub-agents「优化而非默认」〕
DeerFlow 立场:**子代理是优化,不是复杂请求的默认响应**——scoped context + 独立
终止条件,结果由 lead 验证合成。gotry 单代理 12 工具;「帮我全面对比五个目的地」
这类长任务会撑爆主对话上下文。dsh 自带 `dsh-tool-subagent` 基建。
**方法**:仅深度调研类请求 spawn subagent(限定工具集:agent_reach/weather/
anything + 求解器),产物回主对话;普通请求绝不走子代理(遵循 DeerFlow 教训)。

### T4. 规划前背景调查(probePoi 升级)〔借 1.x background investigation〕
DeerFlow 1.x 深研循环在 planner 之前有 background investigation 节点——先快速
搜集背景再定计划,计划不凭空起。gotry 的 probePoi(D-7a)已是雏形。
**方法**:可行性判定前自动跑「背景三件套」:目的地天气(climate 模式)/汇率/
季节性,证据链随判定一起出——把「LLM 编季节建议」的老毛病在管线层堵死。

## 明确不借的(诚实边界)

- **沙箱执行**(Docker/K8s/E2B 容量策略):gotry 无代码执行需求,求解器进程内 ~6ms;
- **报告/播客/幻灯生成**:不是旅行产品核心,等有内容运营场景再看;
- **全量 LangGraph 迁移**:gotry 宿主是 dsh(cordis),换框架 = 重写零收益。

## 落地顺序建议

T1 随 M4 记忆启动(根治 #1);T2 独立小段随时可做;T3 等种子用户真出现长任务再上;
T4 可作 probePoi 的下一个小迭代。

---
来源:[bytedance/deer-flow](https://github.com/bytedance/deer-flow) ·
[deerflow.tech](https://deerflow.tech/) ·
[codebase teardown #1985](https://github.com/bytedance/deer-flow/discussions/1985)
