/**
 * Model-facing `lsp` tool over `ctx.lsp`. One read-only tool with four operations
 * (`goToDefinition`/`findReferences`/`goToImplementation`/`hover`); it converts one-based UTF-16
 * cursor coordinates to the seam's zero-based positions, requires the session workspace with no
 * fallback, caps and renders results, and attaches a configurable timeout budget for
 * `dsh-tool-call-timeout-policy` to enforce. It runtime-injects only `tools`, `lsp`, and `systemPrompt` and
 * imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-lsp
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS, formatHover, formatLocations, LSP_OPERATIONS, parseLspArgs, presentLspCall, renderUri, } from './render.ts';
export { sessionCwd } from './session-cwd.ts';
/** Cordis plugin name for loader diagnostics. */
export declare const name = "tool-lsp";
/** Services required by this plugin. */
export declare const inject: string[];
/** Default tool-call timeout budget (ms), covering the queued open/query/close lifecycle. */
export declare const DEFAULT_LSP_TOOL_TIMEOUT_MS = 60000;
/** The stable system-prompt guidance positioning LSP as a precision aid. */
export declare const LSP_PROMPT_TEXT = "Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration.";
/** Plugin configuration: result caps and the timeout budget. */
export interface Config {
    /** Largest number of rendered locations before an omission marker (default 100). */
    maxLocations?: number;
    /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
    maxResultChars?: number;
    /** Tool-call timeout budget in ms (default 60000). */
    timeoutMs?: number;
}
export declare const Config: z<Config>;
/**
 * Register the `lsp` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `lsp`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map