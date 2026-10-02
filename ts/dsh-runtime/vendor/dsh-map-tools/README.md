<p align="center">
  <img src="assets/banner.svg" width="100%" alt="dsh-map-tools — Map & routing tools for DeepSeek Harness" />
</p>

# dsh-map-tools

<p align="center"><a href="README.en.md">English</a> | 中文</p>

<p align="center">给 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 的<strong>地图与路径规划原生工具</strong>：驾车 / 公交 / 步行 / 骑行路线、地理编码、逆地理编码、POI 搜索。模型直接调用，<strong>不需要 MCP</strong>；算出来的路线会画成<strong>真地图卡片</strong>，出现在最终回答的下方。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-map-tools"><img src="https://img.shields.io/npm/v/dsh-map-tools?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://www.npmjs.com/package/dsh-map-tools"><img src="https://img.shields.io/npm/dw/dsh-map-tools?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/HorusJiang/dsh-map-tools/actions/workflows/ci.yml"><img src="https://github.com/HorusJiang/dsh-map-tools/actions/workflows/ci.yml/badge.svg?style=flat-square" alt="CI"></a>
  <a href="https://github.com/HorusJiang/dsh-map-tools/releases"><img src="https://img.shields.io/github/v/release/HorusJiang/dsh-map-tools?style=flat-square&label=release" alt="Release"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-%E5%8F%AF%E5%AE%89%E8%A3%85-2A6BE8?style=flat-square" alt="dsh-plugin"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://img.shields.io/badge/dshmarket-%E6%94%B6%E5%BD%95-22C55E?style=flat-square&logo=shopify&logoColor=white" alt="dshmarket"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 20">
</p>

---

## 目录

