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
import { Context, Service } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { LspProvider, LspQueryRequest, LspQueryResult, LspService } from './types.ts';
export { LspProviderId } from './brand.ts';
export type { LspHover, LspLocation, LspOperation, LspPosition, LspProvider, LspProviderQuery, LspQueryRequest, LspQueryResult, LspRange, LspService, } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        lsp: LspService;
    }
}
/**
 * Structured LSP failure. Extends {@link HarnessError} with a stable `code`
 * (`LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, `LSP_UNAVAILABLE`, `LSP_DISPOSED`,
 * `LSP_UNSUPPORTED_OPERATION`, `LSP_MALFORMED_RESPONSE`, …) that callers route on instead of
 * parsing `message`.
 */
export declare class LspError extends HarnessError {
}
/**
 * Extract a file's final extension as a normalized, lowercase, leading-dot key (e.g. `Foo.TS` →
 * `.ts`, `foo.d.ts` → `.ts`). Returns `''` for a name with no extension or a leading-dot dotfile
 * (`.bashrc`), which no route ever matches. Splits on both `/` and `\` so a caller's path separator
 * does not change the result.
 * @param filePath - the source path to inspect.
 * @returns the normalized extension, or `''` when there is none.
 */
export declare function finalExtension(filePath: string): string;
/**
 * `ctx.lsp`. Holds the id reservations and the extension→route table; both are populated and cleared
 * together per provider so a route always has a live provider.
 */
export declare class Lsp extends Service implements LspService {
    private readonly providerIds;
    private readonly routes;
    constructor(ctx: Context);
    registerProvider(provider: LspProvider): () => void;
    query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>;
}
export default Lsp;
//# sourceMappingURL=index.d.ts.map