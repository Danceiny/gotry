[English](lavish-local.md) | [简体中文](lavish-local.zh-CN.md)

# Lavish Local Session Adapter (#443, parent #438)

> Status: **bounded adapter slice + plugin registration (2026-09-12, issue #443)**. This document covers the local
> `lavish-axi` session lifecycle adapter that landed as `ts/capabilities/lavish-local.ts` with
> `ts/scripts/lavish-local-tests.ts`, and the host-side registration layer that exposes it as five
> dsh tools through `ts/src/index.ts` (the adapter and the registration slice are deliberately
> distinct layers; §9 names the boundary and §7 keeps the still-open items). Every protocol claim in §2
> was read from the installed `lavish-axi@0.1.67` tarball, not from prose.

## 1. What this answers

GoTry needs to hand a generated HTML artifact to a human for visual review and get feedback back
without inventing a review UI. Lavish Editor ships that UI as a local CLI (`lavish-axi`) with a real
open/poll/reply/end/stop protocol. This adapter is the seam that lets GoTry drive that protocol
**without** becoming a second owner of Lavish's browser surface, watcher, session store, or HTTP
control plane.

The adapter is deliberately narrow: it owns the process group it spawns, the state directory it
creates, and the loopback port it allocates. It owns nothing else, and it never reaches outside that
boundary — see §5.

## 2. Verified protocol facts

Pinned upstream: `lavish-axi@0.1.67` (MIT, `engines.node >= 22`), published `bin` entry
`dist/cli.mjs`. Facts confirmed by reading the installed package and by running it:

- **Output is TOON, decoded with the official decoder.** `axi-sdk-js@0.1.11` pulls
  `@toon-format/toon@^2.1.0`, which resolves to `2.3.1`; the adapter depends on that exact version.
  There is no `--json` switch and no YAML. **Failures also arrive on stdout** as a TOON
  `{error, code, help?}` object with a non-zero exit code (2 for `VALIDATION_ERROR`, 1 otherwise), so
  the adapter checks for the `error` key rather than trusting the exit code alone.
- **Command vocabulary:** `open`, `poll`, `end`, `stop`, `server`. `update` is the SDK's own
  self-upgrade and is never invoked by this adapter; neither are `setup hooks`, `setup plugin`,
  `share`, or `export`.
- **`open`** returns `session.status` of `opened` or `user-ended`. Only a user-initiated end blocks a
  plain reopen — the adapter never passes `--reopen`.
- **`poll`** statuses are `waiting`, `feedback`, `ended`, `browser_disconnected`. A `waiting` result
  consumed nothing and is safe to poll again; a `feedback` delivery **is** the consumption. A missing
  session is reported as a `NOT_FOUND` error object, not as a status.
- **`server`** is the long-running HTTP control plane. `stop` is well-defined when nothing is
  running (`server.status: not-running`).
- **The server self-exits once the last session ends with nothing connected.** The adapter therefore
  treats "the owned server is already gone" as a normal outcome of `stop`, not as an error.

## 3. Adapter API

`LavishLocalSession.create(options)` returns an instance. Every method performs at most one CLI
invocation and returns a discriminated result — an `ok: true` value or a
`{ ok: false, code, detail }` failure. The adapter never retries internally.

| method | protocol call | result |
| --- | --- | --- |
| `open(path)` | `open <realpath> --no-open` | `opened` / `user-ended` plus the loopback session url |
| `poll(path, {timeoutMs})` | `poll <realpath> --timeout-ms <n>` | `waiting` / `feedback` / `ended` / `browser-disconnected` |
| `reply(path, text, {timeoutMs})` | `poll <realpath> --agent-reply <text> --timeout-ms <n>` | same shape as `poll` |
| `end(path)` | `end <realpath>` | `ended` |
| `stop()` | owned process group, never the CLI `stop` | `stopped` / `stopping` / `not-running` |

`reply` is the protocol's own `poll --agent-reply` call, which answers the feedback and waits for the
next state in one invocation. Replies are validated to be non-empty and not the bare `--` flag
terminator, because the CLI's flag parser would silently drop those.

Options are trusted and explicit: `cliPackageRoot` (the installed package directory), `cwd`, and
`allowedRoot` (defaults to `cwd`). There is no option that accepts command text, a shell string, a
port to hijack, or an ambient state directory.

## 4. Trust boundary: the artifact path and the feedback payload

**Artifact paths are allowlisted by realpath.** Input must be a `.html`/`.htm` file; relative input
resolves against `cwd`; the canonical path is then required to stay inside `allowedRoot`, with any
`.git` or `node_modules` segment denied. Because containment is checked **after** symlink
resolution, a symlink pointing outside the root is rejected rather than followed. The adapter only
ever consumes a path — it has no write API, never rewrites the artifact, and never re-runs `open` to
"update" content. Content updates are the caller's (or the watcher's) business, because the CLI's own
`next_step` contract is that Lavish live-reloads a saved artifact.

