/**
 * Gateway chat-completions LLM provider for the embedded Booking Copilot.
 *
 * The team LLM gateway (new-api) speaks the OpenAI chat-completions wire
 * dialect (`data: {...}` frames closed by a `data: [DONE]` sentinel). dsh
 * 0.2.x's bundled DeepSeek adapter moved to the DeepSeek Messages protocol,
 * whose strict translator rejects the gateway's chat-completions stream —
 * most visibly when an upstream model emits a truncated tool-call argument
 * JSON that the harness-side schema-repair path could otherwise recover
 * (hotel-be#33424 / Danceiny/gotry#660 evidence chain). This plugin registers
 * a chat-completions adapter so the planner keeps a wire dialect the whole
 * stack (gateway + harness repair paths) is proven against.
 *
 * Ported from the dsh 0.1.5-rc.1 `dsh-llm-deepseek` adapter (text + tools
 * only; the images/files/replay machinery the planner never used is dropped).
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

export const name = 'llm-gateway-chat'
export const inject = ['llm']

/** Provider route this plugin registers; selected via DEEPSEEK_PROVIDER. */
export const GATEWAY_PROVIDER = 'gateway-chat'

function assertTextOnly(content) {
	if (typeof content === 'string') return
	for (const block of content) {
		if (block.type === 'image' || block.type === 'file') {
			throw new LlmError('gateway chat provider accepts text and tool content only', 'UNSUPPORTED_CONTENT')
		}
	}
}

function flattenText(blocks) {
	if (typeof blocks === 'string') return blocks
	return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
	const text = flattenText(message.content)
	const reasoning = message.content.filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
	const toolCalls = message.content.filter((block) => block.type === 'tool-call').map((block) => ({
		id: block.id,
		type: 'function',
		function: { name: block.name, arguments: block.arguments },
	}))
	return {
		role: 'assistant',
		content: text,
		...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
	}
}

/**
 * Serialize the conversation. Tool-result blocks become standalone
 * `{role: 'tool'}` wire messages after their message's text.
 */
function serializeMessages(messages) {
	const wire = []
	for (const message of messages) {
		assertTextOnly(message.content)
		if (message.role === 'system') {
			wire.push({ role: 'system', content: flattenText(message.content) })
			continue
		}
		if (message.role === 'assistant') {
			wire.push(serializeAssistant(message))
			continue
		}
		const toolResults = message.content.filter((block) => block.type === 'tool-result')
		const text = flattenText(message.content)
		if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
		for (const result of toolResults) {
			wire.push({
				role: 'tool',
				tool_call_id: result.toolCallId,
				content: flattenText(result.content) || '(no output)',
			})
		}
	}
	return wire
}

/** Map the wire finish_reason vocabulary to the harness FinishReason. */
function mapFinishReason(reason) {
	switch (reason) {
		case 'stop': return { kind: 'stop' }
		case 'tool_calls': return { kind: 'tool-calls' }
		case 'length': return { kind: 'max-tokens' }
		default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
	}
}

/** Map wire usage to disjoint harness counts (cache reads subtracted from prompt). */
function mapUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
	const reasoning = usage.completion_tokens_details?.reasoning_tokens
	const combined = usage.prompt_tokens + usage.completion_tokens
	const hasExactTotal = Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0
		&& Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0
		&& Number.isSafeInteger(combined) && (usage.total_tokens === undefined || usage.total_tokens === combined)
	return {
		inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens,
		...(hasExactTotal ? { totalTokens: combined } : {}),
		...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
		...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
	}
}

/** Accept one streamed identity field; empty/null re-sends mean "no update". */
function acceptIdentity(current, incoming) {
	return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case 'text': return { type: 'text', text: block.text }
		case 'reasoning': return { type: 'reasoning', text: block.text }
		case 'tool-call': return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text }
	}
}

