# External benchmark environment bridge

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
successful tool result before it can stop.

The owner-local config also declares a generic tagged-JSON terminal envelope.
The tag is a bounded identifier and `max_bytes` is capped at 1 MiB. A valid
terminal response is exactly one matching tag pair whose body is one JSON
object; prose, code fences, duplicate tags, arrays, primitives, trailing text,
and oversized bodies fail closed. This is syntax conformance only: the
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
  "tools": [{
    "name": "lookup",
    "description": "Lookup a city.",
    "input_schema": {
      "type": "object",
      "properties": { "city": { "type": "string", "enum": ["Dubai", "Singapore"] } },
      "required": ["city"],
      "additionalProperties": false
    },
    "output_keys": ["city", "country"],
    "domain_outcomes": [{ "status": "miss", "code": "NOT_FOUND", "recovery": "revise_arguments" }]
  }],
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
commands are not exposed. In v3, `tools` is the single source for the model
schema, discovery response, pre-spawn input validation, output-key allowlist,
and declared `domain_outcomes`. Each input schema is bounded, object-rooted,
closed (`required` plus `additionalProperties:false`), and uses only the
supported typed subset. `output_keys` is required. `terminal_output` remains
required and capped at 1 MiB.

An adapter must return exactly one v1 envelope: `{schema_version,status:"ok",result}`
or `{schema_version,status:"miss"|"error",code,recovery}`. The tuple must be
declared by that tool. A domain miss/error is an outer successful tool result;
the model may choose to revise arguments and issue another call, but the bridge
never retries automatically. Non-zero exit, spawn, timeout, truncation, and
protocol failures remain infrastructure failures (`runner_failed` or their
specific structured failure); a domain-looking JSON body on a non-zero exit
does not change that classification.
Timeout and output caps are enforced by the subprocess seam, with
non-zero exit, timeout, truncation, invalid JSON, and disallowed tool returning
a structured failure envelope. The subprocess receives only selected
`PATH`/locale/time-zone values plus Python no-user-site/no-bytecode guards;
all other ambient environment names are explicitly removed. Model arguments
are serialized once and rejected before spawn when their UTF-8 size, depth, or
structure count exceeds the bridge limits.

