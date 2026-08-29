/**
 * Pure fold for the heuristic context-composition projection: system prompt
 * and tool schemas from the newest request envelope, conversation from the
 * live surface. Prices with the same shared estimator as the meter service,
 * so the three figures match `measure()`'s heuristic vocabulary exactly.
 */
import { z } from 'zod';
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        contextBreakdown: ContextBreakdownState;
    }
}
/** The context-breakdown state schema and source of its inferred type. */
declare const contextBreakdownStateSchema: z.ZodObject<{
    systemTokens: z.ZodNumber;
    toolsTokens: z.ZodNumber;
    messageTokens: z.ZodNumber;
    claim: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
        tokens: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strict>;
type ContextBreakdownState = z.infer<typeof contextBreakdownStateSchema>;
/**
 * Token-meter's context-composition projection unit.
 *
 * Envelope figures are last-wins per `request/header`; the message figure
 * rides {@link foldSurfaceProjection} — the same O(1) fold the occupancy
 * projection uses — so fully metered logs equal the sum of
 * `measure().nodes[].heuristicTokens` at every event boundary and compaction
 * shrinks the figure by its logged shadow price; the route-priced
 * `measure().surfaceTokens` deliberately diverges by the routed model's image
 * repricing. A replacement without a claim preserves the previous total. The
 * state is a fixed handful of numbers, so the persisted checkpoint stays
 * O(1) over the session's life.
 */
export declare const contextBreakdownProjectionDefinition: {
    key: "contextBreakdown";
    stateVersion: number;
    stateSchema: z.ZodObject<{
        systemTokens: z.ZodNumber;
        toolsTokens: z.ZodNumber;
        messageTokens: z.ZodNumber;
        claim: z.ZodOptional<z.ZodObject<{
            start: z.ZodNumber;
            end: z.ZodNumber;
            tokens: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strict>;
    init: () => {
        systemTokens: number;
        toolsTokens: number;
        messageTokens: number;
    };
    apply: (state: NoInfer<{
        systemTokens: number;
        toolsTokens: number;
        messageTokens: number;
        claim?: {
            start: number;
            end: number;
            tokens: number;
        } | undefined;
    }>, event: import("@deepseek-ai/dsh-session").SessionEvent) => {
        systemTokens: number;
        toolsTokens: number;
        messageTokens: number;
        claim?: {
            start: number;
            end: number;
            tokens: number;
        } | undefined;
    };
    wire: {
        viewSchema: z.ZodObject<{
            systemTokens: z.ZodNumber;
            toolsTokens: z.ZodNumber;
            messageTokens: z.ZodNumber;
        }, z.core.$strict>;
        view: ({ systemTokens, toolsTokens, messageTokens }: NoInfer<{
            systemTokens: number;
            toolsTokens: number;
            messageTokens: number;
            claim?: {
                start: number;
                end: number;
                tokens: number;
            } | undefined;
        }>) => {
            systemTokens: number;
            toolsTokens: number;
            messageTokens: number;
        };
    };
};
export {};
//# sourceMappingURL=breakdown-projection.d.ts.map