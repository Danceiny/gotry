[English](memory-lifecycle-collector.md) | [简体中文](memory-lifecycle-collector.zh-CN.md)

# M4 Planning Lifecycle Collector

> Position: the usage contract for Issue #228's explicit opt-in collector, pseudonymizing first/revisit planning flows and external wait boundaries into candidate input that the #223 scorer can consume.
> Status: active
> Upstream: `memory-design.md` §7, GitHub #20/#223/#228.
> Discipline: writes only to an explicitly passed isolated `stateRoot`; does not read `ts/dsh-runtime/gotry-state/`, browser sessions, historical user profiles, or real credentials; this document records only the tool contract, not real cohort state.

## 1. Boundary

`ts/scripts/memory-lifecycle.ts` is a standalone CLI; the pure logic behind it lives in `ts/src/memory-lifecycle.ts`. It is not a resident service, does not auto-telemeter, and does not attach to product sessions. Every write operation must also provide:

- `--state-root <dir>`: an isolated state root; if the real path or any managed parent/leaf symlink points at a `.git` or `ts/dsh-runtime` shape, it fails closed.
- `--consent <statement>`: the operator's explicit consent statement; only an HMAC consent ref is persisted.
- `GOTRY_MEMORY_LIFECYCLE_HMAC_KEY`: a local key of at least 32 characters; the example generates a 64-digit hex locally (32 bytes of entropy), which only enters a shell variable — never persisted, never printed. After dataset creation, a domain-separated verifier is saved; changing the key makes read/write/export all refuse.

The CLI uses real system time and has no `--at`; test code needing time injection calls the pure-function interface.

## 2. Commands

```bash
STATE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gotry-m4-collector.XXXXXX")"
EXPORT_PATH="$STATE_ROOT/export.json"
CONSENT_STATEMENT='operator reviewed issue #228 scope'
export GOTRY_MEMORY_LIFECYCLE_HMAC_KEY="$(
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
)"

npx tsx ts/scripts/memory-lifecycle.ts init \
  --state-root "$STATE_ROOT" \
  --consent "$CONSENT_STATEMENT" \
  --source synthetic_fixture \
  --dataset m4-demo \
  --wait-code tool_latency \
  --wait-code user_pause

npx tsx ts/scripts/memory-lifecycle.ts start \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --subject 'local subject handle' --flow first-planning --eligible-planning

npx tsx ts/scripts/memory-lifecycle.ts wait-start \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --subject 'local subject handle' --flow first-planning --wait w1 --code tool_latency
npx tsx ts/scripts/memory-lifecycle.ts wait-end \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --subject 'local subject handle' --flow first-planning --wait w1

npx tsx ts/scripts/memory-lifecycle.ts complete \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --subject 'local subject handle' --flow first-planning

npx tsx ts/scripts/memory-lifecycle.ts start \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --subject 'local subject handle' --flow returning-planning --eligible-planning

npx tsx ts/scripts/memory-lifecycle.ts complete \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --subject 'local subject handle' --flow returning-planning

npx tsx ts/scripts/memory-lifecycle.ts record-reflux \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --experience er-hai-memory --kind recalled --evidence 'local evidence handle'

npx tsx ts/scripts/memory-lifecycle.ts record-preference \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --assertion slow-pace --evidence 'local evidence handle' --consumer ranking

npx tsx ts/scripts/memory-lifecycle.ts export \
  --state-root "$STATE_ROOT" --consent "$CONSENT_STATEMENT" \
  --out "$EXPORT_PATH"

npx tsx ts/scripts/memory-value-report.ts "$EXPORT_PATH"
```

The example above is a one-off `synthetic_fixture` demo: both `STATE_ROOT` and the HMAC key can be discarded with the temp root. A private `observed_private` dataset must be generated outside the repository, and the first-use 64-digit hex key must be persisted durably (e.g., a secrets manager or local secure storage); afterwards, for the same `stateRoot`, restore the same `GOTRY_MEMORY_LIFECYCLE_HMAC_KEY` first. Do not apply the generate-a-new-key-per-run pattern to an existing private dataset, or the manifest verifier will refuse read/write/export.

`observed_private` only means the input comes from private observation; the collector export still carries `source_review.state=candidate` and never generates `manual_attested`, `reviewer_ref`, or `attestation_ref`. M4 Exit still requires a real `observed_private` N≥5 repeat cohort plus a manual source review attestation contract.

## 3. Lifecycle Invariants

- After dataset init, `source_kind`, the wait code set, the consent ref, and the HMAC key verifier are frozen.
- Each subject records at most the first and the next eligible completed flow; a third eligible flow is refused.
- The same subject cannot have overlapping flows; a returning start must come after the first complete.
- Waits within the same flow cannot overlap or run out of order; wait codes must come from the set declared at init; flow complete must come after all ended waits.
- start/complete/wait/reflux/preference are all idempotent by HMAC event ref; duplicate submissions return `unchanged` and do not change event counts.

## 4. Persistence and Recovery

State lives in `<stateRoot>/gotry-state/memory-lifecycle/`:

- `manifest.json`: private 0600 JSON, published via a temp file + no-overwrite hard link; a failed write never leaves a half manifest that blocks retries.
- `events.jsonl`: append-only JSONL; while holding the writer lock, it first validates the full candidate projection; fd writes use a write-all loop — a short write or a 0-byte return must not be misreported as success; on failure it rolls back to the previously committed prefix.
- `.writer.lock`: only the lock created by this process is cleaned up; an existing competitor's lock returns `lock_busy`.
- The export output likewise publishes via a full temp file + no-overwrite; an existing target file is not overwritten, and on failure only this run's temp file is cleaned up.

Recovery handles only the provably uncommitted tail fragment: the committed prefix must stay byte-identical; a corrupted, newline-terminated event line is never silently swallowed.

## 5. Verification Entry Point

`GOTRY_SESSION_LIVE=0 ./scripts/run-all-tests.sh` §55 runs `ts/scripts/memory-lifecycle-tests.ts`, covering explicit opt-in, zero writes on illegal input, key/consent binding, out-of-order refusal, path isolation, short-write/ENOSPC fault injection, and the subprocess collect→export→#223 scorer chain.
