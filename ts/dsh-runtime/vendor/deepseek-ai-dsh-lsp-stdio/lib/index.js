import z from "@deepseek-ai/schemastery";
import { LspError, LspProviderId } from "@deepseek-ai/dsh-lsp";
import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { Buffer as Buffer$1 } from "node:buffer";
import { assertNever } from "@deepseek-ai/dsh-llm";
//#region lib/types/abort.js
/**
* Shared cancellation helpers for the local LSP provider's host-I/O, queue, and protocol phases.
* @module @deepseek-ai/dsh-lsp-stdio/abort
*/
/**
* Build an abort Error carrying the signal's reason and preserving timeout classification.
* @param signal - the aborted signal whose reason to surface.
* @returns the timeout reason if present, else the Error reason, else a generic aborted Error.
*/
function abortError(signal) {
	const timeout = timeoutOf(signal);
	if (timeout !== void 0) return timeout;
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return /* @__PURE__ */ new Error("LSP query aborted");
}
/**
* Throw the signal's classified abort error when it has already fired.
* @param signal - the optional query cancellation signal.
*/
function throwIfAborted(signal) {
	if (signal?.aborted) throw abortError(signal);
}
/**
* Await work while allowing a query signal to abandon its wait; the underlying work keeps its own
* handlers and continues to its owner-defined quiescence boundary.
* @param work - the owned asynchronous work.
* @param signal - optional query cancellation.
* @returns the work result, or a rejection carrying the classified abort reason.
*/
function abortable(work, signal) {
	if (signal === void 0) return work;
	if (signal.aborted) return Promise.reject(abortError(signal));
	const canceled = Promise.withResolvers();
	const onAbort = () => {
		canceled.reject(abortError(signal));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	const normalized = work.catch((error) => {
		/* v8 ignore next -- owned LSP promises reject with Error; coercion defends the generic helper. */
		throw error instanceof Error ? error : new Error(String(error));
	});
	return Promise.race([normalized, canceled.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}
//#endregion
//#region lib/types/host.js
/** Filesystem-seam source access for the generic stdio LSP provider. */
/**
* Resolve and validate one workspace through `ctx.fs`.
* @param fs - filesystem provider sharing the language server's execution world.
* @param workspaceRoot - caller-supplied workspace path.
* @param signal - optional cancellation around provider operations.
* @returns stable identity plus process path and file URI.
*/
async function canonicalizeWorkspace(fs, workspaceRoot, signal) {
	throwIfAborted(signal);
	let target;
	try {
		target = await fs.resolve(workspaceRoot, signal === void 0 ? {} : { signal });
	} catch (error) {
		throwIfAborted(signal);
		throw new Error(`workspace root "${workspaceRoot}" cannot be resolved: ${messageOf(error)}`, { cause: error });
	}
	throwIfAborted(signal);
	const info = await fs.stat(target, signal).catch((error) => {
		throwIfAborted(signal);
		throw error;
	});
	throwIfAborted(signal);
	if (info?.type !== "directory") throw new Error(`workspace root "${workspaceRoot}" is not a directory`);
	return {
		target,
		canonicalPath: fs.processPath(target),
		fileUrl: fs.fileUrl(target)
	};
}
/**
* Resolve, contain, and read one byte-bounded query source through `ctx.fs`.
* This layer owns the LSP-specific complete-document cap while the filesystem
* provider owns streaming, regular-file checks, and UTF-8 validation.
* @param fs - filesystem provider sharing the server's execution world.
* @param filePath - absolute source path or path relative to `workspace`.
* @param workspace - already-canonical workspace.
* @param maxDocumentBytes - largest complete source accepted by this host.
* @param signal - optional cancellation.
* @returns canonical file URI and current text.
*/
async function readHostSource(fs, filePath, workspace, maxDocumentBytes, signal) {
	throwIfAborted(signal);
	let target;
	try {
		target = await fs.resolve(filePath, {
			cwd: workspace.canonicalPath,
			...signal === void 0 ? {} : { signal }
		});
	} catch (error) {
		throwIfAborted(signal);
		throw new Error(`source "${filePath}" cannot be resolved: ${messageOf(error)}`, { cause: error });
	}
	throwIfAborted(signal);
	if (!fs.contains(workspace.target, target)) throw new Error(`source "${filePath}" resolves outside the workspace`);
	const chunks = [];
	let bytes = 0;
	try {
		const stream = await fs.streamText(target, signal);
		for await (const chunk of stream) {
			throwIfAborted(signal);
			bytes += Buffer$1.byteLength(chunk);
			if (bytes > maxDocumentBytes) break;
			chunks.push(chunk);
		}
	} catch (error) {
		throwIfAborted(signal);
		throw new Error(`source "${filePath}" could not be read: ${messageOf(error)}`, { cause: error });
	}
	if (bytes > maxDocumentBytes) throw new Error(`source "${filePath}" exceeds the ${maxDocumentBytes}-byte limit; reading stopped after ${bytes} bytes`);
	throwIfAborted(signal);
	return {
		fileUrl: fs.fileUrl(target),
		text: chunks.join("")
	};
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region lib/types/framing.js
/**
* LSP base-protocol framing: `Content-Length`-delimited JSON-RPC over a byte stream. The encoder
* produces one framed buffer; the decoder buffers incoming bytes and yields complete message bodies,
* bounding the header and total message size so a hostile or broken server cannot exhaust memory.
* @module @deepseek-ai/dsh-lsp-stdio/framing
*/
/** The header/body separator in the LSP base protocol. */
const HEADER_SEPARATOR = "\r\n\r\n";
/** Cap on the header section so a server that never sends the separator cannot grow the buffer forever. */
const MAX_HEADER_BYTES = 65536;
/**
* Encode one JSON-RPC message as a framed LSP buffer (`Content-Length: N\r\n\r\n<utf-8 json>`).
* @param message - the JSON-RPC message object to serialize.
* @returns the framed bytes ready to write to the server's stdin.
*/
function encodeMessage(message) {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
	return Buffer.concat([header, body]);
}
/**
* A streaming decoder for `Content-Length`-framed JSON-RPC. Feed it stdout chunks; it returns any
* whole message bodies that completed. It parses only the `Content-Length` header and ignores other
* headers (e.g. `Content-Type`), matching the base protocol.
*/
var MessageDecoder = class {
	buffer = Buffer.alloc(0);
	maxMessageBytes;
	/**
	* @param maxMessageBytes - reject any single framed body larger than this (guards memory).
	*/
	constructor(maxMessageBytes) {
		this.maxMessageBytes = maxMessageBytes;
	}
	/**
	* Append a chunk and return every message body that is now complete.
	* @param chunk - raw bytes from the server's stdout.
	* @returns the parsed JSON bodies, in arrival order (possibly empty).
	* @throws Error when a header is malformed or a body exceeds `maxMessageBytes`.
	*/
	push(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const messages = [];
		for (;;) {
			const step = this.next();
			if (!step.ready) break;
			messages.push(step.message);
		}
		return messages;
	}
	/** Parse and consume the next complete message, or report that more bytes are needed. */
	next() {
		const separator = this.buffer.indexOf(HEADER_SEPARATOR);
		if (separator < 0) {
			if (this.buffer.length > MAX_HEADER_BYTES) throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes without a terminator`);
			return { ready: false };
		}
		if (separator > MAX_HEADER_BYTES) throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes`);
		const contentLength = parseContentLength(this.buffer.toString("ascii", 0, separator));
		if (contentLength > this.maxMessageBytes) throw new Error(`LSP message length ${contentLength} exceeds the ${this.maxMessageBytes}-byte limit`);
		const bodyStart = separator + 4;
		const bodyEnd = bodyStart + contentLength;
		if (this.buffer.length < bodyEnd) return { ready: false };
		const body = this.buffer.toString("utf8", bodyStart, bodyEnd);
		this.buffer = this.buffer.subarray(bodyEnd);
		try {
			return {
				ready: true,
				message: JSON.parse(body)
			};
		} catch (error) {
			/* v8 ignore next -- JSON.parse throws a SyntaxError (an Error); the String() fallback is defensive. */
			throw new Error(`LSP message body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
};
/** Read the `Content-Length` header value (case-insensitive), rejecting a missing or non-numeric one. */
function parseContentLength(headerText) {
	for (const line of headerText.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
		const value = Number(line.slice(colon + 1).trim());
		if (!Number.isInteger(value) || value < 0) throw new Error(`invalid Content-Length header: ${JSON.stringify(line)}`);
		return value;
	}
	throw new Error(`LSP header block missing Content-Length: ${JSON.stringify(headerText)}`);
}
//#endregion
//#region lib/types/connection.js
/**
* A JSON-RPC endpoint over one language server spawned through the subprocess
* capability. Owns id correlation, outbound requests/notifications, and inbound
* server→client requests: it answers `workspace/configuration` from static
* config, and rejects `workspace/applyEdit` (this host never applies edits or
* runs commands). It caps stderr, surfaces framing/decoder failures as a
* fatal close, and exposes tree-scoped termination through the handle so the
* instance owns teardown; group/tree mechanics live in the subprocess
* Service Provider.
* @module @deepseek-ai/dsh-lsp-stdio/connection
*/
const writeConnectionMessage = (stdin, message, done) => {
	stdin.write(encodeMessage(message), done);
};
/** A live JSON-RPC endpoint bound to one child process. */
var LspConnection = class {
	onServerRequest;
	writer;
	handle;
	stdin;
	decoder;
	pending = /* @__PURE__ */ new Map();
	nextId = 1;
	closeReason;
	/** Set once the process has fully exited; the instance awaits it during teardown. */
	closed;
	/**
	* @param spec - how to launch the server and answer its config requests.
	* @param spawner - the subprocess seam's spawn (the provider passes `ctx.subprocess.spawn`).
	* @param onServerRequest - answers a server→client request; rejects to send an error response.
	* @param writer - message writer; tests inject callback failures without relying on OS pipe races.
	*/
	constructor(spec, spawner, onServerRequest, writer = writeConnectionMessage) {
		this.onServerRequest = onServerRequest;
		this.writer = writer;
		this.decoder = new MessageDecoder(spec.maxMessageBytes);
		this.handle = spawner({
			argv: [spec.command, ...spec.args],
			cwd: spec.cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: { maxBytes: spec.maxStderrBytes }
			},
			graceMs: spec.killGraceMs,
			env: spec.env
		});
		/* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
		if (this.handle.stdin === void 0 || this.handle.stdout === void 0) throw new Error("lsp-stdio: subprocess implementation dropped a piped protocol stream");
		/* v8 ignore stop */
		this.stdin = this.handle.stdin;
		this.closed = new Promise((resolve) => {
			const close = () => {
				const reason = this.closeReason ?? new Error(this.exitMessage());
				this.closeReason = reason;
				this.failAll(reason);
				resolve();
			};
			this.handle.done.then(close, (error) => {
				this.fail(asError(error));
				close();
			});
		});
		this.stdin.on("error", (error) => {
			this.fail(error);
		});
		this.handle.stdout.on("data", (chunk) => {
			this.onStdout(chunk);
		});
	}
	/** The child's pid, or `-1` when the spawn produced no pid (so signalling is a no-op). */
	get pid() {
		return this.handle.pid;
	}
	/** The retained stderr tail, for diagnostics on a failed server. */
	get stderrTail() {
		/* v8 ignore next -- the collect disposition always exposes a stderr reader; defensive. */
		return this.handle.collected.stderr?.readFrom(0).text ?? "";
	}
	/** Whether the transport has failed even if the child close event has not arrived yet. */
	get failed() {
		return this.closeReason !== void 0;
	}
	/**
	* Test whether a caught error is this connection's retained fatal transport cause.
	* @param error - error caught by the instance or provider.
	* @returns `true` only when this connection produced that exact failure.
	*/
	failedWith(error) {
		return this.closeReason === error;
	}
	/**
	* Send a request and await its result.
	* @param method - the JSON-RPC method.
	* @param params - the request params.
	* @returns the response result; rejects on an error response, write failure, or close.
	*/
	request(method, params) {
		const id = this.nextId++;
		const promise = new Promise((resolve, reject) => {
			if (this.closeReason !== void 0) {
				reject(this.closeReason);
				return;
			}
			this.pending.set(id, {
				resolve,
				reject
			});
			this.write({
				jsonrpc: "2.0",
				id,
				method,
				params
			}).catch(() => {});
		});
		promise.catch(() => {});
		return promise;
	}
	/**
	* Send a notification (no id, no response).
	* @param method - the JSON-RPC method.
	* @param params - the notification params.
	* @returns a promise that settles when the framed notification has been written.
	*/
	notify(method, params) {
		return this.write({
			jsonrpc: "2.0",
			method,
			params
		});
	}
	/**
	* Send a `$/cancelRequest` for an in-flight request id (best-effort; ignores write failure).
	* @param requestId - the numeric id of the request to cancel.
	*/
	cancel(requestId) {
		this.write({
			jsonrpc: "2.0",
			method: "$/cancelRequest",
			params: { id: requestId }
		}).catch(() => {});
	}
	/**
	* The id the NEXT `request()` will use, so the instance can pre-arm a cancel.
	* @returns the numeric id the next request will be assigned.
	*/
	peekNextId() {
		return this.nextId;
	}
	/** Terminate the server's process tree (the seam's SIGTERM→grace→SIGKILL escalation; idempotent). */
	terminate() {
		this.handle.terminate();
	}
	/**
	* Wait until the owned process tree has exited.
	* @param signal - optional bound for the wait.
	* @returns `true` when the tree exited, or `false` when the signal aborted first.
	*/
	async waitForProcessTreeExit(signal) {
		return await this.handle.waitForExit(signal);
	}
	onStdout(chunk) {
		let messages;
		try {
			messages = this.decoder.push(chunk);
		} catch (error) {
			this.fail(asError(error));
			this.handle.terminate();
			return;
		}
		for (const message of messages) this.dispatch(message);
	}
	dispatch(message) {
		if (message === null || typeof message !== "object") return;
		const frame = message;
		const id = frame.id;
		const method = frame.method;
		if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
			/* v8 ignore next -- protocol tests exercise response writes; only a simultaneous connection
			failure makes this consumption handler run. */
			this.handleServerRequest(id, method, frame.params).catch(() => {});
			return;
		}
		if (typeof method === "string") return;
		if (typeof id === "number") this.handleResponse(id, frame);
	}
	async handleServerRequest(id, method, params) {
		try {
			const result = await this.onServerRequest(method, params);
			await this.write({
				jsonrpc: "2.0",
				id,
				result
			});
		} catch (error) {
			await this.write({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32601,
					message: asError(error).message
				}
			});
		}
	}
	handleResponse(id, frame) {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		const error = frame.error;
		if (error !== null && typeof error === "object") {
			const record = error;
			pending.reject(new Error(typeof record.message === "string" ? record.message : "LSP error response"));
			return;
		}
		pending.resolve(frame.result);
	}
	write(message) {
		if (this.closeReason !== void 0) return Promise.reject(this.closeReason);
		return new Promise((resolve, reject) => {
			const done = (error) => {
				if (error === void 0 || error === null) {
					resolve();
					return;
				}
				this.fail(error);
				reject(error);
			};
			try {
				this.writer(this.stdin, message, done);
			} catch (error) {
				const failure = asError(error);
				this.fail(failure);
				reject(failure);
			}
			/* v8 ignore stop */
		});
	}
	/** The exit-close error message, appending the retained stderr tail when the server wrote any. */
	exitMessage() {
		const tail = this.stderrTail.trim();
		return tail === "" ? "language server exited" : `language server exited; stderr: ${tail}`;
	}
	fail(error) {
		/* v8 ignore next -- the second arm (closeReason already set) needs two fail() calls before close; defensive. */
		if (this.closeReason === void 0) this.closeReason = error;
		this.failAll(error);
	}
	failAll(error) {
		const waiting = [...this.pending.values()];
		this.pending.clear();
		for (const pending of waiting) pending.reject(error);
	}
};
/** Coerce an unknown thrown value to an `Error`. */
function asError(value) {
	/* v8 ignore next -- the non-Error branch guards against a non-Error throw, which our paths never produce. */
	return value instanceof Error ? value : new Error(String(value));
}
//#endregion
//#region lib/types/translate.js
/**
* Pure protocol translation for the local host: what the server's capabilities allow, and how its
* `Location`/`LocationLink`/`Hover` payloads normalize into the seam's closed result unions. No I/O
* or process state — every function here is a pure transform, which the fake-stdio tests pin exactly.
* @module @deepseek-ai/dsh-lsp-stdio/translate
*/
/**
* The `textDocument/*` request method for each LSP operation.
* @param operation - the LSP operation to map.
* @returns the LSP request method name.
*/
function requestMethod(operation) {
	switch (operation) {
		case "goToDefinition": return "textDocument/definition";
		case "findReferences": return "textDocument/references";
		case "goToImplementation": return "textDocument/implementation";
		case "hover": return "textDocument/hover";
		/* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
		default: return assertNever(operation, "requestMethod");
	}
}
/** The `ServerCapabilities` provider field backing each operation. */
function capabilityValue(capabilities, operation) {
	switch (operation) {
		case "goToDefinition": return capabilities.definitionProvider;
		case "findReferences": return capabilities.referencesProvider;
		case "goToImplementation": return capabilities.implementationProvider;
		case "hover": return capabilities.hoverProvider;
		/* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
		default: return assertNever(operation, "capabilityValue");
	}
}
/** A provider capability is present when the server sent `true` or an options object (not `false`/absent). */
function supportsCapability(value) {
	if (value === void 0) return false;
	if (typeof value === "boolean") return value;
	return true;
}
/**
* Whether the server advertises the requested operation.
* @param capabilities - the server's `initialize` capabilities.
* @param operation - the LSP operation to check.
* @returns true when the corresponding provider capability is present.
*/
function supportsOperation(capabilities, operation) {
	return supportsCapability(capabilityValue(capabilities, operation));
}
/**
* Whether a `textDocumentSync` value permits the transient `didOpen`/`didClose` this host relies on.
* The legacy enum form implies open/close for `Full`/`Incremental`; the options form requires an
* explicit `openClose: true`, because the protocol defaults an omitted `openClose` to false.
* @param sync - the server's advertised `textDocumentSync` capability.
* @returns true when transient open/close is supported.
*/
function supportsTransientOpen(sync) {
	if (sync === void 0) return false;
	if (typeof sync === "number") return isOpenCloseKind(sync);
	return sync.openClose === true;
}
/** Legacy enum: `Full` (1) or `Incremental` (2) imply open/close support; `None` (0) does not. */
function isOpenCloseKind(kind) {
	return kind === 1 || kind === 2;
}
/**
* Normalize the negotiated position encoding. An omitted encoding defaults to `utf-16`; any value
* other than `utf-16` is a protocol error this host does not support.
* @param encoding - the server's advertised `positionEncoding`, if any.
* @returns the string `'utf-16'`.
* @throws Error for any non-`utf-16` encoding.
*/
function negotiatePositionEncoding(encoding) {
	if (encoding === void 0 || encoding === "utf-16") return "utf-16";
	throw new Error(`server negotiated unsupported position encoding "${encoding}"; this host requires utf-16`);
}
/** Convert a wire range to the seam's range (structurally identical, but re-shaped as `readonly`). */
function toRange(range) {
	return {
		start: {
			line: range.start.line,
			character: range.start.character
		},
		end: {
			line: range.end.line,
			character: range.end.character
		}
	};
}
/** Whether a record is a `LocationLink` (has `targetUri` + `targetSelectionRange`). */
function isLocationLink(value) {
	return typeof value.targetUri === "string" && isRange(value.targetSelectionRange);
}
/** Whether a record is a `Location` (has string `uri` + a range). */
function isLocation(value) {
	return typeof value.uri === "string" && isRange(value.range);
}
/** Structural range guard used by both location shapes. */
function isRange(value) {
	if (value === null || typeof value !== "object") return false;
	const range = value;
	return isPosition(range.start) && isPosition(range.end);
}
/** Structural position guard. */
function isPosition(value) {
	if (value === null || typeof value !== "object") return false;
	const position = value;
	return isProtocolCoordinate(position.line) && isProtocolCoordinate(position.character);
}
/** Whether a wire coordinate is a valid nonnegative integer. */
function isProtocolCoordinate(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
/**
* Normalize a navigation result (`Location`, `Location[]`, `LocationLink[]`, or `null`) to the seam's
* locations. `Location` maps directly; `LocationLink` maps `targetUri` + `targetSelectionRange`.
* @param payload - the raw `textDocument/definition|references|implementation` result.
* @returns the normalized locations (empty for `null`/`[]`).
* @throws Error when an element is neither a `Location` nor a `LocationLink`.
*/
function normalizeLocations(payload) {
	if (payload === null) return [];
	if (payload === void 0) throw malformedResponse("LSP navigation result was missing");
	const elements = Array.isArray(payload) ? payload : [payload];
	const locations = [];
	for (const element of elements) {
		if (element === null || typeof element !== "object") throw malformedResponse("LSP navigation result contained a non-object entry");
		const record = element;
		if (isLocationLink(record)) {
			const link = record;
			locations.push({
				uri: link.targetUri,
				range: toRange(link.targetSelectionRange)
			});
		} else if (isLocation(record)) {
			const location = record;
			locations.push({
				uri: location.uri,
				range: toRange(location.range)
			});
		} else throw malformedResponse("LSP navigation result contained neither a Location nor a LocationLink");
	}
	return locations;
}
/** Render one `MarkedString` (string form verbatim; object form as a language-tagged fenced block). */
function renderMarkedString(value) {
	if (typeof value === "string") return value;
	return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}
/**
* Normalize a `Hover` (or `null`) to the seam's hover. `MarkupContent` uses its `value`; a string
* `MarkedString` is verbatim; a language-tagged `MarkedString` becomes a fenced code block; an array
* joins its rendered parts with one blank line. The model-facing tool owns the complete result cap.
* @param payload - the raw `textDocument/hover` result.
* @returns the normalized hover, or `null` when there is no content.
* @throws Error when the payload is a non-null, non-object, or structurally invalid hover.
*/
function normalizeHover(payload) {
	if (payload === null) return null;
	if (payload === void 0) throw malformedResponse("LSP hover result was missing");
	if (typeof payload !== "object") throw malformedResponse("LSP hover result was not an object");
	const hover = payload;
	const contents = renderHoverContents(hover.contents);
	if (contents === "") return null;
	const range = hover.range;
	if (range === void 0) return { contents };
	if (!isRange(range)) throw malformedResponse("LSP hover result contained a malformed range");
	return {
		contents,
		range: toRange(range)
	};
}
/** Render the three `Hover.contents` encodings into one string (input is untrusted wire data). */
function renderHoverContents(contents) {
	if (contents === null || contents === void 0) throw malformedResponse("LSP hover result had no contents");
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map((value) => {
		if (isMarkedString(value)) return renderMarkedString(value);
		throw malformedResponse("LSP hover contents contained a malformed MarkedString");
	}).join("\n\n");
	if (typeof contents !== "object") throw malformedResponse("LSP hover contents were not MarkupContent, MarkedString, or an array");
	const record = contents;
	if (record.kind === "markdown" || record.kind === "plaintext") {
		if (typeof record.value !== "string") throw malformedResponse("LSP hover MarkupContent value was not a string");
		return record.value;
	}
	if (typeof record.language === "string" && typeof record.value === "string") return renderMarkedString({
		language: record.language,
		value: record.value
	});
	throw malformedResponse("LSP hover contents were not MarkupContent, MarkedString, or an array");
}
/** Whether an untrusted value is either form of `MarkedString`. */
function isMarkedString(value) {
	if (typeof value === "string") return true;
	if (value === null || typeof value !== "object") return false;
	const record = value;
	return typeof record.language === "string" && typeof record.value === "string";
}
/** Create the stable structured error used for malformed server result payloads. */
function malformedResponse(message) {
	return new LspError(message, "LSP_MALFORMED_RESPONSE");
}
//#endregion
//#region lib/types/instance.js
/**
* One language-server instance: a connection plus the initialize handshake, the serialized abortable
* query queue, the transient `didOpen`→request→`didClose` lifecycle, and bounded teardown. One
* instance owns one `(provider id, canonical workspace)` process. Queries serialize through a single
* queue so a cancellation that fails to stop the server can terminate it without killing unrelated
* work; distinct instances run in parallel.
* @module @deepseek-ai/dsh-lsp-stdio/instance
*/
/**
* A single initialized server process. Not exported as a provider — the provider single-flights and
* pools these. `query()` serializes; `dispose()` rejects queued work and tears the process down.
*/
var LspInstance = class {
	spec;
	connection;
	capabilities;
	/** The serialization tail: each query awaits the prior one, so lifecycles never interleave. */
	queue = Promise.resolve();
	disposed = false;
	/** The one teardown transaction shared by abort, failure, and explicit disposal. */
	teardownPromise;
	/** Set once the process closes, so the pool can synchronously skip a dead instance. */
	processClosed = false;
	/** Populated once `initialize` succeeds; a failed handshake rejects every query. */
	ready;
	/**
	* @param spec - the launch, initialize, and teardown parameters.
	* @param spawner - the subprocess seam's spawn function.
	* @param writer - optional connection writer used by transport conformance tests.
	*/
	constructor(spec, spawner, writer) {
		this.spec = spec;
		this.connection = new LspConnection(spec, spawner, (method, params) => this.answerServerRequest(method, params), writer);
		this.ready = this.initialize();
		this.ready.catch(() => {});
		this.connection.closed.then(() => {
			this.processClosed = true;
		});
	}
	/** Synchronous liveness check: true once the process has closed or the instance was disposed. */
	get dead() {
		return this.processClosed || this.disposed || this.connection.failed;
	}
	/**
	* Test whether a caught query error came from this instance's transport.
	* @param error - error caught by the provider.
	* @returns `true` only for the connection's retained fatal transport cause.
	*/
	isTransportFailure(error) {
		return this.connection.failedWith(error);
	}
	/**
	* Run one query through the serialized queue.
	* @param request - the resolved provider query.
	* @param source - the pre-validated, already-read host source (the provider reads before spawning).
	* @param signal - optional cancellation for this query's full lifecycle.
	* @returns the normalized result.
	*/
	query(request, source, signal) {
		const run = abortable(this.queue, signal).then(() => this.runQuery(request, source, signal)).catch(async (error) => {
			if (this.isTransportFailure(error)) await this.startTeardown();
			throw error;
		});
		this.queue = this.queue.then(() => run).then(() => void 0, () => void 0);
		return run;
	}
	async initialize() {
		const capabilities = (await this.connection.request("initialize", {
			processId: null,
			rootUri: this.spec.workspaceUri,
			workspaceFolders: [{
				uri: this.spec.workspaceUri,
				name: "workspace"
			}],
			capabilities: CLIENT_CAPABILITIES,
			initializationOptions: this.spec.initializationOptions
		})).capabilities;
		negotiatePositionEncoding(capabilities.positionEncoding);
		this.capabilities = capabilities;
		await this.connection.notify("initialized", {});
	}
	async runQuery(request, source, signal) {
		if (this.disposed) throw new LspError("LSP instance was disposed", "LSP_DISPOSED");
		/* v8 ignore next -- the abortable queue wait rejects a pre-aborted signal before runQuery; this is a belt-and-suspenders guard. */
		if (signal?.aborted) throw abortError(signal);
		try {
			await abortable(this.ready, signal);
		} catch (error) {
			if (!this.dead) await this.startTeardown();
			throw error;
		}
		const capabilities = this.capabilities;
		/* v8 ignore next -- `ready` resolves only after capabilities are set, else it rejects above; defensive. */
		if (capabilities === void 0) throw new Error("LSP instance is not initialized");
		if (!supportsOperation(capabilities, request.operation)) throw new LspError(`server does not support ${request.operation}`, "LSP_UNSUPPORTED_OPERATION");
		if (!supportsTransientOpen(capabilities.textDocumentSync)) throw new LspError("server does not support the transient textDocument/didOpen this host requires", "LSP_UNSUPPORTED_OPERATION");
		const uri = source.fileUrl;
		let opened = false;
		try {
			/* v8 ignore next -- guards an abort landing between the ready wait and didOpen; not deterministically reproducible. */
			if (signal?.aborted) throw abortError(signal);
			try {
				await abortable(this.connection.notify("textDocument/didOpen", { textDocument: {
					uri,
					languageId: request.languageId,
					version: 1,
					text: source.text
				} }), signal);
			} catch (error) {
				await this.startTeardown();
				throw error;
			}
			opened = true;
			const payload = await this.sendRequest(request.operation, uri, request.position, signal);
			return this.normalize(request.operation, payload);
		} finally {
			if (opened && !this.dead) try {
				await this.connection.notify("textDocument/didClose", { textDocument: { uri } });
			} catch {
				try {
					await this.startTeardown();
				} catch {}
			}
		}
	}
	async sendRequest(operation, uri, position, signal) {
		const params = {
			textDocument: { uri },
			position: {
				line: position.line,
				character: position.character
			},
			...operation === "findReferences" ? { context: { includeDeclaration: true } } : {}
		};
		const requestId = this.connection.peekNextId();
		const send = this.connection.request(requestMethod(operation), params);
		if (signal === void 0) return send;
		return this.raceAbort(send, requestId, signal);
	}
	/**
	* Race a pending request against abort. On abort, send `$/cancelRequest` and give the server a
	* bounded grace to acknowledge; if it does not settle in time, invalidate and tear down the
	* instance so the still-active request cannot overlap the next queued query's document lifecycle.
	*/
	async raceAbort(send, requestId, signal) {
		try {
			return await abortable(send, signal);
		} catch (error) {
			if (!signal.aborted) throw error;
			this.connection.cancel(requestId);
			const grace = deadline(void 0, this.spec.killGraceMs, "LSP_CANCEL_GRACE");
			try {
				if (!await Promise.race([send.then(markSettled, markSettled), new Promise((resolve) => {
					/* v8 ignore next -- the cancel-grace deadline signal is freshly armed and not yet aborted here; defensive. */
					if (grace.signal.aborted) {
						resolve(false);
						return;
					}
					grace.signal.addEventListener("abort", () => {
						resolve(false);
					}, { once: true });
				})])) await this.startTeardown();
			} finally {
				grace[Symbol.dispose]();
			}
			throw error;
		}
	}
	normalize(operation, payload) {
		if (operation === "hover") return {
			kind: "hover",
			hover: normalizeHover(payload)
		};
		return {
			kind: "locations",
			locations: normalizeLocations(payload),
			resolvedWorkspaceUri: this.spec.workspaceUri
		};
	}
	answerServerRequest(method, params) {
		if (method === "workspace/configuration") {
			const record = params;
			/* v8 ignore next -- a configuration request always carries an items array; the empty fallback is defensive. */
			const items = Array.isArray(record?.items) ? record.items : [];
			return Promise.resolve(items.map(() => this.spec.configuration));
		}
		if (LIFECYCLE_NOOP_METHODS.has(method)) return Promise.resolve(null);
		if (method === "workspace/applyEdit") return Promise.reject(/* @__PURE__ */ new Error("workspace/applyEdit is not permitted by this host"));
		return Promise.reject(/* @__PURE__ */ new Error(`unsupported server request: ${method}`));
	}
	/**
	* Reject queued work, attempt graceful `shutdown`/`exit`, then escalate SIGTERM→SIGKILL, awaiting
	* process close so nothing outlives disposal.
	*/
	async dispose() {
		await this.startTeardown();
	}
	/** Publish disposal once and make every caller await the same quiescence boundary. */
	startTeardown() {
		this.disposed = true;
		this.teardownPromise ??= this.tearDown();
		return this.teardownPromise;
	}
	async tearDown() {
		const shutdownDeadline = deadline(void 0, this.spec.shutdownTimeoutMs, "LSP_SHUTDOWN");
		try {
			await this.gracefulShutdown(shutdownDeadline.signal);
		} catch {} finally {
			shutdownDeadline[Symbol.dispose]();
		}
		await this.forceTerminate();
	}
	/** Best-effort LSP `shutdown`/`exit`, including process close, bounded by `signal`. */
	async gracefulShutdown(signal) {
		await abortable(this.connection.request("shutdown", null), signal);
		await this.connection.notify("exit", null);
		await abortable(this.connection.closed, signal);
	}
	/**
	* Terminate the tree (the seam escalates SIGTERM→`killGraceMs`→SIGKILL),
	* then await leader and helper exit. The awaits are unbounded on purpose:
	* the seam's escalation already committed to SIGKILL, so quiescence — not
	* another timer — is the postcondition disposal owes its callers.
	*/
	async forceTerminate() {
		this.connection.terminate();
		await Promise.all([this.connection.closed, this.connection.waitForProcessTreeExit()]);
	}
};
/** Server→client request methods this host acknowledges with an empty result (no dynamic registration). */
const LIFECYCLE_NOOP_METHODS = new Set([
	"window/workDoneProgress/create",
	"client/registerCapability",
	"client/unregisterCapability"
]);
/** Mark a settled request in the cancel-grace race (either outcome means the request finished). */
function markSettled() {
	return true;
}
/**
* The client capabilities advertised at `initialize`: UTF-16 positions, workspace folders and
* configuration, markdown/plaintext hover, and link support for definition/implementation. No
* dynamic registration; the server's returned capabilities are authoritative.
*/
const CLIENT_CAPABILITIES = {
	general: { positionEncodings: ["utf-16"] },
	workspace: {
		workspaceFolders: true,
		configuration: true
	},
	textDocument: {
		synchronization: { dynamicRegistration: false },
		hover: { contentFormat: ["markdown", "plaintext"] },
		definition: { linkSupport: true },
		implementation: { linkSupport: true },
		references: {}
	}
};
//#endregion
//#region lib/types/index.js
/**
* Generic stdio language-server backend for `ctx.lsp`. One plugin instance configures a named table
* of server commands and registers one isolated provider for each entry. Every provider lazily
* single-flights one server process per canonical workspace target, serves transient-open queries
* through it, and replaces a selected transport that fails before or during the next read-only
* query. Providers read sources through `ctx.fs` and launch servers through
* `ctx.subprocess`, so both local and remote implementations share one host.
*
* Namespace plugin (named exports, no default export). Lifecycle is effect-scoped: disposal
* unregisters from `ctx.lsp` and tears down every live server.
* @module @deepseek-ai/dsh-lsp-stdio
*/
/** Cordis plugin name for loader diagnostics. */
const name = "lsp-stdio";
/** Services required by this plugin. */
const inject = [
	"fs",
	"lsp",
	"subprocess"
];
const LspLocalServerConfig = z.object({
	command: z.string().required(),
	args: z.array(String).default([]),
	env: z.dict(String).default({}),
	extensionToLanguage: z.dict(String).required(),
	initializationOptions: z.any().default(null),
	configuration: z.any().default(null),
	maxMessageBytes: z.number().default(16e6),
	maxStderrBytes: z.number().default(1e6),
	maxDocumentBytes: z.number().default(4e6),
	shutdownTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(5e3),
	killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(2e3)
});
const Config = z.object({ servers: z.dict(LspLocalServerConfig).required() });
/** Propagate teardown failures only after every sibling has settled. */
function throwTeardownFailures(results, message) {
	const failures = [];
	for (const result of results) if (result.status === "rejected") failures.push(result.reason);
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, message);
}
/**
* Register the configured stdio LSP providers. Resolves every executable at load (after credential
* scrubbing) before publishing any provider; each process launches lazily on its first matching
* query.
* @param ctx - the plugin context carrying `fs`, `lsp`, and `subprocess`.
* @param config - the resolved plugin configuration (schemastery has filled every default).
*/
async function apply(ctx, config) {
	const entries = Object.entries(config.servers);
	if (entries.length === 0) throw new Error("lsp-stdio: servers must contain at least one server");
	const setupAbort = new AbortController();
	const stopSetupCancellation = ctx.on("internal/plugin", (fiber) => {
		if (fiber === ctx.fiber && fiber.uid === null) setupAbort.abort(/* @__PURE__ */ new Error("lsp-stdio setup disposed"));
	});
	const providers = await (async () => {
		const lookups = entries.map(async ([providerId, rawConfig]) => {
			if (providerId.trim() === "") throw new Error("lsp-stdio: server ids must be non-empty strings");
			const resolved = rawConfig;
			validateServerConfig(providerId, resolved);
			const executable = await ctx.subprocess.resolveExecutable(resolved.command, resolved.env, setupAbort.signal);
			setupAbort.signal.throwIfAborted();
			return new LocalLspProvider(providerId, ctx.fs, resolved, executable, (spec) => ctx.subprocess.spawn(spec));
		});
		try {
			return await Promise.all(lookups);
		} catch (error) {
			setupAbort.abort(error);
			await Promise.allSettled(lookups);
			throw error;
		} finally {
			stopSetupCancellation();
		}
	})();
	ctx.effect(() => {
		const disposers = [];
		try {
			for (const provider of providers) disposers.push(ctx.lsp.registerProvider(provider));
		} catch (error) {
			for (const dispose of disposers.reverse()) dispose();
			throw error;
		}
		return async () => {
			for (const dispose of disposers.reverse()) dispose();
			throwTeardownFailures(await Promise.allSettled(providers.map((provider) => provider.disposeAll())), "lsp-stdio provider teardown failed");
		};
	}, "lsp-stdio.registerProviders");
}
/** Validate one resolved server entry before any provider in the table is registered. */
function validateServerConfig(providerId, resolved) {
	assertTimer(providerId, "shutdownTimeoutMs", resolved.shutdownTimeoutMs);
	assertTimer(providerId, "killGraceMs", resolved.killGraceMs);
	assertPositiveInteger(providerId, "maxStderrBytes", resolved.maxStderrBytes);
	assertPositiveInteger(providerId, "maxMessageBytes", resolved.maxMessageBytes);
	assertPositiveInteger(providerId, "maxDocumentBytes", resolved.maxDocumentBytes);
}
/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(providerId, name, value) {
	if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) throw new Error(`lsp-stdio: servers.${providerId}.${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`);
}
/** Reject a nonpositive or non-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(providerId, name, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`lsp-stdio: servers.${providerId}.${name} must be a positive integer`);
}
/** A pooled generic provider: one server process per canonical workspace, created on demand. */
var LocalLspProvider = class {
	fs;
	config;
	executable;
	spawner;
	id;
	extensionToLanguage;
	/** One live instance per stable canonical workspace identity. */
	instances = /* @__PURE__ */ new Map();
	/** One complete source-read→open→query→close serialization tail per canonical workspace. */
	queues = /* @__PURE__ */ new Map();
	/** Workspace canonicalizations that have not entered a provider-owned queue yet. */
	workspaceLookups = /* @__PURE__ */ new Set();
	lifetime = new AbortController();
	disposed = false;
	constructor(providerId, fs, config, executable, spawner) {
		this.fs = fs;
		this.config = config;
		this.executable = executable;
		this.spawner = spawner;
		this.id = LspProviderId(providerId);
		this.extensionToLanguage = config.extensionToLanguage;
	}
	/** Read the disposed flag through a method so a `query()` await cannot narrow it to a literal. */
	isDisposed() {
		return this.disposed;
	}
	/** Reject work that cannot publish or use a provider-owned instance. */
	assertActive(signal) {
		/* v8 ignore next -- the seam unregisters this provider before disposal; direct in-flight calls
		exercise the post-await check instead. */
		if (this.isDisposed()) throw new LspError("lsp-stdio provider is disposed", "LSP_DISPOSED");
		if (signal?.aborted) throw abortError(signal);
	}
	/** Fuse caller cancellation with provider disposal for every filesystem and protocol await. */
	querySignal(signal) {
		return signal === void 0 ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]);
	}
	async query(request, signal) {
		this.assertActive(signal);
		const querySignal = this.querySignal(signal);
		const workspaceResult = canonicalizeWorkspace(this.fs, request.workspaceRoot, querySignal);
		const workspaceLookup = workspaceResult.then(() => void 0, () => void 0);
		this.workspaceLookups.add(workspaceLookup);
		let workspace;
		try {
			workspace = await workspaceResult;
		} finally {
			this.workspaceLookups.delete(workspaceLookup);
		}
		this.assertActive(querySignal);
		const workspaceKey = workspace.target.targetKey;
		return this.enqueue(workspaceKey, querySignal, async () => {
			this.assertActive(querySignal);
			const source = await readHostSource(this.fs, request.filePath, workspace, this.config.maxDocumentBytes, querySignal);
			this.assertActive(querySignal);
			let instance = this.instanceFor(workspaceKey, workspace);
			try {
				return await instance.query(request, source, querySignal);
			} catch (error) {
				if (!instance.isTransportFailure(error)) throw error;
				await instance.dispose();
				this.evictIfCurrent(workspaceKey, instance);
				this.assertActive(querySignal);
				instance = this.instanceFor(workspaceKey, workspace);
				return await instance.query(request, source, querySignal);
			} finally {
				if (instance.dead) {
					await instance.dispose();
					this.evictIfCurrent(workspaceKey, instance);
				}
			}
		});
	}
	/** Serialize one complete query lifecycle for a canonical workspace. */
	enqueue(workspace, signal, run) {
		const previous = this.queues.get(workspace) ?? Promise.resolve();
		const result = abortable(previous, signal).then(run);
		const tail = previous.then(() => result).then(() => void 0, () => void 0);
		this.queues.set(workspace, tail);
		tail.then(() => {
			if (this.queues.get(workspace) === tail) this.queues.delete(workspace);
		});
		return result;
	}
	/** Return or synchronously publish the one instance for a canonical workspace. */
	instanceFor(workspaceKey, workspace) {
		this.assertActive();
		const existing = this.instances.get(workspaceKey);
		if (existing !== void 0) return existing;
		const created = this.createInstance(workspace);
		this.instances.set(workspaceKey, created);
		return created;
	}
	/** Drop the slot iff it still contains this instance. */
	evictIfCurrent(workspace, instance) {
		/* v8 ignore next -- mismatch requires another query to replace the slot before this finally runs. */
		if (this.instances.get(workspace) === instance) this.instances.delete(workspace);
	}
	createInstance(workspace) {
		return new LspInstance({
			command: this.executable,
			args: this.config.args,
			cwd: workspace.canonicalPath,
			workspaceUri: workspace.fileUrl,
			env: this.config.env,
			configuration: this.config.configuration,
			initializationOptions: this.config.initializationOptions,
			maxMessageBytes: this.config.maxMessageBytes,
			maxStderrBytes: this.config.maxStderrBytes,
			shutdownTimeoutMs: this.config.shutdownTimeoutMs,
			killGraceMs: this.config.killGraceMs
		}, this.spawner);
	}
	/** Dispose every live instance and block further queries. */
	async disposeAll() {
		this.disposed = true;
		this.lifetime.abort(new LspError("lsp-stdio provider is disposed", "LSP_DISPOSED"));
		const live = [...this.instances.values()];
		const draining = [...this.queues.values()];
		const resolving = [...this.workspaceLookups];
		this.instances.clear();
		const results = await Promise.allSettled([
			...live.map((instance) => instance.dispose()),
			...draining,
			...resolving
		]);
		this.queues.clear();
		this.workspaceLookups.clear();
		throwTeardownFailures(results, "lsp-stdio instance teardown failed");
	}
};
//#endregion
export { Config, LspConnection, LspInstance, MessageDecoder, apply, canonicalizeWorkspace, encodeMessage, inject, name, negotiatePositionEncoding, normalizeHover, normalizeLocations, readHostSource, requestMethod, supportsOperation, supportsTransientOpen };
