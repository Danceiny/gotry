/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function SessionId(id) {
    return id;
}
/**
 * The on-disk session format version, stamped into every newly-written {@link SessionHeader}
 * and enforced by every persistence backend on load. The single source of truth for the
 * version — write sites and the load-time check all read it.
 * While the harness is unreleased it is pinned at `0`: no compatibility is
 * implied, incompatible logs are rejected, and no migration is provided.
 *
 * The version is a single monotonic integer with no major/minor split. Whether
 * a bump is needed is decided by what the WRITER emits, never by what a newer
 * reader can accept: bump exactly when an older runtime could no longer handle
 * a new log with full semantic correctness ("parses without error" is not
 * correctness — silently skipping content that shapes reconstruction is a
 * wrong read). Only structural changes reach that bar: the header shape, the
 * {@link SessionEvent} envelope, core event semantics, or the surface
 * mechanism (the {@link SurfaceEventType} set and {@link SurfaceOp} variants).
 * Adding an ordinary event type does not bump: the generated known-event guard
 * makes older runtimes refuse logs containing a type they do not understand.
 * When in doubt, bump: a near-identity upgrade step is almost free, a missed
 * bump makes older runtimes read new logs wrong silently. The full mechanism
 * (upgrade-step chain, in-memory view conversion, migrate-on-continue) is
 * recorded in the fail-closed-session-event-vocabulary Agent Note
 * (`.agents/notes/implemented/simplification/2026-08-25-fail-closed-session-event-vocabulary.md`).
 */
export const SESSION_FORMAT_VERSION = 0;
//# sourceMappingURL=types.js.map