Runner output must be one bounded JSON object. The bridge recursively rejects
ASCII keys associated with gold, oracle, expected answer, reference, label,
score, reward, ground truth, hidden query, or loader metadata, without
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
consumer dependency closure. It
verifies default-off behavior, environment isolation, private config
rejection, real output truncation, a real deadline, global `both` mode being
overridden to one native bridge schema, and source/installed requests exposing
no other model tool. A clean-package projection fixture adds executable
inline/reordered future plugins: default-off must actually load the poison,
while benchmark opt-in must record zero loads and still reach the bridge.
Missing/duplicate `gotry-tools`, missing/duplicate injection anchors, and a
pre-existing config-path field must all stop before relay activity. Conformance cases additionally cover prose/no-call
correction, one real native call followed by tagged JSON, one format-only
retry, retry exhaustion, and parent stdout suppression. Unit contracts
additionally cover live-agent rejection,
same-name identity shadows, final-assembly/pre-step schema drift, agent
cleanup without double disposal, and plugin-unload quarantine. It is not ChinaTravel
treatment evidence. Round 2 executed one frozen, diagnostic-only treatment:
the provider preflight and planner succeeded, but the runner returned 3 before
evaluation because the agent described an intended CLI/tool action without a
structured bridge call or parseable tagged JSON. Official scores therefore
remain null ([Round 2 evidence](https://github.com/Danceiny/gotry/discussions/78#discussioncomment-18215707)). Round 3 addressed that general prompt/tool/output conformance gap, but its new
frozen treatment stopped after one runner spawn with planner/runner exit 1,
zero released terminal bytes, no evaluator entry, and null official scores
([Round 3 evidence](https://github.com/Danceiny/gotry/discussions/78#discussioncomment-18232139)).
Round 4's treatment at SHA `5ebddb2` had primary preflight pass, but the
planner and runner both exited 1 after 30.968 seconds, released zero terminal
bytes, never entered the evaluator, and produced null official scores. The
product Node gate was v24.20.0 while that treatment used v26.3.0, so it is
diagnostic-only and has no uplift claim. GitHub Node 22/24 §48 separately
exposed a source default-off 30-second lifecycle hang. Round 5 is limited to
removing the timer/keepalive preload; declaring all 216 packages in the
root/package DSH `0.1.2-alpha.3` closure as exact direct dependencies;
requiring the manifest, package lock, and root pnpm importer to expose the same
216-name set; failing publish preverify on omissions, mixed versions, or ranges; resolving
that locked runtime before the legacy vendored fallback in
a source checkout; preserving source normal-mode state continuity under
`ts/dsh-runtime/gotry-state/` while benchmark opt-in and npm-package runs use
the invocation directory for isolation; rejecting a non-alpha.3 benchmark
runtime before spawn; enforcing Node 22.15+; and adding a benchmark-only
structured diagnostic pipe with allowlisted redacted reason codes while stdout
remains fail-closed. The frozen treatment at code SHA `752e54c` stopped after
140.715 seconds with `child_nonzero_exit`, zero terminal bytes, and null
evaluator/official scores, so it remains diagnostic-only. The lock-consistency
successor does not rewrite that UID attribution.
Round 6 narrows the remaining `child_nonzero_exit` ambiguity without reading
raw stderr. Benchmark conformance observes only the final structured
`turn/end.reason` and maps allowlisted model codes or limited HTTP status values
to closed auth, capacity, server, transport, stream, request, and generic
runtime families; blocked, max-token, aborted, and interrupted are also closed
enums. A per-session arbiter writes at most once and retains a more specific
bridge/conformance failure over a later generic terminal error. Transient model
errors that recover before the final turn end emit no failure. Free-form
messages, paths, prompts, request IDs, and credentials are neither inspected
nor reflected. This changes diagnostics only: stdout, retry policy, prompts,
tools, evaluator behavior, and scoring remain unchanged. The frozen ChinaTravel
treatment at code SHA `c61600b` used the clean-installed tarball SHA-256
`8df65b69873034df282dfa126ab93171fa9f1d4177cf17c5f9c694e737ff1161`,
UID `phase2_familiar_20250321040138918100_00001`, and
`deepseek-v4-flash`. It stopped after 49.546 seconds with parent reason
`child_runtime_error`, zero terminal bytes, and null evaluator/official scores.
Leakage and local credential/endpoint scans were zero. This is diagnostic-only
evidence and creates no benchmark or uplift claim; a later documentation-only
successor does not rewrite the treatment attribution.
No external benchmark closure is claimed.

Round 7 changes the benchmark opt-in to a minimal kernel at code SHA
`edb9392896625adbb48abae4a2ecf968dbfc0349`: tool budget, model override, one
native bridge, and isolation/conformance remain; product prompt variables,
process guards, consent hooks, and ordinary GoTry tools are not installed.
The default path is unchanged. The CLI projects a stable, task-agnostic
persona and accepts exactly one canonical root `insert` item and one canonical
`system-prompt` item; missing, duplicate, quoted, reordered, flow, or other
noncanonical root items fail closed. The treatment used tarball SHA-256
`506f20f01966663cb30231df72e7163661402a61cf6d96691972c72cebb24e79`, UID
`e20241028160248698752` (`easy`), and `deepseek-v4-flash`. Preflight passed
without fallback; after 80.463 seconds the runner exited 1 and terminal output
was zero/invalid. The evaluator was not entered, official score was null, and
the case is not countable. The allowlisted reason was
`child_bridge_runner_failed`. No uplift or external benchmark closure is
claimed. The next optimization question is a generic bridge-tool schema and a
recoverable domain-error contract, without changing provider routing or
scoring.

Round 8 replaces that open question with the v3 typed descriptor and exact
result-envelope contract described above. Offline unit coverage proves the
closed schema subset, max/max+1 resource bounds, deep freeze, pre-spawn
required/type/additional-property rejection, exact declared domain tuples, and
nonzero-exit precedence. The loopback source E2E captures the native provider
payload, then drives a declared miss, a model-authored argument revision, a
second adapter invocation, and a tagged terminal; the bridge performs no
automatic retry. This is contract evidence only. A frozen treatment has not
run, no official score exists, and provider routing, scorer, evaluator, and
default product mode are unchanged. No uplift or external benchmark closure is
claimed.
