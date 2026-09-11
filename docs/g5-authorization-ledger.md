# G5 Authorization Ledger

> 定位/Role: sole authorization surface for bridging the G5 internal travel system (the T system) into GoTry; read mechanically by `ts/scripts/g5-guard.ts`
> 状态/Status: living
> 上游/Upstream: [gotry-master-outline.md](gotry-master-outline.md) G5 gate + reuse matrix §2; [issue #348](https://github.com/Danceiny/gotry/issues/348)
> 下游/Downstream: `ts/scripts/g5-guard.ts` (fails closed while no grant covers a reference); founder

## 1. What this ledger is

- The G5 gate (internal travel tool bridge, T-system side, masked) is **closed**. Until a grant below covers it, any reference that wires the G5 lane into code, config, or docs fails the mechanical guard (`npx tsx scripts/g5-guard.ts`, run-all §58).
- **Only the founder maintains entries here.** Agents must never add a grant to unblock themselves; a self-service authorization channel does not exist. Mechanical boundary: the guard proves "no grant → no bridge"; the authorship of a grant is git-reviewable, not machine-provable.
- Generalized "internal assets are available" is not a grant. Per the #348 acceptance, an entry names the concrete system, business purpose, calling subject, allowed methods/fields, tenant/identity scope, retention and revocation.

## 2. Entry format

One line per authorization; the path scope is a glob (`*` within one segment, `**` across segments):

```
- GRANT: <path-glob> — system/purpose/scope one-liner — issue/decision: #<n> or URL
```

A grant line without an `issue/decision` link is rejected by the guard (fails closed).

## 3. Entries

(empty — no internal-travel bridge authorization has been granted; the current product path is the public MIT `hotelbyte-cli` process bridge, and the internal lane stays reference-only)
