<p align="center">
  <img src="assets/banner.svg" width="100%" alt="dsh-map-tools — Map & routing tools for DeepSeek Harness" />
</p>

# dsh-map-tools

<p align="center"><a href="README.md">中文</a> | English</p>

<p align="center">Map &amp; routing tools plugin for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>: driving/transit/walking/bicycling route planning, geocoding, reverse geocoding and POI search as <strong>native tools</strong> — the model calls them directly, no MCP server required.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-map-tools"><img src="https://img.shields.io/npm/v/dsh-map-tools?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://www.npmjs.com/package/dsh-map-tools"><img src="https://img.shields.io/npm/dw/dsh-map-tools?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/HorusJiang/dsh-map-tools/actions/workflows/ci.yml"><img src="https://github.com/HorusJiang/dsh-map-tools/actions/workflows/ci.yml/badge.svg?style=flat-square" alt="CI"></a>
  <a href="https://github.com/HorusJiang/dsh-map-tools/releases"><img src="https://img.shields.io/github/v/release/HorusJiang/dsh-map-tools?style=flat-square&label=release" alt="Release"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-installable-2A6BE8?style=flat-square" alt="dsh-plugin"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://img.shields.io/badge/dshmarket-listed-22C55E?style=flat-square&logo=shopify&logoColor=white" alt="dshmarket"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 20">
</p>

---

## Features

- **7 native tools**: route planning (driving/transit/walking/bicycling), geocoding, reverse geocoding and POI search — called directly by the model via `map_*`.
- **Amap (高德) data source (recommended)**: configure a free Amap Web Service key for the best China coverage (transit, POI, reliable Chinese geocoding).
- **Zero-key fallback**: without a key, driving/walking/bicycling routes use free OSM/OSRM; Chinese address parsing degrades with clear guidance.
- **Settings card out of the box**: Settings → Plugins → dsh-map-tools, graphical config with an "How to get an Amap key?" link; save applies instantly (no restart).
- **China-network friendly**: clear Chinese guidance for unreachable free sources or invalid keys.

## Install

Two ways, pick one:

### Option 1: npm install (recommended, prebuilt, no build approval)

```sh
dsh plugin --profile web add dsh-map-tools
```

### Option 2: from GitHub (source build, requires approval)

```sh
dsh plugin --profile web add github:HorusJiang/dsh-map-tools
```

> The published package ships **no** `prepare`/`postinstall` build scripts, so pnpm ≥10 installs it without prompting to allow build scripts or configuring `allowBuilds`.

> **GoTry vendored patch notice**: this directory preserves the upstream
> `dsh-map-tools@0.5.1` MIT provenance, but GoTry's vendored adaptation is
> evidenced only against the root-locked **DeepSeek Harness 0.1.2-alpha.3**
> closure. Its settings wiring uses alpha.3's published
> `SettingsProvider.prototype.installSection` method plus a plain string namespace;
> this is not an upstream compatibility claim for other Harness releases.

Restart `dsh web` after install (or wait for HMR), then use the `map_*` tools in a session.

> **Development mode**: `dsh plugin add <local-path>` installs via `link:`, so source edits take effect immediately — ideal for iterating on the plugin.

## Quick start

Configure an Amap key (~2 minutes):

