/**
 * Opt-in request clock context. Eligible steps add durable,
 * source-attributed time readings to the request history.
 *
 * @module @deepseek-ai/dsh-time-context
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "time-context";
/** The agent registry that owns pre-step processing. */
export declare const inject: string[];
/** Request-preparation clock formatting and append scheduling. Invalid values fail plugin load. */
export interface Config {
    /** Fallback display zone when the open turn has no unique browser zone. Omit to use the process zone. */
    timeZone?: string;
    /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject at every eligible step. */
    refreshIntervalMs?: number;
}
/** Schemastery validation for {@link Config}. */
export declare const Config: z<Config>;
/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - time zone and durable refresh scheduling configuration.
 * @throws when the refresh interval is invalid or the configured or process time zone cannot be resolved.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map