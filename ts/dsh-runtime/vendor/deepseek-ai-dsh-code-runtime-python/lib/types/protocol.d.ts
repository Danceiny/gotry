/**
 * Versionless, JSON-lines wire protocol between the Node host and the CPython subprocess. Frames
 * travel on the child's fd 3 (one JSON object per line), leaving stdout/stderr free for the
 * program's own output. Host treats every inbound frame as hostile because model code can post
 * anything through the same fd; the Python bootstrap trusts host replies.
 * @module @deepseek-ai/dsh-code-runtime-python/src/protocol
 */
/**
 * The framed-JSON channel's file descriptor from the child's perspective. The
 * host pins it positionally when it spawns the child (`stdio` index 3, i.e.
 * `['pipe','pipe','pipe','pipe']`), and the Python bootstrap reads the same
 * number from its own `protocol.py`. Exported as the single TS-side source of
 * truth: the host wiring uses it, and the cross-language mirror test asserts the
 * Python constant equals it, so a drift on either side breaks the boot channel
 * loudly rather than silently.
 */
export declare const PROTOCOL_FD = 3;
/**
 * One binding namespace declaration inside a {@link BootMessage}. `global` is
 * the program-visible name the namespace is materialized under; `errorClass`,
 * when present, asks the bootstrap to mint a program-visible exception class.
 */
interface Namespace {
    global: string;
    names: string[];
    errorClass?: ErrorClass;
}
/**
 * A namespace's program-visible exception class: rejected calls raise its
 * instances carrying the failed member name on `memberNameProperty`.
 */
interface ErrorClass {
    name: string;
    memberNameProperty: string;
}
/**
 * What the host sends immediately after spawn, as the first line on fd 3. The
 * Python bootstrap reads this, applies resource limits, then waits for the
 * subsequent run frame. Separated from the run so the run message stays
 * pure model input.
 */
export interface BootMessage {
    type: 'boot';
    /** RLIMIT_CPU seconds; the Python bootstrap sets this on itself before executing model code. */
    cpuSeconds: number;
    /** RLIMIT_AS bytes; caps address space so a runaway allocation fails cleanly. */
    addressSpaceBytes: number;
    /** Shared byte budget for captured log text (Python-side ledger). */
    maxLogBytes: number;
    /** Byte cap for the rendered completion value. */
    maxValueBytes: number;
    /**
     * The namespaces to materialize inside the program (globals + names;
     * functions stay host-side). See {@link Namespace}.
     */
    namespaces: Namespace[];
}
/** Python → host: acknowledges boot completed and resource limits are in place. */
interface BootAckMessage {
    type: 'boot-ack';
}
/** Python → host: one bridged binding call (`await tools.name(args)` inside the program). */
interface CallMessage {
    type: 'call';
    /** Python-issued correlation id; the host answers each id at most once and ignores duplicates. */
    id: number;
    /** The namespace global the call targets. */
    global: string;
    /** The function name within the namespace. */
    name: string;
    /** The JSON-safe argument the model program passed. */
    args: unknown;
}
/**
 * Python → host: captured text, streamed eagerly so output survives a
 * mid-run termination (RLIMIT_CPU, SIGTERM/SIGKILL, host wall-timeout).
 */
interface LogMessage {
    type: 'log';
    text: string;
    /**
     * Set when this frame IS the child ledger's truncation marker rather than
     * program output. The two ledgers can exhaust at different points — one
     * child entry larger than `maxLogBytes` sends only the marker while the host
     * ledger is still nearly empty — so the host cannot infer the child's state
     * from its own budget, and comparing the text against the marker string
     * would also honour a program that printed that string itself. Carrying it
     * as a field lets the host stop capturing at the same point the child did
     * and keeps exactly one marker in `logs`.
     */
    truncated?: boolean;
}
/** The failure carried on a {@link DoneMessage}: one of three kinds plus text. */
interface DoneErrorField {
    kind: 'exception' | 'invalid-output' | 'output-limit';
    message: string;
}
/**
 * Python → host: the program settled. `error` carries a program exception
 * (traceback text), an `invalid-output` (completion value was not lossless
 * JSON), or an `output-limit` (serialized completion exceeded the configured
 * cap); wall/CPU budgets, aborts, and substrate death are observed host-side.
 * From the honest child `value` is present only on a clean completion that
 * produced one, and crosses as exact lossless JSON — never substituted or
 * truncated. A forged frame CAN carry both `value` and `error`;
 * {@link validateChildFrame} preserves both rather than guessing which to drop,
 * so a consumer MUST check `error` first and ignore `value` when it is set.
 */
interface DoneMessage {
    type: 'done';
    value?: unknown;
    error?: DoneErrorField;
}
/**
 * Every message the Python side sends. The member interfaces stay module-
 * private: consumers match on the union's discriminant; the host sends the
 * boot and run frames as inline literals.
 */
