[English](benchmark-environment-bridge.md) | [简体中文](benchmark-environment-bridge.zh-CN.md)

# External benchmark environment bridge

> Status: living engineering ledger (Phase 1 treatment seam; default-off, not a product runtime dependency).

This document covers the optional Phase 1 treatment seam for an external
benchmark harness. It is not a product runtime dependency and does not itself
schedule, launch, spend, score, or claim benchmark improvement.

## Default-off and owner-local configuration

The bridge is disabled unless `GOTRY_BENCHMARK_ENV_CONFIG` points to an
absolute, regular, non-symlink JSON file owned by the current POSIX uid. The
file is limited to 64 KiB and must not be group- or world-writable. It is
opt-in and must stay outside tracked/public evidence. A declaration is not
enforcement: the host OS or an equivalent sandbox must enforce forbidden
writes and denied network.

Once the variable is set, an invalid schema or unavailable active subprocess
provider fails hard before any model request; explicit opt-in never falls back
to an ordinary GoTry run without the bridge.

## Cold-start tool-surface isolation

Opt-in is a process-start boundary. Installation fails if an agent is already
live; it is never hot-attached to an existing session. Every later benchmark
agent is forced to native tool presentation and restricted to the exact global
`gotry_benchmark_environment` definition captured after bridge registration.
Matching the name alone is insufficient: an agent-scoped same-name shadow is
denied at dispatch.

The final authoritative `system-prompt/assemble` result must contain exactly
the captured bridge schema. After all downstream `agent/pre-step` listeners
return, the registry schema and definition identity are checked again. An
extra scoped tool, schema mutation, same-name shadow, or retained PTC
`run_code` transport therefore fails before the model request. Per-agent
guard/presentation/restriction effects are installed atomically and partial
installation rolls back. Agent disposal releases them. If the plugin unloads
first, a live agent keeps an agent-owned assembly blocker plus its scoped
guard/restriction as a fail-closed quarantine: no later model request enters
the remaining assembly chain, and bridge/non-bridge dispatch is denied until
that agent or process is disposed. HMR cannot hot-attach to the old agent.

## Benchmark startup composition isolation

After the owner-local config validates, but before any optional host plugin is
resolved or imported, the CLI projects the top-level patch insert sequence to
exactly one `gotry-tools` item. Calendar, map, ask-user, inline/reordered
unknown items, and future non-GoTry inserts are discarded only for benchmark
opt-in; default-off startup retains the ordinary GoTry composition. Missing or
duplicate `gotry-tools` entries fail closed.

The config path is then injected into that projected item through exactly one
`hbcliBin` anchor. A missing or duplicate anchor, or a pre-existing config-path
field, fails before optional-plugin resolution, dsh spawn, or relay activity.
The error is stable and does not reflect package paths, config paths, plugin
names, or benchmark content.

## Agent conformance and terminal gate

Benchmark opt-in is headless one-shot only. GoTry adds an agent-scoped native
execution contract that translates prompt references to a CLI, shell, Python,
or `agent_env.cli` into structured calls to the sole visible
`gotry_benchmark_environment` tool. `action:"tools"` is discovery only. A
countable turn must issue an allowed `action:"call"` and receive its paired
concrete result or declared domain outcome before it can stop. The call shape
is flat; the retired nested `query` form is not accepted. A domain outcome may
support a terminal response or a later model-authored argument revision, but
the bridge does not retry. A later infrastructure failure invalidates a prior
domain-only path; a later concrete result may recover it. In every case the
accepted terminal response must occur after the latest bridge response, so a
stale terminal cannot mask newer evidence.

Round 11 makes the model-facing request schema one flat object: `action` is the
`tools|call|errors` enum, `tool` is an enum derived from the frozen descriptor
set, and `arguments` is a generic object. This is a wire/schema visibility
change only. At execution time the bridge still validates `arguments` exactly
against the selected frozen descriptor `input_schema`; generic model-facing
arguments do not weaken the execution contract.

