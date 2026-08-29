window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
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
		//#endregion
		//#region lib/types/client/contract/snapshot.js
		const EMPTY_LIST$1 = [];
		/** Empty Chat target used before a view builder is registered. */
		const EMPTY_CHAT_SNAPSHOT = {
			order: EMPTY_LIST$1,
			nodes: {
				get: () => void 0,
				values: () => EMPTY_LIST$1
			},
			locations: {
				getTurn: () => EMPTY_LIST$1,
				getStep: () => EMPTY_LIST$1
			},
			navigation: { items: () => EMPTY_LIST$1 },
			timeline: {
				turnOrder: EMPTY_LIST$1,
				turns: /* @__PURE__ */ new Map()
			},
			legacy: {
				nodes: EMPTY_LIST$1,
				turnTimings: /* @__PURE__ */ new Map(),
				turnEnds: /* @__PURE__ */ new Map(),
				partial: null,
				runningCalls: EMPTY_LIST$1
			}
		};
		//#endregion
		//#region lib/types/client/chat/ApprovalCommand.js
		/**
		* Extract a shell command from a correlated Tool call when its arguments carry one.
		* @param call - Tool call arguments, when a correlated call exists.
		* @returns command text, or undefined for absent, malformed, or unrelated arguments.
		*/
		function commandOf(call) {
			if (call === void 0) return void 0;
			try {
				const args = JSON.parse(call.argsRaw);
				return typeof args.command === "string" ? args.command : void 0;
			} catch {
				return;
			}
		}
		/**
		* Render the command of the Chat Tool node correlated with an approval.
		* @param props - Approval identity and Session-standard Chat selector hook.
		* @returns command text when the correlated call carries one.
		*/
		function ApprovalCommand({ callId, useChat }) {
			return useChat((snapshot) => {
				for (const node of snapshot.nodes.values()) {
					const root = node.kind === "tool-call" ? node.data.root : void 0;
					if (root !== void 0 && root.callId === callId && !("kind" in root)) return commandOf(root);
				}
			}) ?? null;
		}
		//#endregion
		//#region lib/types/client/markdown-labels.js
		/** Localized copy adapters for Cordis-free Markdown primitives. */
		/**
		* Build the complete Markdown chrome copy for one locale revision.
		* @param t - Chat locale seat.
		* @returns Labels for code fences and footnotes.
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
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/MessageItem.module.css.mjs
		const css$15 = ".sEKFIG_userRow{flex-direction:column;align-items:flex-end;gap:6px;display:flex}.sEKFIG_userStack{min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;align-items:flex-end;gap:8px;display:flex}.sEKFIG_bubble{background:var(--dsw-specific-bubble);max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;border-radius:22px;padding:10px 16px}.sEKFIG_referenceSummary{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}.sEKFIG_contextRow,.sEKFIG_compactionRow{padding:2px 0}.sEKFIG_compactionButton{width:100%;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:inherit;font:inherit;text-align:left;background:0 0;border:none;border-radius:6px;align-items:center;padding:0;display:flex}.sEKFIG_compactionButton:not(:disabled){cursor:pointer}.sEKFIG_compactionButton:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}.sEKFIG_compactionLeading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);flex:none;place-items:center;margin-right:6px;display:inline-grid}.sEKFIG_compactionLeading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}.sEKFIG_compactionContextIcon,.sEKFIG_compactionDisclosureIcon{grid-area:1/1;justify-content:center;align-items:center;display:inline-flex}.sEKFIG_compactionDisclosureIcon,.sEKFIG_compactionButton:not(:disabled):hover .sEKFIG_compactionContextIcon,.sEKFIG_compactionButton:not(:disabled):focus-visible .sEKFIG_compactionContextIcon{opacity:0}.sEKFIG_compactionButton:not(:disabled):hover .sEKFIG_compactionDisclosureIcon,.sEKFIG_compactionButton:not(:disabled):focus-visible .sEKFIG_compactionDisclosureIcon{opacity:1}.sEKFIG_compactionTitle{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary-dimmed);flex:none}.sEKFIG_compactionSep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.sEKFIG_compactionSummary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.sEKFIG_compactionBody{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}.sEKFIG_retryRow{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}.sEKFIG_retrySummary{width:fit-content;color:inherit;cursor:pointer;user-select:none;border-radius:3px;align-items:center;gap:7px;padding:2px 0;list-style:none;display:inline-flex}.sEKFIG_retrySummary::-webkit-details-marker{display:none}.sEKFIG_retrySummary:after{content:\"\";opacity:.8;border-bottom:1.5px solid;border-right:1.5px solid;width:6px;height:6px;transition:transform .12s;transform:rotate(-45deg)}.sEKFIG_retrySummary:hover{color:var(--dsw-alias-label-secondary)}.sEKFIG_retrySummary:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill);outline-offset:2px}.sEKFIG_retryText{color:inherit}.sEKFIG_retryRow[data-active] .sEKFIG_retryText{background:linear-gradient(90deg, var(--dsw-alias-label-tertiary) 0%, var(--dsw-alias-label-tertiary) 40%, var(--dsw-alias-label-secondary) 50%, var(--dsw-alias-label-tertiary) 60%, var(--dsw-alias-label-tertiary) 100%);color:#0000;background-position:100%;background-size:200% 100%;background-clip:text;animation:1.6s ease-in-out infinite sEKFIG_retry-shimmer}.sEKFIG_retryRow[open] .sEKFIG_retrySummary:after{transform:rotate(45deg)}.sEKFIG_retryDetails{overflow-wrap:anywhere;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));gap:2px;margin-top:3px;padding-left:14px;display:grid}.sEKFIG_retryDetailLabel{color:var(--dsw-alias-label-secondary)}.sEKFIG_turnErrorRow{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));grid-template-columns:10px minmax(0,1fr) auto;align-items:start;gap:8px;padding:2px 0;display:grid}.sEKFIG_turnErrorDot{margin-top:5px}.sEKFIG_turnErrorCopy{overflow-wrap:anywhere;min-width:0}.sEKFIG_turnErrorTitle{color:var(--dsw-alias-state-error-primary);margin-right:6px;font-weight:600}.sEKFIG_turnErrorMessage{color:var(--dsw-alias-label-secondary)}.sEKFIG_turnErrorCode{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-markdown-code-block-small)}.sEKFIG_maxTokensTitle{color:var(--dsw-alias-state-warn-primary);margin-right:6px;font-weight:600}@keyframes sEKFIG_retry-shimmer{0%{background-position:100%}to{background-position:0}}@media (prefers-reduced-motion:reduce){.sEKFIG_retryRow[data-active] .sEKFIG_retryText{color:inherit;background:0 0;animation:none}}";
		const tagId$15 = "@deepseek-ai/dsh-client-ui-chat/MessageItem.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$15) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$15;
			tag.textContent = css$15;
			document.head.appendChild(tag);
		}
		var MessageItem_module_css_default = {
			"bubble": "sEKFIG_bubble",
			"compactionBody": "sEKFIG_compactionBody",
			"compactionButton": "sEKFIG_compactionButton",
			"compactionContextIcon": "sEKFIG_compactionContextIcon",
			"compactionDisclosureIcon": "sEKFIG_compactionDisclosureIcon",
			"compactionLeading": "sEKFIG_compactionLeading",
			"compactionRow": "sEKFIG_compactionRow",
			"compactionSep": "sEKFIG_compactionSep",
			"compactionSummary": "sEKFIG_compactionSummary",
			"compactionTitle": "sEKFIG_compactionTitle",
			"contextRow": "sEKFIG_contextRow",
			"maxTokensTitle": "sEKFIG_maxTokensTitle",
			"referenceSummary": "sEKFIG_referenceSummary",
			"retry-shimmer": "sEKFIG_retry-shimmer",
			"retryDetailLabel": "sEKFIG_retryDetailLabel",
			"retryDetails": "sEKFIG_retryDetails",
			"retryRow": "sEKFIG_retryRow",
			"retrySummary": "sEKFIG_retrySummary",
			"retryText": "sEKFIG_retryText",
			"turnErrorCode": "sEKFIG_turnErrorCode",
			"turnErrorCopy": "sEKFIG_turnErrorCopy",
			"turnErrorDot": "sEKFIG_turnErrorDot",
			"turnErrorMessage": "sEKFIG_turnErrorMessage",
			"turnErrorRow": "sEKFIG_turnErrorRow",
			"turnErrorTitle": "sEKFIG_turnErrorTitle",
			"userRow": "sEKFIG_userRow",
			"userStack": "sEKFIG_userStack"
		};
		//#endregion
		//#region lib/types/client/chat/CompactionItem.js
		/**
		* Renders the model-history compaction marker.
		* @param props - the marker node off the snapshot cache.
		* @returns the marker row, with the summary disclosure when one is available.
		*/
		const CompactionItem = (0, react.memo)(function CompactionItem({ node, title, fallbackSummary, t }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const labels = (0, react.useMemo)(() => markdownLabels(t), [t]);
			const expandable = node.summary !== null;
			const open = expandable && expanded;
			const summary = node.shadowedItemCount !== null && node.shadowedTokenCount !== null ? t("message.compaction.completed", {
				items: node.shadowedItemCount,
				tokens: node.shadowedTokenCount
			}) : fallbackSummary ?? (expandable ? t("message.compaction.expand") : t("message.compaction.unavailable"));
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.compactionRow,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: MessageItem_module_css_default.compactionButton,
					disabled: !expandable,
					"aria-expanded": expandable ? open : void 0,
					onClick: () => {
						setExpanded((value) => !value);
					},
					children: [
						(0, react_jsx_runtime.jsxs)("span", {
							className: MessageItem_module_css_default.compactionLeading,
							"aria-hidden": true,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: MessageItem_module_css_default.compactionContextIcon,
								"data-compaction-icon": "context",
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutline14, {})
							}), (0, react_jsx_runtime.jsx)("span", {
								className: MessageItem_module_css_default.compactionDisclosureIcon,
								"data-compaction-disclosure": open ? "expanded" : "collapsed",
								children: open ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {})
							})]
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.compactionTitle,
							children: title ?? t("message.compaction")
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.compactionSep,
							"aria-hidden": true
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.compactionSummary,
							children: summary
						})
					]
				}), open && node.summary !== null && (0, react_jsx_runtime.jsx)("div", {
					className: MessageItem_module_css_default.compactionBody,
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
						text: node.summary,
						labels
					})
				})]
			});
		});
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/ContextBody.module.css.mjs
		const css$14 = ".YFJ4ta_text{color:var(--dsw-alias-label-secondary);font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.YFJ4ta_fields{border-top:1px solid var(--dsw-alias-line-secondary);flex-direction:column;gap:2px;margin:8px 0 0;padding-top:8px;display:flex}.YFJ4ta_field{gap:8px;min-width:0;display:flex}.YFJ4ta_fieldKey{min-width:96px;color:var(--dsw-alias-label-caption);flex:none}.YFJ4ta_fieldValue{min-width:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;flex:auto;margin:0}.YFJ4ta_files{flex-wrap:wrap;gap:4px 12px;margin:0 0 8px;padding:0;list-style:none;display:flex}.YFJ4ta_file{align-items:baseline;gap:6px;min-width:0;display:flex}.YFJ4ta_filePath{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.YFJ4ta_fileAction{color:var(--dsw-alias-label-caption)}.YFJ4ta_catalogNotice{color:var(--dsw-alias-label-caption);margin:0 0 6px}.YFJ4ta_entries{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.YFJ4ta_entry{gap:8px;min-width:0;display:flex}.YFJ4ta_entryName{color:var(--dsw-alias-label-secondary);flex:none}.YFJ4ta_entryDescription{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.YFJ4ta_sections{flex-direction:column;gap:8px;margin:0;display:flex}.YFJ4ta_section{flex-direction:column;gap:2px;min-width:0;display:flex}.YFJ4ta_sectionName{color:var(--dsw-alias-label-caption)}.YFJ4ta_sectionText{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.YFJ4ta_relaySender{color:var(--dsw-alias-label-caption);overflow-wrap:anywhere;margin:0 0 6px}.YFJ4ta_recalls{flex-direction:column;gap:2px;margin:0 0 8px;padding:0;list-style:none;display:flex}.YFJ4ta_recall{gap:8px;min-width:0;display:flex}.YFJ4ta_recallLabel{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.YFJ4ta_recallCounts{color:var(--dsw-alias-label-caption);flex:none}";
		const tagId$14 = "@deepseek-ai/dsh-client-ui-chat/ContextBody.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$14) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$14;
			tag.textContent = css$14;
			document.head.appendChild(tag);
		}
		var ContextBody_module_css_default = {
			"catalogNotice": "YFJ4ta_catalogNotice",
			"entries": "YFJ4ta_entries",
			"entry": "YFJ4ta_entry",
			"entryDescription": "YFJ4ta_entryDescription",
			"entryName": "YFJ4ta_entryName",
			"field": "YFJ4ta_field",
			"fieldKey": "YFJ4ta_fieldKey",
			"fieldValue": "YFJ4ta_fieldValue",
			"fields": "YFJ4ta_fields",
			"file": "YFJ4ta_file",
			"fileAction": "YFJ4ta_fileAction",
			"filePath": "YFJ4ta_filePath",
			"files": "YFJ4ta_files",
			"recall": "YFJ4ta_recall",
			"recallCounts": "YFJ4ta_recallCounts",
			"recallLabel": "YFJ4ta_recallLabel",
			"recalls": "YFJ4ta_recalls",
			"relaySender": "YFJ4ta_relaySender",
			"section": "YFJ4ta_section",
			"sectionName": "YFJ4ta_sectionName",
			"sectionText": "YFJ4ta_sectionText",
			"sections": "YFJ4ta_sections",
			"text": "YFJ4ta_text"
		};
		//#endregion
		//#region lib/types/client/chat/ContextBody.js
		/** Model-facing text stays bounded at the disclosure, not at the producer. */
		const MAX_CHARS = 2e4;
		/** Rows a list body materializes before summarizing the remainder. */
		const MAX_ENTRIES = 200;
		/** One durable source narrowed to the readable-record shape; null for anything else. */
		function asRecord$1(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
		}
		/**
		* The content blocks as runs, IN THE ORDER the model received them.
		*
		* Adjacent text blocks join with no separator, matching how provider adapters
		* flatten them — inserting a line break would show the reader a line the model
		* never saw. An unknown block breaks the run and keeps its own fallback rather
		* than being hoisted past the text around it or vanishing; the block union is
		* merge-extensible, so a foreign log may interleave shapes this build does not
		* know.
		*/
		function contentRuns(content) {
			const runs = [];
			for (const block of content) {
				if (block.type !== "text") {
					runs.push({ block });
					continue;
				}
				const last = runs[runs.length - 1];
				if (last !== void 0 && "text" in last) last.text += block.text;
				else runs.push({ text: block.text });
			}
			return runs;
		}
		/** Only the blocks this UI version does not know, for bodies that replace the text. */
		function unknownBlocks(content) {
			return contentRuns(content).flatMap((run) => "block" in run ? [run.block] : []);
		}
		/** The model-facing text, truncated to the display bound. */
		function boundedText(text, t) {
			return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n${t("json.truncated", { total: text.length })}` : text;
		}
		/**
		* One source field rendered as a value row; nested shapes stay compact JSON.
		* Bounded on its own, because source fields are as unbounded as the text: an unknown
		* producer may record an arbitrarily large string or array.
		*/
		function fieldValue(value, t) {
			return boundedText(typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value), t);
		}
		/**
		* Source fields as a key/value list. `kind` is always omitted because the
		* row header already names the producer. `form` is omitted only when a
		* dedicated body rendered for it — then the presentation the reader is looking
		* at IS that value. On the opaque fallback the declaration is kept, because
		* that is the one place a form this version cannot present would otherwise
		* disappear from the UI entirely.
		*/
		function SourceFields({ source, formRendered, t }) {
			const record = asRecord$1(source);
			if (record === null) return null;
			const hidden = formRendered ? ["kind", "form"] : ["kind"];
			const rows = Object.entries(record).filter(([key]) => !hidden.includes(key));
			if (rows.length === 0) return null;
			return (0, react_jsx_runtime.jsx)("dl", {
				className: ContextBody_module_css_default.fields,
				"data-context-fields": true,
				children: rows.map(([key, value]) => (0, react_jsx_runtime.jsxs)("div", {
					className: ContextBody_module_css_default.field,
					children: [(0, react_jsx_runtime.jsx)("dt", {
						className: ContextBody_module_css_default.fieldKey,
						children: key
					}), (0, react_jsx_runtime.jsx)("dd", {
						className: ContextBody_module_css_default.fieldValue,
						children: fieldValue(value, t)
					})]
				}, key))
			});
		}
		/**
		* Content blocks this UI version does not know, kept visible rather than
		* dropped: the block union is merge-extensible, so a newer or foreign log may
		* carry a shape this build has no presentation for.
		* @param props - The unrecognized blocks and the locale seat.
		* @returns One generic JSON block per unknown entry.
		*/
		function UnknownBlocks({ blocks, t }) {
			return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: blocks.map((block, index) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
				label: t("message.unknownBlock"),
				payload: block,
				truncatedLabel: (total) => t("json.truncated", { total })
			}, index)) });
		}
		/**
		* The model-facing content of one context, shared by every form that shows it:
		* the text with its real line breaks, then any block this UI version does not
		* know, which keeps its own fallback rather than vanishing.
		* @param props - Durable content and the locale seat.
		* @returns The content blocks as the model received them.
		*/
		function ModelFacingContent({ content, t }) {
			return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: contentRuns(content).map((run, index) => "text" in run ? run.text !== "" && (0, react_jsx_runtime.jsx)("pre", {
				className: ContextBody_module_css_default.text,
				"data-context-text": true,
				children: boundedText(run.text, t)
			}, index) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
				label: t("message.unknownBlock"),
				payload: run.block,
				truncatedLabel: (total) => t("json.truncated", { total })
			}, index)) });
		}
		/**
		* Default presentation: the model-facing text as text, with its real line
		* breaks, and the remaining source fields beneath it. This is what every form
		* this UI version does not recognize renders as.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The opaque context body.
		*/
		function OpaqueBody({ content, source, t }) {
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			}), (0, react_jsx_runtime.jsx)(SourceFields, {
				source,
				formRendered: false,
				t
			})] });
		}
		/**
		* Instruction changes read off the source, or null when the record is not a
		* usable instruction list.
		*
		* The read is all-or-nothing: silently dropping one unreadable entry would show
		* a confident, incomplete file list for a log this version cannot fully read.
		* Paths are deduplicated in first-seen order, matching how the header label is
		* derived from the same array.
		*/
		function instructionChanges(source) {
			const record = asRecord$1(source);
			const list = record === null ? void 0 : record["changes"];
			if (!Array.isArray(list)) return null;
			const changes = [];
			const seen = /* @__PURE__ */ new Set();
			for (const entry of list) {
				const change = asRecord$1(entry);
				if (change === null) return null;
				const path = change["path"];
				if (typeof path !== "string" || path === "") return null;
				const action = change["action"];
				if (action !== "set" && action !== "replace" && action !== "remove") return null;
				const digest = change["digest"];
				if (seen.has(path)) continue;
				seen.add(path);
				changes.push({
					action,
					path,
					...typeof digest === "string" ? { digest } : {}
				});
			}
			return changes.length === 0 ? null : changes;
		}
		/**
		* Locale key for one reconciled file. The baseline loads a file; a later delta
		* distinguishes a newly reconciled path from a rewritten one, which `set` and
		* `replace` already separate at the producer.
		* @param action - the durable change action.
		* @param baseline - whether this context is the startup/resume baseline.
		* @returns the key naming what happened to that file.
		*/
		function instructionAction(action, baseline) {
			if (action === "remove") return "message.context.instructions.removed";
			if (baseline) return "message.context.instructions.loaded";
			return action === "set" ? "message.context.instructions.added" : "message.context.instructions.updated";
		}
		/**
		* `instructions` form: the files this context reconciled, then their text.
		*
		* The text keeps its `<system-reminder>` framing verbatim — the framing is part
		* of what the model read, so hiding it would misreport the request.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The instructions context body, or the opaque body when the change
		* list is unreadable.
		*/
		function InstructionsBody({ content, source, t }) {
			const changes = instructionChanges(source);
			if (changes === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			const baseline = asRecord$1(source)?.["baseline"] === true;
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("ul", {
				className: ContextBody_module_css_default.files,
				"data-context-files": true,
				children: changes.map((change) => (0, react_jsx_runtime.jsxs)("li", {
					className: ContextBody_module_css_default.file,
					title: change.digest,
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: ContextBody_module_css_default.filePath,
						children: change.path
					}), (0, react_jsx_runtime.jsx)("span", {
						className: ContextBody_module_css_default.fileAction,
						children: t(instructionAction(change.action, baseline))
					})]
				}, change.path))
			}), (0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			})] });
		}
		/**
		* Catalog entries read off the source, or null when the record is not a usable
		* catalog. All-or-nothing for the same reason as the instruction list: this body
		* replaces the model-facing text, so a partial list would hide the only complete
		* account of what the model read.
		*/
		function catalogEntries(source) {
			const record = asRecord$1(source);
			const list = record === null ? void 0 : record["entries"];
			if (!Array.isArray(list)) return null;
			const entries = [];
			for (const item of list) {
				const entry = asRecord$1(item);
				if (entry === null) return null;
				const name = entry["name"];
				const description = entry["description"];
				if (typeof name !== "string" || name === "" || typeof description !== "string") return null;
				entries.push({
					name,
					description
				});
			}
			return entries;
		}
		/**
		* `catalog` form: the published entries as a list, read from the source rather
		* than re-parsed out of the model-facing prose.
		*
		* A catalog whose source carries no usable entries falls through to the opaque
		* body, so an older or hand-edited log still shows its text.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The catalog context body, or the opaque body when the entry list is
		* unreadable.
		*/
		function CatalogBody({ content, source, t }) {
			const entries = catalogEntries(source);
			if (entries === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			const update = asRecord$1(source)?.["update"] === true;
			const shown = entries.slice(0, MAX_ENTRIES);
			const rest = unknownBlocks(content);
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				update && (0, react_jsx_runtime.jsx)("p", {
					className: ContextBody_module_css_default.catalogNotice,
					"data-context-catalog-update": true,
					children: t("message.context.catalog.replaced")
				}),
				(0, react_jsx_runtime.jsx)("ul", {
					className: ContextBody_module_css_default.entries,
					"data-context-entries": true,
					children: shown.map((entry, index) => (0, react_jsx_runtime.jsxs)("li", {
						className: ContextBody_module_css_default.entry,
						children: [(0, react_jsx_runtime.jsx)("code", {
							className: ContextBody_module_css_default.entryName,
							children: entry.name
						}), (0, react_jsx_runtime.jsx)("span", {
							className: ContextBody_module_css_default.entryDescription,
							children: entry.description
						})]
					}, index))
				}),
				shown.length < entries.length && (0, react_jsx_runtime.jsx)("p", {
					className: ContextBody_module_css_default.catalogNotice,
					"data-context-entries-truncated": true,
					children: t("message.context.catalog.more", { count: entries.length - shown.length })
				}),
				(0, react_jsx_runtime.jsx)(UnknownBlocks, {
					blocks: rest,
					t
				})
			] });
		}
		/** Snapshot sections read off the source, or null when the record is unusable. */
		function snapshotSections(source) {
			const record = asRecord$1(source);
			const list = record === null ? void 0 : record["sections"];
			if (!Array.isArray(list)) return null;
			const sections = [];
			for (const item of list) {
				const section = asRecord$1(item);
				if (section === null) return null;
				const name = section["name"];
				const text = section["text"];
				if (typeof name !== "string" || name === "" || typeof text !== "string") return null;
				sections.push({
					name,
					text
				});
			}
			return sections.length === 0 ? null : sections;
		}
		/**
		* `snapshot` form: the named contributions this snapshot assembled, in order.
		*
		* The sections are the same bytes the model read, split at the boundaries the
		* producer assembled them on, so a reader sees which subsystem contributed
		* which state instead of one undifferentiated wall.
		*
		* One sentence of the model-facing text is NOT in any section: the producer's
		* framing line declaring that this snapshot supersedes earlier ones. Unlike the
		* `<system-reminder>` wrapper an instruction context carries — which wraps
		* content and cannot be separated from it — that line states the form's own
		* semantics, so the body states them as a caption instead of reprinting the
		* joined prose beside the sections it was split from.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The snapshot context body, or the opaque body when unreadable.
		*/
		function SnapshotBody({ content, source, t }) {
			const sections = snapshotSections(source);
			/* v8 ignore next -- contextBody reads the sections before choosing this body. */
			if (sections === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("p", {
				className: ContextBody_module_css_default.catalogNotice,
				"data-context-snapshot-supersedes": true,
				children: t("message.context.snapshot.supersedes")
			}), (0, react_jsx_runtime.jsx)("dl", {
				className: ContextBody_module_css_default.sections,
				"data-context-sections": true,
				children: sections.map((section, index) => (0, react_jsx_runtime.jsxs)("div", {
					className: ContextBody_module_css_default.section,
					children: [(0, react_jsx_runtime.jsx)("dt", {
						className: ContextBody_module_css_default.sectionName,
						children: section.name
					}), (0, react_jsx_runtime.jsx)("dd", {
						className: ContextBody_module_css_default.sectionText,
						children: boundedText(section.text, t)
					})]
				}, index))
			})] });
		}
		/**
		* `notice` form: what just happened, with the model-facing text beneath it.
		*
		* The one-line account also rides the collapsed row ({@link contextBody}), so a
		* notice is usually readable without expanding at all.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The notice context body.
		*/
		function NoticeBody({ content, t }) {
			return (0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			});
		}
		/**
		* `relay` form: which agent sent this, then what it said.
		*
		* The sender is an opaque session id; it is shown as a field rather than a
		* label, because this client cannot resolve it to a title.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The relay context body.
		*/
		function RelayBody({ content, source, t }) {
			const sender = relaySender(source);
			/* v8 ignore next -- contextBody resolves the sender before choosing this body. */
			if (sender === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("p", {
				className: ContextBody_module_css_default.relaySender,
				"data-context-relay-sender": true,
				children: t("message.context.relay.from", { session: sender })
			}), (0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			})] });
		}
		/** The sending agent's session id, or null when the record does not name one. */
		function relaySender(source) {
			const sender = asRecord$1(source)?.["senderSessionId"];
			return typeof sender === "string" && sender !== "" ? sender : null;
		}
		/** Recalled sessions read off the source, or null when the record is unusable. */
		function recalledSessions(source) {
			const record = asRecord$1(source);
			const list = record === null ? void 0 : record["references"];
			if (!Array.isArray(list)) return null;
			const sessions = [];
			for (const item of list) {
				const reference = asRecord$1(item);
				if (reference === null) return null;
				const label = reference["label"];
				const retained = reference["retainedMessages"];
				const omitted = reference["omittedMessages"];
				const truncated = reference["truncated"];
				if (typeof label !== "string" || label === "" || typeof retained !== "number" || typeof omitted !== "number" || typeof truncated !== "boolean") return null;
				sessions.push({
					label,
					retained,
					omitted,
					truncated
				});
			}
			return sessions.length === 0 ? null : sessions;
		}
		/**
		* `recall` form: which sessions this material came from and how much of each
		* survived the read, then the material itself.
		*
		* Completeness is the fact a reader needs first: recalled context is bounded on
		* the way in, so a card that hid the omitted count would overstate what the
		* model received.
		* @param props - Durable content, its source, and the locale seat.
		* @returns The recall context body, or the opaque body when unreadable.
		*/
		function RecallBody({ content, source, t }) {
			const sessions = recalledSessions(source);
			if (sessions === null) return (0, react_jsx_runtime.jsx)(OpaqueBody, {
				content,
				source,
				t
			});
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("ul", {
				className: ContextBody_module_css_default.recalls,
				"data-context-recalls": true,
				children: sessions.map((session, index) => (0, react_jsx_runtime.jsxs)("li", {
					className: ContextBody_module_css_default.recall,
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: ContextBody_module_css_default.recallLabel,
							children: session.label
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: ContextBody_module_css_default.recallCounts,
							children: t("message.context.recall.counts", {
								retained: session.retained,
								omitted: session.omitted
							})
						}),
						session.truncated && (0, react_jsx_runtime.jsx)("span", {
							className: ContextBody_module_css_default.recallCounts,
							children: t("message.context.recall.truncated")
						})
					]
				}, index))
			}), (0, react_jsx_runtime.jsx)(ModelFacingContent, {
				content,
				t
			})] });
		}
		/** The one-line account a `notice` puts on its collapsed row, when it records one. */
		function noticeSummary(source) {
			const summary = asRecord$1(source)?.["summary"];
			return typeof summary === "string" && summary !== "" ? summary : null;
		}
		/**
		* Choose the body for one context node.
		*
		* Returns the form the body actually rendered as, which is not always the
		* declared one: a declared form whose fields are unreadable falls back to
		* opaque, and the caller labels the row with what it really shows.
		* `summary` is the collapsed row's one-line account, which only a `notice`
		* records: its whole point is being readable without expanding.
		* @param form - the producer-declared form projected onto the node.
		* @param props - durable content, its source, and the locale seat.
		* @returns the rendered form (null for opaque), its collapsed summary, and its body.
		*/
		function contextBody(form, props) {
			const opaque = {
				rendered: null,
				summary: null,
				body: (0, react_jsx_runtime.jsx)(OpaqueBody, { ...props })
			};
			switch (form) {
				case "instructions": return instructionChanges(props.source) === null ? opaque : {
					rendered: "instructions",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(InstructionsBody, { ...props })
				};
				case "catalog": return catalogEntries(props.source) === null ? opaque : {
					rendered: "catalog",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(CatalogBody, { ...props })
				};
				case "snapshot": return snapshotSections(props.source) === null ? opaque : {
					rendered: "snapshot",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(SnapshotBody, { ...props })
				};
				case "notice": {
					const summary = noticeSummary(props.source);
					return summary === null ? opaque : {
						rendered: "notice",
						summary,
						body: (0, react_jsx_runtime.jsx)(NoticeBody, { ...props })
					};
				}
				case "relay": return relaySender(props.source) === null ? opaque : {
					rendered: "relay",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(RelayBody, { ...props })
				};
				case "recall": return recalledSessions(props.source) === null ? opaque : {
					rendered: "recall",
					summary: null,
					body: (0, react_jsx_runtime.jsx)(RecallBody, { ...props })
				};
				case null: return opaque;
				/* v8 ignore next 4 -- closed-union backstop; the compiler rejects a new
				KnownContextForm here rather than letting it degrade to opaque silently. */
				default: throw new Error(`unreachable context form: ${String(form)}`);
			}
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/ContextInjectionRow.module.css.mjs
		const css$13 = ".wBI3_a_root{min-width:0}.wBI3_a_root[data-open]{padding-bottom:4px}.wBI3_a_chevron{color:var(--dsw-alias-label-secondary)}.wBI3_a_sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.wBI3_a_source{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:none;overflow:hidden}.wBI3_a_summary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.wBI3_a_body{box-sizing:border-box;width:calc(100% - 22px - var(--dsh-content-font-delta,0px));max-height:141px;margin:4px 0 0 calc(22px + var(--dsh-content-font-delta,0px));background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code);border:none;border-radius:8px;padding:10px 16px 12px 12px;overflow:auto}";
		const tagId$13 = "@deepseek-ai/dsh-client-ui-chat/ContextInjectionRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$13) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$13;
			tag.textContent = css$13;
			document.head.appendChild(tag);
		}
		var ContextInjectionRow_module_css_default = {
			"body": "wBI3_a_body",
			"chevron": "wBI3_a_chevron",
			"root": "wBI3_a_root",
			"sep": "wBI3_a_sep",
			"source": "wBI3_a_source",
			"summary": "wBI3_a_summary"
		};
		//#endregion
		//#region lib/types/client/chat/ContextInjectionRow.js
		/**
		* Render logged context with the Tool calls disclosure chrome from Figma.
		*
		* The header names the role the context plays and, beside it, the producer the
		* durable source identifies, so a reader can tell an injected skill catalog
		* from a workspace instruction file or a recalled session without expanding.
		* The expanded body follows the producer-declared form; an absent or unknown
		* form renders the opaque body.
		* @param props - Durable content, its projected producer role/name and form, and the locale seat.
		* @returns A collapsed context row with a bounded, form-specific body.
		*/
		function ContextInjectionRow({ content, source, provenance, form, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const { rendered, summary, body } = contextBody(form, {
				content,
				source,
				t
			});
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
				className: ContextInjectionRow_module_css_default.root,
				icon: provenance.role === "recall" ? (0, react_jsx_runtime.jsx)("span", {
					"data-context-recall-icon": true,
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ReferenceIcon, { kind: "session" })
				}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconContextInjectionOutline16, { size: 14 }),
				chevronClassName: ContextInjectionRow_module_css_default.chevron,
				title: t(provenance.role === "recall" ? "message.contextRecall" : "message.contextInjection"),
				collapsedContent: provenance.label === null ? void 0 : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: ContextInjectionRow_module_css_default.sep,
						"aria-hidden": true
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: ContextInjectionRow_module_css_default.source,
						"data-context-source": true,
						children: provenance.label
					}),
					summary !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
						className: ContextInjectionRow_module_css_default.sep,
						"aria-hidden": true
					}), (0, react_jsx_runtime.jsx)("span", {
						className: ContextInjectionRow_module_css_default.summary,
						"data-context-summary": true,
						children: summary
					})] })
				] }),
				keepContentWhenOpen: true,
				open,
				expandable: true,
				expandOnRowClick: true,
				onToggle: () => {
					setOpen((value) => !value);
				},
				children: (0, react_jsx_runtime.jsx)("div", {
					className: ContextInjectionRow_module_css_default.body,
					"data-context-injection-body": true,
					"data-context-form": rendered ?? void 0,
					children: body
				})
			});
		}
		//#endregion
		//#region lib/types/client/chat/message-chrome.js
		function pad2(n) {
			return String(n).padStart(2, "0");
		}
		/**
		* Local calendar-day epoch (ms at local midnight) for an instant.
		* @param ms - Unix epoch ms.
		* @returns Midnight of that local calendar day.
		*/
		function startOfLocalDay(ms) {
			const d = new Date(ms);
			d.setHours(0, 0, 0, 0);
			return d.getTime();
		}
		/**
		* Delay until the next local midnight after `ms` (at least 1ms).
		* @param ms - Unix epoch ms.
		* @returns Milliseconds until the following local midnight.
		*/
		function msUntilNextLocalMidnight(ms) {
			const next = new Date(ms);
			next.setHours(24, 0, 0, 0);
			return Math.max(next.getTime() - ms, 1);
		}
		/**
		* Localized elapsed-time label shared by running and settled turn chrome.
		* @param ms - Elapsed duration in milliseconds (negatives clamp to zero).
		* @param t - Translate seat supplying the duration templates.
		* @returns Display string in whole seconds.
		*/
		function formatRunDuration(ms, t) {
			const total = Math.max(0, Math.floor(ms / 1e3));
			const minutes = Math.floor(total / 60);
			const seconds = total % 60;
			return minutes > 0 ? t("duration.minutes", {
				minutes,
				seconds: String(seconds).padStart(2, "0")
			}) : t("duration.seconds", { seconds });
		}
		/**
		* Sub-turn latency figure: one decimal under ten seconds, whole seconds
		* beyond. Unit-less so the locale template owns the second suffix.
		* @param ms - Latency in milliseconds (negatives clamp to zero).
		* @returns Display number in seconds without unit.
		*/
		function formatLatencySeconds(ms) {
			const s = Math.max(0, ms) / 1e3;
			return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
		}
		/**
		* Decode-throughput figure: whole tokens from ten up, one decimal below.
		* @param tps - Tokens per second.
		* @returns Display number without unit.
		*/
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		/**
		* Compact local timestamp for message IconActions. Same calendar day →
		* `HH:mm`; earlier this year → the `clock.md` date template + clock; other
		* years → the `clock.ymd` template + clock. Pure: the date templates arrive
		* through the caller's locale seat.
		* @param time - Unix epoch ms from the source session event.
		* @param t - translate seat supplying the `clock.md` / `clock.ymd` templates.
		* @param now - Reference instant for the day/year cut (defaults to wall clock).
		* @returns Date-aware clock string (24-hour, zero-padded time).
		*/
		function formatMessageClock(time, t, now = Date.now()) {
			const d = new Date(time);
			const n = new Date(now);
			const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
			if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock;
			const params = {
				y: d.getFullYear(),
				m: d.getMonth() + 1,
				d: d.getDate()
			};
			return `${d.getFullYear() === n.getFullYear() ? t("clock.md", params) : t("clock.ymd", params)} ${clock}`;
		}
		//#endregion
		//#region lib/types/client/chat/use-calendar-day.js
		/**
		* Local calendar-day epoch that advances at each local midnight.
		* @returns Midnight ms for the current local day; updates after the boundary.
		*/
		function useCalendarDay() {
			const [day, setDay] = (0, react.useState)(() => startOfLocalDay(Date.now()));
			(0, react.useEffect)(() => {
				let timer;
				const arm = () => {
					const now = Date.now();
					setDay(startOfLocalDay(now));
					timer = setTimeout(arm, msUntilNextLocalMidnight(now));
				};
				timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()));
				return () => {
					clearTimeout(timer);
				};
			}, []);
			return day;
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/MessageIconActions.module.css.mjs
		const css$12 = ".puIG1q_actions{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:10px;display:flex}.puIG1q_timeStart{font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}.puIG1q_timeEnd{font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-left:12px}.puIG1q_runTimeDot{margin:0 10px}@media (hover:hover){[data-time-hover-root] :is(.puIG1q_timeStart,.puIG1q_timeEnd){opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover :is(.puIG1q_timeStart,.puIG1q_timeEnd),[data-time-hover-root]:focus-within :is(.puIG1q_timeStart,.puIG1q_timeEnd){opacity:1}}.puIG1q_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}.puIG1q_action svg{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px))}.puIG1q_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.puIG1q_action[data-unavailable]{cursor:default;opacity:.4}.puIG1q_action[data-unavailable]:hover{color:var(--dsw-alias-label-tertiary);background:0 0}.puIG1q_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";
		const tagId$12 = "@deepseek-ai/dsh-client-ui-chat/MessageIconActions.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$12) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$12;
			tag.textContent = css$12;
			document.head.appendChild(tag);
		}
		var MessageIconActions_module_css_default = {
			"action": "puIG1q_action",
			"actions": "puIG1q_actions",
			"runTimeDot": "puIG1q_runTimeDot",
			"timeEnd": "puIG1q_timeEnd",
			"timeStart": "puIG1q_timeStart",
			"visuallyHidden": "puIG1q_visuallyHidden"
		};
		//#endregion
		//#region lib/types/client/chat/MessageIconActions.js
		/**
		* Copy / branch (/ clock) IconActions row shared by user and assistant chrome.
		* @param props - Copy text, event time, clock side, branch callback, className.
		* @returns The actions row element.
		*/
		function MessageIconActions({ text, time, runMs, ttftMs, tokensPerSecond, clock, onBranch, branchUnavailable = false, className, extraActions, t }) {
			const day = useCalendarDay();
			const reasonId = (0, react.useId)();
			const [copied, setCopied] = (0, react.useState)(false);
			const copyPending = (0, react.useRef)(false);
			const copyTimer = (0, react.useRef)(null);
			const copyEpoch = (0, react.useRef)(0);
			(0, react.useEffect)(() => () => {
				copyEpoch.current += 1;
				copyPending.current = false;
				if (copyTimer.current !== null) clearTimeout(copyTimer.current);
			}, []);
			const onCopy = (0, react.useCallback)(() => {
				if (copied || copyPending.current) return;
				const epoch = copyEpoch.current;
				copyPending.current = true;
				(0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(text).then((ok) => {
					if (epoch !== copyEpoch.current) return;
					copyPending.current = false;
					if (!ok) return;
					setCopied(true);
					copyTimer.current = window.setTimeout(() => {
						copyTimer.current = null;
						setCopied(false);
					}, 1e3);
				});
			}, [copied, text]);
			const clockEl = time === void 0 ? null : (0, react_jsx_runtime.jsxs)("span", {
				className: clock === "start" ? MessageIconActions_module_css_default.timeStart : MessageIconActions_module_css_default.timeEnd,
				children: [
					formatMessageClock(time, t, day),
					runMs !== void 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						" ",
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageIconActions_module_css_default.runTimeDot,
							"aria-hidden": true,
							children: "·"
						}),
						" ",
						t("message.ranFor", { duration: formatRunDuration(runMs, t) })
					] }),
					ttftMs !== void 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						" ",
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageIconActions_module_css_default.runTimeDot,
							"aria-hidden": true,
							children: "·"
						}),
						" ",
						t("message.ttft", { seconds: formatLatencySeconds(ttftMs) })
					] }),
					tokensPerSecond !== void 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						" ",
						(0, react_jsx_runtime.jsx)("span", {
							className: MessageIconActions_module_css_default.runTimeDot,
							"aria-hidden": true,
							children: "·"
						}),
						" ",
						t("message.tokensPerSecond", { tps: formatTokensPerSecond(tokensPerSecond) })
					] })
				]
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				className: className === void 0 ? MessageIconActions_module_css_default.actions : `${MessageIconActions_module_css_default.actions} ${className}`,
				children: [
					clock === "start" ? clockEl : null,
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: copied ? t("copied") : t("copy"),
						side: "bottom",
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageIconActions_module_css_default.action,
							"aria-label": copied ? t("copied") : t("copy"),
							onClick: onCopy,
							children: copied ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, {})
						})
					}),
					extraActions,
					onBranch !== void 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: branchUnavailable ? t("message.branchUnavailable") : t("message.branch"),
						side: "bottom",
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageIconActions_module_css_default.action,
							"aria-label": t("message.branch"),
							"aria-disabled": branchUnavailable || void 0,
							"aria-describedby": branchUnavailable ? reasonId : void 0,
							"data-unavailable": branchUnavailable || void 0,
							onClick: branchUnavailable ? void 0 : onBranch,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
						})
					}),
					onBranch !== void 0 && branchUnavailable && (0, react_jsx_runtime.jsx)("span", {
						id: reasonId,
						className: MessageIconActions_module_css_default.visuallyHidden,
						children: t("message.branchUnavailable")
					}),
					clock === "end" ? clockEl : null
				]
			});
		}
		//#endregion
		//#region lib/types/client/chat/MessageItem.js
		function contentParts(content) {
			const texts = [];
			const images = [];
			const rest = [];
			for (const block of content) {
				const b = block;
				if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
				else if (b.type === "image" && b.attachment !== void 0) images.push({ attachment: b.attachment });
				else rest.push(block);
			}
			return {
				text: texts.join(""),
				images,
				rest
			};
		}
		function retrySeconds(milliseconds) {
			return Math.max(1, Math.ceil(milliseconds / 1e3));
		}
		function failureMessage(message, code, t) {
			return code === "AUTH" ? t("message.failure.auth") : message;
		}
		function ModelRetryItem({ node, active, t }) {
			const deadline = (0, react.useMemo)(() => Date.now() + node.delayMs, [node.delayMs, node.seq]);
			const scheduledSeconds = retrySeconds(node.delayMs);
			const maximum = node.mode === "normal" ? node.maxRetries : "∞";
			const [countdown, setCountdown] = (0, react.useState)(() => ({
				deadline,
				seconds: retrySeconds(deadline - Date.now())
			}));
			const remainingSeconds = countdown.deadline === deadline ? countdown.seconds : retrySeconds(deadline - Date.now());
			(0, react.useEffect)(() => {
				if (!active) return;
				const updateCountdown = () => {
					const next = retrySeconds(deadline - Date.now());
					setCountdown((current) => current.deadline === deadline && current.seconds === next ? current : {
						deadline,
						seconds: next
					});
					return next;
				};
				if (updateCountdown() === 1) return;
				const timer = window.setInterval(() => {
					if (updateCountdown() === 1) window.clearInterval(timer);
				}, 250);
				return () => {
					window.clearInterval(timer);
				};
			}, [active, deadline]);
			const label = active ? t("message.retry.active") : node.retryState === "cancelled" ? t("message.retry.cancelled") : node.retryState === "started" ? t("message.retry.started") : t("message.retry.scheduled");
			const seconds = active ? remainingSeconds : scheduledSeconds;
			return (0, react_jsx_runtime.jsxs)("details", {
				className: MessageItem_module_css_default.retryRow,
				"data-active": active || void 0,
				children: [(0, react_jsx_runtime.jsx)("summary", {
					className: MessageItem_module_css_default.retrySummary,
					children: (0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.retryText,
						role: "status",
						children: t("message.retry.status", {
							label,
							retry: node.retry,
							maximum,
							seconds
						})
					})
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: MessageItem_module_css_default.retryDetails,
					children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.retryDetailLabel,
						children: t("message.retry.delay")
					}), t("duration.milliseconds", { milliseconds: Math.round(node.delayMs) })] }), (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.retryDetailLabel,
						children: t("message.retry.failure")
					}), failureMessage(node.failure.message, node.failure.code, t)] })]
				})]
			});
		}
		/** Persistent, turn-positioned feedback for a terminal failure. */
		function TurnErrorItem({ node, t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.turnErrorRow,
				role: "status",
				children: [
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
						state: "error",
						className: MessageItem_module_css_default.turnErrorDot
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: MessageItem_module_css_default.turnErrorCopy,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.turnErrorTitle,
							children: t("message.turnError")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.turnErrorMessage,
							children: failureMessage(node.message, node.code, t)
						})]
					}),
					node.code !== void 0 && (0, react_jsx_runtime.jsx)("code", {
						className: MessageItem_module_css_default.turnErrorCode,
						children: node.code
					})
				]
			});
		}
		/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
		function TurnMaxTokensItem({ t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.turnErrorRow,
				role: "status",
				children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
					state: "warning",
					className: MessageItem_module_css_default.turnErrorDot
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: MessageItem_module_css_default.turnErrorCopy,
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.maxTokensTitle,
						children: t("message.maxTokens")
					}), (0, react_jsx_runtime.jsx)("span", {
						className: MessageItem_module_css_default.turnErrorMessage,
						children: t("message.maxTokens.hint")
					})]
				})]
			});
		}
		/** Right-aligned bubble shared by user and steering rows. */
		function UserStyleBubble({ content, renderMessageImages, actions, pending = false, echo = false, referenceLabels = [], previewImages, t }) {
			const { text, images: contentImages, rest } = contentParts(content);
			const images = previewImages ?? contentImages;
			const truncated = (total) => t("json.truncated", { total });
			const showBubble = text !== "" || rest.length > 0;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.userRow,
				"data-pending-steering": pending || void 0,
				"data-submission-echo": echo || void 0,
				"data-time-hover-root": true,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: MessageItem_module_css_default.userStack,
					children: [
						renderMessageImages({
							images,
							align: "end"
						}),
						showBubble && (0, react_jsx_runtime.jsxs)("div", {
							className: MessageItem_module_css_default.bubble,
							children: [(0, _deepseek_ai_dsh_client_ui_primitives.projectUserText)(text, referenceLabels), rest.map((block, i) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
								label: t("message.extraBlock"),
								payload: block,
								truncatedLabel: truncated
							}, i))]
						}),
						referenceLabels.length > 0 && (0, react_jsx_runtime.jsx)("div", {
							className: MessageItem_module_css_default.referenceSummary,
							children: t("message.referenceSummary", { labels: referenceLabels.join(t("message.referenceSeparator")) })
						})
					]
				}), actions?.(text)]
			});
		}
		/**
		* Render one Host-authoritative pending steering item with the same visual
		* language as its eventual durable transcript node.
		* @param props - Pending message content and conversation translator.
		* @returns the pending steering bubble.
		*/
		function PendingSteeringBubble({ content, renderMessageImages, t }) {
			return (0, react_jsx_runtime.jsx)(UserStyleBubble, {
				content,
				renderMessageImages,
				pending: true,
				t,
				actions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text,
					clock: "start",
					className: MessageItem_module_css_default.actions,
					t
				})
			});
		}
		/**
		* Render one local submission echo with the exact visual language of the
		* durable user node that replaces it: draft text plus object-URL previews,
		* visible from the submit click until the durable `user/message` (or its
		* queue occurrence) renders.
		* @param props - the session snapshot's pending submission and render seats.
		* @returns the echoed user bubble.
		*/
		function PendingSubmissionBubble({ submission, renderMessageImages, t }) {
			return (0, react_jsx_runtime.jsx)(UserStyleBubble, {
				content: (0, react.useMemo)(() => submission.text === "" ? [] : [{
					type: "text",
					text: submission.text
				}], [submission.text]),
				previewImages: (0, react.useMemo)(() => submission.images.map((image) => ({ preview: {
					url: image.previewUrl,
					...image.name === void 0 ? {} : { name: image.name },
					...image.width === void 0 ? {} : { width: image.width },
					...image.height === void 0 ? {} : { height: image.height }
				} })), [submission.images]),
				renderMessageImages,
				echo: true,
				t,
				actions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text,
					time: submission.time,
					clock: "start",
					className: MessageItem_module_css_default.actions,
					t
				})
			});
		}
		/** User and admitted-steering keyed Chat renderer. */
		const UserMessageNodeView = (0, react.memo)(function UserMessageNodeView({ node, renderMessageImages, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)(UserStyleBubble, {
				content: data.content,
				renderMessageImages,
				...data.referenceLabels === void 0 ? {} : { referenceLabels: data.referenceLabels },
				t,
				actions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text,
					time: data.time,
					clock: "start",
					className: MessageItem_module_css_default.actions,
					t
				})
			});
		});
		/** Injected-context keyed Chat renderer. */
		const ContextMessageNodeView = (0, react.memo)(function ContextMessageNodeView({ node, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)(ContextInjectionRow, {
				content: data.content,
				source: data.source,
				provenance: data.provenance,
				form: data.form,
				t
			});
		});
		/** Automatic compaction keyed Chat renderer. */
		const CompactionNodeView = (0, react.memo)(function CompactionNodeView({ node, t }) {
			return (0, react_jsx_runtime.jsx)(CompactionItem, {
				node: node.data,
				t
			});
		});
		/** Correlated retry-chain keyed Chat renderer. */
		const RetryNodeView = (0, react.memo)(function RetryNodeView({ node, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)(ModelRetryItem, {
				node: data.current,
				active: data.current.retryState === "scheduled",
				t
			});
		});
		/** Terminal turn-error keyed Chat renderer. */
		const TurnErrorNodeView = (0, react.memo)(function TurnErrorNodeView({ node, t }) {
			return (0, react_jsx_runtime.jsx)(TurnErrorItem, {
				node: node.data,
				t
			});
		});
		/** Max-tokens turn-end notice keyed Chat renderer. */
		const TurnMaxTokensNodeView = (0, react.memo)(function TurnMaxTokensNodeView({ t }) {
			return (0, react_jsx_runtime.jsx)(TurnMaxTokensItem, { t });
		});
		/** Explicit unknown-surface keyed Chat renderer. */
		const UnknownNodeView = (0, react.memo)(function UnknownNodeView({ node, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)("div", {
				className: MessageItem_module_css_default.contextRow,
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
					label: t("message.unknownSurface", { type: data.type }),
					payload: data.data,
					truncatedLabel: (total) => t("json.truncated", { total })
				})
			});
		});
		/** Chat Node kinds that remain independent of a Turn's process disclosure. */
		const TURN_PROCESS_INDEPENDENT_KINDS = new Set([
			"system-prompt",
			"user",
			"steering",
			"turn-process",
			"turn-error",
			"turn-max-tokens",
			"turn-tail"
		]);
		/**
		* Identify one finalized answer generation without using its ordering anchor.
		* @param spec - current Turn process specification.
		* @returns stable identity until the finalized answer Step is withdrawn or replaced.
		*/
		function turnProcessGeneration(spec) {
			return `${String(spec.turn)}|${spec.answerStep === null ? "" : String(spec.answerStep)}`;
		}
		/**
		* Encode one process specification as a primitive Location-data value.
		* @param spec - current Turn process specification.
		* @returns reference-stable scalar for equal specifications.
		*/
		function encodeTurnProcess(spec) {
			return [
				spec.turn,
				spec.controlAnchorSeq,
				spec.processStartSeq,
				spec.answerAnchorSeq ?? "",
				spec.answerStep ?? "",
				spec.inlineReasoning ? 1 : 0,
				spec.messageCount,
				spec.toolCallCount,
				spec.subagentCount
			].join("|");
		}
		/**
		* Decode a same-process signature produced by {@link encodeTurnProcess}.
		* @param signature - encoded Turn process value.
		* @returns decoded process specification.
		*/
		function decodeTurnProcess(signature) {
			const [turn, controlAnchorSeq, processStartSeq, answerAnchorSeq, answerStep, inlineReasoning, messageCount, toolCallCount, subagentCount] = signature.split("|");
			return {
				turn: Number(turn),
				controlAnchorSeq: Number(controlAnchorSeq),
				processStartSeq: Number(processStartSeq),
				answerAnchorSeq: answerAnchorSeq === "" ? null : Number(answerAnchorSeq),
				answerStep: answerStep === "" ? null : Number(answerStep),
				inlineReasoning: inlineReasoning === "1",
				messageCount: Number(messageCount),
				toolCallCount: Number(toolCallCount),
				subagentCount: Number(subagentCount)
			};
		}
		/**
		* Recognize the shipped subagent delegation name and its configured variants.
		* Control tools use distinct names such as `send_message` and `list_agents`.
		* @param name - durable Tool-call name.
		* @returns whether the call creates or forks a subagent.
		*/
		function isSubagentDelegationTool(name) {
			return name === "subagent" || name.startsWith("subagent_");
		}
		//#endregion
		//#region lib/types/client/stores.js
		/** Per-Session Chat selection store shared by the transcript and details panel. */
		/**
		* Resolve any stored generation for one Turn.
		* @param state - Chat store snapshot.
		* @param turn - owning Turn.
		* @returns the Turn's stored entry, when present.
		*/
		function storedTurnProcessEntry(state, turn) {
			return state.turnProcesses.find((entry) => entry.turn === turn);
		}
		/**
		* Create the Chat selection store handle.
		* @returns a handle instantiated once per rendered Session scope.
		*/
		function createChatStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({
					selection: null,
					turnProcesses: []
				}),
				actions: {
					select: (draft, target) => {
						draft.selection = target;
					},
					setTurnProcessOpen: (draft, turn, generation, open) => {
						const index = draft.turnProcesses.findIndex((entry) => entry.turn === turn);
						if (!open) {
							if (index >= 0) draft.turnProcesses.splice(index, 1);
							return;
						}
						const next = {
							turn,
							generation
						};
						if (index < 0) draft.turnProcesses.push(next);
						else draft.turnProcesses[index] = next;
					}
				}
			});
		}
		//#endregion
		//#region lib/types/client/chat/searchable-hidden.js
		/**
		* Apply searchable hidden state without unmounting a stable subtree.
		* @param hidden - whether the subtree is currently hidden.
		* @param reveal - callback for browser find's `beforematch` reveal.
		* @returns ref for the stable subtree root.
		*/
		function useSearchableHidden(hidden, reveal) {
			const ref = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const element = ref.current;
				if (element === null) return;
				if (hidden && element.contains(element.ownerDocument.activeElement)) {
					reveal();
					return;
				}
				if (hidden) element.setAttribute("hidden", "until-found");
				else element.removeAttribute("hidden");
			}, [hidden, reveal]);
			(0, react.useEffect)(() => {
				const element = ref.current;
				if (element === null) return;
				element.addEventListener("beforematch", reveal);
				return () => {
					element.removeEventListener("beforematch", reveal);
				};
			}, [reveal]);
			return ref;
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/ChatView.module.css.mjs
		const css$11 = ".k2S5XG_root{flex-direction:column;flex:auto;min-height:0;display:flex;position:relative}.k2S5XG_scroll{min-height:0;padding:16px calc(var(--dsh-composer-side-clearance) + 16px);flex:auto;overflow-y:auto;container-type:inline-size}[data-conversation-scroll] .k2S5XG_root{flex:none;height:auto;min-height:auto}[data-conversation-scroll] .k2S5XG_scroll{flex:none;min-height:auto;overflow:visible}.k2S5XG_column{max-width:var(--dsh-chat-content-width);flex-direction:column;width:100%;margin:0 auto;display:flex}.k2S5XG_column>:not([hidden]):not(.k2S5XG_flowItem:empty)~:not([hidden]):not(.k2S5XG_flowItem:empty){margin-top:var(--dsh-chat-flow-gap,16px)}.k2S5XG_flowItem{min-width:0}.k2S5XG_flowItem[data-turn-process-answer]{--dsh-chat-flow-gap:8px}.k2S5XG_flowItem:empty{display:none}.k2S5XG_callRow{border-radius:6px}.k2S5XG_turnStatus{height:calc(26px + var(--dsh-content-font-delta,0px));font:var(--dsw-font-s-strong-14);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:nowrap;background:linear-gradient(90deg, var(--dsw-static-deepseek-500) 0%, var(--dsw-static-deepseek-500) 40%, var(--dsw-static-deepseek-200) 50%, var(--dsw-static-deepseek-500) 60%, var(--dsw-static-deepseek-500) 100%);color:#0000;-webkit-text-fill-color:transparent;background-position:100% 0;background-size:250% 100%;-webkit-background-clip:text;background-clip:text;flex:none;align-self:flex-start;align-items:center;animation:1.8s linear infinite k2S5XG_dsh-turn-status-shimmer;display:inline-flex}.k2S5XG_turnStatusClock{font:var(--dsw-font-xs-13);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption);-webkit-text-fill-color:var(--dsw-alias-label-caption);margin-left:8px;font-weight:400}@keyframes k2S5XG_dsh-turn-status-shimmer{to{background-position:0 0}}@media (prefers-reduced-motion:reduce){.k2S5XG_turnStatus{background-position:0 0;background-size:100% 100%;animation:none}}.k2S5XG_hint{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}.k2S5XG_openError{color:var(--dsw-alias-state-error-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}.k2S5XG_older{justify-content:center;display:flex}.k2S5XG_older button{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid);cursor:pointer;border:none;border-radius:14px;padding:4px 12px;font-size:12px}.k2S5XG_older button:disabled{cursor:default;opacity:.6}.k2S5XG_toBottomSlot{z-index:8;height:0;padding-right:max(0px, calc((100% - var(--dsh-chat-content-width)) / 2));pointer-events:none;justify-content:flex-end;display:flex;position:sticky;bottom:16px}[data-conversation-scroll] .k2S5XG_toBottomSlot{bottom:calc(var(--dsh-composer-height,152px) + 16px)}.k2S5XG_toBottom{border:1px solid var(--dsw-alias-border-l2);width:34px;height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-floating-fill);box-shadow:var(--dsw-shadow-lv2);cursor:pointer;pointer-events:auto;border-radius:100px;justify-content:center;align-items:center;margin-top:-34px;padding:0;display:flex}.k2S5XG_toBottom:hover{background:var(--dsw-alias-button-floating-hover)}.k2S5XG_modalAction{min-width:72px}";
		const tagId$11 = "@deepseek-ai/dsh-client-ui-chat/ChatView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$11) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$11;
			tag.textContent = css$11;
			document.head.appendChild(tag);
		}
		var ChatView_module_css_default = {
			"callRow": "k2S5XG_callRow",
			"column": "k2S5XG_column",
			"dsh-turn-status-shimmer": "k2S5XG_dsh-turn-status-shimmer",
			"flowItem": "k2S5XG_flowItem",
			"hint": "k2S5XG_hint",
			"modalAction": "k2S5XG_modalAction",
			"older": "k2S5XG_older",
			"openError": "k2S5XG_openError",
			"root": "k2S5XG_root",
			"scroll": "k2S5XG_scroll",
			"toBottom": "k2S5XG_toBottom",
			"toBottomSlot": "k2S5XG_toBottomSlot",
			"turnStatus": "k2S5XG_turnStatus",
			"turnStatusClock": "k2S5XG_turnStatusClock"
		};
		//#endregion
		//#region lib/types/client/chat/ChatNodeSeat.js
		const EMPTY_PROCESS_KEYS = [];
		function turnProcessOpeningHumanAnchor(keys, nodes, spec) {
			let anchor;
			for (const key of keys) {
				const node = nodes.get(key);
				if ((node?.kind === "user" || node?.kind === "steering") && node.anchorSeq < spec.controlAnchorSeq) anchor = Math.min(anchor ?? node.anchorSeq, node.anchorSeq);
			}
			return anchor;
		}
		/** Derive disclosure facts from one content-revisioned Turn index. */
		function turnProcessLayout(keys, nodes, spec) {
			let hasExternalProcess = false;
			let compactAnswer = true;
			const openingHumanAnchor = turnProcessOpeningHumanAnchor(keys, nodes, spec);
			for (const key of keys) {
				const node = nodes.get(key);
				if (node === void 0 || node.kind === "turn-process") continue;
				if ((node.kind === "user" || node.kind === "steering") && (openingHumanAnchor === void 0 || node.anchorSeq > openingHumanAnchor) && (spec.answerAnchorSeq === null || node.anchorSeq < spec.answerAnchorSeq)) compactAnswer = false;
				if (TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind) || node.anchorSeq < spec.processStartSeq || spec.answerAnchorSeq !== null && node.anchorSeq >= spec.answerAnchorSeq) continue;
				if (node.kind !== "assistant-step" || spec.answerStep === null || node.data.step !== spec.answerStep) hasExternalProcess = true;
			}
			return {
				hasExternalProcess,
				compactAnswer
			};
		}
		/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
		const ChatNodeSeat = (0, react.memo)(function ChatNodeSeat({ nodeKey, historyIncomplete, compactTranscript, selectedCallId, cwd, openFile, inspectCall, forkAt, renderMessageImages, fileMentions, useChat, useStore, actions, renderSlot, t }) {
			const node = useChat((snapshot) => snapshot.nodes.get(nodeKey));
			const processSignature = useChat((snapshot) => {
				const location = snapshot.nodes.get(nodeKey)?.location;
				return location?.kind === "turn" || location?.kind === "step" ? location.turn.data.get("turn-process") : void 0;
			});
			const processSpec = (0, react.useMemo)(() => processSignature === void 0 ? void 0 : decodeTurnProcess(processSignature), [processSignature]);
			const nodeStore = useChat((snapshot) => snapshot.nodes);
			const processLayoutKeys = useChat((snapshot) => {
				if (!compactTranscript || historyIncomplete || processSpec === void 0) return EMPTY_PROCESS_KEYS;
				const current = snapshot.nodes.get(nodeKey);
				const location = current?.location;
				if (current === void 0 || location?.kind !== "turn" && location?.kind !== "step" || location.turn.status !== "closed" || location.turn.turn !== processSpec.turn) return EMPTY_PROCESS_KEYS;
				return current.kind === "turn-process" || current.kind === "assistant-step" && current.data.step === processSpec.answerStep ? snapshot.locations.getTurn(processSpec.turn) : EMPTY_PROCESS_KEYS;
			});
			const processLayout = (0, react.useMemo)(() => processSpec === void 0 || processLayoutKeys.length === 0 ? void 0 : turnProcessLayout(processLayoutKeys, nodeStore, processSpec), [
				nodeStore,
				processLayoutKeys,
				processSpec
			]);
			const processGeneration = (0, react.useMemo)(() => processSpec === void 0 ? void 0 : turnProcessGeneration(processSpec), [processSpec]);
			const storedEntry = useStore((state) => processSpec === void 0 ? void 0 : storedTurnProcessEntry(state, processSpec.turn));
			const processOpen = (storedEntry?.generation === processGeneration ? storedEntry : void 0) !== void 0;
			const setOpen = (0, react.useCallback)((open) => {
				if (processGeneration !== void 0 && processSpec !== void 0) actions.setTurnProcessOpen(processSpec.turn, processGeneration, open);
			}, [
				actions,
				processGeneration,
				processSpec
			]);
			const routedNode = node;
			const sameTurn = routedNode !== void 0 && processSpec !== void 0 && (routedNode.location.kind === "turn" || routedNode.location.kind === "step") && routedNode.location.turn.turn === processSpec.turn;
			const turnClosed = sameTurn && routedNode.location.turn.status === "closed";
			const processWindowReady = processSpec !== void 0 && compactTranscript && processSpec.answerAnchorSeq !== null && turnClosed && !historyIncomplete;
			const processMember = sameTurn && processWindowReady && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind) && routedNode.anchorSeq >= processSpec.processStartSeq && routedNode.anchorSeq < processSpec.answerAnchorSeq;
			const processAnswer = sameTurn && processWindowReady && routedNode.kind === "assistant-step" && routedNode.data.step === processSpec.answerStep;
			const ownsDisclosure = routedNode?.kind === "turn-process" || processAnswer;
			const foldable = processWindowReady && (processMember || ownsDisclosure && ((processLayout?.hasExternalProcess ?? false) || processSpec.inlineReasoning));
			const turnProcess = (0, react.useMemo)(() => processGeneration === void 0 || processSpec === void 0 ? void 0 : {
				spec: processSpec,
				foldable,
				open: processOpen,
				setOpen
			}, [
				foldable,
				processGeneration,
				processOpen,
				processSpec,
				setOpen
			]);
			const controllerInactive = routedNode?.kind === "turn-process" && !foldable;
			const compactAnswer = processAnswer && foldable && processLayout?.compactAnswer === true && !processOpen;
			const processHidden = controllerInactive || foldable && processMember && !processOpen;
			const wrapperRef = useSearchableHidden(processHidden, (0, react.useCallback)(() => {
				if (processMember) setOpen(true);
			}, [processMember, setOpen]));
			const owner = (0, react.useMemo)(() => node === void 0 ? null : {
				selectedCallId,
				cwd,
				openFile,
				inspectCall,
				forkAt,
				renderMessageImages,
				fileMentions,
				turnProcess
			}, [
				node,
				selectedCallId,
				cwd,
				openFile,
				inspectCall,
				forkAt,
				renderMessageImages,
				fileMentions,
				turnProcess
			]);
			if (routedNode === void 0 || owner === null) return null;
			const location = routedNode.location;
			const turn = location.kind === "turn" || location.kind === "step" ? location.turn.turn : void 0;
			const routedOwner = {
				...owner,
				node: routedNode
			};
			return (0, react_jsx_runtime.jsx)("div", {
				ref: wrapperRef,
				className: ChatView_module_css_default.flowItem,
				"data-chat-anchor-key": routedNode.key,
				"data-chat-flow-key": routedNode.key,
				"data-chat-flow-kind": routedNode.kind,
				"data-chat-turn": turn,
				"data-turn-process-member": processMember || void 0,
				"data-turn-process-hidden": processHidden || void 0,
				"data-turn-process-answer": compactAnswer || void 0,
				children: renderSlot("conversation.chat.node", routedOwner, {
					entryKey: routedNode.kind,
					hookContext: nodeKey,
					fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
						label: t("message.unknownSurface", { type: routedNode.kind }),
						payload: routedNode.data,
						truncatedLabel: (total) => t("json.truncated", { total })
					})
				})
			});
		});
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/TurnNavigator.module.css.mjs
		const css$10 = ".iNRYAW_slot{z-index:6;pointer-events:none;height:0;position:sticky;top:0}.iNRYAW_rail{--turn-rail-band:calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px));--turn-preview-height:100px;top:calc(var(--turn-rail-band) / 2);right:calc(12px - (var(--dsh-composer-side-clearance) + 16px));width:28px;height:min(var(--turn-natural-height), max(0px, calc(var(--turn-rail-band) - 64px)), 420px);cursor:pointer;pointer-events:auto;transition:height .22s cubic-bezier(.2,.8,.2,1);position:absolute;transform:translateY(-50%)}.iNRYAW_marks{inset:var(--turn-rail-inset) 0;position:absolute}.iNRYAW_markPosition{top:min(var(--turn-natural-position), var(--turn-position));height:10px;transition:top .22s cubic-bezier(.2,.8,.2,1);animation:.15s ease-out iNRYAW_dsh-turn-mark-enter;position:absolute;left:0;right:0;transform:translateY(-50%)}.iNRYAW_mark{cursor:pointer;pointer-events:none;background:0 0;border:0;border-radius:8px;width:20px;padding:0;position:absolute;inset:0 0 0 auto}.iNRYAW_mark:before{background:var(--dsw-alias-border-l4);content:\"\";border-radius:2px;width:12px;height:2px;transition:width .14s,background-color .14s;position:absolute;top:50%;right:0;transform:translateY(-50%)}.iNRYAW_markPreview:before{background:var(--dsw-alias-label-tertiary);width:18px}.iNRYAW_markActive:before{background:var(--dsw-alias-label-primary);width:20px}.iNRYAW_mark:focus-visible:before{background:var(--dsw-alias-state-business-primary);width:20px}.iNRYAW_mark:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.iNRYAW_preview{top:clamp(0px, calc(min(var(--turn-natural-position), var(--turn-position)) + var(--turn-rail-inset) - var(--turn-preview-height) / 2), calc(100% - var(--turn-preview-height)));box-sizing:border-box;width:min(300px,100cqw - 120px);max-height:var(--turn-preview-height);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2);pointer-events:none;border-radius:10px;padding:10px 12px;transition:top .14s cubic-bezier(.2,.8,.2,1);animation:.12s ease-out iNRYAW_dsh-turn-preview-enter;position:absolute;right:calc(100% + 10px);overflow:hidden}.iNRYAW_previewPrompt,.iNRYAW_previewResponse{-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}.iNRYAW_previewPrompt{font:var(--dsw-font-xs-strong-13);-webkit-line-clamp:2}.iNRYAW_previewResponse{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);-webkit-line-clamp:2;margin-top:4px}@keyframes iNRYAW_dsh-turn-mark-enter{0%{opacity:0}to{opacity:1}}@keyframes iNRYAW_dsh-turn-preview-enter{0%{opacity:0;transform:translate(4px)}to{opacity:1;transform:translate(0)}}@container (width<=900px){.iNRYAW_slot{display:none}}@media (prefers-reduced-motion:reduce){.iNRYAW_rail,.iNRYAW_markPosition,.iNRYAW_mark:before,.iNRYAW_preview{transition:none;animation:none}}";
		const tagId$10 = "@deepseek-ai/dsh-client-ui-chat/TurnNavigator.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$10) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$10;
			tag.textContent = css$10;
			document.head.appendChild(tag);
		}
		var TurnNavigator_module_css_default = {
			"dsh-turn-mark-enter": "iNRYAW_dsh-turn-mark-enter",
			"dsh-turn-preview-enter": "iNRYAW_dsh-turn-preview-enter",
			"mark": "iNRYAW_mark",
			"markActive": "iNRYAW_markActive",
			"markPosition": "iNRYAW_markPosition",
			"markPreview": "iNRYAW_markPreview",
			"marks": "iNRYAW_marks",
			"preview": "iNRYAW_preview",
			"previewPrompt": "iNRYAW_previewPrompt",
			"previewResponse": "iNRYAW_previewResponse",
			"rail": "iNRYAW_rail",
			"slot": "iNRYAW_slot"
		};
		//#endregion
		//#region lib/types/client/chat/TurnNavigator.js
		/** Resting gap between neighbouring marks before the rail compresses to fit. */
		const TURN_SPACING_PX = 10;
		/** Rail padding above the first mark and below the last one, per end. */
		const RAIL_INSET_PX = 6;
		function itemPosition(index, count) {
			const ratio = count <= 1 ? 0 : index / (count - 1);
			return {
				"--turn-natural-position": `${String(index * TURN_SPACING_PX)}px`,
				"--turn-position": `${String(ratio * 100)}%`
			};
		}
		function railSize(count) {
			return {
				"--turn-natural-height": `${String((count - 1) * TURN_SPACING_PX + 2 * RAIL_INSET_PX)}px`,
				"--turn-rail-inset": `${String(RAIL_INSET_PX)}px`
			};
		}
		function itemAtPointer(items, rail, clientY) {
			const rect = rail.getBoundingClientRect();
			const usableHeight = Math.max(1, rect.height - 2 * RAIL_INSET_PX);
			const ratio = Math.max(0, Math.min(1, (clientY - rect.top - RAIL_INSET_PX) / usableHeight));
			return items[Math.round(ratio * (items.length - 1))];
		}
		function TurnNavigatorRail({ items, activeTurn, onNavigate, t }) {
			const [previewTurn, setPreviewTurn] = (0, react.useState)(null);
			const previewId = (0, react.useId)();
			if (items.length < 2) return null;
			const previewIndex = items.findIndex((item) => item.turn === previewTurn);
			const preview = previewIndex < 0 ? void 0 : items[previewIndex];
			const previewPosition = previewIndex < 0 ? void 0 : itemPosition(previewIndex, items.length);
			const previewAtPointer = (event) => {
				setPreviewTurn(itemAtPointer(items, event.currentTarget, event.clientY)?.turn ?? null);
			};
			const navigateAtPointer = (event) => {
				const item = itemAtPointer(items, event.currentTarget, event.clientY);
				if (item !== void 0) onNavigate(item);
			};
			return (0, react_jsx_runtime.jsx)("div", {
				className: TurnNavigator_module_css_default.slot,
				children: (0, react_jsx_runtime.jsxs)("nav", {
					className: TurnNavigator_module_css_default.rail,
					style: railSize(items.length),
					"aria-label": t("chat.turnNavigation.label"),
					onClick: navigateAtPointer,
					onPointerMove: previewAtPointer,
					onPointerLeave: () => {
						setPreviewTurn(null);
					},
					children: [(0, react_jsx_runtime.jsx)("div", {
						className: TurnNavigator_module_css_default.marks,
						children: items.map((item, index) => {
							const active = item.turn === activeTurn;
							const showingPreview = item.turn === previewTurn;
							const markClass = active ? `${TurnNavigator_module_css_default.mark} ${TurnNavigator_module_css_default.markActive}` : showingPreview ? `${TurnNavigator_module_css_default.mark} ${TurnNavigator_module_css_default.markPreview}` : TurnNavigator_module_css_default.mark;
							return (0, react_jsx_runtime.jsx)("div", {
								className: TurnNavigator_module_css_default.markPosition,
								style: itemPosition(index, items.length),
								children: (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: markClass,
									"aria-label": t("chat.turnNavigation.jump", { turn: item.turn }),
									"aria-current": active ? "true" : void 0,
									"aria-describedby": showingPreview ? previewId : void 0,
									onClick: (event) => {
										event.stopPropagation();
										onNavigate(item);
									},
									onFocus: () => {
										setPreviewTurn(item.turn);
									},
									onBlur: () => {
										setPreviewTurn(null);
									}
								})
							}, item.turn);
						})
					}), preview !== void 0 && previewPosition !== void 0 && (0, react_jsx_runtime.jsxs)("div", {
						id: previewId,
						role: "tooltip",
						className: TurnNavigator_module_css_default.preview,
						style: previewPosition,
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: TurnNavigator_module_css_default.previewPrompt,
							children: preview.prompt || t("chat.turnNavigation.turn", { turn: preview.turn })
						}), preview.response !== "" && (0, react_jsx_runtime.jsx)("div", {
							className: TurnNavigator_module_css_default.previewResponse,
							children: preview.response
						})]
					})]
				})
			});
		}
		/**
		* Compact rail of the currently loaded Turns with hover and focus previews.
		*
		* Memoized because it renders two host elements per loaded Turn while the
		* enclosing view re-renders on every streaming delta: without the guard a long
		* session rebuilds hundreds of marks per commit for a rail that only changes
		* when a Turn is added, removed, or becomes active. Its props must therefore
		* stay referentially stable across those commits.
		*/
		const TurnNavigator = (0, react.memo)(TurnNavigatorRail);
		//#endregion
		//#region lib/types/client/chat/ChatView.js
		/** Active column host when present; otherwise the view-local scroller. */
		function scrollerOf(from) {
			return from.closest("[data-conversation-scroll]") ?? from;
		}
		/** Find an already-rendered row without interpolating a selector. */
		function anchorElement(list, key) {
			for (const row of list.querySelectorAll("[data-chat-anchor-key]:not([hidden])")) if (row.dataset.chatAnchorKey === key) return row;
			return null;
		}
		/**
		* Turn owning the row at a scrollport line. Scroll frames are hot, so this
		* hit-tests the line first and falls back to one row scan when layout cannot
		* answer (jsdom, pre-paint); neither path queries per navigation item.
		* @param list - the ChatView list element.
		* @param line - viewport y of the reading line.
		* @returns the Turn number, or null when no loaded row covers the line.
		*/
		function turnAtLine(list, line) {
			const content = list.getBoundingClientRect();
			if (typeof document.elementsFromPoint === "function" && content.width > 0) for (const element of document.elementsFromPoint(content.left + content.width / 2, line)) {
				const row = element instanceof HTMLElement ? element.closest("[data-chat-turn]") : null;
				const turn = Number(row?.dataset.chatTurn);
				if (row !== null && list.contains(row) && Number.isSafeInteger(turn)) return turn;
			}
			let found = null;
			for (const row of list.querySelectorAll("[data-chat-turn]")) {
				if (row.getBoundingClientRect().top > line) break;
				const turn = Number(row.dataset.chatTurn);
				if (Number.isSafeInteger(turn)) found = turn;
			}
			return found;
		}
		/** Row position in scrollport coordinates (viewport-independent). */
		function flowTop(row, scrollport) {
			return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
		}
		/** Select a visible stable node/call identity, falling back only when layout
		* has not exposed a visible box yet. */
		function pagingAnchor(list, scrollport) {
			const viewport = scrollport.getBoundingClientRect();
			const visibleBottom = scrollport.querySelector("[data-composer-seat]")?.getBoundingClientRect().top ?? viewport.bottom;
			if (typeof document.elementsFromPoint === "function" && visibleBottom > viewport.top) {
				const content = list.getBoundingClientRect();
				const left = Math.max(viewport.left, content.left);
				const right = Math.min(viewport.right, content.right);
				const x = left + Math.max(0, right - left) / 2;
				for (const element of document.elementsFromPoint(x, viewport.top + 1)) {
					const row = element instanceof HTMLElement ? element.closest("[data-chat-anchor-key]") : null;
					if (row !== null && list.contains(row)) return row;
				}
			}
			const rows = list.querySelectorAll("[data-chat-flow] > [data-chat-flow-key]:not(:empty):not([hidden])");
			let low = 0;
			let high = rows.length;
			while (low < high) {
				const middle = low + high >>> 1;
				if (rows.item(middle).getBoundingClientRect().bottom > viewport.top) high = middle;
				else low = middle + 1;
			}
			const row = rows[low];
			return row !== void 0 && row.getBoundingClientRect().top < visibleBottom ? row : rows[0] ?? null;
		}
		/** Capture a reflow-resistant reader position from the current rendered window. */
		function scrollPosition(list, scrollport) {
			const row = pagingAnchor(list, scrollport);
			const anchorKey = row?.dataset.chatAnchorKey;
			if (row === null || anchorKey === void 0) return null;
			return {
				anchorKey,
				anchorTop: flowTop(row, scrollport),
				scrollTop: scrollport.scrollTop
			};
		}
		/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
		function openFailureMessage(error, fallback) {
			const message = error instanceof Error ? error.message : String(error);
			return message === "" ? fallback : message;
		}
		/** ProducedFiles opens the session workspace as `.`. */
		function isFolderOpenPath(path) {
			return path === ".";
		}
		/**
		* Prompt-RPC identities already rendered by durable material: user/steering
		* node sources plus queue occurrences. A submission echo whose identity
		* appears here is hidden in the same render, so the echo→durable swap is
		* atomic — no duplicate, no gap — regardless of when the echo leaves the
		* session snapshot.
		*/
		function observedRpcIds(order, nodes, queue) {
			const observed = /* @__PURE__ */ new Set();
			for (const key of order) {
				const node = nodes.get(key);
				if (node === void 0 || node.kind !== "user" && node.kind !== "steering") continue;
				const source = node.data.source;
				if (source?.kind === "user" && typeof source.rpcId === "string") observed.add(source.rpcId);
			}
			for (const item of queue) if (item.rpcId !== void 0) observed.add(item.rpcId);
			return observed;
		}
		function runningTurnStartTime(timeline) {
			let latest = null;
			for (const turn of timeline.turns.values()) if (turn.status === "open") latest = turn.start?.time ?? null;
			return latest;
		}
		/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
		function TurnStatus({ startTime, t }) {
			const [mountedAt] = (0, react.useState)(() => Date.now());
			const anchor = startTime ?? mountedAt;
			const [elapsedMs, setElapsedMs] = (0, react.useState)(() => Math.max(0, Date.now() - anchor));
			(0, react.useEffect)(() => {
				const tick = () => {
					setElapsedMs(Math.max(0, Date.now() - anchor));
				};
				tick();
				const id = setInterval(tick, 1e3);
				return () => {
					clearInterval(id);
				};
			}, [anchor]);
			const showClock = elapsedMs >= 15e3;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ChatView_module_css_default.turnStatus,
				role: "status",
				"aria-live": "polite",
				children: [t("chat.deepDiving"), showClock && (0, react_jsx_runtime.jsx)("span", {
					className: ChatView_module_css_default.turnStatusClock,
					"aria-hidden": true,
					children: formatRunDuration(elapsedMs, t)
				})]
			});
		}
		/**
		* The chat view slot entry: pure component over the composed props; each
		* ordered business Node crosses the keyed renderer seat.
		*/
		function ChatView({ useSession, useChat, useSessions, useStore, actions, renderSlot, sessionId, openFile, loadOlder, loadImage, openView, chatScroll, forkAt, fileMentions, useTranscriptView, t }) {
			const order = useChat((s) => s.order);
			const nodeStore = useChat((s) => s.nodes);
			const turnNavigationItems = useChat((s) => s.navigation.items());
			const timeline = useChat((s) => s.timeline);
			const inbox = useSession((s) => s.queue);
			const cwd = useSessions((s) => s.byId[sessionId]?.cwd);
			const running = useSession((s) => s.running);
			const openState = useSession((s) => s.openState);
			const openError = useSession((s) => s.openError);
			const hasMore = useSession((s) => s.hasMore);
			const loadingOlder = useSession((s) => s.loadingOlder);
			const selectedCallId = useStore((s) => s.selection?.callId);
			const compactTranscript = useTranscriptView((mode) => mode === "compact");
			const inspectCall = (0, react.useCallback)((callId) => {
				openView("trajectory", callId);
			}, [openView]);
			const [fileOpenError, setFileOpenError] = (0, react.useState)(null);
			const [fileOpenBusy, setFileOpenBusy] = (0, react.useState)(false);
			const fileOpenRequest = (0, react.useRef)(0);
			const requestOpenFile = (0, react.useCallback)((path) => {
				const id = ++fileOpenRequest.current;
				setFileOpenBusy(true);
				openFile(path).then(() => {
					if (id !== fileOpenRequest.current) return;
					setFileOpenError(null);
					setFileOpenBusy(false);
				}, (error) => {
					if (id !== fileOpenRequest.current) return;
					setFileOpenError({
						path,
						message: openFailureMessage(error, t(isFolderOpenPath(path) ? "fileOpen.folderUnknown" : "fileOpen.unknown"))
					});
					setFileOpenBusy(false);
				});
			}, [openFile, t]);
			const closeFileOpenError = (0, react.useCallback)(() => {
				fileOpenRequest.current += 1;
				setFileOpenError(null);
				setFileOpenBusy(false);
			}, []);
			const pendingSteering = (0, react.useMemo)(() => inbox.filter((item) => item.placement === "steering"), [inbox]);
			const pendingSubmissions = useSession((s) => s.pendingSubmissions);
			const visibleSubmissions = (0, react.useMemo)(() => {
				if (pendingSubmissions.length === 0) return pendingSubmissions;
				const observed = observedRpcIds(order, nodeStore, inbox);
				return pendingSubmissions.filter((submission) => !observed.has(submission.requestId));
			}, [
				pendingSubmissions,
				order,
				nodeStore,
				inbox
			]);
			const renderMessageImages = (0, react.useCallback)((owner) => renderSlot("conversation.message.images", {
				...owner,
				loadImage
			}), [loadImage, renderSlot]);
			const runningTurnStart = (0, react.useMemo)(() => runningTurnStartTime(timeline), [timeline]);
			const listRef = (0, react.useRef)(null);
			const columnRef = (0, react.useRef)(null);
			const [atBottom, setAtBottom] = (0, react.useState)(() => chatScroll.read() === null);
			const atBottomRef = (0, react.useRef)(atBottom);
			const [activeTurn, setActiveTurn] = (0, react.useState)(() => turnNavigationItems.at(-1)?.turn ?? null);
			/** Last position delivered or written on the main thread. */
			const observedTopRef = (0, react.useRef)(0);
			/** Paging anchor: semantic row/position at click, updated by reader scrolls
			* while the request is pending and restored after the prepend lands. */
			const anchorRef = (0, react.useRef)(null);
			const firstSeqRef = (0, react.useRef)(null);
			const openedRef = (0, react.useRef)(false);
			const lastKeyRef = (0, react.useRef)(null);
			const lastSteeringIdRef = (0, react.useRef)(null);
			const lastSubmissionIdRef = (0, react.useRef)(null);
			/** Flow tip signature — follow-scroll only when this moves, never on a
			*  scroll-driven at-bottom chrome re-render (which would snap inertial
			*  scrolls the rest of the way to the floor). */
			const followSigRef = (0, react.useRef)(null);
			const firstKey = order[0];
			const firstSeq = firstKey === void 0 ? null : nodeStore.get(firstKey)?.anchorSeq ?? null;
			const lastKey = order.at(-1) ?? null;
			const lastNode = lastKey === null ? void 0 : nodeStore.get(lastKey);
			const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null;
			const lastSubmissionId = visibleSubmissions[visibleSubmissions.length - 1]?.requestId ?? null;
			const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ""}:${lastSubmissionId ?? ""}`;
			const syncActiveTurn = (0, react.useCallback)(() => {
				const local = listRef.current;
				const first = turnNavigationItems[0];
				if (local === null || first === void 0) {
					setActiveTurn(null);
					return;
				}
				const el = scrollerOf(local);
				const reading = turnAtLine(local, el.getBoundingClientRect().top + Math.min(96, el.clientHeight * .2));
				let next = first.turn;
				if (reading !== null) for (const item of turnNavigationItems) {
					if (item.turn > reading) break;
					next = item.turn;
				}
				if (el.scrollHeight - el.scrollTop - el.clientHeight <= 25) next = turnNavigationItems.at(-1)?.turn ?? next;
				setActiveTurn((current) => current === next ? current : next);
			}, [turnNavigationItems]);
			const activeTurnRef = (0, react.useRef)(null);
			const activeFrameRef = (0, react.useRef)(null);
			const scheduleActiveTurn = (0, react.useCallback)(() => {
				if (activeFrameRef.current !== null) return;
				if (typeof requestAnimationFrame === "undefined") {
					syncActiveTurn();
					return;
				}
				activeFrameRef.current = requestAnimationFrame(() => {
					activeFrameRef.current = null;
					syncActiveTurn();
				});
			}, [syncActiveTurn]);
			(0, react.useEffect)(() => () => {
				if (activeFrameRef.current !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(activeFrameRef.current);
			}, []);
			activeTurnRef.current = scheduleActiveTurn;
			(0, react.useLayoutEffect)(() => {
				scheduleActiveTurn();
			}, [scheduleActiveTurn]);
			const toBottom = (el) => {
				anchorRef.current = null;
				el.scrollTop = el.scrollHeight;
				observedTopRef.current = el.scrollTop;
				atBottomRef.current = true;
				setAtBottom(true);
				chatScroll.save(null);
				setActiveTurn(turnNavigationItems.at(-1)?.turn ?? null);
			};
			(0, react.useLayoutEffect)(() => {
				const local = listRef.current;
				/* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
				if (local === null) return;
				const el = scrollerOf(local);
				if (openState === "open" && !openedRef.current) {
					openedRef.current = true;
					const saved = chatScroll.read();
					if (saved === null) toBottom(el);
					else {
						el.scrollTop = saved.scrollTop;
						const row = anchorElement(local, saved.anchorKey);
						if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop;
						observedTopRef.current = el.scrollTop;
						const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 25;
						atBottomRef.current = isAtBottom;
						setAtBottom(isAtBottom);
						const normalized = isAtBottom ? null : scrollPosition(local, el);
						if (isAtBottom) chatScroll.save(null);
						else if (normalized !== null) chatScroll.save(normalized);
					}
					firstSeqRef.current = firstSeq;
					lastKeyRef.current = lastKey;
					lastSteeringIdRef.current = lastSteeringId;
					lastSubmissionIdRef.current = lastSubmissionId;
					followSigRef.current = followSig;
					return;
				}
				if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
					const anchor = anchorRef.current;
					anchorRef.current = null;
					const row = anchorElement(local, anchor.key);
					if (row !== null) el.scrollTop += flowTop(row, el) - anchor.top;
					observedTopRef.current = el.scrollTop;
					firstSeqRef.current = firstSeq;
					/* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
					lastKeyRef.current = lastKey;
					lastSteeringIdRef.current = lastSteeringId;
					lastSubmissionIdRef.current = lastSubmissionId;
					followSigRef.current = followSig;
					return;
				}
				firstSeqRef.current = firstSeq;
				const appendedUser = lastKey !== lastKeyRef.current && lastNode?.kind === "user";
				const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current;
				const appendedSubmission = lastSubmissionId !== null && lastSubmissionId !== lastSubmissionIdRef.current;
				const tipMoved = followSigRef.current !== followSig;
				lastKeyRef.current = lastKey;
				lastSteeringIdRef.current = lastSteeringId;
				lastSubmissionIdRef.current = lastSubmissionId;
				followSigRef.current = followSig;
				if (appendedUser || appendedSteering || appendedSubmission || tipMoved && atBottomRef.current) toBottom(el);
			});
			const onScrollRef = (0, react.useRef)(() => {});
			onScrollRef.current = () => {
				const local = listRef.current;
				/* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
				if (local === null) return;
				const el = scrollerOf(local);
				const floor = Math.max(0, el.scrollHeight - el.clientHeight);
				const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > .5;
				const isAtBottom = movedByReader ? floor - el.scrollTop <= 25 : atBottomRef.current;
				if (!movedByReader && isAtBottom) {
					toBottom(el);
					return;
				}
				atBottomRef.current = isAtBottom;
				setAtBottom(isAtBottom);
				const position = isAtBottom ? null : scrollPosition(local, el);
				if (isAtBottom) anchorRef.current = null;
				else if (anchorRef.current !== null && position !== null) anchorRef.current = {
					key: position.anchorKey,
					top: position.anchorTop
				};
				if (isAtBottom) chatScroll.save(null);
				else if (position !== null) chatScroll.save(position);
				observedTopRef.current = el.scrollTop;
				scheduleActiveTurn();
			};
			(0, react.useEffect)(() => {
				const local = listRef.current;
				/* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
				if (local === null) return;
				const el = scrollerOf(local);
				const onScroll = () => {
					onScrollRef.current();
				};
				el.addEventListener("scroll", onScroll, { passive: true });
				return () => {
					el.removeEventListener("scroll", onScroll);
				};
			}, []);
			const followRef = (0, react.useRef)(null);
			followRef.current = () => {
				const local = listRef.current;
				if (local !== null && atBottomRef.current) {
					const el = scrollerOf(local);
					el.scrollTop = el.scrollHeight;
					observedTopRef.current = el.scrollTop;
					chatScroll.save(null);
				}
			};
			(0, react.useEffect)(() => {
				const column = columnRef.current;
				const local = listRef.current;
				if (column === null || local === null || typeof ResizeObserver === "undefined") return;
				const composer = scrollerOf(local).querySelector("[data-composer-seat]");
				const observer = new ResizeObserver(() => {
					followRef.current?.();
					activeTurnRef.current?.();
				});
				observer.observe(column);
				if (composer !== null) observer.observe(composer);
				return () => {
					observer.disconnect();
				};
			}, []);
			(0, react.useEffect)(() => {
				if (!loadingOlder) anchorRef.current = null;
			}, [loadingOlder]);
			const loadOlderAnchored = () => {
				const local = listRef.current;
				/* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
				if (local !== null) {
					const el = scrollerOf(local);
					const row = pagingAnchor(local, el);
					if (row !== null && row.dataset.chatAnchorKey !== void 0) anchorRef.current = {
						key: row.dataset.chatAnchorKey,
						top: flowTop(row, el)
					};
				}
				loadOlder();
			};
			const navigateToTurn = (0, react.useCallback)((item) => {
				const local = listRef.current;
				if (local === null) return;
				const row = anchorElement(local, item.anchorKey);
				if (row === null) return;
				const el = scrollerOf(local);
				el.scrollTop += flowTop(row, el) - 24;
				observedTopRef.current = el.scrollTop;
				const landed = loadingOlder ? pagingAnchor(local, el) : null;
				anchorRef.current = landed === null || landed.dataset.chatAnchorKey === void 0 ? null : {
					key: landed.dataset.chatAnchorKey,
					top: flowTop(landed, el)
				};
				const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 25;
				atBottomRef.current = isAtBottom;
				setAtBottom(isAtBottom);
				setActiveTurn(item.turn);
				const position = isAtBottom ? null : scrollPosition(local, el);
				if (isAtBottom) chatScroll.save(null);
				else if (position !== null) chatScroll.save(position);
			}, [loadingOlder, chatScroll]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ChatView_module_css_default.root,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					ref: listRef,
					className: ChatView_module_css_default.scroll,
					children: [
						(0, react_jsx_runtime.jsx)(TurnNavigator, {
							items: turnNavigationItems,
							activeTurn,
							onNavigate: navigateToTurn,
							t
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							ref: columnRef,
							className: ChatView_module_css_default.column,
							"data-chat-flow": "",
							children: [
								openState === "loading" && (0, react_jsx_runtime.jsx)("div", {
									className: ChatView_module_css_default.hint,
									children: t("chat.loadingHistory")
								}),
								openState === "error" && openError !== null && (0, react_jsx_runtime.jsx)("div", {
									className: ChatView_module_css_default.openError,
									children: t("chat.loadError", {
										message: openError.message,
										code: openError.code
									})
								}),
								hasMore && (0, react_jsx_runtime.jsx)("div", {
									className: ChatView_module_css_default.older,
									children: (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: loadingOlder,
										onClick: loadOlderAnchored,
										children: loadingOlder ? t("loading") : t("chat.loadOlder")
									})
								}),
								order.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
									nodeKey,
									historyIncomplete: hasMore,
									compactTranscript,
									useChat,
									useStore,
									actions,
									selectedCallId,
									cwd,
									openFile: requestOpenFile,
									inspectCall,
									forkAt,
									renderMessageImages,
									fileMentions,
									renderSlot,
									t
								}, nodeKey)),
								running && (0, react_jsx_runtime.jsx)(TurnStatus, {
									startTime: runningTurnStart,
									t
								}),
								pendingSteering.map((item) => (0, react_jsx_runtime.jsx)(PendingSteeringBubble, {
									content: item.content,
									renderMessageImages,
									t
								}, item.id)),
								visibleSubmissions.map((submission) => (0, react_jsx_runtime.jsx)(PendingSubmissionBubble, {
									submission,
									renderMessageImages,
									t
								}, submission.requestId))
							]
						}),
						!atBottom && (0, react_jsx_runtime.jsx)("div", {
							className: ChatView_module_css_default.toBottomSlot,
							children: (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ChatView_module_css_default.toBottom,
								"aria-label": t("chat.toBottom"),
								onClick: () => {
									const local = listRef.current;
									/* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
									if (local !== null) toBottom(scrollerOf(local));
								},
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
							})
						})
					]
				}), fileOpenError !== null && (0, react_jsx_runtime.jsx)(FileOpenErrorDialog, {
					path: fileOpenError.path,
					message: fileOpenError.message,
					busy: fileOpenBusy,
					onClose: closeFileOpenError,
					onRetry: () => {
						requestOpenFile(fileOpenError.path);
					},
					t
				})]
			});
		}
		/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
		function FileOpenErrorDialog({ path, message, busy, onClose, onRetry, t }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose,
				closeLabel: t("close"),
				title: t(isFolderOpenPath(path) ? "fileOpen.folderTitle" : "fileOpen.title"),
				description: message,
				footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					className: ChatView_module_css_default.modalAction,
					onClick: onClose,
					children: t("cancel")
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					className: ChatView_module_css_default.modalAction,
					disabled: busy,
					onClick: onRetry,
					children: t("retry")
				})] })
			});
		}
		//#endregion
		//#region lib/types/client/locale.js
		/** Chat-owned locale namespace and dictionaries. */
		/** Namespace for Chat target, node, statistics, and details copy. */
		const NS = "chat";
		/** Simplified Chinese dictionary and key-set source of truth. */
		const zh = {
			"view.chat": "对话",
			"number.groupSeparator": ",",
			"duration.compactSeconds": "{seconds}秒",
			"duration.compactMinutes": "{minutes}分{seconds}秒",
			"duration.milliseconds": "{milliseconds}毫秒",
			"stats.counts": "{turns} 轮 · {steps} 步",
			"stats.llm": "LLM {duration}",
			"stats.toolCall": "工具调用 {duration}",
			"stats.ttftAverage": "首 token 平均 {duration}",
			"stats.tokensPerSecond": "{throughput} tok/s",
			"stats.cacheHit": "缓存命中 {percent}%",
			"stats.tokens": "输入 {input} tok · 输出 {output} tok",
			"details.title": "详情",
			"details.close": "关闭详情",
			"details.empty": "点击消息流中的工具行查看详情",
			"details.notInWindow": "该调用不在当前窗口内",
			"details.input": "输入",
			"details.output": "输出",
			"details.running": "运行中…",
			"chat.loadingHistory": "载入历史…",
			"chat.loadError": "历史加载失败：{message}（{code}）",
			"chat.loadOlder": "加载更早",
			"chat.toBottom": "回到底部",
			"chat.deepDiving": "深度求索中...",
			"chat.turnNavigation.label": "轮次导航",
			"chat.turnNavigation.jump": "跳转到第 {turn} 轮",
			"chat.turnNavigation.turn": "第 {turn} 轮",
			"settings.transcript.title": "对话显示",
			"settings.transcript.description": "控制已完成轮次的过程内容",
			"settings.transcript.normal": "Normal",
			"settings.transcript.compact": "Compact",
			"fileOpen.title": "无法打开文件",
			"fileOpen.unknown": "无法打开此文件",
			"fileOpen.folderTitle": "无法打开文件夹",
			"fileOpen.folderUnknown": "无法打开此文件夹",
			"message.extraBlock": "附加内容块",
			"message.systemPrompt": "系统提示词",
			"message.contextInjection": "上下文注入",
			"message.contextRecall": "跨会话召回",
			"message.referenceSummary": "引用会话 · {labels}",
			"message.referenceSeparator": "、",
			"message.context.instructions.loaded": "已载入",
			"message.context.instructions.added": "已新增",
			"message.context.instructions.updated": "已更新",
			"message.context.instructions.removed": "已移除",
			"message.context.catalog.replaced": "替换目录",
			"message.context.catalog.more": "…还有 {count} 条",
			"message.context.snapshot.supersedes": "取代先前的快照",
			"message.context.relay.from": "来自会话 {session}",
			"message.context.recall.counts": "保留 {retained} 条 · 省略 {omitted} 条",
			"message.context.recall.truncated": "已截断",
			"message.compaction": "上下文已压缩",
			"message.compaction.running": "正在压缩…",
			"message.compaction.completed": "已压缩 {items} 条历史记录（约 {tokens} tokens）",
			"message.compaction.expand": "点击查看压缩摘要",
			"message.compaction.unavailable": "压缩摘要不可用",
			"message.compaction.commandTitle": "compact",
			"message.think": "思考",
			"message.unknownSurface": "未知 surface 事件：{type}",
			"message.unknownBlock": "未知内容块",
			"message.turnProcess.toolCalls.one": "{count} 次工具调用",
			"message.turnProcess.toolCalls.other": "{count} 次工具调用",
			"message.turnProcess.messages.one": "{count} 条消息",
			"message.turnProcess.messages.other": "{count} 条消息",
			"message.turnProcess.subagents.one": "{count} 个 subagent",
			"message.turnProcess.subagents.other": "{count} 个 subagent",
			"message.turnProcess.thoughtForAWhile": "已思考",
			"message.turnProcess.separator": " · ",
			"message.stopped": "已停止",
			"message.branch": "在新对话中分支",
			"message.branchUnavailable": "仅可从已完成轮次的最后一条消息分支",
			"message.retry.active": "正在重试模型请求",
			"message.retry.cancelled": "模型请求重试已取消",
			"message.retry.started": "已重试模型请求",
			"message.retry.scheduled": "等待重试模型请求",
			"message.retry.status": "{label}（{retry}/{maximum}） · {seconds}s",
			"message.retry.delay": "重试延迟：",
			"message.retry.failure": "失败原因：",
			"message.failure.auth": "API 密钥无效",
			"message.turnError": "本轮运行失败",
			"message.maxTokens": "已达到输出 token 上限",
			"message.maxTokens.hint": "回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。",
			"message.ranFor": "用时 {duration}",
			"message.ttft": "首 token {seconds}秒",
			"message.tokensPerSecond": "{tps} tok/s",
			"message.turnUsage.title": "本轮用量",
			"message.turnUsage.summaryWithCache": "{total} · 缓存命中率 {percent}%",
			"message.turnUsage.model": "提供方 / 模型",
			"message.turnUsage.input": "未缓存输入",
			"message.turnUsage.cacheRead": "缓存读取",
			"message.turnUsage.cacheWrite": "缓存写入",
			"message.turnUsage.output": "输出",
			"message.turnUsage.reasoning": "（其中推理 {tokens}）",
			"message.turnUsage.total": "总计",
			"message.turnUsage.count": "{count} tok",
			"duration.seconds": "{seconds}秒",
			"duration.minutes": "{minutes}分{seconds}秒",
			"command.running": "执行中…",
			"command.failed": "指令失败",
			"command.done": "已完成",
			"command.title": "指令",
			"row.running": "运行中",
			"row.failed": "失败",
			"json.truncated": "… 已截断，共 {total} 字符",
			"clock.md": "{m}月{d}日",
			"clock.ymd": "{y}年{m}月{d}日"
		};
		/** English dictionary, checked against the Chinese key set. */
		const en = {
			"view.chat": "Chat",
			"number.groupSeparator": ",",
			"duration.compactSeconds": "{seconds}s",
			"duration.compactMinutes": "{minutes}m{seconds}s",
			"duration.milliseconds": "{milliseconds}ms",
			"stats.counts": "{turns} turns · {steps} steps",
			"stats.llm": "LLM {duration}",
			"stats.toolCall": "Tool call {duration}",
			"stats.ttftAverage": "TTFT avg {duration}",
			"stats.tokensPerSecond": "{throughput} tok/s",
			"stats.cacheHit": "Cache hit {percent}%",
			"stats.tokens": "Input {input} tok · Output {output} tok",
			"details.title": "Details",
			"details.close": "Close details",
			"details.empty": "Click a tool row in the message flow to view its details",
			"details.notInWindow": "This call is outside the current window",
			"details.input": "Input",
			"details.output": "Output",
			"details.running": "Running…",
			"chat.loadingHistory": "Loading history…",
			"chat.loadError": "Failed to load history: {message} ({code})",
			"chat.loadOlder": "Load earlier",
			"chat.toBottom": "Back to bottom",
			"chat.deepDiving": "Deep diving...",
			"chat.turnNavigation.label": "Turn navigation",
			"chat.turnNavigation.jump": "Jump to turn {turn}",
			"chat.turnNavigation.turn": "Turn {turn}",
			"settings.transcript.title": "Conversation display",
			"settings.transcript.description": "Controls process content in completed turns",
			"settings.transcript.normal": "Normal",
			"settings.transcript.compact": "Compact",
			"fileOpen.title": "Couldn’t open file",
			"fileOpen.unknown": "Couldn’t open this file",
			"fileOpen.folderTitle": "Couldn’t open folder",
			"fileOpen.folderUnknown": "Couldn’t open this folder",
			"message.extraBlock": "Extra content block",
			"message.systemPrompt": "System prompt",
			"message.contextInjection": "Context injection",
			"message.contextRecall": "Session recall",
			"message.referenceSummary": "Referenced session · {labels}",
			"message.referenceSeparator": ", ",
			"message.context.instructions.loaded": "loaded",
			"message.context.instructions.added": "added",
			"message.context.instructions.updated": "updated",
			"message.context.instructions.removed": "removed",
			"message.context.catalog.replaced": "Replacement catalog",
			"message.context.catalog.more": "… {count} more",
			"message.context.snapshot.supersedes": "Supersedes earlier snapshots",
			"message.context.relay.from": "From session {session}",
			"message.context.recall.counts": "{retained} kept · {omitted} omitted",
			"message.context.recall.truncated": "truncated",
			"message.compaction": "Context compacted",
			"message.compaction.running": "Compacting context…",
			"message.compaction.completed": "Compacted {items} history items (~{tokens} tokens)",
			"message.compaction.expand": "View compaction summary",
			"message.compaction.unavailable": "Compaction summary unavailable",
			"message.compaction.commandTitle": "compact",
			"message.think": "Think",
			"message.unknownSurface": "Unknown surface event: {type}",
			"message.unknownBlock": "Unknown content block",
			"message.turnProcess.toolCalls.one": "{count} tool call",
			"message.turnProcess.toolCalls.other": "{count} tool calls",
			"message.turnProcess.messages.one": "{count} message",
			"message.turnProcess.messages.other": "{count} messages",
			"message.turnProcess.subagents.one": "{count} subagent",
			"message.turnProcess.subagents.other": "{count} subagents",
			"message.turnProcess.thoughtForAWhile": "Thought for a while",
			"message.turnProcess.separator": " · ",
			"message.stopped": "Stopped",
			"message.branch": "Branch into a new conversation",
			"message.branchUnavailable": "Available only on the last message of a completed turn",
			"message.retry.active": "Retrying model request",
			"message.retry.cancelled": "Model request retry cancelled",
			"message.retry.started": "Retried model request",
			"message.retry.scheduled": "Waiting to retry model request",
			"message.retry.status": "{label} ({retry}/{maximum}) · {seconds}s",
			"message.retry.delay": "Retry delay: ",
			"message.retry.failure": "Failure reason: ",
			"message.failure.auth": "API key is invalid",
			"message.turnError": "This turn failed",
			"message.maxTokens": "Output token limit reached",
			"message.maxTokens.hint": "The reply was cut off; earlier output is preserved in the conversation. Send \"continue\" to let the model resume.",
			"message.ranFor": "Ran for {duration}",
			"message.ttft": "TTFT {seconds}s",
			"message.tokensPerSecond": "{tps} tok/s",
			"message.turnUsage.title": "Turn usage",
			"message.turnUsage.summaryWithCache": "{total} · Cache hit {percent}%",
			"message.turnUsage.model": "Provider / model",
			"message.turnUsage.input": "Uncached input",
			"message.turnUsage.cacheRead": "Cached input",
			"message.turnUsage.cacheWrite": "Cache write",
			"message.turnUsage.output": "Output",
			"message.turnUsage.reasoning": " ({tokens} reasoning)",
			"message.turnUsage.total": "Total",
			"message.turnUsage.count": "{count} tok",
			"duration.seconds": "{seconds}s",
			"duration.minutes": "{minutes}m {seconds}s",
			"command.running": "Running…",
			"command.failed": "Command failed",
			"command.done": "Completed",
			"command.title": "Command",
			"row.running": "Running",
			"row.failed": "Failed",
			"json.truncated": "… truncated, {total} characters total",
			"clock.md": "{m}/{d}",
			"clock.ymd": "{y}-{m}-{d}"
		};
		//#endregion
		//#region lib/types/client/chat/use-throttled-visual-update.js
		/** Frame-throttled scheduling for non-essential visual alignment. */
		const DEFAULT_INTERVAL_FRAMES = 3;
		/**
		* Return a stable scheduler that coalesces visual updates over a frame interval.
		* @param update - DOM alignment to run after the throttle interval.
		* @param intervalFrames - frames to wait before applying the latest alignment.
		* @returns a stable function that schedules the latest update.
		*/
		function useThrottledVisualUpdate(update, intervalFrames = DEFAULT_INTERVAL_FRAMES) {
			const updateRef = (0, react.useRef)(update);
			updateRef.current = update;
			const pendingFrameRef = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => () => {
				if (pendingFrameRef.current === null) return;
				cancelAnimationFrame(pendingFrameRef.current);
				pendingFrameRef.current = null;
			}, []);
			return (0, react.useCallback)(() => {
				if (pendingFrameRef.current !== null) return;
				let remainingFrames = intervalFrames;
				const advance = () => {
					remainingFrames -= 1;
					if (remainingFrames > 0) {
						pendingFrameRef.current = requestAnimationFrame(advance);
						return;
					}
					pendingFrameRef.current = null;
					updateRef.current();
				};
				pendingFrameRef.current = requestAnimationFrame(advance);
			}, [intervalFrames]);
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/accessibility.module.css.mjs
		const css$9 = ".omK04W_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";
		const tagId$9 = "@deepseek-ai/dsh-client-ui-chat/accessibility.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$9) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$9;
			tag.textContent = css$9;
			document.head.appendChild(tag);
		}
		var accessibility_module_css_default = { "visuallyHidden": "omK04W_visuallyHidden" };
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/ReasoningRow.module.css.mjs
		const css$8 = ".Ytdiha_root{flex-direction:column;display:flex}.Ytdiha_row{position:relative;overflow:hidden}.Ytdiha_root[data-state=running] .Ytdiha_row:after{content:\"\";inset-block:0;background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite Ytdiha_dsh-reasoning-row-sweep;position:absolute;left:0}@keyframes Ytdiha_dsh-reasoning-row-sweep{0%{left:-300px}90%,to{left:100%}}.Ytdiha_leading{flex-shrink:0}.Ytdiha_chevron{color:var(--dsw-alias-label-secondary)}.Ytdiha_title{font-weight:400}.Ytdiha_separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.Ytdiha_summary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.Ytdiha_summary[data-follow-end]{text-overflow:clip}.Ytdiha_thinkBody{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:pre-wrap;word-break:break-word}@media (prefers-reduced-motion:reduce){.Ytdiha_root[data-state=running] .Ytdiha_row:after{animation:none}}";
		const tagId$8 = "@deepseek-ai/dsh-client-ui-chat/ReasoningRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$8) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$8;
			tag.textContent = css$8;
			document.head.appendChild(tag);
		}
		var ReasoningRow_module_css_default = {
			"chevron": "Ytdiha_chevron",
			"dsh-reasoning-row-sweep": "Ytdiha_dsh-reasoning-row-sweep",
			"leading": "Ytdiha_leading",
			"root": "Ytdiha_root",
			"row": "Ytdiha_row",
			"separator": "Ytdiha_separator",
			"summary": "Ytdiha_summary",
			"thinkBody": "Ytdiha_thinkBody",
			"title": "Ytdiha_title"
		};
		//#endregion
		//#region lib/types/client/chat/ReasoningRow.js
		/** Assistant reasoning disclosure, independent of Tool-call presentation. */
		function firstLine(text) {
			const newline = text.indexOf("\n");
			return newline === -1 ? text : text.slice(0, newline);
		}
		function latestLine(text) {
			const visible = text.trimEnd();
			const newline = visible.lastIndexOf("\n");
			return newline === -1 ? visible : visible.slice(newline + 1);
		}
		/**
		* Render one assistant reasoning block as the Think disclosure row.
		* @param props.text - complete or streaming reasoning text.
		* @param props.running - whether this block is the streaming tail.
		* @param props.t - conversation locale seat for the running status.
		* @returns the reasoning disclosure.
		*/
		function ReasoningRow({ text, running, t }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const summaryRef = (0, react.useRef)(null);
			const summary = running ? latestLine(text) : firstLine(text);
			const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
				const element = summaryRef.current;
				if (element === null) return;
				element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0;
			});
			(0, react.useEffect)(() => {
				scheduleSummaryScroll();
			}, [
				running,
				scheduleSummaryScroll,
				summary
			]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ReasoningRow_module_css_default.root,
				"data-variant": "think",
				"data-state": running ? "running" : "ok",
				children: [running && (0, react_jsx_runtime.jsx)("span", {
					className: accessibility_module_css_default.visuallyHidden,
					children: t("row.running")
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
					rowClassName: ReasoningRow_module_css_default.row,
					leadingClassName: ReasoningRow_module_css_default.leading,
					titleClassName: ReasoningRow_module_css_default.title,
					chevronClassName: ReasoningRow_module_css_default.chevron,
					icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconThinkOutline14, { size: 14 }),
					title: t("message.think"),
					open: expanded,
					expandable: true,
					expandOnRowClick: true,
					onToggle: () => {
						setExpanded((value) => !value);
					},
					collapsedContent: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
						className: ReasoningRow_module_css_default.separator,
						"aria-hidden": true
					}), (0, react_jsx_runtime.jsx)("span", {
						ref: summaryRef,
						className: ReasoningRow_module_css_default.summary,
						"data-follow-end": running || void 0,
						children: summary
					})] }),
					children: (0, react_jsx_runtime.jsx)("div", {
						className: ReasoningRow_module_css_default.thinkBody,
						children: text
					})
				})]
			});
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/AssistantMarkdown.module.css.mjs
		const css$7 = "._NjbrW_root{font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}._NjbrW_body{flex-direction:column;gap:16px;display:flex}._NjbrW_body .md-table-wide{--dsh-table-spare:max(0px, calc((100cqw - var(--dsh-chat-content-width)) / 2));--dsh-table-lead:calc(var(--dsh-table-spare) + min(var(--dsh-chat-content-width), 100cqw) - 100%);box-sizing:border-box;width:calc(100% + var(--dsh-table-lead) + var(--dsh-table-spare));max-width:none;margin-left:calc(-1 * var(--dsh-table-lead));padding-left:var(--dsh-table-lead)}._NjbrW_body>[data-turn-process-inline][hidden]{margin-bottom:-16px}._NjbrW_stopped{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);border-radius:6px;align-self:flex-start;padding:0 6px;font-size:11px;line-height:18px}._NjbrW_actions{margin-top:16px;margin-left:-6px}";
		const tagId$7 = "@deepseek-ai/dsh-client-ui-chat/AssistantMarkdown.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$7) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$7;
			tag.textContent = css$7;
			document.head.appendChild(tag);
		}
		var AssistantMarkdown_module_css_default = {
			"actions": "_NjbrW_actions",
			"body": "_NjbrW_body",
			"root": "_NjbrW_root",
			"stopped": "_NjbrW_stopped"
		};
		//#endregion
		//#region lib/types/client/chat/AssistantMarkdown.js
		/** Reasoning block as the Think variant summary row (figma 39:28304). */
		const AssistantMarkdown = (0, react.memo)(function AssistantMarkdown({ blocks, streaming, interrupted, renderMessageImages, reasoningHidden = false, revealProcess, mentions, t }) {
			const labels = (0, react.useMemo)(() => markdownLabels(t), [t]);
			const last = blocks.length - 1;
			if (!(streaming || interrupted === true || blocks.some((block) => block.kind !== "tool-call"))) return null;
			const rendered = [];
			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i];
				if (block === void 0) continue;
				switch (block.kind) {
					case "text":
						rendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
							text: block.text,
							streaming,
							labels,
							fileMentions: mentions
						}, i));
						break;
					case "reasoning":
						rendered.push((0, react_jsx_runtime.jsx)(ProcessReasoning, {
							hidden: reasoningHidden,
							reveal: revealProcess,
							children: (0, react_jsx_runtime.jsx)(ReasoningRow, {
								text: block.text,
								running: streaming && i === last,
								t
							})
						}, i));
						break;
					case "image": {
						const start = i;
						const group = [block];
						while (i + 1 < blocks.length) {
							const next = blocks[i + 1];
							if (next === void 0 || next.kind !== "image") break;
							group.push(next);
							i += 1;
						}
						rendered.push((0, react_jsx_runtime.jsx)(react.Fragment, { children: renderMessageImages({
							images: group.map(({ attachment }) => ({ attachment })),
							align: "start"
						}) }, start));
						break;
					}
					case "tool-call": break;
					default: rendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
						label: t("message.unknownBlock"),
						payload: block.block,
						truncatedLabel: (total) => t("json.truncated", { total })
					}, i));
				}
			}
			return (0, react_jsx_runtime.jsx)("div", {
				className: AssistantMarkdown_module_css_default.root,
				"data-streaming": streaming || void 0,
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: AssistantMarkdown_module_css_default.body,
					children: [rendered, interrupted && (0, react_jsx_runtime.jsx)("span", {
						className: AssistantMarkdown_module_css_default.stopped,
						children: t("message.stopped")
					})]
				})
			});
		});
		function ProcessReasoning({ hidden, reveal, children }) {
			return (0, react_jsx_runtime.jsx)("div", {
				ref: useSearchableHidden(hidden, reveal ?? NOOP),
				"data-turn-process-inline": hidden || void 0,
				children
			});
		}
		const NOOP = () => {};
		//#endregion
		//#region lib/types/client/chat/AssistantNodeView.js
		/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
		const AssistantNodeView = (0, react.memo)(function AssistantNodeView({ node, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, t }) {
			const data = node.data;
			const turn = node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : void 0;
			const tail = useTurnData("turn-tail");
			const owner = (0, react.useMemo)(() => {
				if (turn?.status !== "closed" || data.finalNode === void 0) return void 0;
				if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return void 0;
				return {
					turn,
					seq: data.finalNode.seq,
					openFile
				};
			}, [
				data.finalNode,
				openFile,
				tail,
				turn
			]);
			const mentions = (0, react.useMemo)(() => owner === void 0 ? void 0 : fileMentions(owner), [fileMentions, owner]);
			const reasoningHidden = turnProcess !== void 0 && turnProcess.foldable && turnProcess.spec.answerStep === data.step && turnProcess.spec.inlineReasoning && !turnProcess.open;
			const revealProcess = (0, react.useCallback)(() => {
				turnProcess?.setOpen(true);
			}, [turnProcess]);
			return (0, react_jsx_runtime.jsx)(AssistantMarkdown, {
				blocks: data.blocks,
				streaming: data.status === "running",
				interrupted: data.status === "interrupted",
				renderMessageImages,
				reasoningHidden,
				revealProcess,
				mentions,
				t
			});
		});
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/GenericCommandCard.module.css.mjs
		const css$6 = ".lWjFmq_root{flex-direction:column;display:flex}.lWjFmq_row{position:relative;overflow:hidden}.lWjFmq_root[data-state=running] .lWjFmq_row:after{content:\"\";inset-block:0;background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite lWjFmq_dsh-command-row-sweep;position:absolute;left:0}@keyframes lWjFmq_dsh-command-row-sweep{0%{left:-300px}90%,to{left:100%}}.lWjFmq_leading{flex-shrink:0}.lWjFmq_chevron{color:var(--dsw-alias-label-secondary)}.lWjFmq_title{font-weight:400}.lWjFmq_separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.lWjFmq_summary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.lWjFmq_summary[data-error],.lWjFmq_body[data-error]{color:var(--dsw-alias-state-error-primary)}.lWjFmq_body{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);max-height:260px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;border-radius:12px;margin:4px 0 4px 4px;padding:12px 16px;overflow:auto}@media (prefers-reduced-motion:reduce){.lWjFmq_root[data-state=running] .lWjFmq_row:after{animation:none}}";
		const tagId$6 = "@deepseek-ai/dsh-client-ui-chat/GenericCommandCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$6) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$6;
			tag.textContent = css$6;
			document.head.appendChild(tag);
		}
		var GenericCommandCard_module_css_default = {
			"body": "lWjFmq_body",
			"chevron": "lWjFmq_chevron",
			"dsh-command-row-sweep": "lWjFmq_dsh-command-row-sweep",
			"leading": "lWjFmq_leading",
			"root": "lWjFmq_root",
			"row": "lWjFmq_row",
			"separator": "lWjFmq_separator",
			"summary": "lWjFmq_summary",
			"title": "lWjFmq_title"
		};
		//#endregion
		//#region lib/types/client/chat/GenericCommandCard.js
		/** Node state → row state semantic (running while unsettled; outcome kind after). */
		function stateOf(outcome) {
			if (outcome === null) return "running";
			return outcome.kind === "error" ? "error" : "ok";
		}
		function leadingFor(state) {
			return state === "error" ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "error" }) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutline14, { size: 14 });
		}
		function GenericCommandCard({ node, t, runningSummary }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const text = node.outcome?.text;
			const summary = node.outcome === null ? runningSummary ?? t("command.running") : text ?? (node.outcome.kind === "error" ? t("command.failed") : t("command.done"));
			const title = node.name ?? t("command.title");
			const state = stateOf(node.outcome);
			const body = text !== void 0 && text.includes("\n") ? text : null;
			const open = expanded && body !== null;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: GenericCommandCard_module_css_default.root,
				"data-variant": "others",
				"data-state": state,
				children: [
					state === "running" && (0, react_jsx_runtime.jsx)("span", {
						className: accessibility_module_css_default.visuallyHidden,
						children: t("row.running")
					}),
					state === "error" && (0, react_jsx_runtime.jsx)("span", {
						className: accessibility_module_css_default.visuallyHidden,
						children: t("row.failed")
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
						rowClassName: GenericCommandCard_module_css_default.row,
						leadingClassName: GenericCommandCard_module_css_default.leading,
						titleClassName: GenericCommandCard_module_css_default.title,
						chevronClassName: GenericCommandCard_module_css_default.chevron,
						icon: leadingFor(state),
						title,
						open,
						expandable: body !== null,
						expandOnRowClick: true,
						keepContentWhenOpen: true,
						onToggle: () => {
							setExpanded((value) => !value);
						},
						collapsedContent: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
							className: GenericCommandCard_module_css_default.separator,
							"aria-hidden": true
						}), (0, react_jsx_runtime.jsx)("span", {
							className: GenericCommandCard_module_css_default.summary,
							"data-error": state === "error" || void 0,
							children: summary
						})] }),
						children: (0, react_jsx_runtime.jsx)("pre", {
							className: GenericCommandCard_module_css_default.body,
							"data-error": state === "error" || void 0,
							children: body
						})
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/chat/CompactionCommandCard.js
		/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
		function CompactionCommandCard({ node, compaction, t }) {
			if (compaction !== void 0) return (0, react_jsx_runtime.jsx)(CompactionItem, {
				node: compaction,
				title: t("message.compaction.commandTitle"),
				fallbackSummary: node.outcome?.text ?? null,
				t
			});
			if (node.outcome !== null) return (0, react_jsx_runtime.jsx)(GenericCommandCard, {
				node,
				t
			});
			return (0, react_jsx_runtime.jsx)(GenericCommandCard, {
				node,
				t,
				runningSummary: t("message.compaction.running")
			});
		}
		//#endregion
		//#region lib/types/client/chat/CommandNodeView.js
		/** Ordinary command lifecycle renderer with command-name keyed specialization. */
		const CommandNodeView = (0, react.memo)(function CommandNodeView({ node, renderSlot, t }) {
			const command = node.data;
			const owner = (0, react.useMemo)(() => ({ node: command }), [command]);
			return (0, react_jsx_runtime.jsx)("div", {
				className: ChatView_module_css_default.callRow,
				children: renderSlot("conversation.chat.commandview", owner, {
					entryKey: command.name ?? "",
					fallback: (0, react_jsx_runtime.jsx)(GenericCommandCard, {
						...owner,
						t
					})
				})
			});
		});
		/** One integrated `/compact` command and compaction transaction renderer. */
		const ManualCompactionNodeView = (0, react.memo)(function ManualCompactionNodeView({ node, t }) {
			const data = node.data;
			return (0, react_jsx_runtime.jsx)("div", {
				className: ChatView_module_css_default.callRow,
				children: (0, react_jsx_runtime.jsx)(CompactionCommandCard, {
					node: data.command,
					...data.compaction === null ? {} : { compaction: data.compaction },
					t
				})
			});
		});
		//#endregion
		//#region lib/types/client/chat/SystemPromptRow.js
		/**
		* Render one complete system prompt as a collapsed disclosure whose expanded
		* body is the same opaque context chrome: 141px code-block scrollport and
		* model-facing text with its real line breaks.
		* @param props - Complete prompt text and the locale seat.
		* @returns The system-prompt disclosure row.
		*/
		function SystemPromptRow({ text, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
				className: ContextInjectionRow_module_css_default.root,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBrowseOutline16, { size: 14 }),
				chevronClassName: ContextInjectionRow_module_css_default.chevron,
				title: t("message.systemPrompt"),
				open,
				expandable: true,
				expandOnRowClick: true,
				onToggle: () => {
					setOpen((value) => !value);
				},
				children: (0, react_jsx_runtime.jsx)("div", {
					className: ContextInjectionRow_module_css_default.body,
					"data-system-prompt-body": true,
					children: (0, react_jsx_runtime.jsx)(OpaqueBody, {
						content: [{
							type: "text",
							text
						}],
						source: null,
						t
					})
				})
			});
		}
		/** System-prompt keyed Chat renderer. */
		const SystemPromptNodeView = (0, react.memo)(function SystemPromptNodeView({ node, t }) {
			return (0, react_jsx_runtime.jsx)(SystemPromptRow, {
				text: node.data.text,
				t
			});
		});
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/TurnProcessNodeView.module.css.mjs
		const css$5 = ".Ig-oYq_root{box-sizing:border-box;border:none;border-bottom:1px solid var(--dsw-alias-border-l2);width:100%;min-width:0;height:33px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;background:0 0;align-items:center;padding:0 0 8px;display:flex}.Ig-oYq_root:not([data-open]){margin-bottom:8px}.Ig-oYq_chevron{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;margin-left:6px;transition:transform .1s;transform:rotate(-90deg)}.Ig-oYq_root[data-open] .Ig-oYq_chevron{transform:rotate(0)}.Ig-oYq_label{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:24px;overflow:hidden}@media (prefers-reduced-motion:reduce){.Ig-oYq_chevron{transition:none}}";
		const tagId$5 = "@deepseek-ai/dsh-client-ui-chat/TurnProcessNodeView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$5;
			tag.textContent = css$5;
			document.head.appendChild(tag);
		}
		var TurnProcessNodeView_module_css_default = {
			"chevron": "Ig-oYq_chevron",
			"label": "Ig-oYq_label",
			"root": "Ig-oYq_root"
		};
		//#endregion
		//#region lib/types/client/chat/TurnProcessNodeView.js
		/** Turn-level process disclosure controller. */
		const TurnProcessNodeView = (0, react.memo)(function TurnProcessNodeView({ node, turnProcess, t }) {
			if (turnProcess === void 0) throw new Error("turn-process node requires Turn process owner state");
			if (!turnProcess.foldable) return null;
			const open = turnProcess.open;
			const labels = [];
			if (node.data.toolCallCount > 0) labels.push(t(node.data.toolCallCount === 1 ? "message.turnProcess.toolCalls.one" : "message.turnProcess.toolCalls.other", { count: node.data.toolCallCount }));
			if (node.data.messageCount > 0) labels.push(t(node.data.messageCount === 1 ? "message.turnProcess.messages.one" : "message.turnProcess.messages.other", { count: node.data.messageCount }));
			if (node.data.subagentCount > 0) labels.push(t(node.data.subagentCount === 1 ? "message.turnProcess.subagents.one" : "message.turnProcess.subagents.other", { count: node.data.subagentCount }));
			const label = labels.length === 0 ? t("message.turnProcess.thoughtForAWhile") : labels.join(t("message.turnProcess.separator"));
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: TurnProcessNodeView_module_css_default.root,
				"data-open": open || void 0,
				"data-turn-process": node.data.turn,
				"data-turn-process-messages": node.data.messageCount,
				"data-turn-process-tool-calls": node.data.toolCallCount,
				"data-turn-process-subagents": node.data.subagentCount,
				"aria-expanded": open,
				onClick: (event) => {
					event.currentTarget.focus();
					turnProcess.setOpen(!open);
				},
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: TurnProcessNodeView_module_css_default.label,
					children: label
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: TurnProcessNodeView_module_css_default.chevron })]
			});
		});
		//#endregion
		//#region lib/types/client/chat/token-format.js
		/**
		* Compact token count: 517 / 12.2K / 517K / 1.2M.
		* @param value - non-negative token count.
		* @param t - Chat locale seat.
		* @returns locale-owned compact display string.
		*/
		function formatTokens(value, t) {
			const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
			if (value < 1e3) return String(value);
			if (value < 1e6) return t("number.thousand", { value: scaled(value / 1e3) });
			return t("number.million", { value: scaled(value / 1e6) });
		}
		/**
		* Exact integer token count with locale-owned digit grouping.
		* @param value - non-negative safe integer token count.
		* @param t - Chat locale seat.
		* @returns an unrounded display string.
		*/
		function formatExactTokens(value, t) {
			const digits = String(value);
			const groups = [];
			for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
			return groups.join(t("number.groupSeparator"));
		}
		/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
		function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
			const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
			const doubledScale = scale * 2;
			const denominatorQuotient = Math.floor(denominator / doubledScale);
			const denominatorRemainder = denominator % doubledScale;
			let lower = 0;
			let upper = scale;
			while (lower < upper) {
				const candidate = Math.floor((lower + upper + 1) / 2);
				const factor = candidate * 2 - 1;
				if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate;
				else upper = candidate - 1;
			}
			return lower;
		}
		function displayPercentUnits(units, decimalPlaces) {
			if (decimalPlaces === 0) return String(units);
			const whole = Math.floor(units / 10);
			const tenths = units % 10;
			return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
		}
		/**
		* Display-ready cache-hit share without rounding a partial hit to 100%.
		* @param cacheReadTokens - exact prompt tokens served from cache.
		* @param promptTokens - exact aggregate prompt tokens.
		* @param decimalPlaces - ordinary-ratio precision; partial hits that would
		* round to 100 automatically use enough additional precision to stay honest.
		* @returns percentage text, or null when there was no prompt input.
		*/
		function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
			if (promptTokens === 0) return null;
			const missedInputTokens = promptTokens - cacheReadTokens;
			if (missedInputTokens === 0) return "100";
			const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
			if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
			let distinguishingPlaces = 1;
			let scaledDoubleGap = missedInputTokens * 200;
			const denominatorTens = Math.floor(promptTokens / 10);
			while (scaledDoubleGap <= denominatorTens) {
				scaledDoubleGap *= 10;
				distinguishingPlaces += 1;
			}
			const denominatorOnes = promptTokens % 10;
			let roundedLoss = 5;
			for (let loss = 1; loss < 5; loss += 1) {
				const factor = loss * 2 + 1;
				const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
				if (scaledDoubleGap <= threshold) {
					roundedLoss = loss;
					break;
				}
			}
			return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/TurnUsageDisclosure.module.css.mjs
		const css$4 = ".Ic1DoW_root{min-width:0}.Ic1DoW_root[data-open]{padding-bottom:4px}.Ic1DoW_root [data-disclosure-row]:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px;border-radius:6px}.Ic1DoW_chevron{color:var(--dsw-alias-label-secondary)}.Ic1DoW_separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.Ic1DoW_summary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.Ic1DoW_details{box-sizing:border-box;width:calc(100% - 22px - var(--dsh-content-font-delta,0px));margin:4px 0 0 calc(22px + var(--dsh-content-font-delta,0px));background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);border-radius:8px;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;padding:10px 16px 12px 12px;font-size:12px;line-height:18px;display:grid}.Ic1DoW_details dt,.Ic1DoW_details dd{min-width:0;margin:0}.Ic1DoW_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}.Ic1DoW_details .Ic1DoW_route{overflow-wrap:anywhere}.Ic1DoW_reasoning{color:var(--dsw-alias-label-tertiary);white-space:nowrap}.Ic1DoW_totalLabel,.Ic1DoW_details .Ic1DoW_totalValue{border-top:1px solid var(--dsw-alias-separator-primary);color:var(--dsw-alias-label-primary);padding-top:6px}@media (width<=480px){.Ic1DoW_details{gap-inline:10px;grid-template-columns:minmax(72px,auto) minmax(0,1fr)}}";
		const tagId$4 = "@deepseek-ai/dsh-client-ui-chat/TurnUsageDisclosure.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$4;
			tag.textContent = css$4;
			document.head.appendChild(tag);
		}
		var TurnUsageDisclosure_module_css_default = {
			"chevron": "Ic1DoW_chevron",
			"details": "Ic1DoW_details",
			"reasoning": "Ic1DoW_reasoning",
			"root": "Ic1DoW_root",
			"route": "Ic1DoW_route",
			"separator": "Ic1DoW_separator",
			"summary": "Ic1DoW_summary",
			"totalLabel": "Ic1DoW_totalLabel",
			"totalValue": "Ic1DoW_totalValue"
		};
		//#endregion
		//#region lib/types/client/chat/TurnUsageDisclosure.js
		function formatCompactCount(value, t) {
			return t("message.turnUsage.count", { count: formatTokens(value, t) });
		}
		function formatExactCount(value, t) {
			return t("message.turnUsage.count", { count: formatExactTokens(value, t) });
		}
		/** Compact per-Turn usage summary with an opt-in bucket breakdown. */
		function TurnUsageDisclosure({ usage, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const cacheHit = usage.cacheReadTokens === void 0 ? null : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1);
			const total = formatCompactCount(usage.totalTokens, t);
			const summary = cacheHit === null ? total : t("message.turnUsage.summaryWithCache", {
				total,
				percent: cacheHit
			});
			const routes = usage.routes?.map((route) => `${route.provider}/${route.model}`).join(", ") ?? "";
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDataOutline16, {}),
				title: t("message.turnUsage.title"),
				open,
				expandable: true,
				onToggle: () => {
					setOpen((value) => !value);
				},
				expandOnRowClick: true,
				keepContentWhenOpen: true,
				collapsedContent: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
					className: TurnUsageDisclosure_module_css_default.separator,
					"aria-hidden": true
				}), (0, react_jsx_runtime.jsx)("span", {
					className: TurnUsageDisclosure_module_css_default.summary,
					children: summary
				})] }),
				className: TurnUsageDisclosure_module_css_default.root,
				chevronClassName: TurnUsageDisclosure_module_css_default.chevron,
				children: (0, react_jsx_runtime.jsxs)("dl", {
					className: TurnUsageDisclosure_module_css_default.details,
					"data-turn-usage-details": true,
					children: [
						routes !== "" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.model") }), (0, react_jsx_runtime.jsx)("dd", {
							className: TurnUsageDisclosure_module_css_default.route,
							children: routes
						})] }),
						(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.input") }),
						(0, react_jsx_runtime.jsx)("dd", { children: formatExactCount(usage.uncachedInputTokens, t) }),
						usage.cacheReadTokens !== void 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cacheRead") }), (0, react_jsx_runtime.jsx)("dd", { children: formatExactCount(usage.cacheReadTokens, t) })] }),
						usage.cacheWriteTokens !== void 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cacheWrite") }), (0, react_jsx_runtime.jsx)("dd", { children: formatExactCount(usage.cacheWriteTokens, t) })] }),
						(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.output") }),
						(0, react_jsx_runtime.jsxs)("dd", { children: [formatExactCount(usage.outputTokens, t), usage.reasoningTokens !== void 0 && (0, react_jsx_runtime.jsx)("span", {
							className: TurnUsageDisclosure_module_css_default.reasoning,
							children: t("message.turnUsage.reasoning", { tokens: formatExactCount(usage.reasoningTokens, t) })
						})] }),
						(0, react_jsx_runtime.jsx)("dt", {
							className: TurnUsageDisclosure_module_css_default.totalLabel,
							children: t("message.turnUsage.total")
						}),
						(0, react_jsx_runtime.jsx)("dd", {
							className: TurnUsageDisclosure_module_css_default.totalValue,
							children: formatExactCount(usage.totalTokens, t)
						})
					]
				})
			});
		}
		//#endregion
		//#region lib/types/client/chat/turn-assistant.js
		/**
		* Collect visible prose from one Assistant lifecycle.
		* @param blocks - Assistant content blocks.
		* @returns concatenated text blocks.
		*/
		function assistantText(blocks) {
			return blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("");
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/TurnTailNodeView.module.css.mjs
		const css$3 = ".cfCu1G_root{flex-direction:column;gap:16px;display:flex}.cfCu1G_footer{flex-direction:column;gap:4px;min-width:0;display:flex}.cfCu1G_actions{margin-left:-6px}";
		const tagId$3 = "@deepseek-ai/dsh-client-ui-chat/TurnTailNodeView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var TurnTailNodeView_module_css_default = {
			"actions": "cfCu1G_actions",
			"footer": "cfCu1G_footer",
			"root": "cfCu1G_root"
		};
		//#endregion
		//#region lib/types/client/chat/TurnTailNodeView.js
		/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
		const TurnTailNodeView = (0, react.memo)(function TurnTailNodeView({ node, openFile, forkAt, renderSlot, renderSlotChain, t, useChat }) {
			const data = node.data;
			const hasLaterChatNode = useChat((snapshot) => snapshot.locations.getTurn(data.turn).at(-1) !== node.key);
			const turn = node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : void 0;
			if (turn === void 0) return null;
			const closing = data.closing;
			const tail = renderSlotChain("conversation.chat.turnTail", {
				turn,
				seq: closing?.finalNode.seq ?? data.seq,
				openFile
			});
			if (closing === null) return tail === null ? null : (0, react_jsx_runtime.jsx)("div", {
				className: TurnTailNodeView_module_css_default.root,
				children: tail
			});
			const runMs = turn.start === void 0 || turn.end === void 0 ? void 0 : Math.max(0, turn.end.time - turn.start.time);
			const messageId = closing.finalNode.messageId;
			const assistantActions = messageId === void 0 ? null : renderSlot("conversation.chat.assistant-actions", { messageId });
			return (0, react_jsx_runtime.jsxs)("div", {
				className: TurnTailNodeView_module_css_default.root,
				"data-turn-tail": data.turn,
				"data-time-hover-root": true,
				children: [tail, (0, react_jsx_runtime.jsxs)("div", {
					className: TurnTailNodeView_module_css_default.footer,
					children: [data.tokenUsage === void 0 ? null : (0, react_jsx_runtime.jsx)(TurnUsageDisclosure, {
						usage: data.tokenUsage,
						t
					}), (0, react_jsx_runtime.jsx)(MessageIconActions, {
						text: assistantText(closing.blocks),
						time: closing.time,
						runMs,
						ttftMs: data.ttftMs,
						tokensPerSecond: data.tokensPerSecond,
						clock: "end",
						onBranch: () => {
							forkAt(closing.finalNode.seq);
						},
						branchUnavailable: data.branchUnavailable || hasLaterChatNode,
						className: TurnTailNodeView_module_css_default.actions,
						extraActions: assistantActions,
						t
					})]
				})]
			});
		});
		//#endregion
		//#region lib/types/client/chat/register-node-renderers.js
		/**
		* Register this package's business renderers behind the keyed Chat Node seat.
		* @param ctx - owning UI Conversation context.
		*/
		function registerChatNodeRenderers(ctx) {
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "user",
				locale: NS
			}, UserMessageNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "steering",
				locale: NS
			}, UserMessageNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "context",
				locale: NS
			}, ContextMessageNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "system-prompt",
				locale: NS
			}, SystemPromptNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "assistant-step",
				locale: NS
			}, AssistantNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "command",
				locale: NS,
				children: { "conversation.chat.commandview": {
					kind: "keyed",
					scope: "session"
				} }
			}, CommandNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "manual-compaction",
				locale: NS
			}, ManualCompactionNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "compaction",
				locale: NS
			}, CompactionNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "model-retry",
				locale: NS
			}, RetryNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-error",
				locale: NS
			}, TurnErrorNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-max-tokens",
				locale: NS
			}, TurnMaxTokensNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-process",
				locale: NS
			}, TurnProcessNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-tail",
				locale: NS,
				children: {
					"conversation.chat.turnTail": {
						kind: "chain",
						scope: "session"
					},
					"conversation.chat.assistant-actions": {
						kind: "list",
						scope: "session"
					}
				}
			}, TurnTailNodeView));
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "unknown",
				locale: NS
			}, UnknownNodeView));
		}
		//#endregion
		//#region lib/types/client/contract/turn-metrics.js
		function usageOutputTokens(usage) {
			if (typeof usage !== "object" || usage === null) return null;
			const value = usage.outputTokens;
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
		}
		/**
		* Read one assistant node's TTFT, decode wall time, and output tokens.
		* @param node - A settled assistant node.
		* @returns Per-part readings with `null` for unrecorded values.
		*/
		function assistantStepReading(node) {
			const timing = node.timing;
			return {
				ttftMs: timing !== void 0 && timing.stepStartTime !== null && timing.firstTokenTime !== null ? Math.max(0, timing.firstTokenTime - timing.stepStartTime) : null,
				decodeMs: timing !== void 0 && timing.firstTokenTime !== null ? Math.max(0, timing.completedTime - timing.firstTokenTime) : null,
				outputTokens: usageOutputTokens(node.usage)
			};
		}
		/**
		* Fold assistant nodes into per-turn footer metrics.
		*
		* TTFT is the turn's lowest-step request-dispatch-to-first-token reading, so
		* it is only meaningful when the turn's start is inside
		* the loaded window (the caller gates on `turnTimings`, which shares that
		* window). Throughput divides summed output tokens by summed decode wall time,
		* counting only steps that carry both.
		* @param nodes - Snapshot nodes of the loaded window.
		* @returns Turn number → available metrics; turns with none are absent.
		*/
		function deriveTurnMetrics(nodes) {
			const folds = /* @__PURE__ */ new Map();
			for (const node of nodes) {
				if (node.kind !== "assistant") continue;
				const reading = assistantStepReading(node);
				let fold = folds.get(node.turn);
				if (fold === void 0) {
					fold = {
						firstStep: node.step,
						firstStepTtftMs: reading.ttftMs,
						decodeMs: 0,
						outputTokens: 0,
						sampled: false
					};
					folds.set(node.turn, fold);
				} else if (node.step < fold.firstStep) {
					fold.firstStep = node.step;
					fold.firstStepTtftMs = reading.ttftMs;
				}
				if (reading.decodeMs !== null && reading.outputTokens !== null) {
					fold.decodeMs += reading.decodeMs;
					fold.outputTokens += reading.outputTokens;
					fold.sampled = true;
				}
			}
			const metrics = /* @__PURE__ */ new Map();
			for (const [turn, fold] of folds) {
				const entry = {};
				if (fold.firstStepTtftMs !== null) entry.ttftMs = fold.firstStepTtftMs;
				if (fold.sampled && fold.decodeMs > 0) entry.tokensPerSecond = fold.outputTokens / (fold.decodeMs / 1e3);
				if (entry.ttftMs !== void 0 || entry.tokensPerSecond !== void 0) metrics.set(turn, entry);
			}
			return metrics;
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/chat/StatsLine.module.css.mjs
		const css$2 = ".Sl5kGW_root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0 auto;display:block;overflow:hidden}.Sl5kGW_sep{color:var(--dsw-alias-separator-primary);margin:0 10px}";
		const tagId$2 = "@deepseek-ai/dsh-client-ui-chat/StatsLine.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var StatsLine_module_css_default = {
			"root": "Sl5kGW_root",
			"sep": "Sl5kGW_sep"
		};
		//#endregion
		//#region lib/types/client/chat/StatsLine.js
		/**
		* Fold assistant and tool-result nodes into window-scoped display totals —
		* the FALLBACK for assemblies without the `sessionStats` projection.
		*
		* Every displayed figure rides that durable whole-log projection (and token
		* accounting rides `tokenUsage`) because the window is paged and compaction
		* rewrites it; this fold answers "what is on screen" only when no projection
		* value is served. Its field names deliberately mirror the projection's so
		* the two swap wholesale.
		* @param nodes - snapshot nodes.
		* @returns fallback counts and summed wall times.
		*/
		function deriveStats(nodes) {
			const turns = /* @__PURE__ */ new Set();
			let steps = 0;
			let llmMs = 0;
			let toolMs = 0;
			let ttftMs = 0;
			let ttftSteps = 0;
			let decodeMs = 0;
			let decodeTokens = 0;
			for (const node of nodes) {
				if (node.kind === "tool-result") {
					if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime);
					continue;
				}
				if (node.kind !== "assistant") continue;
				turns.add(node.turn);
				steps += 1;
				if (node.timing !== void 0 && node.timing.stepStartTime !== null) llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime);
				const reading = assistantStepReading(node);
				if (reading.ttftMs !== null) {
					ttftMs += reading.ttftMs;
					ttftSteps += 1;
				}
				if (reading.decodeMs !== null && reading.outputTokens !== null) {
					decodeMs += reading.decodeMs;
					decodeTokens += reading.outputTokens;
				}
			}
			return {
				turns: turns.size,
				steps,
				llmMs,
				toolMs,
				ttftMs,
				ttftSteps,
				decodeMs,
				decodeTokens
			};
		}
		/**
		* Compact duration: 45.2s under a minute, 2m42s from there on.
		* @param ms - duration in milliseconds.
		* @returns display string.
		*/
		function formatDuration(ms, t) {
			const s = ms / 1e3;
			if (s < 60) return t("duration.compactSeconds", { seconds: Math.round(s * 10) / 10 });
			const whole = Math.round(s);
			return t("duration.compactMinutes", {
				minutes: Math.floor(whole / 60),
				seconds: whole % 60
			});
		}
		/**
		* Display-ready cache-hit share of prompt-side input over the whole durable log.
		* @param usage - the session's token-usage projection value.
		* @returns integer text when integer rounding stays below 100, otherwise the
		* minimum decimal precision that still rounds below 100; a full hit returns
		* 100, and no billed input returns null.
		*/
		function cacheHitPercent(usage) {
			const denominator = billedInputTokens(usage);
			return formatCacheHitPercent(usage.cacheReadTokens, denominator);
		}
		/**
		* Sum the three disjoint prompt-side billing buckets.
		* @param usage - the session's token-usage projection value.
		* @returns billed input tokens.
		*/
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}
		const StatsLine = (0, react.memo)(function StatsLine({ useChat, useProjection, t }) {
			const settledNodes = useChat((s) => s.legacy.nodes);
			const usage = useProjection("tokenUsage");
			const projected = useProjection("sessionStats");
			const stats = (0, react.useMemo)(() => projected ?? deriveStats(settledNodes), [projected, settledNodes]);
			const groups = [];
			if (stats.steps > 0) {
				groups.push(t("stats.counts", {
					turns: stats.turns,
					steps: stats.steps
				}));
				const durations = [];
				if (stats.llmMs > 0) durations.push(t("stats.llm", { duration: formatDuration(stats.llmMs, t) }));
				if (stats.toolMs > 0) durations.push(t("stats.toolCall", { duration: formatDuration(stats.toolMs, t) }));
				if (durations.length > 0) groups.push(durations.join(" · "));
				const speeds = [];
				if (stats.ttftSteps > 0) speeds.push(t("stats.ttftAverage", { duration: formatDuration(stats.ttftMs / stats.ttftSteps, t) }));
				if (stats.decodeMs > 0) speeds.push(t("stats.tokensPerSecond", { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) }));
				if (speeds.length > 0) groups.push(speeds.join(" · "));
			}
			if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
				const cacheHit = cacheHitPercent(usage);
				if (cacheHit !== null) groups.push(t("stats.cacheHit", { percent: cacheHit }));
				groups.push(t("stats.tokens", {
					input: formatTokens(billedInputTokens(usage), t),
					output: formatTokens(usage.outputTokens, t)
				}));
			}
			const line = groups.join(" | ");
			const rootRef = (0, react.useRef)(null);
			const [truncated, setTruncated] = (0, react.useState)(false);
			(0, react.useLayoutEffect)(() => {
				const el = rootRef.current;
				if (el === null) return;
				const measure = () => {
					setTruncated(el.scrollWidth > el.clientWidth);
				};
				measure();
				if (typeof ResizeObserver === "undefined") return;
				const observer = new ResizeObserver(measure);
				observer.observe(el);
				return () => {
					observer.disconnect();
				};
			}, [line]);
			if (groups.length === 0) return null;
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: line,
				side: "top",
				delayMs: 500,
				disabled: !truncated,
				children: (0, react_jsx_runtime.jsx)("div", {
					ref: rootRef,
					className: StatsLine_module_css_default.root,
					children: groups.map((group, i) => (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [i > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
						className: StatsLine_module_css_default.sep,
						"aria-hidden": true,
						children: "|"
					}), " "] }), (0, react_jsx_runtime.jsx)("span", { children: group })] }, group))
				})
			});
		});
		//#endregion
		//#region ../../core/session/src/surface.ts
		/** Runtime counterpart of the message-producing event union. */
		const SURFACE_EVENT_TYPES = new Set([
			"user/message",
			"assistant/message",
			"tool/result"
		]);
		/**
		* Narrow an event to a surface-eligible event carrying its required marker.
		* @param event - event to test.
		* @returns true when both the type and marker identify a surface event.
		*/
		function isSurfaceEvent(event) {
			if (!SURFACE_EVENT_TYPES.has(event.type)) return false;
			return event.surfaceOp !== void 0;
		}
		/**
		* Narrow an event to an append-origin surface event: one that entered the
		* surface at its own log position and was never itself a replacement copy.
		*
		* The model-visible surface deliberately shadows replaced ranges, so it is the
		* wrong source for a human transcript — a landed replacement would erase
		* conversation the user already saw. Append-origin events are that transcript's
		* durable source material; replacement copies stay model-only.
		* @param event - event to test.
		* @returns true when the event appended to the surface tail.
		*/
		function isAppendSurfaceEvent(event) {
			return isSurfaceEvent(event) && event.surfaceOp === "append";
		}
		/**
		* Narrow an event to a surface replacement: a node that shadowed an existing
		* surface range instead of appending to the tail. The counterpart of
		* {@link isAppendSurfaceEvent} over the two {@link SurfaceOp} variants.
		* @param event - event to test.
		* @returns true when the event replaced a surface range.
		*/
		function isReplacementSurfaceEvent(event) {
			return isSurfaceEvent(event) && event.surfaceOp !== "append";
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/common.js
		/**
		* Relative positions in one durable event's seq neighborhood: interrupted
		* Assistant, its follow-up Nodes, then follow-ups to an ordinary final. The
		* max-tokens notice sits between a closing Assistant and the turn-tail so the
		* tail stays the turn's last node and keeps its branch action enabled.
		*/
		const CHAT_SYNTHETIC_SEQ_OFFSETS = {
			interruptedAssistant: -.9,
			interruptedFollowup: -.8,
			processControl: -.1,
			maxTokensNotice: .05,
			finalizedFollowup: .1
		};
		/**
		* Resolve one Context's best currently loaded event Location.
		* @param context - assembled business Context.
		* @returns start or first-match Location, otherwise unresolved.
		*/
		function contextLocation(context) {
			return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
		}
		/**
		* Build one final Chat target Node with the engine-owned stable key.
		* @param context - assembled business Context.
		* @param kind - Chat renderer dispatch key.
		* @param anchorSeq - sortable render position.
		* @param data - renderer-owned payload.
		* @param options - optional Location and visibility overrides.
		* @returns final Chat view Node.
		*/
		function chatNode(context, kind, anchorSeq, data, options = {}) {
			return {
				key: context.key,
				kind,
				id: context.id,
				target: "chat",
				anchorSeq,
				location: options.location ?? contextLocation(context),
				visibility: options.visibility ?? "visible",
				data
			};
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/event-projection.js
		/** Chat-owned conversion from durable Session events to Chat view data. */
		function asRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
		}
		function readString(record, key) {
			const value = record[key];
			return typeof value === "string" && value.length > 0 ? value : null;
		}
		function collect(source, member, field) {
			const list = source[member];
			if (!Array.isArray(list)) return [];
			const seen = [];
			for (const entry of list) {
				const record = asRecord(entry);
				const value = record === null ? null : readString(record, field);
				if (value !== null && !seen.includes(value)) seen.push(value);
			}
			return seen;
		}
		function joined(names) {
			return names.length > 0 ? names.join(", ") : null;
		}
		/** Forms Chat presents structurally; unknown merge-extensible values remain opaque. */
		const KNOWN_FORMS = [
			"instructions",
			"catalog",
			"snapshot",
			"notice",
			"relay",
			"recall"
		];
		/**
		* Read the target-supported presentation form from a durable message source.
		* @param source - Logged `user/message` source.
		* @returns Supported form, or null for the opaque presentation.
		*/
		function contextForm(source) {
			const record = asRecord(source);
			const form = record === null ? null : readString(record, "form");
			return form !== null && KNOWN_FORMS.includes(form) ? form : null;
		}
		/**
		* Project a durable message source to the Chat row's role and producer label.
		* @param source - Logged `user/message` source.
		* @returns Role and label rendered by Chat.
		*/
		function contextProvenance(source) {
			const record = asRecord(source);
			const kind = record === null ? null : readString(record, "kind");
			if (record === null || kind === null) return {
				role: "inject",
				label: null
			};
			switch (kind) {
				case "session-reference": return {
					role: "recall",
					label: joined(collect(record, "references", "label")) ?? kind
				};
				case "agent-instructions": return {
					role: "inject",
					label: joined(collect(record, "changes", "path")) ?? kind
				};
				case "plugin": return {
					role: "inject",
					label: readString(record, "plugin") ?? kind
				};
				case "skill-invocation": return {
					role: "inject",
					label: readString(record, "name") ?? kind
				};
				default: return {
					role: "inject",
					label: kind
				};
			}
		}
		/**
		* Read distinct labels cited by a durable cross-session recall source.
		* @param source - Logged `user/message` source.
		* @returns Labels in first-seen order.
		*/
		function sessionRecallLabels(source) {
			const record = asRecord(source);
			if (record === null || readString(record, "kind") !== "session-reference") return [];
			return collect(record, "references", "label");
		}
		/**
		* Classify finalized Assistant content for Chat rendering.
		* @param content - Core content blocks.
		* @returns Chat blocks in source order.
		*/
		function toAssistantBlocks(content) {
			return content.map(toAssistantBlock);
		}
		/**
		* Classify one finalized Assistant block for Chat rendering.
		* @param block - Core content block.
		* @returns Chat block.
		*/
		function toAssistantBlock(block) {
			switch (block.type) {
				case "text": return {
					kind: "text",
					text: block.text
				};
				case "reasoning": return {
					kind: "reasoning",
					text: block.text
				};
				case "image": return {
					kind: "image",
					attachment: block.attachment
				};
				case "tool-call": return {
					kind: "tool-call",
					callId: String(block.id),
					name: block.name,
					argsRaw: block.arguments
				};
				default: return {
					kind: "other",
					block
				};
			}
		}
		/**
		* Create the initial Chat block for one streamed Assistant block kind.
		* @param blockType - Wire block kind.
		* @returns Empty block ready to receive deltas.
		*/
		function emptyAssistantBlock(blockType) {
			switch (blockType) {
				case "text": return {
					kind: "text",
					text: ""
				};
				case "reasoning": return {
					kind: "reasoning",
					text: ""
				};
				case "tool-call": return {
					kind: "tool-call",
					callId: "",
					name: "",
					argsRaw: ""
				};
				default: return {
					kind: "other",
					block: null
				};
			}
		}
		/**
		* Convert a durable failure to locale-independent fields safe for Chat.
		* @param failure - Failure preserved by a Session event.
		* @returns Sanitized message and optional stable provider code.
		*/
		function displayFailure(failure) {
			if (failure === null || typeof failure !== "object") return { message: String(failure) };
			const record = failure;
			const code = typeof record.code === "string" ? record.code : void 0;
			if (code === "AUTH") return {
				code,
				message: ""
			};
			return {
				...code === void 0 ? {} : { code },
				message: typeof record.message === "string" ? record.message : JSON.stringify(failure)
			};
		}
		/**
		* Whether a stream chunk carries visible model output for Chat timing.
		* @param chunk - Stream chunk to inspect.
		* @returns true for a non-empty text, reasoning, or Tool-call delta.
		*/
		function isTokenDelta(chunk) {
			switch (chunk.type) {
				case "text-delta":
				case "reasoning-delta": return chunk.text !== "";
				case "tool-call-delta": return chunk.argumentsDelta !== "" || chunk.name !== void 0;
				default: return false;
			}
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/assistant.js
		function isChunkRunEvent$1(event) {
			return event.type === "chunkrow/text-chunks" || event.type === "chunkrow/reasoning-chunks" || event.type === "chunkrow/tool-call-chunks";
		}
		function initialState(turn, step) {
			return {
				turn,
				step,
				blocks: [],
				visibleBlocks: 0,
				firstVisibleSeq: void 0,
				firstVisibleTime: void 0,
				firstTokenTime: void 0,
				hidden: false,
				final: void 0,
				usage: void 0
			};
		}
		function compactBlocks(blocks) {
			return blocks.filter((block) => block !== void 0);
		}
		function blockIsVisible(block) {
			if (block === void 0 || block.kind === "tool-call") return false;
			if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
			return true;
		}
		function countVisibleBlocks(blocks) {
			let count = 0;
			for (const block of blocks) if (blockIsVisible(block)) count++;
			return count;
		}
		function hasVisibleContent(blocks) {
			return blocks.some(blockIsVisible);
		}
		function hasInterruptionEvidence(blocks) {
			return blocks.some((block) => {
				if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
				return true;
			});
		}
		function resetForRetry(state) {
			return {
				...initialState(state.turn, state.step),
				firstTokenTime: state.firstTokenTime,
				hidden: true
			};
		}
		function updateChunk(state, match) {
			if (match.event.type !== "assistant/chunk") return state;
			const chunk = match.event.data.chunk;
			const blocks = [...state.blocks];
			let changedIndex = -1;
			let previousVisible = false;
			switch (chunk.type) {
				case "block-start":
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(blocks[chunk.index]);
					blocks[chunk.index] = emptyAssistantBlock(chunk.blockType);
					break;
				case "text-delta": {
					const previous = blocks[chunk.index];
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(previous);
					blocks[chunk.index] = {
						kind: "text",
						text: (previous?.kind === "text" ? previous.text : "") + chunk.text
					};
					break;
				}
				case "reasoning-delta": {
					const previous = blocks[chunk.index];
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(previous);
					blocks[chunk.index] = {
						kind: "reasoning",
						text: (previous?.kind === "reasoning" ? previous.text : "") + chunk.text
					};
					break;
				}
				case "tool-call-delta": {
					const previous = blocks[chunk.index];
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(previous);
					const base = previous?.kind === "tool-call" ? previous : {
						kind: "tool-call",
						callId: "",
						name: "",
						argsRaw: ""
					};
					blocks[chunk.index] = {
						kind: "tool-call",
						callId: base.callId || String(chunk.id),
						name: chunk.name ?? base.name,
						argsRaw: base.argsRaw + chunk.argumentsDelta
					};
					break;
				}
				case "block-end":
					changedIndex = chunk.index;
					previousVisible = blockIsVisible(blocks[chunk.index]);
					blocks[chunk.index] = toAssistantBlock(chunk.block);
					break;
				case "usage": return {
					...state,
					usage: chunk.usage
				};
				default: return state;
			}
			const visibleBlocks = state.visibleBlocks - Number(previousVisible) + Number(blockIsVisible(blocks[changedIndex]));
			const firstToken = isTokenDelta(chunk);
			return {
				...state,
				blocks,
				visibleBlocks,
				hidden: visibleBlocks > 0 ? false : state.hidden,
				...visibleBlocks > 0 && state.firstVisibleSeq === void 0 ? {
					firstVisibleSeq: match.event.seq,
					firstVisibleTime: match.event.time
				} : {},
				...firstToken && state.firstTokenTime === void 0 ? { firstTokenTime: match.event.time } : {}
			};
		}
		function chunkRunBoundaries(event, needsToken, needsVisible, visibleFromStart) {
			const fragments = event.type === "chunkrow/tool-call-chunks" ? event.data.args : event.data.texts;
			const nameStartsToken = event.type === "chunkrow/tool-call-chunks" && Object.hasOwn(event.data, "name");
			let firstTokenTime;
			let firstVisible;
			let time = event.time;
			for (let index = 0; index < fragments.length; index++) {
				const fragment = fragments[index];
				if (needsToken && firstTokenTime === void 0 && (nameStartsToken || fragment !== "")) firstTokenTime = time;
				if (needsVisible && firstVisible === void 0 && (visibleFromStart || event.type !== "chunkrow/tool-call-chunks" && fragment.trim() !== "")) firstVisible = {
					seq: event.seq + index,
					time
				};
				if ((!needsToken || firstTokenTime !== void 0) && (!needsVisible || firstVisible !== void 0)) break;
				time += event.data.dt[index] ?? 0;
			}
			return {
				firstTokenTime,
				firstVisible
			};
		}
		function updateChunkRun(state, event) {
			const blocks = [...state.blocks];
			const previous = blocks[event.data.index];
			const previousVisible = blockIsVisible(previous);
			let visibleFromStart = state.visibleBlocks - Number(previousVisible) > 0;
			if (event.type === "chunkrow/text-chunks") {
				const text = previous?.kind === "text" ? previous.text : "";
				visibleFromStart ||= text.trim() !== "";
				blocks[event.data.index] = {
					kind: "text",
					text: text + event.data.texts.join("")
				};
			} else if (event.type === "chunkrow/reasoning-chunks") {
				const text = previous?.kind === "reasoning" ? previous.text : "";
				visibleFromStart ||= text.trim() !== "";
				blocks[event.data.index] = {
					kind: "reasoning",
					text: text + event.data.texts.join("")
				};
			} else {
				const base = previous?.kind === "tool-call" ? previous : {
					kind: "tool-call",
					callId: "",
					name: "",
					argsRaw: ""
				};
				blocks[event.data.index] = {
					kind: "tool-call",
					callId: base.callId || String(event.data.id),
					name: Object.hasOwn(event.data, "name") ? event.data.name : base.name,
					argsRaw: base.argsRaw + event.data.args.join("")
				};
			}
			const boundaries = chunkRunBoundaries(event, state.firstTokenTime === void 0, state.firstVisibleSeq === void 0, visibleFromStart);
			const visibleBlocks = state.visibleBlocks - Number(previousVisible) + Number(blockIsVisible(blocks[event.data.index]));
			return {
				...state,
				blocks,
				visibleBlocks,
				hidden: visibleBlocks > 0 ? false : state.hidden,
				...boundaries.firstVisible === void 0 ? {} : {
					firstVisibleSeq: boundaries.firstVisible.seq,
					firstVisibleTime: boundaries.firstVisible.time
				},
				...boundaries.firstTokenTime === void 0 ? {} : { firstTokenTime: boundaries.firstTokenTime }
			};
		}
		function closedBoundary(location) {
			if (location.kind === "step" && location.step.status === "closed" && location.step.end !== void 0) return location.step.end;
			if ((location.kind === "step" || location.kind === "turn") && location.turn.status === "closed" && location.turn.end !== void 0) return location.turn.end;
		}
		function finalNode(state, context) {
			const final = state.final;
			if (final?.event.type === "assistant/message") {
				const event = final.event;
				return {
					kind: "assistant",
					seq: event.seq,
					messageId: event.data.message.id,
					time: event.time,
					turn: state.turn,
					step: state.step,
					blocks: toAssistantBlocks(event.data.message.content),
					usage: event.data.usage,
					timing: {
						stepStartTime: context.start?.event.time ?? null,
						firstTokenTime: state.firstTokenTime ?? null,
						completedTime: event.time
					},
					...event.data.interrupted === true ? { interrupted: true } : {}
				};
			}
			const location = context.start?.location ?? context.matches.at(-1)?.location;
			const boundary = location === void 0 ? void 0 : closedBoundary(location);
			if (boundary === void 0) return void 0;
			const blocks = compactBlocks(state.blocks);
			if (!hasInterruptionEvidence(blocks)) return void 0;
			return {
				kind: "assistant",
				seq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
				time: boundary.time,
				turn: state.turn,
				step: state.step,
				blocks,
				interrupted: true
			};
		}
		function fallbackState$5(context) {
			let state;
			for (const match of context.matches) {
				if (isChunkRunEvent$1(match.event)) {
					state ??= initialState(match.event.data.turn, match.event.data.step);
					state = updateChunkRun(state, match.event);
					continue;
				}
				if (match.event.type === "assistant/chunk") {
					state ??= initialState(match.event.data.turn, match.event.data.step);
					state = updateChunk(state, match);
					continue;
				}
				if (match.event.type === "assistant/message") {
					state ??= initialState(match.event.data.turn, match.event.data.step);
					const blocks = toAssistantBlocks(match.event.data.message.content);
					state = {
						...state,
						blocks,
						visibleBlocks: countVisibleBlocks(blocks),
						hidden: false,
						final: match,
						usage: match.event.data.usage
					};
					continue;
				}
				if (match.event.type === "llm/retry" && state !== void 0) state = resetForRetry(state);
			}
			return state;
		}
		function projectAssistant(context) {
			const state = context.state ?? fallbackState$5(context);
			if (state === void 0) return void 0;
			const settled = finalNode(state, context);
			const blocks = settled?.blocks ?? compactBlocks(state.blocks);
			const visible = settled === void 0 ? state.visibleBlocks > 0 : hasVisibleContent(blocks);
			const status = settled?.interrupted === true ? "interrupted" : settled === void 0 ? "running" : "settled";
			const anchorSeq = settled?.seq ?? state.firstVisibleSeq ?? context.matches[0]?.event.seq ?? 0;
			const time = settled?.time ?? state.firstVisibleTime ?? context.matches[0]?.event.time ?? 0;
			return {
				anchorSeq,
				visible,
				settled,
				data: {
					status,
					turn: state.turn,
					step: state.step,
					blocks,
					time,
					...state.usage === void 0 ? {} : { usage: state.usage },
					...settled === void 0 ? {} : { finalNode: settled }
				}
			};
		}
		/** Per-step Assistant streaming/final/interruption Definition. */
		const assistantDefinition = {
			kind: "assistant-step",
			target: "chat",
			match: (event) => {
				if (event.type === "step/start") return {
					id: `${event.data.turn}:${event.data.step}`,
					role: "start"
				};
				if (event.type === "assistant/chunk" || event.type === "assistant/message" && isAppendSurfaceEvent(event)) return {
					id: `${event.data.turn}:${event.data.step}`,
					role: "update"
				};
				if (isChunkRunEvent$1(event)) return {
					id: `${event.data.turn}:${event.data.step}`,
					role: "update"
				};
				if (event.type === "llm/retry") return {
					id: `${event.data.turn}:${event.data.step}`,
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "step/start") throw new Error("assistant-step start requires step/start");
				return initialState(match.event.data.turn, match.event.data.step);
			},
			update: (context, match) => {
				if (isChunkRunEvent$1(match.event)) return updateChunkRun(context.state, match.event);
				if (match.event.type === "assistant/chunk") return updateChunk(context.state, match);
				if (match.event.type === "assistant/message") {
					const blocks = toAssistantBlocks(match.event.data.message.content);
					return {
						...context.state,
						blocks,
						visibleBlocks: countVisibleBlocks(blocks),
						hidden: false,
						final: match,
						usage: match.event.data.usage
					};
				}
				if (match.event.type === "llm/retry") return resetForRetry(context.state);
				return context.state;
			},
			publication: (match) => {
				if (match.event.type === "step/start") return "none";
				if (isChunkRunEvent$1(match.event)) return "animation-frame";
				if (match.event.type !== "assistant/chunk") return "immediate";
				const type = match.event.data.chunk.type;
				return type === "usage" || type === "finish" ? "none" : "animation-frame";
			},
			buildLocationData: (context, scope) => {
				if (scope !== "step") return null;
				const projected = projectAssistant(context);
				if (projected === void 0) return null;
				return {
					kind: "step",
					turn: projected.data.turn,
					step: projected.data.step,
					key: "assistant-step",
					value: projected.data
				};
			},
			buildViewNode: (context) => {
				const projected = projectAssistant(context);
				if (projected === void 0) return null;
				if (projected.settled === void 0 && !projected.visible) {
					const state = context.state ?? fallbackState$5(context);
					if (state === void 0) return null;
					const current = context.current.get("chat");
					if (!state.hidden || current === void 0 || current === null) return null;
				}
				return chatNode(context, "assistant-step", projected.anchorSeq, projected.data, { visibility: projected.settled?.interrupted === true || projected.visible ? "visible" : "hidden" });
			}
		};
		/**
		* Register the Assistant lifecycle business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerAssistantConversationNode(ctx) {
			ctx.uiConversation.events.register(assistantDefinition);
		}
		//#endregion
		//#region lib/types/client/contract/chat-nodes.js
		/**
		* Test whether a Tool root has settled.
		* @param block - Tool root lifecycle value.
		* @returns whether the root carries its final result.
		*/
		function isSettledTool(block) {
			return "kind" in block;
		}
		/**
		* Test whether a Tool root is still running.
		* @param block - Tool root lifecycle value.
		* @returns whether the root lacks a final result.
		*/
		function isRunningTool(block) {
			return !isSettledTool(block);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-navigation.js
		/**
		* Preview budget per field. The rail clamps two short lines, so anything past
		* this is invisible; copying whole transcripts into navigation state would
		* otherwise grow with the loaded window on every structural update.
		*/
		const PREVIEW_LIMIT = 160;
		/** Join rendered text until the preview budget is met, then stop reading. */
		function preview(parts) {
			let text = "";
			for (const part of parts) {
				text += text === "" ? part : ` ${part}`;
				if (text.length >= PREVIEW_LIMIT) break;
			}
			return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LIMIT);
		}
		function promptText(node) {
			if (node.kind !== "user") return "";
			return preview(node.data.content.flatMap((block) => block.type === "text" ? [block.text] : []));
		}
		function responseText(node) {
			if (node.kind !== "assistant-step") return "";
			return preview(node.data.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []));
		}
		/**
		* Whether two items carry the same rail state, so the reader can keep its array.
		* @param left - previously published item, when the Turn had one.
		* @param right - freshly derived item, when the Turn still has one.
		* @returns whether both sides describe the same mark.
		*/
		function sameTurnNavigationItem(left, right) {
			if (left === void 0 || right === void 0) return left === right;
			return left.turn === right.turn && left.anchorKey === right.anchorKey && left.prompt === right.prompt && left.response === right.response;
		}
		/**
		* Project one loaded Turn into its rail item.
		* @param turn - Turn number the item addresses.
		* @param locations - live Location index supplying the Turn's node keys.
		* @param nodes - live Chat node store.
		* @returns the item, or undefined when the Turn has no visible loaded node.
		*/
		function turnNavigationItem(turn, locations, nodes) {
			const loaded = locations.getTurn(turn).map((key) => nodes.get(key)).filter((node) => node !== void 0 && node.visibility === "visible");
			const user = loaded.find((node) => node.kind === "user");
			const anchor = user ?? loaded[0];
			if (anchor === void 0) return void 0;
			const response = loaded.findLast((node) => responseText(node) !== "");
			return {
				turn,
				anchorKey: anchor.key,
				prompt: user === void 0 ? "" : promptText(user),
				response: response === void 0 ? "" : responseText(response)
			};
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/chat-snapshot-builder.js
		const EMPTY_KEYS = [];
		const EMPTY_TURNS = [];
		const EMPTY_ITEMS = [];
		const EMPTY_LIST = [];
		function sameReferences$1(left, right) {
			return left.length === right.length && left.every((value, index) => value === right[index]);
		}
		var MutableChatNodeStore = class {
			byKey = /* @__PURE__ */ new Map();
			valuesCache = EMPTY_LIST;
			valuesDirty = false;
			get(key) {
				return this.byKey.get(key);
			}
			values() {
				if (this.valuesDirty) {
					this.valuesCache = [...this.byKey.values()];
					this.valuesDirty = false;
				}
				return this.valuesCache;
			}
			replace(nodes) {
				this.byKey.clear();
				for (const node of nodes) this.byKey.set(node.key, node);
				this.valuesCache = [...this.byKey.values()];
				this.valuesDirty = false;
			}
			upsert(nodes) {
				let changed = false;
				for (const node of nodes) {
					if (this.byKey.get(node.key) === node) continue;
					this.byKey.set(node.key, node);
					changed = true;
				}
				if (changed) this.valuesDirty = true;
			}
		};
		var MutableChatLocationIndex = class {
			turns = /* @__PURE__ */ new Map();
			steps = /* @__PURE__ */ new Map();
			getTurn(turn) {
				return this.turns.get(turn) ?? EMPTY_KEYS;
			}
			getStep(turn, step) {
				return this.steps.get(stepKey(turn, step)) ?? EMPTY_KEYS;
			}
			rebuild(order, store) {
				const turns = /* @__PURE__ */ new Map();
				const steps = /* @__PURE__ */ new Map();
				for (const key of order) {
					const location = store.get(key)?.location;
					if (location === void 0) continue;
					const coordinates = locationCoordinates(location);
					if (coordinates.turn === void 0) continue;
					const turnKeys = turns.get(coordinates.turn) ?? [];
					turnKeys.push(key);
					turns.set(coordinates.turn, turnKeys);
					if (coordinates.step === void 0) continue;
					const step = stepKey(coordinates.turn, coordinates.step);
					const stepKeys = steps.get(step) ?? [];
					stepKeys.push(key);
					steps.set(step, stepKeys);
				}
				this.turns = updateIndex(this.turns, turns);
				this.steps = updateIndex(this.steps, steps);
			}
			/** Invalidate aggregate readers when member data changes without moving. */
			touch(nodes) {
				const turns = /* @__PURE__ */ new Set();
				const steps = /* @__PURE__ */ new Set();
				for (const node of nodes) {
					const coordinates = locationCoordinates(node.location);
					if (coordinates.turn === void 0 || !this.turns.get(coordinates.turn)?.includes(node.key)) continue;
					turns.add(coordinates.turn);
					if (coordinates.step !== void 0) steps.add(stepKey(coordinates.turn, coordinates.step));
				}
				for (const turn of turns) {
					const keys = this.turns.get(turn);
					if (keys === void 0) continue;
					this.turns.set(turn, [...keys]);
				}
				for (const step of steps) {
					const keys = this.steps.get(step);
					if (keys === void 0) continue;
					this.steps.set(step, [...keys]);
				}
			}
		};
		function updateIndex(previous, nextMutable) {
			const next = /* @__PURE__ */ new Map();
			const keys = new Set([...previous.keys(), ...nextMutable.keys()]);
			for (const key of keys) {
				const before = previous.get(key) ?? EMPTY_KEYS;
				const candidate = nextMutable.get(key) ?? EMPTY_KEYS;
				const value = sameReferences$1(before, candidate) ? before : candidate;
				if (candidate.length > 0) next.set(key, value);
			}
			return next;
		}
		/**
		* Loaded-Turn rail projection accumulated alongside the node store: a
		* structural change re-derives the Turn set, a content-only upsert re-derives
		* only the Turns whose nodes moved, and the published array keeps its identity
		* until an item actually changes. Renderers therefore consume final Turn data
		* instead of scanning the loaded window per frame.
		*/
		var MutableTurnNavigationIndex = class {
			current = EMPTY_ITEMS;
			byTurn = /* @__PURE__ */ new Map();
			items() {
				return this.current;
			}
			/** Re-derive the whole Turn set; runs only when the loaded structure moves. */
			rebuild(timeline, locations, nodes) {
				const next = [];
				const byTurn = /* @__PURE__ */ new Map();
				for (const turn of timeline.turnOrder) {
					const derived = turnNavigationItem(turn, locations, nodes);
					if (derived === void 0) continue;
					const previous = this.byTurn.get(turn);
					const item = previous !== void 0 && sameTurnNavigationItem(previous, derived) ? previous : derived;
					next.push(item);
					byTurn.set(turn, item);
				}
				this.byTurn = byTurn;
				if (!(next.length === this.current.length && next.every((item, index) => item === this.current[index]))) this.current = next;
			}
			/** Re-derive only the Turns a content-only upsert touched. */
			touch(turns, locations, nodes) {
				if (turns.size === 0) return;
				const next = this.current.map((item) => {
					if (!turns.has(item.turn)) return item;
					const derived = turnNavigationItem(item.turn, locations, nodes);
					if (derived === void 0 || sameTurnNavigationItem(item, derived)) return item;
					this.byTurn.set(item.turn, derived);
					return derived;
				});
				if (next.some((item, index) => item !== this.current[index])) this.current = next;
			}
		};
		function stepKey(turn, step) {
			return `${turn}:${step}`;
		}
		function locationCoordinates(location) {
			if (location.kind === "step") return {
				turn: location.turn.turn,
				step: location.step.step
			};
			if (location.kind === "turn") return { turn: location.turn.turn };
			return {};
		}
		function turnProcessPresentations(nodes) {
			const presentations = /* @__PURE__ */ new Map();
			for (const raw of nodes) {
				const node = raw;
				if (node.kind === "turn-process") presentations.set(node.data.turn, {
					...presentations.get(node.data.turn),
					control: node
				});
			}
			for (const raw of nodes) {
				const node = raw;
				const location = node.location;
				if (location.kind !== "turn" && location.kind !== "step") continue;
				const current = presentations.get(location.turn.turn) ?? {};
				if ((node.kind === "user" || node.kind === "steering") && node.anchorSeq < (current.control?.data.controlAnchorSeq ?? Number.POSITIVE_INFINITY)) {
					presentations.set(location.turn.turn, {
						...current,
						openingHumanAnchor: Math.min(current.openingHumanAnchor ?? node.anchorSeq, node.anchorSeq)
					});
					continue;
				}
				if (TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) continue;
				presentations.set(location.turn.turn, {
					...current,
					earliestProcessAnchor: Math.min(current.earliestProcessAnchor ?? node.anchorSeq, node.anchorSeq)
				});
			}
			return presentations;
		}
		function presentationPosition(raw, presentations) {
			const node = raw;
			const location = node.location;
			if (location.kind !== "turn" && location.kind !== "step") return {
				anchor: node.anchorSeq,
				rank: 0,
				originalAnchor: node.anchorSeq
			};
			const presentation = presentations.get(location.turn.turn);
			if (presentation === void 0) return {
				anchor: node.anchorSeq,
				rank: 0,
				originalAnchor: node.anchorSeq
			};
			const openingHumanAnchor = presentation.openingHumanAnchor;
			if (openingHumanAnchor !== void 0 && node.anchorSeq < openingHumanAnchor && !TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) return {
				anchor: openingHumanAnchor,
				rank: 2,
				originalAnchor: node.anchorSeq
			};
			if (presentation.control !== void 0 && node.key === presentation.control.key) return openingHumanAnchor === void 0 ? {
				anchor: presentation.earliestProcessAnchor ?? node.anchorSeq,
				rank: -1,
				originalAnchor: node.anchorSeq
			} : {
				anchor: openingHumanAnchor,
				rank: 1,
				originalAnchor: node.anchorSeq
			};
			return {
				anchor: node.anchorSeq,
				rank: 0,
				originalAnchor: node.anchorSeq
			};
		}
		/**
		* Order visible Chat Nodes without changing existing relative order as process
		* eligibility changes. Opening human input precedes process candidates, while
		* each synthetic process control sits between them.
		* @param nodes - currently materialized Chat Nodes.
		* @returns visible Nodes in presentation order.
		*/
		function orderedVisibleChatNodes(nodes) {
			const visible = nodes.filter((node) => node.visibility === "visible");
			const presentations = turnProcessPresentations(visible);
			return visible.sort((left, right) => {
				const leftPosition = presentationPosition(left, presentations);
				const rightPosition = presentationPosition(right, presentations);
				return leftPosition.anchor - rightPosition.anchor || leftPosition.rank - rightPosition.rank || leftPosition.originalAnchor - rightPosition.originalAnchor || left.key.localeCompare(right.key);
			});
		}
		function referenceMessageSeq(node) {
			const candidate = node;
			return candidate.kind === "user" || candidate.kind === "steering" ? candidate.data.seq : void 0;
		}
		function followingRecall(node) {
			const candidate = node;
			if (candidate.kind !== "context") return void 0;
			return {
				messageSeq: candidate.data.seq - 1,
				labels: sessionRecallLabels(candidate.data.source)
			};
		}
		function withReferenceLabels(node, labels) {
			const candidate = node;
			if (candidate.kind !== "user" && candidate.kind !== "steering") return node;
			const current = candidate.data.referenceLabels ?? EMPTY_KEYS;
			const hasLabels = Object.hasOwn(candidate.data, "referenceLabels");
			if (sameReferences$1(current, labels) && hasLabels === labels.length > 0) return node;
			const data = { ...candidate.data };
			if (labels.length === 0) delete data.referenceLabels;
			else data.referenceLabels = labels;
			return {
				...candidate,
				data
			};
		}
		/** Associates a direct message with the sourced recall event that immediately follows it. */
		var ReferenceLabelProjector = class {
			messagesBySeq = /* @__PURE__ */ new Map();
			labelsByMessageSeq = /* @__PURE__ */ new Map();
			replace(nodes) {
				this.messagesBySeq.clear();
				this.labelsByMessageSeq.clear();
				for (const node of nodes) {
					const messageSeq = referenceMessageSeq(node);
					if (messageSeq !== void 0) this.messagesBySeq.set(messageSeq, node.key);
					const recall = followingRecall(node);
					if (recall !== void 0 && recall.labels.length > 0) this.labelsByMessageSeq.set(recall.messageSeq, recall.labels);
				}
				return nodes.map((node) => {
					const messageSeq = referenceMessageSeq(node);
					return messageSeq === void 0 ? node : withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS);
				});
			}
			apply(upserts, store) {
				const byKey = new Map(upserts.map((node) => [node.key, node]));
				const affected = /* @__PURE__ */ new Set();
				for (const node of upserts) {
					const messageSeq = referenceMessageSeq(node);
					if (messageSeq !== void 0) {
						this.messagesBySeq.set(messageSeq, node.key);
						affected.add(messageSeq);
					}
					const recall = followingRecall(node);
					if (recall === void 0) continue;
					const current = this.labelsByMessageSeq.get(recall.messageSeq);
					if (recall.labels.length === 0) this.labelsByMessageSeq.delete(recall.messageSeq);
					else this.labelsByMessageSeq.set(recall.messageSeq, current !== void 0 && sameReferences$1(current, recall.labels) ? current : recall.labels);
					affected.add(recall.messageSeq);
				}
				for (const messageSeq of affected) {
					const key = this.messagesBySeq.get(messageSeq);
					if (key === void 0) continue;
					const node = byKey.get(key) ?? store.get(key);
					if (node === void 0) continue;
					byKey.set(key, withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS));
				}
				return [...byKey.values()];
			}
		};
		const EMPTY_CONTRIBUTION = {
			anchorSeq: 0,
			nodes: EMPTY_LIST,
			partial: null,
			running: null
		};
		function legacyContribution(raw) {
			const node = raw;
			if (raw.visibility !== "visible" && node.kind !== "assistant-step") return EMPTY_CONTRIBUTION;
			switch (node.kind) {
				case "user":
				case "steering":
				case "context":
				case "command":
				case "compaction":
				case "turn-error":
				case "turn-max-tokens":
				case "unknown": return {
					anchorSeq: node.anchorSeq,
					nodes: [node.data],
					partial: null,
					running: null
				};
				case "assistant-step": {
					const data = node.data;
					if (data.status === "running") {
						if (raw.visibility !== "visible") return EMPTY_CONTRIBUTION;
						return {
							anchorSeq: node.anchorSeq,
							nodes: EMPTY_LIST,
							partial: {
								turn: data.turn,
								step: data.step,
								blocks: data.blocks
							},
							running: null
						};
					}
					return {
						anchorSeq: node.anchorSeq,
						nodes: data.finalNode === void 0 ? EMPTY_LIST : [data.finalNode],
						partial: null,
						running: null
					};
				}
				case "tool-call": {
					const root = node.data.root;
					return isRunningTool(root) ? {
						anchorSeq: node.anchorSeq,
						nodes: EMPTY_LIST,
						partial: null,
						running: root
					} : {
						anchorSeq: node.anchorSeq,
						nodes: [root],
						partial: null,
						running: null
					};
				}
				case "manual-compaction": {
					const data = node.data;
					return {
						anchorSeq: node.anchorSeq,
						nodes: data.compaction === null ? [data.command] : [data.command, data.compaction],
						partial: null,
						running: null
					};
				}
				case "model-retry": return {
					anchorSeq: node.anchorSeq,
					nodes: node.data.attempts,
					partial: null,
					running: null
				};
				case "turn-tail":
				case "system-prompt": return EMPTY_CONTRIBUTION;
				default: return EMPTY_CONTRIBUTION;
			}
		}
		function sameContribution(left, right) {
			return left !== void 0 && left.anchorSeq === right.anchorSeq && left.partial?.blocks === right.partial?.blocks && left.partial?.turn === right.partial?.turn && left.partial?.step === right.partial?.step && left.running === right.running && sameReferences$1(left.nodes, right.nodes);
		}
		/** Incremental compatibility projection for StatsLine and legacy top-level snapshot fields. */
		var LegacySliceBuilder = class {
			contributions = /* @__PURE__ */ new Map();
			finalizedContributions = /* @__PURE__ */ new Map();
			runningContributions = /* @__PURE__ */ new Map();
			partialContributions = /* @__PURE__ */ new Map();
			finalized = EMPTY_LIST;
			runningCalls = EMPTY_LIST;
			partial = null;
			timeline;
			turnTimings = /* @__PURE__ */ new Map();
			turnEnds = /* @__PURE__ */ new Map();
			replace(nodes, timeline) {
				this.contributions.clear();
				this.finalizedContributions.clear();
				this.runningContributions.clear();
				this.partialContributions.clear();
				for (const node of nodes) {
					const contribution = legacyContribution(node);
					this.contributions.set(node.key, contribution);
					this.indexContribution(node.key, contribution);
				}
				this.rebuildFinalized();
				this.rebuildRunning();
				this.rebuildPartial();
				this.updateTimeline(timeline);
				return this.snapshot();
			}
			apply(upserts, timeline) {
				let finalizedChanged = false;
				let runningChanged = false;
				let partialChanged = false;
				for (const node of upserts) {
					const contribution = legacyContribution(node);
					const previous = this.contributions.get(node.key);
					if (sameContribution(previous, contribution)) continue;
					finalizedChanged ||= finalizedContributionChanged(previous, contribution);
					runningChanged ||= runningContributionChanged(previous, contribution);
					partialChanged ||= partialContributionChanged(previous, contribution);
					this.contributions.set(node.key, contribution);
					this.indexContribution(node.key, contribution);
				}
				if (finalizedChanged) this.rebuildFinalized();
				if (runningChanged) this.rebuildRunning();
				if (partialChanged) this.rebuildPartial();
				this.updateTimeline(timeline);
				return this.snapshot();
			}
			indexContribution(key, contribution) {
				updateContributionIndex(this.finalizedContributions, key, contribution, contribution.nodes.length > 0);
				updateContributionIndex(this.runningContributions, key, contribution, contribution.running !== null);
				updateContributionIndex(this.partialContributions, key, contribution, contribution.partial !== null);
			}
			rebuildFinalized() {
				const finalized = [...this.finalizedContributions.values()].flatMap((value) => value.nodes).sort((left, right) => left.seq - right.seq);
				if (!sameReferences$1(this.finalized, finalized)) this.finalized = finalized;
			}
			rebuildRunning() {
				const runningCalls = [...this.runningContributions.values()].sort((left, right) => left.anchorSeq - right.anchorSeq).flatMap((value) => value.running === null ? [] : [value.running]);
				if (!sameReferences$1(this.runningCalls, runningCalls)) this.runningCalls = runningCalls;
			}
			rebuildPartial() {
				const partial = [...this.partialContributions.values()].sort((left, right) => left.anchorSeq - right.anchorSeq).findLast((value) => value.partial !== null)?.partial ?? null;
				if (this.partial?.blocks !== partial?.blocks || this.partial?.turn !== partial?.turn || this.partial?.step !== partial?.step) this.partial = partial;
			}
			updateTimeline(timeline) {
				if (this.timeline === timeline) return;
				this.timeline = timeline;
				const turnTimings = /* @__PURE__ */ new Map();
				const turnEnds = /* @__PURE__ */ new Map();
				for (const turn of timeline.turns.values()) {
					if (turn.start !== void 0) turnTimings.set(turn.turn, {
						startTime: turn.start.time,
						...turn.end === void 0 ? {} : { endTime: turn.end.time }
					});
					if (turn.end !== void 0) turnEnds.set(turn.turn, turn.end.seq);
				}
				this.turnTimings = turnTimings;
				this.turnEnds = turnEnds;
			}
			snapshot() {
				return {
					nodes: this.finalized,
					turnTimings: this.turnTimings,
					turnEnds: this.turnEnds,
					partial: this.partial,
					runningCalls: this.runningCalls
				};
			}
		};
		function updateContributionIndex(index, key, contribution, present) {
			if (present) index.set(key, contribution);
			else index.delete(key);
		}
		function finalizedContributionChanged(previous, next) {
			const previousNodes = previous?.nodes ?? EMPTY_LIST;
			return !sameReferences$1(previousNodes, next.nodes) || (previousNodes.length > 0 || next.nodes.length > 0) && previous?.anchorSeq !== next.anchorSeq;
		}
		function runningContributionChanged(previous, next) {
			return previous?.running !== next.running || (previous.running !== null || next.running !== null) && previous.anchorSeq !== next.anchorSeq;
		}
		function partialContributionChanged(previous, next) {
			return previous?.partial?.blocks !== next.partial?.blocks || previous?.partial?.turn !== next.partial?.turn || previous?.partial?.step !== next.partial?.step || ((previous?.partial ?? null) !== null || next.partial !== null) && previous?.anchorSeq !== next.anchorSeq;
		}
		/** Incremental keyed Chat builder registered under the `chat` target. */
		var ChatSnapshotBuilder = class {
			store = new MutableChatNodeStore();
			locations = new MutableChatLocationIndex();
			navigation = new MutableTurnNavigationIndex();
			legacy = new LegacySliceBuilder();
			referenceLabels = new ReferenceLabelProjector();
			order = EMPTY_KEYS;
			/** Last published timeline: a Turn boundary can land without a new node. */
			timeline = null;
			empty;
			constructor() {
				this.empty = this.snapshot({
					turnOrder: EMPTY_TURNS,
					turns: /* @__PURE__ */ new Map()
				});
			}
			replace(input) {
				const nodes = this.referenceLabels.replace(input.nodes);
				this.store.replace(nodes);
				this.order = orderedVisibleChatNodes(nodes).map((node) => node.key);
				this.locations.rebuild(this.order, this.store);
				this.navigation.rebuild(input.timeline, this.locations, this.store);
				this.timeline = input.timeline;
				return this.snapshot(input.timeline, this.legacy.replace(nodes, input.timeline));
			}
			apply(input) {
				const upserts = this.referenceLabels.apply(input.upserts, this.store);
				let structural = false;
				const contentOnly = [];
				for (const node of upserts) {
					const previous = this.store.get(node.key);
					const nodeStructural = previous === void 0 || previous.kind !== node.kind || previous.anchorSeq !== node.anchorSeq || previous.visibility !== node.visibility || locationIdentity(previous.location) !== locationIdentity(node.location);
					structural ||= nodeStructural;
					if (!nodeStructural) contentOnly.push(node);
				}
				this.store.upsert(upserts);
				if (structural) {
					const next = orderedVisibleChatNodes(this.store.values()).map((node) => node.key);
					this.order = sameReferences$1(this.order, next) ? this.order : next;
					this.locations.rebuild(this.order, this.store);
				}
				this.locations.touch(contentOnly);
				if (structural || input.timeline !== this.timeline) this.navigation.rebuild(input.timeline, this.locations, this.store);
				else this.navigation.touch(turnsOf(contentOnly), this.locations, this.store);
				this.timeline = input.timeline;
				return this.snapshot(input.timeline, this.legacy.apply(upserts, input.timeline));
			}
			snapshot(timeline, legacy = this.legacy.replace(EMPTY_LIST, timeline)) {
				return {
					order: this.order,
					nodes: this.store,
					locations: this.locations,
					navigation: this.navigation,
					timeline,
					legacy
				};
			}
		};
		/** Turns owning the given nodes, for the content-only navigation update. */
		function turnsOf(nodes) {
			const turns = /* @__PURE__ */ new Set();
			for (const node of nodes) {
				const turn = locationCoordinates(node.location).turn;
				if (turn !== void 0) turns.add(turn);
			}
			return turns;
		}
		function locationIdentity(location) {
			const coordinates = locationCoordinates(location);
			return `${location.kind}:${coordinates.turn ?? ""}:${coordinates.step ?? ""}`;
		}
		/** Chat target factory contributed to the Conversation view registry. */
		const chatViewDefinition = {
			target: "chat",
			create: () => new ChatSnapshotBuilder(),
			isActive: (snapshot) => snapshot.order.some((key) => snapshot.nodes.get(key)?.kind !== "command")
		};
		/**
		* Register the incremental Chat target builder.
		* @param ctx - owning UI Conversation context.
		*/
		function registerChatConversationView(ctx) {
			ctx.uiConversation.views.register(chatViewDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/command.js
		const COMPACT_PLUGIN = "compact";
		function commandFromRun(match) {
			if (match.event.type !== "command/run") throw new Error("command start requires command/run");
			const data = match.event.data;
			return {
				kind: "command",
				seq: match.event.seq,
				time: match.event.time,
				commandId: data.commandId,
				name: data.name,
				args: data.args ?? null,
				outcome: null
			};
		}
		function commandFromDone(match, previous) {
			if (match.event.type !== "command/done") throw new Error("command update requires command/done");
			const data = match.event.data;
			const sourceEventSeq = data.kind === "success" && data.sourceEventSeq !== void 0 && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0 ? data.sourceEventSeq : void 0;
			return {
				kind: "command",
				seq: previous?.seq ?? match.event.seq,
				time: previous?.time ?? match.event.time,
				commandId: data.commandId,
				name: previous?.name ?? null,
				args: previous?.args ?? null,
				outcome: {
					kind: data.kind,
					...data.text === void 0 ? {} : { text: data.text },
					...sourceEventSeq === void 0 ? {} : { sourceEventSeq }
				}
			};
		}
		/**
		* Read correlation identity from a compaction replacement checkpoint.
		* @param event - candidate Session event.
		* @returns correlated compaction and optional command identity.
		*/
		function compactSource(event) {
			if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return void 0;
			const source = event.data.source;
			if (source.kind !== "plugin" || source.plugin !== COMPACT_PLUGIN || typeof source.compactionId !== "string") return void 0;
			return {
				compactionId: source.compactionId,
				...source.sourceCommandId === void 0 ? {} : { sourceCommandId: source.sourceCommandId }
			};
		}
		/**
		* Build the visible summary marker from optional lifecycle evidence.
		* @param match - compaction/summary Match, when loaded.
		* @param checkpoint - replacement checkpoint Match.
		* @returns final compaction summary Node data.
		*/
		function compactSummary(match, checkpoint) {
			let summary = null;
			let shadowedItemCount = null;
			let shadowedTokenCount = null;
			if (match?.event.type === "compaction/summary") {
				const data = match.event.data;
				if (Array.isArray(data.summary)) {
					const text = data.summary.map((block) => block.type === "text" ? block.text : "").join("");
					summary = text.trim() === "" ? null : text;
				}
				shadowedItemCount = Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0) ? data.shadowedSeqs.length : null;
				shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0 ? data.shadowedTokenCount : null;
			}
			return {
				kind: "compaction",
				seq: checkpoint.event.seq,
				time: checkpoint.event.time,
				summary,
				summaryEventSeq: match?.event.seq ?? null,
				shadowedItemCount,
				shadowedTokenCount
			};
		}
		function fallbackState$4(context) {
			const done = context.matches.find((match) => match.event.type === "command/done");
			const checkpoint = context.matches.find((match) => compactSource(match.event) !== void 0);
			const summary = context.matches.find((match) => match.event.type === "compaction/summary");
			if (checkpoint === void 0) return done === void 0 ? void 0 : { command: commandFromDone(done) };
			const source = compactSource(checkpoint.event);
			if (source?.sourceCommandId === void 0) return done === void 0 ? void 0 : { command: commandFromDone(done) };
			return {
				command: done === void 0 ? {
					kind: "command",
					seq: checkpoint.event.seq,
					time: checkpoint.event.time,
					commandId: source.sourceCommandId,
					name: "compact",
					args: null,
					outcome: null
				} : {
					...commandFromDone(done),
					name: "compact"
				},
				checkpoint,
				...summary === void 0 ? {} : { summary }
			};
		}
		/**
		* Fold shared compaction evidence into a Definition-owned State.
		* @param state - current business State carrying optional compaction evidence.
		* @param match - next compaction lifecycle Match.
		* @returns adopted State, preserving reference identity when the Match adds no evidence.
		*/
		function updateCompactionState(state, match) {
			if (match.event.type === "compaction/summary") return {
				...state,
				summary: match
			};
			if (compactSource(match.event) !== void 0) return {
				...state,
				checkpoint: match
			};
			return state;
		}
		/** Slash-command lifecycle, including integrated manual compaction, Definition. */
		const commandDefinition = {
			kind: "command",
			target: "chat",
			match: (event) => {
				if (event.type === "command/run") return {
					id: String(event.data.commandId),
					role: "start"
				};
				if (event.type === "command/done") return {
					id: String(event.data.commandId),
					role: "update"
				};
				const checkpoint = compactSource(event);
				if (checkpoint?.sourceCommandId !== void 0) return {
					id: String(checkpoint.sourceCommandId),
					role: "update"
				};
				if (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") {
					if (event.data.sourceCommandId !== void 0) return {
						id: String(event.data.sourceCommandId),
						role: "update"
					};
				}
				return null;
			},
			start: (_context, match) => ({ command: commandFromRun(match) }),
			update: (context, match) => {
				if (match.event.type === "command/done") return {
					...context.state,
					command: commandFromDone(match, context.state.command)
				};
				return updateCompactionState(context.state, match);
			},
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$4(context);
				if (state === void 0) return null;
				if (state.command.name !== "compact") return chatNode(context, "command", state.command.seq, state.command);
				const compaction = state.checkpoint === void 0 ? null : compactSummary(state.summary, state.checkpoint);
				const data = {
					command: state.command,
					compaction
				};
				return chatNode(context, "manual-compaction", compaction?.seq ?? state.command.seq, data);
			}
		};
		/**
		* Register the command lifecycle business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerCommandConversationNode(ctx) {
			ctx.uiConversation.events.register(commandDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/compaction.js
		function fallbackState$3(context) {
			const summary = context.matches.find((match) => match.event.type === "compaction/summary");
			const checkpoint = context.matches.find((match) => compactSource(match.event) !== void 0);
			return {
				...summary === void 0 ? {} : { summary },
				...checkpoint === void 0 ? {} : { checkpoint }
			};
		}
		/** Automatic compaction lifecycle and landed checkpoint Definition. */
		const compactionDefinition = {
			kind: "compaction",
			target: "chat",
			match: (event) => {
				const checkpoint = compactSource(event);
				if (checkpoint !== void 0 && checkpoint.sourceCommandId === void 0) return {
					id: checkpoint.compactionId,
					role: "update"
				};
				if (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") {
					if (event.data.sourceCommandId !== void 0) return null;
					const compactionId = event.data.compactionId;
					if (typeof compactionId !== "string" || compactionId === "") return null;
					return {
						id: compactionId,
						role: event.type === "compaction/start" ? "start" : "update"
					};
				}
				return null;
			},
			start: () => ({}),
			update: (context, match) => updateCompactionState(context.state, match),
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$3(context);
				if (state.checkpoint === void 0) return null;
				const marker = compactSummary(state.summary, state.checkpoint);
				return chatNode(context, "compaction", marker.seq, marker);
			}
		};
		/**
		* Register the automatic-compaction business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerCompactionConversationNode(ctx) {
			ctx.uiConversation.events.register(compactionDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/fallback.js
		/** Unclaimed append-surface fallback Definition. */
		const unknownFallbackDefinition = {
			kind: "unknown-surface",
			target: "chat",
			match: (event) => {
				if (event.type === "chunkrow/text-chunks" || event.type === "chunkrow/reasoning-chunks" || event.type === "chunkrow/tool-call-chunks") return null;
				return isAppendSurfaceEvent(event) ? {
					id: String(event.seq),
					role: "start"
				} : null;
			},
			start: (_context, match) => ({
				kind: "unknown",
				seq: match.event.seq,
				time: match.event.time,
				type: match.event.type,
				data: match.event.data
			}),
			update: (context) => context.state,
			buildViewNode: (context) => context.state === void 0 ? null : chatNode(context, "unknown", context.state.seq, context.state)
		};
		/**
		* Register the unmatched append-surface fallback contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerUnknownConversationFallback(ctx) {
			ctx.uiConversation.events.registerFallback(unknownFallbackDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/inbox.js
		function applySplice(previous, splice) {
			const pending = [...previous?.state.pending ?? []];
			const claimed = new Set(previous?.state.claimed ?? []);
			const removed = pending.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted);
			for (const identity of splice.inserted) claimed.delete(identity.id);
			if (splice.target === "next-step" && splice.outcome !== "canceled") for (const identity of removed) claimed.add(identity.id);
			return {
				pending,
				claimed
			};
		}
		function inboxDefinition(target) {
			const kind = `inbox-${target}`;
			return {
				kind,
				match: (event) => event.type === "agent/inbox/spliced" && event.data.target === target ? {
					id: String(event.seq),
					role: "start"
				} : null,
				start: (_context, match, reader) => {
					if (match.event.type !== "agent/inbox/spliced") throw new Error(`${kind} start requires agent/inbox/spliced`);
					return applySplice(reader.previous(kind), match.event.data);
				},
				update: (context) => context.state,
				publication: () => "none"
			};
		}
		/** Cumulative next-turn inbox splice Definition. */
		const nextTurnInboxDefinition = inboxDefinition("next-turn");
		/** Cumulative next-step inbox splice Definition used to classify steering. */
		const nextStepInboxDefinition = inboxDefinition("next-step");
		/**
		* Register the two durable Inbox-state contributions.
		* @param ctx - owning UI Conversation context.
		*/
		function registerInboxConversationNodes(ctx) {
			ctx.uiConversation.events.register(nextTurnInboxDefinition);
			ctx.uiConversation.events.register(nextStepInboxDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/message.js
		function isCompactionCheckpoint(event) {
			if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return false;
			const source = event.data.source;
			return source.kind === "plugin" && source.plugin === "compact";
		}
		/** User, steering, and injected-context message classification Definition. */
		const messageDefinition = {
			kind: "input-message",
			target: "chat",
			match: (event) => event.type === "user/message" && isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event) ? {
				id: String(event.data.id),
				role: "start"
			} : null,
			start: (_context, match, reader) => {
				if (match.event.type !== "user/message") throw new Error("input-message start requires user/message");
				const event = match.event;
				if (event.data.source.kind !== "user") return {
					kind: "context",
					seq: event.seq,
					time: event.time,
					content: event.data.content,
					source: event.data.source,
					provenance: contextProvenance(event.data.source),
					form: contextForm(event.data.source)
				};
				return reader.previous("inbox-next-step")?.state.claimed.has(String(event.data.id)) === true ? {
					kind: "steering",
					messageId: event.data.id,
					seq: event.seq,
					time: event.time,
					content: event.data.content,
					source: event.data.source
				} : {
					kind: "user",
					seq: event.seq,
					time: event.time,
					content: event.data.content,
					source: event.data.source
				};
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				if (context.state === void 0) return null;
				return chatNode(context, context.state.kind, context.state.seq, context.state);
			}
		};
		/**
		* Register the user, steering, and injected-context message contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerMessageConversationNode(ctx) {
			ctx.uiConversation.events.register(messageDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/request-prompt.js
		/** Place a request's system field at the start of its visible message series. */
		function requestPromptAnchor(match, previous, isInitial) {
			if (match.location.kind !== "step") return match.event.seq;
			if (previous === void 0 && !isInitial) return match.event.seq;
			if (previous?.turn === match.location.turn.turn && previous.step === match.location.step.step) return match.event.seq;
			return match.location.step.step === 1 ? match.location.turn.start?.seq ?? match.location.step.start?.seq ?? match.event.seq : match.location.step.start?.seq ?? match.event.seq;
		}
		/** Keep an already rendered prompt at its page-lifetime presentation anchor. */
		function stableRequestPromptAnchor(context, match, previous, isInitial) {
			const current = context.current.get("chat");
			return current?.kind === "system-prompt" ? current.anchorSeq : requestPromptAnchor(match, previous, isInitial);
		}
		/**
		* Request-header prompt Definition for the Chat target.
		* @param inspect - the shared prompt interpretation, supplied by the
		* uiConversation service (a client bundle cannot value-import it).
		* @returns the Chat request-prompt Definition.
		*/
		function requestPromptDefinition(inspect) {
			return {
				kind: "request-prompt",
				target: "chat",
				match: (event) => event.type === "request/header" ? {
					id: String(event.seq),
					role: "start"
				} : null,
				start: (context, match, reader) => {
					if (match.event.type !== "request/header") throw new Error("request-prompt start requires request/header");
					const previous = reader.previous("request-prompt")?.state;
					const location = match.location.kind === "step" ? {
						turn: match.location.turn.turn,
						step: match.location.step.step
					} : {};
					const inspection = inspect(previous?.prompt, match.event);
					const change = inspection.change?.kind;
					return {
						anchorSeq: stableRequestPromptAnchor(context, match, previous, match.event.data.reason === "initial"),
						showsPrompt: previous === void 0 || match.event.data.reason !== "change" || match.event.data.startsSeries === true || change === "system" || change === "system-and-tools",
						...location,
						...inspection
					};
				},
				update: (context) => context.state,
				buildViewNode: (context) => {
					const state = context.state;
					if (state === void 0 || !state.showsPrompt || state.prompt.system === "") return null;
					return chatNode(context, "system-prompt", state.anchorSeq, { text: state.prompt.system });
				}
			};
		}
		/**
		* Register model-request system prompts in the Chat flow.
		* @param ctx - Owning UI Conversation context.
		*/
		function registerRequestPromptConversationNode(ctx) {
			ctx.uiConversation.events.register(requestPromptDefinition((previous, event) => ctx.uiConversation.inspectRequestPrompt(previous, event)));
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/retry.js
		function scheduledNode(match) {
			if (match.event.type !== "llm/retry") return void 0;
			return {
				kind: "model-retry",
				seq: match.event.seq,
				time: match.event.time,
				retryState: "scheduled",
				...match.event.data
			};
		}
		/** A scheduled attempt is cancelled once either owning boundary closes. */
		function isClosed(location) {
			return location.kind === "step" && location.step.status === "closed" || (location.kind === "step" || location.kind === "turn") && location.turn.status === "closed";
		}
		/** Producer-correlated model retry chain Definition. */
		const retryDefinition = {
			kind: "model-retry",
			target: "chat",
			match: (event) => {
				if (event.type === "llm/retry") {
					const retryId = event.data.retryId;
					if (typeof retryId !== "string" || retryId === "") return null;
					return {
						id: retryId,
						role: event.data.retry === 1 ? "start" : "update"
					};
				}
				if (event.type === "llm/retry-started") {
					const retryId = event.data.retryId;
					return typeof retryId === "string" && retryId !== "" ? {
						id: retryId,
						role: "update"
					} : null;
				}
				return null;
			},
			start: (_context, match) => {
				const node = scheduledNode(match);
				if (node === void 0) throw new Error("model-retry start requires a valid llm/retry event");
				return {
					turn: node.turn,
					step: node.step,
					attempts: [node]
				};
			},
			update: (context, match) => {
				if (match.event.type === "llm/retry") {
					const node = scheduledNode(match);
					return node === void 0 ? context.state : {
						...context.state,
						attempts: [...context.state.attempts, node]
					};
				}
				if (match.event.type !== "llm/retry-started") return context.state;
				const retry = match.event.data.retry;
				return {
					...context.state,
					attempts: context.state.attempts.map((attempt) => attempt.retry === retry ? {
						...attempt,
						retryState: "started"
					} : attempt)
				};
			},
			buildViewNode: (context) => {
				if (context.state === void 0 || context.state.attempts.length === 0) return null;
				const location = context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
				const stateAttempts = context.state.attempts;
				const attempts = stateAttempts.map((attempt, index) => index === stateAttempts.length - 1 && attempt.retryState === "scheduled" && isClosed(location) ? {
					...attempt,
					retryState: "cancelled"
				} : attempt);
				const current = attempts.at(-1);
				if (current === void 0) return null;
				const data = {
					attempts,
					current
				};
				return chatNode(context, "model-retry", attempts[0]?.seq ?? current.seq, data);
			}
		};
		/**
		* Register the correlated model-retry business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerRetryConversationNode(ctx) {
			ctx.uiConversation.events.register(retryDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/tool.js
		const MAX_DEPTH = 256;
		const projectedBlocks = /* @__PURE__ */ new WeakMap();
		function jsonArguments(value) {
			return JSON.stringify(value);
		}
		function rootCall(match) {
			if (match.event.type !== "tool/call") throw new Error("tool-call start requires tool/call");
			return {
				callId: String(match.event.data.callId),
				name: match.event.data.name,
				argsRaw: match.event.data.arguments,
				turn: match.event.data.turn,
				step: match.event.data.step,
				time: match.event.time,
				subCalls: []
			};
		}
		function rootResult(match, previous) {
			if (match.event.type !== "tool/result") return void 0;
			const result = match.event.data.message.content[0];
			return {
				kind: "tool-result",
				seq: match.event.seq,
				time: match.event.time,
				callId: String(match.event.data.message.source.callId),
				call: previous === void 0 ? null : {
					name: previous.name,
					argsRaw: previous.argsRaw
				},
				callTime: previous?.time ?? null,
				content: result.content,
				isError: result.isError === true,
				...match.event.data.error === void 0 ? {} : { error: match.event.data.error },
				meta: match.event.data.meta,
				subCalls: []
			};
		}
		function childCall(match, data) {
			return {
				callId: data.subCallId,
				parentCallId: data.parentCallId,
				name: data.name,
				argsRaw: jsonArguments(data.arguments),
				turn: locationTurn(match),
				step: locationStep(match),
				time: match.event.time,
				subCalls: []
			};
		}
		function childResult(match, data, previous) {
			return {
				kind: "tool-result",
				seq: match.event.seq,
				time: match.event.time,
				callId: data.subCallId,
				parentCallId: data.parentCallId,
				call: {
					name: data.name,
					argsRaw: jsonArguments(data.arguments)
				},
				callTime: previous?.time ?? null,
				content: data.content ?? [],
				isError: data.isError === true,
				subCalls: []
			};
		}
		function locationTurn(match) {
			return match.location.kind === "step" || match.location.kind === "turn" ? match.location.turn.turn : 0;
		}
		function locationStep(match) {
			return match.location.kind === "step" ? match.location.step.step : 0;
		}
		function acceptsEdge(state, parent, child) {
			if (parent === child || state.parents.has(child)) return false;
			let cursor = parent;
			let parentDepth = 0;
			const ancestors = /* @__PURE__ */ new Set();
			while (cursor !== void 0) {
				if (cursor === child || ancestors.has(cursor)) return false;
				ancestors.add(cursor);
				parentDepth++;
				cursor = state.parents.get(cursor);
			}
			const pending = [{
				callId: child,
				depth: 1
			}];
			const descendants = /* @__PURE__ */ new Set();
			let subtreeDepth = 0;
			for (const candidate of pending) {
				if (descendants.has(candidate.callId)) return false;
				descendants.add(candidate.callId);
				subtreeDepth = Math.max(subtreeDepth, candidate.depth);
				for (const nested of state.children.get(candidate.callId) ?? []) pending.push({
					callId: nested.callId,
					depth: candidate.depth + 1
				});
			}
			return parentDepth + subtreeDepth <= MAX_DEPTH;
		}
		function updateDispatch(state, match) {
			const event = match.event;
			if (event.type !== "tool/code-dispatch-start" && event.type !== "tool/code-dispatch") return state;
			const data = event.data;
			const parentCallId = String(data.parentCallId);
			const subCallId = String(data.subCallId);
			const siblings = state.children.get(parentCallId) ?? [];
			const index = siblings.findIndex((candidate) => candidate.callId === subCallId);
			if (event.type === "tool/code-dispatch-start") {
				if (index >= 0 || !acceptsEdge(state, parentCallId, subCallId)) return state;
				const children = new Map(state.children);
				children.set(parentCallId, [...siblings, childCall(match, data)]);
				const parents = new Map(state.parents);
				parents.set(subCallId, parentCallId);
				return {
					...state,
					children,
					parents
				};
			}
			if (index < 0 && !acceptsEdge(state, parentCallId, subCallId)) return state;
			const settled = childResult(match, data, index < 0 ? void 0 : siblings[index]);
			const children = new Map(state.children);
			children.set(parentCallId, index < 0 ? [...siblings, settled] : siblings.map((child, at) => at === index ? settled : child));
			const parents = new Map(state.parents);
			if (index < 0) parents.set(subCallId, parentCallId);
			return {
				...state,
				children,
				parents
			};
		}
		function projectBlock(block, state, interruptedAt, visited = /* @__PURE__ */ new Set(), depth = 1) {
			if (visited.has(block.callId) || depth > MAX_DEPTH) return {
				...block,
				subCalls: []
			};
			const nextVisited = new Set(visited);
			nextVisited.add(block.callId);
			const children = (state.children.get(block.callId) ?? block.subCalls).map((child) => projectBlock(child, state, interruptedAt, nextVisited, depth + 1));
			const interruptionSeq = "kind" in block ? void 0 : interruptedAt?.seq;
			const interruptionTime = "kind" in block ? void 0 : interruptedAt?.time;
			const cached = projectedBlocks.get(block);
			if (cached !== void 0 && cached.interruptionSeq === interruptionSeq && cached.interruptionTime === interruptionTime && sameReferences(cached.children, children)) return cached.value;
			const projected = "kind" in block || interruptedAt === void 0 ? sameReferences(block.subCalls, children) ? block : {
				...block,
				subCalls: children
			} : {
				kind: "tool-result",
				seq: interruptedAt.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedFollowup,
				time: interruptedAt.time,
				callId: block.callId,
				...block.parentCallId === void 0 ? {} : { parentCallId: block.parentCallId },
				call: {
					name: block.name,
					argsRaw: block.argsRaw
				},
				callTime: block.time,
				content: [],
				isError: true,
				error: {
					name: "Interrupted",
					code: "interrupted"
				},
				subCalls: children
			};
			projectedBlocks.set(block, {
				children,
				interruptionSeq,
				interruptionTime,
				value: projected
			});
			return projected;
		}
		function sameReferences(left, right) {
			return left.length === right.length && left.every((value, index) => value === right[index]);
		}
		function interruption(context) {
			const location = context.start?.location;
			if (location?.kind === "step" && location.step.status === "closed") return location.step.end;
			if ((location?.kind === "step" || location?.kind === "turn") && location.turn.status === "closed") return location.turn.end;
		}
		function fallbackState$2(context) {
			const match = context.matches.find((candidate) => candidate.event.type === "tool/result");
			const root = match === void 0 ? void 0 : rootResult(match);
			if (root === void 0) return void 0;
			let state = {
				root,
				children: /* @__PURE__ */ new Map(),
				parents: /* @__PURE__ */ new Map()
			};
			for (const candidate of context.matches) state = updateDispatch(state, candidate);
			return state;
		}
		/** Root Tool lifecycle and nested Code Dispatch Definition. */
		const toolDefinition = {
			kind: "tool-call",
			target: "chat",
			match: (event) => {
				if (event.type === "tool/call") return {
					id: String(event.data.callId),
					role: "start"
				};
				if (event.type === "tool/result" && isAppendSurfaceEvent(event)) return {
					id: String(event.data.message.source.callId),
					role: "update"
				};
				if (event.type === "tool/code-dispatch-start" || event.type === "tool/code-dispatch") {
					const rootCallId = event.data.rootCallId;
					return typeof rootCallId === "string" && rootCallId !== "" ? {
						id: rootCallId,
						role: "update"
					} : null;
				}
				return null;
			},
			start: (_context, match) => ({
				root: rootCall(match),
				children: /* @__PURE__ */ new Map(),
				parents: /* @__PURE__ */ new Map()
			}),
			update: (context, match) => {
				if (match.event.type === "tool/result") {
					const result = rootResult(match, "kind" in context.state.root ? void 0 : context.state.root);
					return result === void 0 ? context.state : {
						...context.state,
						root: result
					};
				}
				return updateDispatch(context.state, match);
			},
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$2(context);
				if (state === void 0) return null;
				const projected = projectBlock(state.root, state, interruption(context));
				return chatNode(context, "tool-call", context.start?.event.seq ?? ("kind" in state.root ? state.root.seq : context.matches[0]?.event.seq ?? 0), { root: projected });
			}
		};
		/**
		* Register the root Tool lifecycle and nested-subcall contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerToolConversationNode(ctx) {
			ctx.uiConversation.events.register(toolDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-error.js
		function lastStep$1(context) {
			const location = context.start?.location ?? context.matches[0]?.location;
			if (location?.kind !== "turn" && location?.kind !== "step") return 0;
			return location.turn.steps.at(-1)?.step ?? 0;
		}
		function failureFrom(match) {
			if (match.event.type !== "turn/end" || match.event.data.reason.kind !== "error") return void 0;
			const failure = match.event.data.reason.error;
			const display = displayFailure(failure);
			return {
				seq: match.event.seq,
				time: match.event.time,
				message: display.message,
				...display.code === void 0 ? {} : { code: display.code }
			};
		}
		function fallbackState$1(context) {
			const end = context.matches.find((match) => failureFrom(match) !== void 0);
			if (end?.event.type !== "turn/end") return void 0;
			const failure = failureFrom(end);
			if (failure === void 0) return void 0;
			return {
				turn: end.event.data.turn,
				failure
			};
		}
		/**
		* Terminal turn failure Definition. Retries run inside the failing turn, so the
		* turn's `llm/retry` history never suppresses this terminal row; the model-retry
		* node renders that history separately.
		*/
		const turnErrorDefinition = {
			kind: "turn-error",
			target: "chat",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "turn/end" && event.data.reason.kind === "error") return {
					id: String(event.data.turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("turn-error start requires turn/start");
				return { turn: match.event.data.turn };
			},
			update: (context, match) => {
				const failure = failureFrom(match);
				return failure === void 0 ? context.state : {
					...context.state,
					failure
				};
			},
			buildViewNode: (context) => {
				const state = context.state ?? fallbackState$1(context);
				if (state?.failure === void 0) return null;
				const failure = state.failure;
				const node = {
					kind: "turn-error",
					seq: failure.seq,
					time: failure.time,
					turn: state.turn,
					step: lastStep$1(context),
					message: failure.message,
					...failure.code === void 0 ? {} : { code: failure.code }
				};
				return chatNode(context, "turn-error", node.seq, node);
			}
		};
		/**
		* Register the terminal Turn-error business contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerTurnErrorConversationNode(ctx) {
			ctx.uiConversation.events.register(turnErrorDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-max-tokens.js
		function lastStep(context) {
			const location = context.start?.location ?? context.matches[0]?.location;
			if (location?.kind !== "turn" && location?.kind !== "step") return 0;
			return location.turn.steps.at(-1)?.step ?? 0;
		}
		/**
		* Anchor the notice between the closing Assistant and the turn-tail so the
		* tail stays the turn's last Chat node and keeps its branch action enabled.
		* Without a closing text Assistant there is no branch action to protect, and
		* the turn/end seq keeps the notice at the truncation point.
		*/
		function noticeAnchor(context, seq) {
			const location = context.start?.location ?? context.matches[0]?.location;
			if (location?.kind !== "turn" && location?.kind !== "step") return seq;
			const closing = location.turn.data.get("turn-tail")?.closing;
			return closing === null || closing === void 0 ? seq : closing.finalNode.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.maxTokensNotice;
		}
		function stateFrom(match) {
			if (match.event.type !== "turn/end" || match.event.data.reason.kind !== "max-tokens") return void 0;
			return {
				turn: match.event.data.turn,
				seq: match.event.seq,
				time: match.event.time
			};
		}
		/** Notice Definition for a turn the provider ended at its output-token cap. */
		const turnMaxTokensDefinition = {
			kind: "turn-max-tokens",
			target: "chat",
			match: (event) => {
				if (event.type === "turn/end" && event.data.reason.kind === "max-tokens") return {
					id: String(event.data.turn),
					role: "start"
				};
				return null;
			},
			start: (_context, match) => {
				const state = stateFrom(match);
				if (state === void 0) throw new Error("turn-max-tokens start requires a max-tokens turn/end");
				return state;
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				const state = context.state;
				if (state === void 0) return null;
				const node = {
					kind: "turn-max-tokens",
					seq: state.seq,
					time: state.time,
					turn: state.turn,
					step: lastStep(context)
				};
				return chatNode(context, "turn-max-tokens", noticeAnchor(context, state.seq), node);
			}
		};
		/**
		* Register the max-tokens turn-end notice contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerTurnMaxTokensConversationNode(ctx) {
			ctx.uiConversation.events.register(turnMaxTokensDefinition);
		}
		//#endregion
		//#region lib/types/client/contract/assistant-content.js
		/**
		* Test whether Assistant blocks contain a user-facing reply rather than only
		* reasoning or Tool-call protocol material.
		* @param blocks - Assistant content blocks.
		* @returns whether the blocks contain visible reply content.
		*/
		function hasAssistantReplyContent(blocks) {
			return blocks.some((block) => {
				if (block.kind === "reasoning" || block.kind === "tool-call") return false;
				if (block.kind === "text") return block.text.trim() !== "";
				return true;
			});
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-process.js
		function isChunkRunEvent(event) {
			return event.type === "chunkrow/text-chunks" || event.type === "chunkrow/reasoning-chunks" || event.type === "chunkrow/tool-call-chunks";
		}
		function eventTurn(event) {
			const data = event.data;
			return typeof data.turn === "number" ? data.turn : void 0;
		}
		function visibleAssistantEvent(event) {
			if (event.type === "assistant/chunk") {
				const chunk = event.data.chunk;
				if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") return chunk.text.trim() !== "";
				if (chunk.type === "block-start") return chunk.blockType !== "text" && chunk.blockType !== "reasoning" && chunk.blockType !== "tool-call";
				if (chunk.type !== "block-end") return false;
				const block = chunk.block;
				if (block.type === "tool-call") return false;
				if (block.type === "text" || block.type === "reasoning") return block.text.trim() !== "";
				return true;
			}
			return event.type === "assistant/message" && isAppendSurfaceEvent(event) && toAssistantBlocks(event.data.message.content).some((block) => {
				if (block.kind === "tool-call") return false;
				if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
				return true;
			});
		}
		function processEvidence(event) {
			if (isChunkRunEvent(event)) {
				if (event.type === "chunkrow/tool-call-chunks") return void 0;
				const firstVisible = event.data.texts.findIndex((text) => text.trim() !== "");
				return firstVisible < 0 ? void 0 : {
					kind: "assistant",
					seq: event.seq + firstVisible,
					step: event.data.step
				};
			}
			if (visibleAssistantEvent(event)) {
				if (event.type !== "assistant/chunk" && event.type !== "assistant/message") return void 0;
				return {
					kind: "assistant",
					seq: event.seq,
					step: event.data.step
				};
			}
			if (event.type === "tool/call" || event.type === "tool/result" && isAppendSurfaceEvent(event) || event.type === "llm/retry") return {
				kind: "other",
				seq: event.seq
			};
		}
		function turnLocation$1(context) {
			const location = context.start?.location ?? context.matches.at(-1)?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn : void 0;
		}
		function fallbackState(context) {
			const turn = context.matches.map((match) => eventTurn(match.event)).find((candidate) => candidate !== void 0);
			if (turn === void 0) return void 0;
			let state = {
				turn,
				assistantStartByStep: /* @__PURE__ */ new Map(),
				messageCountByStep: /* @__PURE__ */ new Map(),
				toolCallCount: 0,
				subagentCount: 0
			};
			for (const match of context.matches) state = updateProcessState(state, match.event);
			return state;
		}
		function isFinalAssistant(data) {
			return data?.finalNode !== void 0;
		}
		function latestAnswer(turn) {
			const data = turn.steps.at(-1)?.data.get("assistant-step");
			if (!isFinalAssistant(data) || !hasAssistantReplyContent(data.blocks)) return null;
			return data.blocks.some((block) => block.kind === "tool-call") ? null : data;
		}
		function processSpec(state, turn) {
			const controlAnchorSeq = Math.min(state.otherStartSeq ?? Number.POSITIVE_INFINITY, ...state.assistantStartByStep.values());
			if (!Number.isFinite(controlAnchorSeq)) return null;
			const answer = latestAnswer(turn);
			const counts = {
				messageCount: answer === null ? [...state.messageCountByStep.values()].reduce((total, count) => total + count, 0) : [...state.messageCountByStep].filter(([step]) => step < answer.step).reduce((total, [, count]) => total + count, 0),
				toolCallCount: state.toolCallCount,
				subagentCount: state.subagentCount
			};
			if (answer === null) return {
				turn: turn.turn,
				controlAnchorSeq,
				processStartSeq: controlAnchorSeq,
				answerAnchorSeq: null,
				answerStep: null,
				inlineReasoning: false,
				...counts
			};
			const inlineReasoning = answer.blocks.some((block) => block.kind === "reasoning" && block.text.trim() !== "");
			const earlierAssistantSeq = Math.min(...[...state.assistantStartByStep].filter(([step]) => step < answer.step).map(([, seq]) => seq));
			const externalProcessSeq = Math.min(state.otherStartSeq ?? Number.POSITIVE_INFINITY, earlierAssistantSeq);
			return {
				turn: turn.turn,
				controlAnchorSeq,
				processStartSeq: turn.start?.seq ?? (Number.isFinite(externalProcessSeq) ? externalProcessSeq : answer.finalNode.seq),
				answerAnchorSeq: answer.finalNode.seq,
				answerStep: answer.step,
				inlineReasoning,
				...counts
			};
		}
		function updateProcessState(state, event) {
			let current = state;
			if (event.type === "assistant/message" && isAppendSurfaceEvent(event) && hasAssistantReplyContent(toAssistantBlocks(event.data.message.content))) {
				const messageCountByStep = new Map(current.messageCountByStep);
				messageCountByStep.set(event.data.step, (messageCountByStep.get(event.data.step) ?? 0) + 1);
				current = {
					...current,
					messageCountByStep
				};
			}
			if (event.type === "tool/call") {
				const subagent = isSubagentDelegationTool(event.data.name);
				current = {
					...current,
					toolCallCount: current.toolCallCount + (subagent ? 0 : 1),
					subagentCount: current.subagentCount + (subagent ? 1 : 0)
				};
			}
			const evidence = processEvidence(event);
			if (evidence === void 0) return current;
			if (evidence.kind === "other") return current.otherStartSeq === void 0 ? {
				...current,
				otherStartSeq: evidence.seq
			} : current;
			if (current.assistantStartByStep.has(evidence.step)) return current;
			const assistantStartByStep = new Map(current.assistantStartByStep);
			assistantStartByStep.set(evidence.step, evidence.seq);
			return {
				...current,
				assistantStartByStep
			};
		}
		/** Turn-scoped process range and answer-boundary Definition. */
		const turnProcessDefinition = {
			kind: "turn-process",
			target: "chat",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				const turn = eventTurn(event);
				if (turn === void 0) return null;
				if (event.type === "assistant/chunk" || event.type === "assistant/message" || isChunkRunEvent(event) || event.type === "tool/call" || event.type === "tool/result" || event.type === "llm/retry" || event.type === "step/start" || event.type === "step/end" || event.type === "turn/end") return {
					id: String(turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("turn-process start requires turn/start");
				return {
					turn: match.event.data.turn,
					assistantStartByStep: /* @__PURE__ */ new Map(),
					messageCountByStep: /* @__PURE__ */ new Map(),
					toolCallCount: 0,
					subagentCount: 0
				};
			},
			update: (context, match) => updateProcessState(context.state, match.event),
			publication: (match) => {
				if (isChunkRunEvent(match.event)) return "animation-frame";
				if (match.event.type === "assistant/chunk") {
					const type = match.event.data.chunk.type;
					return type === "usage" || type === "finish" ? "none" : "animation-frame";
				}
				return "immediate";
			},
			buildLocationData: (context, scope) => {
				if (scope !== "turn") return null;
				const state = context.state ?? fallbackState(context);
				if (state === void 0) return null;
				const turn = turnLocation$1(context);
				if (turn === void 0) return null;
				const spec = processSpec(state, turn);
				return spec === null ? null : {
					kind: "turn",
					turn: turn.turn,
					key: "turn-process",
					value: encodeTurnProcess(spec)
				};
			},
			buildViewNode: (context) => {
				const turn = turnLocation$1(context);
				const signature = turn?.data.get("turn-process");
				if (turn === void 0 || signature === void 0) return null;
				const data = decodeTurnProcess(signature);
				return chatNode(context, "turn-process", data.controlAnchorSeq + CHAT_SYNTHETIC_SEQ_OFFSETS.processControl, data);
			}
		};
		/**
		* Register the Turn-scoped process disclosure projection.
		* @param ctx - owning UI Conversation context.
		*/
		function registerTurnProcess(ctx) {
			ctx.uiConversation.events.register(turnProcessDefinition);
		}
		//#endregion
		//#region ../../llm/token-meter/src/turn-usage.ts
		function isCount(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
		}
		function safeSum(values) {
			let total = 0;
			for (const value of values) {
				total += value;
				if (!Number.isSafeInteger(total)) return void 0;
			}
			return total;
		}
		function messageRoute(message) {
			const { provider, model } = message.source;
			return provider.length > 0 && model.length > 0 ? {
				provider,
				model
			} : void 0;
		}
		function normalizeUsage(usage, route) {
			const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage;
			if (!isCount(inputTokens) || !isCount(outputTokens)) return void 0;
			if (cacheReadTokens !== void 0 && !isCount(cacheReadTokens)) return void 0;
			if (cacheWriteTokens !== void 0 && !isCount(cacheWriteTokens)) return void 0;
			if (reasoningTokens !== void 0 && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) return;
			const knownPrompt = safeSum([
				inputTokens,
				...cacheReadTokens === void 0 ? [] : [cacheReadTokens],
				...cacheWriteTokens === void 0 ? [] : [cacheWriteTokens]
			]);
			if (knownPrompt === void 0) return void 0;
			let exactTotal;
			if (totalTokens !== void 0) {
				if (!isCount(totalTokens)) return void 0;
				const exactPrompt = totalTokens - outputTokens;
				if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return void 0;
				if (cacheReadTokens !== void 0 && cacheWriteTokens !== void 0 && exactPrompt !== knownPrompt) return;
				exactTotal = totalTokens;
			} else {
				if (cacheReadTokens === void 0 || cacheWriteTokens === void 0) return void 0;
				const derivedTotal = safeSum([knownPrompt, outputTokens]);
				if (derivedTotal === void 0) return void 0;
				exactTotal = derivedTotal;
			}
			return {
				inputTokens,
				outputTokens,
				totalTokens: exactTotal,
				...cacheReadTokens === void 0 ? {} : { cacheReadTokens },
				...cacheWriteTokens === void 0 ? {} : { cacheWriteTokens },
				...reasoningTokens === void 0 ? {} : { reasoningTokens },
				...route === void 0 ? {} : { route }
			};
		}
		function aggregateAttempts(attempts) {
			if (attempts.length === 0) return void 0;
			const inputTokens = safeSum(attempts.map((attempt) => attempt.inputTokens));
			const outputTokens = safeSum(attempts.map((attempt) => attempt.outputTokens));
			const totalTokens = safeSum(attempts.map((attempt) => attempt.totalTokens));
			if (inputTokens === void 0 || outputTokens === void 0 || totalTokens === void 0) return void 0;
			const cacheRead = attempts.map((attempt) => attempt.cacheReadTokens);
			const cacheWrite = attempts.map((attempt) => attempt.cacheWriteTokens);
			const reasoning = attempts.map((attempt) => attempt.reasoningTokens);
			const cacheReadTokens = cacheRead.every(isCount) ? safeSum(cacheRead) : void 0;
			const cacheWriteTokens = cacheWrite.every(isCount) ? safeSum(cacheWrite) : void 0;
			const reasoningTokens = reasoning.every(isCount) ? safeSum(reasoning) : void 0;
			let routes;
			const attributed = attempts.map((attempt) => attempt.route);
			if (attributed.every((route) => route !== void 0)) {
				const unique = /* @__PURE__ */ new Map();
				for (const route of attributed) unique.set(`${route.provider}\0${route.model}`, route);
				routes = [...unique.values()];
			}
			return {
				uncachedInputTokens: inputTokens,
				outputTokens,
				totalTokens,
				...cacheReadTokens === void 0 ? {} : { cacheReadTokens },
				...cacheWriteTokens === void 0 ? {} : { cacheWriteTokens },
				...reasoningTokens === void 0 ? {} : { reasoningTokens },
				...routes === void 0 ? {} : { routes }
			};
		}
		function sameAttempt(state, turn, step) {
			return state.turn === turn && state.step === step;
		}
		/**
		* Fold one complete Turn's durable attempt lifecycle into exact token accounting.
		*
		* No attempt is inferred from a usage sample. Any missing lifecycle boundary,
		* incomplete attempt usage, unsafe count, or contradictory exact total makes
		* the whole disclosure unavailable.
		* @param events - Turn-local durable events from `turn/start` through `turn/end`.
		* @returns exact aggregate usage, or undefined when it cannot be proven.
		*/
		function deriveTurnTokenUsage(events) {
			let state = { kind: "idle" };
			const attempts = [];
			let turn;
			let sawEnd = false;
			let invalid = false;
			const closeOpen = (route) => {
				if (state.kind !== "open" || state.sample === void 0) return false;
				const normalized = normalizeUsage(state.sample, route);
				if (normalized === void 0) return false;
				attempts.push(normalized);
				return true;
			};
			for (const event of events) {
				if (invalid) break;
				if (event.type === "turn/start") {
					if (turn !== void 0 || state.kind !== "idle") invalid = true;
					else turn = event.data.turn;
					continue;
				}
				if (turn === void 0) {
					invalid = true;
					break;
				}
				if (event.type === "turn/end") {
					if (event.data.turn !== turn || state.kind !== "idle" || sawEnd) invalid = true;
					else sawEnd = true;
					continue;
				}
				if (sawEnd) {
					invalid = true;
					break;
				}
				if (event.type === "step/start") {
					if (event.data.turn !== turn || state.kind !== "idle") invalid = true;
					else state = {
						kind: "open",
						turn,
						step: event.data.step
					};
					continue;
				}
				if (event.type === "llm/retry-started") {
					if (event.data.turn !== turn || state.kind !== "settled" || state.by !== "retry" || !sameAttempt(state, event.data.turn, event.data.step)) invalid = true;
					else state = {
						kind: "open",
						turn,
						step: event.data.step
					};
					continue;
				}
				if (event.type === "assistant/chunk") {
					if (event.data.turn !== turn || state.kind !== "open" || !sameAttempt(state, event.data.turn, event.data.step)) {
						invalid = true;
						continue;
					}
					if (event.data.chunk.type === "usage") state = {
						...state,
						sample: event.data.chunk.usage
					};
					else if (event.data.chunk.type === "finish" && (event.data.chunk.reason.kind === "error" || event.data.chunk.reason.kind === "aborted")) if (!closeOpen()) invalid = true;
					else state = {
						kind: "finishClosed",
						turn,
						step: event.data.step
					};
					continue;
				}
				if (event.type === "assistant/message") {
					if (event.data.turn !== turn || state.kind !== "open" || !sameAttempt(state, event.data.turn, event.data.step)) {
						invalid = true;
						continue;
					}
					if (event.data.usage !== void 0) state = {
						...state,
						sample: event.data.usage
					};
					if (!closeOpen(messageRoute(event.data.message))) invalid = true;
					else state = {
						kind: "settled",
						turn,
						step: event.data.step,
						by: "message"
					};
					continue;
				}
				if (event.type === "llm/retry") {
					if (event.data.turn !== turn || state.kind === "idle" || !sameAttempt(state, event.data.turn, event.data.step)) {
						invalid = true;
						continue;
					}
					if (state.kind === "settled" || state.kind === "open" && !closeOpen()) invalid = true;
					if (!invalid) state = {
						kind: "settled",
						turn,
						step: event.data.step,
						by: "retry"
					};
					continue;
				}
				if (event.type === "step/end") {
					if (event.data.turn !== turn || state.kind === "idle" || !sameAttempt(state, event.data.turn, event.data.step)) {
						invalid = true;
						continue;
					}
					if (state.kind === "open" && !closeOpen()) invalid = true;
					if (!invalid) state = { kind: "idle" };
				}
			}
			return invalid || !sawEnd || state.kind !== "idle" ? void 0 : aggregateAttempts(attempts);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-tail.js
		function isSessionEvent(event) {
			return event.type !== "chunkrow/text-chunks" && event.type !== "chunkrow/reasoning-chunks" && event.type !== "chunkrow/tool-call-chunks";
		}
		function hasTextAssistant(event) {
			return event.type === "assistant/message" && isAppendSurfaceEvent(event) && toAssistantBlocks(event.data.message.content).some((block) => block.kind === "text" && block.text.trim() !== "");
		}
		function chunkHasText(event) {
			if (event.type === "chunkrow/text-chunks") return event.data.texts.some((text) => text.trim() !== "");
			if (event.type === "chunkrow/reasoning-chunks" || event.type === "chunkrow/tool-call-chunks") return false;
			if (event.type !== "assistant/chunk") return false;
			const chunk = event.data.chunk;
			if (chunk.type === "text-delta") return chunk.text.trim() !== "";
			return chunk.type === "block-end" && chunk.block.type === "text" && chunk.block.text.trim() !== "";
		}
		function turnCoordinates(event) {
			if (event.type === "assistant/message" || event.type === "assistant/chunk" || event.type === "step/start" || event.type === "chunkrow/text-chunks" || event.type === "chunkrow/reasoning-chunks" || event.type === "chunkrow/tool-call-chunks" || event.type === "step/end") return {
				turn: event.data.turn,
				step: event.data.step
			};
			if (event.type === "llm/retry" || event.type === "llm/retry-started") return {
				turn: event.data.turn,
				step: event.data.step
			};
		}
		function closingAnchor(context) {
			let anchor = context.matches.find((match) => match.event.type === "turn/end")?.event.seq ?? context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0;
			const steps = /* @__PURE__ */ new Map();
			for (const match of context.matches) {
				const event = match.event;
				if (event.type === "turn/end") continue;
				const coordinates = turnCoordinates(event);
				if (coordinates?.step === void 0) continue;
				const previous = steps.get(coordinates.step) ?? {
					streamedText: false,
					finalized: false
				};
				if (event.type === "assistant/chunk" || event.type === "chunkrow/text-chunks" || event.type === "chunkrow/reasoning-chunks" || event.type === "chunkrow/tool-call-chunks") {
					steps.set(coordinates.step, {
						...previous,
						streamedText: previous.streamedText || chunkHasText(event)
					});
					continue;
				}
				if (event.type === "assistant/message") {
					steps.set(coordinates.step, {
						streamedText: false,
						finalized: true
					});
					if (hasTextAssistant(event)) anchor = event.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup;
					continue;
				}
				if (event.type === "llm/retry") {
					steps.set(coordinates.step, {
						streamedText: false,
						finalized: false
					});
					continue;
				}
				if (event.type === "step/end" && previous.streamedText && !previous.finalized) anchor = event.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedFollowup;
			}
			return anchor;
		}
		function turnLocation(context) {
			const location = context.start?.location ?? context.matches[0]?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn : void 0;
		}
		function hasText(data) {
			return data.finalNode !== void 0 && data.blocks.some((block) => block.kind === "text" && block.text.trim() !== "");
		}
		function tailData(context) {
			const end = context.state?.end ?? context.matches.find((match) => match.event.type === "turn/end");
			if (end?.event.type !== "turn/end") return null;
			const turn = turnLocation(context);
			if (turn === void 0) return null;
			const finalized = turn.steps.map((step) => step.data.get("assistant-step")).filter((candidate) => candidate !== void 0).filter((candidate) => candidate.finalNode !== void 0).sort((left, right) => left.finalNode.seq - right.finalNode.seq);
			const closing = finalized.findLast(hasText) ?? null;
			let latestTranscriptSeq = finalized.at(-1)?.finalNode.seq;
			for (const match of context.matches) {
				const event = match.event;
				const candidate = event.type === "tool/call" || event.type === "tool/result" && isAppendSurfaceEvent(event) || event.type === "turn/end" && event.data.reason.kind === "error" || event.type === "llm/retry" ? event.seq : void 0;
				if (candidate !== void 0 && (latestTranscriptSeq === void 0 || candidate > latestTranscriptSeq)) latestTranscriptSeq = candidate;
			}
			const metrics = deriveTurnMetrics(finalized.map((candidate) => candidate.finalNode)).get(end.event.data.turn);
			const tokenUsage = context.start?.event.type === "turn/start" ? deriveTurnTokenUsage(context.matches.map((match) => match.event).filter(isSessionEvent)) : void 0;
			return {
				turn: end.event.data.turn,
				seq: end.event.seq,
				time: end.event.time,
				closing,
				branchUnavailable: closing === null || latestTranscriptSeq !== closing.finalNode.seq,
				...metrics?.ttftMs === void 0 ? {} : { ttftMs: metrics.ttftMs },
				...metrics?.tokensPerSecond === void 0 ? {} : { tokensPerSecond: metrics.tokensPerSecond },
				...tokenUsage === void 0 ? {} : { tokenUsage }
			};
		}
		/** Completed-turn footer Definition independent of any Assistant row. */
		const turnTailDefinition = {
			kind: "turn-tail",
			target: "chat",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "turn/end") return {
					id: String(event.data.turn),
					role: "update"
				};
				if (event.type === "tool/call" || event.type === "tool/result") return {
					id: String(event.data.turn),
					role: "update"
				};
				const coordinates = turnCoordinates(event);
				if (coordinates !== void 0) return {
					id: String(coordinates.turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("turn-tail start requires turn/start");
				return { turn: match.event.data.turn };
			},
			update: (context, match) => match.event.type === "turn/end" ? {
				...context.state,
				end: match
			} : context.state,
			publication: (match) => match.event.type === "turn/end" ? "immediate" : "none",
			buildLocationData: (context, scope) => {
				if (scope !== "turn") return null;
				const value = tailData(context);
				return value === null ? null : {
					kind: "turn",
					turn: value.turn,
					key: "turn-tail",
					value
				};
			},
			buildViewNode: (context) => {
				const data = turnLocation(context)?.data.get("turn-tail");
				return data === void 0 ? null : chatNode(context, "turn-tail", closingAnchor(context), data);
			}
		};
		/**
		* Register completed-Turn footer data and its Chat node contribution.
		* @param ctx - owning UI Conversation context.
		*/
		function registerTurnTailConversationNode(ctx) {
			ctx.uiConversation.events.register(turnTailDefinition);
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/register.js
		/**
		* Register the Chat business Definitions and target builder contributed by this package.
		* @param ctx - owning UI Conversation context.
		*/
		function registerConversationNodes(ctx) {
			registerInboxConversationNodes(ctx);
			registerMessageConversationNode(ctx);
			registerRequestPromptConversationNode(ctx);
			registerAssistantConversationNode(ctx);
			registerTurnProcess(ctx);
			registerToolConversationNode(ctx);
			registerCommandConversationNode(ctx);
			registerCompactionConversationNode(ctx);
			registerRetryConversationNode(ctx);
			registerTurnErrorConversationNode(ctx);
			registerTurnMaxTokensConversationNode(ctx);
			registerTurnTailConversationNode(ctx);
			registerUnknownConversationFallback(ctx);
			registerChatConversationView(ctx);
		}
		//#endregion
		//#region lib/types/client/details/tool-node-reader.js
		function toolNode(node) {
			return node?.kind === "tool-call" ? node : void 0;
		}
		/**
		* Find any root or nested Tool lifecycle through the internal Node store.
		* @param snapshot - current Conversation snapshot.
		* @param callId - root or nested call identity.
		* @returns current Tool lifecycle when materialized in the loaded window.
		*/
		function findToolCall(snapshot, callId) {
			const visit = (block) => {
				if (block.callId === callId) return block;
				for (const child of block.subCalls) {
					const found = visit(child);
					if (found !== void 0) return found;
				}
			};
			for (const node of snapshot.nodes.values()) {
				const root = toolNode(node)?.data.root;
				if (root === void 0) continue;
				const found = visit(root);
				if (found !== void 0) return found;
			}
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/details/DetailsPanel.module.css.mjs
		const css$1 = ".QN9_7W_root{border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);flex-direction:column;min-width:0;height:100%;display:flex}.QN9_7W_header{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:8px;padding:14px 12px 12px;display:flex}.QN9_7W_title{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.QN9_7W_close{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;display:grid}.QN9_7W_close:hover{background:var(--dsw-alias-interactive-bg-hover)}.QN9_7W_body{flex:1;min-height:0;padding:12px 16px;overflow-y:auto}.QN9_7W_empty{color:var(--dsw-alias-label-tertiary);padding:8px 0;font-size:13px;line-height:20px}.QN9_7W_section{margin-bottom:16px}.QN9_7W_sectionLabel{color:var(--dsw-alias-label-secondary);margin-bottom:6px;font-size:12px;font-weight:500;line-height:18px}.QN9_7W_code{background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;border-radius:12px;margin:0;padding:16px;font-size:13px;line-height:22px}.QN9_7W_code[data-error]{color:var(--dsw-alias-state-error-primary)}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-chat/DetailsPanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var DetailsPanel_module_css_default = {
			"body": "QN9_7W_body",
			"close": "QN9_7W_close",
			"code": "QN9_7W_code",
			"empty": "QN9_7W_empty",
			"header": "QN9_7W_header",
			"root": "QN9_7W_root",
			"section": "QN9_7W_section",
			"sectionLabel": "QN9_7W_sectionLabel",
			"title": "QN9_7W_title"
		};
		//#endregion
		//#region lib/types/client/details/DetailsPanel.js
		function settledMaterial(node, callId) {
			return {
				name: node.call?.name ?? callId,
				argsRaw: node.call?.argsRaw ?? null,
				block: node
			};
		}
		function runningMaterial(call) {
			return {
				name: call.name,
				argsRaw: call.argsRaw,
				block: call
			};
		}
		function materialFor(s, callId) {
			const found = findToolCall(s, callId);
			if (found === void 0) return null;
			return "kind" in found ? settledMaterial(found, callId) : runningMaterial(found);
		}
		function pretty(raw) {
			try {
				return JSON.stringify(JSON.parse(raw), null, 2);
			} catch {
				return raw;
			}
		}
		/** Flatten a settled result for the no-ui-tool fallback. */
		function rawResultText(block) {
			if (!("kind" in block)) return "";
			const parts = block.content.map((item) => item.type === "text" ? item.text : JSON.stringify(item, null, 2));
			if (parts.length === 0 && block.error !== void 0) parts.push(`${block.error.name}: ${block.error.code}`);
			return parts.join("\n");
		}
		function DetailsPanel({ useChat, useSessions, sessionId, useStore, renderSlot, closeDetails, t }) {
			const selection = useStore((s) => s.selection);
			const sessionCwd = useSessions((list) => list.byId[sessionId]?.cwd);
			const callId = selection?.callId;
			const material = useChat((s) => callId === void 0 ? null : materialFor(s, callId), (a, b) => (0, _deepseek_ai_dsh_client_store.shallowEqual)(a, b));
			return (0, react_jsx_runtime.jsxs)("div", {
				className: DetailsPanel_module_css_default.root,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: DetailsPanel_module_css_default.header,
					children: [(0, react_jsx_runtime.jsx)("div", {
						className: DetailsPanel_module_css_default.title,
						children: selection === null ? t("details.title") : material?.name ?? selection.toolName ?? t("details.title")
					}), (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: DetailsPanel_module_css_default.close,
						"aria-label": t("details.close"),
						onClick: () => {
							closeDetails();
						},
						children: (0, react_jsx_runtime.jsx)("svg", {
							viewBox: "0 0 16 16",
							width: "14",
							height: "14",
							"aria-hidden": true,
							children: (0, react_jsx_runtime.jsx)("path", {
								d: "M4 4l8 8M12 4l-8 8",
								stroke: "currentColor",
								strokeWidth: "1.5",
								strokeLinecap: "round"
							})
						})
					})]
				}), (0, react_jsx_runtime.jsx)("div", {
					className: DetailsPanel_module_css_default.body,
					children: selection === null || callId === void 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: DetailsPanel_module_css_default.empty,
						children: t("details.empty")
					}) : material === null ? (0, react_jsx_runtime.jsx)("div", {
						className: DetailsPanel_module_css_default.empty,
						children: t("details.notInWindow")
					}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [material.argsRaw !== null && (0, react_jsx_runtime.jsxs)("section", {
						className: DetailsPanel_module_css_default.section,
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: DetailsPanel_module_css_default.sectionLabel,
							children: t("details.input")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.CodeBlock, {
							code: pretty(material.argsRaw),
							lang: "json",
							copyLabel: t("copy"),
							copiedLabel: t("copied")
						})]
					}), (0, react_jsx_runtime.jsxs)("section", {
						className: DetailsPanel_module_css_default.section,
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: DetailsPanel_module_css_default.sectionLabel,
							children: t("details.output")
						}), (0, react_jsx_runtime.jsx)(react.Fragment, { children: renderSlot("conversation.details.tool", {
							block: material.block,
							cwd: sessionCwd
						}, { fallback: "kind" in material.block ? (0, react_jsx_runtime.jsx)("pre", {
							className: DetailsPanel_module_css_default.code,
							"data-error": material.block.isError || void 0,
							children: rawResultText(material.block)
						}) : (0, react_jsx_runtime.jsx)("div", {
							className: DetailsPanel_module_css_default.empty,
							children: t("details.running")
						}) }) }, callId)]
					})] })
				})]
			});
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-chat/src/client/settings/TranscriptViewRow.module.css.mjs
		const css = ".rCQQpG_row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.rCQQpG_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.rCQQpG_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.rCQQpG_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.rCQQpG_selector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.rCQQpG_selector:hover{background:var(--dsw-alias-interactive-bg-hover)}.rCQQpG_chevron{flex:none}";
		const tagId = "@deepseek-ai/dsh-client-ui-chat/TranscriptViewRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var TranscriptViewRow_module_css_default = {
			"chevron": "rCQQpG_chevron",
			"desc": "rCQQpG_desc",
			"row": "rCQQpG_row",
			"rowText": "rCQQpG_rowText",
			"selector": "rCQQpG_selector",
			"title": "rCQQpG_title"
		};
		//#endregion
		//#region lib/types/client/settings/TranscriptViewRow.js
		/** General Settings row for completed-Turn transcript presentation. */
		const OPTIONS = [{
			id: "normal",
			label: "settings.transcript.normal"
		}, {
			id: "compact",
			label: "settings.transcript.compact"
		}];
		/**
		* Render the completed-Turn transcript mode selector.
		* @param props - composed Settings slot props.
		* @returns the preference row.
		*/
		function TranscriptViewRow({ useTranscriptView, setTranscriptView, t }) {
			const mode = useTranscriptView((value) => value);
			const [open, setOpen] = (0, react.useState)(false);
			const selectedLabel = mode === "normal" ? "settings.transcript.normal" : "settings.transcript.compact";
			const closeMenu = () => {
				setOpen(false);
			};
			const selectMode = (id) => {
				closeMenu();
				setTranscriptView(id);
			};
			const selector = (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: TranscriptViewRow_module_css_default.selector,
				"aria-haspopup": "menu",
				"aria-expanded": open,
				onClick: () => {
					setOpen((value) => !value);
				},
				children: [t(selectedLabel), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: TranscriptViewRow_module_css_default.chevron })]
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				className: TranscriptViewRow_module_css_default.row,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: TranscriptViewRow_module_css_default.rowText,
					children: [(0, react_jsx_runtime.jsx)("div", {
						className: TranscriptViewRow_module_css_default.title,
						children: t("settings.transcript.title")
					}), (0, react_jsx_runtime.jsx)("div", {
						className: TranscriptViewRow_module_css_default.desc,
						children: t("settings.transcript.description")
					})]
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
					open,
					onClose: closeMenu,
					items: OPTIONS.map((option) => ({
						id: option.id,
						label: t(option.label)
					})),
					selectedId: mode,
					onSelect: selectMode,
					align: "end",
					portal: true,
					anchor: selector
				})]
			});
		}
		//#endregion
		//#region ../../../vendor/cosmokit/src/misc.ts
		/** Return true when a value is `null` or `undefined`. */
		function isNullable(value) {
			return value === null || value === void 0;
		}
		/** Return true for non-array object values. */
		function isPlainObject(data) {
			return data && typeof data === "object" && !Array.isArray(data);
		}
		/** Filter object entries and return a new object. */
		function filterKeys(object, filter) {
			return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
		}
		/** Map object values while preserving the original key set. */
		function mapValues(object, transform) {
			return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
		}
		/** Pick selected keys from an object, optionally including `undefined` values. */
		function pick(source, keys, forced) {
			if (!keys) return { ...source };
			const result = {};
			for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
			return result;
		}
		//#endregion
		//#region ../../../vendor/cosmokit/src/types.ts
		/** Test values using `instanceof` with a `toStringTag` fallback. */
		function is(type, value) {
			if (arguments.length === 1) return (value) => is(type, value);
			return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
		}
		function isArrayBufferLike(value) {
			return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
		}
		function isArrayBufferSource(value) {
			return isArrayBufferLike(value) || ArrayBuffer.isView(value);
		}
		let Binary;
		(function(_Binary) {
			_Binary.is = isArrayBufferLike;
			_Binary.isSource = isArrayBufferSource;
			function fromSource(source) {
				if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
				else return source;
			}
			_Binary.fromSource = fromSource;
			function toBase64(source) {
				source = fromSource(source);
				if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
				let binary = "";
				const bytes = new Uint8Array(source);
				for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
				return btoa(binary);
			}
			_Binary.toBase64 = toBase64;
			function fromBase64(source) {
				if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
				return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
			}
			_Binary.fromBase64 = fromBase64;
			function toHex(source) {
				source = fromSource(source);
				if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
				return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
			}
			_Binary.toHex = toHex;
			function fromHex(source) {
				if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
				const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
				const buffer = [];
				for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
				return Uint8Array.from(buffer).buffer;
			}
			_Binary.fromHex = fromHex;
		})(Binary || (Binary = {}));
		Binary.fromBase64;
		Binary.toBase64;
		Binary.fromHex;
		Binary.toHex;
		/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
		function clone(source, refs = /* @__PURE__ */ new Map()) {
			if (!source || typeof source !== "object") return source;
			if (is("Date", source)) return new Date(source.valueOf());
			if (is("RegExp", source)) return new RegExp(source.source, source.flags);
			if (isArrayBufferLike(source)) return source.slice(0);
			if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
			const cached = refs.get(source);
			if (cached) return cached;
			if (Array.isArray(source)) {
				const result = [];
				refs.set(source, result);
				source.forEach((value, index) => {
					result[index] = Reflect.apply(clone, null, [value, refs]);
				});
				return result;
			}
			const result = Object.create(Object.getPrototypeOf(source));
			refs.set(source, result);
			for (const key of Reflect.ownKeys(source)) {
				const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
				if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
				Reflect.defineProperty(result, key, descriptor);
			}
			return result;
		}
		/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
		function deepEqual(a, b, strict) {
			if (a === b) return true;
			if (!strict && isNullable(a) && isNullable(b)) return true;
			if (typeof a !== typeof b) return false;
			if (typeof a !== "object") return false;
			if (!a || !b) return false;
			function check(test, then) {
				return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
			}
			return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? Object.keys({
				...a,
				...b
			}).every((key) => deepEqual(a[key], b[key], strict));
		}
		//#endregion
		//#region ../../../vendor/cosmokit/src/time.ts
		let Time;
		(function(_Time) {
			_Time.millisecond = 1;
			const second = _Time.second = 1e3;
			const minute = _Time.minute = second * 60;
			const hour = _Time.hour = minute * 60;
			const day = _Time.day = hour * 24;
			const week = _Time.week = day * 7;
			let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
			function setTimezoneOffset(offset) {
				timezoneOffset = offset;
			}
			_Time.setTimezoneOffset = setTimezoneOffset;
			function getTimezoneOffset() {
				return timezoneOffset;
			}
			_Time.getTimezoneOffset = getTimezoneOffset;
			function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
				if (typeof date === "number") date = new Date(date);
				if (offset === void 0) offset = timezoneOffset;
				return Math.floor((date.valueOf() / minute - offset) / 1440);
			}
			_Time.getDateNumber = getDateNumber;
			function fromDateNumber(value, offset) {
				const date = new Date(value * day);
				if (offset === void 0) offset = timezoneOffset;
				return new Date(+date + offset * minute);
			}
			_Time.fromDateNumber = fromDateNumber;
			const numeric = /\d+(?:\.\d+)?/.source;
			const timeRegExp = new RegExp(`^${[
				"w(?:eek(?:s)?)?",
				"d(?:ay(?:s)?)?",
				"h(?:our(?:s)?)?",
				"m(?:in(?:ute)?(?:s)?)?",
				"s(?:ec(?:ond)?(?:s)?)?"
			].map((unit) => `(${numeric}${unit})?`).join("")}$`);
			function parseTime(source) {
				const capture = timeRegExp.exec(source);
				if (!capture) return 0;
				return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
			}
			_Time.parseTime = parseTime;
			function parseDate(date) {
				const parsed = parseTime(date);
				if (parsed) date = Date.now() + parsed;
				else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
				else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
				return date ? new Date(date) : /* @__PURE__ */ new Date();
			}
			_Time.parseDate = parseDate;
			function format(ms) {
				const abs = Math.abs(ms);
				if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
				else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
				else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
				else if (abs >= second) return Math.round(ms / second) + "s";
				return ms + "ms";
			}
			_Time.format = format;
			function toDigits(source, length = 2) {
				return source.toString().padStart(length, "0");
			}
			_Time.toDigits = toDigits;
			function template(template, time = /* @__PURE__ */ new Date()) {
				return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
			}
			_Time.template = template;
		})(Time || (Time = {}));
		//#endregion
		//#region ../../../vendor/schemastery/src/index.ts
		const kSchema = Symbol.for("schemastery");
		const kValidationError = Symbol.for("ValidationError");
		globalThis.__schemastery_index__ ??= 0;
		globalThis.__schemastery_refs__ = void 0;
		var ValidationError = class extends TypeError {
			options;
			name = "ValidationError";
			constructor(message, options) {
				let prefix = "$";
				for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
				else if (typeof segment === "number") prefix += "[" + segment + "]";
				else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
				if (prefix.startsWith(".")) prefix = prefix.slice(1);
				super((prefix === "$" ? "" : `${prefix} `) + message);
				this.options = options;
			}
			static is(error) {
				return !!error?.[kValidationError];
			}
		};
		Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
		const Schema = function(options) {
			const schema = function(data, options = {}) {
				return Schema.resolve(data, schema, options)[0];
			};
			if (options.refs) {
				const refs = mapValues(options.refs, (options) => new Schema(options));
				const getRef = (uid) => refs[uid];
				for (const key in refs) {
					const options = refs[key];
					options.sKey = getRef(options.sKey);
					options.inner = getRef(options.inner);
					options.list = options.list && options.list.map(getRef);
					options.dict = options.dict && mapValues(options.dict, getRef);
				}
				return refs[options.uid];
			}
			Object.assign(schema, options);
			if (typeof schema.callback === "string") try {
				schema.callback = new Function("return " + schema.callback)();
			} catch {}
			Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
			Object.setPrototypeOf(schema, Schema.prototype);
			schema.meta ||= {};
			schema.toString = schema.toString.bind(schema);
			return schema;
		};
		Schema.prototype = Object.create(Function.prototype);
		Schema.prototype[kSchema] = true;
		Object.defineProperty(Schema.prototype, "~standard", { get() {
			return {
				version: 1,
				vendor: "schemastery",
				validate: (value) => {
					try {
						return { value: Schema.resolve(value, this, {})[0] };
					} catch (error) {
						if (ValidationError.is(error)) return { issues: [{
							message: error.message,
							path: error.options.path
						}] };
						throw error;
					}
				}
			};
		} });
		Schema.ValidationError = ValidationError;
		Schema.prototype.toJSON = function toJSON() {
			if (globalThis.__schemastery_refs__) {
				globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
				return this.uid;
			}
			globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
			globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
			const result = {
				uid: this.uid,
				refs: globalThis.__schemastery_refs__
			};
			globalThis.__schemastery_refs__ = void 0;
			return result;
		};
		Schema.prototype.set = function set(key, value) {
			this.dict[key] = value;
			return this;
		};
		Schema.prototype.push = function push(value) {
			this.list.push(value);
			return this;
		};
		function mergeDesc(original, messages) {
			const result = typeof original === "string" ? { "": original } : { ...original };
			for (const locale in messages) {
				const value = messages[locale];
				if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
				else if (typeof value === "string") result[locale] = value;
			}
			return result;
		}
		function getInner(value) {
			return value?.$value ?? value?.$inner;
		}
		function extractKeys(data) {
			return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
		}
		Schema.prototype.i18n = function i18n(messages) {
			const schema = Schema(this);
			const desc = mergeDesc(schema.meta.description, messages);
			if (Object.keys(desc).length) schema.meta.description = desc;
			if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
				return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
			});
			if (schema.list) schema.list = schema.list.map((inner, index) => {
				return inner.i18n(mapValues(messages, (data = {}) => {
					if (Array.isArray(getInner(data))) return getInner(data)[index];
					if (Array.isArray(data)) return data[index];
					return extractKeys(data);
				}));
			});
			if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
				if (getInner(data)) return getInner(data);
				return extractKeys(data);
			}));
			if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
			return schema;
		};
		Schema.prototype.extra = function extra(key, value) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		};
		for (const key of [
			"required",
			"disabled",
			"collapse",
			"hidden",
			"loose"
		]) Object.assign(Schema.prototype, { [key](value = true) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		} });
		Schema.prototype.deprecated = function deprecated() {
			const schema = Schema(this);
			schema.meta.badges ||= [];
			schema.meta.badges.push({
				text: "deprecated",
				type: "danger"
			});
			return schema;
		};
		Schema.prototype.experimental = function experimental() {
			const schema = Schema(this);
			schema.meta.badges ||= [];
			schema.meta.badges.push({
				text: "experimental",
				type: "warning"
			});
			return schema;
		};
		Schema.prototype.pattern = function pattern(regexp) {
			const schema = Schema(this);
			const pattern = pick(regexp, ["source", "flags"]);
			schema.meta = {
				...schema.meta,
				pattern
			};
			return schema;
		};
		Schema.prototype.simplify = function simplify(value) {
			if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
			if (isNullable(value)) return value;
			if (this.type === "object" || this.type === "dict") {
				const result = {};
				for (const key in value) {
					const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
					if (this.type === "dict" || !isNullable(item)) result[key] = item;
				}
				if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
				return result;
			} else if (this.type === "array" || this.type === "tuple") {
				const result = [];
				value.forEach((value, index) => {
					const schema = this.type === "array" ? this.inner : this.list[index];
					const item = schema ? schema.simplify(value) : value;
					result.push(item);
				});
				return result;
			} else if (this.type === "intersect") {
				const result = {};
				for (const item of this.list) Object.assign(result, item.simplify(value));
				return result;
			} else if (this.type === "union") for (const schema of this.list) try {
				Schema.resolve(value, schema, {});
				return schema.simplify(value);
			} catch {}
			return value;
		};
		Schema.prototype.toString = function toString(inline) {
			return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
		};
		Schema.prototype.role = function role(role, extra) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				role,
				extra
			};
			return schema;
		};
		for (const key of [
			"default",
			"link",
			"comment",
			"description",
			"max",
			"min",
			"step"
		]) Object.assign(Schema.prototype, { [key](value) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		} });
		const resolvers = {};
		Schema.extend = function extend(type, resolve) {
			resolvers[type] = resolve;
		};
		Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
			if (!schema) return [data];
			if (options.ignore?.(data, schema)) return [data];
			if (isNullable(data) && schema.type !== "lazy") {
				if (schema.meta.required) throw new ValidationError(`missing required value`, options);
				let current = schema;
				let fallback = schema.meta.default;
				while (current?.type === "intersect" && isNullable(fallback)) {
					current = current.list[0];
					fallback = current?.meta.default;
				}
				if (isNullable(fallback)) return [data];
				data = clone(fallback);
			}
			const callback = resolvers[schema.type];
			if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
			try {
				return callback(data, schema, options, strict);
			} catch (error) {
				if (!schema.meta.loose) throw error;
				return [schema.meta.default];
			}
		};
		Schema.from = function from(source) {
			if (isNullable(source)) return Schema.any();
			else if ([
				"string",
				"number",
				"boolean"
			].includes(typeof source)) return Schema.const(source).required();
			else if (source[kSchema]) return source;
			else if (typeof source === "function") switch (source) {
				case String: return Schema.string().required();
				case Number: return Schema.number().required();
				case Boolean: return Schema.boolean().required();
				case Function: return Schema.function().required();
				default: return Schema.is(source).required();
			}
			else throw new TypeError(`cannot infer schema from ${source}`);
		};
		Schema.lazy = function lazy(builder) {
			const toJSON = () => {
				if (!schema.inner[kSchema]) {
					schema.inner = schema.builder();
					schema.inner.meta = {
						...schema.meta,
						...schema.inner.meta
					};
				}
				return schema.inner.toJSON();
			};
			const schema = new Schema({
				type: "lazy",
				builder,
				inner: { toJSON }
			});
			return schema;
		};
		Schema.natural = function natural() {
			return Schema.number().step(1).min(0);
		};
		Schema.percent = function percent() {
			return Schema.number().step(.01).min(0).max(1).role("slider");
		};
		Schema.date = function date() {
			return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
				const date = new Date(value);
				if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
				return date;
			}, true)]);
		};
		Schema.regExp = function regExp(flag = "") {
			return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
				try {
					return new RegExp(value, flag);
				} catch (e) {
					throw new ValidationError(e.message, options);
				}
			}, true)]);
		};
		Schema.arrayBuffer = function arrayBuffer(encoding) {
			return Schema.union([
				Schema.is(ArrayBuffer),
				Schema.is(SharedArrayBuffer),
				Schema.transform(Schema.any(), (value, options) => {
					if (Binary.isSource(value)) return Binary.fromSource(value);
					throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
				}, true),
				...encoding ? [Schema.transform(Schema.string(), (value, options) => {
					try {
						return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
					} catch (e) {
						throw new ValidationError(e.message, options);
					}
				}, true)] : []
			]);
		};
		Schema.extend("lazy", (data, schema, options, strict) => {
			if (!schema.inner[kSchema]) {
				schema.inner = schema.builder();
				schema.inner.meta = {
					...schema.meta,
					...schema.inner.meta
				};
			}
			return Schema.resolve(data, schema.inner, options, strict);
		});
		Schema.extend("any", (data) => {
			return [data];
		});
		Schema.extend("never", (data, _, options) => {
			throw new ValidationError(`expected nullable but got ${data}`, options);
		});
		Schema.extend("const", (data, { value }, options) => {
			if (deepEqual(data, value)) return [value];
			throw new ValidationError(`expected ${value} but got ${data}`, options);
		});
		function checkWithinRange(data, meta, description, options, skipMin = false) {
			const { max = Infinity, min = -Infinity } = meta;
			if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
			if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
		}
		Schema.extend("string", (data, { meta }, options) => {
			if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
			if (meta.pattern) {
				const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
				if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
			}
			checkWithinRange(data.length, meta, "string length", options);
			return [data];
		});
		function decimalShift(data, digits) {
			const str = data.toString();
			if (str.includes("e")) return data * Math.pow(10, digits);
			const index = str.indexOf(".");
			if (index === -1) return data * Math.pow(10, digits);
			const frac = str.slice(index + 1);
			const integer = str.slice(0, index);
			if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
			return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
		}
		function isMultipleOf(data, min, step) {
			step = Math.abs(step);
			if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
			const index = step.toString().indexOf(".");
			const digits = step.toString().slice(index + 1).length;
			return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
		}
		Schema.extend("number", (data, { meta }, options) => {
			if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
			checkWithinRange(data, meta, "number", options);
			const { step } = meta;
			if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
			return [data];
		});
		Schema.extend("boolean", (data, _, options) => {
			if (typeof data === "boolean") return [data];
			throw new ValidationError(`expected boolean but got ${data}`, options);
		});
		Schema.extend("bitset", (data, { bits, meta }, options) => {
			let value = 0, keys = [];
			if (typeof data === "number") {
				value = data;
				for (const key in bits) if (data & bits[key]) keys.push(key);
			} else if (Array.isArray(data)) {
				keys = data;
				for (const key of keys) {
					if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
					if (key in bits) value |= bits[key];
				}
			} else throw new ValidationError(`expected number or array but got ${data}`, options);
			if (value === meta.default) return [value];
			return [value, keys];
		});
		Schema.extend("function", (data, _, options) => {
			if (typeof data === "function") return [data];
			throw new ValidationError(`expected function but got ${data}`, options);
		});
		Schema.extend("is", (data, { constructor }, options) => {
			if (typeof constructor === "function") {
				if (data instanceof constructor) return [data];
				throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
			} else {
				if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
				let prototype = Object.getPrototypeOf(data);
				while (prototype) {
					if (prototype.constructor?.name === constructor) return [data];
					prototype = Object.getPrototypeOf(prototype);
				}
				throw new ValidationError(`expected ${constructor} but got ${data}`, options);
			}
		});
		function property(data, key, schema, options) {
			try {
				const [value, adapted] = Schema.resolve(data[key], schema, {
					...options,
					path: [...options.path || [], key]
				});
				if (adapted !== void 0) data[key] = adapted;
				return value;
			} catch (e) {
				if (!options?.autofix) throw e;
				delete data[key];
				return schema.meta.default;
			}
		}
		Schema.extend("array", (data, { inner, meta }, options) => {
			if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
			checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
			return [data.map((_, index) => property(data, index, inner, options))];
		});
		Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
			if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
			const result = {};
			for (const key in data) {
				let rKey;
				try {
					rKey = Schema.resolve(key, sKey, options)[0];
				} catch (error) {
					if (strict) continue;
					throw error;
				}
				result[rKey] = property(data, key, inner, options);
				data[rKey] = data[key];
				if (key !== rKey) delete data[key];
			}
			return [result];
		});
		Schema.extend("tuple", (data, { list }, options, strict) => {
			if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
			const result = list.map((inner, index) => property(data, index, inner, options));
			if (strict) return [result];
			result.push(...data.slice(list.length));
			return [result];
		});
		function merge(result, data) {
			for (const key in data) {
				if (key in result) continue;
				result[key] = data[key];
			}
		}
		Schema.extend("object", (data, { dict }, options, strict) => {
			if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
			const result = {};
			for (const key in dict) {
				const value = property(data, key, dict[key], options);
				if (!isNullable(value) || key in data) result[key] = value;
			}
			if (!strict) merge(result, data);
			return [result];
		});
		Schema.extend("union", (data, { list, toString }, options, strict) => {
			const messages = [];
			for (const inner of list) try {
				return Schema.resolve(data, inner, options, strict);
			} catch (error) {
				messages.push(error);
			}
			throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		});
		Schema.extend("intersect", (data, { list, toString }, options, strict) => {
			if (!list.length) return [data];
			let result;
			for (const inner of list) {
				const value = Schema.resolve(data, inner, options, true)[0];
				if (isNullable(value)) continue;
				if (isNullable(result)) result = value;
				else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
				else if (typeof value === "object") merge(result ??= {}, value);
				else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
			}
			if (!strict && isPlainObject(data)) merge(result, data);
			return [result];
		});
		Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
			const [result, adapted = data] = Schema.resolve(data, inner, options, true);
			if (preserve) return [callback(result)];
			else return [callback(result), callback(adapted)];
		});
		const formatters = {};
		function defineMethod(name, keys, format) {
			formatters[name] = format;
			Object.assign(Schema, { [name](...args) {
				const schema = new Schema({ type: name });
				keys.forEach((key, index) => {
					switch (key) {
						case "sKey":
							schema.sKey = args[index] ?? Schema.string();
							break;
						case "inner":
							schema.inner = Schema.from(args[index]);
							break;
						case "list":
							schema.list = args[index].map(Schema.from);
							break;
						case "dict":
							schema.dict = mapValues(args[index], Schema.from);
							break;
						case "bits":
							schema.bits = {};
							for (const key in args[index]) {
								if (typeof args[index][key] !== "number") continue;
								schema.bits[key] = args[index][key];
							}
							break;
						case "callback": {
							const callback = schema.callback = args[index];
							callback["toJSON"] ||= () => callback.toString();
							break;
						}
						case "constructor": {
							const constructor = schema.constructor = args[index];
							if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
							break;
						}
						default: schema[key] = args[index];
					}
				});
				if (name === "object" || name === "dict") schema.meta.default = {};
				else if (name === "array" || name === "tuple") schema.meta.default = [];
				else if (name === "bitset") schema.meta.default = 0;
				return schema;
			} });
		}
		defineMethod("is", ["constructor"], ({ constructor }) => {
			if (typeof constructor === "function") return constructor.name;
			else return constructor;
		});
		defineMethod("any", [], () => "any");
		defineMethod("never", [], () => "never");
		defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
		defineMethod("string", [], () => "string");
		defineMethod("number", [], () => "number");
		defineMethod("boolean", [], () => "boolean");
		defineMethod("bitset", ["bits"], () => "bitset");
		defineMethod("function", [], () => "function");
		defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
		defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
		defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
		defineMethod("object", ["dict"], ({ dict }) => {
			if (Object.keys(dict).length === 0) return "{}";
			return `{ ${Object.entries(dict).map(([key, inner]) => {
				return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
			}).join(", ")} }`;
		});
		defineMethod("union", ["list"], ({ list }, inline) => {
			const result = list.map(({ toString: format }) => format()).join(" | ");
			return inline ? `(${result})` : result;
		});
		defineMethod("intersect", ["list"], ({ list }) => {
			return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
		});
		defineMethod("transform", [
			"inner",
			"callback",
			"preserve"
		], ({ inner }, isInner) => inner.toString(isInner));
		//#endregion
		//#region lib/types/chat-settings.js
		/** Chat transcript preferences stored in the Host user-settings document. */
		/** Settings namespace owned by the Chat target. */
		const CHAT_SETTINGS_NAMESPACE = "ui-chat";
		/** Field carrying the completed-Turn transcript presentation mode. */
		const TRANSCRIPT_VIEW_FIELD = "transcriptView";
		/** Transcript presentation modes accepted at settings boundaries. */
		const TRANSCRIPT_VIEW_MODES = ["normal", "compact"];
		/** Default preserves the compact process disclosure introduced by Chat. */
		const DEFAULT_TRANSCRIPT_VIEW_MODE = "compact";
		Schema.object({ [TRANSCRIPT_VIEW_FIELD]: Schema.union([...TRANSCRIPT_VIEW_MODES]).default(DEFAULT_TRANSCRIPT_VIEW_MODE) });
		//#endregion
		//#region lib/types/client/transcript-view.js
		/** Host-backed completed-Turn transcript presentation policy. */
		/** Live transcript preference consumed by Chat and its Settings row. */
		var TranscriptViewPolicy = class {
			host;
			/** Reactive current mode; defaults to Compact before Host settings arrive. */
			mode = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(DEFAULT_TRANSCRIPT_VIEW_MODE);
			/**
			* @param host - durable Chat settings scope.
			*/
			constructor(host) {
				this.host = host;
				host.subscribe(() => {
					this.adopt();
				});
				this.adopt();
			}
			/**
			* Publish and persist one explicit user choice.
			* @param mode - Normal or Compact transcript presentation.
			*/
			setMode(mode) {
				if (this.mode.getSnapshot() === mode) return;
				this.mode.set(mode);
				this.host.set(TRANSCRIPT_VIEW_FIELD, mode);
			}
			/** Adopt the latest accepted Host section without writing it back. */
			adopt() {
				const section = this.host.getSnapshot().value;
				if (section === void 0 || this.mode.getSnapshot() === section.transcriptView) return;
				this.mode.set(section.transcriptView);
			}
		};
		//#endregion
		//#region lib/types/client/apply.js
		const CHAT_NODE_INJECT = { hooks: { turnData: ({ useChat }, nodeKey) => function useTurnData(key) {
			return useChat((snapshot) => {
				const location = snapshot.nodes.get(nodeKey)?.location;
				return location?.kind === "turn" || location?.kind === "step" ? location.turn.data.get(key) : void 0;
			});
		} } };
		/** Services required by the Chat target and its presentation registrations. */
		const inject = [
			"slots",
			"sessions",
			"uiSession",
			"uiConversation",
			"layout",
			"locale",
			"settingsScope",
			"remote",
			"remote.session"
		];
		/**
		* Mount all Chat-owned contributions.
		* @param ctx - Client root context.
		*/
		function apply(ctx) {
			const chatSources = /* @__PURE__ */ new WeakMap();
			const chatSource = (binding) => {
				let source = chatSources.get(binding);
				if (source === void 0) {
					const target = ctx.uiConversation.binding(binding).target("chat");
					source = {
						getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
						subscribe: (listener) => target.subscribe(listener)
					};
					chatSources.set(binding, source);
				}
				return source;
			};
			registerConversationNodes(ctx);
			registerChatNodeRenderers(ctx);
			ctx.uiSession.provide({
				hooks: ["chat"],
				resolve: (binding) => ({ hooks: { chat: chatSource(binding) } })
			});
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-chat: dictionaries");
			const t = ctx.locale.bind(NS);
			const chatStore = createChatStore();
			const chatScrollPositions = /* @__PURE__ */ new Map();
			const transcriptView = new TranscriptViewPolicy(ctx.settingsScope.bind({ namespace: CHAT_SETTINGS_NAMESPACE }));
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "transcript-view",
				order: 12,
				locale: NS,
				inject: () => ({
					hooks: { transcriptView: transcriptView.mode },
					setTranscriptView: (mode) => {
						transcriptView.setMode(mode);
					}
				})
			}, TranscriptViewRow));
			ctx.slots.inject("conversation.view", () => {
				return ctx.slots.register({
					name: "conversation.view",
					id: "chat",
					order: 0,
					label: () => t("view.chat"),
					locale: NS,
					children: {
						"conversation.chat.node": {
							kind: "keyed",
							scope: "session",
							inject: CHAT_NODE_INJECT
						},
						"conversation.message.images": {
							kind: "single",
							scope: "session"
						}
					},
					store: chatStore,
					inject: (sessionId, actions) => {
						const session = ctx.sessions.binding(sessionId)?.session;
						if (session === void 0) throw new Error(`ui-chat: unknown session "${sessionId}"`);
						return {
							hooks: { transcriptView: transcriptView.mode },
							openDetails: (target) => {
								actions.select(target);
								ctx.layout.openDetails();
							},
							fileMentions: (owner) => ctx.get("chatFileMentions")?.forClosing(owner),
							openFile: async (path) => {
								const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
								const result = await ctx.remote.session.openWorkspacePath({ path: resolveWorkspacePath(cwd, path) });
								if (!result.ok) throw new Error(`path open failed: ${result.error.message}`);
							},
							loadOlder: () => {
								session.loadOlder();
							},
							loadImage: Object.assign((attachment) => ctx.uiConversation.imageUrl(sessionId, attachment), { peek: (attachment) => ctx.uiConversation.peekImageUrl(sessionId, attachment) }),
							chatScroll: {
								save: (position) => {
									if (position === null) chatScrollPositions.delete(sessionId);
									else chatScrollPositions.set(sessionId, position);
								},
								read: () => chatScrollPositions.get(sessionId) ?? null
							},
							forkAt: (seq) => {
								ctx.sessions.fork({
									sessionId,
									atSeq: seq,
									increaseTitle: true
								}).then((childId) => {
									ctx.sessions.open(childId);
								}).catch(() => {});
							}
						};
					}
				}, ChatView);
			});
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "stats",
				order: 0,
				locale: NS
			}, StatsLine));
			ctx.slots.inject("conversation.approval.detail", () => ctx.slots.register({ name: "conversation.approval.detail" }, ApprovalCommand));
			ctx.slots.inject("details", () => ctx.slots.register({
				name: "details",
				locale: NS,
				children: { "conversation.details.tool": {
					kind: "single",
					scope: "session"
				} },
				store: chatStore,
				inject: () => ({ closeDetails: () => {
					ctx.layout.closeDetails();
				} })
			}, DetailsPanel));
		}
		//#endregion
		exports.EMPTY_CHAT_SNAPSHOT = EMPTY_CHAT_SNAPSHOT;
		exports.apply = apply;
		exports.inject = inject;
		exports.isRunningTool = isRunningTool;
		exports.isSettledTool = isSettledTool;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map