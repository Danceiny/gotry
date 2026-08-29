import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { decodeSeqRanges, decodeStorageRecord } from "@deepseek-ai/dsh-session";
import { LlmAdapter, LlmError, ReasoningEffortId, assertNever, requestImageHandleText, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
//#region lib/types/index.js
/**
* Keyless snapshot-test LLM replay. It derives one model-call script per
* recorded session from `assistant/chunk` events and explicitly marked local
* compaction calls, then binds fresh live sessions to parent/child scripts by
* first-call order. Throw and hang cases require an explicit override because
* a session log cannot reconstruct them alone.
* @module @deepseek-ai/dsh-llm-replay
*/
const PACKED_CHUNK_ROW_TYPES = new Set([
	"text-chunks",
	"reasoning-chunks",
	"tool-call-chunks"
]);
/**
* Parse a session `.jsonl` buffer into its event list. Line 0 is the session
* header (a `{type:'session',…}` record), every subsequent non-empty line is a
* {@link SessionEvent} or a packed chunk row. Packed rows expand back into
* events, and JSONL storage-form provenance ranges expand back into
* `number[]`, so physical fixture encodings derive the same script. The
* header is skipped; malformed lines fail loud.
* @param text - the raw `.jsonl` file contents.
* @returns every event after the header, in log order.
*/
function parseSessionLog(text) {
	const events = [];
	let nextSeq = 0;
	let headerSkipped = false;
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (line.trim().length === 0) continue;
		if (!headerSkipped) {
			headerSkipped = true;
			continue;
		}
		let value;
		try {
			value = JSON.parse(line);
		} catch (error) {
			throw new Error(`session snapshot line ${index + 1} contains invalid JSON`, { cause: error });
		}
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`session snapshot line ${index + 1} must be a JSON object`);
		const record = value;
		const packed = PACKED_CHUNK_ROW_TYPES.has(record.type);
		const seqKey = packed ? "seq0" : "seq";
		const timeKey = packed ? "time0" : "time";
		if (!Object.hasOwn(record, seqKey)) record[seqKey] = nextSeq;
		if (!Object.hasOwn(record, timeKey)) record[timeKey] = 0;
		let decoded;
		try {
			if (Object.hasOwn(record, "sourceEventSeqs")) record.sourceEventSeqs = decodeSeqRanges(record.sourceEventSeqs);
			decoded = decodeStorageRecord(record);
		} catch (error) {
			/* v8 ignore next -- decodeStorageRecord only throws Error instances; the String arm satisfies unknown narrowing. */
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`session snapshot line ${index + 1}: ${detail}`, { cause: error });
		}
		events.push(...decoded);
		nextSeq += decoded.length;
	}
	return events;
}
/**
* Read replay identity, ordering, and fork-seed facts from the JSONL header.
*
* @param text - the raw `.jsonl` file contents (only the header line is read).
* @returns the header's `id`, `createdAt`, and `seedLength`, defaulted when absent.
*/
function parseSessionHeader(text) {
	const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "{}";
	const parsed = JSON.parse(firstLine);
	return {
		id: typeof parsed.id === "string" ? parsed.id : "",
		createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
		seedLength: typeof parsed.seedLength === "number" ? parsed.seedLength : 0
	};
}
/**
* Reconstruct the per-`stream()` replay script from a recorded session log.
*
* Splits `assistant/chunk` events at every `finish`, using turn and step changes
* to detect an unterminated prior call. A `compaction/summary` explicitly marked
* as one local LLM-stream call becomes a canonical successful stream from its
* complete `rawOutput` at the summary's log position. A
* missing assistant terminator means the live stream threw, so derivation
* rejects and the scenario must provide an explicit override. Multiple calls
* may share one turn and step when the loop retries.
* @param events - the recorded session's events.
* @returns one `chunks` entry per recorded model call, in call order.
*/
function deriveReplayScript(events) {
	const script = [];
	let currentKey;
	let current = [];
	const close = (key, chunks) => {
		if (chunks.length === 0) return;
		if (chunks[chunks.length - 1]?.type !== "finish") throw new Error(`llm-replay: model call ${key} ended without a finish chunk (a thrown stream); this scenario needs a replay.override.json sidecar`);
		script.push({
			kind: "chunks",
			chunks
		});
	};
	for (const event of events) {
		if (event.type === "compaction/summary") {
			close(currentKey, current);
			currentKey = void 0;
			current = [];
			const persisted = event.data;
			if (persisted.llmStreamCall === true) {
				if (persisted.rawOutput === void 0) throw new Error("llm-replay: compaction/summary marks an LLM stream call without rawOutput");
				const chunks = [];
				for (const [index, block] of persisted.rawOutput.entries()) {
					chunks.push({
						type: "block-start",
						index,
						blockType: block.type
					});
					chunks.push({
						type: "block-end",
						index,
						block
					});
				}
				if (persisted.usage !== void 0) chunks.push({
					type: "usage",
					usage: persisted.usage
				});
				chunks.push({
					type: "finish",
					reason: { kind: "stop" }
				});
				script.push({
					kind: "chunks",
					chunks
				});
			}
			continue;
		}
		if (event.type !== "assistant/chunk") continue;
		const { turn, step, chunk } = event.data;
		const key = `${turn}/${step}`;
		if (current.length > 0 && key !== currentKey) close(currentKey, current);
		if (current.length === 0) currentKey = key;
		current.push(chunk);
		if (chunk.type === "finish") {
			close(currentKey, current);
			currentKey = void 0;
			current = [];
		}
	}
	close(currentKey, current);
	return script;
}
const REPLAY_CHUNK_TYPES = new Set([
	"block-start",
	"text-delta",
	"reasoning-delta",
	"tool-call-delta",
	"block-end",
	"usage",
	"finish"
]);
const FROM_REQUEST_OPEN = "{{fromRequest:";
const FROM_REQUEST_CLOSE = "}}";
/** Collect every string leaf of one JSON-compatible value, in traversal order. */
function collectStrings(value, out) {
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out);
		return;
	}
	if (value !== null && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
}
/** Resolve one placeholder pattern against the request corpus; the LAST match wins. */
function resolveFromRequest(pattern, corpus) {
	let regex;
	try {
		regex = new RegExp(pattern, "g");
	} catch (error) {
		throw new Error(`llm-replay: fromRequest has an invalid pattern ${JSON.stringify(pattern)}: ${String(error)}`);
	}
	let last;
	for (const match of corpus.matchAll(regex)) last = match;
	if (last === void 0) throw new Error(`llm-replay: fromRequest pattern ${JSON.stringify(pattern)} matched nothing in the request`);
	return last[1] ?? last[0];
}
/** Replace every `{{fromRequest:<pattern>}}` occurrence in one scripted string. */
function substituteString(text, corpus) {
	let result = "";
	let cursor = 0;
	while (true) {
		const open = text.indexOf(FROM_REQUEST_OPEN, cursor);
		if (open === -1) return result + text.slice(cursor);
		let close = text.indexOf(FROM_REQUEST_CLOSE, open + 14);
		if (close === -1) throw new Error(`llm-replay: fromRequest placeholder is unterminated in ${JSON.stringify(text)}`);
		while (text[close + 2] === "}") close += 1;
		const pattern = text.slice(open + 14, close);
		result += text.slice(cursor, open) + resolveFromRequest(pattern, corpus);
		cursor = close + 2;
	}
}
/** Deep-copy one JSON-compatible value with scripted placeholders resolved. */
function substituteValue(value, corpus) {
	if (typeof value === "string") return value.includes(FROM_REQUEST_OPEN) ? substituteString(value, corpus) : value;
	if (Array.isArray(value)) return value.map((item) => substituteValue(item, corpus));
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteValue(item, corpus)]));
	return value;
}
/**
* Resolve every `{{fromRequest:<regex>}}` placeholder in one scripted entry
* against the live request. The corpus is every string leaf of the request
* messages joined by newlines; the pattern's LAST corpus match wins and its
* first capture group (or, without one, the whole match) substitutes in place.
* Scenario sidecars use this to script arguments no static file can know,
* such as a randomly minted goal id the model must echo back. A pattern that
* matches nothing, an invalid pattern, and an unterminated placeholder each
* fail loud. The last two braces of a consecutive `}` run terminate the
* placeholder, so a pattern may end with a brace quantifier but cannot
* contain `}}` followed by further pattern content. Derived entries pass
* through the same resolution as sidecar entries.
* @param entry - the scripted entry about to replay.
* @param messages - the live request messages searched by the placeholders.
* @returns the entry itself when no placeholder appears, else a resolved deep copy.
*/
function resolveScriptedEntry(entry, messages) {
	if (!JSON.stringify(entry).includes(FROM_REQUEST_OPEN)) return entry;
	const leaves = [];
	collectStrings(messages, leaves);
	return substituteValue(entry, leaves.join("\n"));
}
/** Replace typed recorded-session tokens with the live sessions bound at the same corpus indexes. */
function materializeSessionTokens(entry, liveSessionIds) {
	if (!JSON.stringify(entry).includes("{{session:")) return entry;
	const replace = (value) => {
		if (typeof value === "string") return value.replace(/\{\{session:([1-9]\d*)\}\}/g, (_token, ordinal) => {
			const live = liveSessionIds[Number(ordinal) - 1];
			if (live === void 0) throw new Error(`llm-replay: session token {{session:${ordinal}}} was used before that recorded session bound`);
			return live;
		});
		if (Array.isArray(value)) return value.map(replace);
		if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
		return value;
	};
	return replace(entry);
}
/** Learn a background child id from the stable tool-result text before that child reaches its first model call. */
function inferStartedSubagents(messages, liveSessionIds) {
	const leaves = [];
	collectStrings(messages, leaves);
	for (const leaf of leaves) for (const match of leaf.matchAll(/started subagent ([^\s"'<>]+)/g)) {
		const id = match[1];
		/* v8 ignore next -- the fixed regular expression always has capture group 1. */
		if (id === void 0 || liveSessionIds.includes(id)) continue;
		const index = liveSessionIds.findIndex((value, candidate) => candidate > 0 && value === void 0);
		if (index < 0) return;
		liveSessionIds[index] = id;
	}
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function invalidOverride(file, location, detail) {
	throw new Error(`llm-replay: invalid override ${file}: ${location} ${detail}`);
}
function readChunks(value, file, location) {
	if (!Array.isArray(value)) invalidOverride(file, location, "chunks must be an array");
	for (const [index, chunk] of value.entries()) if (!isRecord(chunk) || typeof chunk["type"] !== "string" || !REPLAY_CHUNK_TYPES.has(chunk["type"])) invalidOverride(file, `${location}.chunks[${index}]`, "must have a known StreamChunk type");
	return value;
}
function readReplayEntry(value, file, location) {
	if (!isRecord(value)) invalidOverride(file, location, "must be an object");
	switch (value["kind"]) {
		case "chunks":
			if (!hasExactKeys(value, ["kind", "chunks"])) invalidOverride(file, location, "has invalid chunks-entry fields");
			return {
				kind: "chunks",
				chunks: readChunks(value["chunks"], file, location)
			};
		case "throw": {
			const accepted = value["accepted"];
			if (!hasExactKeys(value, accepted === void 0 ? [
				"kind",
				"chunks",
				"message",
				"code"
			] : [
				"kind",
				"chunks",
				"message",
				"code",
				"accepted"
			])) invalidOverride(file, location, "has invalid throw-entry fields");
			if (typeof value["message"] !== "string" || value["message"].length === 0) invalidOverride(file, location, "message must be a non-empty string");
			if (typeof value["code"] !== "string" || value["code"].length === 0) invalidOverride(file, location, "code must be a non-empty string");
			if (accepted !== void 0 && typeof accepted !== "boolean") invalidOverride(file, location, "accepted must be a boolean");
			return {
				kind: "throw",
				chunks: readChunks(value["chunks"], file, location),
				message: value["message"],
				code: value["code"],
				...accepted === void 0 ? {} : { accepted }
			};
		}
		case "hang": {
			const readyFile = value["readyFile"];
			if (!hasExactKeys(value, readyFile === void 0 ? ["kind"] : ["kind", "readyFile"])) invalidOverride(file, location, "has invalid hang-entry fields");
			if (readyFile !== void 0 && (typeof readyFile !== "string" || readyFile.length === 0)) invalidOverride(file, location, "readyFile must be a non-empty string");
			return {
				kind: "hang",
				...readyFile === void 0 ? {} : { readyFile }
			};
		}
		default: return invalidOverride(file, location, `has unknown kind ${JSON.stringify(value["kind"])}`);
	}
}
function readOverrideDoc(value, file) {
	if (Array.isArray(value)) return value.map((entry, index) => readReplayEntry(entry, file, `entry ${index}`));
	if (!isRecord(value) || !hasExactKeys(value, ["patches"]) || !Array.isArray(value["patches"])) return invalidOverride(file, "document", "must be a ReplayEntry[] or { patches: [...] }");
	return { patches: value["patches"].map((value, index) => {
		const location = `patch ${index}`;
		if (!isRecord(value) || !hasExactKeys(value, ["at", "entry"])) return invalidOverride(file, location, "must contain exactly at and entry");
		const at = value["at"];
		if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return invalidOverride(file, location, "at must be a non-negative safe integer");
		return {
			at,
			entry: readReplayEntry(value["entry"], file, `${location}.entry`)
		};
	}) };
}
/**
* Load the PRIMARY session's replay script: the sidecar override when present
* (whole-script replacement or `{ patches }` augmentation over the derived
* script), else the script derived from the session JSONL (fail-loud when the
* fixture is missing).
* @param config - the fixture paths; only `file` and `overrideFile` are consulted.
* @returns the resolved primary-session script.
*/
function loadReplayScript(config) {
	if (config.overrideFile !== void 0 && existsSync(config.overrideFile)) {
		const doc = readOverrideDoc(JSON.parse(readFileSync(config.overrideFile, "utf8")), config.overrideFile);
		if (Array.isArray(doc)) return doc;
		const script = deriveScriptFromFile(config.file);
		const derivedLength = script.length;
		const seenIndexes = /* @__PURE__ */ new Set();
		for (const patch of doc.patches) {
			if (patch.at > derivedLength) throw new Error(`llm-replay: override patch index ${String(patch.at)} out of range (derived script has ${derivedLength} call(s); == length appends): ${config.overrideFile}`);
			if (seenIndexes.has(patch.at)) throw new Error(`llm-replay: duplicate override patch index ${patch.at}: ${config.overrideFile}`);
			seenIndexes.add(patch.at);
			script[patch.at] = patch.entry;
		}
		return script;
	}
	return deriveScriptFromFile(config.file);
}
/** Derive the primary script from the session JSONL, failing loud on a missing fixture. */
function deriveScriptFromFile(file) {
	if (!existsSync(file)) throw new Error(`llm-replay: fixture not found: ${file} — run \`pnpm run test:snapshot:record\` first`);
	return deriveReplayScript(parseSessionLog(readFileSync(file, "utf8")));
}
/**
* Load the primary and child scripts in bind order. Child derivation begins at
* `seedLength` so inherited parent chunks are never replayed as child calls.
*
* @param config - the fixture paths: the primary log plus any recorded child logs.
* @returns the primary script first, then the child scripts in bind order.
*/
function loadSessionScripts(config) {
	const primaryEntries = loadReplayScript(config);
	const primaryHeader = existsSync(config.file) ? parseSessionHeader(readFileSync(config.file, "utf8")) : {
		id: "",
		createdAt: 0
	};
	const primary = {
		recordedId: primaryHeader.id,
		createdAt: primaryHeader.createdAt,
		entries: primaryEntries,
		primary: true
	};
	const children = [];
	for (const childFile of config.childFiles ?? []) {
		if (!existsSync(childFile)) throw new Error(`llm-replay: child fixture not found: ${childFile} — re-record the scenario`);
		const text = readFileSync(childFile, "utf8");
		const header = parseSessionHeader(text);
		const ownEvents = parseSessionLog(text).slice(header.seedLength);
		children.push({
			recordedId: header.id,
			createdAt: header.createdAt,
			entries: deriveReplayScript(ownEvents),
			primary: false
		});
	}
	children.sort((a, b) => a.createdAt - b.createdAt || a.recordedId.localeCompare(b.recordedId));
	return [primary, ...children];
}
/** Replay adapter that makes a configured provider catalog discoverable without provider I/O. */
var ReplayAdapter = class extends LlmAdapter {
	replay;
	providers;
	constructor(providers, replay) {
		super();
		this.replay = replay;
		this.providers = new Map(providers.map((provider) => [provider.id, provider]));
	}
	providerInfo(provider) {
		const configured = this.providers.get(provider);
		/* v8 ignore next -- LlmRuntime only asks about routes registered from this same map. */
		if (configured === void 0) return super.providerInfo(provider);
		return {
			id: provider,
			name: configured.name ?? provider
		};
	}
	providerRetryPolicy(provider) {
		const configured = this.providers.get(provider);
		/* v8 ignore next -- LlmRuntime only asks about routes registered from this same map. */
		if (configured === void 0) return super.providerRetryPolicy(provider);
		return configured.retryPolicy === void 0 ? void 0 : resolveRetryPolicy(configured.retryPolicy, `llm-replay: provider "${provider}" retryPolicy`);
	}
	imageRequestPricing(provider, model) {
		const visualTokens = this.providers.get(provider)?.models?.find((candidate) => candidate.id === model)?.imageRequestTokens;
		if (visualTokens === void 0) return void 0;
		return { priceImages: (images) => images.map((ref) => ({
			visualTokens,
			text: requestImageHandleText(ref, {
				width: ref.width,
				height: ref.height
			})
		})) };
	}
	listModels(provider) {
		const configured = this.providers.get(provider);
		/* v8 ignore next -- LlmRuntime only asks about routes registered from this same map. */
		if (configured === void 0) return Promise.resolve([]);
		return Promise.resolve((configured.models ?? []).map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			...model.description === void 0 ? {} : { description: model.description },
			...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] }
		})));
	}
	resolveModel(provider, model) {
		const configured = this.providers.get(provider);
		/* v8 ignore next -- LlmRuntime only asks about routes registered from this same map. */
		if (configured === void 0) return Promise.resolve({
			provider,
			id: model,
			name: model
		});
		const configuredModel = configured.models?.find((candidate) => candidate.id === model);
		return Promise.resolve({
			provider,
			id: model,
			name: configuredModel?.name ?? model,
			...configuredModel?.description === void 0 ? {} : { description: configuredModel.description },
			...configuredModel?.inputModalities === void 0 ? {} : { inputModalities: [...configuredModel.inputModalities] },
			...configuredModel?.contextWindow === void 0 ? {} : { context: { contextWindow: configuredModel.contextWindow } },
			...configuredModel?.defaultMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredModel.defaultMaxTokens },
			...configuredModel?.reasoningEfforts === void 0 ? {} : { reasoning: {
				efforts: configuredModel.reasoningEfforts.map((id) => ({
					id: ReasoningEffortId(id),
					name: id
				})),
				...configuredModel.defaultReasoningEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(configuredModel.defaultReasoningEffort) }
			} }
		});
	}
	stream(options) {
		return this.replay(options);
	}
};
/**
* Wait `paceMs` between chunk yields, aborting the wait (and the stream) the
* moment the signal fires — a paced replay must cancel as promptly as a burst
* one.
*/
function paceDelay(paceMs, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, paceMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** Yield a recorded stream back, honoring abort like a real adapter. */
async function* replayEntry(entry, signal, paceMs) {
	switch (entry.kind) {
		case "chunks":
			for (const chunk of entry.chunks) {
				if (signal?.aborted) throw new Error("aborted");
				if (paceMs > 0) await paceDelay(paceMs, signal);
				yield chunk;
			}
			return;
		case "throw":
			for (const chunk of entry.chunks) {
				if (signal?.aborted) throw new Error("aborted");
				if (paceMs > 0) await paceDelay(paceMs, signal);
				yield chunk;
			}
			throw new LlmError(entry.message, entry.code);
		case "hang":
			yield {
				type: "block-start",
				index: 0,
				blockType: "text"
			};
			yield {
				type: "text-delta",
				index: 0,
				text: "partial"
			};
			if (entry.readyFile !== void 0) writeFileSync(entry.readyFile, "");
			await new Promise((_resolve, reject) => {
				if (signal?.aborted) {
					reject(/* @__PURE__ */ new Error("aborted"));
					return;
				}
				signal?.addEventListener("abort", () => {
					reject(/* @__PURE__ */ new Error("aborted"));
				}, { once: true });
			});
			/* v8 ignore next -- unreachable: the hang promise only ever rejects (on abort), never resolves; control never reaches here */
			return;
		/* v8 ignore next -- sidecar entries are validated before they reach the closed local union. */
		default: return assertNever(entry, "llm-replay replay entry");
	}
}
/** Whether the scripted provider call reached the live adapter's post-2xx commit point. */
function providerAccepted(entry) {
	switch (entry.kind) {
		case "chunks":
		case "hang": return true;
		case "throw": return entry.accepted ?? entry.chunks.length > 0;
		/* v8 ignore next -- override parsing and derived entries close the local union before replay. */
		default: return assertNever(entry, "llm-replay acceptance entry");
	}
}
/**
* Install per-session positional replay. A newly seen live session takes the
* next ordered recorded script, then advances its own cursor synchronously at
* invocation time; calls without `sessionId` share one anonymous session. A
* non-empty provider catalog registers a routed replay adapter; otherwise a
* catch-all waterfall intercepts requests.
*
* @param ctx - the context whose LLM service receives the replay route or waterfall.
* @param config - the resolved fixture paths (env-var defaulting is `apply`'s job).
* @returns the {@link ReplayHandle} carrying the disposer and the teardown consumption check.
*/
function installLlmReplay(ctx, config) {
	const paceMs = config.paceMs ?? 0;
	if (!Number.isInteger(paceMs) || paceMs < 0) throw new Error(`llm-replay: paceMs must be a non-negative integer, got ${String(config.paceMs)}`);
	const scripts = loadSessionScripts(config);
	const bound = /* @__PURE__ */ new Map();
	const liveSessionIds = Array.from({ length: scripts.length });
	let nextScript = 0;
	const ANON = "\0anon\0";
	const replay = (options) => {
		const key = options.sessionId ?? ANON;
		let state = bound.get(key);
		let unrecorded = false;
		if (state === void 0) {
			const script = scripts[nextScript];
			if (script === void 0) {
				unrecorded = true;
				state = {
					entries: [],
					cursor: 0
				};
			} else {
				const scriptIndex = nextScript;
				nextScript++;
				state = {
					entries: script.entries,
					cursor: 0
				};
				bound.set(key, state);
				if (key !== ANON) liveSessionIds[scriptIndex] = key;
			}
		}
		const boundState = state;
		const seenSessions = nextScript;
		const totalScripts = scripts.length;
		const index = boundState.cursor++;
		const entry = boundState.entries[index];
		return (async function* () {
			if (unrecorded) throw new Error(`llm-replay: a model call arrived from an unrecorded session (#${seenSessions + 1}); the scenario recorded only ${totalScripts} session(s) — re-record it`);
			if (entry === void 0) throw new Error(`llm-replay: script exhausted — session requested model call #${index + 1} but its script has only ${boundState.entries.length}; re-record the scenario`);
			inferStartedSubagents(options.messages, liveSessionIds);
			const resolved = resolveScriptedEntry(materializeSessionTokens(entry, liveSessionIds), options.messages);
			if (options.provider === "deepseek-official" && providerAccepted(resolved)) {
				const extensions = ctx.get("deepseekLlmApiExtensions");
				if (extensions !== void 0) {
					const signal = options.signal ?? new AbortController().signal;
					await (await extensions.prepare({
						body: { messages: [] },
						signal,
						...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },
						...options.purpose === void 0 ? {} : { purpose: options.purpose }
					})).accept();
				}
			}
			yield* replayEntry(resolved, options.signal, paceMs);
		})();
	};
	const providers = config.providers ?? [];
	return {
		dispose: providers.length > 0 ? ctx.llm.registerAdapter(providers.map((provider) => provider.id), new ReplayAdapter(providers, replay)) : ctx.on("llm/stream", (options, _next) => replay(options)),
		assertConsumed() {
			const problems = [];
			if (nextScript < scripts.length) problems.push(`${scripts.length - nextScript} recorded script(s) never bound to a live session`);
			for (const [key, state] of bound) if (state.cursor < state.entries.length) {
				const who = key === ANON ? "the anonymous session" : `session ${key}`;
				problems.push(`${who} consumed ${state.cursor}/${state.entries.length} recorded call(s)`);
			}
			if (problems.length > 0) throw new Error(`llm-replay: fixture not fully consumed — ${problems.join("; ")}; the scenario drove fewer model calls than recorded`);
		}
	};
}
const name = "llm-replay";
const inject = ["llm"];
function validateConfiguredModels(providers) {
	for (const provider of providers ?? []) for (const model of provider.models ?? []) {
		const modalities = model.inputModalities;
		if (modalities !== void 0 && (!Array.isArray(modalities) || !modalities.every((modality) => modality === "text" || modality === "image"))) throw new Error(`llm-replay: provider "${provider.id}" model "${model.id}" inputModalities must be an array containing only "text" and "image"`);
		const imageRequestTokens = model.imageRequestTokens;
		if (imageRequestTokens !== void 0 && (!Number.isSafeInteger(imageRequestTokens) || imageRequestTokens <= 0)) throw new Error(`llm-replay: provider "${provider.id}" model "${model.id}" imageRequestTokens must be a positive safe integer`);
		if (imageRequestTokens !== void 0 && model.inputModalities?.includes("image") !== true) throw new Error(`llm-replay: provider "${provider.id}" model "${model.id}" imageRequestTokens requires inputModalities to include "image"`);
	}
}
function apply(ctx, config = {}) {
	const file = config.file ?? process.env.DSH_SNAPSHOT_FILE;
	if (file === void 0 || file.length === 0) throw new Error("llm-replay: a fixture path is required (Config.file or $DSH_SNAPSHOT_FILE)");
	validateConfiguredModels(config.providers);
	const overrideFile = config.overrideFile ?? process.env.DSH_SNAPSHOT_OVERRIDE;
	const childEnv = process.env.DSH_SNAPSHOT_CHILD_FILES;
	const childFiles = config.childFiles ?? (childEnv !== void 0 && childEnv.length > 0 ? childEnv.split(delimiter) : []);
	installLlmReplay(ctx, {
		file,
		...overrideFile !== void 0 && overrideFile.length > 0 ? { overrideFile } : {},
		...childFiles.length > 0 ? { childFiles } : {},
		...config.providers !== void 0 ? { providers: config.providers } : {},
		...config.paceMs !== void 0 ? { paceMs: config.paceMs } : {}
	});
}
//#endregion
export { apply, deriveReplayScript, inject, installLlmReplay, loadReplayScript, loadSessionScripts, name, parseSessionHeader, parseSessionLog, resolveScriptedEntry };
