import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
//#region lib/types/provider.js
/**
* Perplexity search over its OpenAI-compatible chat-completions endpoint. The generated answer
* becomes `content`; sources prefer structured `search_results[]` and fall back to URL-only
* `citations[]`. The wire format and native `fetch` client are provider-private and do not use
* `ctx.llm`.
* @module @deepseek-ai/dsh-web-search-perplexity/provider
*/
/** Stable id this provider registers under. */
const PERPLEXITY_PROVIDER_ID = "perplexity";
/** Default Perplexity endpoint; `/chat/completions` is the operation. */
const PERPLEXITY_DEFAULT_BASE_URL = "https://api.perplexity.ai";
/** Default search model. */
const PERPLEXITY_DEFAULT_MODEL = "sonar";
/** Default upper bound on generated answer tokens. */
const PERPLEXITY_DEFAULT_MAX_TOKENS = 1024;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "deepseek-harness/0.0.1";
/**
* Map one structured Perplexity search result to a normalized source.
*
* @param result - one entry of the response's `search_results[]`.
* @returns the normalized source; blank fields are omitted rather than set empty.
*/
function mapPerplexityResult(result) {
	return {
		url: result.url,
		...result.title != null && result.title.length > 0 ? { title: result.title } : {},
		...result.snippet != null && result.snippet.length > 0 ? { snippet: result.snippet } : {},
		...result.date != null && result.date.length > 0 ? { publishedAt: result.date } : {}
	};
}
/**
* Map a Perplexity response envelope to a normalized search result. Prefers
* structured `search_results[]`; falls back to URL-only `citations[]` (those
* sources carry just a `url`) only when `search_results` is absent.
*
* @param response - the parsed chat-completions response body.
* @returns the normalized result; `content` is omitted when the answer is empty.
*/
function mapPerplexityResponse(response) {
	const content = response.choices?.[0]?.message?.content;
	const sources = response.search_results !== void 0 ? response.search_results.map(mapPerplexityResult) : (response.citations ?? []).map((url) => ({ url }));
	return {
		...content != null && content.length > 0 ? { content } : {},
		sources,
		truncated: false
	};
}
/** The Perplexity-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
var PerplexitySearchProvider = class {
	options;
	id = PERPLEXITY_PROVIDER_ID;
	constructor(options) {
		this.options = options;
	}
	available() {
		return this.options.apiKey.length > 0 && URL.canParse(this.options.baseURL) && isPositiveInteger(this.options.maxTokens);
	}
	async search(request, signal) {
		let response;
		try {
			response = await fetch(`${this.options.baseURL}/chat/completions`, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${this.options.apiKey}`,
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify({
					model: this.options.model,
					max_tokens: this.options.maxTokens,
					messages: [{
						role: "user",
						content: request.query
					}],
					...this.options.searchRecency !== void 0 ? { search_recency_filter: this.options.searchRecency } : {}
				}),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (isAbortError(error)) throw new WebError("Perplexity search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Perplexity search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Perplexity API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
				if (detail !== void 0 && detail.length > 0) message = detail;
			} catch (error) {
				if (isAbortError(error)) throw new WebError("Perplexity search aborted", "WEB_ABORTED", { cause: error });
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			return mapPerplexityResponse(await response.json());
		} catch (error) {
			if (isAbortError(error)) throw new WebError("Perplexity search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Perplexity returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
};
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
/** True for a request limit that can be sent to Perplexity (a positive whole number). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
//#endregion
//#region lib/types/index.js
/**
* Perplexity-backed `WebSearchProvider` plugin. It contributes to the
* `ctx.web` registry without owning the service.
*
* @module @deepseek-ai/dsh-web-search-perplexity
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-perplexity";
/** The web seam this provider registers into. */
const inject = ["web"];
const Config = z.object({
	apiKey: z.string(),
	baseURL: z.string(),
	model: z.string(),
	maxTokens: z.number().step(1).min(1),
	searchRecency: z.union([
		"day",
		"week",
		"month",
		"year"
	])
});
/** Register the Perplexity search provider with `ctx.web`. */
function apply(ctx, config) {
	ctx.web.registerSearchProvider(new PerplexitySearchProvider({
		apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get("PERPLEXITY_API_KEY")?.value ?? "",
		baseURL: config.baseURL ?? "https://api.perplexity.ai",
		model: config.model ?? "sonar",
		maxTokens: config.maxTokens ?? 1024,
		...config.searchRecency !== void 0 ? { searchRecency: config.searchRecency } : {}
	}));
}
//#endregion
export { Config, PERPLEXITY_DEFAULT_BASE_URL, PERPLEXITY_DEFAULT_MAX_TOKENS, PERPLEXITY_DEFAULT_MODEL, PERPLEXITY_PROVIDER_ID, PerplexitySearchProvider, apply, inject, name };
