[English](capability-onboarding.md)

# GoTry 能力首次体验——三项「需用户自己动手」的设置面

> 定位：本仓**用户必须自己操作**的三项外部能力的单一可跟随指引（issue #559 B 步）。能力层运行时提示字符串是**首次接触**通知（失败瞬间一行），本文是它们的**可跟随展开**与之前缺失的**影响面**。
> 状态：living——新增需用户动手的能力、或影响面变化时同步更新。
> 上游：[`data-sources.md`](data-sources.md)（数据权威）、[`user-guide.md`](user-guide.md)（用户叙事）、[`tools.md`](tools.md)（工具面）。
> 下游：bootstrap 设置命令（`bin/gotry-bootstrap.js`）、doctor 报告（`ts/capabilities/doctor.ts`）、能力层提示字符串（`ts/capabilities/*.ts`）。

## 为什么需要本文

GoTry 里有三项外部能力**不能**由 bootstrap 自动装——它们触及**用户的个人数据**（扩展安装 + 登录）、**用户的个人资金**（FlyAI key）、**用户的个人基础设施**（CalDAV username）：

| 能力 | 为何用户侧 | 装在哪里 |
|---|---|---|
| Session Bridge 扩展 | 每浏览器 Chrome 一次性安装 + 扩展 ID 身份固定；扩展跑在用户浏览器里，不在服务端 | `extension/README.md`、`ts/capabilities/session/extension-bridge.ts` |
| FlyAI key | 平台侧 API key——永不嵌入 npm 包；模型不能替用户输入；本机 CLI 是唯一写入面 | `ts/src/flyai-setup-tool.ts`、`ts/capabilities/flyai.ts` |
| dsh-calendar | CalDAV username 是用户自有资源；D-9 拍板：可选依赖进 setup 状态管理，禁环境变量控制产品行为 | `ts/capabilities/doctor.ts`、`bin/gotry-bootstrap.js` |

首次接触提示（能力层 / bootstrap / doctor）现在末尾都加一行**影响面**：哪些工具不可用、哪些仍可用。本文是那条提示的可跟随展开。任一路径或影响面变化时，**同 commit 同步修改运行时字符串与本文**。

---

## 1. Session Bridge 扩展

### 装好后能拿到什么

`gotry_session_search` 与 `gotry_session_login`（账号会话通道）。桥让 gotry 在用户**自己登录态的**Chrome 里被动嗅探——**携程机票/酒店、12306 余票、Dida 供应商门户实时酒店报价**。只读。Cookie 只读**名字**；值立刻丢弃。

### 不装损失什么

| 表面 | 没桥时状态 |
|---|---|
| `gotry_session_search`（kind=flight / hotel / train / dida） | 不可用 |
| `gotry_session_login`（携程登录引导） | 不可用 |
| FlyAI 实时（`gotry_flyai_search`） | 不受影响（仍可用） |
| hbcli 实时酒店（`gotry_hotel_search`） | 不受影响（仍可用） |
| 地图 / 天气 / 航班印证 | 不受影响（仍可用） |

影响**有限**：账号会话工具没了，其它仍可用。

### 三种安装路径（任选其一）

#### 路径 A：Chrome 应用商店（推荐，自动更新）

1. 打开 https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd
2. 点 **添加至 Chrome**。
3. 打开 Chrome，确认扩展在 `chrome://extensions` **已启用**。
4. 启动 gotry web / headless 会话——桥 `/health` 心跳在 ~5 秒内接上扩展。

#### 路径 B：GitHub Releases 本地加载（不经商店审核，更新比商店快）

1. 跑 `npx @danceiny/gotry setup --extension-from=github`——从 GitHub Releases tag `ext-*` 下载 tarball，校 SHA-256，解压到 `~/.gotry/extension`。
2. 打开 `chrome://extensions` → 打开**开发者模式** → 点**加载已解压的扩展程序** → 选 `~/.gotry/extension`。
3. 确认扩展 ID 与 `ts/capabilities/session/extension-bridge.ts` 里的常量一致（unpacked = `olpgkofjhhiiiahdkkbcninhjmegghfe`；商店 = `oeajpiccmonococjcegddlooeeohlbgd`）。

