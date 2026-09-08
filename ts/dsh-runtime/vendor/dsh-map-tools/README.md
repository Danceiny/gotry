<p align="center">
  <img src="assets/banner.svg" width="100%" alt="dsh-map-tools — Map & routing tools for DeepSeek Harness" />
</p>

# dsh-map-tools

<p align="center"><a href="README.en.md">English</a> | 中文</p>

<p align="center">地图与路径规划工具插件，为 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 提供驾车/公交/步行/骑行路线规划、地理编码、逆地理编码和 POI 搜索等<strong>原生工具</strong>——模型可直接调用，无需 MCP 服务器。</p>

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

## 特性

- **7 个原生工具**：路线规划（驾车/公交/步行/骑行）、地理编码、逆地理编码、POI 搜索——模型通过 `map_*` 直接调用，无需 MCP。
- **高德数据源（推荐）**：配置免费的高德 Web 服务 key 后，使用国内最全的地图数据（含公交换乘、POI、稳定的中文地理编码）。
- **零 key 兜底**：不配置 key 时，驾车/步行/骑行路线自动走免费的 OSM/OSRM；中文地址解析不可靠时给出清晰引导。
- **开箱即用的配置卡片**：设置 → 插件 → dsh-map-tools，图形化配置，内置"如何获取高德 Key？"申请链接，保存即生效（无需重启）。
- **面向国内网络**：免费源不可达、key 无效等场景均有清晰的中文提示与补救路径。

## 安装

支持两种安装方式，二选一：

### 方式一：npm 安装（推荐，预构建免授权）

```sh
dsh plugin --profile web add dsh-map-tools
```

### 方式二：从 GitHub 安装（源码构建，需授权）

```sh
dsh plugin --profile web add github:HorusJiang/dsh-map-tools
```

> 发布包不含 `prepare`/`postinstall` 等构建脚本，pnpm ≥10 安装时**无需**放行构建脚本、也无需配置 `allowBuilds`。

> **GoTry vendored patch notice**：本目录保留上游 `dsh-map-tools@0.5.1` 的 MIT
> provenance，但 GoTry 的 vendored adaptation 只对 root 锁定的
> **DeepSeek Harness 0.1.2-alpha.3** closure 提供兼容证据。其 settings 接线
> 使用 alpha.3 已发布的 `SettingsProvider.prototype.installSection` 方法和普通字符串 namespace；
> 这不是对上游包其他 Harness 版本兼容性的声明。

安装后**重启 `dsh web`**（或等待 HMR 热加载），在会话中即可使用 `map_*` 工具。

> **开发模式**：在本地 clone 后使用 `dsh plugin add <本地路径>` 会以 `link:` 方式安装——改动源码即生效，适合插件迭代。

## 快速开始

配置高德 key（约 2 分钟）：

