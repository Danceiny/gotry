import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assertNever } from "@deepseek-ai/dsh-llm";
import { LspError } from "@deepseek-ai/dsh-lsp";
import { FIRST_PARTY_SECTION_ORDER } from "@deepseek-ai/dsh-system-prompt";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
//#region lib/types/render.js
/**
* Pure formatting and coordinate conversion for the `lsp` tool: one-based↔zero-based UTF-16 cursor
* conversion, workspace-grouped location rendering with `file:`-URI resolution, complete-result
* capping, and UI presentation. No I/O — a UI may call the presenter on live streaming and on
* replay, so it depends only on the tool arguments.
* @module @deepseek-ai/dsh-tool-lsp/render
*/
/** The four operations the tool exposes, as a runtime tuple for schema enum + validation. */
const LSP_OPERATIONS = [
	"goToDefinition",
	"findReferences",
	"goToImplementation",
	"hover"
];
/** Default cap on rendered locations before an omission marker is appended. */
const DEFAULT_MAX_LOCATIONS = 100;
/** Default cap on the complete rendered tool result, including truncation metadata. */
const DEFAULT_MAX_RESULT_CHARS = 16e3;
/**
* Validate and convert model arguments: `operation` must be one of the four; `line`/`character` are
* positive one-based integers converted to the seam's zero-based position.
* @param args - the schema-validated raw arguments.
* @returns the validated input with a zero-based position.
* @throws Error when the operation is unknown or a coordinate is not a positive integer.
*/
function parseLspArgs(args) {
	if (!isOperation(args.operation)) throw new Error(`operation must be one of ${LSP_OPERATIONS.join(", ")}`);
	if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
	const line = oneBased(args.line, "line");
	const character = oneBased(args.character, "character");
	return {
		operation: args.operation,
		filePath: args.file_path,
		position: {
			line: line - 1,
			character: character - 1
		}
	};
}
/** Whether a string is one of the four operations. */
function isOperation(value) {
	return LSP_OPERATIONS.includes(value);
}
/** Validate a one-based coordinate is a positive integer. */
function oneBased(value, name) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer (one-based)`);
	return value;
}
/**
* Render a locations result grouped by file, converting each zero-based location back to a one-based
* `path:line:character` entry. A `file:` URI inside the workspace becomes a workspace-relative path;
* outside it, a URI-derived absolute path; a non-`file:` URI is kept verbatim. Applies `maxLocations` and
* appends an omission marker when it truncates by count, then applies the complete result cap.
* @param locations - the seam's locations (possibly empty).
* @param workspaceUri - the provider's canonical workspace `file:` URI.
* @param maxLocations - the cap before truncation.
* @param maxResultChars - the complete rendered-text cap, including truncation metadata.
* @returns the rendered text; a distinct no-result line when there are none.
*/
function formatLocations(locations, workspaceUri, maxLocations, maxResultChars) {
	if (locations.length === 0) return boundResult("No results.", maxResultChars, "locations");
	const shown = locations.slice(0, maxLocations);
	const omitted = locations.length - shown.length;
	const grouped = /* @__PURE__ */ new Map();
	for (const location of shown) {
		const path = renderUri(location.uri, workspaceUri);
		const line = location.range.start.line + 1;
		const character = location.range.start.character + 1;
		const entries = grouped.get(path) ?? [];
		entries.push(`${path}:${line}:${character}`);
		grouped.set(path, entries);
	}
	const lines = [];
	for (const entries of grouped.values()) lines.push(...entries);
	if (omitted > 0) lines.push(`… ${omitted} more location${omitted === 1 ? "" : "s"} omitted (limit ${maxLocations}).`);
	return boundResult(lines.join("\n"), maxResultChars, "locations");
}
/**
* Render a hover result, applying `maxResultChars` last and keeping its marker within the cap.
* @param hover - the normalized hover, or `null` for no hover.
* @param maxResultChars - the complete rendered-text cap, including truncation metadata.
* @returns the rendered hover text; a distinct no-result line for `null`.
*/
function formatHover(hover, maxResultChars) {
	return boundResult(hover === null ? "No hover information." : hover.contents, maxResultChars, "hover");
}
/** Bound a complete rendered result, including the truncation notice itself. */
function boundResult(text, maxChars, label) {
	if (text.length <= maxChars) return text;
	const notice = `\n… ${label} truncated (limit ${maxChars} characters).`;
	if (notice.length >= maxChars) return notice.slice(0, maxChars);
	return `${text.slice(0, maxChars - notice.length)}${notice}`;
}
/**
* Resolve a location URI without applying the harness host's path rules. A valid `file:` URI becomes
* workspace-relative when it is under the provider's canonical workspace URI, or a URI-derived
* absolute path otherwise; malformed and non-`file:` URIs remain verbatim.
* @param uri - the target URI from the seam.
* @param workspaceUri - the provider's canonical workspace `file:` URI.
* @returns the display path or the verbatim URI.
*/
function renderUri(uri, workspaceUri) {
	if (!uri.startsWith("file:")) return uri;
	let target;
	let workspace;
	try {
		target = new URL(uri);
		workspace = new URL(workspaceUri);
	} catch {
		return uri;
	}
	if (workspace.protocol !== "file:") return uri;
	const drivePath = /^\/[a-z](?::|%3A)/iu;
	const windowsWorld = workspace.hostname.length > 0 || drivePath.test(workspace.pathname);
	const targetWindowsWorld = windowsWorld && (target.hostname.length > 0 || drivePath.test(target.pathname));
	const workspacePath = filePath(workspace, windowsWorld);
	const targetPath = filePath(target, targetWindowsWorld);
	if (workspacePath === void 0 || targetPath === void 0) return uri;
	if (windowsWorld !== targetWindowsWorld) return targetPath;
	const path = windowsWorld ? win32 : posix;
	const relative = path.relative(workspacePath, targetPath);
	const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	const rendered = relative === "" ? "." : outside ? targetPath : relative;
	return windowsWorld ? rendered.replaceAll("\\", "/") : rendered;
}
/** Decode a file URL for its execution world while containing malformed URL failures. */
function filePath(url, windows) {
	try {
		const path = fileURLToPath(url, { windows });
		return path.includes("\0") ? void 0 : path;
	} catch {
		return;
	}
}
/**
* UI presentation for a pending `lsp` call. Uses a generic search card; the title carries the
* operation and one-based cursor, and `locations` focuses the queried line. The shared location
* shape has no character, so the title preserves the column.
* @param args - the raw tool arguments.
* @returns the generic call view.
*/
function presentLspCall(args) {
	return {
		card: "generic",
		kind: "search",
		title: `LSP ${args.operation} ${args.file_path}:${args.line}:${args.character}`,
		locations: [{
			path: args.file_path,
			line: args.line
		}]
	};
}
//#endregion
//#region lib/types/session-cwd.js
/**
* Derive the workspace root an `lsp` call resolves against from the calling
* agent's session. A missing cwd fails as `LSP_WORKSPACE_REQUIRED` because the
* local provider must canonicalize a real workspace before starting a server.
* @module @deepseek-ai/dsh-tool-lsp/session-cwd
*/
/**
* The session workspace cwd for this call, or `undefined` when none applies.
* @param exec - the tool-execution context; only its optional `agent` is read.
* @returns the calling agent's session cwd, or undefined for a non-agent caller.
*/
function sessionCwd(exec) {
	return exec.agent?.session.header.cwd;
}
//#endregion
//#region lib/types/index.js
/**
* Model-facing `lsp` tool over `ctx.lsp`. One read-only tool with four operations
* (`goToDefinition`/`findReferences`/`goToImplementation`/`hover`); it converts one-based UTF-16
* cursor coordinates to the seam's zero-based positions, requires the session workspace with no
* fallback, caps and renders results, and attaches a configurable timeout budget for
* `dsh-tool-call-timeout-policy` to enforce. It runtime-injects only `tools`, `lsp`, and `systemPrompt` and
* imports no provider.
*
* Namespace plugin (named exports, no default export).
* @module @deepseek-ai/dsh-tool-lsp
*/
/** Cordis plugin name for loader diagnostics. */
const name = "tool-lsp";
/** Services required by this plugin. */
const inject = [
	"tools",
	"lsp",
	"systemPrompt"
];
/** Default tool-call timeout budget (ms), covering the queued open/query/close lifecycle. */
const DEFAULT_LSP_TOOL_TIMEOUT_MS = 6e4;
/** The stable system-prompt guidance positioning LSP as a precision aid. */
const LSP_PROMPT_TEXT = "Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration.";
const Config = z.object({
	maxLocations: z.number().default(100),
	maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
	timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_LSP_TOOL_TIMEOUT_MS)
});
const LSP_POSITION_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		line: {
			type: "integer",
			required: true
		},
		character: {
			type: "integer",
			required: true
		}
	}
};
const LSP_RANGE_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		start: {
			...LSP_POSITION_OUTPUT_SCHEMA,
			required: true
		},
		end: {
			...LSP_POSITION_OUTPUT_SCHEMA,
			required: true
		}
	}
};
/**
* Register the `lsp` tool and its system-prompt guidance.
* @param ctx - the plugin context (must inject `tools`, `lsp`, `systemPrompt`).
* @param config - the resolved plugin configuration.
*/
function apply(ctx, config) {
	const resolved = config;
	assertPositiveInteger("maxLocations", resolved.maxLocations);
	assertPositiveInteger("maxResultChars", resolved.maxResultChars);
	assertTimer("timeoutMs", resolved.timeoutMs);
	ctx.systemPrompt.section({
		name: "tool:lsp",
		order: FIRST_PARTY_SECTION_ORDER.TOOL_LSP,
		text: LSP_PROMPT_TEXT
	});
	ctx.tools.register(defineTool({
		name: "lsp",
		description: "Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.",
		parameters: {
			operation: {
				type: "string",
				required: true,
				enum: [...LSP_OPERATIONS],
				description: "goToDefinition, findReferences, goToImplementation, or hover."
			},
			file_path: {
				type: "string",
				required: true,
				description: "The source file to query, relative to the workspace or absolute."
			},
			line: {
				type: "number",
				required: true,
				description: "One-based line of the cursor."
			},
			character: {
				type: "number",
				required: true,
				description: "One-based UTF-16 column of the cursor."
			}
		},
		output: {
			schema: { oneOf: [{
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "locations"
					},
					locations: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								uri: {
									type: "string",
									required: true
								},
								range: {
									...LSP_RANGE_OUTPUT_SCHEMA,
									required: true
								}
							}
						}
					},
					resolvedWorkspaceUri: {
						type: "string",
						required: true
					}
				}
			}, {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "hover"
					},
					hover: {
						required: true,
						oneOf: [{ type: "null" }, {
							type: "object",
							additionalProperties: false,
							properties: {
								contents: {
									type: "string",
									required: true
								},
								range: LSP_RANGE_OUTPUT_SCHEMA
							}
						}]
					}
				}
			}] },
			render: (_args, value) => {
				switch (value.kind) {
					case "locations": return [{
						type: "text",
						text: formatLocations(value.locations, value.resolvedWorkspaceUri, resolved.maxLocations, resolved.maxResultChars)
					}];
					case "hover": return [{
						type: "text",
						text: formatHover(value.hover, resolved.maxResultChars)
					}];
					/* v8 ignore next -- exhaustive over the output schema's closed union; unreachable. */
					default: return assertNever(value, "tool-lsp output");
				}
			}
		},
		timeoutMs: resolved.timeoutMs,
		async execute(args, exec) {
			const input = parseLspArgs(args);
			const workspaceRoot = sessionCwd(exec);
			if (workspaceRoot === void 0) throw new LspError("the lsp tool requires a session workspace cwd", "LSP_WORKSPACE_REQUIRED");
			const result = await ctx.lsp.query({
				operation: input.operation,
				filePath: input.filePath,
				position: input.position,
				workspaceRoot
			}, exec.signal);
			switch (result.kind) {
				case "locations": return {
					kind: "locations",
					locations: result.locations.map((location) => ({
						uri: location.uri,
						range: {
							start: {
								line: location.range.start.line,
								character: location.range.start.character
							},
							end: {
								line: location.range.end.line,
								character: location.range.end.character
							}
						}
					})),
					resolvedWorkspaceUri: result.resolvedWorkspaceUri
				};
				case "hover": return {
					kind: "hover",
					hover: result.hover === null ? null : {
						contents: result.hover.contents,
						...result.hover.range === void 0 ? {} : { range: {
							start: {
								line: result.hover.range.start.line,
								character: result.hover.range.start.character
							},
							end: {
								line: result.hover.range.end.line,
								character: result.hover.range.end.character
							}
						} }
					}
				};
				/* v8 ignore next -- exhaustive over the closed LspQueryResult union; unreachable. */
				default: return assertNever(result, "tool-lsp result");
			}
		},
		presentCall: presentLspCall
	}));
}
/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`tool-lsp: ${name} must be a positive integer`);
}
/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name, value) {
	if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) throw new Error(`tool-lsp: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`);
}
//#endregion
export { Config, DEFAULT_LSP_TOOL_TIMEOUT_MS, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS, LSP_OPERATIONS, LSP_PROMPT_TEXT, apply, formatHover, formatLocations, inject, name, parseLspArgs, presentLspCall, renderUri, sessionCwd };