**Feedback is data, never authority.** Everything the CLI prints about the user — prompt text,
selectors, tags, attachment references, artifact failures, the DOM snapshot — is returned inside a
`LavishUntrustedFeedback` value marked `trust: 'untrusted'`, with byte and count bounds and an
explicit truncation flag per collection. The adapter deliberately drops the CLI's `next_step`
instruction text instead of forwarding it, because it is third-party prose addressed to an agent and
must not arrive as system authority. Attachment references are projected to `id`/`name` only: the
adapter performs **no filesystem access** for feedback and never follows a path supplied by a
browser.

**Prompt vs text: two distinct fields.** Each projected prompt carries both `text` (the
selected-element context — for freeform chat input upstream sets this to the placeholder
`"Freeform message"`, for an annotation it is the lower-cased element `tagName` plus
`el.innerText.trim()` of the selected element) and `prompt` (the user's actual instruction from the
chat input). The upstream chat filter is
`acceptedPrompts.filter((p) => p.tag === "message" && p.prompt)` (see lavish-axi `dist/cli.mjs`
near the user-message projection, ~7720), so without `prompt` the request is dropped on the floor.
The adapter never substitutes `text` for `prompt`: a missing or non-string `prompt` is exposed as
`prompt: ''` and counted in `LavishUntrustedFeedback.promptsMalformed` so the drop is auditable.
An empty-string `prompt` (a legitimate "no text, attachments only" request) is preserved as data
and is **not** counted as malformed. Annotation tags are real HTML element names (`h1`, `div`, …)
— see upstream `context()` at ~5359 — not a literal `"text"`.

**Nothing is logged.** The adapter contains no logging and writes nothing to stdout or stderr. The
session url embeds an opaque access key, so `redactLavishSessionUrl` is exported for any surface that
must display one, failure details are redacted before they are returned, and a test asserts that a
full lifecycle produces zero writes to either stream.

## 5. Ownership: process group, state directory, port

Each instance owns exactly one `lavish-axi server` child, launched in **its own process group** with
an argv array and `shell: false`. No command string is ever assembled, so nothing in a reply or a
path can be shell-expanded. Cleanup signals the group with `SIGTERM`, waits, then `SIGKILL`, then
waits again, and every CLI invocation is reaped before its result is returned — the adapter never
leaves a poll or a server behind.

Each instance also owns an `mkdtemp` state directory and an **unused** loopback port that it
allocated itself. The child environment is built from scratch rather than inherited: only `PATH`, a
`HOME` redirected inside the owned state directory, and the six explicit `LAVISH_AXI_*` variables
reach the child. A caller's ambient `LAVISH_AXI_*` values (including a wildcard host allowlist or an
idle-timeout override) and any Tailscale variables are dropped, so no global `~/.lavish-axi`
configuration, hook file, or Tailscale binding can be reached. `LAVISH_AXI_TELEMETRY=0`,
`LAVISH_AXI_NO_OPEN=1`, `LAVISH_AXI_HOST=127.0.0.1`, and `LAVISH_AXI_LINK_HOST=127.0.0.1` are always
set, so the session url never leaves loopback and no browser is driven.

**A server this adapter did not start is never adopted, preempted, or shut down.** Before spawning,
the adapter probes the health endpoint on its port; if anything answers, it fails closed. After
spawning, a server only counts as ours when our own child is still alive **and** the health payload
reports the pinned `app`/`version`; the same check gates every later command, so the CLI's
`ensureServer` always reuses our child instead of spawning a detached one of its own. `stop` signals
only our process group and reports `not-running` when there is nothing of ours to reap. Tests cover
both a foreign listener and a pre-existing **same-version** `lavish-axi` server and assert that
neither is signalled.

## 6. Bounded behavior and unknown outcomes

Responses are bounded in bytes on both streams and in wall-clock time per invocation. A poll always
carries an explicit `--timeout-ms` (bounded by `maxPollTimeoutMs`), so a poll returns cleanly with
`waiting` instead of running forever; a `waiting` result consumed nothing and may be polled again.

The one dangerous case is deliberately not silent. If the adapter's own deadline fires and kills a
poll, the outcome is genuinely unknown — the delivery may or may not have consumed feedback. The
adapter records that and refuses the next `poll` with `poll-outcome-unknown` rather than risking a
double-consume; the caller must decide explicitly, which usually means a fresh instance. A
user-initiated end is likewise sticky: once `open` returns `user-ended`, or a poll reports
`ended_by: 'user'`, the instance latches closed and later `open` calls fail with
`session-user-ended` instead of reopening.

## 7. Not in this slice (explicit TODO)

