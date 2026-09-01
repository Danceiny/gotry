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
  "schema_version": "gotry_benchmark_environment_bridge_v2",
  "enabled": true,
  "executable": "/OWNER-LOCAL/bin/node",
  "cwd": "/OWNER-LOCAL/harness",
  "argv_prefix": ["/OWNER-LOCAL/harness/runner.js"],
  "allowed_tools": ["lookup"],
  "allowed_output_keys": {
    "lookup": ["city", "country"]
  },
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
commands are not exposed. `allowed_tools` is a bounded, unique identifier
allowlist. `terminal_output` is required: its identifier-like `tag` defines the
only accepted envelope and its positive `max_bytes` is capped at 1 MiB. The
required terminal contract makes this schema v2; a v1 owner-local file must be
updated explicitly rather than being accepted with ambiguous terminal behavior. The
optional `allowed_output_keys` mapping is a bounded per-tool
positive allowlist: each mapped tool must be in `allowed_tools`, and each
nonempty list must contain unique ASCII identifier-like JSON key names. When
configured for a call, every object key in the visible result (recursing
through arrays and nested objects) must be listed; unknown keys fail closed as
`{"ok":false,"error":"forbidden_output"}` without reflecting their names or
values. Configurations omitting this field remain backward-compatible. The
mapping may be partial: allowed tools without a mapping retain the
recursive denylist only. Benchmark admission should map every allowed tool when
the stronger positive contract is required.
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
Round 4 addresses the newly isolated startup-composition failure. No score
uplift or external benchmark closure is claimed until a new frozen treatment
reaches the official evaluator.
