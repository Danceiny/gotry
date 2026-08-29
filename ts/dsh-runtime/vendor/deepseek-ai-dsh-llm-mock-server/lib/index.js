import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout } from "node:timers/promises";
//#region lib/types/index.js
/**
* Scriptable OpenAI-compatible HTTP/SSE server for transport, protocol, and
* semantic-empty LLM recovery tests. Each accepted chat-completions request
* consumes one behavior; the server never retries or interprets harness policy.
*
* @module @deepseek-ai/dsh-llm-mock-server
*/
/** Request-scoped behaviors accepted by {@link startMockLlmServer}. */
const MOCK_LLM_BEHAVIORS = [
	"connection_reset",
	"stream_disconnect",
	"empty",
	"empty_body",
	"stream_eof",
	"partial_eof",
	"partial_disconnect",
	"stall",
	"malformed_json",
	"malformed_event",
	"wrong_content_type",
	"rate_limit",
	"server_error",
	"service_unavailable",
	"auth_error",
	"invalid_request",
	"context_overflow",
	"quota_exceeded",
	"success",
	"reasoning_success",
	"tool_call_success",
	"max_tokens",
	"slow_success",
	"random"
];
/**
* Default stress profile for `random`. Weights are configurable test pressure,
* not a claim about production incident frequency.
*/
const DEFAULT_MOCK_LLM_RANDOM_WEIGHTS = Object.freeze({
	success: 48,
	slow_success: 10,
	max_tokens: 2,
	connection_reset: 5,
	stream_disconnect: 5,
	partial_disconnect: 10,
	empty: 5,
	stall: 2,
	rate_limit: 5,
	server_error: 4,
	service_unavailable: 2,
	partial_eof: 1,
	malformed_json: 1
});
/** Largest millisecond delay accepted by Node timers without truncation. */
const MAX_MOCK_LLM_TIMER_DELAY_MS = 2147483647;
const DEFAULT_SUCCESS_TEXT = "mock response recovered";
const DEFAULT_PARTIAL_TEXT = "discarded partial response";
const DEFAULT_REASONING_TEXT = "mock reasoning";
const CONCRETE_BEHAVIORS = new Set(MOCK_LLM_BEHAVIORS.filter((behavior) => behavior !== "random"));
function boundedInteger(name, value, min, max) {
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`llm-mock-server: ${name} must be an integer between ${min} and ${max}`);
	return value;
}
function resolveOptions(options) {
	const host = options.host ?? "127.0.0.1";
	const port = boundedInteger("port", options.port ?? 0, 0, 65535);
	const chunkSize = boundedInteger("chunkSize", options.chunkSize ?? 8, 1, Number.MAX_SAFE_INTEGER);
	const chunkDelayMs = boundedInteger("chunkDelayMs", options.chunkDelayMs ?? 25, 0, MAX_MOCK_LLM_TIMER_DELAY_MS);
	const disconnectDelayMs = boundedInteger("disconnectDelayMs", options.disconnectDelayMs ?? 10, 0, MAX_MOCK_LLM_TIMER_DELAY_MS);
	const retryAfterMs = boundedInteger("retryAfterMs", options.retryAfterMs ?? 1e3, 1, MAX_MOCK_LLM_TIMER_DELAY_MS);
	const randomSeed = boundedInteger("randomSeed", options.randomSeed ?? randomBytes(4).readUInt32LE(0), 0, 4294967295);
	const successText = options.successText ?? DEFAULT_SUCCESS_TEXT;
	const partialText = options.partialText ?? DEFAULT_PARTIAL_TEXT;
	const reasoningText = options.reasoningText ?? DEFAULT_REASONING_TEXT;
	const toolName = options.toolName ?? "mock_tool";
	const toolArguments = options.toolArguments ?? "{\"value\":\"mock\"}";
	if (host.length === 0) throw new Error("llm-mock-server: host must not be empty");
	if (options.sequence.length === 0) throw new Error("llm-mock-server: sequence must not be empty");
	const lastBehavior = options.sequence.reduce((_previous, behavior) => behavior);
	if (options.apiKey === "") throw new Error("llm-mock-server: apiKey must not be empty");
	if (successText.length === 0) throw new Error("llm-mock-server: successText must not be empty");
	if (partialText.length === 0) throw new Error("llm-mock-server: partialText must not be empty");
	if (reasoningText.length === 0) throw new Error("llm-mock-server: reasoningText must not be empty");
	if (toolName.length === 0) throw new Error("llm-mock-server: toolName must not be empty");
	if (options.requestId === "") throw new Error("llm-mock-server: requestId must not be empty");
	try {
		JSON.parse(toolArguments);
	} catch {
		throw new Error("llm-mock-server: toolArguments must be valid JSON");
	}
	const configuredWeights = options.randomWeights ?? DEFAULT_MOCK_LLM_RANDOM_WEIGHTS;
	const randomWeights = [];
	for (const [behavior, weight] of Object.entries(configuredWeights)) {
		if (!CONCRETE_BEHAVIORS.has(behavior)) throw new Error(`llm-mock-server: randomWeights contains unknown concrete behavior ${JSON.stringify(behavior)}`);
		if (!Number.isFinite(weight) || weight < 0) throw new Error(`llm-mock-server: random weight for ${behavior} must be a non-negative finite number`);
		if (weight > 0) randomWeights.push([behavior, weight]);
	}
	if (randomWeights.length === 0) throw new Error("llm-mock-server: randomWeights must contain at least one positive weight");
	return {
		host,
		port,
		...options.apiKey === void 0 ? {} : { apiKey: options.apiKey },
		sequence: [...options.sequence],
		lastBehavior,
		repeatLast: options.repeatLast ?? false,
		randomSeed,
		randomWeights,
		successText,
		partialText,
		reasoningText,
		chunkSize,
		chunkDelayMs,
		disconnectDelayMs,
		retryAfterMs,
		...options.requestId === void 0 ? {} : { requestId: options.requestId },
		toolName,
		toolArguments,
		...options.onEvent === void 0 ? {} : { onEvent: options.onEvent }
	};
}
function emit(options, event) {
	try {
		options.onEvent?.(Object.freeze(event));
	} catch (_telemetryObserverFailure) {}
}
async function readJsonBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const body = Buffer.concat(chunks).toString("utf8");
	return body.length === 0 ? void 0 : JSON.parse(body);
}
function splitText(text, size) {
	const points = Array.from(text);
	const chunks = [];
	for (let index = 0; index < points.length; index += size) chunks.push(points.slice(index, index + size).join(""));
	return chunks;
}
function openSse(response, contentType = "text/event-stream; charset=utf-8") {
	response.writeHead(200, {
		"content-type": contentType,
		"cache-control": "no-cache",
		"connection": "keep-alive"
	});
	response.flushHeaders();
}
function writeSse(record, response, payload) {
	response.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
	record.chunksSent += 1;
}
function writeDone(record, response) {
	writeSse(record, response, "[DONE]");
}
function finishRecord(options, record, outcome) {
	if (record.outcome !== void 0) return;
	record.outcome = outcome;
	emit(options, {
		type: "result",
		attempt: record.attempt,
		scriptBehavior: record.scriptBehavior,
		behavior: record.behavior,
		outcome,
		chunksSent: record.chunksSent
	});
}
function httpError(options, record, response, status, message, code, type = "mock_error") {
	const headers = { "content-type": "application/json" };
	if (record.behavior === "rate_limit") headers["retry-after"] = String(Math.ceil(options.retryAfterMs / 1e3));
	if (options.requestId !== void 0) headers["x-request-id"] = options.requestId;
	response.writeHead(status, headers);
	response.end(JSON.stringify({ error: {
		message,
		type,
		code
	} }));
	finishRecord(options, record, "completed");
}
function terminalChunk(reason, outputTokens) {
	return {
		choices: [{
			index: 0,
			delta: { content: "" },
			finish_reason: reason
		}],
		usage: {
			prompt_tokens: 3,
			completion_tokens: outputTokens
		}
	};
}
async function pause(milliseconds, response) {
	if (milliseconds === 0) return !response.destroyed;
	const controller = new AbortController();
	const stop = () => {
		controller.abort();
	};
	response.once("close", stop);
	try {
		await setTimeout(milliseconds, void 0, { signal: controller.signal });
		return true;
	} catch (_responseClosed) {
		return false;
	} finally {
		response.off("close", stop);
	}
}
async function streamText(options, record, response, text, delayMs) {
	for (const chunk of splitText(text, options.chunkSize)) {
		writeSse(record, response, { choices: [{
			index: 0,
			delta: { content: chunk },
			finish_reason: null
		}] });
		if (!await pause(delayMs, response)) return false;
	}
	return true;
}
async function completeText(options, record, response, reason, delayMs) {
	if (!await streamText(options, record, response, options.successText, delayMs)) {
		finishRecord(options, record, "client_closed");
		return;
	}
	writeSse(record, response, terminalChunk(reason, Array.from(options.successText).length));
	writeDone(record, response);
	response.end();
	finishRecord(options, record, "completed");
}
async function disconnect(options, record, response) {
	if (!await pause(options.disconnectDelayMs, response)) {
		finishRecord(options, record, "client_closed");
		return;
	}
	finishRecord(options, record, "reset");
	response.destroy();
}
function toolCallChunks(options) {
	const midpoint = Math.max(1, Math.floor(options.toolArguments.length / 2));
	return [{ choices: [{
		index: 0,
		delta: { tool_calls: [{
			index: 0,
			id: "mock-call-1",
			type: "function",
			function: {
				name: options.toolName,
				arguments: options.toolArguments.slice(0, midpoint)
			}
		}] },
		finish_reason: null
	}] }, { choices: [{
		index: 0,
		delta: { tool_calls: [{
			index: 0,
			function: { arguments: options.toolArguments.slice(midpoint) }
		}] },
		finish_reason: null
	}] }];
}
async function runBehavior(options, record, request, response) {
	switch (record.behavior) {
		case "script_exhausted":
			httpError(options, record, response, 500, "mock script exhausted", "MOCK_SCRIPT_EXHAUSTED");
			return;
		case "connection_reset":
			finishRecord(options, record, "reset");
			request.socket.destroy();
			return;
		case "stream_disconnect":
			openSse(response);
			await disconnect(options, record, response);
			return;
		case "empty":
			openSse(response);
			writeSse(record, response, terminalChunk("stop", 0));
			writeDone(record, response);
			response.end();
			finishRecord(options, record, "completed");
			return;
		case "empty_body":
			openSse(response);
			response.end();
			finishRecord(options, record, "completed");
			return;
		case "stream_eof":
			openSse(response);
			writeSse(record, response, { choices: [{
				index: 0,
				delta: { role: "assistant" },
				finish_reason: null
			}] });
			response.end();
			finishRecord(options, record, "completed");
			return;
		case "partial_eof":
			openSse(response);
			await streamText(options, record, response, options.partialText, 0);
			response.end();
			finishRecord(options, record, "completed");
			return;
		case "partial_disconnect":
			openSse(response);
			if (!await streamText(options, record, response, options.partialText, options.chunkDelayMs)) return;
			await disconnect(options, record, response);
			return;
		case "stall":
			openSse(response);
			finishRecord(options, record, "stalled");
			return;
		case "malformed_json":
			openSse(response);
			writeSse(record, response, "{not-json");
			writeDone(record, response);
			response.end();
			finishRecord(options, record, "completed");
			return;
		case "malformed_event":
			openSse(response);
			writeSse(record, response, { choices: [null] });
			writeDone(record, response);
			response.end();
			finishRecord(options, record, "completed");
			return;
		case "wrong_content_type":
			openSse(response, "application/json");
			await completeText(options, record, response, "stop", 0);
			return;
		case "rate_limit":
			httpError(options, record, response, 429, "mock rate limit", "rate_limit");
			return;
		case "server_error":
			httpError(options, record, response, 500, "mock server error", "server_error");
			return;
		case "service_unavailable":
			httpError(options, record, response, 503, "mock service unavailable", "service_unavailable");
			return;
		case "auth_error":
			httpError(options, record, response, 401, "mock authentication failed", "invalid_api_key");
			return;
		case "invalid_request":
			httpError(options, record, response, 400, "mock invalid request", "invalid_request");
			return;
		case "context_overflow":
			httpError(options, record, response, 400, "mock input exceeds the model context window", "context_length_exceeded", "invalid_request_error");
			return;
		case "quota_exceeded":
			httpError(options, record, response, 429, "mock insufficient quota", "insufficient_quota");
			return;
		case "success":
			openSse(response);
			await completeText(options, record, response, "stop", 0);
			return;
		case "reasoning_success":
			openSse(response);
			for (const chunk of splitText(options.reasoningText, options.chunkSize)) writeSse(record, response, { choices: [{
				index: 0,
				delta: { reasoning_content: chunk },
				finish_reason: null
			}] });
			await completeText(options, record, response, "stop", 0);
			return;
		case "tool_call_success":
			openSse(response);
			for (const chunk of toolCallChunks(options)) writeSse(record, response, chunk);
			writeSse(record, response, terminalChunk("tool_calls", 2));
			writeDone(record, response);
			response.end();
			finishRecord(options, record, "completed");
			return;
		case "max_tokens":
			openSse(response);
			await completeText(options, record, response, "length", 0);
			return;
		case "slow_success":
			openSse(response);
			await completeText(options, record, response, "stop", options.chunkDelayMs);
			return;
	}
}
function seededRandom(seed) {
	let state = seed;
	return () => {
		state = state + 1831565813 >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
		return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
	};
}
function chooseRandomBehavior(weights, random) {
	const total = weights.reduce((sum, entry) => sum + entry[1], 0);
	let draw = random() * total;
	for (const [behavior, weight] of weights) {
		if (draw < weight) return behavior;
		draw -= weight;
	}
	/* v8 ignore next -- seededRandom is strictly less than one; this guards floating-point residue only */
	return weights.at(-1)[0];
}
/**
* Start a local chat-completions server that consumes one configured behavior
* per accepted request. Only a `POST` path ending in `/chat/completions` consumes the script;
* invalid routes, methods, authorization, and JSON receive ordinary 4xx
* responses. Closing the handle terminates stalled connections.
*
* @param options - listener, script, response content, timing, and telemetry options.
* @returns the listening handle after the port is bound.
*/
async function startMockLlmServer(options) {
	const resolved = resolveOptions(options);
	const requests = [];
	const random = seededRandom(resolved.randomSeed);
	let cursor = 0;
	const selectBehavior = () => {
		const selected = resolved.sequence[cursor];
		cursor += 1;
		const scriptBehavior = selected ?? (resolved.repeatLast ? resolved.lastBehavior : "script_exhausted");
		return {
			scriptBehavior,
			behavior: scriptBehavior === "random" ? chooseRandomBehavior(resolved.randomWeights, random) : scriptBehavior
		};
	};
	const handle = async (request, response) => {
		/* v8 ignore next -- node:http server requests always carry a URL despite the shared optional type */
		const path = new URL(request.url ?? "/", "http://mock.invalid").pathname;
		if (request.method !== "POST") {
			response.writeHead(405, { allow: "POST" }).end();
			return;
		}
		if (!path.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		if (resolved.apiKey !== void 0 && request.headers.authorization !== `Bearer ${resolved.apiKey}`) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: {
				message: "invalid mock bearer token",
				code: "invalid_api_key"
			} }));
			return;
		}
		let body;
		try {
			body = await readJsonBody(request);
		} catch {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: {
				message: "request body must be valid JSON",
				code: "invalid_json"
			} }));
			return;
		}
		const selected = selectBehavior();
		const record = {
			attempt: requests.length + 1,
			scriptBehavior: selected.scriptBehavior,
			behavior: selected.behavior,
			path,
			headers: { ...request.headers },
			body,
			chunksSent: 0
		};
		requests.push(record);
		response.once("close", () => {
			if (!response.writableFinished && record.outcome === void 0) finishRecord(resolved, record, "client_closed");
		});
		emit(resolved, {
			type: "request",
			attempt: record.attempt,
			scriptBehavior: record.scriptBehavior,
			behavior: record.behavior,
			path
		});
		await runBehavior(resolved, record, request, response);
	};
	const server = createServer((request, response) => {
		/* v8 ignore start -- last-resort containment for Node response failures after validated test inputs */
		handle(request, response).catch((error) => {
			const record = requests.at(-1);
			if (record !== void 0) finishRecord(resolved, record, "server_error");
			if (response.headersSent) {
				response.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: {
				message: "mock server handler failed",
				code: "MOCK_HANDLER_FAILED"
			} }));
		});
		/* v8 ignore stop */
	});
	let closing;
	const close = () => closing ??= new Promise((resolveClose) => {
		server.close(() => {
			resolveClose();
		});
		server.closeAllConnections();
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(resolved.port, resolved.host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	return {
		baseURL: `http://${isIP(resolved.host) === 6 ? `[${resolved.host}]` : resolved.host}:${address.port}`,
		port: address.port,
		randomSeed: resolved.randomSeed,
		requests,
		close
	};
}
//#endregion
export { DEFAULT_MOCK_LLM_RANDOM_WEIGHTS, MAX_MOCK_LLM_TIMER_DELAY_MS, MOCK_LLM_BEHAVIORS, startMockLlmServer };
