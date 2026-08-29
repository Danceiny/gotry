/**
 * Generic stdio language-server backend for `ctx.lsp`. One plugin instance configures a named table
 * of server commands and registers one isolated provider for each entry. Every provider lazily
 * single-flights one server process per canonical workspace target, serves transient-open queries
 * through it, and replaces a selected transport that fails before or during the next read-only
 * query. Providers read sources through `ctx.fs` and launch servers through
 * `ctx.subprocess`, so both local and remote implementations share one host.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is effect-scoped: disposal
 * unregisters from `ctx.lsp` and tears down every live server.
 * @module @deepseek-ai/dsh-lsp-stdio
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { canonicalizeWorkspace, readHostSource } from './host.ts';
export { encodeMessage, MessageDecoder } from './framing.ts';
export { negotiatePositionEncoding, normalizeHover, normalizeLocations, requestMethod, supportsOperation, supportsTransientOpen, } from './translate.ts';
export { LspInstance } from './instance.ts';
export { LspConnection } from './connection.ts';
/** Cordis plugin name for loader diagnostics. */
export declare const name = "lsp-stdio";
/** Services required by this plugin. */
export declare const inject: string[];
/** One configured local language server and its host bounds. */
export interface LspLocalServerConfig {
    /** Executable to spawn (absolute, or resolved on PATH at load). */
    command: string;
    /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
    extensionToLanguage: Record<string, string>;
    /** Arguments passed to the executable (no shell). Default `[]`. */
    args?: string[];
    /** Extra env vars merged on top of the scrubbed ambient env. Default `{}`. */
    env?: Record<string, string>;
    /** Static `initialize` options forwarded to the server. Default `null`. */
    initializationOptions?: unknown;
    /** Static answer to every `workspace/configuration` item. Default `null`. */
    configuration?: unknown;
    /** Largest single framed message accepted from the server (bytes). Default 16000000. */
    maxMessageBytes?: number;
    /** Largest stderr tail retained for diagnostics (bytes). Default 1000000. */
    maxStderrBytes?: number;
    /** Largest source file this host will open (bytes). Default 4000000. */
    maxDocumentBytes?: number;
    /** Graceful `shutdown`/`exit` budget before escalation (ms). Default 5000. */
    shutdownTimeoutMs?: number;
    /** Request-cancel and SIGTERM→SIGKILL grace (ms). Default 2000. */
    killGraceMs?: number;
}
/** Plugin configuration: provider id → local language-server configuration. */
export interface Config {
    /** Non-empty table of stable provider ids to independent local server configurations. */
    servers: Record<string, LspLocalServerConfig>;
}
export declare const Config: z<Config>;
/**
 * Register the configured stdio LSP providers. Resolves every executable at load (after credential
 * scrubbing) before publishing any provider; each process launches lazily on its first matching
 * query.
 * @param ctx - the plugin context carrying `fs`, `lsp`, and `subprocess`.
 * @param config - the resolved plugin configuration (schemastery has filled every default).
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map