The owner-local config also declares a generic tagged-JSON terminal envelope.
The tag is a bounded identifier and `max_bytes` is capped at 1 MiB. A valid
terminal response is exactly one matching tag pair whose body is one JSON
object; prose, code fences, duplicate tags, arrays, primitives, trailing text,
and oversized bodies fail closed. Paired reasoning blocks (`<think>…</think>`,
case-insensitive, any position) are stripped before this validation:
contemporary reasoning models emit them even when instructed to answer with the
envelope only; every other leading/trailing text still fails closed. This is syntax conformance only: the
external adapter and official evaluator still own the business schema.

If the model tries to stop without a real bridge call, or returns a malformed
terminal response after a successful call, GoTry injects at most one fixed
conformance correction. A terminal-format correction must reuse the existing
tool result and cannot dispatch the bridge again. A second violation ends the
turn with a stable error that does not reflect the prompt, arguments, tool
result, paths, or invalid response. The parent CLI separately buffers bounded
stdout and releases it only when the child exits successfully and the same
terminal parser accepts it; rejected assistant text is never forwarded as a
successful benchmark result.

Example (placeholder paths only):

```json
{
  "schema_version": "gotry_benchmark_environment_bridge_v3",
  "enabled": true,
  "executable": "/OWNER-LOCAL/bin/node",
  "cwd": "/OWNER-LOCAL/harness",
  "argv_prefix": ["/OWNER-LOCAL/harness/runner.js"],
  "tools": [
    {
      "name": "lookup",
      "description": "Look up one city.",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "City name." }
        },
        "required": ["city"],
        "additionalProperties": false
      },
      "output_keys": ["city", "country"],
      "domain_outcomes": [
        { "status": "miss", "code": "NOT_FOUND", "recovery": "revise_arguments" }
      ]
    }
  ],
  "timeout_ms": 30000,
  "max_output_bytes": 65536,
  "terminal_output": {
    "tag": "output",
    "max_bytes": 65536
  },
  "isolation": {
    "mode": "host-enforced",
    "writes": "forbidden",
    "network": "denied"
  }
}
```

The executable and cwd are absolute and fixed. Calls use an argv list with the
configured prefix; arbitrary shell strings, shell interpolation, and arbitrary
commands are not exposed. `tools` is a bounded, nonempty descriptor set and is
the single source for discovery, the model-visible tool-name enum, and exact
pre-spawn validation.
Each descriptor has a nonempty description, a closed and bounded object
`input_schema`, a nonempty unique `output_keys` allowlist, and a finite list of
exact `domain_outcomes`. Open nested objects, unknown schema keywords, duplicate
names/keys/outcomes, unbounded arrays, and free-text recovery values fail at
config load. A v1/v2 file must be migrated explicitly; it is never accepted
with ambiguous behavior.

The model sees one flat object root: `action` is the
`tools|call|errors` enum, `tool` is the descriptor-derived name enum, and
`arguments` is a generic object. Only `action` is universally required on this
provider-facing wire. Before any subprocess starts, execution enforces the
exact action shape and validates call arguments against the selected frozen
descriptor `input_schema`; empty, nested legacy `query`, mixed-action,
missing-call-field, and extra-field objects fail closed.
`tools` returns the frozen descriptors. `errors` returns the complete closed
bridge protocol/infrastructure failure inventory. Those failures use
`{"ok":false,"error":"..."}` and are distinct from an adapter domain outcome,
which uses `{"ok":true,"outcome":{...}}` after an exact declared exit-zero
envelope. The bridge never retries either class automatically.

For a concrete result, every visible object key, including keys below arrays
and nested objects, must be listed by that descriptor's nonempty `output_keys`;
every primitive leaf must therefore have a declared-key ancestor. Top-level
record arrays may pass, while unkeyed primitive or mixed arrays fail closed as
`{"ok":false,"error":"forbidden_output"}` without reflecting their values.
`terminal_output` remains required: its identifier-like `tag` defines the only
accepted envelope and its positive `max_bytes` is capped at 1 MiB.
Timeout and output caps are enforced by the subprocess seam, with
non-zero exit, timeout, truncation, invalid JSON, and disallowed tool returning
a structured failure envelope. The subprocess receives only selected
`PATH`/locale/time-zone values plus Python no-user-site/no-bytecode guards;
all other ambient environment names are explicitly removed. Model arguments
are serialized once and rejected before spawn when their UTF-8 size, depth, or
structure count exceeds the bridge limits.

