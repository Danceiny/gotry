import Schema from "@deepseek-ai/schemastery";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { Zip, ZipDeflate } from "fflate";
//#region lib/types/archive.js
/**
* Host-side session-log download: streams one ZIP archive whose files are the
* sessions' stored artifact text verbatim plus every referenced media object.
* The root artifact sits under its original base name (`session.jsonl`); each
* subagent descendant under `subagents/<id>/<filename>`; each image referenced
* by any included log under `media/<attachmentId>.<ext>` (content-addressed,
* so one archive never duplicates a shared image). No manifest is written —
* every file is byte-identical to the backend's durable artifact or attachment
* store and self-describing through its own header line or media type. Before
* each live session's artifact read, the SessionStore flush barrier makes the
* current in-memory log durable; cold sessions need no barrier. Request abort
* and response-consumer cancellation share one producer signal and terminate
* the active compressor.
* Compression runs on the host with fflate's streaming Zip API, so the archive
* bytes are produced incrementally and the host never holds the whole archive
* in one buffer; production waits for consumer pull whenever the response queue
* reaches its byte high-water mark, so a slow consumer bounds accumulation to
* the fixed 64 KiB response queue plus one synchronous fflate push.
* @module
*/
/** Balanced default used when Session export configuration omits a compression level. */
const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL = 6;
/**
* Resolve the persistence, session-query, and attachment services a log export needs.
* @param ctx - the composed host context.
* @returns the export services (absent when the deployment does not mount them).
*/
function sessionLogExportDeps(ctx) {
	return {
		sessionQuery: ctx.get("sessionQuery"),
		sessionPersistence: ctx.get("sessionPersistence"),
		attachments: ctx.get("attachments"),
		sessions: ctx.get("sessions")
	};
}
/**
* Flush one currently live session through the store's authoritative durability
* barrier immediately before its raw artifact is read. A cold or absent id has
* no in-memory work to flush.
* @param deps - export services, including the optional live-session store.
* @param id - the session whose artifact is about to be read.
* @param signal - optional cancellation observed around the flush barrier.
*/
async function flushLiveSessionLog(deps, id, signal) {
	signal?.throwIfAborted();
	const sessions = deps.sessions;
	if (sessions === void 0) return;
	const session = sessions.get(id);
	if (session === void 0) return;
	await sessions.flush(session);
	signal?.throwIfAborted();
}
/** Zip extension for each accepted raster media type. */
const MEDIA_TYPE_EXTENSIONS = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif"
};
/**
* The zip path for one media object: content-addressed by the opaque
* attachment id so shared images land once and the id in the log maps back to
* the archive entry without a manifest.
* @param ref - the durable reference from a session log.
* @returns the archive path.
*/
function mediaEntryPath(ref) {
	return `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`;
}
/**
* Collect every image reference inside one content array, descending into
* nested tool results the way the live attachment route does.
* @param content - an event content array (or nested tool-result content).
* @param refs - the dedupe map being filled (keyed by attachment id).
*/
function collectImageRefs(content, refs) {
	if (!Array.isArray(content)) return;
	const pending = [];
	for (const item of content) pending.push(item);
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const block = value;
		if (block.type === "image" && typeof block.attachment === "object" && block.attachment !== null) {
			const ref = block.attachment;
			refs.set(String(ref.attachmentId), ref);
		}
		if (Array.isArray(block.content)) for (const item of block.content) pending.push(item);
	}
}
/**
* Collect every image reference one session event carries, across the same
* carriers the live attachment route scans (direct content, message content,
* inserted messages, and completed assistant chunk blocks).
* @param event - one parsed JSONL event object.
* @param refs - the dedupe map being filled (keyed by attachment id).
*/
function collectEventImageRefs(event, refs) {
	const data = event.data;
	if (typeof data !== "object" || data === null) return;
	const carrier = data;
	collectImageRefs(carrier.content, refs);
	if (carrier.message !== void 0) collectImageRefs(carrier.message.content, refs);
	if (carrier.inserted !== void 0) for (const message of carrier.inserted) collectImageRefs(message.content, refs);
	if (carrier.chunk?.type === "block-end") collectImageRefs([carrier.chunk.block], refs);
}
/**
* Collect the distinct media references one stored artifact text names.
* Lines that fail to parse cannot reference media and are skipped (the
* artifact text itself is exported verbatim regardless).
* @param content - the stored artifact text.
* @returns the dedupe map keyed by attachment id.
*/
function imageRefsInArtifact(content) {
	const refs = /* @__PURE__ */ new Map();
	for (const line of content.split("\n")) {
		if (line === "") continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		collectEventImageRefs(event, refs);
	}
	return refs;
}
/**
* One safe zip path segment from an untrusted session id. Session ids are
* host-controlled, but the brand allows any non-empty string, so `../`, dot
* segments, and separator characters are neutralized before they can shape
* archive entries. Distinct ids may collapse onto one segment (id collision
* is impossible for the host-minted UUIDs, so no uniqueness suffix is kept).
* @param id - the raw session id.
* @returns a filesystem-safe single path segment.
*/
function safeSessionIdSegment(id) {
	return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
/**
* The export archive filename for one root session.
* @param sessionId - the root session id (sanitized to one safe path segment).
* @returns the attachment filename for the session's export archive.
*/
function sessionLogZipFilename(sessionId) {
	return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`;
}
/**
* Yield the export entries in zip order: the preloaded root artifact first,
* then every subagent descendant in lineage order (each flushed when live,
* read from the persistence backend right before it is yielded, and dropped
* after the consumer moves on), then every distinct media object referenced by any of
* the included logs (read and verified from the attachment store, one archive
* entry per attachment id). The host holds at most one descendant's artifact
* text and one media object at a time beyond the root.
* @param deps - the mounted export services (the caller answered 500 before this runs).
* @param root - the already-read root artifact (read by the caller so the
* missing-session path can answer cleanly before streaming starts).
* @param sessionId - the root session id.
* @param includeDescendants - whether to include every subagent descendant.
* @param signal - optional cancellation forwarded to lineage, persistence, and attachment reads.
* @returns the export entries in zip order.
*/
async function* sessionLogZipEntries(deps, root, sessionId, includeDescendants, signal) {
	const media = /* @__PURE__ */ new Map();
	const rememberMedia = (content) => {
		for (const [id, ref] of imageRefsInArtifact(content)) media.set(id, ref);
	};
	rememberMedia(root.content);
	yield {
		path: root.filename,
		content: root.content
	};
	if (includeDescendants) {
		const seen = new Set([sessionId]);
		const collect = async function* (nodes) {
			for (const node of nodes) {
				signal?.throwIfAborted();
				const id = node.session.header.id;
				if (seen.has(id)) continue;
				seen.add(id);
				await flushLiveSessionLog(deps, id, signal);
				const raw = await deps.sessionPersistence.readRaw(id, signal);
				signal?.throwIfAborted();
				if (raw === void 0) throw new Error(`subagent "${id}" has no stored log artifact`);
				rememberMedia(raw.content);
				yield {
					path: `subagents/${safeSessionIdSegment(id)}/${raw.filename}`,
					content: raw.content
				};
				yield* collect(node.descendants);
			}
		};
		const lineage = await deps.sessionQuery.traceSession(sessionId, signal);
		signal?.throwIfAborted();
		yield* collect(lineage.descendants);
	}
	for (const ref of media.values()) {
		signal?.throwIfAborted();
		const stored = await deps.attachments.readImage(ref, signal);
		signal?.throwIfAborted();
		yield {
			path: mediaEntryPath(ref),
			data: stored.data
		};
	}
}
/** How many code units of artifact text one zip push carries (bounded encode memory). */
const PUSH_CHUNK_CODE_UNITS = 65536;
/** How many bytes of media one zip push carries (bounded memory; images are already size-capped). */
const PUSH_CHUNK_BYTES = 65536;
/** Byte capacity retained by the response stream before ZIP production waits for pull. */
const RESPONSE_HIGH_WATER_MARK_BYTES = 65536;
/** One producer waiter released only when ReadableStream pull restores capacity. */
var ResponseCapacityGate = class {
	releasePending;
	/**
	* Wait until the response queue has positive byte capacity or cancellation wins.
	* @param controller - response controller whose desired size owns capacity.
	* @param signal - combined request/consumer cancellation.
	*/
	async wait(controller, signal) {
		signal.throwIfAborted();
		if (controller.desiredSize === null || controller.desiredSize > 0) return;
		await new Promise((resolve) => {
			const release = () => {
				this.releasePending = void 0;
				signal.removeEventListener("abort", release);
				resolve();
			};
			this.releasePending = release;
			signal.addEventListener("abort", release, { once: true });
		});
		signal.throwIfAborted();
	}
	/** Release the current producer waiter after a consumer pull. */
	pulled() {
		this.releasePending?.();
	}
};
/**
* Push one media object's bytes into a deflate stream in bounded chunks,
* waiting for consumer capacity between chunks like the artifact path does.
* @param deflate - the zip entry's deflate stream.
* @param data - the stored image bytes.
* @param controller - response queue controller.
* @param capacity - pull-driven response-capacity gate.
* @param signal - cancellation; throws when aborted.
*/
async function pushBinaryChunks(deflate, data, controller, capacity, signal) {
	let offset = 0;
	do {
		signal.throwIfAborted();
		const end = Math.min(offset + PUSH_CHUNK_BYTES, data.byteLength);
		const finalChunk = end >= data.byteLength;
		deflate.push(data.subarray(offset, end), finalChunk);
		offset = end;
		await capacity.wait(controller, signal);
	} while (offset < data.byteLength);
}
/**
* Push one artifact's text into a deflate stream in bounded chunks, never
* splitting a surrogate pair across a chunk boundary (a lone high surrogate
* re-encodes as U+FFFD and would silently corrupt the exported artifact).
* @param deflate - the zip entry's deflate stream.
* @param content - the artifact text verbatim.
* @param controller - response queue controller.
* @param capacity - pull-driven response-capacity gate.
* @param signal - cancellation; throws when aborted.
*/
async function pushArtifactChunks(deflate, content, controller, capacity, signal) {
	const encoder = new TextEncoder();
	let offset = 0;
	let finalChunk;
	do {
		signal.throwIfAborted();
		let end = Math.min(offset + PUSH_CHUNK_CODE_UNITS, content.length);
		if (end < content.length && end - offset > 1) {
			const last = content.charCodeAt(end - 1);
			if (last >= 55296 && last <= 56319) end -= 1;
		}
		finalChunk = end >= content.length;
		deflate.push(encoder.encode(content.slice(offset, end)), finalChunk);
		offset = end;
		await capacity.wait(controller, signal);
	} while (!finalChunk);
}
/**
* Stream one session-log ZIP as a WHATWG ReadableStream. The root artifact is
* read and validated by the caller before this is called (missing root or
* missing services answer cleanly before any byte is produced); each entry is
* then encoded and deflated in bounded chunks as it is produced, so the
* archive bytes arrive incrementally. A descendant that fails to read errors
* the stream (fail-loud, never silent under-export).
* @param deps - the mounted export services (the caller answered 500 before this runs).
* @param root - the already-read root artifact (first zip entry).
* @param sessionId - the root session id.
* @param includeDescendants - whether to include every subagent descendant.
* @param compressionLevel - validated fflate DEFLATE level for every ZIP entry.
* @param signal - request cancellation combined with response-consumer cancellation.
* @returns the zip byte stream.
*/
function streamSessionLogZip(deps, root, sessionId, includeDescendants, compressionLevel, signal) {
	const consumerAbort = new AbortController();
	const producerSignal = AbortSignal.any([signal, consumerAbort.signal]);
	let zip;
	let zipTerminated = false;
	const capacity = new ResponseCapacityGate();
	const terminateZip = () => {
		if (zip === void 0 || zipTerminated) return;
		zipTerminated = true;
		zip.terminate();
	};
	return new ReadableStream({
		start(controller) {
			const archive = new Zip((error, data, final) => {
				/* v8 ignore next 3 -- fflate reports only internal zip failures, unreachable for valid inputs */
				if (error) {
					controller.error(error);
					return;
				}
				/* v8 ignore next -- fflate may emit empty chunks; not controllable from tests */
				if (data.byteLength > 0) controller.enqueue(data);
				if (final) controller.close();
			});
			zip = archive;
			(async () => {
				try {
					for await (const entry of sessionLogZipEntries(deps, root, sessionId, includeDescendants, producerSignal)) {
						const deflate = new ZipDeflate(entry.path, { level: compressionLevel });
						archive.add(deflate);
						if ("content" in entry) await pushArtifactChunks(deflate, entry.content, controller, capacity, producerSignal);
						else await pushBinaryChunks(deflate, entry.data, controller, capacity, producerSignal);
					}
					archive.end();
				} catch (error) {
					/* v8 ignore next -- typed backends reject with Error, and DOMException is one in Node */
					terminateZip();
					controller.error(error instanceof Error ? error : new Error(String(error)));
				}
			})();
		},
		pull() {
			capacity.pulled();
		},
		cancel(reason) {
			consumerAbort.abort(reason instanceof Error ? reason : /* @__PURE__ */ new Error("session log export stream cancelled"));
			terminateZip();
		}
	}, {
		highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
		size: (chunk) => chunk.byteLength
	});
}
//#endregion
//#region lib/types/index.js
/** Session-log download command and Host-owned streaming route. */
const name = "session-log-download";
const inject = ["commands", "connection"];
/** Stable browser download path retained across the transport migration. */
const SESSION_LOG_EXPORT_PATH = "/api/session.export";
/** Validate Session-log archive configuration. */
const Config = Schema.object({ compressionLevel: Schema.number().step(1).min(0).max(9).default(6) });
const REQUESTED = {
	kind: "success",
	text: "Session log download requested."
};
/**
* Register the Web-only `/export` command and authenticated ZIP download route.
* @param ctx - Host context carrying the human-command registry.
* @param config - resolved compression policy.
*/
function apply(ctx, config = {}) {
	ctx.effect(() => ctx.commands.register({
		name: "export",
		description: "Download this Session log as a ZIP archive",
		handler: (invocation) => Promise.resolve(invocation.rawInput.trim() === "" ? REQUESTED : {
			kind: "error",
			text: "The Web /export command does not accept a path."
		})
	}), "session-log-download: command");
	connectionOf(ctx).fetch.register({
		path: SESSION_LOG_EXPORT_PATH,
		methods: ["GET", "HEAD"],
		fetch: async (request) => {
			const response = await sessionLogExportResponse(ctx, request, config.compressionLevel ?? 6);
			if (request.method === "GET") return response;
			await response.body?.cancel();
			return new Response(null, {
				status: response.status,
				headers: response.headers
			});
		}
	});
}
function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}
async function sessionLogExportResponse(ctx, request, compressionLevel) {
	const url = new URL(request.url);
	const query = Object.fromEntries(url.searchParams);
	const sessionIdValue = query["sessionId"];
	const descendantsValue = query["includeDescendants"];
	if (sessionIdValue === void 0 || sessionIdValue.length === 0 || descendantsValue !== void 0 && descendantsValue !== "true" && descendantsValue !== "false") return new Response("missing or invalid sessionId query parameter", { status: 400 });
	const sessionId = SessionId(sessionIdValue);
	const deps = sessionLogExportDeps(ctx);
	if (deps.sessionQuery === void 0 || deps.sessionPersistence === void 0 || deps.attachments === void 0) return new Response("session log export is unavailable: missing session-query, session-persistence, or attachments service", { status: 500 });
	if (!deps.sessionPersistence.supportsRawArtifacts) return new Response("session log export is unavailable: the persistence backend does not expose per-session raw artifacts", { status: 501 });
	const ready = {
		sessionQuery: deps.sessionQuery,
		sessionPersistence: deps.sessionPersistence,
		attachments: deps.attachments,
		sessions: deps.sessions
	};
	let root;
	try {
		await flushLiveSessionLog(deps, sessionId, request.signal);
		root = await deps.sessionPersistence.readRaw(sessionId, request.signal);
		request.signal.throwIfAborted();
	} catch {
		request.signal.throwIfAborted();
		return new Response("session log export failed to prepare the stored artifact", { status: 500 });
	}
	if (root === void 0) return new Response("session not found", { status: 404 });
	return new Response(streamSessionLogZip(ready, root, sessionId, descendantsValue === "true", compressionLevel, request.signal), { headers: {
		"content-type": "application/zip",
		"content-disposition": `attachment; filename="${sessionLogZipFilename(sessionId)}"`
	} });
}
//#endregion
export { Config, DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, SESSION_LOG_EXPORT_PATH, apply, flushLiveSessionLog, inject, name, sessionLogExportDeps, sessionLogZipEntries, sessionLogZipFilename, streamSessionLogZip };
