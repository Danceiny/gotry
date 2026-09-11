[English](tokens.md) | [简体中文](tokens.zh-CN.md)

# GoTry Token Manual (the single token authority)

> Positioning: **precise acquisition steps + unified storage location for all external credentials**. Every token the founder has given can always be found here — never re-asked, never lost.
> Discipline (established after the founder's sharp critique on 2026-08-24): tokens go into `.env` (gitignored); not into the global `~/.npmrc`, not into git-tracked files, not into docs in plaintext.

---

## Unified Storage: Repo Root `.env` (gitignored)

```
LLM_API_KEY=...          # DeepSeek (stored, given 2026-08-22)
NPM_TOKEN=...            # npmjs (stored, given 2026-08-24, see below)
TWITTER_AUTH_TOKEN=      # agent-reach channel (not given, fill on receipt)
TWITTER_CT0=
XHS_COOKIES=             # Xiaohongshu Cookie-Editor JSON
```

**The format for the founder giving tokens**: paste directly in conversation (any format works); I auto-write `.env` and use it immediately.

---

## npm (npmjs.org) — ✅ Connected (2026-08-22, @danceiny/gotry@0.0.1-rc.5 PUT 200)

**Isolation command** (2026-08-22 founder: "don't use the global ~/.npmrc, make a separate command to isolate it"):
- `./scripts/publish-npm.sh` — `NPM_CONFIG_USERCONFIG` points to the in-repo `.npmrc.publish` (gitignored, generated from .env on the fly), **never reads/writes the global ~/.npmrc**, unaffected by bnpm registry/prefix; deprecated the old script's practice of `npm config set` writing tokens to the global config (one of the sources polluting the daily-work npmrc)
- Full process as actually tested: whoami=danceiny passed; the bare name `gotry` collided with the existing `go-try` (new npm rule) → switched to scoped `@danceiny/gotry`; founder enabled 2FA (recovery codes stored at `~/work/npm_recovery_codes.txt`, 4 used); **recovery codes can be used as `--otp`**; final `npm publish --access public --otp=<recovery code>` → PUT 200 + public access. New packages are subject to an npm security review hold; view may 404 for minutes to hours after PUT 200 — normal
- **⚠️ 2026-08-28 rc.10 release reality (supersedes the old flow)**: the legacy NPM_TOKEN in .env has expired (whoami 401); **recovery codes as --otp have been rejected by npm** ("one-time password from an authenticator required", both tested codes rejected). Viable paths = ① web login: npm CLI without a TTY falls into interactive mode and fails; you must use npm-profile library-level driving (critical header `npm-auth-type: web`, otherwise the registry 400 treats it as a couch login) to get the real loginUrl → browser Approve → session token written to `.npmrc.publish`; ② at publish time, for EOTP use an expect-wrapped PTY to run `npm publish`; otplease auto-opens the browser for `auth/cli` second verification; after Approve, the publish automatically continues to success. rc.10 was shipped via this path
- **⚠️ rc.15 release record (2026-08-29, codified by #50③ as the standard release action)**:
  - The web session token (`.npmrc.publish`, path A) can log in and whoami, but **publish PUT is blocked by account-level 2FA (EOTP → web second confirmation)**; the npm logs also gave a deprecation warning — direct publish with bypass-2FA tokens is being tightened (<https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/>, target 2027-01).
  - The path actually walked = **`npm publish` under a PTY terminal** (expect-wrapped PTY since rc.10) → otplib pops web authorization → **founder clicks Approve once in the browser** → PUT auto-retries to success. **"Release = one browser approve, clicked by the founder" is the standard action from here on** (synced to the AGENTS.md release gate)
- **Every future release**: `TAG=latest ./scripts/publish-npm.sh` (dist-tag must be passed explicitly, #50①: the old default rc.5 once pushed new packages to a stale channel); credentials use the path A web session — `--otp=<recovery code>` is rejected by npm, and the granular bypass token (path B) is on npm's tightening track; neither is a main path
- **dist-tag maintenance (#50②, executed 2026-09-02)**: within a founder instruction window, using the `.env` NPM_TOKEN (granular), ran `npm dist-tag add @danceiny/gotry@0.0.1-rc.16 rc --registry=https://registry.npmjs.org/` successfully — `rc` moved from the stranded rc.7 to rc.16; **but the DELETE dist-tag endpoint returns 403 for this token** (direct curl recheck also 403; a granular token has no delete permission) → the stray `rc.5` was repointed via the add channel to `0.0.1-rc.5` for self-consistency, and `rc.11–rc.14` each point to their same-named versions; fully deleting the five aliases requires one founder login on the npmjs web UI (package → Settings → manage dist-tags). **Runbook split into two tiers**: repointing (add) can be done directly with a token; deletion must use the web UI
- **Deletion channel exhaustion verified (2026-09-08, rc.20 wrap-up retest, do not retry)**: agent side, four routes all 403/405 — ① the `.env` granular token via CLI and direct curl DELETE both 403 (the error message explicitly states "Granular access tokens that bypass two-factor authentication may not perform this action", i.e., the dist-tag face of npm's 2026-07-31 tightening policy); ② the old granular token in `~/.npmrc` 401 (expired); ③ the leftover `.npmrc.publish` token in the main worktree (whoami=danceiny valid, actually granular form `npm_`×40, not a web session) still 403 on DELETE — **granular token validity ≠ delete permission**; ④ the registry dist-tags collection-wide PUT endpoint 405 (not open). **Whether a web session token can pass DELETE is untested** (a session cannot be established without founder browser authorization); the script side already ships `./scripts/publish-npm.sh login` (final state, exempt from the TAG gate) + an `rmtag` subcommand; if rmtag still 403s after login, the npmjs web UI is authoritative (package → Settings → manage dist-tags)
- **Path A (recommended)**: `./scripts/publish-npm.sh login` → click Approve once in the browser → the session token is written only to .npmrc.publish → run the script again to publish
- Path B (**being tightened, not a main path**): create a granular token on the npmjs web (allow bypass 2FA + packages read-write) → store as NPM_TOKEN in .env — npm policy target 2027-01 bans bypass-2FA direct publish; the deprecation warning was already seen in the rc.15 release logs

### Historical Token Note

On 2026-08-22/24 there was a legacy classic token written into `.env`'s `NPM_TOKEN` (later expired, whoami 401); its plaintext once mistakenly entered a git-tracked document (private repo); per founder instruction, not elaborated; to rotate, revoke anytime on the npmjs web. **The lesson is codified: docs never store tokens in plaintext.**

### Precise Causes of 403 (npm 2026-07-31 Policy, Verified by Testing)

| Operation | This classic token | Reason |
|---|---|---|
| `npm whoami` | ✅ passes | read operations unrestricted |
| `npm profile get` | ❌ 403 | since 2026-07-31 bypass-2FA tokens are banned from account management |
| `npm publish` | ❌ 403 | a classic token has no 2FA capability; needs a web session or a bypass token |

Policy original text: <https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/>
The token restriction on direct publish targets 2027-01; the main path = **path A web session (one browser approve by the founder at release)**; the granular bypass token (path B) is still usable but on the retirement track; mid-term migration to path C OIDC.

### Path A: Web Session (Simplest, 10 Seconds, No Token Generation Needed)

I can generate a one-time link anytime; you click Approve once in the browser:

```sh
# I run this, give you the output link, you open it in the browser and confirm
npm login --auth-type=web --registry=https://registry.npmjs.org/
# the link looks like https://www.npmjs.com/login?next=/login/cli/<uuid>
# after you click → my session is established → immediately npm publish (the session carries 2FA authorization)
```

The link is valid for about 5 minutes; if it expires I just regenerate — zero cost.

### Path B: Granular Access Token (One-and-Done, ~60 Seconds)

1. Open in the browser <https://www.npmjs.com/settings/danceiny/tokens>
2. **Generate New Token → Granular Access Token**
3. Three key form fields:
   - Expiration: choose short term (7 days is enough)
   - Packages and scopes: **Read and write**
   - **Check "Allow token to bypass two-factor authentication"** (lower on the page; not checking it = wasted creation)
4. After generation, copy the string starting with `npm_`, paste it to me → I write `.env` → `./scripts/publish-npm.sh` publishes

### Path C (Mid-Term Main Evaluation, #50③): GitHub Actions OIDC Trusted Publishing

After the package's first publish, associate the GitHub repo + workflow on the npmjs package settings page; afterwards CI auto-publishes, **permanently token-free and 2FA-free**. Unusable before the first publish — walk A or B first.

### Publish Script (Ready)

```sh
TAG=latest ./scripts/publish-npm.sh                    # dist-tag must be explicit (#50①); credentials prefer the .npmrc.publish session, fall back to NPM_TOKEN in .env
NPM_TOKEN=npm_xxx TAG=latest ./scripts/publish-npm.sh  # or inject a token ad hoc
```

---

## LLM (DeepSeek)

Already stored in `.env`'s `LLM_API_KEY` (given 2026-08-22, `sk-f2f5...83d8`).
Get a new key: <https://platform.deepseek.com/api_keys> → Create new key → paste directly to me.

## LLM Price Table and Price Drift Monitoring (issue #49)

> **The price table follows model/relay switches**: `ts/data/llm-price-table.json` is the single source of truth for `gotry_m3_nightly_run_v1.cost_usd` (ADR-11); the peak conservative upper bound only goes up, never down.
> Adding a provider/changing prices: `gotry_llm_price_table_v2` schema; `loadPriceTable` is dual-format compatible with v1; unknown model → fail-closed, no price guessing.
> Long-term mechanism: `npx tsx scripts/price-drift-watch.ts` (default offline comparison against the baseline fixture, outputs a PR-ready Markdown diff) / `--fetch` (online pull of official pages + first-time fixture write; fetch failure/parse failure always SKIP, zero writes of unknown data); **never auto-apply prices** — price changes must be manual PRs, per ADR-11 "peak only-high-not-low".

---

## agent-reach Channels (All Optional, Connected on Receipt, No Chasing)

> The runtime body (python `.venv` + agent-reach) status is checkable anytime: **`npx @danceiny/gotry doctor`** (or in a dsh conversation, ask the assistant to call the `gotry_doctor` tool); when something is missing, **`npx @danceiny/gotry doctor --fix`** one-click installs it (official pip, installed into the in-package `.venv`). The table below is only **channel credentials**; each channel still needs individual opt-in.

| Channel | What's needed | Acquisition steps | Format to give me |
|---|---|---|---|
| Twitter/X | 2 cookie values | log in to x.com in the browser → F12 → Application → Cookies → copy `auth_token` and `ct0` | paste two lines in conversation |
| Xiaohongshu | Cookie JSON | install the Cookie-Editor extension in Chrome → log in to Xiaohongshu → extension Export (JSON) | paste JSON |
| Reddit | rdt-cli cookie | OpenCLI browser login state (desktop) | I detect OpenCLI presence and use it |
| Bilibili subtitles | (optional) OpenCLI | install OpenCLI on desktop, log in to Bilibili | auto-detected |
| Xueqiu/stocks | login Cookie | `.venv/bin/agent-reach configure --from-browser chrome --platform xueqiu` (upstream instructions passed through verbatim) | ready once configured; `gotry_agent_reach` reflectively calls get_stock_quote |
| YouTube subtitles | yt-dlp | `brew install yt-dlp` | ready once installed, nothing to give me |
| GitHub private repos | gh login | `brew install gh && gh auth login` | ready once installed |
| Web-wide semantic search | mcporter+exa | `npm i -g mcporter && mcporter config add exa https://mcp.exa.ai/mcp --scope home` (free, no key) | ready once installed |

**Zero-config already connected** (no action needed): web page reading (r.jina.ai) / RSS / V2EX / Bilibili search.

## Amap MCP Server (Official Agent Channel, P0 Due Diligence 2026-08-28)

| Item | Content |
|---|---|
| Capabilities | geocoding/reverse geocoding/POI search/driving-transit-walking-cycling routes (the upgrade surface over dsh-map-tools' free OSRM) |
| Acquisition | <https://console.amap.com/dev/key/app> → create application → add Key (service platform: choose "Web 服务") → paste to me |
| Free | individual developer daily quota (thousands of calls/day per interface incl. geocoding; the console prevails) |
| Usage | the key goes into `.env`'s `AMAP_KEY`; integration via the Amap MCP Server (<https://developer.amap.com/api/mcp-server/getting-started>) or direct REST |

## Fliggy FlyAI (飞猪) (Official Agent Channel; Anonymous Trial Quota Is a **Shared Pool, Easily Exhausted**, 2026-09-02 Erratum)

`npx -y @fly-ai/flyai-cli search-flight --origin 上海 --destination 丽江 --dep-date 2026-10-01` returns real fares. All 8 tools are read-only (flights/trains/hotels/POI/Marriott/keywords/AI semantic). **2026-09-02 Dubai session reality: the anonymous trial quota is a shared pool; once exhausted, always 429 "Trial limit reached"** — the gotry side already classifies this as `needs-setup` (the error carries application guidance, no longer blindly retried as a search failure). Stable usage = apply for a formal API Key at the <flyai.open.fliggy.com> console, configure the `FLYAI_API_KEY` environment variable; `npx @danceiny/gotry doctor` shows the key configuration status. During the no-key period, flight/train/hotel search primarily uses `gotry_session_search` (account session).

---

## Security Baseline (No Nagging, Facts Only)

- `.env` is in `.gitignore` ✓ (no tokens in git-tracked files, verified)
- The global `~/.npmrc` **does not** hold an npmjs token (last tick's mistaken write cleaned; the company bnpm one stays — an intranet necessity)
- Git history contains one npm token in plaintext (written into decisions-needed.md on 2026-08-22/24 then pushed, private repo) — per founder instruction **this topic is not elaborated further**; to rotate, revoke anytime on the npmjs web
