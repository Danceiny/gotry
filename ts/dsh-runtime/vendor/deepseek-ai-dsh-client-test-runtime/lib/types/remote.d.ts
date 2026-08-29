/** Test-owned Remote face: `$on` subscriptions with an explicit test event driver. */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Remote service test double for the forwarded-event path. Feature specs need
 * `ctx.remote.$on` to exist (their plugins inject `remote`) and need forwarded
 * Host events to reach those subscribers, but not the wire — so this double
 * implements subscription plus an explicit `emit` driver available only on the
 * concrete test object. A spec that also calls one namespace scripts it through
 * the constructor rather than reaching the real Client Remote service.
 *
 * `$mount` rejects: a spec that needs a real generated contribution installed —
 * codecs, descriptors, and the wire — has outgrown this double and needs the
 * real Client Remote service.
 *
 * One deliberate asymmetry with production: a throwing listener propagates out
 * of the emit instead of being contained and logged, so a spec cannot lean on
 * this double for the containment guarantee `$on` documents — assert that
 * against the real service.
 */
export declare class TestRemote {
    private readonly subscriptions;
    /**
     * Register the double as `ctx.remote`, plus one service per scripted
     * namespace so a plugin injecting `remote.<name>` also unparks.
     * @param ctx - the spec's root Context.
     * @param namespaces - scripted namespace faces reached as `ctx.remote.<name>`.
     */
    constructor(ctx: Context, namespaces?: Readonly<Record<string, object>>);
    /**
     * Deliver one forwarded host event to its subscribers, standing in for the
     * carrier that owns the frame sink.
     * @param event - forwarded host event name.
     * @param args - the Host argument list, verbatim.
     */
    emit(event: string, args: readonly unknown[]): void;
    /**
     * Subscribe to one forwarded host event.
     * @param event - forwarded host event name.
     * @param listener - receives the Host argument list verbatim.
     * @returns disposer removing this subscription.
     */
    $on(event: string, listener: (...args: never[]) => void): () => void;
    /**
     * Generated-namespace mount, unsupported by this double.
     * @returns never; always rejects.
     */
    $mount(): Promise<() => Promise<void>>;
}
//# sourceMappingURL=remote.d.ts.map