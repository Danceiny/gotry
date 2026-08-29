/**
 * Perplexity search over its OpenAI-compatible chat-completions endpoint. The generated answer
 * becomes `content`; sources prefer structured `search_results[]` and fall back to URL-only
 * `citations[]`. The wire format and native `fetch` client are provider-private and do not use
 * `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-perplexity/provider
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import type { PerplexityResponse, PerplexitySearchResult } from './types.ts';
/** Stable id this provider registers under. */
export declare const PERPLEXITY_PROVIDER_ID = "perplexity";
/** Default Perplexity endpoint; `/chat/completions` is the operation. */
export declare const PERPLEXITY_DEFAULT_BASE_URL = "https://api.perplexity.ai";
/** Default search model. */
export declare const PERPLEXITY_DEFAULT_MODEL = "sonar";
/** Default upper bound on generated answer tokens. */
export declare const PERPLEXITY_DEFAULT_MAX_TOKENS = 1024;
/** Recency filter values Perplexity accepts for `search_recency_filter`. */
export type PerplexityRecency = 'day' | 'week' | 'month' | 'year';
/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface PerplexitySearchProviderOptions {
    /** Perplexity API key. Empty/absent makes the provider unavailable. */
    apiKey: string;
    /** Endpoint base; `/chat/completions` is appended. */
    baseURL: string;
    /** Search model name. */
    model: string;
    /** Upper bound on generated answer tokens (`max_tokens`). */
    maxTokens: number;
    /** Optional recency window sent as `search_recency_filter`; omitted = no filter. */
    searchRecency?: PerplexityRecency;
}
/**
 * Map one structured Perplexity search result to a normalized source.
 *
 * @param result - one entry of the response's `search_results[]`.
 * @returns the normalized source; blank fields are omitted rather than set empty.
 */
export declare function mapPerplexityResult(result: PerplexitySearchResult): WebSearchSource;
/**
 * Map a Perplexity response envelope to a normalized search result. Prefers
 * structured `search_results[]`; falls back to URL-only `citations[]` (those
 * sources carry just a `url`) only when `search_results` is absent.
 *
 * @param response - the parsed chat-completions response body.
 * @returns the normalized result; `content` is omitted when the answer is empty.
 */
export declare function mapPerplexityResponse(response: PerplexityResponse): WebSearchResult;
/** The Perplexity-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export declare class PerplexitySearchProvider implements WebSearchProvider {
    private readonly options;
    readonly id = "perplexity";
    constructor(options: PerplexitySearchProviderOptions);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
//# sourceMappingURL=provider.d.ts.map