export type ChildToHost = BootAckMessage | CallMessage | LogMessage | DoneMessage;
/** Host → Python: successful answer to one {@link CallMessage}. */
interface ReplyOk {
    type: 'reply';
    id: number;
    ok: true;
    value: unknown;
}
/** Host → Python: failed answer to one {@link CallMessage}. */
interface ReplyErr {
    type: 'reply';
    id: number;
    ok: false;
    message: string;
}
/** Host → Python: the answer to one {@link CallMessage}. */
export type ReplyMessage = ReplyOk | ReplyErr;
/**
 * Each frame's wire fields tagged by required/optional, keyed by field name so
 * the mapping is exhaustive over the frame interface (see {@link FrameFieldRoles})
 * across the whole {@link WireFrameShapes} roster. Bound to the interfaces by
 * `satisfies` below; {@link WIRE_FRAME_FIELDS} projects it to sorted
 * required/optional arrays for the cross-language mirror comparison. `global` is
 * the JSON key {@link CallMessage} and {@link Namespace} send (a reserved word
 * the Python side carries via a functional `TypedDict`).
 */
declare const WIRE_FRAME_FIELD_ROLES: {
    readonly BootMessage: {
        readonly type: "required";
        readonly cpuSeconds: "required";
        readonly addressSpaceBytes: "required";
        readonly maxLogBytes: "required";
        readonly maxValueBytes: "required";
        readonly namespaces: "required";
    };
    readonly Namespace: {
        readonly global: "required";
        readonly names: "required";
        readonly errorClass: "optional";
    };
    readonly RunMessage: {
        readonly type: "required";
        readonly program: "required";
    };
    readonly BootAckMessage: {
        readonly type: "required";
    };
    readonly CallMessage: {
        readonly type: "required";
        readonly id: "required";
        readonly global: "required";
        readonly name: "required";
        readonly args: "required";
    };
    readonly LogMessage: {
        readonly type: "required";
        readonly text: "required";
        readonly truncated: "optional";
    };
    readonly DoneErrorField: {
        readonly kind: "required";
        readonly message: "required";
    };
    readonly DoneMessage: {
        readonly type: "required";
        readonly value: "optional";
        readonly error: "optional";
    };
    readonly ErrorClass: {
        readonly name: "required";
        readonly memberNameProperty: "required";
    };
    readonly ReplyOk: {
        readonly type: "required";
        readonly id: "required";
        readonly ok: "required";
        readonly value: "required";
    };
    readonly ReplyErr: {
        readonly type: "required";
        readonly id: "required";
        readonly ok: "required";
        readonly message: "required";
    };
};
/**
 * The wire field names of each frame, split into sorted required and optional
 * key arrays — the shape the cross-language mirror test compares against
 * `py/protocol.py`'s `TypedDict` `__required_keys__`/`__optional_keys__`.
 * Projected from {@link WIRE_FRAME_FIELD_ROLES}, so it inherits that mapping's
 * exhaustive, optionality-checked binding to the frame interfaces: a TS-side
 * field add, remove, rename, or optionality flip fails typecheck at the roles
 * map, and a Python-side divergence fails the mirror test at runtime.
 */
export declare const WIRE_FRAME_FIELDS: Record<keyof typeof WIRE_FRAME_FIELD_ROLES, {
    required: string[];
    optional: string[];
}>;
/**
 * The in-band marker text announcing that log capture stopped at the byte
 * budget. Shared wire vocabulary: the Python-side LogBuffer emits it when ITS
 * ledger exhausts, and the host emits identical text when its own ledger drops
 * a frame first (forged fd-3 traffic, stray stdout bytes) — a truncated run
 * reads the same however the cap was hit.
 * @param maxBytes - the configured `maxLogBytes` the marker names.
 * @returns the marker line.
 */
export declare function logTruncationMarker(maxBytes: number): string;
/**
 * Serialize one JSON-parse-produced value without recursion. `JSON.stringify`
 * recurses per nesting level and throws `RangeError` a few thousand levels
 * deep, but the seam's `CodeJsonValue` has no depth limit — an honest deep
 * completion or binding resolution below the byte budget must cross intact
 * (the worker backend's wire is equally stack-safe). Callers must pass a value
 * produced by `JSON.parse` (or equally JSON-plain): only `null`, finite
 * numbers, booleans, strings, dense arrays, and plain objects — this encoder
 * validates nothing. Output matches compact `JSON.stringify` byte for byte
 * EXCEPT on an integral double beyond the safe range, where {@link scalarJson}
 * emits the exact integer's BigInt digits rather than `JSON.stringify`'s rounded
 * spelling (`1152921504606846976`, not `...847000`) so the seam's lossless-JSON
 * promise holds across the wire.
 * @param value - a JSON-plain value (e.g. straight from `JSON.parse`).
 * @returns the compact JSON encoding.
 */
