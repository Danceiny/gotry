/**
 * Pure formatting and coordinate conversion for the `lsp` tool: one-based↔zero-based UTF-16 cursor
 * conversion, workspace-grouped location rendering with `file:`-URI resolution, complete-result
 * capping, and UI presentation. No I/O — a UI may call the presenter on live streaming and on
 * replay, so it depends only on the tool arguments.
 * @module @deepseek-ai/dsh-tool-lsp/render
 */
import type { GenericCallView } from '@deepseek-ai/dsh-tools';
import type { LspHover, LspLocation, LspOperation, LspPosition } from '@deepseek-ai/dsh-lsp';
/** The four operations the tool exposes, as a runtime tuple for schema enum + validation. */
export declare const LSP_OPERATIONS: readonly LspOperation[];
/** Default cap on rendered locations before an omission marker is appended. */
export declare const DEFAULT_MAX_LOCATIONS = 100;
/** Default cap on the complete rendered tool result, including truncation metadata. */
export declare const DEFAULT_MAX_RESULT_CHARS = 16000;
/** Validated `lsp` arguments after coordinate checks. */
export interface LspToolInput {
    readonly operation: LspOperation;
    readonly filePath: string;
    /** Zero-based UTF-16 position converted from the one-based model coordinates. */
    readonly position: LspPosition;
}
/** The raw, schema-typed argument shape. */
export interface LspToolArgs {
    readonly operation: string;
    readonly file_path: string;
    readonly line: number;
    readonly character: number;
}
/**
 * Validate and convert model arguments: `operation` must be one of the four; `line`/`character` are
 * positive one-based integers converted to the seam's zero-based position.
 * @param args - the schema-validated raw arguments.
 * @returns the validated input with a zero-based position.
 * @throws Error when the operation is unknown or a coordinate is not a positive integer.
 */
export declare function parseLspArgs(args: LspToolArgs): LspToolInput;
/**
 * Render a locations result grouped by file, converting each zero-based location back to a one-based
 * `path:line:character` entry. A `file:` URI inside the workspace becomes a workspace-relative path;
 * outside it, a URI-derived absolute path; a non-`file:` URI is kept verbatim. Applies `maxLocations` and
 * appends an omission marker when it truncates by count, then applies the complete result cap.
 * @param locations - the seam's locations (possibly empty).
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @param maxLocations - the cap before truncation.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered text; a distinct no-result line when there are none.
 */
export declare function formatLocations(locations: readonly LspLocation[], workspaceUri: string, maxLocations: number, maxResultChars: number): string;
/**
 * Render a hover result, applying `maxResultChars` last and keeping its marker within the cap.
 * @param hover - the normalized hover, or `null` for no hover.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered hover text; a distinct no-result line for `null`.
 */
export declare function formatHover(hover: LspHover | null, maxResultChars: number): string;
/**
 * Resolve a location URI without applying the harness host's path rules. A valid `file:` URI becomes
 * workspace-relative when it is under the provider's canonical workspace URI, or a URI-derived
 * absolute path otherwise; malformed and non-`file:` URIs remain verbatim.
 * @param uri - the target URI from the seam.
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @returns the display path or the verbatim URI.
 */
export declare function renderUri(uri: string, workspaceUri: string): string;
/**
 * UI presentation for a pending `lsp` call. Uses a generic search card; the title carries the
 * operation and one-based cursor, and `locations` focuses the queried line. The shared location
 * shape has no character, so the title preserves the column.
 * @param args - the raw tool arguments.
 * @returns the generic call view.
 */
export declare function presentLspCall(args: LspToolArgs): GenericCallView;
//# sourceMappingURL=render.d.ts.map