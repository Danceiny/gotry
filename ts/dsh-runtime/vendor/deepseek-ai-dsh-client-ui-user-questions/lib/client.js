window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-user-questions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/types/client/contract/slots.js
		function settlePendingComposer(settle, failureMessage) {
			try {
				settle();
				return Promise.resolve();
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(failureMessage, { cause: error }));
			}
		}
		/**
		* Narrow a request to a renderable plan review, or return undefined to leave it
		* to the generic question flow.
		*
		* The card is one decision over one plan, and it claims a request only when it
		* can send every answer that request allows — an intent changes the layout,
		* never which answers are reachable. So the batch must be a single question
		* that declares the intent, carries the plan as its detail, offers the approve
		* label the intent names, and is a binary single choice: at most one option
		* besides approve, and not multi-select. A third option or a multi-select batch
		* has answers two buttons cannot express, so the generic flow keeps it — as it
		* keeps any request whose intent the asker's own service would have rejected,
		* because the client sits downstream of a wire boundary and every request must
		* stay answerable.
		*
		* @param questions - the request's whole question batch.
		* @returns The narrowed review, or undefined when the generic flow owns it.
		*/
		function planReviewOf(questions) {
			if (questions.length !== 1) return void 0;
			const question = questions[0];
			const intent = question.intent;
			if (intent?.kind !== "plan-review" || question.detail === void 0) return void 0;
			if (question.multiSelect === true) return void 0;
			const options = question.options ?? [];
			if (options.length > 2) return void 0;
			const approve = options.find((option) => option.label === intent.approve);
			if (approve === void 0) return void 0;
			const decline = options.find((option) => option.label !== intent.approve);
			return {
				id: question.id,
				question: question.question,
				plan: question.detail,
				approve,
				...decline === void 0 ? {} : { decline }
			};
		}
		let nextQuestionKey = 0;
		/** Create a wire-preserved user-question rejection. */
		function questionError(message, code) {
			const error = new Error(message);
			error.name = "UserQuestionError";
			error.code = code;
			return error;
		}
		/** One answerable Client presentation of a pending Host waterfall. */
		var PendingQuestion = class {
			sessionId;
			/** Presentation discriminator used by Session pending-interaction consumers. */
			kind;
			/** Opaque render identity and request key for the Session-scoped draft store. */
			key;
			/** The request's question list. */
			questions;
			/** Result returned by the Remote Event listener to the Host waterfall. */
			result;
			#resolve;
			#reject;
			#signal;
			#onAbort;
			#delegated = Symbol("pending question delegated");
			#settled = false;
			/**
			* @param sessionId - Agent/Session identity owning the scoped request.
			* @param questions - complete question batch.
			* @param signal - Host request and delivery lifetime.
			*/
			constructor(sessionId, questions, signal) {
				this.sessionId = sessionId;
				nextQuestionKey += 1;
				this.key = `question:${String(nextQuestionKey)}`;
				this.questions = questions;
				this.kind = planReviewOf(questions) === void 0 ? "question" : "plan-review";
				const completion = Promise.withResolvers();
				this.result = completion.promise;
				this.#resolve = completion.resolve;
				this.#reject = completion.reject;
				this.#signal = signal;
				if (signal === void 0) {
					this.#onAbort = void 0;
					return;
				}
				const onAbort = () => {
					this.abort(questionError("ask_user_question was aborted before the user answered", "ASK_ABORTED"));
				};
				this.#onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}
			/**
			* Resolve the Host waterfall with the whole answer batch.
			* @param answer - complete structured answer batch.
			*/
			answer(answer) {
				return settlePendingComposer(() => {
					this.finish(() => {
						this.#resolve(answer);
					});
				}, "pending question settlement failed");
			}
			/** Delegate an unanswered request to the next waterfall listener. */
			delegate() {
				if (this.#settled) return;
				this.finish(() => {
					this.#reject(this.#delegated);
				});
			}
			/**
			* Test whether a rejection requests waterfall delegation.
			* @param reason - rejection received from {@link PendingQuestion.result}.
			* @returns whether {@link PendingQuestion.delegate} produced it.
			*/
			isDelegation(reason) {
				return reason === this.#delegated;
			}
			/** Reject the Host waterfall because the user closed the question. */
			cancel() {
				return settlePendingComposer(() => {
					this.finish(() => {
						this.#reject(questionError("the user cancelled ask_user_question", "ASK_CANCELLED"));
					});
				}, "pending question cancellation failed");
			}
			/**
			* End an unanswered presentation when its transport, scope, or plugin lifetime ends.
			* @param reason - rejection exposed to the waiting Remote Event listener.
			*/
			abort(reason) {
				if (this.#settled) return;
				this.finish(() => {
					this.#reject(reason);
				});
			}
			finish(settle) {
				if (this.#settled) throw new Error(`pending question ${this.key} is already settled`);
				this.#settled = true;
				if (this.#signal !== void 0 && this.#onAbort !== void 0) this.#signal.removeEventListener("abort", this.#onAbort);
				settle();
			}
		};
		//#endregion
		//#region lib/types/client/draft-store.js
		/**
		* Session-scoped draft state for the generic question composer. The Slot
		* registry owns store instances; this module exports only the factory so a
		* plugin reload cannot reuse a module-global handle.
		*/
		const emptyProgress = () => ({
			index: 0,
			drafts: []
		});
		/**
		* Declare the question composer's transient Session store.
		* @returns a non-persisted store handle whose instance is owned by the Slot registry.
		*/
		function createQuestionDraftStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({ progress: emptyProgress() }),
				actions: {
					replace: (draft, requestKey, progress) => {
						draft.requestKey = requestKey;
						draft.progress = progress;
					},
					clear: (draft, requestKey) => {
						if (draft.requestKey !== requestKey) return;
						delete draft.requestKey;
						draft.progress = emptyProgress();
					}
				}
			});
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
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-user-questions/src/client/PlanReviewPanel.module.css.mjs
		const css$1 = ".UT05uW_frame{padding:6px calc(var(--dsh-composer-side-clearance) + 16px) 10px;justify-content:center;display:flex}.UT05uW_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-specific-input-major);max-height:min(60vh,520px);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:20px;flex-direction:column;display:flex;overflow:hidden}.UT05uW_card,.UT05uW_card *{box-sizing:border-box}.UT05uW_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);flex-shrink:0;align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}.UT05uW_dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;width:8px;height:8px}.UT05uW_body{overscroll-behavior:contain;flex:auto;min-height:0;padding:12px 16px 4px;font-size:14px;line-height:22px;overflow-y:auto}.UT05uW_footer{flex-shrink:0;justify-content:space-between;align-items:center;gap:12px;padding:8px 16px 12px;display:flex}.UT05uW_feedback{min-height:16px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}.UT05uW_actions{flex-shrink:0;align-items:center;gap:8px;display:flex}.UT05uW_discuss{color:var(--dsw-alias-label-secondary);gap:6px}.UT05uW_discuss:hover:not(:disabled){color:var(--dsw-alias-label-primary)}@media (width<=720px){.UT05uW_card{border-radius:16px}.UT05uW_body{padding:10px 12px 4px}.UT05uW_footer{align-items:flex-end;padding:8px 12px 10px}}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-user-questions/PlanReviewPanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-user-questions";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var PlanReviewPanel_module_css_default = {
			"actions": "UT05uW_actions",
			"body": "UT05uW_body",
			"card": "UT05uW_card",
			"discuss": "UT05uW_discuss",
			"dot": "UT05uW_dot",
			"feedback": "UT05uW_feedback",
			"footer": "UT05uW_footer",
			"frame": "UT05uW_frame",
			"strip": "UT05uW_strip"
		};
		//#endregion
		//#region lib/types/client/PlanReviewPanel.js
		/**
		* Optional-prop spread for a decision button's tooltip: `title` is optional on
		* the DOM props, and exactOptionalPropertyTypes rejects an explicit undefined.
		*
		* @param description - the asker's option description, when it carries one.
		* @returns The `title` prop to spread, or nothing.
		*/
		function tooltip(description) {
			return description === void 0 ? {} : { title: description };
		}
		/**
		* Render a plan review as a decision card.
		*
		* @param props - the question domain face, the narrowed plan review, and `t`.
		* @returns The plan-review takeover for this request.
		*/
		function PlanReviewPanel({ pending, review, t }) {
			const markdownLabels = (0, react.useMemo)(() => ({
				code: {
					copyLabel: t("copy"),
					copiedLabel: t("copied")
				},
				footnotes: t("markdown.footnotes")
			}), [t]);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const settle = (send) => {
				setBusy(true);
				setError(null);
				send().catch((cause) => {
					setBusy(false);
					setError(cause instanceof Error ? cause.message : String(cause));
				});
			};
			const decide = (label) => {
				settle(() => pending.answer({ answers: [{
					id: review.id,
					selected: [label]
				}] }));
			};
			const decline = review.decline;
			return (0, react_jsx_runtime.jsx)("div", {
				className: PlanReviewPanel_module_css_default.frame,
				"data-plan-review-key": pending.key,
				children: (0, react_jsx_runtime.jsxs)("section", {
					className: PlanReviewPanel_module_css_default.card,
					"aria-label": review.question,
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: PlanReviewPanel_module_css_default.strip,
							children: [(0, react_jsx_runtime.jsx)("span", { className: PlanReviewPanel_module_css_default.dot }), t("plan.header")]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: PlanReviewPanel_module_css_default.body,
							"data-plan-review-scroll": true,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
								text: review.plan,
								labels: markdownLabels
							})
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: PlanReviewPanel_module_css_default.footer,
							children: [(0, react_jsx_runtime.jsx)("div", {
								className: PlanReviewPanel_module_css_default.feedback,
								role: "status",
								children: error
							}), (0, react_jsx_runtime.jsxs)("div", {
								className: PlanReviewPanel_module_css_default.actions,
								children: [
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "ghost",
										className: PlanReviewPanel_module_css_default.discuss,
										icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 14 }),
										disabled: busy,
										onClick: () => {
											settle(() => pending.cancel());
										},
										children: t("plan.discuss")
									}),
									decline !== void 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										...tooltip(decline.description),
										disabled: busy,
										onClick: () => {
											decide(decline.label);
										},
										children: t("plan.decline")
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										...tooltip(review.approve.description),
										disabled: busy,
										onClick: () => {
											decide(review.approve.label);
										},
										children: t("plan.approve")
									})
								]
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region \0dsh-css:/private/tmp/dsh-alpha/packages/client/ui-user-questions/src/client/QuestionComposer.module.css.mjs
		const css = ".YS9gXa_frame{padding:6px calc(var(--dsh-composer-side-clearance) + 16px) 10px;justify-content:center;display:flex}.YS9gXa_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);max-height:min(60vh,520px);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:20px;flex-direction:column;padding:0 0 10px;display:flex;overflow:hidden}.YS9gXa_card,.YS9gXa_card *{box-sizing:border-box}.YS9gXa_cardMinimized{max-height:none}.YS9gXa_cardMinimized .YS9gXa_header{padding-bottom:14px}.YS9gXa_headerActions{flex-shrink:0;align-items:center;gap:4px;display:flex}.YS9gXa_header{flex-shrink:0;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 16px 0 24px;display:flex}.YS9gXa_headingBlock{min-width:0}.YS9gXa_eyebrow{color:var(--dsw-alias-label-tertiary);margin-bottom:5px;font-size:11px;line-height:16px}.YS9gXa_title{margin:0;font-size:16px;font-weight:500;line-height:22px}.YS9gXa_detail{margin:0 2px 8px}.YS9gXa_footerActions{flex-shrink:0;align-items:center;gap:12px;display:flex}.YS9gXa_pager{flex-shrink:0;align-items:center;gap:6px;display:flex}.YS9gXa_progress{color:var(--dsw-alias-label-secondary);white-space:nowrap;word-spacing:-2px;padding:0 4px;font-size:14px;font-weight:500;line-height:24px}.YS9gXa_iconButton{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;padding:0;display:grid}.YS9gXa_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.YS9gXa_iconButton:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.YS9gXa_body{overscroll-behavior:contain;flex-direction:column;flex:auto;min-height:0;display:flex;overflow-y:auto}.YS9gXa_options{flex-direction:column;gap:1px;margin:8px 0 0;padding:4px 12px;display:flex}.YS9gXa_option{width:100%;min-height:40px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:1px solid #0000;border-radius:12px;flex-shrink:0;align-items:flex-start;gap:8px;padding:8px 12px 8px 8px;transition:background-color .12s,border-color .12s;display:flex}.YS9gXa_option:hover:not(:disabled),.YS9gXa_optionSelected{background:var(--dsw-alias-interactive-bg-hover)}.YS9gXa_optionSelected{border-color:var(--dsw-alias-border-l2)}.YS9gXa_option:disabled{cursor:default}.YS9gXa_number{background:var(--dsw-alias-bg-overlay);width:20px;height:20px;color:var(--dsw-alias-label-secondary);border-radius:6px;flex:0 0 20px;place-items:center;margin-top:2px;font-size:12px;font-weight:500;line-height:18px;display:grid}.YS9gXa_checkbox{flex:0 0 20px;place-items:center;width:20px;height:20px;margin-top:2px;display:grid}.YS9gXa_checkbox:before{content:\"\";border:1px solid var(--dsw-alias-border-l4);border-radius:4px;grid-area:1/1;width:14px;height:14px;transition:background-color .12s,border-color .12s}.YS9gXa_checkbox>svg{grid-area:1/1}.YS9gXa_checkboxChecked{color:var(--dsw-alias-label-primary-foreground)}.YS9gXa_checkboxChecked:before{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary)}.YS9gXa_optionCopy{flex:1;min-width:0}.YS9gXa_optionLine{flex-wrap:wrap;align-items:baseline;gap:2px 6px;display:flex}.YS9gXa_optionLabel{font-size:14px;font-weight:500;line-height:24px}.YS9gXa_badge{background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-button-info-fill);border-radius:6px;padding:0 4px;font-size:11px;font-weight:600;line-height:18px}.YS9gXa_description{color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:400;line-height:24px}.YS9gXa_customRow{border:1px solid #0000;border-radius:12px;flex-shrink:0;align-items:flex-start;gap:8px;width:100%;min-height:40px;padding:8px 12px 8px 8px;transition:background-color .12s,border-color .12s;display:flex}.YS9gXa_customRow:hover,.YS9gXa_customRow:focus-within,.YS9gXa_customRowActive{background:var(--dsw-alias-interactive-bg-hover)}.YS9gXa_customRow:focus-within,.YS9gXa_customRowActive{border-color:var(--dsw-alias-border-l2)}.YS9gXa_field{--dsh-answer-field-padding:0;min-width:0;display:grid}.YS9gXa_field>*{min-width:0;padding:var(--dsh-answer-field-padding);font:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;grid-area:1/1;font-size:14px;line-height:24px}.YS9gXa_fieldMirror{box-sizing:content-box;visibility:hidden;max-height:144px;overflow:hidden}.YS9gXa_fieldInput{resize:none;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);background:0 0;border:none;outline:none;overflow-y:auto}.YS9gXa_fieldInput::placeholder{color:var(--dsw-alias-label-caption)}.YS9gXa_customInline{flex:1}.YS9gXa_customBlock{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);--dsh-answer-field-padding:8px 12px;border-radius:10px;flex-shrink:0;min-height:64px;margin:0 12px}.YS9gXa_customBlock:focus-within{border-color:var(--dsw-alias-state-business-primary)}.YS9gXa_footer{flex-shrink:0;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;padding:0 10px 0 18px;display:flex}.YS9gXa_feedback{min-height:16px;color:var(--dsw-alias-state-error-primary);text-align:right;flex:1;font-size:11px;line-height:16px}@media (width<=720px){.YS9gXa_card{border-radius:16px}.YS9gXa_header{padding:10px 12px 0 18px}.YS9gXa_options{padding:4px 8px}.YS9gXa_title{font-size:15px;line-height:21px}.YS9gXa_option,.YS9gXa_customRow{padding:8px 6px}.YS9gXa_footer{align-items:flex-end;padding:0 10px}.YS9gXa_footerActions{flex-shrink:0}}@media (prefers-reduced-motion:reduce){.YS9gXa_option,.YS9gXa_customRow{transition:none}}";
		const tagId = "@deepseek-ai/dsh-client-ui-user-questions/QuestionComposer.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-user-questions";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var QuestionComposer_module_css_default = {
			"badge": "YS9gXa_badge",
			"body": "YS9gXa_body",
			"card": "YS9gXa_card",
			"cardMinimized": "YS9gXa_cardMinimized",
			"checkbox": "YS9gXa_checkbox",
			"checkboxChecked": "YS9gXa_checkboxChecked",
			"customBlock": "YS9gXa_customBlock",
			"customInline": "YS9gXa_customInline",
			"customRow": "YS9gXa_customRow",
			"customRowActive": "YS9gXa_customRowActive",
			"description": "YS9gXa_description",
			"detail": "YS9gXa_detail",
			"eyebrow": "YS9gXa_eyebrow",
			"feedback": "YS9gXa_feedback",
			"field": "YS9gXa_field",
			"fieldInput": "YS9gXa_fieldInput",
			"fieldMirror": "YS9gXa_fieldMirror",
			"footer": "YS9gXa_footer",
			"footerActions": "YS9gXa_footerActions",
			"frame": "YS9gXa_frame",
			"header": "YS9gXa_header",
			"headerActions": "YS9gXa_headerActions",
			"headingBlock": "YS9gXa_headingBlock",
			"iconButton": "YS9gXa_iconButton",
			"number": "YS9gXa_number",
			"option": "YS9gXa_option",
			"optionCopy": "YS9gXa_optionCopy",
			"optionLabel": "YS9gXa_optionLabel",
			"optionLine": "YS9gXa_optionLine",
			"optionSelected": "YS9gXa_optionSelected",
			"options": "YS9gXa_options",
			"pager": "YS9gXa_pager",
			"progress": "YS9gXa_progress",
			"title": "YS9gXa_title"
		};
		//#endregion
		//#region lib/types/client/QuestionComposer.js
		/**
		* Split the conventional recommendation suffix without changing the answer value.
		* @param label - Original option label returned if selected.
		* @returns Display label plus recommendation state.
		*/
		function parseRecommendedLabel(label) {
			const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
			return suffix.test(label) ? {
				label: label.replace(suffix, ""),
				recommended: true
			} : {
				label,
				recommended: false
			};
		}
		/** Return whether a text-field key event belongs to an active IME composition. */
		function isComposing(event) {
			return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
		}
		/**
		* Auto-growing free-text answer: a textarea, so a long answer soft-wraps and
		* Shift+Enter breaks a line, over a hidden mirror that owns the height.
		*
		* The mirror renders the draft plus a trailing newline in normal flow and so
		* sizes the grid row (counting rows by '\n' cannot see soft wraps); the
		* textarea shares that one cell and stretches to it, and `rows={1}` keeps the
		* control's own intrinsic height out of the row sizing so the mirror alone
		* decides. Past the mirror's cap the textarea scrolls itself — it is the only
		* scrollport in the stack, there being no second glyph layer to keep aligned.
		* Mirror and textarea MUST share font, line-height, padding and wrapping rules
		* or the two heights diverge.
		*
		* @param props - visual variant, draft text, and the field's event handlers.
		* @returns The mirrored auto-growing field.
		*/
		function AnswerField(props) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(QuestionComposer_module_css_default.field, props.variant === "inline" ? QuestionComposer_module_css_default.customInline : QuestionComposer_module_css_default.customBlock),
				children: [(0, react_jsx_runtime.jsx)("div", {
					"aria-hidden": true,
					className: QuestionComposer_module_css_default.fieldMirror,
					children: `${props.value}\n`
				}), (0, react_jsx_runtime.jsx)("textarea", {
					autoFocus: props.autoFocus,
					className: QuestionComposer_module_css_default.fieldInput,
					value: props.value,
					disabled: props.disabled,
					rows: 1,
					placeholder: props.placeholder,
					onFocus: props.onFocus,
					onChange: props.onChange,
					onKeyDown: props.onKeyDown
				})]
			});
		}
		/**
		* Composer takeover router. Generic-question drafts live in this entry's
		* Session-scoped Slot store, keyed by the pending carrier, so a strict Session
		* entry remount restores the same request without exposing it to another one.
		*
		* One takeover, two presentations: a request that declares a presentation intent this
		* package renders uses that presentation (a plan review is one decision over one
		* plan, not a question set), and every other request takes the generic flow.
		* The routing lives here, at the one entry that owns the composer seat, so
		* neither presentation can claim a request the other is already rendering.
		*
		* @param props - the selector-matched pending question carrier plus the framework standard kit.
		* @returns The question flow, or the intent's own surface, for this request.
		*/
		function QuestionComposer(props) {
			const question = props.matched;
			const review = (0, react.useMemo)(() => planReviewOf(question.questions), [question]);
			return review === void 0 ? (0, react_jsx_runtime.jsx)(QuestionFlow, {
				pending: question,
				t: props.t,
				useStore: props.useStore,
				actions: props.actions
			}, question.key) : (0, react_jsx_runtime.jsx)(PlanReviewPanel, {
				pending: question,
				review,
				t: props.t
			}, question.key);
		}
		function QuestionFlow({ pending, t, useStore, actions }) {
			const questions = pending.questions;
			const markdownLabels = (0, react.useMemo)(() => ({
				code: {
					copyLabel: t("copy"),
					copiedLabel: t("copied")
				},
				footnotes: t("markdown.footnotes")
			}), [t]);
			const initialProgress = (0, react.useMemo)(() => ({
				index: 0,
				drafts: questions.map(() => ({
					selected: [],
					custom: "",
					skipped: false
				}))
			}), [questions]);
			const { index, drafts } = useStore((state) => state.requestKey === pending.key && state.progress.drafts.length === questions.length ? state.progress : void 0) ?? initialProgress;
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [minimized, setMinimized] = (0, react.useState)(false);
			const focusedQuestions = (0, react.useRef)(/* @__PURE__ */ new Set());
			const question = questions[index];
			const draft = drafts[index];
			const hasOptions = (question.options?.length ?? 0) > 0;
			const replaceProgress = (nextIndex, nextDrafts) => {
				actions.replace(pending.key, {
					index: nextIndex,
					drafts: nextDrafts
				});
			};
			const cancelFlow = () => {
				setBusy("cancel");
				setError(null);
				pending.cancel().then(() => {
					actions.clear(pending.key);
				}).catch((cause) => {
					setBusy(null);
					setError({ text: cause instanceof Error ? cause.message : String(cause) });
				});
			};
			const updateDraft = (update, nextIndex = index) => {
				replaceProgress(nextIndex, drafts.map((item, itemIndex) => itemIndex === index ? update(item) : item));
				setError(null);
			};
			const choose = (label) => {
				updateDraft((current) => {
					if (question.multiSelect === true) {
						const selected = current.selected.includes(label) ? current.selected.filter((item) => item !== label) : [...current.selected, label];
						return {
							...current,
							selected,
							skipped: false
						};
					}
					return {
						selected: [label],
						custom: "",
						skipped: false
					};
				}, question.multiSelect !== true && index < questions.length - 1 ? index + 1 : index);
			};
			const answered = (item) => item.selected.length > 0 || item.custom.trim() !== "";
			const completed = (item) => answered(item) || item.skipped;
			const submitDrafts = (values) => {
				const missing = values.findIndex((item) => !completed(item));
				if (missing >= 0) {
					replaceProgress(missing, values);
					setError({ key: "error.incomplete" });
					return;
				}
				const answer = { answers: questions.map((item, itemIndex) => {
					const value = values[itemIndex];
					if (value.skipped) return {
						id: item.id,
						selected: []
					};
					const custom = value.custom.trim();
					return {
						id: item.id,
						selected: custom === "" || item.multiSelect === true ? value.selected : [],
						...custom === "" ? {} : { custom }
					};
				}) };
				setBusy("answer");
				setError(null);
				pending.answer(answer).then(() => {
					actions.clear(pending.key);
				}).catch((cause) => {
					setBusy(null);
					setError({ text: cause instanceof Error ? cause.message : String(cause) });
				});
			};
			const continueFlow = () => {
				if (!answered(draft)) {
					setError({ key: "error.unanswered" });
					return;
				}
				if (index < questions.length - 1) {
					replaceProgress(index + 1, drafts);
					setError(null);
					return;
				}
				submitDrafts(drafts);
			};
			const draftCustom = (event) => {
				const value = event.target.value;
				updateDraft((current) => ({
					...current,
					selected: question.multiSelect === true ? current.selected : [],
					custom: value,
					skipped: false
				}));
			};
			const continueFromCustom = (event) => {
				if (event.key !== "Enter" || event.shiftKey || isComposing(event)) return;
				event.preventDefault();
				continueFlow();
			};
			const skipQuestion = () => {
				const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index ? {
					selected: [],
					custom: "",
					skipped: true
				} : item);
				replaceProgress(index < questions.length - 1 ? index + 1 : index, nextDrafts);
				setError(null);
				if (index < questions.length - 1) return;
				submitDrafts(nextDrafts);
			};
			return (0, react_jsx_runtime.jsx)("div", {
				className: QuestionComposer_module_css_default.frame,
				"data-question-key": pending.key,
				children: (0, react_jsx_runtime.jsxs)("section", {
					className: clsx(QuestionComposer_module_css_default.card, minimized && QuestionComposer_module_css_default.cardMinimized),
					"aria-labelledby": `question-${pending.key}-${String(index)}`,
					children: [(0, react_jsx_runtime.jsxs)("header", {
						className: QuestionComposer_module_css_default.header,
						children: [(0, react_jsx_runtime.jsxs)("div", {
							className: QuestionComposer_module_css_default.headingBlock,
							children: [question.header !== void 0 && (0, react_jsx_runtime.jsx)("div", {
								className: QuestionComposer_module_css_default.eyebrow,
								children: question.header
							}), (0, react_jsx_runtime.jsx)("h2", {
								className: QuestionComposer_module_css_default.title,
								id: `question-${pending.key}-${String(index)}`,
								children: question.question
							})]
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: QuestionComposer_module_css_default.headerActions,
							children: [(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: QuestionComposer_module_css_default.iconButton,
								"aria-label": t(minimized ? "nav.maximize" : "nav.minimize"),
								title: t(minimized ? "nav.maximize" : "nav.minimize"),
								"aria-expanded": !minimized,
								disabled: busy !== null,
								onClick: () => {
									setMinimized((current) => !current);
								},
								children: minimized ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: QuestionComposer_module_css_default.iconButton,
								"aria-label": t("nav.cancel"),
								title: t("nav.cancel"),
								disabled: busy !== null,
								onClick: cancelFlow,
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, {})
							})]
						})]
					}), !minimized && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("div", {
						className: QuestionComposer_module_css_default.body,
						"data-question-scroll": true,
						children: [question.detail !== void 0 && (0, react_jsx_runtime.jsx)("div", {
							className: QuestionComposer_module_css_default.detail,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
								text: question.detail,
								labels: markdownLabels
							})
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: QuestionComposer_module_css_default.options,
							role: question.multiSelect === true ? "group" : "radiogroup",
							children: [(question.options ?? []).map((option, optionIndex) => {
								const selected = draft.selected.includes(option.label);
								const display = parseRecommendedLabel(option.label);
								return (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: clsx(QuestionComposer_module_css_default.option, selected && question.multiSelect !== true && QuestionComposer_module_css_default.optionSelected),
									role: question.multiSelect === true ? "checkbox" : "radio",
									"aria-checked": selected,
									"aria-label": display.label,
									disabled: busy !== null,
									onClick: () => {
										choose(option.label);
									},
									onKeyDown: (event) => {
										if (event.key !== "Enter" || !drafts.every(completed)) return;
										event.preventDefault();
										submitDrafts(drafts);
									},
									children: [question.multiSelect === true ? (0, react_jsx_runtime.jsx)("span", {
										className: clsx(QuestionComposer_module_css_default.checkbox, selected && QuestionComposer_module_css_default.checkboxChecked),
										"aria-hidden": "true",
										children: selected && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline14, { size: 12 })
									}) : (0, react_jsx_runtime.jsx)("span", {
										className: QuestionComposer_module_css_default.number,
										children: optionIndex + 1
									}), (0, react_jsx_runtime.jsx)("span", {
										className: QuestionComposer_module_css_default.optionCopy,
										children: (0, react_jsx_runtime.jsxs)("span", {
											className: QuestionComposer_module_css_default.optionLine,
											children: [
												(0, react_jsx_runtime.jsx)("span", {
													className: QuestionComposer_module_css_default.optionLabel,
													children: display.label
												}),
												display.recommended && (0, react_jsx_runtime.jsx)("span", {
													className: QuestionComposer_module_css_default.badge,
													children: t("option.recommended")
												}),
												option.description !== void 0 && (0, react_jsx_runtime.jsx)("span", {
													className: QuestionComposer_module_css_default.description,
													children: option.description
												})
											]
										})
									})]
								}, `${option.label}-${String(optionIndex)}`);
							}), hasOptions ? (0, react_jsx_runtime.jsxs)("div", {
								className: clsx(QuestionComposer_module_css_default.customRow, draft.custom !== "" && QuestionComposer_module_css_default.customRowActive),
								children: [question.multiSelect === true ? (0, react_jsx_runtime.jsx)("span", {
									className: clsx(QuestionComposer_module_css_default.checkbox, draft.custom !== "" && QuestionComposer_module_css_default.checkboxChecked),
									"aria-hidden": "true",
									children: draft.custom !== "" && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline14, { size: 12 })
								}) : (0, react_jsx_runtime.jsx)("span", {
									className: QuestionComposer_module_css_default.number,
									"aria-hidden": "true",
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 12 })
								}), (0, react_jsx_runtime.jsx)(AnswerField, {
									variant: "inline",
									value: draft.custom,
									disabled: busy !== null,
									placeholder: t("custom.placeholder"),
									onChange: draftCustom,
									onKeyDown: continueFromCustom
								})]
							}) : (0, react_jsx_runtime.jsx)(AnswerField, {
								autoFocus: !focusedQuestions.current.has(index),
								variant: "block",
								value: draft.custom,
								disabled: busy !== null,
								placeholder: t("custom.placeholder"),
								onFocus: () => {
									focusedQuestions.current.add(index);
								},
								onChange: draftCustom,
								onKeyDown: continueFromCustom
							})]
						})]
					}), (0, react_jsx_runtime.jsxs)("footer", {
						className: QuestionComposer_module_css_default.footer,
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: QuestionComposer_module_css_default.pager,
								children: [
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QuestionComposer_module_css_default.iconButton,
										"aria-label": t("nav.prev"),
										disabled: index === 0 || busy !== null,
										onClick: () => {
											replaceProgress(index - 1, drafts);
											setError(null);
										},
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutline14, {})
									}),
									(0, react_jsx_runtime.jsxs)("span", {
										className: QuestionComposer_module_css_default.progress,
										children: [
											index + 1,
											" / ",
											questions.length
										]
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QuestionComposer_module_css_default.iconButton,
										"aria-label": t("nav.next"),
										disabled: index === questions.length - 1 || busy !== null,
										onClick: () => {
											replaceProgress(index + 1, drafts);
											setError(null);
										},
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {})
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								className: QuestionComposer_module_css_default.feedback,
								role: "status",
								children: error === null ? null : "key" in error ? t(error.key) : error.text
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: QuestionComposer_module_css_default.footerActions,
								children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									disabled: busy !== null,
									onClick: skipQuestion,
									children: t("action.skip")
								}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									disabled: busy !== null || !answered(draft),
									onClick: continueFlow,
									children: busy === "answer" ? t("submitting") : index === questions.length - 1 ? t("submit") : t("action.next")
								})]
							})
						]
					})] })]
				})
			});
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** `question` namespace dictionaries. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"error.incomplete": "请先完成这道问题。",
			"error.unanswered": "请选择一个选项或填写自定义答案。",
			"nav.prev": "上一题",
			"nav.next": "下一题",
			"nav.minimize": "收起问题卡片",
			"nav.maximize": "展开问题卡片",
			"nav.cancel": "放弃整组问题",
			"option.recommended": "推荐",
			"custom.placeholder": "输入你的答案",
			"action.skip": "跳过本题",
			"action.next": "下一题",
			"plan.header": "计划待审",
			"plan.approve": "确认执行",
			"plan.decline": "拒绝",
			"plan.discuss": "去聊天里说"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"error.incomplete": "Please complete this question first.",
			"error.unanswered": "Please select an option or enter a custom answer.",
			"nav.prev": "Previous question",
			"nav.next": "Next question",
			"nav.minimize": "Collapse the question card",
			"nav.maximize": "Expand the question card",
			"nav.cancel": "Dismiss all questions",
			"option.recommended": "Recommended",
			"custom.placeholder": "Type your answer",
			"action.skip": "Skip this question",
			"action.next": "Next",
			"plan.header": "Plan review",
			"plan.approve": "Approve",
			"plan.decline": "Refuse",
			"plan.discuss": "Chat about it"
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "question";
		/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
		const inject = [
			"sessions",
			"remote",
			"uiSession",
			"slots",
			"locale"
		];
		/** Present one request until the user answers, cancels, or its lifetime ends. */
		async function answerQuestion(ctx, owner, request, next, registerPendingInteraction) {
			const sessionId = ctx.sessions.scopeOf(owner);
			if (sessionId === void 0) return next();
			const pending = new PendingQuestion(sessionId, request.questions, request.signal);
			const completed = Promise.withResolvers();
			const remove = registerPendingInteraction(pending, async () => {
				pending.delegate();
				await completed.promise;
			});
			try {
				try {
					return await pending.result;
				} catch (error) {
					if (pending.isDelegation(error)) return await next();
					throw error;
				}
			} finally {
				remove();
				completed.resolve();
			}
		}
		/**
		* Client plugin body: register the `question` dictionaries and the question
		* composer into the composer chain. Zero business face — data and verbs live
		* on the matched carrier; t rides the standard locale seat.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-user-questions: dictionaries");
			const questionDraftStore = createQuestionDraftStore();
			const registerPendingInteraction = ctx.uiSession.registerPendingInteraction((pending) => pending.kind === "plan-review" ? 2 : 1);
			ctx.slots.inject("conversation.composer", () => ctx.slots.register({
				name: "conversation.composer",
				select: ({ pendingInteraction }) => pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,
				locale: NS,
				store: questionDraftStore
			}, QuestionComposer));
			ctx.remote.$on("user-questions/request", function(request, next) {
				return answerQuestion(ctx, this, request, next, registerPendingInteraction);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map