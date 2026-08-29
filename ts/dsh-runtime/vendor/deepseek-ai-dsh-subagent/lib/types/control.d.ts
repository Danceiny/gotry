/**
 * Browser-facing subagent control assembly: the catalog view sampled against
 * the live Agent registry, one browser zone's validation, and the stable
 * failure codes the Remote surface answers with.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import type { SubagentCatalog, SubagentControlErrorDetailsMap, SubagentListEntry } from './control-types.ts';
declare const CONTROL_ID_SCHEMAS: {
    readonly 'subagent.list': z.ZodObject<{
        parentSessionId: z.ZodString;
    }, z.core.$strip>;
    readonly 'subagent.prompt': z.ZodObject<{
        parentSessionId: z.ZodString;
        childSessionId: z.ZodString;
        mode: z.ZodLiteral<"continuable">;
    }, z.core.$strip>;
    readonly 'subagent.interrupt': z.ZodObject<{
        parentSessionId: z.ZodString;
        childSessionId: z.ZodString;
        mode: z.ZodLiteral<"continuable">;
    }, z.core.$strip>;
};
/**
 * Validate and canonicalize one browser-supplied IANA zone at the wire boundary.
 * @param value - the browser's reported zone name.
 * @returns the canonical zone, or `undefined` when the name is unusable.
 */
export declare function canonicalClientTimeZone(value: string): string | undefined;
/**
 * Refuse one Remote call with a stable business failure the carrier preserves.
 * @param code - declared caller-facing code.
 * @param message - human-readable refusal.
 * @param details - that code's declared detail payload.
 * @returns Never — the failure is thrown.
 * @throws {TypertRemoteFailure} always.
 */
export declare function rejectControl<Code extends keyof SubagentControlErrorDetailsMap>(code: Code, message: string, details: SubagentControlErrorDetailsMap[Code]): never;
/**
 * Apply the subagent payload checks that are stricter than generated
 * branded-string codecs.
 * @param method - method name carried in the failure message.
 * @param payload - decoded control fields to validate.
 * @throws {TypertRemoteFailure} `bad-request` with the original Zod issues.
 */
export declare function validateControlRequest(method: keyof typeof CONTROL_ID_SCHEMAS, payload: unknown): void;
/**
 * Project one durable listing onto the catalog view, replacing each row's
 * store-derived activity with the live Agent driver's status and reporting
 * whether the exact parent Agent is live. Without an Agent registry no driver
 * runs at all, so every row is inactive and the parent is unavailable.
 * @param ctx - Host context that may carry the Agent registry.
 * @param parentSessionId - the listed parent.
 * @param entries - the durable direct-child listing.
 * @returns the catalog view answered to one browser.
 */
export declare function catalogView(ctx: Context, parentSessionId: SessionId, entries: readonly SubagentListEntry[]): SubagentCatalog;
/**
 * Refuse one catalog read while preserving cancellation and a missing
 * projections registry as distinct failures.
 * @param error - the thrown value.
 * @param signal - the caller's cancellation.
 * @returns Never — the refusal is thrown.
 * @throws {TypertRemoteFailure} always.
 */
export declare function rejectCatalogRead(error: unknown, signal: AbortSignal): never;
/**
 * Refuse one continuation prompt without exposing provider detail: admission
 * failures the caller can act on keep their own code, everything else is
 * internal.
 * @param error - the thrown value.
 * @param childSessionId - the addressed child.
 * @param signal - the caller's cancellation.
 * @returns Never — the refusal is thrown.
 * @throws {TypertRemoteFailure} always.
 */
export declare function rejectPrompt(error: unknown, childSessionId: SessionId, signal: AbortSignal): never;
export {};
//# sourceMappingURL=control.d.ts.map