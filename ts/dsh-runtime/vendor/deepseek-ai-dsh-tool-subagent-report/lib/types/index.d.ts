/**
 * The child-scoped `report` tool and its usage guidance, installed into every
 * continuable in-process child's unpublished context. Roots, one-shot children,
 * remote providers, and agentless executions never see the registration.
 *
 * @module @deepseek-ai/dsh-tool-subagent-report
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { SubagentReportDelivery } from '@deepseek-ai/dsh-subagent';
export declare const name = "tool-subagent-report";
export declare const inject: string[];
/** Config: how accepted reports are scheduled on the parent. */
export interface Config {
    /**
     * Parent scheduling (default `next-step`). `next-step` wakes the parent and
     * enters at its nearest step boundary; `quiet` adds the same context without
     * waking, so a parked parent waits for another waking input.
     */
    reportDelivery?: SubagentReportDelivery;
}
export declare const Config: z<Config>;
/**
 * Install `report` and its usage guidance into one continuable child's scope.
 * Both registrations are owned by that scope and are therefore invisible to the
 * child's parent and siblings.
 * @param childCtx - child-scoped context receiving the tool and the guidance.
 * @param ctx - service context used for delivery.
 * @param delivery - resolved deployment scheduling policy.
 * @returns disposer that attempts both child registrations before reporting cleanup failures.
 */
export declare function installReportTool(childCtx: Context, ctx: Context, delivery: SubagentReportDelivery): () => void;
/**
 * Register the continuable-child contribution.
 * @param ctx - context carrying tools, the system prompt, and the subagent service.
 * @param config - deployment scheduling policy.
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map