Runner output must be one bounded, exact
`gotry_benchmark_tool_result_v1` object: either
`{schema_version,status:"ok",result}` or an exit-zero, descriptor-declared
`{schema_version,status:"miss"|"error",code,recovery}`. Ambiguous or extra
fields fail closed; a nonzero process exit always remains an infrastructure
failure even if stdout resembles a domain envelope. The bridge recursively
rejects ASCII keys associated with gold, oracle, expected answer, reference,
label, score, reward, ground truth, hidden query, or loader metadata, without
reflecting the key or value to the model. Non-ASCII keys and primitive
top-level results are rejected, and output structure is bounded separately. A benchmark
adapter may provide only the declared visible tool surface and must keep its
query loader and Python/harness runtime outside GoTry's product dependency
graph. No Python dependency is added to the product runtime.

The owner of the validated config is the authority selecting the executable,
cwd, and fixed argv prefix. The bridge does not claim that every referenced
path is owner-owned: root-owned sandbox executables and virtualenv symlinks are
valid deployment choices. Treatment admission must therefore fence the exact
adapter/harness revision and review its positive visible-output contract. The
recursive key guard is defense in depth, not semantic proof against secrets
encoded inside otherwise allowed string values.

## Verification boundary

The validator and registration contract can be checked offline with:

```bash
cd ts
npx tsx scripts/benchmark-environment-bridge-tests.ts
npx tsx scripts/benchmark-environment-bridge-e2e.ts
```

The E2E uses a loopback synthetic model relay, a temporary owner-local runner,
an isolated `DSH_HOME` and cwd, and a synthetic key only. It always exercises
the source checkout. When `GOTRY_BRIDGE_E2E_BIN` is set, it additionally
exercises that clean installed-package CLI. The standard regression creates a
temporary clean consumer when the variable is absent, while CI prepares the
same route explicitly because the historical root npm lock is not the publish
consumer dependency closure.

Covered behavior:

- Default-off behavior, environment isolation, private config rejection, real
  output truncation, a real deadline, global `both` mode being overridden to
  one native bridge schema, and source/installed requests exposing no other
  model tool.
- Clean-package projection fixture with executable inline/reordered future
  plugins: default-off must actually load the poison, while benchmark opt-in
  must record zero loads and still reach the bridge.
- Missing/duplicate `gotry-tools`, missing/duplicate injection anchors, and a
  pre-existing config-path field must all stop before relay activity.
- Conformance cases: prose/no-call correction, one real native call followed
  by tagged JSON, one format-only retry, retry exhaustion, and parent stdout
  suppression; paired reasoning-block normalization; domain-only,
  domain-to-result, domain-to-failure, and stale-terminal ordering.
- Descriptor/result cases: flat `tools|errors|call` branches, the complete
  bridge failure inventory, schema max/max+1 boundaries, exact adapter
  envelopes, nonempty positive output keys, primitive/mixed arrays, and a
  declared miss followed by a model-authored revised call.
- Unit contracts: live-agent rejection, same-name identity shadows,
  final-assembly/pre-step schema drift, agent cleanup without double disposal,
  and plugin-unload quarantine.

None of this is ChinaTravel treatment evidence.

## Round ledger

All frozen treatments to date are diagnostic-only: official scores are null and
no uplift or external benchmark closure is claimed.

### Round 2 — first frozen treatment

