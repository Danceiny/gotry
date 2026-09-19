[English](sf-evidence-isolation-report.md) | [简体中文](sf-evidence-isolation-report.zh-CN.md)

# Session-flight evidence isolation test report

> Role: verify the benchmark command, evidence files, and summary readback for issue #503.
> Status: passed locally on 2026-09-19; live supplier acceptance remains open.
> Upstream: [data sources](../data-sources.md), [issue #503](https://github.com/Danceiny/gotry/issues/503).
> Downstream: benchmark maintainers and reviewers of the isolation change.

## Evidence boundary

This report covers a command-level end-to-end path: the real benchmark command writes query records and its batch summary; the real summary command reads those files and writes a rebuilt summary. Session responses are deterministic substitutes in a temporary source overlay, the FlyAI process is intercepted, and fetch attempts are trapped. No live supplier, login, inventory, fare, or real-session acceptance is established by this test. Those acceptance conditions remain in issue #272.

## Command contract

The benchmark accepts `--evidence-root PATH` and `--evidence-root=PATH`. Relative paths resolve from the caller's working directory, and paths containing spaces are preserved. Records and the batch summary use the same root and canonical run timestamp. The summary command must receive the same root.

Omitting the option retains `~/.gotry/evidence/session` for existing users. Automated tests pass an isolated root; the compatibility test instead confines HOME to a temporary directory. Missing, blank, duplicate, or unknown options fail before searches. A file used as the root, or a root below a file, fails before searches. `--help` and `-h` explain usage without searching or writing evidence.

## Validation record

Validated implementation: `1d30362cea07563cb337a64ff8702b0f1650f16c`; base: `20d728e3668d302821bad0f8687ca8ef55d29ed5`. The five code/test files retained identical SHA-256 digests throughout final validation. The report-only commit follows this implementation commit.

Environment: macOS 26.6.2, arm64; locked npm installs at both package roots; TypeScript 5.9.3 and tsx 4.23.13. Validation completed by 2026-09-19 09:15 UTC.

| Check | Observed result |
|---|---|
| Targeted CLI and command-to-files-to-summary E2E, Node 22.23.2 | 14 CLI cases and five batch scenarios passed. |
| Same targeted commands, Node 24.10.0 | All 19 cases passed. |
| TypeScript typecheck | Exit 0. |
| Full `scripts/run-all-tests.sh`, Node 24.16.0 selected by its runtime setup | Exit 0, `ALL SUITES GREEN`; includes the 19 cases and real Booking Copilot subprocess/plugin chain. |
| Pinned old benchmark with the same E2E harness | Expected exit 1 at the missing explicit-root summary directory. |
| Bilingual structure, readability, and whitespace | Passed; 64 document pairs and eight calibrated reader-facing files. |

Full-run log SHA-256: `d16eb3494a0375a54b92c5e7a3755183fa7e449315bc78635708ed0798086719`. The full entry no longer runs the historical Python oracle. Explicit skips: real HotelByte UAT, external STAICLI tarball proof (artifact not supplied), seven optional Agent Reach doctor assertions (not installed), and the real Lavish probe. Real supplier/session/login and real-LLM acceptance were not exercised. These exclusions remain outside this passing isolation conclusion.

## Scenario results

| Scenario | Expected and observed result |
|---|---|
| First query challenged | One record, one intercepted comparator attempt; benchmark exits 0 with `challenge_stop`; rebuilt summary exits 1 with `fail_closed`. |
| Second query challenged | Two records; no later query artifacts; the rebuilt summary preserves the incomplete batch. |
| Eighth query challenged | Eight records remain, but `batch_complete=false` and the rebuilt summary still fails closed. |
| Complete explicit-root batch | Eight query files, one raw summary, and successful rebuilt summary; all share one batch identity. |
| Default-root compatibility | Eight records under a temporary HOME, successful summary readback, and no explicit-root directory created. |
| CLI boundaries | 14 cases pass: two help forms, ten invalid argument cases, and two invalid filesystem targets. No query-start output or fetch attempt is observed. |

The four explicit-root scenarios use a root outside HOME with spaces in its name; the first also uses equals syntax with a relative path. Each query file is deeply compared with the corresponding raw summary record. Filenames, batch timestamp, selected batch ID, query IDs, and record counts are checked across both commands. All five temporary overlays are removed and cleanup is asserted.

The identical harness with the benchmark source from `20d728e3668d302821bad0f8687ca8ef55d29ed5` exits 1: the expected explicit-root summary directory is absent because that runner ignores the new flag. This negative control is expected; it is not a failure of the fixed implementation.

## Reproduction

Install locked dependencies at both the repository root and `ts/` with `npm ci --no-audit --no-fund --strict-peer-deps`. Then run:

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/sf-live-cli-tests.ts)
(cd ts && npx tsx scripts/sf-live-challenge-stop-tests.ts)
# Expected exit 1, requires the pinned historical commit to be available:
(cd ts && SF503_BASELINE=1 npx tsx scripts/sf-live-challenge-stop-tests.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 ./scripts/run-all-tests.sh
```

Both targeted commands are wired into the existing full-regression entry. The runner code is copied unchanged into a temporary overlay; only the session provider is replaced. Production pacing remains unchanged; an isolated child-process timer preload accelerates the test. No production test bypass is added.
