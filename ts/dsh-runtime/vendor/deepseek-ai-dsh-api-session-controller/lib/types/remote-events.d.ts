/** Session Controller events forwarded unchanged through the Remote Event carrier. */
export declare const SESSION_CONTROLLER_REMOTE_EVENTS: readonly ["api-session/activity", "api-session/added", "api-session/error", "api-session/removed", "api-session/status"];
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteEventSelection extends Record<typeof SESSION_CONTROLLER_REMOTE_EVENTS[number], true> {
    }
}
//# sourceMappingURL=remote-events.d.ts.map