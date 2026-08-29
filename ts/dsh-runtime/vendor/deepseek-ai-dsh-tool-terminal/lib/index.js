import z from "@deepseek-ai/schemastery";
import { TerminalSessionId } from "@deepseek-ai/dsh-terminal";
import { FIRST_PARTY_SECTION_ORDER } from "@deepseek-ai/dsh-system-prompt";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TextRetainer } from "@deepseek-ai/dsh-output-retention";
//#region lib/types/render.js
/** Model and UI rendering for persistent terminal tool results. */
const encoder = new TextEncoder();
const TRUNCATED = "\n[output truncated]";
function byteLength(text) {
	return encoder.encode(text).byteLength;
}
function retain(text, maxBytes, kind) {
	const retainer = new TextRetainer({
		kind,
		maxBytes
	});
	retainer.push(text);
	return retainer.finish().text;
}
function fitWithSuffix(content, suffix, maxBytes) {
	const fixedBytes = byteLength(suffix);
	if (fixedBytes >= maxBytes) return retain(suffix, maxBytes, "tail");
	return `${retain(content, maxBytes - fixedBytes, "tail")}${suffix}`;
}
function fitWithPrefix(prefix, content, maxBytes) {
	const fixed = `${prefix}${TRUNCATED}`;
	const fixedBytes = byteLength(fixed);
	if (fixedBytes >= maxBytes) return retain(fixed, maxBytes, "head");
	return `${prefix}${retain(content, maxBytes - fixedBytes, "tail")}${TRUNCATED}`;
}
function boundBodyWithSuffix(content, metadata, upstreamTruncated, maxBytes) {
	const complete = `${content}${`${metadata}${upstreamTruncated ? TRUNCATED : ""}`}`;
	if (byteLength(complete) <= maxBytes) return complete;
	return fitWithSuffix(content, `${metadata}${TRUNCATED}`, maxBytes);
}
/**
* Bound one complete terminal acknowledgement while preserving UTF-8 cuts.
* @param text - complete acknowledgement text.
* @param maxBytes - positive final result cap.
* @returns bounded text with a truncation marker when it fits.
*/
function boundTerminalText(text, maxBytes) {
	if (byteLength(text) <= maxBytes) return text;
	const markerBytes = byteLength(TRUNCATED);
	if (markerBytes >= maxBytes) return retain(TRUNCATED, maxBytes, "tail");
	return `${retain(text, maxBytes - markerBytes, "head")}${TRUNCATED}`;
}
/**
* Render one created session and its bounded MOTD.
* @param result - published spawn result.
* @param maxBytes - complete UTF-8 result cap.
* @returns Model-facing session acknowledgement.
*/
function renderSpawn(result, maxBytes) {
	const prefix = `started terminal session ${result.name === void 0 ? result.sessionId : `${result.sessionId} (${result.name})`} [type: ${result.type}]\n`;
	const motd = result.motd || "(no startup output)";
	const complete = `${prefix}${motd}`;
	return byteLength(complete) <= maxBytes ? complete : fitWithPrefix(prefix, motd, maxBytes);
}
/**
* Render one settled interactive send.
* @param result - settled send outcome.
* @param maxBytes - complete UTF-8 result cap.
* @returns Terminal output plus wait/session markers.
*/
function renderSend(result, maxBytes) {
	const output = result.viewport || "(no new output)";
	const status = result.sessionStatus.kind === "running" ? "running" : `exited code=${result.sessionStatus.exitCode ?? "null"} signal=${result.sessionStatus.signal ?? "null"}`;
	return boundBodyWithSuffix(output, `\n[wait: ${result.waitReason}]\n[session: ${status}]`, result.truncated, maxBytes);
}
/**
* Render one incremental background operation read.
* @param read - consuming operation delta.
* @returns Delta plus its upstream truncation marker. The generic task control
*   applies the producer's complete-result cap after adding job status.
*/
function renderSendRead(read) {
	const separator = read.delta.endsWith("\n") || read.delta.length === 0 ? "" : "\n";
	return `${read.delta}${read.truncated ? `${separator}[output truncated]` : ""}`;
}
/**
* Render one bounded historical page.
* @param result - retained scrollback page.
* @param maxBytes - complete UTF-8 result cap.
* @returns Page text plus pagination and truncation markers.
*/
function renderRead(result, maxBytes) {
	return boundBodyWithSuffix(result.text || "(no retained output)", `\n[lines: ${result.lineBegin}-${result.lineEnd} of ${result.totalLines}]`, result.truncated, maxBytes);
}
/**
* Render owner-visible live sessions.
* @param sessions - fresh owner-scoped snapshots.
* @param maxBytes - complete UTF-8 result cap.
* @returns One line per session or the empty marker.
*/
function renderList(sessions, maxBytes) {
	if (sessions.length === 0) return "(no terminal sessions)";
	return boundBodyWithSuffix(sessions.map((session) => {
		const name = session.name === void 0 ? "" : ` (${session.name})`;
		const pid = session.pid === void 0 ? "" : ` pid=${session.pid}`;
		const status = session.status.kind === "running" ? "running" : `exited code=${session.status.exitCode ?? "null"} signal=${session.status.signal ?? "null"}`;
		return `${session.sessionId}${name} [${session.type}] ${status}${pid}`;
	}).join("\n"), "", false, maxBytes);
}
//#endregion
//#region lib/types/index.js
/**
* Six model-facing persistent terminal tools. Owner identity comes from the exact
* tool execution Agent; generic `ctx.jobs` owns background ids and collection.
* @module @deepseek-ai/dsh-tool-terminal
*/
/** Cordis plugin name. */
const name = "tool-terminal";
/** Required capability, registry, and prompt services. */
const inject = [
	"terminals",
	"tools",
	"systemPrompt"
];
/** Default cap for one complete model-facing terminal result. */
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
/** Smallest cap that preserves every counter-backed PTY and job id in its creation acknowledgement. */
const MIN_MAX_RESULT_BYTES = 64;
/** Schemastery configuration for the terminal tool consumer. */
const Config = z.object({
	enableRunInBackground: z.boolean().default(true),
	maxResultBytes: z.number().step(1).min(64).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RESULT_BYTES)
});
const SESSION_STATUS_SCHEMA = { oneOf: [{
	type: "object",
	additionalProperties: false,
	properties: { kind: {
		type: "string",
		required: true,
		const: "running"
	} }
}, {
	type: "object",
	additionalProperties: false,
	properties: {
		kind: {
			type: "string",
			required: true,
			const: "exited"
		},
		exitCode: {
			required: true,
			oneOf: [{ type: "integer" }, { type: "null" }]
		},
		signal: {
			required: true,
			oneOf: [{ type: "string" }, { type: "null" }]
		}
	}
}] };
const SESSION_SNAPSHOT_PROPERTIES = {
	sessionId: {
		type: "string",
		required: true
	},
	name: { type: "string" },
	type: {
		type: "string",
		required: true
	},
	pid: { type: "integer" },
	status: {
		...SESSION_STATUS_SCHEMA,
		required: true
	}
};
const SESSION_SNAPSHOT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: SESSION_SNAPSHOT_PROPERTIES
};
const BACKGROUND_TASK_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		kind: {
			type: "string",
			required: true,
			const: "background"
		},
		jobId: {
			type: "string",
			required: true
		}
	}
};
function requireAgent(agent) {
	if (agent === void 0) throw new Error("terminal tools require an initiating agent");
	return agent;
}
function sessionId(args) {
	if (args.sessionId.length === 0) throw new Error("sessionId must be a non-empty string");
	return TerminalSessionId(args.sessionId);
}
function textResult(text, maxBytes) {
	return [{
		type: "text",
		text: boundTerminalText(text, maxBytes)
	}];
}
function rawContentText(content) {
	if (content.length !== 1) return void 0;
	const block = content[0];
	return block?.type === "text" ? block.text : void 0;
}
function sendDetail(result) {
	return result.sessionStatus.kind === "running" ? `wait: ${result.waitReason}` : `session exited: ${result.sessionStatus.exitCode ?? result.sessionStatus.signal ?? "unknown"}`;
}
/** Register all terminal tools and the minimal usage guidance. */
function apply(ctx, config = {}) {
	const enableRunInBackground = config.enableRunInBackground ?? true;
	const maxResultBytes = config.maxResultBytes ?? 262144;
	if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 64) throw new Error(`tool-terminal: maxResultBytes must be a safe integer of at least 64`);
	const finalizeContent = (_exec, result) => {
		const raw = rawContentText(result.content);
		return raw === void 0 ? void 0 : textResult(raw, maxResultBytes);
	};
	ctx.systemPrompt.section({
		name: "tool:pty",
		order: FIRST_PARTY_SECTION_ORDER.TOOL_PTY,
		text: "Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer shell/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited."
	});
	ctx.tools.register(defineTool({
		name: "terminal_open",
		description: "Create a persistent, owner-isolated terminal session from a registered backend type. Use this for shell or REPL state that must survive across tool calls.",
		parameters: {
			type: {
				type: "string",
				required: true,
				description: "Registered terminal backend type, usually \"shell\"."
			},
			name: {
				type: "string",
				description: "Optional owner-local display name such as \"main\" or \"gdb\"."
			},
			cwd: {
				type: "string",
				description: "Initial working directory. Defaults to the deployment workspace root."
			}
		},
		finalizeContent,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					...SESSION_SNAPSHOT_PROPERTIES,
					motd: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderSpawn(value, maxResultBytes)
			}]
		},
		async execute(args, exec) {
			if (args.type.length === 0) throw new Error("type must be a non-empty string");
			return await ctx.terminals.spawn(requireAgent(exec.agent), {
				type: args.type,
				...args.name !== void 0 ? { name: args.name } : {},
				...args.cwd !== void 0 ? { cwd: args.cwd } : {}
			}, exec.signal);
		},
		presentCall: (args) => {
			const parsed = args;
			return {
				card: "generic",
				title: `Open terminal ${parsed.name ?? parsed.type}`,
				kind: "execute"
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "terminal_send",
		description: "Send text to a persistent terminal. By default Enter is submitted and the call waits for a prompt, stdin wait, output silence, timeout, or session exit." + (enableRunInBackground ? " Background mode returns a job id for job_output/job_kill." : ""),
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Terminal session id returned by terminal_open or terminal_list."
			},
			text: {
				type: "string",
				required: true,
				description: "UTF-8 text to write to the terminal."
			},
			submit: {
				type: "boolean",
				description: "Submit Enter after text (default true). Set false for control characters or incomplete REPL input."
			},
			...enableRunInBackground ? { run_in_background: {
				type: "boolean",
				description: "Return a job id immediately; collect with job_output or stop with job_kill."
			} } : {}
		},
		finalizeContent,
		output: {
			schema: { oneOf: [BACKGROUND_TASK_OUTPUT_SCHEMA, {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "foreground"
					},
					viewport: {
						type: "string",
						required: true
					},
					waitReason: {
						type: "string",
						required: true,
						enum: [
							"stdin_read",
							"inferred_idle",
							"timeout",
							"session_exit"
						]
					},
					sessionStatus: {
						...SESSION_STATUS_SCHEMA,
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			}] },
			render: (_args, value) => [{
				type: "text",
				text: value.kind === "background" ? `started background job ${value.jobId}` : renderSend(value, maxResultBytes)
			}],
			presentationMeta: (_args, value) => value.kind === "foreground" ? {
				viewport: value.viewport,
				waitReason: value.waitReason,
				sessionStatus: value.sessionStatus,
				truncated: value.truncated
			} : null
		},
		async execute(args, exec) {
			const owner = requireAgent(exec.agent);
			const id = sessionId(args);
			const request = {
				text: args.text,
				submit: args.submit ?? true
			};
			if (args.run_in_background === true) {
				if (!enableRunInBackground) throw new Error("background terminal sends are disabled by tool-terminal configuration");
				const jobs = ctx.get("jobs");
				if (jobs === void 0) throw new Error("background terminal sends require @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
				let cancelRequested = false;
				return {
					kind: "background",
					jobId: jobs.start({
						kind: "pty-send",
						label: `${id}: ${args.text || "(input)"}`,
						owner,
						outputLimitBytes: maxResultBytes,
						run: () => {
							const operation = ctx.terminals.startSend(owner, id, request);
							return {
								cancel: () => {
									cancelRequested = true;
									operation.cancel();
								},
								done: operation.done.then((result) => ({
									status: cancelRequested ? "killed" : "completed",
									detail: sendDetail(result)
								}), (error) => ({
									status: "failed",
									detail: String(error)
								})),
								readOutput: () => renderSendRead(operation.readOutput())
							};
						}
					})
				};
			}
			const result = await ctx.terminals.startSend(owner, id, {
				...request,
				signal: exec.signal
			}).done;
			if (exec.signal.aborted) throw new Error("terminal send aborted");
			return {
				kind: "foreground",
				...result
			};
		},
		presentCall(args) {
			const parsed = args;
			if (parsed.run_in_background === true) return {
				card: "generic",
				title: `Send to terminal ${parsed.sessionId} in background`,
				kind: "execute",
				rawInput: parsed.text
			};
			return {
				card: "terminal",
				title: parsed.text || "(send input)",
				description: `Terminal ${parsed.sessionId}`
			};
		},
		presentResult(args, result) {
			if (args.run_in_background === true || result.isError) return void 0;
			const raw = rawContentText(result.content);
			return raw === void 0 ? void 0 : {
				card: "terminal",
				output: raw
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "terminal_read",
		description: "Read a bounded page of retained output from a persistent terminal without sending input.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Terminal session id."
			},
			offset: {
				type: "number",
				description: "Newest-relative line offset (default 0)."
			},
			count: {
				type: "number",
				description: "Requested line count (default 500; backend caps apply)."
			}
		},
		finalizeContent,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					totalLines: {
						type: "integer",
						required: true
					},
					lineBegin: {
						type: "integer",
						required: true
					},
					lineEnd: {
						type: "integer",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderRead(value, maxResultBytes)
			}]
		},
		execute(args, exec) {
			const result = ctx.terminals.read(requireAgent(exec.agent), sessionId(args), {
				...args.offset !== void 0 ? { offset: args.offset } : {},
				...args.count !== void 0 ? { count: args.count } : {}
			});
			return Promise.resolve(result);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Read terminal ${args.sessionId}`,
			kind: "read",
			rawInput: args
		})
	}));
	ctx.tools.register(defineTool({
		name: "terminal_signal",
		description: "Send an allowed signal to the current foreground process group of a persistent terminal.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Terminal session id."
			},
			signal: {
				type: "string",
				required: true,
				enum: [
					"SIGINT",
					"SIGTERM",
					"SIGKILL",
					"SIGTSTP",
					"SIGHUP"
				],
				description: "Signal to deliver. Shell-targeted SIGKILL is rejected; use terminal_close."
			}
		},
		finalizeContent,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					delivered: {
						type: "boolean",
						required: true,
						const: true
					},
					targetPgid: {
						type: "integer",
						required: true
					}
				}
			},
			render: (args, value) => [{
				type: "text",
				text: `delivered ${args.signal} to foreground process group ${value.targetPgid}`
			}]
		},
		async execute(args, exec) {
			return ctx.terminals.signal(requireAgent(exec.agent), sessionId(args), args.signal);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Signal terminal ${args.sessionId}`,
			kind: "execute",
			rawInput: args
		})
	}));
	ctx.tools.register(defineTool({
		name: "terminal_close",
		description: "Close one persistent terminal and wait until its captured owned process tree is gone.",
		parameters: { sessionId: {
			type: "string",
			required: true,
			description: "Terminal session id."
		} },
		finalizeContent,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessionId: {
						type: "string",
						required: true
					},
					outcome: {
						type: "string",
						required: true,
						enum: ["closed", "already-closing"]
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.outcome === "closed" ? `closed terminal session ${value.sessionId}` : `terminal session ${value.sessionId} was already closing`
			}]
		},
		async execute(args, exec) {
			const id = sessionId(args);
			return {
				sessionId: id,
				outcome: await ctx.terminals.kill(requireAgent(exec.agent), id) ? "closed" : "already-closing"
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Close terminal ${args.sessionId}`,
			kind: "delete"
		})
	}));
	ctx.tools.register(defineTool({
		name: "terminal_list",
		description: "List persistent terminal sessions owned by the current agent.",
		parameters: {},
		finalizeContent,
		output: {
			schema: {
				type: "array",
				items: SESSION_SNAPSHOT_SCHEMA
			},
			render: (_args, value) => [{
				type: "text",
				text: renderList(value, maxResultBytes)
			}]
		},
		execute(_args, exec) {
			return Promise.resolve(ctx.terminals.list(requireAgent(exec.agent)));
		},
		presentCall: () => ({
			card: "generic",
			title: "List terminal sessions",
			kind: "read"
		})
	}));
}
//#endregion
export { Config, DEFAULT_MAX_RESULT_BYTES, MIN_MAX_RESULT_BYTES, apply, inject, name };
