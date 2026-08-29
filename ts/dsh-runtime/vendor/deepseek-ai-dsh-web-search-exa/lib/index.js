import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
//#region lib/types/provider.js
/**
* `ExaSearchProvider`: a `WebSearchProvider` backed by the Exa search API (`POST /search` with
* highlight contents). It maps the first non-blank highlight to `snippet`, maps
* `publishedDate` to `publishedAt`, drops entries without a snippet, and omits `content`
* because Exa returns no generated answer.
* @module @deepseek-ai/dsh-web-search-exa/provider
*/
/** Stable id this provider registers under. */
const EXA_PROVIDER_ID = "exa";
/** Default Exa search endpoint; `/search` is the operation. */
const EXA_DEFAULT_BASE_URL = "https://api.exa.ai";
/** Default retrieval mode: let Exa pick between keyword and neural search. */
const EXA_DEFAULT_SEARCH_TYPE = "auto";
/** Default number of highlight sentences requested per result. */
const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "deepseek-harness/0.0.1";
/**
* Map one Exa result to a normalized source, or `undefined` when it carries no
* portable snippet (an entry with no highlight is dropped — the seam has no
* other field to derive a snippet from, and inventing one would lie).
*
* @param result - one entry of Exa's `results[]`.
* @returns the normalized source, or `undefined` when the entry has no
*   non-blank highlight.
*/
function mapExaResult(result) {
	const snippet = result.highlights?.find((highlight) => highlight.trim().length > 0);
	if (snippet === void 0) return void 0;
	return {
		url: result.url,
		...result.title != null && result.title.length > 0 ? { title: result.title } : {},
		snippet,
		...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {}
	};
}
/**
* Map an Exa response envelope to a normalized search result.
*
* @param response - the parsed `POST /search` response body.
* @returns the normalized result; snippet-less entries are dropped
*   ({@link mapExaResult}).
*/
function mapExaResponse(response) {
	return {
		sources: (response.results ?? []).map(mapExaResult).filter((source) => source !== void 0),
		truncated: false
	};
}
/** The Exa-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
var ExaSearchProvider = class {
	options;
	id = "exa";
	constructor(options) {
		this.options = options;
	}
	available() {
		return this.options.apiKey.length > 0 && isValidBaseUrl(this.options.baseURL) && isPositiveInteger(this.options.highlightsPerResult) && (this.options.numResults === void 0 || isPositiveInteger(this.options.numResults));
	}
	async search(request, signal) {
		const numResults = request.maxResults ?? this.options.numResults;
		let response;
		try {
			response = await fetch(`${this.options.baseURL}/search`, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${this.options.apiKey}`,
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify({
					query: request.query,
					type: this.options.searchType,
					contents: { highlights: { highlightsPerUrl: this.options.highlightsPerResult } },
					...numResults !== void 0 ? { numResults } : {}
				}),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (isAbortError(error)) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Exa search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Exa API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = parsed.error ?? parsed.message;
				if (detail !== void 0 && detail.length > 0) message = detail;
			} catch (error) {
				if (isAbortError(error)) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			return mapExaResponse(await response.json());
		} catch (error) {
			if (isAbortError(error)) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Exa returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
};
/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL) {
	return URL.canParse(baseURL);
}
/** True for a request limit that can be sent to Exa (a positive whole number). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
//#endregion
//#region lib/types/index.js
/**
* Exa-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
* registry without owning the service.
*
* @module @deepseek-ai/dsh-web-search-exa
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-exa";
/** The web seam this provider registers into. */
const inject = ["web"];
const Config = z.object({
	apiKey: z.string(),
	baseURL: z.string(),
	searchType: z.union([
		"auto",
		"keyword",
		"neural"
	]),
	numResults: z.number().step(1).min(1),
	highlightsPerResult: z.number().step(1).min(1)
});
/** Register the Exa search provider with `ctx.web`. */
function apply(ctx, config) {
	ctx.web.registerSearchProvider(new ExaSearchProvider({
		apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get("EXA_API_KEY")?.value ?? "",
		baseURL: config.baseURL ?? "https://api.exa.ai",
		searchType: config.searchType ?? "auto",
		highlightsPerResult: config.highlightsPerResult ?? 1,
		...config.numResults !== void 0 ? { numResults: config.numResults } : {}
	}));
}
//#endregion
export { Config, EXA_DEFAULT_BASE_URL, EXA_DEFAULT_HIGHLIGHTS_PER_RESULT, EXA_DEFAULT_SEARCH_TYPE, EXA_PROVIDER_ID, ExaSearchProvider, apply, inject, name };
