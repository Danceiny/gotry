/** Shared remote-environment scrubbing for E2B process and terminal launchers. */
import type { Sandbox } from '@deepseek-ai/dsh-e2b';
/**
 * Read the remote environment through ASCII base64 so SDK callback chunking cannot corrupt UTF-8.
 * @param sandbox - shared E2B execution world.
 * @param signal - optional cancellation for the control-plane request.
 * @returns the complete NUL-delimited UTF-8 environment.
 */
export declare function readRemoteEnvironment(sandbox: Sandbox, signal?: AbortSignal): Promise<string>;
/**
 * Parse an E2B NUL-delimited environment while removing harness-private and credential-shaped names.
 * @param raw - The complete NUL-delimited remote environment.
 * @returns Mutable retained entries for the caller to overlay and serialize.
 */
export declare function scrubRemoteEnvironment(raw: string): Map<string, string>;
/**
 * Isolate E2B's fixed login-shell bootstrap from user profiles and ambient credentials.
 * @param raw - The complete NUL-delimited remote environment.
 * @returns Explicit E2B command or PTY overrides for bootstrap-shell startup.
 */
export declare function bootstrapEnvironment(raw: string): Record<string, string>;
/**
 * Overlay explicit entries and serialize one validated E2B environment.
 * @param raw - The complete NUL-delimited remote environment.
 * @param explicit - Deliberate caller overrides applied after ambient scrubbing; an `undefined` tombstone removes an ambient entry.
 * @returns NUL-delimited `name=value` entries accepted by `env -i`.
 */
export declare function serializeRemoteEnvironment(raw: string, explicit: Readonly<NodeJS.ProcessEnv> | undefined): string;
//# sourceMappingURL=environment.d.ts.map