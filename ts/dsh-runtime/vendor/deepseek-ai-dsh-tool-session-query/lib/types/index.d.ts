/**
 * Model-facing, workspace-authorized session-history search and read tools.
 *
 * @module @deepseek-ai/dsh-tool-session-query
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by Loader diagnostics. */
export declare const name = "tool-session-query";
/** Capability services required by the model-facing consumer. */
export declare const inject: string[];
/** Default maximum number of authorized search hits returned by one call. */
export declare const DEFAULT_MAX_SEARCH_RESULTS = 100;
/** Default cooperative deadline for either full-text search tool. */
export declare const DEFAULT_SEARCH_TIMEOUT_MS = 30000;
/** Deployment-owned search count and timeout bounds. */
export interface Config {
    /** Maximum authorized hits returned by one search call. Defaults to 100. */
    maxSearchResults?: number;
    /** Cooperative full-text search deadline in milliseconds. Defaults to 30000. */
    searchTimeoutMs?: number;
}
/** Schemastery config for Loader defaults and generated configuration docs. */
export declare const Config: z<Config>;
/** Register all five tools and their shared model guidance. */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map