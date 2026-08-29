/** Package-owned invariant companion for the GitHub webhook adapter. */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis invariant-companion plugin name. */
export declare const name = "webhook-github-invariant";
/** Registry required before reserving this package's invariant ownership. */
export declare const inject: string[];
/**
 * Register this package's explained empty invariant.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the invariant registration disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map