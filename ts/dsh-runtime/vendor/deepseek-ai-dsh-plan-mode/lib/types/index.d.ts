/**
 * Plan mode is logged per-agent collaboration state: while active, a
 * deployment-owned guidance section is included in each model request, and
 * `exit_plan_mode` presents the completed plan for user review, while the
 * `/plan off` command lets a user leave directly. Sandbox mode and approval
 * policy enforce restrictions independently and do not read or write plan
 * state.
 *
 * The state in force is folded from the session log (`plan/mode`, last one
 * wins), so resume and fork restore it without a live mirror. User selections
 * remain pending until the next accepted in-turn pre-step. The service includes
 * the selected state in the proposed step assembly, then appends `plan/mode`
 * from `agent/pre-step` only when the step is accepted. Same-step request
 * retries reuse their assembly.
 *
 * The exit tool remains registered while plan mode is inactive, so entering
 * or leaving plan mode changes only the prompt section, not the request tool
 * catalog.
 *
 * Agent Note:
 * - .agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md
 *
 * @module @deepseek-ai/dsh-plan-mode
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CommandId } from '@deepseek-ai/dsh-commands';
export type * from './types.ts';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * Whether plan mode is in force from this point on: log-only, non-surface,
         * whole-value replace. The last `plan/mode` wins; a log with none folds to
         * inactive through {@link foldPlanMode}.
         */
        'plan/mode': {
            active: boolean;
        };
    }
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        planMode: PlanModeController;
    }
}
/**
 * The model-facing exit tool's name. It stays registered while plan mode is
 * inactive so the request tool catalog is stable across transitions.
 */
export declare const EXIT_PLAN_MODE = "exit_plan_mode";
/** Deployment-owned plan guidance. */
export interface PlanModeConfig {
    /** Guidance rendered as the `plan:policy` prompt section while plan mode is active. */
    section: string;
}
/**
 * Validate deployment-owned plan guidance. Missing, blank, non-string, or
 * unknown fields fail at plugin load rather than being ignored.
 *
 * @param config Raw plugin config.
 * @returns A detached validated config.
 */
export declare function resolveConfig(config: PlanModeConfig): PlanModeConfig;
/**
 * Whether plan mode is active after the first `end` events. The last
 * `plan/mode` wins; a prefix with none is inactive.
 *
 * @param events The session log or any prefix of it.
 * @param end Fold `events[0, end)`; defaults to the whole log.
 * @returns Whether plan mode is active.
 */
export declare function foldPlanMode(events: readonly SessionEvent[], end?: number): boolean;
/**
 * Projection unit state: the logged mode, the latest successful `/plan`
 * selection not yet resolved by a `plan/mode` commit, and an execution whose
 * paired `command/done` has not settled. Plain JSON (persisted-cache
 * precondition).
 */
interface PlanUnitState {
    active: boolean;
    /** The selection's target mode; null when no selection is outstanding. */
    wanted: boolean | null;
    /** The latest plan command awaiting its paired settlement. */
    running: {
        commandId: CommandId;
        wanted: boolean;
    } | null;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        plan: PlanUnitState;
    }
}
/**
 * `ctx.planMode`: owns logged plan state, applies and narrates selected state at step start,
 * the `plan:policy` section, the `/plan` command, and the stable exit tool.
 * UIs observe committed flips through `session/event`; there is no live mirror.
 */
export declare class PlanModeController extends Service {
    static inject: string[];
    /** Validated deployment-owned guidance. */
    private readonly section;
    /**
     * Latest selection per session awaiting the next accepted in-turn pre-step.
     * `narrate` is true for user selections and false for the exit tool, whose
     * result already narrates the transition.
     */
    private readonly pendingIntents;
    constructor(ctx: Context, config?: PlanModeConfig);
    /**
     * Read the logged plan state and any selected state awaiting the next
     * accepted in-turn pre-step.
     *
     * @param agent The agent to read.
     * @returns Current logged state plus a pending selection, when present.
     */
    get(agent: Agent): {
        active: boolean;
        pending?: boolean;
    };
    /**
     * Select whether plan mode should be active. Between turns the method
     * appends the change immediately because no in-turn pre-step will run until
     * another prompt starts a turn. The open-turn fold is the idle signal:
     * agent status stays `running` through post-turn checkpointing, when no
     * further in-turn pre-step runs. During an open turn the selection remains
     * pending until the next accepted in-turn pre-step. Repeated selection of
     * the current or already-pending state is a no-op.
     *
     * @param agent The agent to switch.
     * @param active Whether plan mode should be active.
     * @returns what happened: `committed` (logged now), `queued` (awaiting the
     * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
     * was cleared; the logged state already matches), or `noop` (already in that
     * state).
     */
    set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop';
    /** Append one pending selection before the next request assembly. */
    private onBoundary;
    /** Build a user-switch notice when the last logged header described the other mode. */
    private narration;
}
export default PlanModeController;
//# sourceMappingURL=index.d.ts.map