- [这是什么](#这是什么)
- [效果长什么样](#效果长什么样)
- [安装](#安装)
- [快速开始](#快速开始)
- [工具参考](#工具参考)
- [配置](#配置)
- [数据源与降级](#数据源与降级)
- [已知限制](#已知限制)
- [架构](#架构)
- [FAQ](#faq)
- [开发](#开发)
- [发布](#发布)
- [安全](#安全)
- [贡献](#贡献)
- [许可](#许可)

## 这是什么

一句话：**把「路怎么走」变成模型能直接调用的 7 个工具，并把结果画成看得见的地图。**

- **7 个原生工具**（`map_*`）：路线规划（驾车 / 公交 / 步行 / 骑行）、地理编码、逆地理编码、POI 搜索。走 DSH 的 `ctx.tools` 注册，**不是 MCP**，没有额外进程。
- **路线画在真地图上**：每轮回答的收尾正文之后会出现一张真地图——高德底图 + 高德绘制的路线折线 + 起终标注，配距离、耗时、步数与「在高德打开」深链。**一轮里算了几条就画几条**（每条标注「第 k/N 条」），不会再出现「正文讲 A、地图画 B」。
- **零 key 也能用**：不配置 key 时，驾车 / 步行 / 骑行走免费 OSM/OSRM；中文地址解析不可靠时给出明确引导；配置高德 key 后无缝升级到全能力。
- **key 不出服务端**：静态地图由**宿主**携带 key 去取，浏览器只加载一张本地图片；key 永不回显到页面或日志。
- **卡片数据不占 token**：路线几何等卡片专用数据不进模型上下文。
- **开箱即用的配置卡片**：侧边栏**「插件」页 → dsh-map-tools**，bundle 详情页里就是配置区——选数据源、填 key（脱敏）、改超时，保存即生效，**无需重启**。（更老的宿主没有这个座位，卡片仍出现在 `设置 → 插件 → dsh-map-tools`。）
- **与模型 / 提供方无关**：插件只提供工具与卡片，不读模型名、不分模型版本，换任何 DSH 支持的模型/提供方行为一致。

## 效果长什么样

<p align="center">
  <img src="assets/card-turn-tail.png" width="100%" alt="回合尾部的路线地图卡：高德真地图 + 路线折线 + 起终点标注 + 距离/耗时/步数 + 「在高德打开」深链" />
</p>

<p align="center"><sub>实机截图：收尾正文下方的路线地图卡（驾车 10.8 公里 / 约 20 分钟 / 共 12 步，蓝色折线是高德绘制的真实路线）。</sub></p>

一次路线问答里，界面会出现三处内容：

| 位置 | 内容 | 说明 |
|---|---|---|
| 过程区（「思考」块） | 紧凑摘要 + 可折叠路书 | **不渲染地图**——过程区会随思考反复重绘，地图只在最终结果处出现一次（也省掉一次取图） |
| 收尾正文 | 距离、耗时、分段指引、「在高德打开 ↗」 | 模型可见文本，模型据此作答 |
| 收尾正文**之后**（回合尾部） | **路线地图卡**：真地图 + 起终点 + 距离/耗时/步数 + 深链 | 本轮每条路线一张，多条时标注「第 k/N 条」；超过 3 条只显示前 3 条并注明总数 |

卡片的四种形态（都不会「空白」）：

- **运行中**：显示「规划中…」。
- **成功 + 有几何**：真地图（高德静态图）。
- **成功但取不到真地图**（未配 key / 配额超限 / 宿主没有该路由）：**自动退回自绘 SVG 示意图**——不请求外部网络、不需要前端 key，路线走向、起终点、距离耗时照常显示。
- **失败**：显示错误文本，不会被吞掉。

> 回合尾部是 DSH 客户端的**单选**席位：本轮有路线时地图卡占用这一行，官方的「本轮产出文件」行本轮不渲染——卡片里会注明「本轮另有 N 个产出文件（地图卡占用此行，文件见过程区）」。

卡片上的**署名**接在「在高德打开 ↗」**同一行的后面**（`本卡片由 DeepSeek Harness 插件 dsh-map-tools 生成 · GitHub ↗`；整卡只出现一次，挂在最后一条路线上）：地图卡经常被截图转发，而那张图里没有 README、也没有包页——这行字是图里唯一能说明"它是谁画的"的信息。它由浏览器半边直接渲染，不进模型上下文、不占 token。

## 安装

### 方式一：桌面版插件页安装（DeepSeek Harness Desktop，推荐）

桌面版的**插件管理界面**可以直接按包名安装，不必碰命令行：

1. 侧边栏打开 **「插件」页** → 右上角 **「添加插件」**。
2. 在 **「包名或地址」** 里填 `dsh-map-tools`；右侧 **「安装源」** 用默认即可（国内网络可切 **「中国大陆镜像源」**）。
3. 界面会去该 npm 源**查询这个包**并显示名称与版本，确认无误后点 **「安装」**；结束时可以点 **「立即启用」**，否则按提示 **「更改将在下次启动生效」**。
4. 重启 DeepSeek Harness Desktop，在会话里即可使用 `map_*` 工具。

> **它装到哪个 profile**：桌面版写进 **`desktop`** profile（`~/.dsh/profiles/desktop`），依赖会写成 `dsh-map-tools ^0.7.1` 这样的 caret 区间——**0.x 下 caret 不会升到 0.8.x**，升级时在同一个输入框里填目标版本（形如 `dsh-map-tools@^0.8.0`，`0.8` 换成你要升到的那条 minor）重新安装即可。
> 同一个输入框也接受 **GitHub 地址**（`https://github.com/HorusJiang/dsh-map-tools`）与 **本机插件目录的绝对路径**，源码安装 / 本地开发都能走这个界面。

### 方式二：从 npm 安装（命令行，预构建）

```sh
dsh plugin --profile web add dsh-map-tools        # Web / CLI 版
dsh plugin --profile desktop add dsh-map-tools    # 桌面版（profile 名 desktop）
```

### 方式三：从 GitHub 安装（源码构建）

```sh
dsh plugin --profile web add github:HorusJiang/dsh-map-tools
```

> 发布包不含 `prepare` / `postinstall` 构建脚本，pnpm ≥10 安装时**无需**放行构建脚本，也不必配置 `allowBuilds`。

**版本要求**

> **GoTry vendored 通知**：本目录基于上游 `dsh-map-tools@0.7.3`（MIT provenance 保留），peerDependencies 未改动（`>=0.1.2-rc.1` 开区间，天然覆盖 GoTry root 锁定的 DeepSeek Harness `0.2.0-rc.2` closure）；唯一适配是 `lib/settings-ns.js`：0.2.0-rc.2 的 SettingsForms 以插件导出的 Config schema 自动生成表单，手工注册只剩页策略 `settings.configure({auto}, fiber)`（旧线型 installSection 路径保留兼容）。适配证据只在 root 锁定的 0.2.0-rc.2 closure 上验证；这不是对上游包其他 Harness 版本兼容性的声明。

- **DeepSeek Harness ≥ 0.1.2-rc.1**（peer 依赖：`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis` ^4.0.2）。更早的发布线因 `@deepseek-ai/dsh-settings` 移除旧 API 而不再支持。
- 已在 **DSH 0.1.6-alpha.2 / 0.1.6-alpha.1 + Node v24** 实测全部功能；已兼容版本记录在 `package.json` 的 `dsh.compatibility.dshReleases`。
- **桌面版同样可用**：**DeepSeek Harness Desktop（DSH 0.1.7-rc.2）** 上，插件页安装（`desktop` profile）与回合尾部的地图卡片都正常工作——该版本的 `conversation.chat.turnTail` 仍声明为 `list`，与插件注册的形状一致。
- **插件不写死宿主版本号**：客户端卡片按**槽位实际声明**适配。`conversation.chat.turnTail` 在 0.1.6-alpha.2 由链式（`chain`，要 `select`）改成列表式（`list`，要 `id`），插件运行时读 `slots.spec()` 决定注册形状，因此同一份构建在两条发布线上都能让回合尾部的路线卡片正常出现（详见 [docs/dsh-map-tools-0.1.6兼容性说明.md](docs/dsh-map-tools-0.1.6兼容性说明.md)）。
- **Node ≥ 20**。
- 路线地图卡与配置页需要 **Web 客户端**（`dsh.client.platform: web`：`dsh web` 与 DeepSeek Harness Desktop 都属于这一类）。TUI / headless 下 7 个工具照常可用，只是没有图形卡片。

安装后**重启客户端**：命令行版重启 `dsh web`（或在启动器里按 `R`），桌面版重启 DeepSeek Harness Desktop。之后在会话中即可使用 `map_*` 工具。

### 升级 / 卸载 / 查看

```sh
dsh plugin --profile web list                        # 查看已装版本
dsh plugin --profile web add dsh-map-tools@^0.7.0    # 升级
dsh plugin --profile web remove dsh-map-tools        # 卸载
```

桌面版可以完全在界面上做完：**「插件」页 → dsh-map-tools** 里有开关与 **「卸载」**；**升级＝在「添加插件」里填目标版本重新安装**（形如 `dsh-map-tools@^0.8.0`），因为界面写下的 `^0.7.1` 在 0.x 下不会自己升到 0.8.x。

> **0.x 的坑**：`^0.6.1` 这类 caret 在 0.x 阶段只允许同 minor，**装不到 0.7.x**。升级时请写明目标版本（如 `dsh-map-tools@^0.7.0`）——界面安装（方式一）同样适用这一条。

### 本地开发安装

```sh
dsh plugin --profile web add /absolute/path/to/dsh-map-tools
```

以 `link:` 方式挂载。注意：**改动源码后需要 `pnpm run build`**，且要让宿主**热替换**（不用重启）还得额外配置 hmr 与 junction——完整配方见 [`docs/开发-热插拔-HMR.md`](docs/开发-热插拔-HMR.md)。

## 快速开始

配置高德 key（约 2 分钟）：

1. 打开 [高德开放平台](https://console.amap.com/dev/key/app) → 创建应用 → 申请 **「Web 服务」** 类型 key（个人开发者免费）。
2. 在 DSH 侧边栏的 **「插件」页 → dsh-map-tools** 填入 key，数据源选 `amap`，保存（立即生效）。
3. 在会话里直接提问：

```
从北京南站到首都机场T3，规划驾车路线
把「西湖区文三路478号」转成经纬度
116.397428,39.90923 附近 1 公里内有什么加油站？
```

4. 预期结果：模型给出距离、耗时与分段指引，**收尾正文下方出现一张地图卡**；点卡片上的「在高德打开 ↗」可在高德 App / 网页里继续导航。

## 工具参考

| 工具 | 作用 | 参数 | 免费 OSM | 高德 |
|---|---|---|---|---|
| `map_driving_route` | 驾车路线规划 | `origin`、`destination`（必填，地址或 `"lng,lat"`）；`waypoints`（`"lng,lat;lng,lat"`，**仅高德**）；`alternatives`（备选方案，默认 `false`） | ✅ | ✅ |
| `map_walking_route` | 步行路线规划 | `origin`、`destination` | ✅ | ✅ |
| `map_bicycling_route` | 骑行路线规划 | `origin`、`destination` | ✅ | ✅ |
| `map_transit_route` | 公交 / 地铁换乘 | `origin`、`destination` | — | ✅ |
| `map_geocode` | 地址 → 经纬度 | `address` | 中文不可靠 | ✅ |
| `map_reverse_geocode` | 经纬度 → 结构化地址 | `location`（`"lng,lat"`） | 中文不可靠 | ✅ |
| `map_poi_search` | 兴趣点搜索 | `keywords`；`location`（周边搜索中心）、`radiusM`（默认 1000，最大 50000）、`region`（限定城市）、`types`（POI 类型编码，如 `060000` 餐饮） | — | ✅ |

起点 / 终点统一接受 **地址文本** 或 **`"lng,lat"` 坐标**两种形式，插件自动归一化。

**模型可见文本里有什么**

- 距离、耗时、步数、数据源。
- 分段指引：**≤ 24 步全部给出**；更长时给出前 16 步 + 「中间省略 N 步，共 M 步」+ **最后 6 步**（到达段永远在，模型没有理由再去补算分段）。
- 坐标入参会**回显反查后的地名**并标注「（坐标反查）」，传错起点一眼可见：`起终点：北京南站 → 北京首都国际机场（坐标反查）`。

**卡片专用数据不进模型上下文**：路线几何（抽稀后 ≤ 200 点）与起终点名走 `output.presentationMeta` 持久化到会话日志，只用于渲染卡片，不占 token。

## 配置

### bundle 配置页（推荐）

DSH 的**侧边栏「插件」页 → dsh-map-tools** 打开 bundle 详情页，**描述与行列表之间**就是本插件的配置区：顶部一行状态（数据源 · key 状态）、数据源选择、高德 key 输入（脱敏，留空表示保持不变）、请求超时，并内置「如何获取高德 Key？」申请链接和「打开配置文件」。保存后插件**重建工具实例**，立即生效。

这一区渲染在宿主的 `plugins.bundle.config` 座位上（key = 包名 `dsh-map-tools`），页面骨架（标题、包名、描述、开关、卸载）由宿主自己画，插件只画内容。**更老的宿主**（DSH ≤ 0.1.5，没有这个座位）自动回落到 `设置 → 插件 → dsh-map-tools`，卡片内容完全一样。

配置区的行为约定与官方配置页一致：改动**先暂存、点保存才落盘**（屏幕上看到的就是保存会写下的），**离开页面即丢弃**（所以没有「取消」按钮），**非法超时会拦住保存**而不是被悄悄改写成默认值，保存后**以宿主返回的值重新播种**（key 输入框随之为空）。

### 配置文件

配置实际存储在 **`~/.dsh-map-tools/config.json`**（权限 0600），与 DSH 设置文档解耦、**跨 profile 共享**。路径可用 `DSH_MAP_TOOLS_CONFIG` 环境变量覆盖。

```jsonc
// ~/.dsh-map-tools/config.json
{
  "provider": "amap",     // "amap" | "osm"
  "amapKey": "……",        // 高德「Web 服务」key（secret，永不回显）
  "timeoutMs": 15000,
  "maxQps": 2,            // 高德每秒请求上限
  "defaultMode": "driving",
  "language": "zh"
}
```

| 键 | 默认 | 配置页可改 | 说明 |
|---|---|---|---|
| `provider` | `amap` | ✅ | `amap` = 高德（推荐，国内数据最全）；`osm` = 免费 OSM 兜底（无需 key，能力有限） |
| `amapKey` | — | ✅ | 高德 **Web 服务** 类型 key，[免费申请](https://console.amap.com/dev/key/app) |
| `timeoutMs` | `15000` | ✅ | 单次请求超时（毫秒） |
| `maxQps` | `2` | 手改 JSON | 高德每秒最大请求数（默认 2 低于常见上限 3，防触发 `10021` 配额错误） |
| `defaultMode` | `driving` | 手改 JSON | 默认路线模式（`driving` / `transit` / `walking` / `bicycling`） |
| `language` | `zh` | 手改 JSON | 返回语言（`zh` / `en`） |

> key 只以布尔标记 `hasAmapKey` 呈现给前端，**永远不会回显到页面或日志**。

### cordis.yml 默认值

也可以在 profile 的 `cordis.yml` 里给默认值：

```yaml
- id: map-tools
  name: dsh-map-tools
  config:
    provider: amap
```

**优先级：配置文件（配置页写入）> `cordis.yml` 默认值。**

### 回环路由（进阶）

配置卡片走插件的同源回环路由，不直接写 DSH 设置：

| 路由 | 用途 |
|---|---|
| `GET /dsh-map-tools/config` | 返回非敏感摘要（`provider`、`hasAmapKey`、`timeoutMs` …） |
| `GET /dsh-map-tools/config?open=true` | 在编辑器中打开配置文件 |
| `POST /dsh-map-tools/config` | 应用 `provider` / `amapKey` / `timeoutMs` 补丁并重建工具 |
| `GET /dsh-map-tools/staticmap?w=&h=&line=` | 取静态地图 PNG（同源校验、按参数缓存、连接关闭即取消上游请求） |

静态地图**由宿主取回**，浏览器只拿到一张本地图片——这也是不把图片塞进工具结果的原因：既不进模型上下文，也不必往附件仓库写字节。

## 数据源与降级

| 数据源 | 覆盖能力 | Key | 备注 |
|---|---|---|---|
| **高德（amap）** | 全部 7 个工具 | [免费申请](https://console.amap.com/dev/key/app) | 国内数据最全：公交换乘、POI、稳定的中文地理编码 |
| OSRM | 驾车 / 步行 / 骑行 | 无 | 免费公共实例，有频率限制 |
| Photon / Nominatim | 地理编码 | 无 | 免费公共实例；**中文地址解析不可靠**，部分国内网络不可达 |

降级规则（都是**明说**，不静默失败、不伪造结果）：

- **未配 key**：驾车 / 步行 / 骑行可用（OSRM）；公交换乘与 POI 搜索会给出「需要高德 key」的中文引导并附申请链接；中文地址解析不稳时提示改用 `"lng,lat"` 坐标或配置 key。
- **配了 key 但失败**：错误信息同样面向可操作（key 类型不对、配额超限、网络不可达等都会点名原因）。
- 免费源的中文短板是**刻意保留的设计**：不试图把它「修好」，而是给出清晰的补救路径。

## 已知限制

1. **卡片只镜像本回合的路线调用。** 若模型在本轮只算了一段用于核对细节的分段路线（主路线是上一回合算的），卡片显示的就是那段。工具描述里已写明这条契约：引用更早回合的路线，请在本回合用相同起终点再调用一次。
2. **每轮最多画 3 条路线**，超出只显示前 3 条并注明本轮总数。
3. **地图卡会占用「回合尾部」的唯一席位**：本轮有路线时，官方「本轮产出文件」行本轮不渲染（卡片内注明产出文件数量）。这是该链式槽位的单选语义决定的，不是 bug。
4. **公交换乘没有真实线路折线**：高德 v5 的公交折线实测为空值，卡片用「步行段起终点 + 上下车站点」连成的示意链表示。
5. **地图卡与配置页只在 Web 客户端**；TUI / headless 只有工具文本。
6. **「在高德打开」深链**使用官方 `uri.amap.com` 协议，尚未逐项实机验证；如遇异常欢迎提 [Issue](https://github.com/HorusJiang/dsh-map-tools/issues)。
7. 免费源的频率限制与网络可达性不受本插件控制。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  模型（任意 DSH 支持的模型 / 提供方）                       │
│  map_driving_route / map_transit_route / ...  7 个原生工具  │
└─────────────────┬───────────────────────────────────────────┘
                  │   ctx.tools（defineTool：参数校验 + output.render）
┌─────────────────▼───────────────────────────────────────────┐
│  宿主半边（TypeScript -> lib/）                             │
│    src/tools/            工具定义与模型可见文本             │
│    src/clients/          数据源客户端                       │
│      amap.ts               高德 Web 服务（推荐）            │
│      osrm.ts               OSRM 免费路线（兜底）            │
│      photon.ts / nominatim.ts  免费地理编码（兜底）         │
│    src/geo.ts            几何解码 / 去重 / 抽稀 / 编码      │
│    src/config-file.ts    ~/.dsh-map-tools/config.json 0600  │
│    src/config-route.ts   GET/POST /dsh-map-tools/config     │
│    src/staticmap-route.ts  GET /dsh-map-tools/staticmap     │
│    src/settings-ns.ts    老宿主设置页 namespace 注册         │
└─────────────────┬───────────────────────────────────────────┘
                  │   presentationMeta（不进模型上下文）
┌─────────────────▼───────────────────────────────────────────┐
│  浏览器半边  client/client.js（手写 lazy-CJS，零构建）      │
│    - 插件页 bundle 配置卡（plugins.bundle.config，key=包名） │
│      老宿主回落到 设置 -> 插件（settings.plugin.item）       │
│    - 回合尾部路线卡（conversation.chat.turnTail）           │
│      真地图（宿主静态图）-> 取不到时退回自绘 SVG 示意图     │
└─────────────────────────────────────────────────────────────┘
```

- **配置优先级**：配置文件（配置卡片写入）→ `cordis.yml` 默认值。
- **保存即生效**：配置变更后工具实例自动重建，无需重启。
- **无 MCP**：全部能力为 DSH 原生工具，不依赖外部 MCP 服务器进程。
- **路线几何不进模型上下文**：它只用于画卡片，这也是卡片不占 token 的原因。

## FAQ

**Q：配置了高德 key，路线还是走 OSM？**
A：检查配置文件的 `provider` 是否为 `amap`（不是 `osm`）、`amapKey` 是否非空。配置卡顶部的状态行会显示当前数据源与 key 状态。

**Q：为什么公交换乘 / POI 搜索提示需要 key？**
A：免费 OSM 源不提供公交换乘与 POI 数据，这两项能力必须用高德 key。

**Q：高德 key 被拒 / 报错怎么办？**
A：确认申请的是 **「Web 服务」** 类型 key（不是 JS API / Web 端 key），并在高德控制台确认对应服务已启用。报 `10021` 说明触发 QPS 配额，可调低 `maxQps`（默认 2）或降低请求频率。

**Q：中文地址解析报「免费数据源不可用」？**
A：免费源（Photon / Nominatim）对中文支持差，且部分国内网络不可达。这是设计行为——直接传 `"lng,lat"` 坐标，或配置高德 key。

**Q：路线卡片没出现地图？**
A：卡片会依次尝试：真地图 → 自绘示意图 → 文本行。看不到地图通常是①未配 key ②高德配额超限 ③不在 Web 客户端。此时仍会有自绘示意图或文本结果，不是失败。

**Q：卡片画的是另一条路线，和正文对不上？**
A：见[已知限制](#已知限制)第 1 条——卡片只镜像**本回合**的路线调用。让模型在本回合用相同起终点再算一次即可；工具的 description 已内置这条契约。

**Q：为什么过程区（「思考」块）里没有地图？**
A：刻意如此。过程区会随思考反复重绘，地图只在回合尾部（最终结果处）出现一次，避免闪烁并省掉重复取图。

**Q：地图卡把「本轮产出文件」那行挤掉了？**
A：回合尾部是单选席位。卡片里会注明「本轮另有 N 个产出文件」，文件本身在过程区。

**Q：卡片会消耗 token 吗？**
A：不会。卡片数据走 `presentationMeta` 持久化，不进入模型上下文。

**Q：需要装 MCP 服务器吗？**
A：不需要。7 个工具都是 DSH 原生工具。

**Q：支持哪些 DSH 版本？**
A：DSH ≥ 0.1.2-rc.1；已在 0.1.6-alpha.2 与 0.1.6-alpha.1 实测（回合尾部槽位语义在这两版之间变过，插件按槽位声明自适应，无需换版本），桌面版 **DeepSeek Harness Desktop 0.1.7-rc.2** 同样可用。详见[安装](#安装)。

**Q：桌面版（DeepSeek Harness Desktop）怎么装、怎么升级？**
A：不用命令行：侧边栏**「插件」页 → 「添加插件」**里填包名 `dsh-map-tools` 即可（界面会去 npm 源查询这个包）；升级就在同一处填目标版本（形如 `dsh-map-tools@^0.8.0`）重新安装——界面写下的 `^0.7.1` 在 0.x 下不会自己升到 0.8.x。安装落在 `desktop` profile，细节见[安装](#安装)方式一。

## 开发

```sh
pnpm install
pnpm run build                        # tsc → lib/
pnpm test                             # vitest 单元测试（mock 网络，135 个用例）
node scripts/smoke.mjs                # 冒烟：宿主注册 7 个工具
node scripts/config-e2e.mjs           # 配置回环：卡片数据通路端到端
node scripts/integration.mjs          # 真实网络：免费源（OSRM / Nominatim）
node scripts/amap-e2e.mjs             # 真实网络：高德（需 AMAP_API_KEY）
node scripts/call-driving-route.mjs   # 单次调用示例
node scripts/check-secrets.mjs        # 密钥守卫
pnpm hooks                            # 安装 pre-commit 密钥守卫
```

约定要点：

- 单元测试**一律 mock 网络**（`tests/` 里不发真实请求）；需要真实 key 的脚本只从 `process.env.AMAP_API_KEY` 读取，**禁止**把 key 写进任何文件。
- 改完 `client/client.js` 必须 `node --check client/client.js`；client 测试直接加载随包发布的同一份字节。
- 新增 / 修改面向模型的工具必须同步补单元测试。
- **开发期热插拔**（改源码不重启、不刷新页面）：配方与上游限制见 [`docs/开发-热插拔-HMR.md`](docs/开发-热插拔-HMR.md)。

完整约定见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

## 发布

发布由 CI 执行（[`.github/workflows/release.yml`](.github/workflows/release.yml)），而且**是两段式——第二段必须由人来做**：

```sh
# 1. 打 tag 触发：CI 跑 CI 同款闸门，然后 `npm stage publish` 只 staging（此时谁都装不到）
git tag -a vX.Y.Z -m "dsh-map-tools X.Y.Z" && git push origin vX.Y.Z

# 2. 维护者用 2FA 批准，再把 CI 留下的草稿 Release 转正（命令会打印在 run summary 里）
npm stage list dsh-map-tools
npm stage approve <stage-id>
gh release edit vX.Y.Z --draft=false
```

为什么两段式：npm 的 **trusted publisher 只授权 staged publishing**（`npm publish` 不在允许动作里），所以工作流自己没有能力把包推到所有人面前——tag 表示"这是候选发布"，2FA 那一下才表示"这就是发布"。一次性配置（npm 包的 Trusted publishing 加一条 GitHub Actions 连接、`allowed actions` 不勾 `npm publish`）见 release.yml 顶部注释。

没有 CI、或要手动发布时，同一套动作用本地脚本：

```sh
node scripts/publish.mjs                  # 直发：构建 → 测试 → 打包检查 → publish → 验证可安装
node scripts/publish.mjs --stage          # 两段式：只 staging，等 2FA 批准
node scripts/publish.mjs --verify-only    # 只验证某个版本"真的能装上"（含 sha1 对照）
```

两条路都用同一条判据判断"发布成功"：**用全新缓存 + `--prefer-online` 把 tarball 真拉下来**，并与本地构建产物对照 sha1。npm 的读路径是几份独立传播的缓存（完整 packument、安装用的 corgi packument、tarball），**npmjs.com 上的 `Published` 和 `npm view` 都比 tarball 传播得早，不能当"能装上"的证据**。

版本语义遵循 [SemVer](https://semver.org/lang/zh-CN/)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。发布包只含 `lib/`、`client/`、`cordis.patch.yml` 与 `LICENSE`（外加 npm 必带的 `package.json` / README）。

## 安全

API key 的存储方式（`~/.dsh-map-tools/config.json`，0600，永不回显）与漏洞报告流程见 [SECURITY.md](SECURITY.md)。

## 贡献

欢迎 Issue 与 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发约定与提交规范。

## 许可

[MIT](LICENSE) © HorusJiang
