/**
 * The one home of this application's forwarded-Host-event allowlist. Both
 * compiler faces list this file, so the Host forwarding loop and the consumer
 * `ctx.remote.$on` key face read one declaration instead of two copies that
 * could drift; `./types.ts` derives the type projection from it and stays
 * type-only.
 */
/**
 * Host events this application forwards without renaming. The explicit mode is
 * both the Host dispatch strategy and the legal key set of `ctx.remote.$on`.
 */
export declare const API_REMOTE_FORWARDED_EVENTS: readonly [{
    readonly event: "agent-preset/selected";
    readonly mode: "emit";
}, {
    readonly event: "approval/request";
    readonly mode: "waterfall";
}, ...{
    event: "api-session/added" | "api-session/removed" | "api-session/status" | "api-session/activity" | "api-session/error";
    mode: "emit";
}[], {
    readonly event: "commands/change";
    readonly mode: "emit";
}, {
    readonly event: "credentials/reference-updated";
    readonly mode: "emit";
}, {
    readonly event: "cordis/request-run";
    readonly mode: "emit";
}, {
    readonly event: "cordis/request-run-resolved";
    readonly mode: "emit";
}, {
    readonly event: "cordis/dynamic-package";
    readonly mode: "emit";
}, {
    readonly event: "cordis/dynamic-retract";
    readonly mode: "emit";
}, {
    readonly event: "cordis/inspect-query";
    readonly mode: "emit";
}, {
    readonly event: "cordis/inspect-query-resolved";
    readonly mode: "emit";
}, {
    readonly event: "llm/adapters-updated";
    readonly mode: "emit";
}, {
    readonly event: "settings/document-updated";
    readonly mode: "emit";
}, {
    readonly event: "user-questions/request";
    readonly mode: "waterfall";
}];
//# sourceMappingURL=remote-events.d.ts.map