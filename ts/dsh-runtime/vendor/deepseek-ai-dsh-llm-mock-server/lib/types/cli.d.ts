/**
 * Dependency-free CLI parsing for the standalone mock LLM server.
 * @module @deepseek-ai/dsh-llm-mock-server/cli
 */
import type { MockLlmServerOptions } from './index.ts';
/** Listener lifecycle behavior understood only by the standalone CLI. */
export declare const CONNECTION_REFUSED_BEHAVIOR = "connection_refused";
/** Parsed CLI configuration, including a pre-listen unavailable interval. */
export interface MockLlmCliConfig {
    /** Server options after removing the lifecycle-only `connection_refused` entry. */
    readonly server: MockLlmServerOptions;
    /** Delay before binding the model port; an integer from zero through the Node timer maximum. */
    readonly listenDelayMs: number;
    /** Whether the original sequence requested a true pre-listen refusal phase. */
    readonly startsUnavailable: boolean;
}
/** Result of parsing `dsh-llm-mock-server` arguments. */
export type MockLlmCliParseResult = {
    readonly kind: 'help';
} | {
    readonly kind: 'run';
    readonly config: MockLlmCliConfig;
};
/** Command usage written for `--help` and invalid arguments. */
export declare const MOCK_LLM_CLI_USAGE = "Usage: dsh-llm-mock-server [options]\n\nRequired:\n  --sequence <a,b,...>       Ordered behaviors; connection_refused is allowed first\n\nListener:\n  --host <host>              Default 127.0.0.1\n  --port <port>              Default 8000; required and nonzero for connection_refused\n  --api-key <token>          Validate exact Bearer token when present\n  --listen-delay-ms <ms>     Unavailable interval (default 750 with connection_refused)\n  --repeat-last              Repeat the final request behavior after exhaustion\n  --seed <uint32>            Reproduce random selections\n  --random-weights <a=n,...> Relative weights for concrete behaviors\n\nResponse:\n  --success-text <text>\n  --partial-text <text>\n  --reasoning-text <text>\n  --chunk-size <count>\n  --chunk-delay-ms <ms>\n  --disconnect-delay-ms <ms>\n  --retry-after-ms <ms>\n  --request-id <id>\n  --tool-name <name>\n  --tool-arguments <json>\n\nOther:\n  --help\n";
/**
 * Parse standalone server arguments without starting a process or listener.
 * Tokenizing rides `node:util` `parseArgs` (strict, no positionals); numeric
 * coercion, bounds, and cross-option constraints remain manual below it.
 * @param argv - arguments after the executable name.
 * @returns help or validated run configuration.
 */
export declare function parseMockLlmCliArgs(argv: readonly string[]): MockLlmCliParseResult;
//# sourceMappingURL=cli.d.ts.map