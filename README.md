# GoTry

> 身体和灵魂,更多旅行,更少旅游。

**GoTry 是一个 AI 旅行规划助手**:你用一句话说想去哪、为什么想出发,它先问清楚你的工作时间和已订资源,然后给出**经过引擎验证**的行程方案——不是「AI 觉得不错」,是数学求解器算过「可行」的。

## 它能做什么

| 你说 | GoTry 做 |
|---|---|
| 「我想去洱海边发呆,这周末,上海,预算 3000」 | 先问你是否已订航班/酒店;然后判定:洱海 2 天装不下(进「下一次出发」清单),推荐千岛湖(06:35 起/84% 精力/¥1002)或太湖(¥755),给你选择题 |
| 「带爸妈去云南 5 天,爸爸有高血压」 | 引擎感知同伴约束:不上 4506m 雪山、海拔递减结构(丽江 2400m→大理 1976m)、每日步行 ≤4h,输出验证过的四段行程 |
| 「我在海外远程办公,下周想去普吉岛两周」 | 工作窗口(UTC+4 10:00-19:00=当地 13:00-22:00)成为硬约束——周五晚班机被排除,只推周六早班 |

## 五分钟跑起来

### 前提
- macOS 或 Linux
- Python ≥3.9
- Node.js ≥22(推荐用 [nvm](https://github.com/nvm-sh/nvm) 安装)
- 一个 LLM API key(推荐 [DeepSeek](https://platform.deepseek.com),也兼容任何 OpenAI 兼容端点)

### 安装

```bash
git clone <本仓库地址>
cd gotry

# 1. Python 依赖
python3 -m venv .venv
.venv/bin/pip install -e .

# 2. Node 依赖
cd ts && npm install && cd ..

# 3. 配置你的 API key
cat > .env <<'EOF'
LLM_API_KEY=你的key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
EOF
```

### 使用

```bash
# 方式一:浏览器界面(推荐)
./gotry shell
# 自动打开 http://127.0.0.1:4080,三个页面:对话 / 下一次出发 / 动机画像

# 方式二:命令行一问一答
./gotry "我想去洱海边发呆,这周末,上海,预算3000"

# 方式三:dsh 运行时(DeepSeek Harness 生态,更强大的 agent 能力)
./gotry web
```

### 试一试

启动 `./gotry shell` 后,在对话框输入:

```
我想去洱海边发呆,就这周末,我在上海,预算3000,别让我早起。年假了不用办公,还没订任何东西。
```

GoTry 会:
1. 先问你一两个关键问题(如果信息不全)
2. 然后给出**引擎判定**的方案:哪个目的地可行/不可行/为什么/多少钱/几点起床/到达精力百分比
3. 不可行的目的地不会消失——进「下一次出发」页面,带成行条件

## 它怎么做到的

```
你的话 → LLM(翻译:抽事实、提骨架) → Z3 求解器(判定:可行性/全成本)
                                              ↓
                                    证据链标注的结果 ← 你看到的每个数字
```

**核心原则**:LLM 负责理解和解释,**判定与算术由确定性引擎完成**——这是 GoTry 和普通 AI 聊天的本质区别。

### 门到门全成本

不是「飞行 3 小时」,而是从「闹钟响起」到「住处放下行李」的全程:
- 凌晨起床的生物钟代价
- 家到机场的时间 + 提前值机
- **真实飞行时长**(含时差:深圳→迪拜 7h35m,不是表观的 3h35m)
- 落地后的接驳与精力消耗

### 证据链

每个推荐都标注数据来源:
- `[骨架:openflights]` — 航线通航性验证(OpenFlights 数据库)
- `[实时API:hbcli]` — 酒店/航班实时数据(hotelbyte-cli)
- `[静态包:估算]` — 估算值,预订前需核实

## 跑测试

```bash
./scripts/run-all-tests.sh
```

包含:Python 单元测试(20 例)+ TS 三套件 + 双实现差分 + 对话循环重放 + 骨架集成验证。

## 项目文档

| 文档 | 给谁看 |
|---|---|
| 本 README | 所有人:是什么/怎么用 |
| `docs/architecture.md` | 工程师:系统架构/统一模型/ADR/债务 |
| `docs/roadmap.md` | 项目管理:里程碑(M0-M6)与当前位置 |
| `docs/gotry-product-design.md` | 产品:主循环/透明机制/全成本模型 |
| `docs/gotry-master-outline.md` | 项目管理:工作分解/复用矩阵 |
| `docs/tech-strategy.md` | 技术决策者:选型/评测/分工 |
| `docs/kimi-postmortem.md` | 所有人:一个真实 AI 旅行规划的失败复盘 |

## 参与开发

```bash
# 全栈回归
./scripts/run-all-tests.sh

# 对话循环重放(不需要 API key,mock 模式)
cd ts && npx tsx scripts/replay.ts

# 真 LLM 重放(需要 .env)
cd ts && npx tsx scripts/replay-real.ts

# 异步深度规划演示(跨进程工单闭环)
cd ts && npx tsx scripts/replay-async.ts --request-only
cd ts && npx tsx scripts/async-collect.ts <工单id>
```

架构决策(ADR)和技术债见 `docs/architecture.md` §8/§10。Agent 协作契约见 `AGENTS.md`。

## License

TBD(正式发布前确定)
