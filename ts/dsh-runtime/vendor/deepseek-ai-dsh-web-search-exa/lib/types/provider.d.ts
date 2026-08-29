/**
 * `ExaSearchProvider`: a `WebSearchProvider` backed by the Exa search API (`POST /search` with
 * highlight contents). It maps the first non-blank highlight to `snippet`, maps
 * `publishedDate` to `publishedAt`, drops entries without a snippet, and omits `content`
 * because Exa returns no generated answer.
 * @module @deepseek-ai/dsh-web-search-exa/provider
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import type { ExaResult, ExaSearchResponse } from './types.ts';
/** Stable id this provider registers under. */
export declare const EXA_PROVIDER_ID = "exa";
/** Default Exa search endpoint; `/search` is the operation. */
export declare const EXA_DEFAULT_BASE_URL = "https://api.exa.ai";
/** Default retrieval mode: let Exa pick between keyword and neural search. */
export declare const EXA_DEFAULT_SEARCH_TYPE = "auto";
/** Default number of highlight sentences requested per result. */
export declare const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1;
/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface ExaSearchProviderOptions {
    /** Exa API key. Empty/absent makes the provider unavailable. */
    apiKey: string;
    /** Endpoint base; `/search` is appended. */
    baseURL: string;
    /** Retrieval mode sent as Exa's `type`. */
    searchType: 'auto' | 'keyword' | 'neural';
    /** Default result count when a request carries no `maxResults`. */
    numResults?: number;
    /** Highlight sentences requested per result (Exa's `highlightsPerUrl`). */
    highlightsPerResult: number;
}
/**
 * Map one Exa result to a normalized source, or `undefined` when it carries no
 * portable snippet (an entry with no highlight is dropped — the seam has no
 * other field to derive a snippet from, and inventing one would lie).
 *
 * @param result - one entry of Exa's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank highlight.
 */
export declare function mapExaResult(result: ExaResult): WebSearchSource | undefined;
/**
 * Map an Exa response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; snippet-less entries are dropped
 *   ({@link mapExaResult}).
 */
export declare function mapExaResponse(response: ExaSearchResponse): WebSearchResult;
/** The Exa-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export declare class ExaSearchProvider implements WebSearchProvider {
    private readonly options;
    readonly id = "exa";
    constructor(options: ExaSearchProviderOptions);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
//# sourceMappingURL=provider.d.ts.map