#### 路径 C：npm 包内副本本地加载（离线确定性）

1. 跑 `npx @danceiny/gotry setup`——把包内 `extension/` 落到 `~/.gotry/extension`。
2. 在 `chrome://extensions` 按路径 B 加载已解压扩展。

### 验证

```bash
# 桥活着（loopback HTTP）：
curl -s http://127.0.0.1:8791/health
# 期望：{"ok":true,"service":"gotry-session-bridge","protocol":"session-bridge.v1"}

# 扩展连上（最近心跳 < 45 秒）：
curl -s http://127.0.0.1:8791/status
# 期望："extensionConnected":true, "lastSeenMsAgo":<较小值>
```

桥在但 `extensionConnected` 持续 >45s 为 false：去 `chrome://extensions` → 扩展 **Service worker** → **检查视图：service worker** 看扩展控制台——桥的 `/health` 请求会出现在那里。常见原因 = 扩展装了但 SW 被 Chrome 挂起（Chrome 强休眠空闲 worker；随便开个标签页唤醒）。

### 边界——商店 ID ≠ unpacked ID

两个 ID（商店 `oeajpicc…`、unpacked `olpgkf…`）都被桥的 Origin 白名单（`extension-bridge.ts` 的 `EXTENSION_ORIGINS`）信任。一台 Chrome 同时只能装一个；切换要先卸另一个。

---

## 2. FlyAI Key（飞猪开放平台）

### 装好后能拿到什么

`gotry_flyai_search`（8 类官方开放接口：机票、火车票、酒店、POI、关键词、AI、万豪酒店、万豪套餐）。配好本机 key 后配额走你个人飞猪额度——**无共享池风险**。验证回执绑定 `(key sha256, 来源, endpoint 指纹)`——三要素全匹配回执才有效。

### 不装损失什么

| 状态 | 行为 | 影响 |
|---|---|---|
| 匿名试用（无 key） | `gotry_flyai_search` 走共享额度池 | **额度易耗尽**——池子小；高频会话触发 `Trial limit reached`，本会话内该工具返 `verdict=needs-setup` |
| 达限后 | `gotry_flyai_search` 不可用直到配 key | 会话仍可用：走 `gotry_session_search`（账号会话，需 Session Bridge）或 hbcli（酒店） |
| 配好 `gotry setup flyai` | 配额走本机 key，401 / 速率限制路径正常 | 正常 |

### 配置步骤

1. 在浏览器登录 https://flyai.open.fliggy.com/console。
2. 创建 / 复制一个 API key。
3. 跑 `npx @danceiny/gotry setup flyai`——在隐藏输入里粘贴 key。CLI **先用配置 endpoint 验证 key**，再写 `FLYAI_API_KEY` + 验证回执。
4. 可选 stdin：`echo "$KEY" | npx @danceiny/gotry setup flyai --stdin`（CI / 容器路径）。
5. 验证：`npx @danceiny/gotry setup flyai --status` 显来源 + endpoint + 验证状态。

### 验证

```bash
# 状态（来源 + endpoint + 是否验证）：
npx @danceiny/gotry setup flyai --status
# 期望输出（按行）：
#   状态: 已验证当前配置
#   来源: env | masked: ****
#   endpoint: https://flyai.open.fliggy.com/mcp

# 只读 provider 检查（打一次 FlyAI；更新验证回执）：
npx @danceiny/gotry setup flyai --check
# 期望：action=check, checkVerdict=hit 或 miss, verified=true（仅当 key 已配）

# doctor 表面：
npx @danceiny/gotry doctor
# 期望：FlyAI 行 → ✅ 已验证
```

### 清除 / 轮换

```bash
# 清除已存 key（回到匿名试用）：
npx @danceiny/gotry setup flyai --clear

# 轮换：直接重跑 setup flyai，贴新 key；验证回执按新 key sha256 重写。
# 旧回执因 key sha256 不再匹配自动失效。
```

### 边界情况

