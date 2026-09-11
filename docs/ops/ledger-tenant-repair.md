[English](ledger-tenant-repair.md) | [简体中文](ledger-tenant-repair.zh-CN.md)

# Ledger Tenant Repair (Owner Gate)

> Position: operating checklist for issue #254 manual repair of historical events misrecorded as `local`.
> Status: living
> Upstream: [`../architecture.md`](../architecture.md) §8.16 / §10.1 #254 boundary, [`../design/milestone-delivery-plan.md`](../design/milestone-delivery-plan.md) Q-2
> Downstream: `ts/src/ledger-repair-plan.ts`, `ts/src/ledger-repair-apply.ts`, `ts/scripts/state-cli.ts`
> Last updated: 2026-09-11
> Boundary: fixture-green engineering proofs are not a real repair receipt; do not open `ts/dsh-runtime/gotry-state/` from tests.

## Schemas

| Schema | Role |
|---|---|
| `gotry.ledger-repair-plan/1` | Dry-run plan (`repair-plan`) |
| `gotry.ledger-repair-backup/1` | Checksummed backup manifest under `<stateRoot>/.gotry-repair-backup/` |
| `gotry.ledger-repair-apply/1` | Apply result object |
| `gotry.ledger-repair-applied/1` | Idempotent applied stamp under `gotry-state/.gotry-repair-applied/` |
| `gotry.ledger-repair-receipt/1` | Desensitized receipt (`--receipt-out`); store real receipts privately |

Receipt fields include `planDigest`, `mappingSha256`, redacted path fingerprints, before/after census, affected seqs, `authorizedBy`, `gitHead` (optional), and `mode` (`applied` \| `already_applied`).

## Owner checklist (real data)

1. **Inventory**: `npx tsx scripts/state-cli.ts repair-plan <root> --format json` (read-only; never opens the live DB via SQLite — copies db/`-wal`/`-shm` first).
2. **Evidence mapping**: hand-author a JSON array of `{ seq, fromTenant, toTenant, evidence }`. Empty evidence is rejected. Without a mapping entry the event is retained in place — no guessing.
3. **Review dry-run**: re-run with `--mapping <file>`; confirm `applyable=true`, inspect every `move`, and record `plan-digest`.
4. **Written authorization**: founder (or delegated owner) explicitly authorizes apply on this root + digest. Agents must not invent authorization.
5. **Apply on an authorized root only**:  
   `repair-apply <root> --mapping <file> --plan-digest <hex> --i-authorize-apply [--receipt-out <private-path>]`  
   Prefer a verified copy first; founder ledger only with explicit go-ahead.
6. **Verify visibility**: target tenant `log`/`stats`/fold see moved subjects; `local` and other tenants do not cross-read them.
7. **Archive receipt**: keep the SHA-bound receipt **outside the public repo** (or a private path). Redacted fields must not reintroduce absolute paths.
8. **Backup retention**: keep `<stateRoot>/.gotry-repair-backup/<stamp>-<digest>/` until verification; restore with  
   `repair-rollback <root> --backup <dir> --i-authorize-rollback` if needed; discard only after owner confirmation.

## Closing #254

Engineering merge alone does **not** close the issue. Close when either:

- **A**: a founder-authorized real (or confirmed-copy) repair produced a private, SHA-bound receipt; or  
- **B**: founder confirms in writing that no real move is needed, attaching a `repair-plan` showing zero moves / retain-only for the relevant root.

## Hard non-goals

- Heuristic tenant inference; auto-scanning the founder ledger; M5 receipt/outbox; treating tenant scope as authentication.