Provider preflight and planner succeeded, but the runner returned 3 before
evaluation because the agent described an intended CLI/tool action without a
structured bridge call or parseable tagged JSON. Official scores null
([evidence](https://github.com/Danceiny/gotry/discussions/78#discussioncomment-18215707)).

### Round 3 — agent conformance

Added the provider-neutral conformance layer (prompt CLI/shell/Python
references mapped to the sole native bridge `query.action=call`; one fixed
correction; tagged-JSON terminal gate). The new frozen treatment stopped after
one runner spawn with planner/runner exit 1, zero released terminal bytes, no
evaluator entry, and null official scores
([evidence](https://github.com/Danceiny/gotry/discussions/78#discussioncomment-18232139)).

### Round 4 — startup composition isolation

The CLI projects the config-verified top-level insert to exactly one
`gotry-tools` item before any optional host plugin resolves; anchor/name
uniqueness fails closed before relay. The treatment at SHA `5ebddb2` had
primary preflight pass, but planner and runner both exited 1 after 30.968
seconds, released zero terminal bytes, never entered the evaluator, and
produced null official scores. The product Node gate was v24.20.0 while that
treatment used v26.3.0, so it is diagnostic-only. GitHub Node 22/24 §48
separately exposed a source default-off 30-second lifecycle hang.

### Round 5 — headless lifecycle containment + runtime resolution

Scope: remove the timer/keepalive preload; declare all 216 packages in the
root/package DSH `0.1.2-alpha.3` closure as exact direct dependencies; require
manifest, package lock, and root pnpm importer to expose the same 216-name
set; fail publish preverify on omissions, mixed versions, or ranges; resolve
the locked runtime before the legacy vendored fallback in a source checkout;
preserve source normal-mode state continuity under `ts/dsh-runtime/gotry-state/`
while benchmark opt-in and npm-package runs use the invocation directory;
reject a non-alpha.3 benchmark runtime before spawn; enforce Node 22.15+; add
a benchmark-only structured diagnostic pipe with allowlisted redacted reason
codes while stdout remains fail-closed.

The frozen treatment at code SHA `752e54c` stopped after 140.715 seconds with
`child_nonzero_exit`, zero terminal bytes, and null evaluator/official scores.
The lock-consistency successor does not rewrite that UID attribution.

### Round 6 — structured terminal diagnostics

Narrows the remaining `child_nonzero_exit` ambiguity without reading raw
stderr. Benchmark conformance observes only the final structured
`turn/end.reason` and maps allowlisted model codes or limited HTTP status
values to closed auth, capacity, server, transport, stream, request, and
generic runtime families; blocked, max-token, aborted, and interrupted are
also closed enums. A per-session arbiter writes at most once and retains a
more specific bridge/conformance failure over a later generic terminal error.
Transient model errors that recover before the final turn end emit no failure.
Free-form messages, paths, prompts, request IDs, and credentials are neither
inspected nor reflected. Diagnostics only: stdout, retry policy, prompts,
tools, evaluator behavior, and scoring are unchanged.

The frozen ChinaTravel treatment at code SHA `c61600b` used the
clean-installed tarball SHA-256
`8df65b69873034df282dfa126ab93171fa9f1d4177cf17c5f9c694e737ff1161`, UID
`phase2_familiar_20250321040138918100_00001`, and `deepseek-v4-flash`. It
stopped after 49.546 seconds with parent reason `child_runtime_error`, zero
terminal bytes, and null evaluator/official scores. Leakage and local
credential/endpoint scans were zero. A later documentation-only successor does
not rewrite the treatment attribution.

### Round 7 — minimal kernel

Benchmark opt-in is a minimal kernel at code SHA
`edb9392896625adbb48abae4a2ecf968dbfc0349`: tool budget, model override, one
native bridge, and isolation/conformance remain; product prompt variables,
process guards, consent hooks, and ordinary GoTry tools are not installed. The
default path is unchanged. The CLI projects a stable, task-agnostic persona
and accepts exactly one canonical root `insert` item and one canonical
`system-prompt` item; missing, duplicate, quoted, reordered, flow, or other
noncanonical root items fail closed.

The treatment used tarball SHA-256
`506f20f01966663cb30231df72e7163661402a61cf6d96691972c72cebb24e79`, UID
`e20241028160248698752` (`easy`), and `deepseek-v4-flash`. Preflight passed
without fallback; after 80.463 seconds the runner exited 1 and terminal output
was zero/invalid. The evaluator was not entered, official score was null, and
the case is not countable. The allowlisted reason was
`child_bridge_runner_failed`. The next optimization question is a generic
bridge-tool schema and a recoverable domain-error contract, without changing
provider routing or scoring.

### Round 8 — generic bridge actions and recovery inventory

The bridge query blob became one flat, typed control surface:
`action=tools|call|errors`, with `tool` and structured `arguments` on calls.
`action=errors` exposes the complete closed bridge protocol/infrastructure
failure inventory with stable
recovery guidance. This makes discovery, invocation, and recovery
provider-neutral without changing the owner-local executable boundary.

### Round 9 — benchmark governance budgets and terminal normalization

Round 9 pins an explicit model output ceiling through `LLM_MAX_TOKENS` and
allows each frozen benchmark run to set validated soft/hard budgets while
preserving the 60/120-second defaults. It also removes a paired reasoning block
before applying the otherwise unchanged strict terminal validator. The first
diagnostic treatment survived the full chain and exercised the ChinaTravel
tool surface, but did not yield an official, attributable benchmark score or
external closure.

### Round 10 — per-tool typed result contract hardening

Round 10 keeps the single flat Round 8 protocol and derives one exact `call`
schema per descriptor. The same closed/bounded `input_schema` is shown to the
model and applied before spawn; empty or mixed protocol objects fail closed.
Descriptors also require nonempty `output_keys` and finite exact
`domain_outcomes`.

Adapter stdout must be one exact `gotry_benchmark_tool_result_v1` envelope. A
concrete result is accepted only when every primitive leaf sits below a
declared output key. A declared domain outcome is an exit-zero transport
success that the model may use to revise arguments; the bridge never retries.
Nonzero exit, timeout, truncation, malformed JSON, and result/domain ambiguity
remain infrastructure or conformance failures. Tagged terminal output must be
newer than the latest bridge response, so an old terminal cannot hide a later
domain or infrastructure fact.

This round does not change provider routing, the scorer, the evaluator, or the
default product path. A frozen treatment and any score/uplift claim require
separate provenance-bound evidence.

### Round 10 treatment diagnosis and Round 11 — flat model-facing wire

The real `glm-5.3-flash` treatment on main `c843fae` diagnosed a provider/model
visibility failure for the top-level `oneOf` bridge schema: the treatment made
57 empty `{}` calls and produced no countable score. Round 11 therefore changes
only the model-facing bridge wire to one flat object with `action` enum
`tools|call|errors`, a descriptor-derived `tool` enum, and generic object
`arguments`. Execution-time validation remains exact against the selected
frozen descriptor `input_schema`. Provider routing, the scorer, evaluator,
default product path, external data/oracle/query/trajectory inputs, private
paths, and credentials are unchanged; no score or uplift is claimed.

### Round 12 — exact terminal schema projection (#215)

With the wire usable (Round 11), the frozen Round 11 treatment surfaced the
next bottleneck: GoTry only told the model "one JSON object", so the model
added root keys and wrote day rows as direct activities, and the official
scorer rejected the body 22 times by convention without running.

Round 12 closes the structural half (issue #215): the bridge config carries a
data-value-free closed `body_schema`; the same structure contract is projected
as one deterministic outline into the system prompt and the single terminal
correction; every accepted terminal body is fail-closed validated against it —
extra root keys, missing `day`/`activities`, wrong types, and nested extra
fields are rejected with no autofix. Config face bumped to v4; v3 and older
configs fail closed. Source tests + source/packaged E2E cover the legal
ChinaTravel-like hierarchy, the five Round 11 rejection classes, and the
single-source projection. The frozen rerun (same case, model, and budget;
only legal terminals reach the pinned official scorer) is the remaining
segment and has not run at this SHA; no treatment or uplift is claimed.