export declare function encodeJsonPlain(value: unknown): string;
/**
 * Meter a `JSON.parse`-produced done value's compact-JSON byte length AND its
 * number losslessness in one traversal, stopping the instant `maxBytes` is
 * crossed. This bounds the INCREMENTAL allocation the check itself would add on
 * top of the already-parsed value — the enqueued children; strings and keys are
 * metered by {@link jsonStringBytesUpTo} without allocating an escaped copy —
 * not the parse that produced `value`.
 * That upstream width is bounded separately, by the host-side cap on inbound
 * fd-3 frame size before `JSON.parse` runs (owned by the runtime that reads the
 * channel), so `value` cannot be arbitrarily large when it reaches here. The
 * budget is the `maxValueBytes` the boot frame carries — a required wire field
 * with no default at this layer. The traversal rejects over-budget BEFORE
 * materializing a string's escaped form or enqueuing an array's/object's
 * children, so a forgery within that frame cap cannot force those secondary
 * allocations. Object key COUNTING is
 * unavoidably O(keys) — JS has no lazy own-key iterator, and the parse already
 * built the key set — but the check still refuses the per-entry work before the
 * enqueue loop. A non-lossless number (non-finite, negative zero) is caught only
 * when the value fits the budget — an over-budget value is rejected regardless,
 * so the distinction is moot. Same JSON-plain precondition and traversal shape
 * as {@link encodeJsonPlain}; a number's byte length is measured through
 * {@link scalarJson} (matching the encoder, so a beyond-safe-range integer
 * meters its exact BigInt digits, not `JSON.stringify`'s rounded spelling) and
 * a string's/key's through {@link jsonStringBytesUpTo} (the exact escaped size,
 * scanned without allocating the escaped copy).
 * @param value - a JSON-plain value (e.g. straight from `JSON.parse`).
 * @param maxBytes - the completion-value budget in bytes.
 * @returns `{ ok: true, bytes }` with the exact serialized size, or
 * `{ ok: false, reason }` — `over-budget` once the size exceeds `maxBytes`,
 * `non-lossless` on a non-finite or negative-zero number.
 */
export declare function checkDoneValue(value: unknown, maxBytes: number): {
    ok: true;
    bytes: number;
} | {
    ok: false;
    reason: 'over-budget' | 'non-lossless';
};
/**
 * Whether a raw JSON line contains an integer token that would lose precision
 * as a JavaScript number. `JSON.parse` silently rounds such a token
 * (`9007199254740993` becomes `...992`) BEFORE any validation can see it, so
 * the check must read the source text; a beyond-safe-range token whose double
 * parse round-trips exactly (`2**53`, `2**60`) is lossless and passes. The scan walks the line skipping string literals (a digit run
 * inside a string is data, not a number token) and tests every number token
 * in plain integer form — no fraction or exponent, which parse as doubles by
 * intent. A reviver cannot do this job: the reviver walk recurses per nesting
 * level and would reintroduce the depth limit `encodeJsonPlain` removes.
 * @param line - the raw UTF-8 text of one JSON-lines frame.
 * @returns true when an unsafe integer token is present outside strings.
 */
export declare function hasUnsafeIntegerToken(line: string): boolean;
/**
 * Whether a JSON.parse-produced value contains a number outside lossless
 * JSON: non-finite (`1e400` parses to `Infinity`) or negative zero (`-0.0`
 * parses to JS `-0`, whose sign bit a re-serialization drops). The honest
 * child's validator rejects these before sending, so a frame carrying one is
 * forged.
 *
 * Runs on `call.args`, which — unlike a completion value — has NO seam byte
 * cap, so there is no budget to reject a wide payload against the way
 * {@link checkDoneValue} does. The traversal therefore holds ONE cursor per
 * NESTING LEVEL (an array or {@link ownValues} iterator) instead of one entry
 * per member: a forged flat `args` at the top of the host's inbound frame-size
 * cap would
 * otherwise push tens of millions of stack entries — and `Object.values` would
 * copy each object's full breadth — allocating hundreds of megabytes beyond
 * what `JSON.parse` already holds. Iterative either way, so a deep frame
 * cannot overflow the host stack.
 * @param value - a JSON-parse-produced value from an fd-3 frame.
 * @returns true when any contained number is non-finite or negative zero.
 */
export declare function hasNonLosslessNumber(value: unknown): boolean;
/**
 * Runtime shape gate for inbound fd-3 traffic. Model code has full access to
 * fd 3 and can post anything — `null`, primitives, poisoned fields — so the
 * compile-time union means nothing here: every field is validated and REBUILT
 * before the host reads it (forged extras never ride along; a non-number id
 * can never be echoed into a reply). Junk returns `undefined` and is dropped
 * so a throw in the host's `message` handler cannot crash the host process.
 * @param raw - one JSON-parsed frame from fd 3.
 * @returns the rebuilt frame, or `undefined` to drop it silently.
 */
export declare function validateChildFrame(raw: unknown): ChildToHost | undefined;
export {};
//# sourceMappingURL=protocol.d.ts.map