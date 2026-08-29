/**
 * Six model-facing persistent terminal tools. Owner identity comes from the exact
 * tool execution Agent; generic `ctx.jobs` owns background ids and collection.
 * @module @deepseek-ai/dsh-tool-terminal
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        'pty-send': 'pty-send';
    }
}
/** Cordis plugin name. */
export declare const name = "tool-terminal";
/** Required capability, registry, and prompt services. */
export declare const inject: string[];
/** Default cap for one complete model-facing terminal result. */
export declare const DEFAULT_MAX_RESULT_BYTES: number;
/** Smallest cap that preserves every counter-backed PTY and job id in its creation acknowledgement. */
export declare const MIN_MAX_RESULT_BYTES = 64;
/** Model-facing terminal tool configuration. */
export interface Config {
    /** Expose `run_in_background` and accept background sends (default true). */
    enableRunInBackground?: boolean;
    /** Maximum UTF-8 bytes in one complete terminal or task-output result. */
    maxResultBytes?: number;
}
/** Schemastery configuration for the terminal tool consumer. */
export declare const Config: z<Config>;
/** Register all terminal tools and the minimal usage guidance. */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map