/** Parse an SSE byte/text stream into data payloads; `[DONE]` yielded verbatim as the sentinel. */
async function* parseSse(stream, onActivity) {
	const decoder = new TextDecoder()
	let buffer = ''
	let sawDone = false
	for await (const chunk of stream) {
		onActivity?.()
		buffer += decoder.decode(chunk, { stream: true })
		let index
		while ((index = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, '')
			buffer = buffer.slice(index + 1)
			if (!line.startsWith('data:')) continue
			const data = line.slice(5).trimStart()
			if (data === '[DONE]') { sawDone = true; yield '[DONE]'; return }
			if (data.length > 0) yield data
		}
	}
	buffer += decoder.decode()
	for (const line of buffer.split('\n')) {
		if (!line.startsWith('data:')) continue
		const data = line.slice(5).trimStart()
		if (data === '[DONE]') { sawDone = true; yield '[DONE]'; return }
		if (data.length > 0) yield data
	}
	if (!sawDone) throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Deltas stream as they arrive; block-ends, usage, and finish are deferred to
 * the `[DONE]` sentinel. A `stop` (or absent) finish with no opened blocks is
 * a degenerate provider completion and maps to an EMPTY_RESPONSE error finish.
 */
async function* translate(payloads) {
	let nextIndex = 0
	let textBlock
	let reasoningBlock
	const toolBlocks = new Map()
	const order = []
	let pendingFinish
	let pendingUsage
	function open(kind) {
		const block = { index: nextIndex++, kind, text: '' }
		order.push(block)
		return block
	}
	for await (const payload of payloads) {
		if (payload === '[DONE]') {
			for (const block of order) {
				yield { type: 'block-end', index: block.index, block: closeBlock(block) }
			}
			if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
			const reason = pendingFinish ?? { kind: 'stop' }
			yield {
				type: 'finish',
				reason: reason.kind === 'stop' && order.length === 0
					? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } }
					: reason,
			}
			return
		}
		let chunk
		try {
			chunk = JSON.parse(payload)
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
		}
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta
			const reasoning = delta?.reasoning_content
			if (typeof reasoning === 'string' && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open('reasoning')
					yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
				}
				reasoningBlock.text += reasoning
				yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
			}
			const content = delta?.content
			if (typeof content === 'string' && content.length > 0) {
				if (!textBlock) {
					textBlock = open('text')
					yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
				}
				textBlock.text += content
				yield { type: 'text-delta', index: textBlock.index, text: content }
			}
			for (const call of delta?.tool_calls ?? []) {
				let block = toolBlocks.get(call.index)
				if (!block) {
					block = open('tool-call')
					toolBlocks.set(call.index, block)
					yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
				}
				block.callId = acceptIdentity(block.callId, call.id)
				block.name = acceptIdentity(block.name, call.function?.name)
				const fragment = call.function?.arguments ?? ''
				block.text += fragment
				yield {
					type: 'tool-call-delta',
					index: block.index,
					id: block.callId ?? '',
					...(block.name !== undefined ? { name: block.name } : {}),
					argumentsDelta: fragment,
				}
			}
			if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
		}
		if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
	}
	throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * Resolve the thinking/effort wire pair, ported verbatim from the dsh
 * 0.1.5-rc.1 DeepSeek adapter (resolveThinking). The harness profile pins the
 * planner route at thinking=enabled/effort=high — the model is expected to
 * <think> before emitting the typed decision, and dropping these fields runs
 * the model in the gateway's default (non-thinking) mode, which measurably
 * ignores the planner's fine-grained intent rules.
 */
