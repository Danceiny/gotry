/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-fs-e2b`.
 * @module @deepseek-ai/dsh-fs-e2b/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "fs-e2b-invariant";
/** Service required before reserving package ownership. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map