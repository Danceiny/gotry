/** Package invariant companion for `@deepseek-ai/dsh-session-log-export`. */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "session-export-invariant";
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Host context carrying the invariant registry.
 * @returns the registration disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map