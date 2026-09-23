[简体中文](capability-onboarding.zh-CN.md)

# GoTry Capability Onboarding — Three Setup Surfaces That Need the User

> Position: the single followable reference for the three external capabilities that the user must set up themselves (issue #559 B step). The runtime hint strings inside the capability layer are **first-touch** notifications (a single line at the moment of failure); this document is the **followable guide** that backs them and the **impact surface** they were missing.
> Status: living — updated whenever a new capability needs user-side setup, or the impact surface changes.
> Upstream: [`data-sources.md`](data-sources.md) (data authority), [`user-guide.md`](user-guide.md) (end-user narrative), [`tools.md`](tools.md) (tool surface).
> Downstream: bootstrap setup commands (`bin/gotry-bootstrap.js`), doctor report (`ts/capabilities/doctor.ts`), capability hint strings (`ts/capabilities/*.ts`).

## Why This Document Exists

Three external capabilities in GoTry cannot be auto-installed by the bootstrap — they require the **user's own** action because they touch personal data (extension install + login), personal money (FlyAI key), or personal infrastructure (CalDAV username):

| Capability | Why it is user-side | Where it is wired |
|---|---|---|
| Session Bridge extension | Per-browser Chrome install + extension ID identity pinning; the extension runs in the user's browser, not on the server | `extension/README.md`, `ts/capabilities/session/extension-bridge.ts` |
| FlyAI key | Provider-side API key — never embedded into the npm package; the LLM cannot enter it on the user's behalf; the host CLI is the only write path | `ts/src/flyai-setup-tool.ts`, `ts/capabilities/flyai.ts` |
| dsh-calendar | CalDAV username is a user-owned resource, mounted optionally via the setup state surface (D-9: optional dependencies enter the setup state, not env vars) | `ts/capabilities/doctor.ts`, `bin/gotry-bootstrap.js` |

The first-touch prompts (capability layer / bootstrap / doctor) now end with a one-line **impact** statement: which tools become unavailable and which still work. This document is the followable expansion. If a setup path or impact changes, edit the runtime string **and** here in the same commit.

---

## 1. Session Bridge Extension

### What you get when it is connected

`gotry_session_search` and `gotry_session_login` (the account-session channel). The bridge lets gotry passively sniff the user's own logged-in Chrome tabs — **Ctrip flight + hotel, 12306 trains, Dida supplier-portal real-time hotel prices**. Read-only. Cookies are read **name-only**; values are discarded immediately.

### What you lose without it

| Surface | Status without bridge |
|---|---|
| `gotry_session_search` (kind=flight / hotel / train / dida) | unavailable |
| `gotry_session_login` (Ctrip login guidance) | unavailable |
| FlyAI realtime (`gotry_flyai_search`) | unchanged (still works) |
| hbcli realtime hotel (`gotry_hotel_search`) | unchanged (still works) |
| Map / weather / flight verify | unchanged (still works) |

So the impact is **contained**: account-session tools are gone, the rest still works.

### Three install paths (pick one)

#### Path A — Chrome Web Store (recommended; auto-update)

1. Open https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd
2. Click **Add to Chrome**.
3. Open Chrome, confirm the extension is **enabled** at `chrome://extensions`.
4. Open a gotry web / headless session — `/health` heartbeat from the bridge picks up the extension within ~5 seconds.

#### Path B — GitHub Releases local load (no store review; faster updates)

1. Run `npx @danceiny/gotry setup --extension-from=github` — this downloads the tarball from GitHub Releases tag `ext-*`, verifies SHA-256, and unpacks to `~/.gotry/extension`.
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `~/.gotry/extension`.
3. Confirm the extension ID matches the expected constant in `ts/capabilities/session/extension-bridge.ts` (`olpgkofjhhiiiahdkkbcninhjmegghfe` for unpacked; `oeajpiccmonococjcegddlooeeohlbgd` for store).

#### Path C — npm bundle local load (offline deterministic)

1. Run `npx @danceiny/gotry setup` — drops the bundled `extension/` into `~/.gotry/extension`.
2. Load unpacked at `chrome://extensions` as in Path B.

### Verification

```bash
# Bridge is alive (loopback HTTP):
curl -s http://127.0.0.1:8791/health
# expected: {"ok":true,"service":"gotry-session-bridge","protocol":"session-bridge.v1"}

# Extension is connected (last heartbeat < 45 seconds ago):
curl -s http://127.0.0.1:8791/status
# expected: "extensionConnected":true, "lastSeenMsAgo":<small>
```

If `extensionConnected` stays `false` for >45s while the bridge is up: open the extension service worker console at `chrome://extensions` → Service worker → **Inspect views: service worker**; the bridge logs `/health` hits there. Common cause = the extension is installed but its service worker was suspended (Chrome aggressively suspends idle workers; open a tab to wake it).

### Edge case — store ID ≠ unpacked ID

Both IDs (`oeajpicc…` for store, `olpgkf…` for unpacked) are trusted by the bridge's Origin whitelist (`EXTENSION_ORIGINS` in `extension-bridge.ts`). A single Chrome instance can only carry one of them at a time — switching requires uninstalling the other first.

---

## 2. FlyAI Key (Fliggy Open Platform)

### What you get when it is configured

`gotry_flyai_search` (8 official Fliggy open-API kinds: flight, train, hotel, poi, keyword, ai, marriott-hotel, marriott-package). With a verified key, quota follows your personal Fliggy plan — **no shared-pool quota risk**. The verification receipt is bound to `(key sha256, source, endpoint fingerprint)` — set / clear / verify must match all three or the receipt is treated as stale.

### What you lose without it

| State | Behaviour | Status |
|---|---|---|
| Anonymous trial (no key) | `gotry_flyai_search` falls back to the shared quota pool | **Easily exhausted** — the pool is small; high-traffic sessions hit `Trial limit reached` and the tool returns `verdict=needs-setup` for the rest of the session |
| After Trial limit | `gotry_flyai_search` is unavailable until configured | session still usable via `gotry_session_search` (account-session, requires Session Bridge) or hbcli (hotel) |
| After `gotry setup flyai` | quota follows your personal key, retry-after / 401 paths behave correctly | normal |

### Setup steps

1. Log into https://flyai.open.fliggy.com/console in your browser.
2. Create / copy an API key.
3. Run `npx @danceiny/gotry setup flyai` — paste the key at the hidden prompt. The CLI **verifies the key against the configured endpoint first**, then writes `FLYAI_API_KEY` and a verification receipt.
4. Optional: pipe from stdin — `echo "$KEY" | npx @danceiny/gotry setup flyai --stdin` (CI / containerized path).
5. Verify: `npx @danceiny/gotry setup flyai --status` shows source + endpoint + verification status.

### Verification

```bash
# Status (source + endpoint + verified?):
npx @danceiny/gotry setup flyai --status
# expected output (line by line):
#   状态: 已验证当前配置
#   来源: env | masked: ****
#   endpoint: https://flyai.open.fliggy.com/mcp

# Read-only provider check (calls FlyAI once; updates verification receipt):
npx @danceiny/gotry setup flyai --check
# expected: action=check, checkVerdict=hit or miss, verified=true (only when key is configured)

# Doctor surface:
npx @danceiny/gotry doctor
# expected: FlyAI row → ✅ 已验证
```

### Clearing / rotating

```bash
# Clear the saved key (back to anonymous trial):
npx @danceiny/gotry setup flyai --clear

# Rotate: just run setup flyai again with the new key; the verification receipt
# is rebuilt against the new key sha256. Old receipt is invalidated because
# key sha256 no longer matches.
```

### Edge cases

- **Endpoint debugging**: `DEBUG_FLYAI_MCP_URL` overrides the endpoint; the receipt records `endpointDebug=true` and the doctor surfaces a `(DEBUG)` tag next to the endpoint. A 403 in DEBUG mode usually means the key's allowed-scope does not match the overridden host.
- **Stale receipt after endpoint change**: if the endpoint fingerprint changes (server-side routing, mirror rotation), the existing receipt is treated as stale; the doctor surfaces `已配置未通过验证`. Re-run `setup flyai --check` to rebuild.
- **Don't send the key in chat**: the runtime CLI deliberately hides input and the model-side tool (`gotry_flyai_setup`) refuses all credential parameters. This is a hard rule — verification logs only show sha256, masked key, source, and endpoint.

---

## 3. dsh-calendar (Optional CalDAV Work-Window Reader)

### What you get when it is mounted and configured

`gotry_calendar_check` becomes available as a tool that reads the user's CalDAV work window so the agent doesn't have to ask "what days are you free" via chat. The persona interview fallback covers work-window inference even without it, but with it the calendar tool runs automatically and removes an interview round.

### What you lose without it

| State | Behaviour | Status |
|---|---|---|
| Default (not mounted) | Calendar tool is **not** in the toolbox; the persona interview covers work-window inference | acceptable — most users do not need this |
| Mounted but not configured (`--on` without `username:` in cordis.patch.yml) | Calendar tool is in the toolbox, but every call returns "未配置" mid-session | **degraded** — the user opted in but the runtime blocks |
| Mounted and configured | Calendar tool reads the work window automatically | ok |

**Important**: dsh-calendar is **default-off** (D-9). The "degraded" state is only triggered by an explicit `--on` that was not finished. If you don't need automatic work-window reads, just leave it off.

### Setup steps (only if you want it)

1. Make sure your dsh web profile exists at `~/.dsh/profiles/web/` (default after first `gotry web` run).
2. Enable the calendar mount: `npx @danceiny/gotry setup calendar`. This writes `~/.gotry/calendar.json` with `{enabled:true, updatedAt:<iso>}` and restarts the affected sessions on next reload.
3. Edit `~/.dsh/profiles/web/cordis.patch.yml` to override the calendar entry's `config.username` with your CalDAV username:

   ```yaml
   - id: dsh-calendar
     config:
       username: <your-caldav-username>
   ```

4. Restart gotry (the patch is read at startup, not on the fly).

### Turning it off

```bash
npx @danceiny/gotry setup calendar --off   # deletes ~/.gotry/calendar.json; back to default
```

### Verification

```bash
# Status (mounted? configured?):
npx @danceiny/gotry setup calendar --status
# expected:
#   状态: 已挂载且已配置
#   状态文件: ~/.gotry/calendar.json
#   说明: 挂载=`npx @danceiny/gotry setup calendar`; 关闭=`... --off`; ...

# Doctor surface:
npx @danceiny/gotry doctor
# expected: dsh-calendar row → ✅ 已挂载且已配置
```

### Edge cases

- The persona interview still works even when calendar is configured. Calendar reads do not replace the interview — they remove the "what days are you free" round; preference / pace / constraints still come from chat.
- No new dependency is added to the npm bundle for this — dsh-calendar is an opt-in patch entry. Removing it (`--off`) does not require an npm reinstall.
- Username is the only required field; URL / auth credentials are provided by the dsh profile's Cordis configuration (out of scope here).

---

## Reference

- Capability registry / routing surface: [`architecture.md`](architecture.md) § channel registry
- Tool surface (what each tool does): [`tools.md`](tools.md)
- End-user narrative (when to use which tool): [`user-guide.md`](user-guide.md)
- Data source authority (which sources are realtime / static / fallback): [`data-sources.md`](data-sources.md)
- Extension install details: [`extension/README.md`](../extension/README.md)
- FlyAI integration contract: [`design/flyai-supplier-skill-design.md`](design/flyai-supplier-skill-design.md)
- Optional-dependency / setup-state contract: [`design/tool-orchestration-design.md`](design/tool-orchestration-design.md), [`decisions-needed.md`](decisions-needed.md) D-9