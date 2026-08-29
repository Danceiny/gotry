/**
 * Pure protocol translation for the local host: what the server's capabilities allow, and how its
 * `Location`/`LocationLink`/`Hover` payloads normalize into the seam's closed result unions. No I/O
 * or process state — every function here is a pure transform, which the fake-stdio tests pin exactly.
 * @module @deepseek-ai/dsh-lsp-stdio/translate
 */
import type { LspHover, LspLocation, LspOperation } from '@deepseek-ai/dsh-lsp';
import type { WireServerCapabilities } from './protocol.ts';
/**
 * The `textDocument/*` request method for each LSP operation.
 * @param operation - the LSP operation to map.
 * @returns the LSP request method name.
 */
export declare function requestMethod(operation: LspOperation): string;
/**
 * Whether the server advertises the requested operation.
 * @param capabilities - the server's `initialize` capabilities.
 * @param operation - the LSP operation to check.
 * @returns true when the corresponding provider capability is present.
 */
export declare function supportsOperation(capabilities: WireServerCapabilities, operation: LspOperation): boolean;
/**
 * Whether a `textDocumentSync` value permits the transient `didOpen`/`didClose` this host relies on.
 * The legacy enum form implies open/close for `Full`/`Incremental`; the options form requires an
 * explicit `openClose: true`, because the protocol defaults an omitted `openClose` to false.
 * @param sync - the server's advertised `textDocumentSync` capability.
 * @returns true when transient open/close is supported.
 */
export declare function supportsTransientOpen(sync: WireServerCapabilities['textDocumentSync']): boolean;
/**
 * Normalize the negotiated position encoding. An omitted encoding defaults to `utf-16`; any value
 * other than `utf-16` is a protocol error this host does not support.
 * @param encoding - the server's advertised `positionEncoding`, if any.
 * @returns the string `'utf-16'`.
 * @throws Error for any non-`utf-16` encoding.
 */
export declare function negotiatePositionEncoding(encoding: string | undefined): 'utf-16';
/**
 * Normalize a navigation result (`Location`, `Location[]`, `LocationLink[]`, or `null`) to the seam's
 * locations. `Location` maps directly; `LocationLink` maps `targetUri` + `targetSelectionRange`.
 * @param payload - the raw `textDocument/definition|references|implementation` result.
 * @returns the normalized locations (empty for `null`/`[]`).
 * @throws Error when an element is neither a `Location` nor a `LocationLink`.
 */
export declare function normalizeLocations(payload: unknown): LspLocation[];
/**
 * Normalize a `Hover` (or `null`) to the seam's hover. `MarkupContent` uses its `value`; a string
 * `MarkedString` is verbatim; a language-tagged `MarkedString` becomes a fenced code block; an array
 * joins its rendered parts with one blank line. The model-facing tool owns the complete result cap.
 * @param payload - the raw `textDocument/hover` result.
 * @returns the normalized hover, or `null` when there is no content.
 * @throws Error when the payload is a non-null, non-object, or structurally invalid hover.
 */
export declare function normalizeHover(payload: unknown): LspHover | null;
//# sourceMappingURL=translate.d.ts.map