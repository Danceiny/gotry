/**
 * Shared ownership of one E2B sandbox. Capability adapters await the same SDK
 * handle, so filesystem and process operations inhabit one remote Linux world.
 * @module @deepseek-ai/dsh-e2b
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { Sandbox } from 'e2b';
export { CommandExitError, FileNotFoundError, FileType, Sandbox, SandboxNotFoundError, } from 'e2b';
export type { CommandHandle, CommandResult, EntryInfo } from 'e2b';
/**
 * Quote one opaque argument for the SDK's unavoidable `/bin/bash -l -c` layer.
 * @param value - Exact argument value to preserve.
 * @returns A single shell word with no interpolation.
 */
export declare function quoteE2BShellArg(value: string): string;
/**
 * Isolate E2B's hard-coded login shell behind a fresh randomized home path.
 * @param overrides - Additional environment entries for the internal command.
 * @returns A fresh mutable map that the E2B SDK may extend.
 */
export declare function e2bControlEnvs(overrides?: Readonly<Record<string, string>>): Record<string, string>;
/** Configuration for the shared E2B sandbox owner. */
export interface Config {
    /** API key; omission reads `E2B_API_KEY`. It is never forwarded into the sandbox. */
    apiKey?: string;
    /** Shared remote working directory, created before adapters receive the sandbox. */
    cwd?: string;
    /** E2B sandbox lifetime in milliseconds; expiry always deletes the sandbox. */
    timeoutMs?: number;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        e2b: E2BRuntime;
    }
}
/**
 * Creates one lazily consumable E2B SDK handle and deletes the sandbox at
 * timeout or disposal. Creation begins at plugin construction; adapters await
 * {@link getSandbox} before their first operation.
 */
export declare class E2BRuntime extends Service {
    static Config: z<Config>;
    /** Validated remote working directory shared by provider adapters. */
    readonly cwd: string;
    /** Remote directory reserved for adapter-owned process and terminal state. */
    readonly runtimeRoot: string;
    private readonly config;
    private readonly ready;
    private disposed;
    constructor(ctx: Context, config: Config);
    /**
     * Return the shared live SDK handle.
     * @returns the created sandbox after the configured cwd exists.
     * @throws when E2B rejects creation or the service is disposing.
     */
    getSandbox(): Promise<Sandbox>;
    private validate;
    private open;
}
export default E2BRuntime;
//# sourceMappingURL=index.d.ts.map