- **Endpoint 调试**：`DEBUG_FLYAI_MCP_URL` 覆盖 endpoint；回执记 `endpointDebug=true`，doctor 表面在 endpoint 后挂 `(DEBUG)`。DEBUG 模式遇 403 多为 key 的 allow-scope 与覆盖 host 不匹配。
- **Endpoint 变化后回执过期**：endpoint 指纹变了（服务端路由 / 镜像轮换），既有回执视为过期；doctor 显 `已配置未通过验证`。重跑 `setup flyai --check` 重写。
- **不要在聊天里发 key**：运行时 CLI 故意隐藏输入；模型侧工具（`gotry_flyai_setup`）拒绝一切凭据参数。这是硬规则——验证日志只显 sha256、掩码 key、来源、endpoint。

---

## 3. dsh-calendar（可选 CalDAV 工作窗口读取）

### 挂载并配好后能拿到什么

`gotry_calendar_check` 出现为一个工具，自动读用户的 CalDAV 工作窗口——agent 不用在聊天里挨个问「你哪天有空」。即使没配，persona 访谈也会兜出工作窗口；配好后工具自动跑，少一轮访谈。

### 不装损失什么

| 状态 | 行为 | 影响 |
|---|---|---|
| 默认（未挂载） | 日历工具**不在**工具箱；persona 访谈兜工作窗口 | 可接受——多数用户不需要 |
| 挂载但未配（`--on` 但 cordis.patch.yml 没填 `username:`） | 日历工具在工具箱，但每次调用都返「未配置」 | **降级**——用户已 opt-in 但运行时挡掉 |
| 挂载且配好 | 日历工具自动读工作窗口 | 正常 |

**关键**：dsh-calendar **默认不挂载**（D-9）。degraded 只在显式 `--on` 但没收尾时出现。如果不要自动读工作窗口，留默认即可。

### 配置步骤（仅在你需要时）

1. 确认 dsh web profile 已存在（默认路径 `~/.dsh/profiles/web/`，首次 `gotry web` 后落位）。
2. 开挂载：`npx @danceiny/gotry setup calendar`。写 `~/.gotry/calendar.json`（`{enabled:true, updatedAt:<iso>}`），下次 reload 时重启相关会话生效。
3. 改 `~/.dsh/profiles/web/cordis.patch.yml`，覆盖 calendar 行的 `config.username` 填你的 CalDAV 用户名：

   ```yaml
   - id: dsh-calendar
     config:
       username: <你的日历账号>
   ```

4. 重启 gotry（patch 启动时读，运行时不动）。

### 关闭

```bash
npx @danceiny/gotry setup calendar --off   # 删 ~/.gotry/calendar.json；回到默认
```

### 验证

```bash
# 状态（挂了？配了？）：
npx @danceiny/gotry setup calendar --status
# 期望：
#   状态: 已挂载且已配置
#   状态文件: ~/.gotry/calendar.json
#   说明: 挂载=`npx @danceiny/gotry setup calendar`; 关闭=`... --off`; ...

# doctor 表面：
npx @danceiny/gotry doctor
# 期望：dsh-calendar 行 → ✅ 已挂载且已配置
```

### 边界情况

- 即使日历配好，persona 访谈仍正常工作——日历读不替代访谈，只去掉「你哪天有空」这一轮；偏好 / 节奏 / 约束仍来自聊天。
- 本能力**不**给 npm 包加新依赖——dsh-calendar 是 opt-in patch 条目。`--off` 关闭不需要重装 npm。
- username 是唯一必填字段；URL / 鉴权凭据由 dsh profile 的 Cordis 配置提供（此处不展开）。

---

## 参考

- 能力注册 / 路由面：[`architecture.md`](architecture.md) § channel registry
- 工具面（每个工具干什么）：[`tools.md`](tools.md)
- 用户叙事（何时用哪个工具）：[`user-guide.md`](user-guide.md)
- 数据源权威（哪些源实时 / 静态 / 降级）：[`data-sources.md`](data-sources.md)
- 扩展安装细节：[`extension/README.md`](../extension/README.md)
- FlyAI 集成契约：[`design/flyai-supplier-skill-design.md`](design/flyai-supplier-skill-design.md)
- 可选依赖 / setup 状态契约：[`design/tool-orchestration-design.md`](design/tool-orchestration-design.md)、[`decisions-needed.md`](decisions-needed.md) D-9