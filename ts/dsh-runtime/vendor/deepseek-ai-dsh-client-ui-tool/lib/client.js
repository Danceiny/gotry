window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-tool",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region ../../util/workspace-path/src/index.ts
		/**
		* Browser-safe Workspace path and display helpers.
		* @module @deepseek-ai/dsh-util-workspace-path
		*/
		/** Whether a path uses a Windows drive or UNC prefix. */
		function isWindowsStylePath(value) {
			return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
		}
		/**
		* Resolve a Workspace-relative path into the Host-facing spelling used by path operations.
		* @param cwd - Session Workspace root, when known.
		* @param path - Absolute or Workspace-relative path.
		* @returns an absolute path when a Workspace root is available, otherwise the original path.
		*/
		function resolveWorkspacePath(cwd, path) {
			if (path.startsWith("/") || isWindowsStylePath(path)) return path;
			if (cwd === void 0 || cwd === "") return path;
			return `${cwd.replace(/[/\\]+$/, "")}/${path.replace(/^[/\\]+/, "")}`;
		}
		/**
		* Abbreviate a POSIX home directory for display.
		* @param path - Absolute or already-short display path.
		* @param home - Host account home; absent skips abbreviation.
		* @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
		*/
		function abbreviateHomePath(path, home) {
			if (home === void 0 || home === "") return path;
			if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path;
			const root = home.replace(/\/+$/, "");
			if (root === "" || root === "/") return path;
			if (path.replace(/\/+$/, "") === root) return "~";
			if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
			return path;
		}
		//#endregion
		//#region lib/types/client/tool/models/tool-call-model.js
		/** Locale key per generic row variant. */
		const VARIANT_TITLE_KEYS = {
			search: "tool.title.search",
			read: "tool.title.read",
			bash: "tool.title.bash",
			write: "tool.title.write",
			edit: "tool.title.edit",
			code: "tool.title.code",
			others: "tool.title.generic"
		};
		/**
		* Known tool name -> variant.
		*
		* `cordis_define` is deliberately absent: ui-cordis registers a keyed
		* `tool.call.toolview` entry for it, and a keyed hit REPLACES the generic row
		* (this table is only reached through GenericToolCard, the dispatch fallback in
		* ToolCallTree). An entry here would be unreachable, and a second title for the
		* same call would be a second answer to a question the card already owns.
		*/
		const TOOL_VARIANTS = {
			bash: "bash",
			pwsh: "bash",
			read: "read",
			web_fetch: "read",
			web_search: "search",
			grep: "search",
			glob: "search",
			write: "write",
			edit: "edit",
			run_code: "code",
			cordis_package_inspect: "read",
			cordis_runtime_inspect: "read",
			cordis_run: "others",
			cordis_stop: "others",
			cordis_undefine: "others"
		};
		/** Tool-owned titles that refine a generic row variant without replacing it. */
		const TOOL_TITLE_KEYS = {
			cordis_package_inspect: "tool.title.inspect",
			cordis_runtime_inspect: "tool.title.inspect",
			cordis_run: "tool.title.runCordis",
			cordis_stop: "tool.title.stopCordis",
			cordis_undefine: "tool.title.removeCordis",
			pwsh: "tool.title.pwsh"
		};
		/**
		* Classify a tool name into its row variant.
		* @param toolName - wire tool name.
		* @returns matching variant, others when unknown.
		*/
		function classifyTool(toolName) {
			return TOOL_VARIANTS[toolName] ?? "others";
		}
		/**
		* Flatten a settled result's content blocks to display text: text blocks
		* verbatim, other block shapes as pretty JSON. Empty content on a failed call
		* falls back to the structured error's `name: code` line.
		* @param node - the settled result node.
		* @returns the flattened result text (may be empty).
		*/
		function resultText(node) {
			const parts = [];
			for (const block of node.content) if (block.type === "text") parts.push(block.text);
			else parts.push(JSON.stringify(block, null, 2));
			if (parts.length === 0 && node.error !== void 0) parts.push(`${node.error.name}: ${node.error.code}`);
			return parts.join("\n");
		}
		function parseArgs(argsRaw) {
			try {
				return JSON.parse(argsRaw);
			} catch {
				return;
			}
		}
		function firstLine(text) {
			const nl = text.indexOf("\n");
			return nl === -1 ? text : text.slice(0, nl);
		}
		function pickString(args, keys) {
			for (const key of keys) {
				const v = args[key];
				if (typeof v === "string" && v !== "") return v;
			}
		}
		/** Summary key preference per variant (args-derived; result-derived summaries are a ledger item). */
		const SUMMARY_KEYS = {
			bash: ["description", "command"],
			read: [
				"path",
				"file_path",
				"url"
			],
			search: [
				"query",
				"pattern",
				"url"
			],
			write: ["path", "file_path"],
			edit: ["path", "file_path"],
			code: ["description"],
			others: []
		};
		/**
		* Strip the workspace root from a workspace-rooted absolute path (display only).
		* @param text - the path to shorten.
		* @param cwd - session workspace root; absent or empty leaves the path unchanged.
		* @returns the path relative to the workspace root, or unchanged when it is not rooted there.
		*/
		function relativizeToCwd(text, cwd) {
			if (cwd === void 0 || cwd === "") return text;
			const root = cwd.replace(/[/\\]+$/, "");
			if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1);
			return text;
		}
		function deriveSummary(variant, argsRaw) {
			const parsed = parseArgs(argsRaw);
			if (typeof parsed !== "object" || parsed === null) return firstLine(argsRaw);
			const args = parsed;
			if (variant === "search" && Array.isArray(args.queries)) {
				const queries = args.queries.filter((query) => typeof query === "string" && query !== "");
				if (queries.length > 0) return queries.map(firstLine).join(", ");
			}
			const picked = pickString(args, SUMMARY_KEYS[variant]);
			if (picked !== void 0) return firstLine(picked);
			for (const v of Object.values(args)) if (typeof v === "string" && v !== "") return firstLine(v);
			return firstLine(argsRaw);
		}
		/** Path keys only — never `url` (web_fetch lands on the read variant). */
		const FILE_PATH_KEYS = ["path", "file_path"];
		/** File-tool variants whose summary may be an openable workspace path. */
		const FILE_PATH_VARIANTS = new Set([
			"read",
			"write",
			"edit"
		]);
		function deriveFilePath(variant, argsRaw) {
			if (!FILE_PATH_VARIANTS.has(variant)) return void 0;
			const parsed = parseArgs(argsRaw);
			if (typeof parsed !== "object" || parsed === null) return void 0;
			const picked = pickString(parsed, FILE_PATH_KEYS);
			return picked === void 0 ? void 0 : firstLine(picked);
		}
		function deriveBody(variant, argsRaw) {
			if (argsRaw === "") return null;
			const parsed = parseArgs(argsRaw);
			if (parsed === void 0) return argsRaw;
			if (variant === "code" && typeof parsed === "object" && parsed !== null) {
				const code = parsed.code;
				if (typeof code === "string" && code !== "") return code;
			}
			return JSON.stringify(parsed, null, 2);
		}
		/**
		* Derive the full row model from a frozen call slice.
		* @param toolName - wire tool name (dispatch-supplied; survives windowless results).
		* @param block - RunningToolCall or ToolResultNode off the snapshot caches.
		* @param cwd - session workspace root; workspace-rooted path summaries display relative to it.
		* @param home - host account home; a leftover POSIX home path displays as `~`.
		* @returns the row model.
		*/
		function toolRowModel(toolName, block, cwd, home) {
			const variant = classifyTool(toolName);
			const done = "kind" in block;
			const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? "";
			const state = !done ? "running" : block.error?.code === "interrupted" ? "stopped" : block.isError ? "error" : "ok";
			const base = argsRaw === "" ? block.callId : abbreviateHomePath(relativizeToCwd(deriveSummary(variant, argsRaw), cwd), home);
			const toolTitleKey = TOOL_TITLE_KEYS[toolName];
			const summary = variant === "others" && toolName !== "" && toolTitleKey === void 0 ? `${toolName} · ${base}` : base;
			const output = done ? resultText(block) || null : null;
			const errorSummary = state === "error" && output !== null ? firstLine(output) : null;
			return {
				variant,
				titleKey: toolTitleKey ?? VARIANT_TITLE_KEYS[variant],
				summary,
				filePath: deriveFilePath(variant, argsRaw),
				body: deriveBody(variant, argsRaw),
				output,
				errorSummary,
				state
			};
		}
		//#endregion
		//#region lib/types/client/tool/models/raw-tool-call.js
		const parsedCalls = /* @__PURE__ */ new WeakMap();
		/**
		* Parse the call head paired with one immutable Tool block.
		* @param block - running or settled Tool block.
		* @returns the Tool name and object arguments, or null when the call head or valid JSON object is unavailable.
		*/
		function parsedToolCall(block) {
			const cached = parsedCalls.get(block);
			if (cached !== void 0 || parsedCalls.has(block)) return cached ?? null;
			const call = "kind" in block ? block.call : block;
			if (call === null) {
				parsedCalls.set(block, null);
				return null;
			}
			let value;
			try {
				value = JSON.parse(call.argsRaw);
			} catch {
				parsedCalls.set(block, null);
				return null;
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				parsedCalls.set(block, null);
				return null;
			}
			const parsed = {
				name: call.name,
				args: value
			};
			parsedCalls.set(block, parsed);
			return parsed;
		}
		/**
		* Read the exact single text block consumed by first-party card derivations.
		* @param block - settled Tool result.
		* @returns its text, or undefined for any other content layout.
		*/
		function singleResultText(block) {
			if (block.content.length !== 1) return void 0;
			const only = block.content[0];
			return only?.type === "text" ? only.text : void 0;
		}
		/**
		* Validate the optional escalation pair shared by first-party shell and file
		* mutation tools.
		* @param args - parsed open-root Tool arguments.
		* @returns whether the declared escalation fields form a valid pair.
		*/
		function validEscalationFields(args) {
			const permission = args.sandbox_permissions;
			const justification = args.justification;
			if (permission === void 0 && justification === void 0) return true;
			if (permission !== "workspace-write" && permission !== "danger-full-access") return false;
			return typeof justification === "string" && justification.trim() !== "";
		}
		//#endregion
		//#region lib/types/client/tool/models/read-card-model.js
		function validReadCall(block) {
			const call = parsedToolCall(block);
			if (call?.name !== "read") return false;
			const { file_path: path, offset, limit } = call.args;
			if (typeof path !== "string" || path.trim() === "") return false;
			if (offset !== void 0 && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1)) return false;
			if (limit !== void 0 && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return false;
			return true;
		}
		function readMeta(meta) {
			if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
			const { path, offset, lines, totalLines, lang } = meta;
			if (typeof path !== "string" || typeof offset !== "number" || !Number.isInteger(offset) || offset < 1) return null;
			if (typeof totalLines !== "number" || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines)) return null;
			if (lang !== void 0 && typeof lang !== "string") return null;
			const narrowed = [];
			let previous = offset - 1;
			for (const line of lines) {
				if (typeof line !== "object" || line === null || Array.isArray(line)) return null;
				const { number, text } = line;
				if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number <= previous) return null;
				if (number > totalLines || typeof text !== "string") return null;
				previous = number;
				narrowed.push({
					number,
					text
				});
			}
			return {
				path,
				offset,
				lines: narrowed,
				totalLines,
				...lang === void 0 ? {} : { lang }
			};
		}
		/**
		* Derive a settled root read card after validating its persisted metadata and
		* model-facing read envelope.
		* @param block - running or settled Tool block.
		* @param sessionCwd - the session workspace root; a workspace-rooted absolute
		*   path label displays relative to it. Absent leaves the path as authored.
		* @param home - host account home; a leftover POSIX home path displays as `~`.
		* @returns the read-card props, or null for the generic path.
		*/
		function readCardModel(block, sessionCwd, home) {
			if (block.parentCallId !== void 0 || !("kind" in block) || block.isError) return null;
			if (!validReadCall(block)) return null;
			const meta = readMeta(block.meta);
			if (meta === null) return null;
			const text = singleResultText(block);
			if (text === void 0) return null;
			if (/^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1] === void 0) return null;
			return {
				label: abbreviateHomePath(relativizeToCwd(meta.path, sessionCwd), home),
				lines: meta.lines,
				totalLines: meta.totalLines,
				lang: meta.lang
			};
		}
		//#endregion
		//#region lib/types/client/tool/models/diff-card-model.js
		/**
		* Narrow opaque result metadata's `diffs` to well-formed hunks.
		* @param diffs - the metadata field to validate.
		* @returns the validated hunks, or null when the payload is not usable.
		*/
		function narrowDiffs(diffs) {
			if (!Array.isArray(diffs) || diffs.length === 0) return null;
			const out = [];
			for (const hunk of diffs) {
				if (typeof hunk !== "object" || hunk === null) return null;
				const { path, oldText, newText } = hunk;
				if (typeof path !== "string") return null;
				if (oldText !== null && typeof oldText !== "string") return null;
				if (typeof newText !== "string") return null;
				out.push({
					path,
					oldText,
					newText
				});
			}
			return out;
		}
		function intendedDiff(block) {
			const parsed = parsedToolCall(block);
			if (parsed === null) return null;
			if (parsed.name === "str_replace_editor") {
				const { command, path, file_text: fileText, old_str: oldText, new_str: newText } = parsed.args;
				if (typeof path !== "string" || path.trim() === "") return null;
				if (command === "create") {
					if (fileText !== void 0 && typeof fileText !== "string") return null;
					return {
						tool: "str_replace_editor",
						diff: {
							path,
							oldText: null,
							newText: fileText ?? ""
						}
					};
				}
				if (command === "str_replace") {
					if (oldText !== void 0 && typeof oldText !== "string") return null;
					if (newText !== void 0 && typeof newText !== "string") return null;
					return {
						tool: "str_replace_editor",
						diff: {
							path,
							oldText: oldText ?? null,
							newText: newText ?? ""
						}
					};
				}
				return null;
			}
			const { file_path: path } = parsed.args;
			if (typeof path !== "string" || path.trim() === "") return null;
			if (!validEscalationFields(parsed.args)) return null;
			if (parsed.name === "write") {
				const { content } = parsed.args;
				return typeof content === "string" ? {
					tool: "write",
					diff: {
						path,
						oldText: null,
						newText: content
					}
				} : null;
			}
			if (parsed.name !== "edit") return null;
			const { old_string: oldText, new_string: newText, replace_all: replaceAll } = parsed.args;
			if (typeof oldText !== "string" || typeof newText !== "string") return null;
			if (replaceAll !== void 0 && typeof replaceAll !== "boolean") return null;
			return {
				tool: "edit",
				diff: {
					path,
					oldText: oldText || null,
					newText
				}
			};
		}
		function appliedDiffs(meta) {
			if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
			const diffs = meta.diffs;
			if (!Array.isArray(diffs)) return null;
			if (diffs.length === 0) return "empty";
			return narrowDiffs(diffs);
		}
		/**
		* Derive running diffs for root write/edit and `str_replace_editor`
		* create/replace calls, plus applied settled diffs for root write/edit calls.
		* A successful write with valid empty metadata uses its argument-derived
		* whole-file diff, matching create and identical-overwrite presentation;
		* `str_replace_editor` settles through Generic because it has no result view.
		* @param block - running or settled Tool block.
		* @returns the diff-card props, or null for the generic path.
		*/
		function diffCardModel(block) {
			if (block.parentCallId !== void 0) return null;
			const intended = intendedDiff(block);
			if (intended === null) return null;
			if (!("kind" in block)) return { card: { diffs: [intended.diff] } };
			if (intended.tool === "str_replace_editor") return null;
			if (block.isError) return null;
			const applied = appliedDiffs(block.meta);
			if (applied === null || applied === "empty") return intended.tool === "write" ? { card: { diffs: [intended.diff] } } : null;
			return { card: { diffs: applied } };
		}
		//#endregion
		//#region lib/types/client/tool/models/search-card-model.js
		function validSearchCall(block) {
			const call = parsedToolCall(block);
			if (call === null) return null;
			const { pattern, path } = call.args;
			if (typeof pattern !== "string") return null;
			if (call.name === "grep" && pattern === "") return null;
			if (call.name === "glob" && pattern.trim() === "") return null;
			if (call.name !== "grep" && call.name !== "glob") return null;
			if (path !== void 0 && (typeof path !== "string" || path.trim() === "")) return null;
			if (call.name === "grep") {
				const { include } = call.args;
				if (include !== void 0 && (typeof include !== "string" || !validInclude(include))) return null;
			}
			return call.name;
		}
		function validInclude(include) {
			if (include.trim() === "" || include.startsWith("!")) return false;
			let braceDepth = 0;
			for (const character of include) if (character === "{") braceDepth += 1;
			else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
			else if (character === "," && braceDepth === 0) return false;
			return true;
		}
		function searchFiles(value) {
			if (!Array.isArray(value)) return null;
			const files = [];
			for (const file of value) {
				if (typeof file !== "object" || file === null || Array.isArray(file)) return null;
				const { path, matches } = file;
				if (typeof path !== "string" || !Array.isArray(matches)) return null;
				const narrowed = [];
				for (const match of matches) {
					if (typeof match !== "object" || match === null || Array.isArray(match)) return null;
					const { lineNumber, line } = match;
					if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) return null;
					if (typeof line !== "string") return null;
					narrowed.push({
						lineNumber,
						line
					});
				}
				files.push({
					path,
					matches: narrowed
				});
			}
			return files;
		}
		function flattenContent(content) {
			const text = content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
			return text === "" ? void 0 : text;
		}
		/**
		* Derive a settled root grep/glob card from persisted metadata.
		* @param block - running or settled Tool block.
		* @returns search-card props, or null for the generic path.
		*/
		function searchCardModel(block) {
			if (block.parentCallId !== void 0 || !("kind" in block) || block.isError) return null;
			const tool = validSearchCall(block);
			if (tool === null) return null;
			if (typeof block.meta !== "object" || block.meta === null || Array.isArray(block.meta)) return null;
			const meta = block.meta;
			if (typeof meta.truncated !== "boolean") return null;
			if (typeof meta.total !== "number" || !Number.isInteger(meta.total) || meta.total < 0) return null;
			const common = {
				truncated: meta.truncated,
				total: meta.total
			};
			const recovery = meta.truncated ? flattenContent(block.content) : void 0;
			if (tool === "grep") {
				if (meta.shape !== "matches") return null;
				const files = searchFiles(meta.files);
				return files === null ? null : {
					recovery,
					card: {
						kind: "matches",
						files,
						...common
					}
				};
			}
			if (meta.shape !== "paths" || !Array.isArray(meta.paths)) return null;
			if (!meta.paths.every((path) => typeof path === "string")) return null;
			return {
				recovery,
				card: {
					kind: "paths",
					paths: [...meta.paths],
					...common
				}
			};
		}
		//#endregion
		//#region lib/types/client/tool/models/terminal-card-model.js
		/**
		* Build the TerminalBlock display copy from the conversation locale seat —
		* the one place the primitive's label surface pairs with this package's
		* dictionary, shared by every terminal render site (chat row, bash row,
		* details panel).
		* @param t - the render site's conversation locale seat.
		* @returns the full label set for {@link TerminalBlockProps}'s `labels`.
		*/
		function terminalBlockLabels(t) {
			return {
				signal: (signal) => t("terminal.signal", { signal }),
				exitCode: (code) => t("terminal.exitCode", { code }),
				running: t("terminal.running"),
				failed: t("terminal.failed"),
				done: t("terminal.done"),
				copy: t("copy"),
				copied: t("copied"),
				noOutput: t("terminal.noOutput"),
				collapseAria: t("terminal.collapseAria"),
				collapse: t("collapse"),
				expandAria: (hidden) => t("terminal.expandAria", { n: hidden }),
				expand: (hidden) => t("terminal.expandRest", { n: hidden })
			};
		}
		/**
		* Resolve locale-owned `terminal_send` copy while preserving Tool-authored
		* shell commands and descriptions verbatim.
		* @param model - locale-neutral terminal card data.
		* @param t - the render site's conversation locale seat.
		* @returns terminal props and description ready for rendering.
		*/
		function localizeTerminalCardModel(model, t) {
			if (model.copy.kind === "shell") return {
				card: {
					command: model.copy.command,
					...model.card
				},
				description: model.copy.description
			};
			return {
				card: {
					command: model.copy.text === "" ? t("terminal.sendInput") : model.copy.text,
					...model.card
				},
				description: t("terminal.session", { sessionId: model.copy.sessionId })
			};
		}
		/**
		* True when a settled terminal card reports a failing exit — a non-zero code
		* or a terminating signal. The bash tool settles a failing command as a
		* completed call (`isError` stays false: the exit status is result data), so
		* this is the collapsed row's only failure signal; without it the red exit
		* pill would be visible only after expanding the card.
		* @param model - a derived terminal card.
		* @returns whether the card's exit status is a failure.
		*/
		function terminalFailed(model) {
			const { exitCode, signal, running } = model.card;
			return running !== true && (exitCode !== void 0 && exitCode !== 0 || signal !== void 0);
		}
		/**
		* Resolve a shell call's workdir for display: an absolute path is used as-is,
		* a relative one joins under the session workspace, and an omitted one is the
		* session workspace. Without a session cwd, a relative path stays as authored
		* and an omitted one stays absent.
		* @param workdir - the raw call's workdir, if any.
		* @param sessionCwd - the session workspace root, if the caller knows it.
		* @returns the working directory for the prompt label, or undefined.
		*/
		function resolveTerminalCwd(workdir, sessionCwd) {
			if (workdir === void 0 || workdir === "") return sessionCwd;
			if (sessionCwd === void 0 || sessionCwd === "") return normalizeSegments(workdir);
			return normalizeSegments(resolveWorkspacePath(sessionCwd, workdir));
		}
		/**
		* Collapse `.` and `..` segments so the prompt label names the directory the
		* command actually ran in. The bash executor resolves the workdir before
		* running, so a joined `/w/app/..` must display as `w`, not as `..`. Separators
		* are preserved as authored (a Windows path keeps its backslashes) because this
		* value is only ever displayed; a `..` that would climb past the root is
		* dropped, which is what a filesystem does with it. A UNC path's `server` and
		* `share` are part of its root, not poppable segments: Windows cannot climb
		* above a share, so `\\\\server\\share` with a `..` stays there.
		* @param path - a joined or absolute path, possibly carrying `.`/`..` segments.
		* @returns the same path with those segments resolved.
		*/
		function normalizeSegments(path) {
			if (!/(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(path)) return path;
			const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/.exec(path);
			if (unc !== null) {
				const [matched, server, share] = unc;
				const root = `\\\\${String(server)}\\${String(share)}`;
				const rest = collapse(path.slice(matched.length), true);
				return rest === "" ? root : `${root}\\${rest}`;
			}
			const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
			const rooted = /^[/\\]/.test(path);
			const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
			const body = collapse(path.slice(drive.length), rooted || drive !== "", separator);
			const leading = rooted ? separator : "";
			return drive === "" ? `${leading}${body}` : `${drive}${rooted ? leading : separator}${body}`;
		}
		/**
		* Collapse the `.`/`..` segments of a path body against a known root state.
		* @param body - the path after any drive letter or UNC root.
		* @param rooted - the body hangs off a root, so a `..` at its top is dropped
		*   the way a filesystem drops one; without a root the `..` is kept, since it
		*   stays meaningful against a cwd this function cannot see.
		* @param separator - separator to rejoin with (default `/`).
		* @returns the collapsed body, without leading or trailing separators.
		*/
		function collapse(body, rooted, separator = "/") {
			const kept = [];
			for (const segment of body.split(/[/\\]/)) {
				if (segment === "" || segment === ".") continue;
				if (segment === "..") {
					if (kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
					else if (!rooted) kept.push(segment);
					continue;
				}
				kept.push(segment);
			}
			return kept.join(separator);
		}
		function shellCall(name, args) {
			if (name !== "bash" && name !== "pwsh") return null;
			const { command, description, timeoutMs, workdir, run_in_background: background } = args;
			if (typeof command !== "string" || command.trim() === "") return null;
			if (timeoutMs !== void 0 && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) return null;
			if (workdir !== void 0 && typeof workdir !== "string") return null;
			if (background !== void 0 && typeof background !== "boolean") return null;
			if (!validEscalationFields(args)) return null;
			if (description === void 0) return {
				kind: "shell",
				command,
				description: void 0,
				workdir: void 0,
				persistent: true,
				background: false
			};
			if (typeof description !== "string" || description.trim() === "") return null;
			return {
				kind: "shell",
				command,
				description,
				workdir,
				persistent: false,
				background: background === true
			};
		}
		/**
		* Identify a settled root call from the persistent Bash or PowerShell tool.
		* Its result stays on the generic input/output path because the persistent
		* shell can report resets and partial output without one process exit status.
		* @param block - running or settled Tool block.
		* @returns whether the block is a settled persistent-shell call.
		*/
		function isSettledPersistentShellCall(block) {
			if (!("kind" in block) || block.parentCallId !== void 0) return false;
			const parsed = parsedToolCall(block);
			if (parsed === null) return false;
			return shellCall(parsed.name, parsed.args)?.persistent === true;
		}
		function terminalSendCall(name, args) {
			if (name !== "terminal_send") return null;
			const { sessionId, text, submit, run_in_background: background } = args;
			if (typeof sessionId !== "string" || sessionId === "" || typeof text !== "string") return null;
			if (submit !== void 0 && typeof submit !== "boolean") return null;
			if (background !== void 0 && typeof background !== "boolean") return null;
			return {
				kind: "terminal-send",
				text,
				sessionId,
				background: background === true
			};
		}
		/**
		* Parse the marker literals owned by `@deepseek-ai/dsh-shell/render` without
		* importing that Host-only package into the Client dependency graph.
		* @param text - rendered shell result text.
		* @returns output with a trailing exit-code or signal marker extracted.
		*/
		function parseExitStatus(text) {
			const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
			if (signal?.[1] !== void 0) return {
				output: text.slice(0, signal.index),
				signal: signal[1]
			};
			const exit = /\n\[exit code: (\d+)\]$/.exec(text);
			if (exit?.[1] !== void 0) return {
				output: text.slice(0, exit.index),
				exitCode: Number(exit[1])
			};
			return {
				output: text,
				exitCode: 0
			};
		}
		/**
		* Derive terminal props for supported root shell and terminal-send calls.
		* Standard shell results parse their final status marker; persistent shell
		* results, background calls, errors, malformed input, or child dispatches use
		* the generic path. {@link isSettledPersistentShellCall} lets that generic
		* persistent result remain expandable without inventing one process status.
		* @param block - running or settled Tool block.
		* @param sessionCwd - session workspace root used to resolve workdir.
		* @returns locale-neutral terminal-card data, or null for the generic path.
		*/
		function terminalCardModel(block, sessionCwd) {
			if (block.parentCallId !== void 0) return null;
			const parsed = parsedToolCall(block);
			if (parsed === null) return null;
			const call = shellCall(parsed.name, parsed.args) ?? terminalSendCall(parsed.name, parsed.args);
			if (call === null || call.background) return null;
			const copy = call.kind === "shell" ? {
				kind: "shell",
				command: call.command,
				description: call.description
			} : {
				kind: "terminal-send",
				text: call.text,
				sessionId: call.sessionId
			};
			const cwd = resolveTerminalCwd(call.kind === "shell" ? call.workdir : void 0, sessionCwd);
			if (!("kind" in block)) return {
				copy,
				card: {
					cwd,
					output: void 0,
					exitCode: void 0,
					signal: void 0,
					running: true
				}
			};
			if (block.isError || call.kind === "shell" && call.persistent) return null;
			const output = singleResultText(block);
			if (output === void 0) return null;
			const status = call.kind === "terminal-send" ? { output } : parseExitStatus(output);
			return {
				copy,
				card: {
					cwd,
					output: status.output,
					exitCode: status.exitCode,
					signal: status.signal,
					running: false
				}
			};
		}
		//#endregion
		//#region lib/types/client/tool/models/web-card-model.js
		function validWebCall(block) {
			const call = parsedToolCall(block);
			if (call === null) return null;
			if (call.name === "web_search") {
				const { queries } = call.args;
				if (!Array.isArray(queries) || queries.length === 0) return null;
				return queries.every((query) => typeof query === "string" && query.trim() !== "") ? call.name : null;
			}
			if (call.name === "web_fetch") {
				const { url } = call.args;
				return typeof url === "string" && url.trim() !== "" ? call.name : null;
			}
			return null;
		}
		function webSources(value) {
			if (!Array.isArray(value)) return null;
			const sources = [];
			for (const source of value) {
				if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
				const { url, title, snippet, publishedAt } = source;
				if (typeof url !== "string") return null;
				if (title !== void 0 && typeof title !== "string") return null;
				if (snippet !== void 0 && typeof snippet !== "string") return null;
				if (publishedAt !== void 0 && typeof publishedAt !== "string") return null;
				sources.push({
					url,
					...title === void 0 ? {} : { title },
					...snippet === void 0 ? {} : { snippet },
					...publishedAt === void 0 ? {} : { publishedAt }
				});
			}
			return sources;
		}
		/**
		* Derive a settled root web-search or web-fetch card from persisted metadata.
		* @param block - running or settled Tool block.
		* @returns web-card props, or null for the generic path.
		*/
		function webCardModel(block) {
			if (block.parentCallId !== void 0 || !("kind" in block) || block.isError) return null;
			const tool = validWebCall(block);
			if (tool === null || typeof block.meta !== "object" || block.meta === null || Array.isArray(block.meta)) return null;
			const meta = block.meta;
			if (typeof meta.truncated !== "boolean") return null;
			if (tool === "web_search") {
				const sources = webSources(meta.sources);
				if (sources === null || meta.answer !== void 0 && typeof meta.answer !== "string") return null;
				return {
					kind: "search",
					answer: meta.answer,
					sources,
					truncated: meta.truncated
				};
			}
			if (typeof meta.url !== "string") return null;
			if (typeof meta.statusCode !== "number" || !Number.isInteger(meta.statusCode)) return null;
			return {
				kind: "fetch",
				url: meta.url,
				statusCode: meta.statusCode,
				truncated: meta.truncated
			};
		}
		//#endregion
		//#region ../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region lib/types/client/tool/models/primitive-labels.js
		/** Localized copy adapters for Cordis-free UI primitives used by Tool cards. */
		/**
		* Build localized Markdown chrome labels.
		* @param t - Conversation locale seat.
		* @returns Markdown chrome labels.
		*/
		function markdownLabels(t) {
			return {
				code: {
					copyLabel: t("copy"),
					copiedLabel: t("copied")
				},
				footnotes: t("markdown.footnotes")
			};
		}
		/**
		* Build localized diff-card chrome labels.
		* @param t - Conversation locale seat.
		* @returns Diff-card chrome labels.
		*/
		function diffBlockLabels(t) {
			return {
				copy: t("copy"),
				copied: t("copied"),
				collapseAria: t("diff.collapseAria"),
				expandAria: (count) => t("diff.expandAria", { count }),
				collapse: t("collapse"),
				expand: (count) => t("diff.expandRest", { count }),
				files: (count) => t(count === 1 ? "diff.files.one" : "diff.files.other", { count })
			};
		}
		/**
		* Build localized read-card chrome labels.
		* @param t - Conversation locale seat.
		* @returns Read-card chrome labels.
		*/
		function readBlockLabels(t) {
			return {
				window: (shown, total) => t("read.window", {
					shown,
					total
				}),
				copy: t("copy"),
				copied: t("copied"),
				collapseAria: t("read.collapseAria"),
				expandAria: (count) => t("read.expandAria", { count }),
				collapse: t("collapse"),
				expand: (count) => t("read.expandRest", { count })
			};
		}
		/**
		* Build localized search-card chrome labels.
		* @param t - Conversation locale seat.
		* @returns Search-card chrome labels.
		*/
		function searchBlockLabels(t) {
			return {
				pathsSummary: (shown, total, truncated) => t(truncated ? "search.paths.truncated" : "search.paths", {
					shown,
					total
				}),
				matchesSummary: (shown, total, files, truncated) => t(truncated ? "search.matches.truncated" : "search.matches", {
					shown,
					total,
					files
				}),
				copy: t("copy"),
				copied: t("copied"),
				noResults: t("search.noResults"),
				collapseAria: t("search.collapseAria"),
				expandAria: (count) => t("search.expandAria", { count }),
				collapse: t("collapse"),
				expand: (count) => t("search.expandRest", { count })
			};
		}
		/**
		* Build localized web-card chrome labels.
		* @param t - Conversation locale seat.
		* @returns Web-card chrome labels.
		*/
		function webBlockLabels(t) {
			return {
				noResults: t("web.noResults"),
				sourcesTruncated: t("web.sourcesTruncated"),
				http: t("web.http"),
				contentTruncated: t("web.contentTruncated"),
				markdown: markdownLabels(t)
			};
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-tool/src/client/tool/components/AskQuestionCard.module.css.mjs
		const css$4 = ".swW5CG_card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:12px;flex-direction:column;gap:16px;max-height:360px;margin:4px 0 4px 4px;padding:16px 20px;display:flex;overflow-y:auto}.swW5CG_item{flex-direction:column;gap:2px;min-width:0;display:flex}.swW5CG_question,.swW5CG_answer{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));margin:0}.swW5CG_question{color:var(--dsw-alias-label-tertiary)}.swW5CG_answer{color:var(--dsw-alias-label-primary)}.swW5CG_answerLine{display:block}.swW5CG_skipped{color:var(--dsw-alias-label-tertiary)}.swW5CG_verdict{color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));margin:0}.swW5CG_questionList{flex-direction:column;gap:8px;margin:0;padding-left:20px;display:flex}.swW5CG_unansweredQuestion{color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}";
		const tagId$4 = "@deepseek-ai/dsh-client-ui-tool/AskQuestionCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-tool";
			tag.dataset.pluginCss = tagId$4;
			tag.textContent = css$4;
			document.head.appendChild(tag);
		}
		var AskQuestionCard_module_css_default = {
			"answer": "swW5CG_answer",
			"answerLine": "swW5CG_answerLine",
			"card": "swW5CG_card",
			"item": "swW5CG_item",
			"question": "swW5CG_question",
			"questionList": "swW5CG_questionList",
			"skipped": "swW5CG_skipped",
			"unansweredQuestion": "swW5CG_unansweredQuestion",
			"verdict": "swW5CG_verdict"
		};
		//#endregion
		//#region lib/types/client/tool/components/AskQuestionCard.js
		/**
		* Render a validated ask-user transcript from plain card data.
		* @param props - Localized transcript card data.
		* @returns the readable answered or unanswered question list.
		*/
		function AskQuestionCard({ card }) {
			if (card.kind === "unanswered") return (0, react_jsx_runtime.jsxs)("div", {
				className: AskQuestionCard_module_css_default.card,
				children: [(0, react_jsx_runtime.jsx)("p", {
					className: AskQuestionCard_module_css_default.verdict,
					children: card.verdict
				}), (0, react_jsx_runtime.jsx)("ul", {
					className: AskQuestionCard_module_css_default.questionList,
					children: card.questions.map((question) => (0, react_jsx_runtime.jsx)("li", {
						className: AskQuestionCard_module_css_default.unansweredQuestion,
						children: question.question
					}, question.id))
				})]
			});
			return (0, react_jsx_runtime.jsx)("dl", {
				className: AskQuestionCard_module_css_default.card,
				children: card.questions.map((question) => (0, react_jsx_runtime.jsxs)("div", {
					className: AskQuestionCard_module_css_default.item,
					children: [(0, react_jsx_runtime.jsx)("dt", {
						className: AskQuestionCard_module_css_default.question,
						children: question.question
					}), (0, react_jsx_runtime.jsx)("dd", {
						className: AskQuestionCard_module_css_default.answer,
						children: question.answers.length === 0 ? (0, react_jsx_runtime.jsx)("span", {
							className: AskQuestionCard_module_css_default.skipped,
							children: card.skippedLabel
						}) : question.answers.map((answer, index) => (0, react_jsx_runtime.jsx)("span", {
							className: AskQuestionCard_module_css_default.answerLine,
							children: answer
						}, `${question.id}-${String(index)}`))
					})]
				}, question.id))
			});
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-tool/src/client/tool/components/ToolRow.module.css.mjs
		const css$3 = ".Sc5-RW_root{flex-direction:column;display:flex}.Sc5-RW_row{position:relative;overflow:hidden}.Sc5-RW_root[data-state=running] .Sc5-RW_row:after{content:\"\";background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite Sc5-RW_dsh-tool-row-sweep;position:absolute;top:0;bottom:0;left:0}@keyframes Sc5-RW_dsh-tool-row-sweep{0%{left:-300px}90%,to{left:100%}}.Sc5-RW_leading{flex-shrink:0}.Sc5-RW_root[data-tool^=cordis_] .Sc5-RW_leading,.Sc5-RW_root[data-tool^=cordis_] .Sc5-RW_title{color:var(--dsw-alias-state-business-primary)}.Sc5-RW_root[data-tool^=cordis_] .Sc5-RW_title{font-weight:500}.Sc5-RW_root[data-tool^=cordis_] .Sc5-RW_sep{background:var(--dsw-alias-state-business-primary)}.Sc5-RW_chevron{color:var(--dsw-alias-label-secondary)}.Sc5-RW_title{font-weight:400}.Sc5-RW_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.Sc5-RW_summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}.Sc5-RW_summarySuffix{white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);flex:none;margin-left:4px}.Sc5-RW_fileLink{text-overflow:ellipsis;white-space:nowrap;min-width:0;font:inherit;text-align:left;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);text-decoration:underline;text-decoration-color:var(--dsw-alias-label-quaternary);text-underline-offset:3px;cursor:pointer;background:0 0;border:none;flex:auto;margin:0;padding:0;overflow:hidden}.Sc5-RW_fileLink:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}.Sc5-RW_errorSummary{color:var(--dsw-alias-state-error-primary)}.Sc5-RW_bodyWrap{flex-direction:column;display:flex}.Sc5-RW_inspectButton{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}.Sc5-RW_root:hover .Sc5-RW_inspectButton,.Sc5-RW_inspectButton:focus-visible{opacity:1}.Sc5-RW_inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}.Sc5-RW_bodyScroll{max-height:260px;overflow-y:auto}.Sc5-RW_ioCard{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);border-radius:12px;flex-direction:column;margin:4px 0 4px 4px;display:flex}.Sc5-RW_ioSection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}.Sc5-RW_ioSection::-webkit-scrollbar-thumb{background-clip:padding-box;border:2px solid #0000;border-radius:6px}.Sc5-RW_ioSection::-webkit-scrollbar-track{margin:6px 0}.Sc5-RW_ioLabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}.Sc5-RW_ioDivider{background:var(--dsw-alias-border-l2);flex:none;height:1px}.Sc5-RW_ioText{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}.Sc5-RW_ioText[data-error]{color:var(--dsw-alias-state-error-primary)}.Sc5-RW_codeBody,.Sc5-RW_terminalBody,.Sc5-RW_diffBody,.Sc5-RW_readBody,.Sc5-RW_searchBody,.Sc5-RW_webBody{margin:4px 0 4px 4px}.Sc5-RW_searchRecovery{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);margin:4px 0 4px 4px}.Sc5-RW_codeBody{--dsl-code-block-content-font:var(--dsw-font-markdown-code-block-small)}.Sc5-RW_terminalBody{--dsl-terminal-font:var(--dsw-font-markdown-code-block-small);--dsl-terminal-line-height:18px;--dsl-terminal-output-max-height:224px;border:1px solid var(--dsw-alias-border-l1)}.Sc5-RW_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";
		const tagId$3 = "@deepseek-ai/dsh-client-ui-tool/ToolRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-tool";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var ToolRow_module_css_default = {
			"bodyScroll": "Sc5-RW_bodyScroll",
			"bodyWrap": "Sc5-RW_bodyWrap",
			"chevron": "Sc5-RW_chevron",
			"codeBody": "Sc5-RW_codeBody",
			"diffBody": "Sc5-RW_diffBody",
			"dsh-tool-row-sweep": "Sc5-RW_dsh-tool-row-sweep",
			"errorSummary": "Sc5-RW_errorSummary",
			"fileLink": "Sc5-RW_fileLink",
			"inspectButton": "Sc5-RW_inspectButton",
			"ioCard": "Sc5-RW_ioCard",
			"ioDivider": "Sc5-RW_ioDivider",
			"ioLabel": "Sc5-RW_ioLabel",
			"ioSection": "Sc5-RW_ioSection",
			"ioText": "Sc5-RW_ioText",
			"leading": "Sc5-RW_leading",
			"readBody": "Sc5-RW_readBody",
			"root": "Sc5-RW_root",
			"row": "Sc5-RW_row",
			"searchBody": "Sc5-RW_searchBody",
			"searchRecovery": "Sc5-RW_searchRecovery",
			"sep": "Sc5-RW_sep",
			"summary": "Sc5-RW_summary",
			"summarySuffix": "Sc5-RW_summarySuffix",
			"terminalBody": "Sc5-RW_terminalBody",
			"title": "Sc5-RW_title",
			"visuallyHidden": "Sc5-RW_visuallyHidden",
			"webBody": "Sc5-RW_webBody"
		};
		//#endregion
		//#region lib/types/client/tool/components/ToolRow.js
		function leadingFor$1(state, icon) {
			switch (state) {
				case "error": return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "error" });
				case "stopped": return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "warning" });
				default: return icon;
			}
		}
		/** Visually hidden run-state label: the StateDot and the CSS sweep are both
		*  aria-hidden / colour-only, so assistive technology needs this text to know a
		*  row is running, failed, or interrupted. null in the ok state (the icon and
		*  summary already describe a settled row). */
		function stateStatus$1(state, t) {
			switch (state) {
				case "running": return t("row.running");
				case "error": return t("row.failed");
				case "stopped": return t("row.stopped");
				default: return null;
			}
		}
		function ToolRow({ t, variant, toolName, icon, title, summary, summarySuffix, body, output, askQuestion, errorSummary, terminal, diff, read, search, web, state, filePath, onOpenFile, inspect }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const terminalLabels = (0, react.useMemo)(() => terminalBlockLabels(t), [t]);
			const diffLabels = (0, react.useMemo)(() => diffBlockLabels(t), [t]);
			const readLabels = (0, react.useMemo)(() => readBlockLabels(t), [t]);
			const searchLabels = (0, react.useMemo)(() => searchBlockLabels(t), [t]);
			const webLabels = (0, react.useMemo)(() => webBlockLabels(t), [t]);
			const terminalBody = terminal === void 0 || terminal === null ? null : localizeTerminalCardModel(terminal, t);
			const diffBody = diff ?? null;
			const readBody = read ?? null;
			const searchBody = search ?? null;
			const webBody = web ?? null;
			const askQuestionBody = askQuestion ?? null;
			const outputText = output ?? null;
			const expandable = body !== null || outputText !== null || (askQuestionBody ?? terminalBody ?? diffBody ?? readBody ?? searchBody ?? webBody) !== null;
			const open = expanded && expandable;
			const status = stateStatus$1(state, t);
			const failureLine = state === "error" ? errorSummary ?? null : null;
			const summaryText = failureLine ?? terminalBody?.description ?? summary;
			const suffix = failureLine === null ? summarySuffix ?? null : null;
			const fileLink = filePath !== void 0 && onOpenFile !== void 0 && failureLine === null;
			const toggleExpand = () => {
				setExpanded((v) => !v);
			};
			const openFile = (event) => {
				event.stopPropagation();
				if (filePath !== void 0) onOpenFile?.(filePath);
			};
			const fileLinkKeyDown = (event) => {
				if (event.key === "Enter" || event.key === " ") event.stopPropagation();
			};
			const cardBody = variant === "code" ? null : body;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ToolRow_module_css_default.root,
				"data-variant": variant,
				"data-tool": toolName,
				"data-state": state,
				children: [status !== null && (0, react_jsx_runtime.jsx)("span", {
					className: ToolRow_module_css_default.visuallyHidden,
					children: status
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
					rowClassName: ToolRow_module_css_default.row,
					leadingClassName: ToolRow_module_css_default.leading,
					titleClassName: ToolRow_module_css_default.title,
					chevronClassName: ToolRow_module_css_default.chevron,
					icon: leadingFor$1(state, icon),
					title,
					open,
					expandable,
					expandOnRowClick: true,
					keepContentWhenOpen: true,
					onToggle: toggleExpand,
					collapsedContent: summaryText !== "" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: ToolRow_module_css_default.sep,
							"aria-hidden": true
						}),
						fileLink ? (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ToolRow_module_css_default.fileLink,
							onClick: openFile,
							onKeyDown: fileLinkKeyDown,
							children: summaryText
						}) : (0, react_jsx_runtime.jsx)("span", {
							className: clsx(ToolRow_module_css_default.summary, failureLine !== null && ToolRow_module_css_default.errorSummary),
							children: summaryText
						}),
						suffix !== null && (0, react_jsx_runtime.jsx)("span", {
							className: ToolRow_module_css_default.summarySuffix,
							children: suffix
						})
					] }),
					children: (0, react_jsx_runtime.jsxs)("div", {
						className: ToolRow_module_css_default.bodyWrap,
						children: [askQuestionBody !== null ? (0, react_jsx_runtime.jsx)(AskQuestionCard, { card: askQuestionBody }) : terminalBody !== null ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TerminalBlock, {
							...terminalBody.card,
							maxLines: Infinity,
							labels: terminalLabels,
							className: ToolRow_module_css_default.terminalBody
						}) : diffBody !== null ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DiffBlock, {
							...diffBody.card,
							labels: diffLabels,
							maxLines: 8,
							className: ToolRow_module_css_default.diffBody
						}) : readBody !== null ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ReadBlock, {
							...readBody,
							labels: readLabels,
							maxLines: 8,
							className: ToolRow_module_css_default.readBody
						}) : searchBody !== null ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SearchBlock, {
							...searchBody.card,
							labels: searchLabels,
							maxLines: 8,
							className: ToolRow_module_css_default.searchBody
						}), searchBody.recovery !== void 0 && (0, react_jsx_runtime.jsx)("div", {
							className: ToolRow_module_css_default.searchRecovery,
							children: searchBody.recovery
						})] }) : webBody !== null ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.WebBlock, {
							...webBody,
							labels: webLabels,
							className: ToolRow_module_css_default.webBody
						}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [variant === "code" && body !== null && (0, react_jsx_runtime.jsx)("div", {
							className: ToolRow_module_css_default.bodyScroll,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.CodeBlock, {
								code: body,
								lang: "typescript",
								copyLabel: t("copy"),
								copiedLabel: t("copied"),
								className: ToolRow_module_css_default.codeBody
							})
						}), (cardBody !== null || outputText !== null) && (0, react_jsx_runtime.jsxs)("div", {
							className: ToolRow_module_css_default.ioCard,
							children: [
								cardBody !== null && (0, react_jsx_runtime.jsxs)("div", {
									className: ToolRow_module_css_default.ioSection,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: ToolRow_module_css_default.ioLabel,
										children: t("row.input")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: ToolRow_module_css_default.ioText,
										children: cardBody
									})]
								}),
								cardBody !== null && outputText !== null && (0, react_jsx_runtime.jsx)("span", {
									className: ToolRow_module_css_default.ioDivider,
									"aria-hidden": true
								}),
								outputText !== null && (0, react_jsx_runtime.jsxs)("div", {
									className: ToolRow_module_css_default.ioSection,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: ToolRow_module_css_default.ioLabel,
										children: t("row.output")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: ToolRow_module_css_default.ioText,
										"data-error": state === "error" || void 0,
										children: outputText
									})]
								})
							]
						})] }), inspect !== void 0 && (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: ToolRow_module_css_default.inspectButton,
							onClick: inspect,
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconInspectOutline12, {}), t("row.inspect")]
						})]
					})
				})]
			});
		}
		//#endregion
		//#region lib/types/client/tool/toolviews/GenericToolCard.js
		/** Variant leading icons (figma table); all glyphs render at 14 inside the 16px leading box. */
		const VARIANT_ICONS = {
			search: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, { size: 14 }),
			read: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutline16, { size: 14 }),
			bash: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutline14, { size: 14 }),
			write: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 14 }),
			edit: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 14 }),
			code: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size: 14 }),
			others: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkle16, { size: 14 })
		};
		function GenericToolCard({ toolName, block, cwd, home, openFile, inspect, t }) {
			const model = toolRowModel(toolName, block, cwd, home);
			const terminal = terminalCardModel(block, cwd);
			const read = readCardModel(block, cwd, home);
			const diff = diffCardModel(block);
			const search = searchCardModel(block);
			const web = webCardModel(block);
			const state = model.state === "ok" && terminal !== null && terminalFailed(terminal) ? "error" : model.state;
			const singleFile = model.filePath !== void 0;
			return (0, react_jsx_runtime.jsx)(ToolRow, {
				t,
				variant: model.variant,
				toolName,
				icon: VARIANT_ICONS[model.variant],
				title: t(model.titleKey),
				summary: model.summary,
				body: singleFile ? null : model.body,
				output: model.output,
				errorSummary: model.errorSummary,
				terminal,
				diff,
				read,
				search,
				web,
				state,
				filePath: model.filePath,
				onOpenFile: singleFile ? openFile : void 0,
				inspect
			});
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-tool/src/client/tool/ToolCallTree.module.css.mjs
		const css$2 = ".fxd7Gq_callRow{border-radius:6px}.fxd7Gq_subCalls{border-left:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:4px;margin:4px 0 2px 22px;padding-left:8px;display:flex}";
		const tagId$2 = "@deepseek-ai/dsh-client-ui-tool/ToolCallTree.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-tool";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var ToolCallTree_module_css_default = {
			"callRow": "fxd7Gq_callRow",
			"subCalls": "fxd7Gq_subCalls"
		};
		//#endregion
		//#region lib/types/client/tool/ToolCallTree.js
		/** Root/subcall Tool composition with one keyed atomic dispatch path. */
		/** Resolve a Tool call's wire name from either lifecycle form. */
		function callName(node) {
			return "kind" in node ? node.call?.name ?? "" : node.name;
		}
		/** One atomic call dispatched through the Tool-owned keyed slot. */
		const ToolCall = (0, react.memo)(function ToolCall({ renderSlot, callId, toolName, block, openFile, selected, cwd, home, inspectCall, t, children }) {
			const owner = (0, react.useMemo)(() => ({
				callId,
				toolName,
				block,
				openFile,
				cwd,
				home,
				inspect: () => {
					inspectCall(callId);
				}
			}), [
				callId,
				toolName,
				block,
				openFile,
				cwd,
				home,
				inspectCall
			]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ToolCallTree_module_css_default.callRow,
				"data-chat-anchor-key": `call:${callId}`,
				"data-chat-call-id": callId,
				"data-selected": selected || void 0,
				children: [renderSlot("tool.call.toolview", owner, {
					entryKey: toolName,
					fallback: (0, react_jsx_runtime.jsx)(GenericToolCard, {
						...owner,
						t
					})
				}), children]
			});
		});
		const ToolCallBranch = (0, react.memo)(function ToolCallBranch({ renderSlot, block, selectedCallId, cwd, home, openFile, inspectCall, t }) {
			return (0, react_jsx_runtime.jsx)(ToolCall, {
				renderSlot,
				callId: block.callId,
				toolName: callName(block),
				block,
				openFile,
				selected: block.callId === selectedCallId,
				cwd,
				home,
				inspectCall,
				t,
				children: block.subCalls.length > 0 ? (0, react_jsx_runtime.jsx)("div", {
					className: ToolCallTree_module_css_default.subCalls,
					"data-subcalls": true,
					children: block.subCalls.map((child) => (0, react_jsx_runtime.jsx)(ToolCallBranch, {
						renderSlot,
						block: child,
						selectedCallId,
						cwd,
						home,
						openFile,
						inspectCall,
						t
					}, child.callId))
				}) : null
			});
		});
		/**
		* Render one root Tool call and its recursive children through the same
		* atomic keyed dispatch.
		* @param props - whole-Tool owner data and the Tool-owned child-slot share.
		* @returns the Tool call tree.
		*/
		function ToolCallTree({ renderSlot, node, selectedCallId, cwd, openFile, inspectCall, useConnectionGeneration, t }) {
			const home = useConnectionGeneration((generation) => generation?.host.home);
			const block = node.data.root;
			return (0, react_jsx_runtime.jsx)(ToolCallBranch, {
				renderSlot,
				block,
				selectedCallId,
				cwd,
				home,
				openFile,
				inspectCall,
				t
			});
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-tool/src/client/tool/ToolDetails.module.css.mjs
		const css$1 = ".ETv8ta_description{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);margin:0 0 6px}.ETv8ta_cardBody{margin:0}.ETv8ta_recovery{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);margin:6px 0 0}.ETv8ta_code{background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;border-radius:12px;margin:0;padding:16px;font-size:13px;line-height:22px}.ETv8ta_code[data-error]{color:var(--dsw-alias-state-error-primary)}.ETv8ta_read,.ETv8ta_web{margin:0}.ETv8ta_empty{color:var(--dsw-alias-label-tertiary);padding:8px 0;font-size:13px;line-height:20px}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-tool/ToolDetails.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-tool";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var ToolDetails_module_css_default = {
			"cardBody": "ETv8ta_cardBody",
			"code": "ETv8ta_code",
			"description": "ETv8ta_description",
			"empty": "ETv8ta_empty",
			"read": "ETv8ta_read",
			"recovery": "ETv8ta_recovery",
			"web": "ETv8ta_web"
		};
		//#endregion
		//#region lib/types/client/tool/ToolDetails.js
		/** Card-aware output body for the selected Tool call in details. */
		/**
		* Render the selected Tool call's structured output when its raw fields form a
		* supported root card, otherwise preserve the flattened result text.
		* @param props - selected call slice, workspace root, host home, and locale seat.
		* @returns the details output body.
		*/
		function ToolDetails({ block, cwd, useConnectionGeneration, t }) {
			const home = useConnectionGeneration((generation) => generation?.host.home);
			const terminalModel = terminalCardModel(block, cwd);
			if (terminalModel !== null) {
				const terminal = localizeTerminalCardModel(terminalModel, t);
				return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [terminal.description !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
					className: ToolDetails_module_css_default.description,
					children: terminal.description
				}) : null, (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TerminalBlock, {
					...terminal.card,
					labels: terminalBlockLabels(t),
					className: ToolDetails_module_css_default.cardBody
				})] });
			}
			const read = readCardModel(block, cwd, home);
			if (read !== null) return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ReadBlock, {
				...read,
				labels: readBlockLabels(t),
				className: ToolDetails_module_css_default.read
			});
			const diff = diffCardModel(block);
			if (diff !== null) return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DiffBlock, {
				...diff.card,
				labels: diffBlockLabels(t),
				className: ToolDetails_module_css_default.cardBody
			});
			const search = searchCardModel(block);
			if (search !== null) return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SearchBlock, {
				...search.card,
				labels: searchBlockLabels(t),
				className: ToolDetails_module_css_default.cardBody
			}), search.recovery !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
				className: ToolDetails_module_css_default.recovery,
				children: search.recovery
			}) : null] });
			const web = webCardModel(block);
			if (web !== null) {
				const body = "kind" in block ? resultText(block) : "";
				return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.WebBlock, {
					...web,
					labels: webBlockLabels(t),
					className: ToolDetails_module_css_default.web
				}), body !== "" ? (0, react_jsx_runtime.jsx)("pre", {
					className: ToolDetails_module_css_default.code,
					children: body
				}) : null] });
			}
			if (!("kind" in block)) return (0, react_jsx_runtime.jsx)("div", {
				className: ToolDetails_module_css_default.empty,
				children: t("details.running")
			});
			return (0, react_jsx_runtime.jsx)("pre", {
				className: ToolDetails_module_css_default.code,
				"data-error": block.isError || void 0,
				children: resultText(block)
			});
		}
		//#endregion
		//#region lib/types/client/locale.js
		/** Locale namespace supplied by the conversation owner to Tool renderers. */
		const CONVERSATION_NS = "conversation";
		//#endregion
		//#region lib/types/client/tool/toolviews/ask-question-row.js
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function parseJson(text) {
			try {
				return JSON.parse(text);
			} catch {
				return;
			}
		}
		/** Answer records from the result JSON; null when the result is malformed. */
		function answerEntries(text) {
			const parsed = parseJson(text);
			if (!isRecord(parsed)) return null;
			const answers = parsed.answers;
			if (!Array.isArray(answers) || !answers.every(isRecord)) return null;
			const entries = [];
			for (const answer of answers) {
				if (typeof answer.id !== "string" || !Array.isArray(answer.selected) || !answer.selected.every((item) => typeof item === "string") || answer.custom !== void 0 && typeof answer.custom !== "string") return null;
				entries.push({
					id: answer.id,
					selected: answer.selected,
					...answer.custom === void 0 ? {} : { custom: answer.custom }
				});
			}
			return entries;
		}
		/** Questions from call JSON; null when pairing with answers would be ambiguous. */
		function questionEntries(argsRaw) {
			const parsed = parseJson(argsRaw);
			if (!isRecord(parsed) || !Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
			const questions = [];
			const ids = /* @__PURE__ */ new Set();
			for (const question of parsed.questions) {
				if (!isRecord(question) || typeof question.id !== "string" || typeof question.question !== "string" || ids.has(question.id)) return null;
				ids.add(question.id);
				questions.push({
					id: question.id,
					question: question.question
				});
			}
			return questions;
		}
		/** Pair questions with result entries by their echoed stable ids. */
		function pairAnswers(argsRaw, answers) {
			const questions = questionEntries(argsRaw);
			if (questions === null || questions.length !== answers.length) return null;
			const byId = /* @__PURE__ */ new Map();
			for (const answer of answers) {
				if (byId.has(answer.id)) return null;
				byId.set(answer.id, answer);
			}
			const paired = [];
			for (const question of questions) {
				const answer = byId.get(question.id);
				if (answer === void 0) return null;
				paired.push({
					...question,
					answers: [...answer.selected, ...answer.custom === void 0 || answer.custom === "" ? [] : [answer.custom]]
				});
			}
			return paired;
		}
		/** Answer summary plus structured transcript content from the two wire JSON documents. */
		function answeredPresentation(argsRaw, text, t) {
			const answers = answerEntries(text);
			if (answers === null) return null;
			const answered = answers.filter((answer) => answer.selected.length > 0 || (answer.custom ?? "") !== "").length;
			return {
				summary: t("ask.answered", {
					answered,
					total: answers.length
				}),
				questions: pairAnswers(argsRaw, answers)
			};
		}
		/** Best-effort answered-count summary when strict transcript pairing fails. */
		function answeredSummary(text, t) {
			const parsed = parseJson(text);
			if (!isRecord(parsed)) return null;
			const answers = parsed.answers;
			if (!Array.isArray(answers) || !answers.every(isRecord)) return null;
			const answered = answers.filter((a) => Array.isArray(a.selected) && a.selected.length > 0 || typeof a.custom === "string" && a.custom !== "").length;
			return t("ask.answered", {
				answered,
				total: answers.length
			});
		}
		/** Summarizes a pending, answered, cancelled, or interrupted question set. */
		function AskQuestionRow({ toolName, block, inspect, t }) {
			const model = toolRowModel(toolName, block);
			const code = "kind" in block ? block.error?.code : void 0;
			const argsRaw = ("kind" in block ? block.call?.argsRaw : block.argsRaw) ?? "";
			let summary = model.summary;
			let state = model.state;
			let transcript = null;
			if (code === "ASK_CANCELLED") {
				summary = t("ask.cancelled");
				state = "ok";
				const questions = questionEntries(argsRaw);
				if (questions !== null) transcript = {
					kind: "unanswered",
					questions,
					verdict: t("ask.cancelledDetail")
				};
			} else if (code === "ASK_ABORTED") {
				summary = t("ask.interrupted");
				state = "stopped";
				const questions = questionEntries(argsRaw);
				if (questions !== null) transcript = {
					kind: "unanswered",
					questions,
					verdict: t("ask.interruptedDetail")
				};
			} else if (model.state === "running") summary = t("ask.waiting");
			else if ("kind" in block && model.state === "ok") {
				const text = singleResultText(block);
				if (text !== void 0) {
					const presentation = answeredPresentation(argsRaw, text, t);
					summary = presentation?.summary ?? answeredSummary(text, t) ?? model.summary;
					if (presentation?.questions !== null && presentation?.questions !== void 0) transcript = {
						kind: "answered",
						questions: presentation.questions,
						skippedLabel: t("ask.skipped")
					};
				}
			}
			return (0, react_jsx_runtime.jsx)(ToolRow, {
				t,
				variant: model.variant,
				toolName,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQuestionOutline14, {}),
				title: t("ask.rowTitle"),
				summary,
				body: transcript === null ? model.body : null,
				output: transcript === null ? model.output : null,
				askQuestion: transcript,
				state,
				inspect
			});
		}
		/** Registers the ask-user-question conversation row. */
		const askQuestionToolview = {
			name: "ask-question-toolview",
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: "ask_user_question",
					locale: CONVERSATION_NS
				}, AskQuestionRow));
			}
		};
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-tool/src/client/tool/toolviews/bash-sample.module.css.mjs
		const css = "._0-W7OG_card{flex-direction:column;display:flex}._0-W7OG_terminal{--dsl-terminal-font:var(--dsw-font-markdown-code-block-small);--dsl-terminal-line-height:18px;--dsl-terminal-output-max-height:224px;border:1px solid var(--dsw-alias-border-l1);margin:4px 0 4px 4px}._0-W7OG_ioCard{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);border-radius:12px;flex-direction:column;margin:4px 0 4px 4px;display:flex}._0-W7OG_ioSection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}._0-W7OG_ioSection::-webkit-scrollbar-thumb{background-clip:padding-box;border:2px solid #0000;border-radius:6px}._0-W7OG_ioSection::-webkit-scrollbar-track{margin:6px 0}._0-W7OG_ioLabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}._0-W7OG_ioDivider{background:var(--dsw-alias-border-l2);flex:none;height:1px}._0-W7OG_ioText{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}._0-W7OG_ioText[data-error]{color:var(--dsw-alias-state-error-primary)}._0-W7OG_root[data-expandable]{cursor:pointer}._0-W7OG_root{height:calc(24px + var(--dsh-content-font-delta,0px));align-items:center;min-width:0;display:flex;position:relative;overflow:hidden}._0-W7OG_root[data-state=running]:after{content:\"\";background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite _0-W7OG_dsh-bash-row-sweep;position:absolute;top:0;bottom:0;left:0}@keyframes _0-W7OG_dsh-bash-row-sweep{0%{left:-300px}90%,to{left:100%}}._0-W7OG_leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex;position:relative}._0-W7OG_leading svg:not([data-state]){width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}._0-W7OG_chevron{color:var(--dsw-alias-label-secondary)}._0-W7OG_iconIdle{opacity:1;transition:opacity .1s;display:inline-flex}._0-W7OG_chevronHover{opacity:0;margin:auto;transition:opacity .1s;position:absolute;inset:0}._0-W7OG_root:hover ._0-W7OG_iconIdle{opacity:0}._0-W7OG_root:hover ._0-W7OG_chevronHover{opacity:1}._0-W7OG_title{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);flex:none}._0-W7OG_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}._0-W7OG_summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}._0-W7OG_errorSummary{color:var(--dsw-alias-state-error-primary)}._0-W7OG_bodyWrap{flex-direction:column;display:flex}._0-W7OG_inspectButton{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}._0-W7OG_card:hover ._0-W7OG_inspectButton,._0-W7OG_inspectButton:focus-visible{opacity:1}._0-W7OG_inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}._0-W7OG_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";
		const tagId = "@deepseek-ai/dsh-client-ui-tool/bash-sample.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-tool";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var bash_sample_module_css_default = {
			"bodyWrap": "_0-W7OG_bodyWrap",
			"card": "_0-W7OG_card",
			"chevron": "_0-W7OG_chevron",
			"chevronHover": "_0-W7OG_chevronHover",
			"dsh-bash-row-sweep": "_0-W7OG_dsh-bash-row-sweep",
			"errorSummary": "_0-W7OG_errorSummary",
			"iconIdle": "_0-W7OG_iconIdle",
			"inspectButton": "_0-W7OG_inspectButton",
			"ioCard": "_0-W7OG_ioCard",
			"ioDivider": "_0-W7OG_ioDivider",
			"ioLabel": "_0-W7OG_ioLabel",
			"ioSection": "_0-W7OG_ioSection",
			"ioText": "_0-W7OG_ioText",
			"leading": "_0-W7OG_leading",
			"root": "_0-W7OG_root",
			"sep": "_0-W7OG_sep",
			"summary": "_0-W7OG_summary",
			"terminal": "_0-W7OG_terminal",
			"title": "_0-W7OG_title",
			"visuallyHidden": "_0-W7OG_visuallyHidden"
		};
		//#endregion
		//#region lib/types/client/tool/toolviews/bash-sample.js
		function leadingFor(state) {
			switch (state) {
				case "error": return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "error" });
				case "stopped": return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "warning" });
				default: return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutline14, { size: 14 });
			}
		}
		/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
		function stateStatus(state, t) {
			switch (state) {
				case "running": return t("bash.running");
				case "error": return t("bash.failed");
				case "stopped": return t("bash.stopped");
				default: return null;
			}
		}
		/** Renders expandable Bash output with an accessible lifecycle label. */
		function BashRow({ toolName, block, sessionId, useSessions, inspect, t }) {
			const model = toolRowModel(toolName, block);
			const terminalModel = terminalCardModel(block, useSessions((list) => list.byId[sessionId]?.cwd));
			const terminal = terminalModel === null ? null : localizeTerminalCardModel(terminalModel, t);
			const state = model.state === "ok" && terminalModel !== null && terminalFailed(terminalModel) ? "error" : model.state;
			const status = stateStatus(state, t);
			const [expanded, setExpanded] = (0, react.useState)(false);
			const genericBody = terminal === null && (model.state === "error" || isSettledPersistentShellCall(block)) && (model.body !== null || model.output !== null);
			const expandable = terminal !== null || genericBody;
			const open = expanded && expandable;
			const failureLine = model.state === "error" ? model.errorSummary : null;
			const toggleExpand = () => {
				setExpanded((v) => !v);
			};
			const toggleFromKeyboard = (event) => {
				if (!expandable || event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				toggleExpand();
			};
			const leading = open ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: bash_sample_module_css_default.chevron }) : expandable ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
				className: bash_sample_module_css_default.iconIdle,
				children: leadingFor(state)
			}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: clsx(bash_sample_module_css_default.chevron, bash_sample_module_css_default.chevronHover) })] }) : leadingFor(state);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: bash_sample_module_css_default.card,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: bash_sample_module_css_default.root,
					"data-sample": "bash",
					"data-variant": "bash",
					"data-state": state,
					"data-expandable": expandable || void 0,
					role: expandable ? "button" : void 0,
					tabIndex: expandable ? 0 : void 0,
					"aria-expanded": expandable ? open : void 0,
					onClick: expandable ? toggleExpand : void 0,
					onKeyDown: expandable ? toggleFromKeyboard : void 0,
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: bash_sample_module_css_default.leading,
							children: leading
						}),
						status !== null && (0, react_jsx_runtime.jsx)("span", {
							className: bash_sample_module_css_default.visuallyHidden,
							children: status
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: bash_sample_module_css_default.title,
							children: t(model.titleKey)
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: bash_sample_module_css_default.sep,
							"aria-hidden": true
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: clsx(bash_sample_module_css_default.summary, failureLine !== null && bash_sample_module_css_default.errorSummary),
							children: failureLine ?? terminal?.description ?? model.summary
						})
					]
				}), open && (0, react_jsx_runtime.jsxs)("div", {
					className: bash_sample_module_css_default.bodyWrap,
					children: [terminal !== null ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TerminalBlock, {
						...terminal.card,
						maxLines: Infinity,
						labels: terminalBlockLabels(t),
						className: bash_sample_module_css_default.terminal
					}) : (0, react_jsx_runtime.jsxs)("div", {
						className: bash_sample_module_css_default.ioCard,
						children: [
							model.body !== null && (0, react_jsx_runtime.jsxs)("div", {
								className: bash_sample_module_css_default.ioSection,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: bash_sample_module_css_default.ioLabel,
									children: t("row.input")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: bash_sample_module_css_default.ioText,
									children: model.body
								})]
							}),
							model.body !== null && model.output !== null && (0, react_jsx_runtime.jsx)("span", {
								className: bash_sample_module_css_default.ioDivider,
								"aria-hidden": true
							}),
							model.output !== null && (0, react_jsx_runtime.jsxs)("div", {
								className: bash_sample_module_css_default.ioSection,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: bash_sample_module_css_default.ioLabel,
									children: t("row.output")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: bash_sample_module_css_default.ioText,
									"data-error": state === "error" || void 0,
									children: model.output
								})]
							})
						]
					}), inspect !== void 0 && (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: bash_sample_module_css_default.inspectButton,
						onClick: inspect,
						children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconInspectOutline12, {}), t("row.inspect")]
					})]
				})]
			});
		}
		/** Registers the standalone Bash conversation-row sample. */
		const bashToolviewSample = {
			name: "bash-toolview-sample",
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: "bash",
					locale: CONVERSATION_NS
				}, BashRow));
			}
		};
		//#endregion
		//#region lib/types/client/tool/toolviews/file-mutation-row.js
		/**
		* Lets users expand an applied file diff and open the reported path.
		*/
		function FileMutationRow({ toolName, block, cwd, home, openFile, inspect, t }) {
			const model = toolRowModel(toolName, block, cwd, home);
			const diff = diffCardModel(block);
			return (0, react_jsx_runtime.jsx)(ToolRow, {
				t,
				variant: model.variant,
				toolName,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 14 }),
				title: t(model.titleKey),
				summary: model.summary,
				body: null,
				output: model.output,
				errorSummary: model.errorSummary,
				diff,
				state: model.state,
				filePath: model.filePath,
				onOpenFile: openFile,
				inspect
			});
		}
		/** Registers the edit and write conversation rows. */
		const fileMutationToolview = {
			name: "file-mutation-toolview",
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("tool.call.toolview", function* () {
					yield ctx.slots.register({
						name: "tool.call.toolview",
						key: "edit",
						locale: CONVERSATION_NS
					}, FileMutationRow);
					yield ctx.slots.register({
						name: "tool.call.toolview",
						key: "write",
						locale: CONVERSATION_NS
					}, FileMutationRow);
				});
			}
		};
		//#endregion
		//#region lib/types/client/tool/toolviews/read-row.js
		/**
		* Lets users expand a completed read result and open its reported path.
		*/
		function ReadRow({ toolName, block, cwd, home, openFile, inspect, t }) {
			const model = toolRowModel(toolName, block, cwd, home);
			const read = readCardModel(block, cwd, home);
			return (0, react_jsx_runtime.jsx)(ToolRow, {
				t,
				variant: model.variant,
				toolName,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutline16, { size: 14 }),
				title: t(model.titleKey),
				summary: model.summary,
				body: null,
				output: model.output,
				errorSummary: model.errorSummary,
				read,
				state: model.state,
				filePath: model.filePath,
				onOpenFile: openFile,
				inspect
			});
		}
		/** Registers the read tool's conversation row. */
		const readToolview = {
			name: "read-toolview",
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: "read",
					locale: CONVERSATION_NS
				}, ReadRow));
			}
		};
		//#endregion
		//#region lib/types/client/tool/toolviews/search-row.js
		const SEARCH_TITLE_KEYS = {
			grep: "tool.title.grep",
			glob: "tool.title.glob"
		};
		/** Lets users expand grep or glob results and recover capped searches. */
		function SearchRow({ toolName, block, inspect, t }) {
			const model = toolRowModel(toolName, block);
			const search = searchCardModel(block);
			return (0, react_jsx_runtime.jsx)(ToolRow, {
				t,
				variant: model.variant,
				toolName,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, { size: 14 }),
				title: t(toolName === "grep" ? SEARCH_TITLE_KEYS.grep : toolName === "glob" ? SEARCH_TITLE_KEYS.glob : model.titleKey),
				summary: model.summary,
				body: null,
				output: model.output,
				errorSummary: model.errorSummary,
				search,
				state: model.state,
				inspect
			});
		}
		/** Registers the grep and glob conversation rows. */
		const searchToolview = {
			name: "search-toolview",
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("tool.call.toolview", function* () {
					yield ctx.slots.register({
						name: "tool.call.toolview",
						key: "grep",
						locale: CONVERSATION_NS
					}, SearchRow);
					yield ctx.slots.register({
						name: "tool.call.toolview",
						key: "glob",
						locale: CONVERSATION_NS
					}, SearchRow);
				});
			}
		};
		//#endregion
		//#region lib/types/client/tool/toolviews/plan-summary.js
		/**
		* Pure plan derivation for the todo_write row's one-line summary. Several items
		* may be `in_progress` at once — parallel work runs concurrent tasks, so a
		* summary built from one active item would silently drop the rest. The plan
		* strip header derives its own counts inline and shares nothing with this, so
		* this stays inside the toolviews domain rather than in `contract/` (the
		* inter-domain face).
		* @module
		*/
		/**
		* Derive the counts and the active summary from a whole-list snapshot. It names
		* the first `in_progress` item and counts the remaining active ones, so a
		* parallel plan reports how many tasks are running rather than naming one and
		* hiding the others. `activeContent` is null when nothing is in progress, or
		* when the first active item's content is missing, mistyped, or blank once
		* trimmed — the tool's own rule for usable content, applied here because a
		* rejected call keeps its args verbatim. The row then renders the counts alone
		* rather than falling back to the generic tool summary: the counts are already
		* known to be good, and the active-item clause is the only part an unusable
		* name costs.
		* @param todos - the whole list, in model order.
		* @returns the done/total counts and the two summary halves.
		*/
		function planSummary(todos) {
			const active = todos.filter((t) => t.status === "in_progress");
			const first = active[0]?.content;
			const named = typeof first === "string" && first.trim() !== "";
			return {
				done: todos.filter((t) => t.status === "completed").length,
				total: todos.length,
				activeContent: named ? first : null,
				activeExtra: named ? active.length - 1 : 0
			};
		}
		//#endregion
		//#region lib/types/client/tool/toolviews/todo-row.js
		function isItem(value) {
			return typeof value === "object" && value !== null;
		}
		function summarize(argsRaw, t) {
			let parsed;
			try {
				parsed = JSON.parse(argsRaw);
			} catch {
				return null;
			}
			if (typeof parsed !== "object" || parsed === null) return null;
			const todos = parsed.todos;
			if (!Array.isArray(todos) || !todos.every(isItem)) return null;
			const { done, total, activeContent, activeExtra } = planSummary(todos);
			const head = t("todo.completed", {
				done,
				total
			});
			return {
				text: activeContent === null ? head : `${head} · ${activeContent}`,
				extra: activeExtra
			};
		}
		/** Summarizes a plan update without presenting a cancelled call as completed. */
		function TodoRow({ toolName, block, inspect, t }) {
			const model = toolRowModel(toolName, block);
			const summary = summarize(("kind" in block ? block.call?.argsRaw : block.argsRaw) ?? "", t) ?? {
				text: model.summary,
				extra: 0
			};
			return (0, react_jsx_runtime.jsx)(ToolRow, {
				t,
				variant: model.variant,
				toolName,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChecklistOutline14, {}),
				title: t("todo.rowTitle"),
				summary: summary.text,
				summarySuffix: summary.extra > 0 ? `+${summary.extra}` : null,
				body: model.body,
				output: model.output,
				errorSummary: model.errorSummary,
				state: model.state,
				inspect
			});
		}
		/** Registers the todo conversation row. */
		const todoToolview = {
			name: "todo-toolview",
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: "todo_write",
					locale: CONVERSATION_NS
				}, TodoRow));
			}
		};
		//#endregion
		//#region lib/types/client/tool/toolviews/web-row.js
		const WEB_TITLE_KEYS = {
			web_search: "tool.title.webSearch",
			web_fetch: "tool.title.webFetch"
		};
		/** Lets users expand a completed web search or fetch result. */
		function WebRow({ toolName, block, inspect, t }) {
			const model = toolRowModel(toolName, block);
			const web = webCardModel(block);
			const icon = toolName === "web_fetch" ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutline16, { size: 14 }) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGlobeOutline14, { size: 14 });
			return (0, react_jsx_runtime.jsx)(ToolRow, {
				t,
				variant: model.variant,
				toolName,
				icon,
				title: t(toolName === "web_search" ? WEB_TITLE_KEYS.web_search : toolName === "web_fetch" ? WEB_TITLE_KEYS.web_fetch : model.titleKey),
				summary: model.summary,
				body: null,
				output: model.output,
				errorSummary: model.errorSummary,
				web,
				state: model.state,
				inspect
			});
		}
		/** Registers the web search and fetch conversation rows. */
		const webToolview = {
			name: "web-toolview",
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("tool.call.toolview", function* () {
					yield ctx.slots.register({
						name: "tool.call.toolview",
						key: "web_search",
						locale: CONVERSATION_NS
					}, WebRow);
					yield ctx.slots.register({
						name: "tool.call.toolview",
						key: "web_fetch",
						locale: CONVERSATION_NS
					}, WebRow);
				});
			}
		};
		//#endregion
		//#region lib/types/client/apply.js
		/** Required services: the slot registry and the Host description used for POSIX `~`. */
		const inject = ["slots", "connection"];
		/**
		* Mount the whole-Tool renderers and built-in atomic Tool registrations.
		* @param ctx - Client root context.
		*/
		function apply(ctx) {
			const connection = ctx.get("connection");
			const toolInject = () => ({ hooks: { connectionGeneration: connection.generation } });
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "tool-call",
				locale: CONVERSATION_NS,
				children: { "tool.call.toolview": {
					kind: "keyed",
					scope: "session"
				} },
				inject: toolInject
			}, ToolCallTree));
			ctx.slots.inject("conversation.details.tool", () => ctx.slots.register({
				name: "conversation.details.tool",
				locale: CONVERSATION_NS,
				inject: toolInject
			}, ToolDetails));
			ctx.plugin(bashToolviewSample);
			ctx.plugin(readToolview);
			ctx.plugin(fileMutationToolview);
			ctx.plugin(searchToolview);
			ctx.plugin(webToolview);
			ctx.plugin(todoToolview);
			ctx.plugin(askQuestionToolview);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map