/**
 * E2B Service Provider for the subprocess capability seam. Each handle starts through the
 * shared sandbox and retains command output/status paths in that remote world.
 * @module @deepseek-ai/dsh-subprocess-e2b
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** Configuration for the E2B subprocess adapter. */
export interface Config {
    /** Remote status/liveness poll cadence in milliseconds; each tick is one control-plane request. */
    pollMs?: number;
}
/** E2B command manager registered as `ctx.subprocess`. */
export declare class E2BSubprocessRuntime extends SubprocessRuntime {
    static inject: string[];
    static Config: z<Config>;
    private readonly live;
    private readonly terminals;
    private readonly terminalSetups;
    private readonly pollMs;
    private disposing;
    /** Create the E2B subprocess service and bind its disposal policy. */
    constructor(ctx: Context, config: Config);
    /** @inheritdoc */
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    /** @inheritdoc */
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
    /** @inheritdoc */
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>;
}
export default E2BSubprocessRuntime;
//# sourceMappingURL=index.d.ts.map