function resolveThinking(options) {
	if (options.purpose === 'session-title') return { thinking: { type: 'disabled' } }
	const effort = options.reasoningEffort
	if (effort === 'off') return { thinking: { type: 'disabled' } }
	if (effort === 'low' || effort === 'high' || effort === 'max') {
		return { thinking: { type: 'enabled' }, reasoning_effort: effort }
	}
	return { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
}

/**
 * Chat-completions adapter: fetch + SSE against an OpenAI-compatible
 * endpoint, emitting harness StreamChunks. Transport-only: connection facts
 * and the bearer token arrive through per-operation resolvers owned by the
 * registering plugin.
 */
export class GatewayChatAdapter extends LlmAdapter {
	constructor(dependencies) {
		super()
		this.config = dependencies
	}

	providerInfo(provider) {
		return { id: provider, name: this.config.providerName ?? 'Gateway Chat' }
	}

	providerRetryPolicy(_provider) {
		return this.config.retryPolicy
	}

	listModels(provider) {
		return Promise.resolve([this.modelInfo(provider, this.config.resolveConnection().model ?? 'deepseek-flash')])
	}

	resolveModel(provider, model, _signal) {
		return Promise.resolve(this.modelInfo(provider, model))
	}

	/** Exact model metadata: id/name are schema-required; context sizes the harness budget. */
	modelInfo(provider, model) {
		return {
			provider,
			id: model,
			name: model,
			inputModalities: ['text'],
			context: { contextWindow: this.config.contextWindow ?? 128_000 },
			defaultMaxTokens: this.config.maxTokens ?? 16_384,
			reasoning: {
				efforts: [
					{ id: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
					{ id: 'low', name: 'Low' },
					{ id: 'high', name: 'High' },
					{ id: 'max', name: 'Max' },
				],
			},
		}
	}

	async prepareCall(provider, model, _signal) {
		return {
			model: this.modelInfo(provider, model),
			stream: (options) => this.streamWithConnection(options, this.config.resolveConnection(), this.config.resolveApiKey),
		}
	}

	stream(options) {
		const connection = this.config.resolveConnection()
		return this.streamWithConnection(options, connection, this.config.resolveApiKey)
	}

	async *streamWithConnection(options, connection, resolveApiKey) {
		const consumer = new AbortController()
		const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
		const iterator = this.request(options, signal, connection, resolveApiKey)[Symbol.asyncIterator]()
		let exhausted = false
		try {
			while (true) {
				const result = await iterator.next()
				if (result.done) {
					exhausted = true
					return
				}
				yield result.value
			}
		} catch (error) {
			if (options.signal?.aborted) throw new LlmError('gateway chat request aborted by caller', 'ABORTED', { cause: error })
			if (error instanceof LlmError) throw error
			throw new LlmError(`gateway chat stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
		} finally {
			consumer.abort('gateway chat stream consumer stopped')
			if (!exhausted && iterator.return !== undefined) {
				try { await iterator.return() } catch { /* teardown race */ }
			}
		}
	}

	async *request(options, signal, connection, resolveApiKey) {
		const apiKey = await resolveApiKey(connection)
		const tools = (options.tools ?? []).map((tool) => ({
			type: 'function',
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}))
		const messages = serializeMessages(options.messages)
		if (typeof options.system === 'string' && options.system.length > 0 && messages[0]?.role !== 'system') {
			messages.unshift({ role: 'system', content: options.system })
		}
		const thinking = resolveThinking(options)
		const body = {
			model: options.model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
			...thinking,
			...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
			...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
			...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
			...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		}
		const base = connection.baseURL.replace(/\/+$/u, '')
		const endpoint = new URL(base).pathname.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'authorization': `Bearer ${apiKey}`,
				'content-type': 'application/json',
				'accept': 'text/event-stream',
			},
			body: JSON.stringify(body),
			signal,
		})
		if (!response.ok) {
			const detail = (await response.text().catch(() => '')).slice(0, 300)
			const status = response.status
			if (status === 401 || status === 403) throw new LlmError(`gateway chat auth failed: ${detail}`, 'AUTH')
			if (status === 429) throw new LlmError(`gateway chat rate limited: ${detail}`, 'RATE_LIMIT')
			if (status === 400 || status === 413 || status === 422) throw new LlmError(`gateway chat rejected the request: ${detail}`, 'INVALID_REQUEST')
			throw new LlmError(`gateway chat HTTP ${status}: ${detail}`, status >= 500 ? 'SERVER' : 'INVALID_REQUEST')
		}
		if (response.body === null) throw new LlmError('gateway chat returned an empty body', 'EMPTY_RESPONSE')
		yield* translate(parseSse(response.body, () => undefined))
	}
}

/**
 * Register the gateway-chat provider route. Modeled on the dsh-llm-deepseek
 * api-key plugin: one adapter instance, one provider route, credentials from
 * the launching environment (the planner child only ever sees the env the
 * parent explicitly forwards).
 */
export function apply(ctx) {
	const resolveConnection = () => ({
		baseURL: launchEnv(ctx).get('DEEPSEEK_BASE_URL')?.value ?? '',
		models: [],
	})
	const resolveApiKey = async () => {
		const ambient = launchEnv(ctx).get('DEEPSEEK_API_KEY')
		if (ambient !== undefined && ambient.value.length > 0) return ambient.value
		throw new LlmError('llm-gateway-chat: DEEPSEEK_API_KEY is missing from the planner environment', 'MISSING_CREDENTIAL')
	}
	ctx.llm.registerConfigurableProviders([{
		provider: GATEWAY_PROVIDER,
		displayName: 'Gateway Chat',
		settingsNs: 'llm-gateway-chat',
		settingsPath: [],
	}])
	ctx.llm.registerAdapter([GATEWAY_PROVIDER], new GatewayChatAdapter({
		resolveConnection,
		resolveApiKey,
		providerName: 'Gateway Chat',
	}))
}

/** Read the dsh launch environment (ambient process env of the subprocess). */
function launchEnv(ctx) {
	try {
		const environment = ctx.get('launchEnvironment')
		if (environment !== undefined) return environment
	} catch { /* fallback below */ }
	return {
		get: (ref) => {
			const value = process.env[ref]
			return value === undefined ? undefined : { value }
		},
	}
}
