/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent-report`.
 * @module @deepseek-ai/dsh-tool-subagent-report/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "tool-subagent-report-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - context carrying the invariant service.
 * @returns the registration disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map