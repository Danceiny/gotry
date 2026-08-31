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

Example (placeholder paths only):

```json
{
  "schema_version": "gotry_benchmark_environment_bridge_v1",
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
allowlist. The optional `allowed_output_keys` mapping is a bounded per-tool
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
an isolated `DSH_HOME` and cwd, and a synthetic key only. By default it
exercises the source checkout. When `GOTRY_BRIDGE_E2E_BIN` is set, it instead
exercises that clean installed-package CLI; CI uses this route because the
historical root npm lock is not the publish consumer dependency closure. It
verifies default-off behavior, environment isolation, private config
rejection, real output truncation, and a real deadline. It is not ChinaTravel
treatment evidence. Round 1's exact DeepSeek frozen case produced an
environment-unavailable, schema-invalid result (score 0); the separate GLM run
hit the 300 s planner timeout. Round 2's synthetic checks are evidence for the
seam only. The frozen ChinaTravel treatment has not run, so no score uplift or
external benchmark closure is claimed.
