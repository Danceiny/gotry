import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { FIRST_PARTY_SECTION_ORDER } from "@deepseek-ai/dsh-system-prompt";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SessionQueryError, extractSessionEventText } from "@deepseek-ai/dsh-session-query";
import { HarnessError } from "@deepseek-ai/dsh-llm";
//#region lib/types/input.js
/**
* Model argument schemas, normalization, and filter construction.
*
* @module @deepseek-ai/dsh-tool-session-query/input
*/
const sessionSearchParameters = {
	query: {
		type: "string",
		required: true,
		description: "Literal full-text query over prior session history."
	},
	session_ids: {
		type: "array",
		items: { type: "string" },
		description: "Optional session ids to include."
	},
	created_at_from: {
		type: "string",
		description: "Inclusive timezone-qualified ISO 8601 creation-time lower bound."
	},
	created_at_to: {
		type: "string",
		description: "Inclusive timezone-qualified ISO 8601 creation-time upper bound."
	},
	parent_session_ids: {
		type: "array",
		items: { type: "string" },
		description: "Optional direct parent session ids."
	},
	include_root_sessions: {
		type: "boolean",
		description: "Include sessions with no parent in the parent filter."
	},
	availability: {
		type: "array",
		items: {
			type: "string",
			enum: ["live", "persisted"]
		},
		description: "Require at least one selected source availability."
	},
	event_seq_from: {
		type: "integer",
		description: "Inclusive event sequence lower bound."
	},
	event_seq_to: {
		type: "integer",
		description: "Inclusive event sequence upper bound."
	},
	event_time_from: {
		type: "string",
		description: "Inclusive timezone-qualified ISO 8601 event-time lower bound."
	},
	event_time_to: {
		type: "string",
		description: "Inclusive timezone-qualified ISO 8601 event-time upper bound."
	},
	event_types: {
		type: "array",
		items: { type: "string" },
		description: "Event types to include."
	},
	event_surfaces: {
		type: "array",
		items: {
			type: "string",
			enum: [
				"current",
				"shadowed",
				"log-only"
			]
		},
		description: "Event surfaces to include."
	}
};
const eventSearchParameters = {
	session_id: {
		type: "string",
		description: "Target session id. Omit for the current session."
	},
	query: {
		type: "string",
		required: true,
		description: "Literal full-text query over the target session."
	},
	seq_from: {
		type: "integer",
		description: "Inclusive event sequence lower bound."
	},
	seq_to: {
		type: "integer",
		description: "Inclusive event sequence upper bound."
	},
	time_from: {
		type: "string",
		description: "Inclusive timezone-qualified ISO 8601 event-time lower bound."
	},
	time_to: {
		type: "string",
		description: "Inclusive timezone-qualified ISO 8601 event-time upper bound."
	},
	event_types: {
		type: "array",
		items: { type: "string" },
		description: "Event types to include."
	},
	surfaces: {
		type: "array",
		items: {
			type: "string",
			enum: [
				"current",
				"shadowed",
				"log-only"
			]
		},
		description: "Event surfaces to include."
	}
};
const targetSessionParameter = { session_id: {
	type: "string",
	description: "Target session id. Omit for the current session."
} };
function buildSessionFilters(args) {
	const filters = [];
	if (args.session_ids !== void 0) {
		assertNonEmptyArray("session_ids", args.session_ids);
		filters.push({
			kind: "id",
			values: args.session_ids.map(SessionId)
		});
	}
	const created = timestampRange("created_at", args.created_at_from, args.created_at_to);
	if (created !== void 0) filters.push({
		kind: "created-at",
		...created
	});
	if (args.availability !== void 0) {
		assertNonEmptyArray("availability", args.availability);
		filters.push({
			kind: "availability",
			values: args.availability
		});
	}
	return filters;
}
function materializeParentSessionIds(values) {
	if (values === void 0) return void 0;
	assertNonEmptyArray("parent_session_ids", values);
	return [...new Set(values.map(SessionId))];
}
function buildEventFilters(input) {
	const filters = [];
	const seq = sequenceRange(input.seqFrom, input.seqTo);
	if (seq.from !== void 0 || seq.to !== void 0) filters.push({
		kind: "seq",
		...seq
	});
	const time = timestampRange("time", input.timeFrom, input.timeTo);
	if (time !== void 0) filters.push({
		kind: "time",
		...time
	});
	if (input.eventTypes !== void 0) {
		assertNonEmptyArray("event_types", input.eventTypes);
		filters.push({
			kind: "type",
			values: input.eventTypes
		});
	}
	if (input.surfaces !== void 0) {
		assertNonEmptyArray("surfaces", input.surfaces);
		filters.push({
			kind: "surface",
			values: input.surfaces
		});
	}
	return filters;
}
function normalizeQuery(value) {
	const query = value.trim().replace(/\s+/gu, " ");
	if (query.length === 0) throw new SessionQueryError("session-search query must contain non-whitespace text", "SESSION_QUERY_INVALID_QUERY");
	if (query.includes("\0")) throw new SessionQueryError("session-search query must not contain NUL", "SESSION_QUERY_INVALID_QUERY");
	return query;
}
function sequenceRange(from, to) {
	if (from !== void 0) assertNonNegativeSafeInteger("sequence lower bound", from);
	if (to !== void 0) assertNonNegativeSafeInteger("sequence upper bound", to);
	if (from !== void 0 && to !== void 0 && from > to) throw invalidRange("sequence", "from must be less than or equal to to");
	return {
		...from === void 0 ? {} : { from },
		...to === void 0 ? {} : { to }
	};
}
function timestampRange(name, from, to) {
	if (from === void 0 && to === void 0) return void 0;
	const fromTimestamp = from === void 0 ? void 0 : parseIsoTimestamp(`${name}_from`, from);
	const toTimestamp = to === void 0 ? void 0 : parseIsoTimestamp(`${name}_to`, to);
	if (fromTimestamp !== void 0 && toTimestamp !== void 0 && compareTimestamps(fromTimestamp, toTimestamp) > 0) throw invalidRange(name, "from must be less than or equal to to");
	return {
		...fromTimestamp === void 0 ? {} : { from: timestampLowerBound(fromTimestamp) },
		...toTimestamp === void 0 ? {} : { to: timestampUpperBound(toTimestamp) }
	};
}
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
function parseIsoTimestamp(name, value) {
	const match = ISO_TIMESTAMP.exec(value);
	if (match === null) throw invalidRange(name, "must be an ISO 8601 timestamp with Z or a numeric offset");
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6] ?? 0);
	const offsetHour = Number(match[10] ?? 0);
	const offsetMinute = Number(match[11] ?? 0);
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) throw invalidRange(name, "must be a valid ISO 8601 timestamp");
	const fraction = match[7] ?? "";
	const millisecondDigits = fraction.slice(0, 3).padEnd(3, "0");
	const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}.${millisecondDigits}${match[8]}`;
	const timestamp = Date.parse(normalized);
	if (!Number.isSafeInteger(timestamp)) throw invalidRange(name, "must be a valid ISO 8601 timestamp");
	return {
		millisecond: timestamp,
		remainder: fraction.slice(3).replace(/0+$/u, "")
	};
}
function compareTimestamps(left, right) {
	if (left.millisecond !== right.millisecond) return left.millisecond < right.millisecond ? -1 : 1;
	const length = Math.max(left.remainder.length, right.remainder.length);
	for (let index = 0; index < length; index += 1) {
		const leftDigit = left.remainder[index] ?? "0";
		const rightDigit = right.remainder[index] ?? "0";
		if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
	}
	return 0;
}
function timestampLowerBound(timestamp) {
	return timestamp.remainder.length === 0 ? timestamp.millisecond : nextUpFinite(timestamp.millisecond);
}
function timestampUpperBound(timestamp) {
	return timestamp.remainder.length === 0 ? timestamp.millisecond : nextDownFinite(timestamp.millisecond + 1);
}
function nextUpFinite(value) {
	if (value === 0) return Number.MIN_VALUE;
	const view = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
	view.setFloat64(0, value);
	const bits = view.getBigUint64(0);
	view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n);
	return view.getFloat64(0);
}
function nextDownFinite(value) {
	if (value === 0) return -Number.MIN_VALUE;
	const view = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
	view.setFloat64(0, value);
	const bits = view.getBigUint64(0);
	view.setBigUint64(0, value > 0 ? bits - 1n : bits + 1n);
	return view.getFloat64(0);
}
function daysInMonth(year, month) {
	if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	return [
		4,
		6,
		9,
		11
	].includes(month) ? 30 : 31;
}
function invalidRange(name, detail) {
	return new SessionQueryError(`session ${name} range ${detail}`, "SESSION_QUERY_INVALID_FILTER");
}
function assertNonNegativeSafeInteger(name, value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new SessionQueryError(`${name} must be a non-negative safe integer`, "SESSION_QUERY_INVALID_FILTER");
}
function assertNonEmptyArray(name, values) {
	if (values.length === 0) throw new SessionQueryError(`${name} must contain at least one value when supplied`, "SESSION_QUERY_INVALID_FILTER");
}
/** Model schemas and model-owned value normalization shared by tool operations. */
const toolInput = {
	sessionSearchParameters,
	eventSearchParameters,
	targetSessionParameter,
	buildSessionFilters,
	materializeParentSessionIds,
	buildEventFilters,
	normalizeQuery,
	sequenceRange,
	assertNonNegativeSafeInteger
};
//#endregion
//#region lib/types/service-boundary.js
/**
* Session-query service error containment and model-safe translation.
*
* @module @deepseek-ai/dsh-tool-session-query/service-boundary
*/
const UNPRINTABLE_SERVICE_ERROR = "[unprintable session query failure]";
const SAFE_SESSION_QUERY_FAILURES = {
	SESSION_QUERY_ABORTED: {
		code: "SESSION_QUERY_ABORTED",
		message: "session query was cancelled"
	},
	SESSION_QUERY_CORRUPT_SESSION: {
		code: "SESSION_QUERY_CORRUPT_SESSION",
		message: "session event history is corrupt"
	},
	SESSION_QUERY_EVENT_NOT_FOUND: {
		code: "SESSION_QUERY_EVENT_NOT_FOUND",
		message: "session event was not found"
	},
	SESSION_QUERY_INDEX_FAILED: {
		code: "SESSION_QUERY_INDEX_FAILED",
		message: "session search index is unavailable"
	},
	SESSION_QUERY_INVALID_CONFIG: {
		code: "SESSION_QUERY_TOOL_FAILED",
		message: "session query operation failed"
	},
	SESSION_QUERY_INVALID_CURSOR: {
		code: "SESSION_QUERY_INVALID_CURSOR",
		message: "session search continuation is invalid"
	},
	SESSION_QUERY_INVALID_FILTER: {
		code: "SESSION_QUERY_INVALID_FILTER",
		message: "session query filters were rejected"
	},
	SESSION_QUERY_INVALID_LIMIT: {
		code: "SESSION_QUERY_INVALID_LIMIT",
		message: "session query result limit was rejected"
	},
	SESSION_QUERY_INVALID_QUERY: {
		code: "SESSION_QUERY_INVALID_QUERY",
		message: "session query was rejected"
	},
	SESSION_QUERY_INVALID_LINEAGE: {
		code: "SESSION_QUERY_INVALID_LINEAGE",
		message: "session lineage is invalid"
	},
	SESSION_QUERY_INVALID_SURFACE: {
		code: "SESSION_QUERY_INVALID_SURFACE",
		message: "session event history is invalid"
	},
	SESSION_QUERY_INVALID_WINDOW: {
		code: "SESSION_QUERY_INVALID_WINDOW",
		message: "session event window is invalid"
	},
	SESSION_QUERY_PERSISTENCE_FAILED: {
		code: "SESSION_QUERY_PERSISTENCE_FAILED",
		message: "session history storage is unavailable"
	},
	SESSION_QUERY_SEARCH_DISABLED: {
		code: "SESSION_QUERY_SEARCH_DISABLED",
		message: "session search is disabled in this deployment"
	},
	SESSION_QUERY_SESSION_NOT_FOUND: {
		code: "SESSION_QUERY_SESSION_NOT_FOUND",
		message: "session was not found"
	},
	SESSION_QUERY_STALE_CURSOR: {
		code: "SESSION_QUERY_STALE_CURSOR",
		message: "session history changed while paging; retry the complete search call"
	},
	SESSION_QUERY_SOURCE_CONFLICT: {
		code: "SESSION_QUERY_TOOL_FAILED",
		message: "session query operation failed"
	}
};
function unauthorizedTarget() {
	return new HarnessError("session target is outside the caller workspace", "SESSION_QUERY_TOOL_UNAUTHORIZED");
}
async function call(ctx, signal, operation, invoke) {
	signal.throwIfAborted();
	try {
		const value = await invoke();
		signal.throwIfAborted();
		return value;
	} catch (error) {
		signal.throwIfAborted();
		throw sanitizeError(ctx, operation, error);
	}
}
function sanitizeError(ctx, operation, error) {
	const generic = genericFailure();
	const diagnostic = fullError(error);
	try {
		ctx.logger.warn(`tool-session-query: ${operation} failed: ${diagnostic}`);
		if (error instanceof SessionQueryError) {
			const code = error.code;
			const failure = typeof code === "string" && Object.hasOwn(SAFE_SESSION_QUERY_FAILURES, code) ? SAFE_SESSION_QUERY_FAILURES[code] : void 0;
			if (failure !== void 0 && failure.code !== "SESSION_QUERY_TOOL_FAILED") return new SessionQueryError(failure.message, failure.code);
		}
		if (error instanceof HarnessError && error.code === "SESSION_QUERY_TOOL_UNAUTHORIZED") return unauthorizedTarget();
	} catch {
		return generic;
	}
	return generic;
}
function genericFailure() {
	return new HarnessError("session query operation failed", "SESSION_QUERY_TOOL_FAILED");
}
function fullError(error) {
	try {
		return renderFullError(error);
	} catch {
		return UNPRINTABLE_SERVICE_ERROR;
	}
}
function renderFullError(error) {
	if (!(error instanceof Error)) return String(error);
	const diagnostics = [];
	const seen = /* @__PURE__ */ new Set();
	let current = error;
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		diagnostics.push(current.stack ?? String(current));
		current = current.cause;
	}
	/* v8 ignore next -- defensive containment for a cyclic Error.cause graph */
	if (current instanceof Error) diagnostics.push("[circular error cause]");
	else if (current !== void 0) diagnostics.push(renderFullError(current));
	return diagnostics.join("\nCaused by: ");
}
/** Model-safe session-query invocation and error translation boundary. */
const serviceBoundary = {
	unauthorizedTarget,
	call,
	sanitizeError
};
//#endregion
//#region lib/types/workspace-access.js
/**
* Caller identity, workspace authorization, and visible lineage projection.
*
* @module @deepseek-ai/dsh-tool-session-query/workspace-access
*/
function callerOf(exec) {
	const agent = exec.agent;
	if (agent === void 0) throw new HarnessError("session query tools require an agent-bound caller", "SESSION_QUERY_TOOL_MISSING_AGENT");
	return {
		id: agent.session.id,
		header: agent.session.header,
		events: agent.session.events
	};
}
function targetId(args, caller) {
	return args.session_id === void 0 ? caller.id : SessionId(args.session_id);
}
async function authorizeTarget(ctx, caller, target, signal) {
	if (target === caller.id) return;
	const cwd = caller.header.cwd;
	if (cwd === void 0) throw serviceBoundary.unauthorizedTarget();
	if ((await serviceBoundary.call(ctx, signal, "target authorization", () => ctx.sessionQuery.filterSessions([{
		kind: "id",
		values: [target]
	}, {
		kind: "cwd",
		values: [cwd]
	}], signal))).length !== 1) throw serviceBoundary.unauthorizedTarget();
}
function recordAuthorized(record, caller) {
	return headerAuthorized(record.header, caller);
}
function headerAuthorized(header, caller) {
	if (header.id === caller.id) return header.cwd === caller.header.cwd;
	return caller.header.cwd !== void 0 && header.cwd === caller.header.cwd;
}
function assertObservedTargetAuthorized(caller, target, observed) {
	if (observed.id !== target || !headerAuthorized(observed, caller)) throw serviceBoundary.unauthorizedTarget();
}
async function authorizeSessionIds(ctx, caller, ids, signal) {
	const unique = [...new Set(ids)];
	const authorized = /* @__PURE__ */ new Set();
	if (unique.includes(caller.id)) authorized.add(caller.id);
	const cwd = caller.header.cwd;
	const other = unique.filter((id) => id !== caller.id);
	if (cwd === void 0 || other.length === 0) return authorized;
	const records = await serviceBoundary.call(ctx, signal, "session-id authorization", () => ctx.sessionQuery.filterSessions([{
		kind: "id",
		values: other
	}, {
		kind: "cwd",
		values: [cwd]
	}], signal));
	const requested = new Set(other);
	for (const record of records) if (requested.has(record.header.id) && recordAuthorized(record, caller)) authorized.add(record.header.id);
	return authorized;
}
async function readTitles(ctx, caller, ids, signal) {
	const result = /* @__PURE__ */ new Map();
	const observations = await serviceBoundary.call(ctx, signal, "title observation", () => ctx.sessionQuery.readTitleSnapshots(ids, signal));
	for (const observation of observations) {
		if (observation.status === "rejected") {
			result.set(observation.sessionId, unavailableTitle(ctx, observation.reason));
			continue;
		}
		assertObservedTargetAuthorized(caller, observation.sessionId, observation.value.session);
		result.set(observation.sessionId, { text: observation.value.title?.title ?? "untitled" });
	}
	return result;
}
async function readTitle(ctx, caller, id, signal) {
	return (await readTitles(ctx, caller, [id], signal)).get(id);
}
function unavailableTitle(ctx, error) {
	const sanitized = serviceBoundary.sanitizeError(ctx, "title observation item", error);
	if (sanitized.code === "SESSION_QUERY_TOOL_UNAUTHORIZED") throw sanitized;
	return {
		text: "untitled",
		unavailableCode: sanitized.code
	};
}
function authorizeDescendants(nodes, caller) {
	const result = [];
	let pending;
	for (const node of [...nodes].reverse()) pending = {
		node,
		target: result,
		next: pending
	};
	while (pending !== void 0) {
		const current = pending;
		pending = current.next;
		if (!recordAuthorized(current.node.session, caller)) {
			current.target.push(null);
			continue;
		}
		const projected = {
			record: current.node.session,
			descendants: []
		};
		current.target.push(projected);
		for (const child of [...current.node.descendants].reverse()) pending = {
			node: child,
			target: projected.descendants,
			next: pending
		};
	}
	return result;
}
function* visitDescendants(nodes) {
	let pending;
	for (const node of [...nodes].reverse()) pending = {
		node,
		depth: 0,
		next: pending
	};
	while (pending !== void 0) {
		const current = pending;
		pending = current.next;
		yield current;
		if (current.node === null) continue;
		for (const child of [...current.node.descendants].reverse()) pending = {
			node: child,
			depth: current.depth + 1,
			next: pending
		};
	}
}
function descendantIds(nodes) {
	const ids = [];
	for (const { node } of visitDescendants(nodes)) if (node !== null) ids.push(node.record.header.id);
	return ids;
}
function titleText(view) {
	return view.unavailableCode === void 0 ? view.text : `${view.text} (title unavailable: ${view.unavailableCode})`;
}
/** Workspace-scoped caller authorization, title access, and lineage projection. */
const workspaceAccess = {
	callerOf,
	targetId,
	authorizeTarget,
	recordAuthorized,
	assertObservedTargetAuthorized,
	authorizeSessionIds,
	readTitles,
	readTitle,
	authorizeDescendants,
	visitDescendants,
	descendantIds,
	titleText
};
//#endregion
//#region lib/types/presentation.js
/**
* Model text rendering and generic tool-call presentation.
*
* @module @deepseek-ai/dsh-tool-session-query/presentation
*/
function formatSessionSearch(collected, titles, authorizedParents) {
	if (collected.items.length === 0) return formatEmptySessionSearch();
	const lines = [`Session search results (${collected.items.length}):`];
	for (const [index, hit] of collected.items.entries()) {
		const parent = hit.header.parentSession === void 0 ? "root" : authorizedParents.has(hit.header.parentSession) ? hit.header.parentSession : "[outside workspace]";
		const availability = [hit.live ? "live" : void 0, hit.persisted ? "persisted" : void 0].filter((value) => value !== void 0).join(", ") || "unavailable";
		lines.push("", `${index + 1}. Session ${hit.header.id} — ${workspaceAccess.titleText(titles.get(hit.header.id))}`, `   Created: ${formatTime(hit.header.createdAt)}`, `   Parent: ${parent}`, `   Availability: ${availability}`, `   Best match: seq ${hit.bestMatch.seq} | ${hit.bestMatch.type} | ${hit.bestMatch.surface} | ${formatTime(hit.bestMatch.time)}`, `   Snippet: ${hit.bestMatch.snippet}`);
	}
	if (collected.capped) lines.push("", "Result cap reached. Narrow the query or add filters to find additional matches.");
	return lines.join("\n");
}
function formatEmptySessionSearch() {
	return "No prior session matches found.";
}
function formatEventSearch(sessionId, title, collected) {
	const lines = [`Session ${sessionId} — ${workspaceAccess.titleText(title)}`];
	if (collected.items.length === 0) {
		lines.push("", "No prior event matches found.");
		return lines.join("\n");
	}
	lines.push("", `Event search results (${collected.items.length}):`);
	for (const [index, hit] of collected.items.entries()) lines.push(`${index + 1}. seq ${hit.seq} | ${hit.type} | ${hit.surface} | ${formatTime(hit.time)}`, `   Snippet: ${hit.snippet}`);
	if (collected.capped) lines.push("", "Result cap reached. Narrow the query or add filters to find additional matches.");
	return lines.join("\n");
}
function formatSessionTrace(trace, ancestors, ancestorBoundary, descendants, titles) {
	const lines = [
		`Session ${trace.target.header.id} — ${workspaceAccess.titleText(titles.get(trace.target.header.id))}`,
		`Created: ${formatTime(trace.target.header.createdAt)}`,
		`Availability: ${availabilityText(trace.target)}`,
		"",
		"Ancestors (nearest first):"
	];
	if (ancestors.length === 0 && !ancestorBoundary) lines.push("- none (target is a root session)");
	for (const record of ancestors) lines.push(`- ${record.header.id} — ${workspaceAccess.titleText(titles.get(record.header.id))} | ${formatTime(record.header.createdAt)} | ${availabilityText(record)}`);
	if (ancestorBoundary) lines.push("- [outside workspace boundary]");
	lines.push("", "Descendants:");
	if (descendants.length === 0) lines.push("- none");
	else renderDescendants(lines, descendants, titles);
	return lines.join("\n");
}
function renderDescendants(lines, nodes, titles) {
	for (const { node, depth } of workspaceAccess.visitDescendants(nodes)) {
		const indent = "  ".repeat(depth);
		if (node === null) {
			lines.push(`${indent}- [outside workspace subtree]`);
			continue;
		}
		const id = node.record.header.id;
		lines.push(`${indent}- ${id} — ${workspaceAccess.titleText(titles.get(id))} | ${formatTime(node.record.header.createdAt)} | ${availabilityText(node.record)}`);
	}
}
function formatEventTrace(sessionId, title, trace) {
	return [
		`Session ${sessionId} — ${workspaceAccess.titleText(title)}`,
		`Target: seq ${trace.target.seq} | ${trace.target.type} | ${trace.target.surface} | ${formatTime(trace.target.time)}`,
		`Replaced by: ${trace.replacedBy ?? "none"}`,
		`Replacement chain: ${seqList(trace.replacementChain)}`,
		`Events replaced by target: ${seqList(trace.replacedEventSeqs)}`,
		`Events cited directly as sources: ${seqList(trace.sourceEventSeqs)}`,
		`Direct derived events: ${seqList(trace.derivedEventSeqs)}`
	].join("\n");
}
function formatEventRead(sessionId, title, window) {
	const before = window.events.filter((event) => event.seq < window.target.seq);
	const after = window.events.filter((event) => event.seq > window.target.seq);
	const lines = [
		`Session ${sessionId} — ${workspaceAccess.titleText(title)}`,
		`Target event seq ${window.target.seq}:`,
		"```json",
		JSON.stringify(window.target, null, 2),
		"```"
	];
	if (before.length > 0) {
		lines.push("", "Before:");
		for (const event of before) lines.push(formatNeighbor(event));
	}
	if (after.length > 0) {
		lines.push("", "After:");
		for (const event of after) lines.push(formatNeighbor(event));
	}
	return lines.join("\n");
}
function formatNeighbor(event) {
	const text = extractSessionEventText(event);
	return `- seq ${event.seq} | ${event.type} | ${formatTime(event.time)}` + (text.length === 0 ? " | (no semantic text)" : `\n  ${text.replaceAll("\n", "\n  ")}`);
}
function availabilityText(record) {
	return [record.live ? "live" : void 0, record.persisted ? "persisted" : void 0].filter((value) => value !== void 0).join(", ") || "unavailable";
}
function seqList(values) {
	return values.length === 0 ? "none" : values.join(", ");
}
function formatTime(value) {
	return new Date(value).toISOString();
}
function presentSessionSearchCall(args) {
	return {
		card: "generic",
		kind: "search",
		title: "Search prior sessions",
		rawInput: args.query
	};
}
function presentEventSearchCall(args) {
	return {
		card: "generic",
		kind: "search",
		title: "Search session events",
		rawInput: args.query
	};
}
function presentSessionTraceCall(args) {
	return {
		card: "generic",
		kind: "read",
		title: args.session_id === void 0 ? "Trace current session" : `Trace session ${args.session_id}`,
		...args.session_id === void 0 ? {} : { rawInput: args.session_id }
	};
}
function presentEventTargetCall(action, args) {
	return {
		card: "generic",
		kind: "read",
		title: `${action} ${args.seq}`,
		rawInput: {
			...args.session_id === void 0 ? {} : { session_id: args.session_id },
			seq: args.seq
		}
	};
}
/** Text output and call-card presentation for every session-query tool. */
const presentation = {
	formatSessionSearch,
	formatEmptySessionSearch,
	formatEventSearch,
	formatSessionTrace,
	formatEventTrace,
	formatEventRead,
	presentSessionSearchCall,
	presentEventSearchCall,
	presentSessionTraceCall,
	presentEventTargetCall
};
//#endregion
//#region lib/types/operations.js
/**
* Tool operation orchestration over session-query service capabilities.
*
* @module @deepseek-ai/dsh-tool-session-query/operations
*/
async function executeSessionSearch(ctx, args, exec, maxResults) {
	const caller = workspaceAccess.callerOf(exec);
	const cwd = caller.header.cwd;
	if (cwd === void 0) throw new HarnessError("cross-session search is unavailable because the caller session has no workspace", "SESSION_QUERY_TOOL_UNAUTHORIZED");
	const query = toolInput.normalizeQuery(args.query);
	const sessionFilters = toolInput.buildSessionFilters(args);
	const eventFilters = toolInput.buildEventFilters({
		seqFrom: args.event_seq_from,
		seqTo: args.event_seq_to,
		timeFrom: args.event_time_from,
		timeTo: args.event_time_to,
		eventTypes: args.event_types,
		surfaces: args.event_surfaces
	});
	const requestedParentIds = toolInput.materializeParentSessionIds(args.parent_session_ids);
	if (requestedParentIds !== void 0 || args.include_root_sessions === true) {
		const authorizedParentIds = requestedParentIds === void 0 ? /* @__PURE__ */ new Set() : await workspaceAccess.authorizeSessionIds(ctx, caller, requestedParentIds, exec.signal);
		const parentValues = requestedParentIds?.filter((id) => authorizedParentIds.has(id)) ?? [];
		if (args.include_root_sessions === true) parentValues.push(null);
		if (parentValues.length === 0) return presentation.formatEmptySessionSearch();
		sessionFilters.push({
			kind: "parent",
			values: parentValues
		});
	}
	sessionFilters.push({
		kind: "cwd",
		values: [cwd]
	});
	const collected = await collectPages(maxResults, exec.signal, (cursor) => serviceBoundary.call(ctx, exec.signal, "session search", () => ctx.sessionQuery.searchSessions({
		query,
		sessionFilters,
		eventFilters,
		...cursor === void 0 ? {} : { cursor }
	}, { signal: exec.signal })), (hit) => hit.header.id !== caller.id && workspaceAccess.recordAuthorized(hit, caller));
	const parentIds = collected.items.map((hit) => hit.header.parentSession).filter((id) => id !== void 0);
	const authorizedParents = await workspaceAccess.authorizeSessionIds(ctx, caller, parentIds, exec.signal);
	const titles = await workspaceAccess.readTitles(ctx, caller, collected.items.map((hit) => hit.header.id), exec.signal);
	return presentation.formatSessionSearch(collected, titles, authorizedParents);
}
async function executeEventSearch(ctx, args, exec, maxResults) {
	const caller = workspaceAccess.callerOf(exec);
	const sessionId = workspaceAccess.targetId(args, caller);
	await workspaceAccess.authorizeTarget(ctx, caller, sessionId, exec.signal);
	const query = toolInput.normalizeQuery(args.query);
	const range = toolInput.sequenceRange(args.seq_from, args.seq_to);
	if (sessionId === caller.id) {
		const stepStart = caller.events.findLast((event) => event.type === "step/start");
		if (stepStart === void 0) throw new HarnessError("current-session search requires an active step boundary", "SESSION_QUERY_TOOL_NO_CURRENT_STEP");
		range.to = Math.min(range.to ?? Number.MAX_SAFE_INTEGER, stepStart.seq - 1);
	}
	const title = await workspaceAccess.readTitle(ctx, caller, sessionId, exec.signal);
	if (range.from !== void 0 && range.to !== void 0 && range.from > range.to) return presentation.formatEventSearch(sessionId, title, {
		items: [],
		capped: false
	});
	const filters = toolInput.buildEventFilters({
		seqFrom: range.from,
		seqTo: range.to,
		timeFrom: args.time_from,
		timeTo: args.time_to,
		eventTypes: args.event_types,
		surfaces: args.surfaces
	});
	const collected = await collectPages(maxResults, exec.signal, async (cursor) => {
		const page = await serviceBoundary.call(ctx, exec.signal, "event search", () => ctx.sessionQuery.searchEvents({
			sessionId,
			query,
			filters,
			...cursor === void 0 ? {} : { cursor }
		}, { signal: exec.signal }));
		workspaceAccess.assertObservedTargetAuthorized(caller, sessionId, page.session);
		return page;
	}, () => true);
	return presentation.formatEventSearch(sessionId, title, collected);
}
async function executeSessionTrace(ctx, args, exec) {
	const caller = workspaceAccess.callerOf(exec);
	const sessionId = workspaceAccess.targetId(args, caller);
	await workspaceAccess.authorizeTarget(ctx, caller, sessionId, exec.signal);
	const trace = await serviceBoundary.call(ctx, exec.signal, "session lineage trace", () => ctx.sessionQuery.traceSession(sessionId, exec.signal));
	workspaceAccess.assertObservedTargetAuthorized(caller, sessionId, trace.target.header);
	const ancestors = [];
	let ancestorBoundary = false;
	for (const ancestor of trace.ancestors) {
		if (!workspaceAccess.recordAuthorized(ancestor, caller)) {
			ancestorBoundary = true;
			break;
		}
		ancestors.push(ancestor);
	}
	if (ancestors.length === trace.ancestors.length && !trace.complete) ancestorBoundary = true;
	const descendants = workspaceAccess.authorizeDescendants(trace.descendants, caller);
	const visibleIds = [
		trace.target.header.id,
		...ancestors.map((record) => record.header.id),
		...workspaceAccess.descendantIds(descendants)
	];
	const titles = await workspaceAccess.readTitles(ctx, caller, visibleIds, exec.signal);
	return presentation.formatSessionTrace(trace, ancestors, ancestorBoundary, descendants, titles);
}
async function executeEventTrace(ctx, args, exec) {
	toolInput.assertNonNegativeSafeInteger("seq", args.seq);
	const caller = workspaceAccess.callerOf(exec);
	const sessionId = workspaceAccess.targetId(args, caller);
	await workspaceAccess.authorizeTarget(ctx, caller, sessionId, exec.signal);
	const trace = await serviceBoundary.call(ctx, exec.signal, "event trace", () => ctx.sessionQuery.traceEvent({
		sessionId,
		seq: args.seq
	}, exec.signal));
	workspaceAccess.assertObservedTargetAuthorized(caller, sessionId, trace.session);
	const title = await workspaceAccess.readTitle(ctx, caller, sessionId, exec.signal);
	return presentation.formatEventTrace(sessionId, title, trace);
}
async function executeEventRead(ctx, args, exec) {
	toolInput.assertNonNegativeSafeInteger("seq", args.seq);
	if (args.before !== void 0) toolInput.assertNonNegativeSafeInteger("before", args.before);
	if (args.after !== void 0) toolInput.assertNonNegativeSafeInteger("after", args.after);
	const caller = workspaceAccess.callerOf(exec);
	const sessionId = workspaceAccess.targetId(args, caller);
	await workspaceAccess.authorizeTarget(ctx, caller, sessionId, exec.signal);
	const window = await serviceBoundary.call(ctx, exec.signal, "event read", () => ctx.sessionQuery.readEvent({
		sessionId,
		seq: args.seq,
		...args.before === void 0 ? {} : { before: args.before },
		...args.after === void 0 ? {} : { after: args.after }
	}, exec.signal));
	workspaceAccess.assertObservedTargetAuthorized(caller, sessionId, window.session);
	const title = await workspaceAccess.readTitle(ctx, caller, sessionId, exec.signal);
	return presentation.formatEventRead(sessionId, title, window);
}
async function collectPages(maxResults, signal, request, accept) {
	const items = [];
	const seen = /* @__PURE__ */ new Set();
	let cursor;
	while (true) {
		signal.throwIfAborted();
		const page = await request(cursor);
		signal.throwIfAborted();
		for (const item of page.items) {
			if (!accept(item)) continue;
			if (items.length === maxResults) return {
				items,
				capped: true
			};
			items.push(item);
		}
		if (page.nextCursor === void 0) return {
			items,
			capped: false
		};
		if (seen.has(page.nextCursor)) throw new SessionQueryError("session-search provider repeated a continuation cursor", "SESSION_QUERY_INVALID_CURSOR");
		seen.add(page.nextCursor);
		cursor = page.nextCursor;
	}
}
/** Five model-facing session-query operation implementations. */
const operations = {
	executeSessionSearch,
	executeEventSearch,
	executeSessionTrace,
	executeEventTrace,
	executeEventRead
};
//#endregion
//#region lib/types/index.js
/**
* Model-facing, workspace-authorized session-history search and read tools.
*
* @module @deepseek-ai/dsh-tool-session-query
*/
/** Cordis plugin name used by Loader diagnostics. */
const name = "tool-session-query";
/** Capability services required by the model-facing consumer. */
const inject = [
	"tools",
	"systemPrompt",
	"sessionQuery"
];
/** Default maximum number of authorized search hits returned by one call. */
const DEFAULT_MAX_SEARCH_RESULTS = 100;
/** Default cooperative deadline for either full-text search tool. */
const DEFAULT_SEARCH_TIMEOUT_MS = 3e4;
/** Schemastery config for Loader defaults and generated configuration docs. */
const Config = z.object({
	maxSearchResults: z.number().step(1).min(1).default(100),
	searchTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SEARCH_TIMEOUT_MS)
});
const TEXT_OUTPUT = {
	schema: { type: "string" },
	render: (_args, value) => [{
		type: "text",
		text: value
	}]
};
const PROMPT_TEXT = "Use session_search to find relevant work from prior sessions, or session_event_search to search earlier events in one session. Search results are cursor-free and workspace-scoped. Follow a useful hit with session_trace, session_event_trace, or session_event_read when you need lineage, relationships, or exact data.";
/** Register all five tools and their shared model guidance. */
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	ctx.systemPrompt.section({
		name: "tool:session-query",
		order: FIRST_PARTY_SECTION_ORDER.TOOL_SESSION_QUERY,
		text: PROMPT_TEXT
	});
	ctx.tools.register(defineTool({
		name: "session_search",
		description: "Search prior sessions in the caller workspace and return the strongest matching event from each session.",
		parameters: toolInput.sessionSearchParameters,
		output: TEXT_OUTPUT,
		timeoutMs: resolved.searchTimeoutMs,
		execute: (args, exec) => operations.executeSessionSearch(ctx, args, exec, resolved.maxSearchResults),
		presentCall: presentation.presentSessionSearchCall
	}));
	ctx.tools.register(defineTool({
		name: "session_event_search",
		description: "Search prior events in one authorized session; the current session excludes the step performing this call.",
		parameters: toolInput.eventSearchParameters,
		output: TEXT_OUTPUT,
		timeoutMs: resolved.searchTimeoutMs,
		execute: (args, exec) => operations.executeEventSearch(ctx, args, exec, resolved.maxSearchResults),
		presentCall: presentation.presentEventSearchCall
	}));
	ctx.tools.register(defineTool({
		name: "session_trace",
		description: "Read the authorized session lineage around one session, including complete visible ancestor and descendant relationships.",
		parameters: toolInput.targetSessionParameter,
		output: TEXT_OUTPUT,
		isConcurrencySafe: () => true,
		execute: (args, exec) => operations.executeSessionTrace(ctx, args, exec),
		presentCall: presentation.presentSessionTraceCall
	}));
	ctx.tools.register(defineTool({
		name: "session_event_trace",
		description: "Read every direct replacement and relationship to a cited source event for one event in an authorized session.",
		parameters: {
			...toolInput.targetSessionParameter,
			seq: {
				type: "integer",
				required: true,
				description: "Target event sequence number."
			}
		},
		output: TEXT_OUTPUT,
		isConcurrencySafe: () => true,
		execute: (args, exec) => operations.executeEventTrace(ctx, args, exec),
		presentCall: (args) => presentation.presentEventTargetCall("Trace event", args)
	}));
	ctx.tools.register(defineTool({
		name: "session_event_read",
		description: "Read one full unabridged event and optional neighboring raw-event summaries from an authorized session.",
		parameters: {
			...toolInput.targetSessionParameter,
			seq: {
				type: "integer",
				required: true,
				description: "Target event sequence number."
			},
			before: {
				type: "integer",
				description: "Number of preceding raw events to summarize. Omit for none."
			},
			after: {
				type: "integer",
				description: "Number of following raw events to summarize. Omit for none."
			}
		},
		output: TEXT_OUTPUT,
		isConcurrencySafe: () => true,
		execute: (args, exec) => operations.executeEventRead(ctx, args, exec),
		presentCall: (args) => presentation.presentEventTargetCall("Read event", args)
	}));
}
function resolveConfig(config) {
	const maxSearchResults = config.maxSearchResults ?? 100;
	const searchTimeoutMs = config.searchTimeoutMs ?? 3e4;
	if (!Number.isSafeInteger(maxSearchResults) || maxSearchResults < 1) throw new TypeError("tool-session-query: maxSearchResults must be a positive safe integer");
	if (!Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 1 || searchTimeoutMs > MAX_TIMER_DELAY_MS) throw new TypeError(`tool-session-query: searchTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`);
	return {
		maxSearchResults,
		searchTimeoutMs
	};
}
//#endregion
export { Config, DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_SEARCH_TIMEOUT_MS, apply, inject, name };
