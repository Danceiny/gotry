/**
 * Perplexity-backed `WebSearchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-search-perplexity
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { PERPLEXITY_DEFAULT_BASE_URL, PERPLEXITY_DEFAULT_MAX_TOKENS, PERPLEXITY_DEFAULT_MODEL, PERPLEXITY_PROVIDER_ID, PerplexitySearchProvider, } from './provider.ts';
export type { PerplexityRecency, PerplexitySearchProviderOptions } from './provider.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "web-search-perplexity";
/** The web seam this provider registers into. */
export declare const inject: string[];
/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
    /** Perplexity API key. Falls back to `$PERPLEXITY_API_KEY`. Empty → unavailable. */
    apiKey?: string;
    /** Endpoint base; `/chat/completions` is appended. Defaults to the public API. */
    baseURL?: string;
    /** Search model name. Defaults to `sonar`. */
    model?: string;
    /** Upper bound on generated answer tokens. Defaults to 1024. */
    maxTokens?: number;
    /** Recency window sent as `search_recency_filter`. Omitted = no filter. */
    searchRecency?: 'day' | 'week' | 'month' | 'year';
}
export declare const Config: z<Config>;
/** Register the Perplexity search provider with `ctx.web`. */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map