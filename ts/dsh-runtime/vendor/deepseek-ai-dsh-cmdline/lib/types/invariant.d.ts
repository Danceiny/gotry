/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cmdline`.
 * @module @deepseek-ai/dsh-cmdline/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "cmdline-invariant";
/** Service required before the companion can register. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map