1. Open the [Amap console](https://console.amap.com/dev/key/app) → create an app → request a **"Web Service"** key (free for individuals).
2. In DSH **Settings → Plugins → dsh-map-tools**, paste the key, set data source `amap`, save.
3. Ask in a session:

```
Plan a driving route from Beijing South Station to Capital Airport T3
Geocode "西湖区文三路478号" to coordinates
Any gas stations within 1km of 116.397428,39.90923?
```

## Tools

| Tool | What it does | Free OSM | Amap |
|---|---|---|---|
| `map_driving_route` | Driving route planning | ✅ | ✅ |
| `map_transit_route` | Transit planning | — | ✅ |
| `map_walking_route` | Walking route planning | ✅ | ✅ |
| `map_bicycling_route` | Bicycling route planning | ✅ | ✅ |
| `map_geocode` | Address → coordinates | CJK unreliable | ✅ |
| `map_reverse_geocode` | Coordinates → address | CJK unreliable | ✅ |
| `map_poi_search` | POI search | — | ✅ |

Origin/destination accept either **address text** or **`"lng,lat"` coordinates** — the plugin normalizes automatically.

## Configuration

### Settings card (recommended)

DSH **Settings → Plugins → dsh-map-tools** provides a graphical card: data-source selector, masked Amap key input, timeout, and apply link. Saving takes effect immediately.

Config lives in **`~/.dsh-map-tools/config.json`** (0600), decoupled from the DSH settings document and shared across profiles:

```jsonc
// ~/.dsh-map-tools/config.json
{
  "provider": "amap",        // "amap" | "osm"
  "amapKey": "your-amap-key",
  "timeoutMs": 15000
}
```

> Keys are only surfaced to the frontend as a boolean (`hasAmapKey`); the literal is **never echoed to the page or logs**.

### cordis.yml defaults

Defaults can be provided in the profile's `cordis.yml` (**config-file values win over cordis.yml**):

```yaml
- id: map-tools
  name: dsh-map-tools
  config:
    provider: amap
```

## Architecture

```
┌─ Model ─────────────────────────────────────┐
│  map_driving_route / map_geocode / ...      │  7 native tools (ctx.tools)
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  src/tools/    tool definitions (validate+render) │
│  src/clients/  provider clients              │
│    amap.ts      Amap Web Service API (recommended) │
│    osrm.ts      OSRM free routing (fallback)       │
│    photon.ts    Photon free geocoding (fallback)   │
│    nominatim.ts Nominatim free geocoding (fallback)│
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  src/config-file.ts  ~/.dsh-map-tools/config.json (0600) │
│  src/config-route.ts loopback route /dsh-map-tools/config │
│  src/settings-ns.ts   settings namespace registration    │
│  client/client.js     settings card (hand-written, zero-dep)│
└──────────────────────────────────────────────┘
```

- **Config priority**: config file (settings card) → `cordis.yml` defaults.
- **Instant apply**: tools rebuild on config change; no restart.
- **No MCP**: all capabilities are native tools; no external MCP server process.

## Data sources

| Source | Use | Key | Notes |
|---|---|---|---|
| Amap (高德) | All tools (recommended) | Free | Best China coverage: transit, POI, Chinese geocoding |
| OSRM | driving/walking/bicycling routes | none | Free public server, rate-limited |
| Photon / Nominatim | geocoding | none | Free public; **CJK unreliable**, unreachable on some networks |

> Free-source limitations (unstable CJK geocoding) are deliberate: without a key you get clear guidance; with an Amap key the experience upgrades seamlessly.

## FAQ

**Q: I configured an Amap key but routes still use OSM?**
A: Check the config file's `provider` is `amap` (not `osm`) and `amapKey` is non-empty.

**Q: Why do transit/POI require a key?**
A: Free OSM sources don't provide transit or POI data; those need the Amap key.

**Q: My Amap key is rejected?**
A: Make sure it's a **"Web Service"** key (not JS API / Web key), and the services are enabled in the Amap console.

**Q: Chinese geocoding reports "free source unavailable"?**
A: Free sources (Photon/Nominatim) handle Chinese poorly and may be unreachable on some CN networks. This is by design — configure an Amap key and it resolves.

## Development

```sh
pnpm install
pnpm run build                # tsc → lib/
pnpm test                     # vitest unit tests (mocked network)
node scripts/smoke.mjs        # smoke: 7 tools register
node scripts/integration.mjs  # integration: real requests (free sources)
node scripts/amap-e2e.mjs     # Amap e2e: set AMAP_API_KEY
node scripts/config-e2e.mjs   # config file round-trip
```

Conventions: see [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Publishing

```sh
npm config set registry https://registry.npmjs.org/
npm login                     # npm account (a bypass-2FA publish token is recommended)
node scripts/publish.mjs      # one-shot: build → pack check → publish → verify
```

Versioning follows [SemVer](https://semver.org/); changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## Security

Key storage and vulnerability reporting: see [SECURITY.md](SECURITY.md).

## Contributing

Issues and PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## License

[MIT](LICENSE) © HorusJiang
