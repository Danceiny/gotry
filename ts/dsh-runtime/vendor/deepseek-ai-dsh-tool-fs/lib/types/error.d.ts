/**
 * Model-facing remediation for guarded-mutation failures. The provider's
 * `FS_STALE_VERSION` and `FS_NOT_OBSERVED` messages state the condition but
 * not the only correct recovery (re-read / read the file), so this package
 * appends the remedy at the model boundary; provider messages stay
 * machine-oriented and unchanged.
 * @module @deepseek-ai/dsh-tool-fs/src/error
 */
/**
 * Append the correct recovery instruction to a guarded-mutation failure's
 * message. `FS_STALE_VERSION` (the file changed since this session's last
 * observation, including a missing target) recovers only by re-reading;
 * `FS_NOT_OBSERVED` (no prior read by this session) by reading. The `FsError`
 * code is preserved so retry/permission/UI layers keep routing on it, and the
 * original error chains as `cause`. Anything else passes through untouched.
 * @param error - the caught value from a write/edit execution.
 * @returns a remediated `FsError` for the two guarded-mutation codes, else the original value.
 */
export declare function remediateFsError(error: unknown): unknown;
//# sourceMappingURL=error.d.ts.map