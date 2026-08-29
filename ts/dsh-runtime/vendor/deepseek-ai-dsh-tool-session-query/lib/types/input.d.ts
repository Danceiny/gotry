/**
 * Model argument schemas, normalization, and filter construction.
 *
 * @module @deepseek-ai/dsh-tool-session-query/input
 */
import { type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session';
import { type SessionAvailability, type SessionEventMetadataFilter, type SessionEventSurface, type SessionResultFilter } from '@deepseek-ai/dsh-session-query';
interface SessionSearchArgs {
    query: string;
    session_ids?: string[];
    created_at_from?: string;
    created_at_to?: string;
    parent_session_ids?: string[];
    include_root_sessions?: boolean;
    availability?: SessionAvailability[];
    event_seq_from?: number;
    event_seq_to?: number;
    event_time_from?: string;
    event_time_to?: string;
    event_types?: string[];
    event_surfaces?: SessionEventSurface[];
}
interface EventFilterInput {
    readonly seqFrom?: number | undefined;
    readonly seqTo?: number | undefined;
    readonly timeFrom?: string | undefined;
    readonly timeTo?: string | undefined;
    readonly eventTypes?: string[] | undefined;
    readonly surfaces?: SessionEventSurface[] | undefined;
}
declare function buildSessionFilters(args: SessionSearchArgs): SessionResultFilter[];
declare function materializeParentSessionIds(values: readonly string[] | undefined): SessionIdValue[] | undefined;
declare function buildEventFilters(input: EventFilterInput): SessionEventMetadataFilter[];
declare function normalizeQuery(value: string): string;
declare function sequenceRange(from: number | undefined, to: number | undefined): {
    from?: number;
    to?: number;
};
declare function assertNonNegativeSafeInteger(name: string, value: number): void;
/** Model schemas and model-owned value normalization shared by tool operations. */
export declare const toolInput: {
    sessionSearchParameters: {
        readonly query: {
            readonly type: "string";
            readonly required: true;
            readonly description: "Literal full-text query over prior session history.";
        };
        readonly session_ids: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Optional session ids to include.";
        };
        readonly created_at_from: {
            readonly type: "string";
            readonly description: "Inclusive timezone-qualified ISO 8601 creation-time lower bound.";
        };
        readonly created_at_to: {
            readonly type: "string";
            readonly description: "Inclusive timezone-qualified ISO 8601 creation-time upper bound.";
        };
        readonly parent_session_ids: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Optional direct parent session ids.";
        };
        readonly include_root_sessions: {
            readonly type: "boolean";
            readonly description: "Include sessions with no parent in the parent filter.";
        };
        readonly availability: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly enum: readonly ["live", "persisted"];
            };
            readonly description: "Require at least one selected source availability.";
        };
        readonly event_seq_from: {
            readonly type: "integer";
            readonly description: "Inclusive event sequence lower bound.";
        };
        readonly event_seq_to: {
            readonly type: "integer";
            readonly description: "Inclusive event sequence upper bound.";
        };
        readonly event_time_from: {
            readonly type: "string";
            readonly description: "Inclusive timezone-qualified ISO 8601 event-time lower bound.";
        };
        readonly event_time_to: {
            readonly type: "string";
            readonly description: "Inclusive timezone-qualified ISO 8601 event-time upper bound.";
        };
        readonly event_types: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Event types to include.";
        };
        readonly event_surfaces: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly enum: readonly ["current", "shadowed", "log-only"];
            };
            readonly description: "Event surfaces to include.";
        };
    };
    eventSearchParameters: {
        readonly session_id: {
            readonly type: "string";
            readonly description: "Target session id. Omit for the current session.";
        };
        readonly query: {
            readonly type: "string";
            readonly required: true;
            readonly description: "Literal full-text query over the target session.";
        };
        readonly seq_from: {
            readonly type: "integer";
            readonly description: "Inclusive event sequence lower bound.";
        };
        readonly seq_to: {
            readonly type: "integer";
            readonly description: "Inclusive event sequence upper bound.";
        };
        readonly time_from: {
            readonly type: "string";
            readonly description: "Inclusive timezone-qualified ISO 8601 event-time lower bound.";
        };
        readonly time_to: {
            readonly type: "string";
            readonly description: "Inclusive timezone-qualified ISO 8601 event-time upper bound.";
        };
        readonly event_types: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Event types to include.";
        };
        readonly surfaces: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
                readonly enum: readonly ["current", "shadowed", "log-only"];
            };
            readonly description: "Event surfaces to include.";
        };
    };
    targetSessionParameter: {
        readonly session_id: {
            readonly type: "string";
            readonly description: "Target session id. Omit for the current session.";
        };
    };
    buildSessionFilters: typeof buildSessionFilters;
    materializeParentSessionIds: typeof materializeParentSessionIds;
    buildEventFilters: typeof buildEventFilters;
    normalizeQuery: typeof normalizeQuery;
    sequenceRange: typeof sequenceRange;
    assertNonNegativeSafeInteger: typeof assertNonNegativeSafeInteger;
};
export {};
//# sourceMappingURL=input.d.ts.map