- **Browser acceptance scope.** The direct-adapter browser check exercised user feedback, replies, source-file refresh and user end. It did not establish `browser_disconnected` grace. Registered five-tool browser and final-candidate evidence are tracked in #443 (parent #438); native-preview acceptance is separate in #448.
- **Lavish is not a product dependency.** Only the decoder (`@toon-format/toon@2.3.1`) enters the manifests and locks; the adapter is handed an installed CLI path at runtime and the CLI itself is not vendored into the product tree.
- **Unsupported feedback shapes stay opaque.** Whiteboard/excalidraw targets and attachments are bounded and marked untrusted rather than deeply modelled, so the product surface must not rely on fields beyond `id` / `name`.
- **Native HTML preview acceptance is a separate item (#448).** Opening a listed HTML entry is a client-labelled action that hands the file to the host's native HTML preview; that rendering and any script execution is the host renderer's behaviour, not the Lavish adapter's. The Lavish registered tools do not extend or override the host preview, and #448 carries the actual native-preview status.

## 8. Evidence and how to run

`ts/scripts/lavish-local-tests.ts` has two parts. The offline part is deterministic and needs no
network: it builds a synthetic `lavish-axi` package tree and covers CLI trust refusal (wrong name,
unpinned version, non-pinned entry, missing entry, escaping entry), the path allowlist, argv shape,
the no-shell guarantee, byte/timeout bounds, malformed and unexpected CLI states, feedback bounds,
process-group reaping, user-ended latching, foreign-port refusal, two-instance isolation, and the
zero-write assertion.

The live part is opt-in (`GOTRY_LAVISH_LIVE=1`) and installs the pinned version into a unique
`mkdtemp` npm prefix from the public registry (`--no-save`, `--ignore-scripts`, never global), then
runs the real CLI `open` / `poll --timeout-ms` / `end` / `stop` protocol against a synthetic HTML
fixture on the adapter's own port, including reaping a live owned server. It prints its argv and exit
codes as a transcript.

```
cd ts && npx tsx scripts/lavish-local-tests.ts
cd ts && GOTRY_LAVISH_LIVE=1 npx tsx scripts/lavish-local-tests.ts
```

## 9. Registration into the product tool surface

The host can enable the five tools by adding this GoTry plugin configuration fragment:

```json
{
  "lavishAxiPackageRoot": "/path/to/node_modules/lavish-axi"
}
```

Use the absolute directory of an installed, trusted `lavish-axi@0.1.67` package. Empty or relative
values register no Lavish tools. Package identity is checked before execution; GoTry does not
install or discover a CLI automatically. Tool arguments cannot override the package, port or state root.

Each call binds to the exact `exec.agent.session.id` and the host's absolute
`exec.agent.session.header.cwd`; `agent.id` is not a fallback. Both raw and canonical cwd must
remain unchanged. Paths must resolve to existing `.html` / `.htm` files inside that workspace;
`.git`, `node_modules` and symlink escapes are refused.

| Tool | Purpose |
| --- | --- |
| `gotry_lavish_open(path)` | Open an existing artifact and return a usable loopback session URL. |
| `gotry_lavish_poll(path, timeoutMs?)` | Poll once with a bounded CLI wait; queueing, startup and command overhead may add time. `waiting` consumes nothing. |
| `gotry_lavish_reply(path, reply, timeoutMs?)` | Send a bounded visible reply and wait once for the next feedback state. |
| `gotry_lavish_end(path)` | End the review, retaining the owned server handle for cleanup. |
| `gotry_lavish_stop()` | Reap this host session's owned server; repeated calls preserve the cleanup result, including failures. |

**Feedback.** `open` returns the URL. Poll/reply feedback is bounded and marked
`trust: "untrusted"`: `prompt` carries the user's instruction and `text` carries selected-element
context. Missing or non-string prompts increment `promptsMalformed`; legitimate empty strings
remain data. Attachments project only to `id` / `name`, without reading their reported paths.
The CLI's `next_step` instructions are discarded. The model and presentation receive the same
bounded feedback fields.

**Lifecycle.** Commands are serialized per host session. Terminal records (`disposed`, `ended`,
`poll-outcome-unknown`, `stopped`, `user-ended`) reject further open/poll/reply/end calls with
`lavish-session-terminal`; stop remains available and returns its cached cleanup result.
Unreadable or uncertain poll outcomes are terminal because the delivery may already be consumed.
Host stop/disposal cannot be overwritten by a late feedback result. Plugin unload marks existing
records disposed and closes the registrar before awaiting cleanup: active calls return
`lavish-plugin-closed`, including calls with a new host session id. Cleanup signals only owned
process groups; failures remain visible and plugin unload reports unreaped records.

**Review loop.** `gotry_itinerary_render` creates one new HTML file; `gotry_artifacts_list` and
`gotry_artifacts_read` discover it and read its source. Then: open in Lavish → user submits feedback
→ poll → agent edits the same HTML source → Lavish refreshes on save → reply → user end or stop.
The reply tool does not write HTML. Host-native HTML preview is a separate path tracked in #448;
these tools do not extend filesystem authority or bypass the fact gate.
