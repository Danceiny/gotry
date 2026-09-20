[English](parallel-search-perf-report.md) | [简体中文](parallel-search-perf-report.zh-CN.md)

# Parallel Search Performance Report

> Role: measured evidence and remaining acceptance gaps for issue #519.
> Status: living — controlled installed-product target passed; full regression and review pending (2026-09-20).
> Upstream: [architecture](../architecture.md); [issue #519](https://github.com/Danceiny/gotry/issues/519).
> Downstream: the implementation reviewer and feature acceptance owner.

## Outcome and scope

The predeclared three-pair schedule reduced whole-task median time from **8316 ms to 3077 ms (63.0%)**, meeting the 50% target for the fixed four-query workload. Every run retained four ordered observations and exited normally. Partial failure, a dependent lookup and user cancellation also passed through the actual installed product.

The GoTry package, dsh host, registered tools, spawned provider processes and terminal exit are real. Model responses come from a scripted local SSE server; the provider is a local CLI fixture. HOME, DSH_HOME, working directory and temporary files are isolated. No live supplier, credential or founder state is used. This proves execution of a predetermined plan, not autonomous planning quality or a general 63% gain for online trips.

## Protocol and provenance

- Runtime source: `27bf7c4ec04dffe1e5834f97cd53e797ee3f338e`, exported with `git archive`, compiled, packed and installed in a fresh consumer. Tarball SHA-256: `a71afd02b3bbad64fb9fbe9f1003e413f5769f311f94d0d7f987b915e1057e97`.
- Baseline source: `7f5f86893899fdf083bf1b261bf54e07cebf16f8`, tree `8ad8593974d7cc64a0acd49ea3677b7e9afeab9b`.
- Node `v24.10.0`; package version `0.0.1-rc.24`; dsh, dsh-tools and dsh-agent-loop `0.1.5-rc.1`. These three dependency manifests match by SHA-256. The consumer inherits the baseline dependency lock; an initial unconstrained offline install failed on an uncached transitive package and was not used for measurement.
- Both builds receive the same four calls in one model step: hotel and destination-directory searches for Hangzhou and Nanjing, stay 2027-01-15 to 2027-01-17. Provider delay was fixed at 1500 ms per call before measurement.
- Primary metric: process launch through normal terminal exit, including startup. Secondary metric: provider span. Schedule fixed before execution: baseline/candidate repeated three times; no sample removed.
- A process-scoped `caffeinate -s` assertion prevented maintenance sleep during both builds' measurements. Thermal protection was unchanged.

## Performance results

| Pair | Baseline whole, ms | Candidate whole, ms | Baseline provider span, ms | Candidate provider span, ms |
|---|---|---|---|---|
| 1 | 8568 | 3064 | 6143 | 1504 |
| 2 | 7845 | 3077 | 6151 | 1503 |
| 3 | 8316 | 3773 | 6143 | 1503 |
| Median | 8316 | 3077 | 6143 | 1503 |

Baseline peak concurrency was 1; candidate peak was 4. All six runs preserved normalized observation equality, original source markers and result order. The sample size is three per build; no tail-latency or live-provider claim follows from it.

## Behavioral end-to-end checks

The [behavior harness](../../scripts/parallel-search-behavior-e2e.mjs) uses 300 ms provider delays for the first two correctness cases. These are not performance samples.

| Scenario | Assertions | Result |
|---|---|---|
| Four independent queries, one provider failure | Peak concurrency 4; successful hotel ID/name/price retained; two valid empty results remain misses; failed directory remains unavailable with its original error; observation order preserved | Passed; normal exit, 3004 ms |
| Directory lookup followed by a dependent hotel query | Query uses the city parsed from the actual directory observation; starts after that provider finishes; both observations retained, concurrency 1 | Passed; normal exit, 2262 ms |
| User cancels four active searches | Send SIGINT only to the installed product after all four providers are ready; verify all four provider PIDs and four descendant PIDs are gone before harness cleanup | Passed; cancellation exit in 542 ms |

The pure committed source also passed hbcli, Anything, process-cancellation and effect-interpreter regression suites plus TypeScript checking. The process tests cover pre-cancel zero dispatch, escaped descendants holding pipes, incomplete-cleanup errors and cancellation preceding a timeout. These local checks support the end-to-end evidence; they do not replace it. Unknown escaped descendants are not claimed as reaped.

## Preserved failures and limits

Earlier diagnostic candidates were uncommitted snapshots. Their initial whole-time median was 8356 ms against a historical 7980 ms baseline, which did not meet the target. A later paired schedule was interrupted by an 809-second thermal-protection sleep; its incomplete third baseline and missing final candidate remain recorded and cannot yield an accepted median.

The first behavioral run of the committed candidate returned the expected query output but did not exit before its timeout. Power logs show a 900-second Maintenance Sleep overlapping the run (05:09:32–05:24:32 UTC+04:00); total wall time was 910299 ms. Its failure receipt remains intact. The subsequent run used the process-scoped sleep assertion described above. Neither interrupted run is relabeled as passed.

## Reproduction and remaining work

Use separately installed tarballs, identical dependencies and a fresh output directory. The scripts preserve model requests, provider events, stdout, stderr and assertions.

```sh
caffeinate -s node scripts/parallel-search-perf-e2e.mjs /absolute/baseline/node_modules/.bin/gotry /new/baseline-output serial - 1
caffeinate -s node scripts/parallel-search-perf-e2e.mjs /absolute/candidate/node_modules/.bin/gotry /new/candidate-output parallel - 1
caffeinate -s node scripts/parallel-search-behavior-e2e.mjs /absolute/candidate/node_modules/.bin/gotry /new/behavior-output
```

Repeat the first two commands in the predeclared three-pair schedule and compare medians. Do not retry until a desired score appears or subtract startup. Full regression, independent review and merge readback remain required before issue closure. Cancellation defects are tracked in [#522](https://github.com/Danceiny/gotry/issues/522). No release or online supplier acceptance is claimed.
