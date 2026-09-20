[English](parallel-search-perf-report.md) | [简体中文](parallel-search-perf-report.zh-CN.md)

# Parallel Search Performance Report

> Role: measured evidence and remaining acceptance gaps for issue #519.
> Status: living — performance target unproven (2026-09-20).
> Upstream: [architecture](../architecture.md); [issue #519](https://github.com/Danceiny/gotry/issues/519).
> Downstream: the implementation reviewer and feature acceptance owner.

## Evidence boundary

The installed GoTry package, dsh host, registered tools, spawned provider processes, and terminal exit are real. The model is a local scripted SSE server and the provider is a local CLI fixture returning valid empty results. HOME, DSH_HOME, working directory and temporary files are isolated. No live supplier, credential or founder state is used.

This verifies execution of a predetermined plan. It does not prove autonomous task decomposition, live-provider speed, result quality for populated results, or full feature acceptance. The measured candidate contains recorded, uncommitted Traex changes on top of `ce6a92abaf6e32c1b1501a54bde558284330c970`; it is a diagnostic snapshot, not final-commit acceptance.

## Protocol and provenance

- Node `v24.10.0`; GoTry package version `0.0.1-rc.24`; dsh, dsh-tools and dsh-agent-loop `0.1.5-rc.1`. The three host package manifests match between installs by SHA-256.
- Historical baseline source: `7f5f86893899fdf083bf1b261bf54e07cebf16f8`, tree `8ad8593974d7cc64a0acd49ea3677b7e9afeab9b`.
- Both builds receive the same four calls in one model step: hotel and destination-directory searches for Hangzhou and Nanjing, stay 2027-01-15 to 2027-01-17. Provider delay is fixed at 1500 ms per call before any measurement.
- Primary metric: process launch through normal terminal exit, including startup. Acceptance requires a median reduction of at least 50%, with all four ordered observations and source markers preserved. Provider-only time is secondary.
- Initial runs contain three samples per build. The follow-up schedule was fixed as baseline/candidate repeated three times. An interrupted schedule cannot yield an accepted median.
- Candidate tarball SHA-256: `6b88f27372815edd82183a0d4dc78ec47bb2edcddb4f19685902731db525e801`.
- Candidate registration source SHA-256: `999310600e5c5e7f960460f6d349daf1dd8f186d74a8dae5af9ae5f229389793`; process helper: `655853ea05683c703e9908d183b0d543b3c20f2efc84ec2fadbdd6a3b5daa4dd`.

## Results

| Run | Whole time, ms | Provider span, ms | Peak concurrent providers | Outcome |
|---|---|---|---|---|
| Historical baseline, three samples | 8569 / 7980 / 7778 | 6132 / 6116 / 6128 | 1 / 1 / 1 | Four observations, normal exits |
| Initial candidate, three samples | 21735 / 7027 / 8356 | 1515 / 1523 / 1537 | 4 / 4 / 4 | Four observations, normal exits |
| Paired baseline 1 / candidate 1 | 8625 / 8087 | 6093 / 1512 | 1 / 4 | Exact ordered observation equality after timestamp normalization |
| Paired baseline 2 / candidate 2 | 12682 / 7945 | 6425 / 1504 | 1 / 4 | Exact ordered observation equality after timestamp normalization |
| Paired baseline 3 | 817233, timed out | Incomplete | 1 observed | Environment interrupted; final candidate sample not run |

The initial candidate median is 8356 ms versus the historical 7980 ms: **the 50% whole-task target was not met**. Concurrent execution is demonstrated, but faster provider calls alone do not satisfy the issue. Historical and current samples were measured at different times, so this is not evidence of a causal product slowdown either.

The power log records a thermal-protection sleep at 03:25:50 UTC+04:00, lasting 809 seconds, during the third paired baseline. Its tool results contain an unavailable source and turn-deadline failures. That run remains in the evidence; no passing paired median is reported. Further load testing was deferred pending a stable host.

## Behavioral end-to-end checks

The same frozen installed candidate also passed [the behavior harness](../../scripts/parallel-search-behavior-e2e.mjs), using a 300 ms provider delay per call. These are correctness scenarios, not additional performance samples.

| Scenario | Assertions | Result |
|---|---|---|
| Four independent queries, one provider failure | Peak concurrency 4; the successful hotel retains its ID, name and price; two valid empty results remain misses; the failed directory remains unavailable with its original source error; observation order preserved | Passed; normal exit, 3152 ms |
| Directory lookup followed by a dependent hotel query | The hotel query uses the city parsed from the actual directory observation; it starts after that provider finishes; both observations retained, concurrency 1 | Passed; normal exit, 2389 ms |

Both cases use isolated state and the real installed host. They do not prove a model can invent the plan autonomously, cancellation cleanup, or final-commit acceptance. Raw model requests, provider events, outputs and assertions remain in the local test receipts. Final committed code still needs the same scenarios rerun.

## Reproduction and remaining work

Use [the installed-product harness](../../scripts/parallel-search-perf-e2e.mjs) against separately installed baseline and candidate tarballs with identical dependencies. Use a fresh output directory each time. It preserves receipts, provider events, model requests, stdout and stderr; checks all four ordered source observations; and records wall and monotonic times.

```sh
node scripts/parallel-search-perf-e2e.mjs /absolute/baseline/node_modules/.bin/gotry /new/baseline-output serial
node scripts/parallel-search-perf-e2e.mjs /absolute/candidate/node_modules/.bin/gotry /new/candidate-output parallel 7980
```

Do not retry until a desired score appears or subtract startup from the primary metric. First freeze the final committed implementation, diagnose startup overhead on a stable host, then run a predeclared paired schedule and retain every result. Feature acceptance also requires dependent searches, partial failure, cancellation/process cleanup, populated-result quality, full regression, and review/merge evidence. Issue #519 remains open.
