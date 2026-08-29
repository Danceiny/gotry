/**
 * Capture coordinator for the telemetry capability. Live capture subscribes to
 * the session firehose plus the one live-bus relay (`agent/error`). Both
 * capture paths apply the fixed chunk projection, build logical records, and
 * run each through the
 * `session-telemetry/record` waterfall (deployment-mounted redaction rules;
 * pass-through when none), then hands the result to the backend. Live capture
 * follows the session firehose; on-demand capture replays the canonical log
 * only when requested. Every synchronous handler is self-contained so a
 * failing backend can never starve other subscribers (cordis `emit` is
 * stop-on-throw) or touch the agent loop. Composed by a backend in its
 * constructor.
 *
 * @module @deepseek-ai/dsh-session-telemetry/coordinator
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionTelemetrySink } from './index.ts';
/** Whether capture follows live events or reads the canonical log only when requested. */
export type SessionTelemetryCapture = 'live' | 'on-demand';
/**
 * Install the telemetry capture side onto a context for one backend.
 *
 * Live capture registers the persistence-coordinator listener set plus the
 * `agent/error` relay, all through `ctx.effect()`/`ctx.on()` on the composing
 * fiber, and sweeps already-live sessions (a hot reload does not replay
 * `session/created`). A `session/disposed` captures the session's `shutdown`
 * operational record at its own termination edge and retires it from the
 * adopted set. On-demand capture registers none of those continuous listeners;
 * {@link captureSession} reads the canonical log explicitly and never creates
 * operational records. Disposal captures shutdown markers for live-adopted
 * sessions, then awaits the backend's `shutdown()`; a failure there warns
 * instead of throwing — best-effort reporting must not fail application
 * teardown.
 */
export declare class SessionTelemetryCoordinator {
    private readonly ctx;
    private readonly backend;
    /**
     * Sessions adopted by THIS fiber and still live, for double-adoption
     * protection and the teardown sweep of unmarked sessions;
     * `session/disposed` marks and retires entries.
     */
    private readonly adopted;
    /** Per session, the `turn:step` keys whose first chunk already shipped; rebuilt from the log on re-adoption. */
    private readonly chunkSeen;
    /**
     * @param ctx - the composing backend's context; listeners bind to its fiber.
     * @param backend - the backend receiving records; owned elsewhere, never disposed here beyond `shutdown()` forwarding.
     * @param capture - follow live events, or wait for explicit canonical-log capture.
     */
    constructor(ctx: Context, backend: SessionTelemetrySink, capture?: SessionTelemetryCapture);
    /**
     * Project and hand over the canonical session-log suffix after the handoff
     * cursor, optionally stopping at an inclusive sequence boundary. Redaction
     * runs during this call, so an on-demand caller retains no copied records
     * before requesting capture and uses the policy mounted at that time.
     * Backend and policy failures remain contained per event and do not starve
     * later events in the same replay.
     * @param session - session whose current canonical-log prefix may be handed over.
     * @param throughSeq - optional last sequence included in this capture.
     */
    captureSession(session: Session, throughSeq?: number): void;
    /**
     * Adopt a session: replay its log THROUGH the projection from the handoff
     * cursor, then rely on the firehose for everything after. When no cursor
     * survived, replay starts at the session's construction boundary
     * (`firstLiveSeq`), not seq 0: constructor seeds never publish on the
     * firehose, and their content already left the process under another
     * identity — the same id in a previous process (resume) or the parent's
     * stream (fork, stitched by receivers via `session.seed_length`). Events
     * at or below the start still feed the projection state (first-chunk
     * tracking) without being re-handed, so a resumed fiber drops mid-step
     * chunk continuations exactly like the fiber that saw the step begin. The
     * cost, accepted with the capture contract's at-most-once stance: a resume
     * does not backfill records a previous process failed to deliver.
     * @param session - the live session to adopt; a second adoption is a no-op.
     */
    private adopt;
    /** Feed the chunk projection without handing off — the ≤cursor half of re-adoption. */
    private track;
    /** Project, redact, and hand one event to the backend. */
    private captureEvent;
    /**
     * Run the `session-telemetry/record` waterfall at capture time. The innermost `next`
     * passes the record through unchanged — this package ships no rules; exported
     * data is as clean as the listeners a deployment mounts. Callers run inside
     * {@link contain}, so a throwing rule withholds the record instead of
     * reaching the loop (fail-closed). On-demand capture invokes this waterfall
     * while reading the canonical session log, not when the event was appended.
     */
    private redact;
    /** Hand one redacted record to the backend, then advance its ledger cursor. */
    private deliver;
    /** Forward the turn-end boundary to the backend's optional flush hint. */
    private hintFlush;
    /** Relay one `agent/error` bus emission as an `agent-error` operational record. */
    private relayAgentError;
    /** Lazily create the per-session first-chunk tracking set. */
    private seen;
    /**
     * Run one capture-side step with its exception contained: cordis `emit`
     * is stop-on-throw, so a throwing listener would starve every subscriber
     * registered after this plugin — nothing from the backend may escape.
     */
    private contain;
}
//# sourceMappingURL=coordinator.d.ts.map