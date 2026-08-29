import { Service } from "@deepseek-ai/cordis";
import { HarnessError } from "@deepseek-ai/dsh-llm";
//#region lib/types/brand.js
/**
* dsh-lsp's owned branded id: {@link LspProviderId}, the opaque identity a provider reserves on
* `ctx.lsp`. The `Branded<B>` primitive lives in `@deepseek-ai/dsh-brand`; keeping the type and its
* factory together here lets `index.ts` re-export both under one name.
* @module @deepseek-ai/dsh-lsp/brand
*/
/**
* Brand a string as an {@link LspProviderId}. No validation — the registry rejects an empty id at
* registration.
* @param id - the provider's stable identifier.
* @returns the same string, branded.
*/
function LspProviderId(id) {
	return id;
}
//#endregion
//#region lib/types/index.js
/**
* Service Definition for the LSP capability seam (`ctx.lsp`): a language-server provider registry and per-query,
* order-independent selection over normalized goToDefinition/findReferences/goToImplementation/
* hover queries.
*
* A provider reserves a branded id and an exclusive set of file extensions atomically:
* {@link Lsp.registerProvider} validates and conflict-checks everything before mutating, so an
* invalid or conflicting registration publishes nothing, and its disposer releases every
* reservation together. Selection routes a query by the file's final extension; it never depends on
* registration order. The seam exposes exactly the four operations and no JSON-RPC escape hatch.
* @module @deepseek-ai/dsh-lsp
*/
/**
* Structured LSP failure. Extends {@link HarnessError} with a stable `code`
* (`LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, `LSP_UNAVAILABLE`, `LSP_DISPOSED`,
* `LSP_UNSUPPORTED_OPERATION`, `LSP_MALFORMED_RESPONSE`, …) that callers route on instead of
* parsing `message`.
*/
var LspError = class extends HarnessError {};
/**
* Extract a file's final extension as a normalized, lowercase, leading-dot key (e.g. `Foo.TS` →
* `.ts`, `foo.d.ts` → `.ts`). Returns `''` for a name with no extension or a leading-dot dotfile
* (`.bashrc`), which no route ever matches. Splits on both `/` and `\` so a caller's path separator
* does not change the result.
* @param filePath - the source path to inspect.
* @returns the normalized extension, or `''` when there is none.
*/
function finalExtension(filePath) {
	const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot).toLowerCase();
}
/** A well-formed normalized extension: a dot followed by one or more non-dot, non-separator chars. */
const EXTENSION_PATTERN = /^\.[^./\\]+$/;
/**
* `ctx.lsp`. Holds the id reservations and the extension→route table; both are populated and cleared
* together per provider so a route always has a live provider.
*/
var Lsp = class extends Service {
	providerIds = /* @__PURE__ */ new Set();
	routes = /* @__PURE__ */ new Map();
	constructor(ctx) {
		super(ctx, "lsp");
	}
	registerProvider(provider) {
		const id = provider.id;
		if (id.trim() === "") throw new LspError("an LSP provider id must be a non-empty string", "LSP_INVALID_PROVIDER");
		if (this.providerIds.has(id)) throw new LspError(`an LSP provider with id "${id}" is already registered`, "LSP_CONFLICT");
		const entries = Object.entries(provider.extensionToLanguage);
		if (entries.length === 0) throw new LspError(`LSP provider "${id}" registers no file extensions`, "LSP_INVALID_PROVIDER");
		const pending = /* @__PURE__ */ new Map();
		for (const [rawExt, languageId] of entries) {
			const ext = normalizeExtension(rawExt);
			if (!EXTENSION_PATTERN.test(ext)) throw new LspError(`LSP provider "${id}" maps an invalid extension "${rawExt}"`, "LSP_INVALID_PROVIDER");
			if (languageId.trim() === "") throw new LspError(`LSP provider "${id}" maps extension "${ext}" to an empty language id`, "LSP_INVALID_PROVIDER");
			if (pending.has(ext)) throw new LspError(`LSP provider "${id}" maps extension "${ext}" more than once`, "LSP_INVALID_PROVIDER");
			pending.set(ext, {
				provider,
				languageId
			});
		}
		for (const ext of pending.keys()) if (this.routes.has(ext)) throw new LspError(`extension "${ext}" is already handled by another LSP provider`, "LSP_CONFLICT");
		const dispose = this.ctx.effect(function* () {
			this.providerIds.add(id);
			for (const [ext, route] of pending) this.routes.set(ext, route);
			yield () => {
				this.providerIds.delete(id);
				for (const ext of pending.keys()) this.routes.delete(ext);
			};
		}.bind(this), "lsp.registerProvider()");
		return () => void dispose();
	}
	async query(request, signal) {
		const route = this.routes.get(finalExtension(request.filePath));
		if (route === void 0) throw new LspError(`no LSP provider handles "${request.filePath}"`, "LSP_UNAVAILABLE");
		return route.provider.query({
			...request,
			languageId: route.languageId
		}, signal);
	}
};
/** Lowercase an extension and ensure it carries a leading dot; `EXTENSION_PATTERN` rejects the rest. */
function normalizeExtension(ext) {
	const lower = ext.toLowerCase();
	return lower.startsWith(".") ? lower : `.${lower}`;
}
//#endregion
export { Lsp, Lsp as default, LspError, LspProviderId, finalExtension };