1. 打开 [高德开放平台](https://console.amap.com/dev/key/app) → 创建应用 → 申请 **"Web 服务"** 类型 key（个人开发者免费）。
2. 在 DSH 的 **设置 → 插件 → dsh-map-tools** 填入 key，选择数据源 `amap`，保存。
3. 在会话中直接提问：

```
从北京南站到首都机场T3，规划驾车路线
把"西湖区文三路478号"转成经纬度
116.397428,39.90923 附近 1 公里内有什么加油站？
```

## 工具

| 工具 | 功能 | 免费 OSM | 高德 |
|---|---|---|---|
| `map_driving_route` | 驾车路线规划 | ✅ | ✅ |
| `map_transit_route` | 公交/地铁换乘 | — | ✅ |
| `map_walking_route` | 步行路线规划 | ✅ | ✅ |
| `map_bicycling_route` | 骑行路线规划 | ✅ | ✅ |
| `map_geocode` | 地址 → 经纬度 | 中文不可靠 | ✅ |
| `map_reverse_geocode` | 经纬度 → 地址 | 中文不可靠 | ✅ |
| `map_poi_search` | 兴趣点搜索 | — | ✅ |

起点/终点统一接受 **地址文本** 或 **`"lng,lat"` 坐标** 两种形式，插件自动归一化。

## 配置

### 设置页配置卡片（推荐）

DSH 的 **设置 → 插件 → dsh-map-tools** 提供图形化卡片：数据源选择、高德 key 输入（脱敏显示）、超时设置、申请链接。保存后立即生效。

配置实际存储于 **`~/.dsh-map-tools/config.json`**（用户目录，权限 0600），与 DSH 设置文档解耦，跨 profile 共享：

```jsonc
// ~/.dsh-map-tools/config.json
{
  "provider": "amap",        // "amap" | "osm"
  "amapKey": "你的高德Web服务key",
  "timeoutMs": 15000
}
```

> key 只以布尔标记（`hasAmapKey`）呈现给前端，**永远不会回显到页面或日志**。

### cordis.yml 默认值

也可以在 profile 的 `cordis.yml` 中提供默认值（**配置文件中的值优先于 cordis.yml**）：

```yaml
- id: map-tools
  name: dsh-map-tools
  config:
    provider: amap
```

## 架构

```
┌─ 模型 ──────────────────────────────────────┐
│  map_driving_route / map_geocode / ...       │  7 个原生工具（ctx.tools）
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│  src/tools/    工具定义（参数校验/输出渲染）     │
│  src/clients/  数据源客户端                    │
│    amap.ts      高德 Web 服务 API（推荐）      │
│    osrm.ts      OSRM 免费路线（兜底）           │
│    photon.ts    Photon 免费地理编码（兜底）     │
│    nominatim.ts Nominatim 免费地理编码（兜底）   │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│  src/config-file.ts  ~/.dsh-map-tools/config.json（0600） │
│  src/config-route.ts 回环路由 /dsh-map-tools/config     │
│  src/settings-ns.ts   设置页 namespace 注册              │
│  client/client.js     设置页配置卡片（前端，手写零依赖）    │
└──────────────────────────────────────────────┘
```

- **配置优先级**：配置文件（设置卡片写入）→ `cordis.yml` 默认值。
- **保存即生效**：配置变更后工具自动重建，无需重启。
- **无 MCP**：全部能力为原生工具，不依赖外部 MCP 服务器进程。

## 数据源

| 数据源 | 用途 | Key | 备注 |
|---|---|---|---|
| 高德（Amap） | 全部工具（推荐） | 免费申请 | 国内数据最全，含公交/POI/中文地理编码 |
| OSRM | 驾车/步行/骑行路线 | 无 | 免费公开服务，有频率限制 |
| Photon / Nominatim | 地理编码 | 无 | 免费公开服务；**中文地址解析不可靠**，部分网络不可达 |

> 免费源的局限（中文地理编码不稳定）是刻意设计：不配 key 时给出明确引导，配 key 后体验无缝升级。

## FAQ

**Q: 配置了高德 key，但路线还是走 OSM？**
A: 检查配置文件的 `provider` 是否为 `amap`（不是 `osm`），且 `amapKey` 非空。

**Q: 为什么公交换乘/POI 搜索提示需要 key？**
A: OSM 免费源不提供公交换乘与 POI 数据；这两项能力需要高德 key。

**Q: 高德 key 无效怎么办？**
A: 确认申请的是 **"Web 服务"** 类型 key（不是 JS API / Web 端 key），并在高德控制台确认已启用相应服务。

**Q: 中文地址解析报"免费数据源不可用"？**
A: 免费源（Photon/Nominatim）对中文地址支持差，且部分国内网络不可达。这是设计行为——配置高德 key 后自动解决。

## 开发

```sh
pnpm install
pnpm run build                # tsc 构建到 lib/
pnpm test                     # vitest 单元测试（mock 网络）
node scripts/smoke.mjs        # 冒烟：7 工具注册
node scripts/integration.mjs  # 集成：真实网络请求（免费源）
node scripts/amap-e2e.mjs     # 高德 e2e：需设置 AMAP_API_KEY
node scripts/config-e2e.mjs   # 配置读写回环验证
```

详细约定见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

## 发布

```sh
npm config set registry https://registry.npmjs.org/
npm login                     # 需要 npm 账号（建议配置 bypass-2FA 的发布 token）
node scripts/publish.mjs      # 一键：构建 → 打包检查 → 发布 → 验证
```

版本语义遵循 [SemVer](https://semver.org/lang/zh-CN/)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安全

API key 存储与漏洞报告流程见 [SECURITY.md](SECURITY.md)。

## 贡献

欢迎 Issue 与 PR！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发约定与提交规范。

## 许可

[MIT](LICENSE) © HorusJiang
