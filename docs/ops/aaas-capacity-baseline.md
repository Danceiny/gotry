[English](aaas-capacity-baseline.md) | [简体中文](aaas-capacity-baseline.zh-CN.md)

# AaaS Capacity Baseline (Measured)

> Role: what one replica of the multi-tenant tier costs per open tenant, per takeover and per booted planner, measured with the real code, and which numbers still need a probe on a real node.
> Status: living
> Upstream: [AaaS RFC](../rfc/aaas-rfc.md) §3.4 switch trigger 4 and §4.8; [AaaS security design](../design/aaas-security-design.md) S-17.
> Downstream: the A3 capacity plan and failure drills; the per-replica `maxOpenTenants`, the global turn cap and the planner resource ceilings; whoever weighs the Postgres or MySQL fallback.
> Evidence boundary: a measurement on one development machine against a local directory standing in for the object store. It sizes the cost of the code and shows what grows with what. It is not a node capacity, a latency promise or A3 evidence.
> Last updated: 2026-10-30

## TL;DR

- An idle open tenant costs about **three file descriptors** and **a quarter of a MiB** of resident memory, and opens in about 9 ms, flat from 1 to 500 tenants. The first ceiling on a replica is the **descriptor limit**, not memory: at a soft limit of 1024 descriptors it is a few hundred tenants. `maxOpenTenants` turns that cliff into a typed refusal.
- Taking a tenant over from its durable copy is linear in the ledger: about **4 ms per MiB** to restore and **7 ms per MiB** to publish the final snapshot, on local disk. A 100 MiB ledger took 0.4 s to take over.
- A booted, idle planner process tree is about **200 MiB** and boots in 0.5 to 1 s. Concurrent turns, not tenants, are what use memory: eight turns at once is about 1.6 GiB, and up to twice that for the first second of each turn while the warm-up tree runs.
- Handing 500 open tenants back gracefully took **11 to 13 s** here (11 s one tenant at a time, 13 s with the router's eight at a time). A rolling deploy of a full replica takes at least that long.
- Nothing grew faster than linearly across the steps measured, so these numbers do not by themselves trigger the RFC's fallback to a shared database. They do not replace probing a real node (§4).

## 1. Method

`ts/scripts/tenant-capacity-probe.ts` builds real routers over isolated temporary state roots, with the SQLite lease store and a directory durable store, and reports:

- **Density.** Tenants are opened one after another in one process, at steps of 1, 10, 50, 100, 250 and 500. At each step it records resident memory, descriptors held and the time to open. After 500 it closes the router (a graceful handoff of every tenant) and records the time and the descriptors left.
- **Takeover.** One replica fills a tenant's ledger to a target size with random data and hands it off, which publishes the final snapshot. A second replica then opens the tenant: lease acquisition, restore from the newest verified copy, and the integrity checks. Each size is run three times and the median is reported. The restored row count must equal what was written.
- **Planner.** Real planner processes are booted with the production route settings (the chat-completions adapter) against an address nothing listens on, so no model call is made. After boot the probe waits 1.5 s and sums the resident memory and CPU time of every process below the probe, leaving out its own `ps`. Warm-up is off (`GOTRY_BOOKING_COPILOT_WARMUP=0`), so each port is one tree; the production default also starts a second, short-lived tree per port as a warmer and closes it once its own warm-up ends.

The run reported here: 2026-10-30, `v26.9.0`, `darwin/arm64`, Apple M4 Pro with 14 cores and 48 GiB, one run for density and the median of three for takeover.

## 2. Results

### 2.1 Tenants held open

| Tenants | Resident (MiB) | Over baseline (MiB) | Descriptors over baseline | Open, median / p95 (ms) |
|---:|---:|---:|---:|---:|
| 1 | 102.5 | 0.7 | 5 | 16.0 / 16.0 |
| 10 | 104.8 | 3.0 | 32 | 8.0 / 16.0 |
| 50 | 115.0 | 13.2 | 152 | 8.2 / 12.0 |
| 100 | 126.6 | 24.8 | 302 | 8.6 / 11.6 |
| 250 | 163.2 | 61.4 | 752 | 8.5 / 12.0 |
| 500 | 235.0 | 133.2 | 1,502 | 8.6 / 12.0 |

Per tenant that is 0.27 MiB and 3.0 descriptors (a database file, its write-ahead log and its shared-memory file). Closing all 500 gracefully took 11.3 s one tenant after another (23 ms each), and 13.2 s with the router's eight at a time on a busier machine. The work is building snapshots inside one process, so doing several at once is not faster; it limits what one tenant that cannot finish can hold back. Every tenant was flushed. Two descriptors remained above the starting baseline afterwards, so closing a tenant gives its handles back.

### 2.2 Taking a tenant over

| Ledger (MiB) | Publish the final snapshot (ms) | Restore on the new owner (ms) |
|---:|---:|---:|
| 1.1 | 31 | 24 |
| 10.1 | 86 | 48 |
| 50.5 | 374 | 179 |
| 100.8 | 713 | 397 |

The slope is about 3.8 ms per MiB to restore and 6.8 ms per MiB to publish. The directory store has no network, so a real object store adds the transfer of the ledger in both directions.

### 2.3 A booted planner

| Trees | Processes | Resident per tree (MiB) | CPU to boot, all trees (s) | Boot (ms) |
|---:|---:|---:|---:|---:|
| 1 | 3 | 216 | 0.53 | 506 |
| 4 | 9 | 204 | 2.53 | 523 |

A tree is the worker and what it starts: the dsh runtime below it and, here, also the TypeScript loader's helper, because the probe runs the worker from source (a built service has two processes). The default ceiling of 1.5 GiB per tree (`DEFAULT_TENANT_PLANNER_RESOURCE_LIMITS`) is about seven times an idle tree, and the 120 CPU-second ceiling is far above a boot. A turn that is running will use more than an idle tree; no model call was made here.

## 3. What the numbers say

This is arithmetic on the table above, not a forecast.

- **Descriptors set the first limit.** A process often starts with a soft limit of 1024. With 256 kept for sockets, logs and the planner pipes, that holds `(1024 − 256) / 3 = 256` tenants. At 65,536 descriptors the same arithmetic gives about 21,000. Raising the limit is a deployment setting; `maxOpenTenants` is what keeps a replica from reaching it, because past the limit every tenant and every socket on the replica fails together.
- **Memory for idle tenants is small.** 10,000 idle tenants would be about 2.6 GiB. Memory is used by turns: with about 200 MiB per booted planner, the global turn cap sets the planner memory of a replica (`globalConcurrentTurns × 200 MiB`, twice that during the first second of a turn).
- **A rolling deploy is not instant.** Draining a replica at 500 tenants is at least 11 s here (13 s with eight at a time), before any network, and up to `drainTimeoutMs` more for each tenant with a call that never returns. A deploy plan has to allow for the drain time of a full replica.
- **Takeover time is a ledger-size question.** A tenant that has not been busy takes over in tens of milliseconds. The turn that triggers a takeover waits for it.
- **The fallback trigger.** Trigger 4 of the RFC compares tenant count times per-file overhead with the replica budget. With the per-tenant cost above, the budget that binds first is descriptors, which is configuration. These numbers do not argue for the shared-database fallback.

## 4. What this does not show, and what is still a human probe

- **A real node.** Linux, the real filesystem and `fsync` cost, the real descriptor limit and the real memory limit of the intranet hosts. The facts F-2 (what each node holds today) and F-3 (conditional writes on the object store) of the RFC are still read-only probes for a person with access.
- **The network.** Takeover and snapshot time through the real object store, and replication lag under load.
- **Busy tenants.** The tenants here were idle after opening. Page caches and statements grow with use, so 0.27 MiB is a floor.
- **A turn in progress.** The planner figure is a booted tree that made no model call. A turn that is running, with a long prompt and a long response, will use more.
- **Variance.** Density is one run. Takeover is the median of three.
- **Values to set.** `maxOpenTenants`, the global turn cap and the planner ceilings have no production value yet. They are set from a probe of the real nodes in A3, together with a runaway-child drill.

## 5. Re-running

```bash
cd ts && npx tsx --expose-gc scripts/tenant-capacity-probe.ts --json /tmp/aaas-capacity.json
```

`--smoke` runs small numbers and asserts correctness only (everything opened, the handles came back, a restored ledger holds what was written, never a speed); it is part of the full regression as run-all §100. `--tenants`, `--sizes-mb` and `--no-planner` change what is measured. The probe uses temporary directories only and never touches a state root.
