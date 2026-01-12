import { Anthropic } from "@anthropic-ai/sdk"
import axios from "axios"
import { Readable } from "stream"

import { type ModelInfo, openAiModelInfoSaneDefaults, LMSTUDIO_DEFAULT_TEMPERATURE } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { NativeToolCallParser } from "../../core/assistant-message/NativeToolCallParser"
import { XmlMatcher } from "../../utils/xml-matcher"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { getModelsFromCache } from "./fetchers/modelCache"

// SSE chunk parser for streaming responses
class SSEParser {
	private buffer = ""

	parse(chunk: string): string[] {
		const results: string[] = []
		this.buffer += chunk

		const lines = this.buffer.split("\n")
		this.buffer = lines.pop() || ""

		for (const line of lines) {
			if (line.startsWith("data: ")) {
				const data = line.slice(6).trim()
				if (data && data !== "[DONE]") {
					results.push(data)
				}
			}
		}

		return results
	}

	final(): string[] {
		const results: string[] = []
		if (this.buffer.trim()) {
			const data = this.buffer.trim()
			if (data.startsWith("data: ")) {
				const content = data.slice(6).trim()
				if (content && content !== "[DONE]") {
					results.push(content)
				}
			}
		}
		return results
	}
}

export class LmStudioHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private baseUrl: string
	private currentAbortController: AbortController | null = null
	private currentStream: Readable | null = null

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.baseUrl = (this.options.lmStudioBaseUrl || "http://localhost:1234") + "/v1"
		console.log("[LmStudio] Initializing with axios - bypasses undici 300s timeout limit")
	}

	/**
	 * Abort the current streaming request if one is in progress.
	 * This is called when the user cancels the task.
	 */
	abort(): void {
		console.log("[LmStudio] abort() called")

		// First, destroy the stream to stop reading data
		if (this.currentStream) {
			console.log("[LmStudio] Destroying current stream")
			try {
				if (!this.currentStream.destroyed) {
					this.currentStream.destroy()
				}
			} catch (e) {
				console.error("[LmStudio] Error destroying stream:", e)
			}
			this.currentStream = null
		}

		// Then abort the HTTP request
		if (this.currentAbortController) {
			console.log("[LmStudio] Aborting HTTP request via AbortController")
			try {
				this.currentAbortController.abort()
			} catch (e) {
				console.error("[LmStudio] Error aborting request:", e)
			}
			this.currentAbortController = null
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const openAiMessages = [
			{ role: "system" as const, content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// LM Studio always supports native tools (https://lmstudio.ai/docs/developer/core/tools)
		const useNativeTools = metadata?.tools && metadata.tools.length > 0 && metadata?.toolProtocol !== "xml"

		// -------------------------
		// Track token usage
		// -------------------------
		const toContentBlocks = (
			blocks: Anthropic.Messages.MessageParam[] | string,
		): Anthropic.Messages.ContentBlockParam[] => {
			if (typeof blocks === "string") {
				return [{ type: "text", text: blocks }]
			}

			const result: Anthropic.Messages.ContentBlockParam[] = []
			for (const msg of blocks) {
				if (typeof msg.content === "string") {
					result.push({ type: "text", text: msg.content })
				} else if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text") {
							result.push({ type: "text", text: part.text })
						}
					}
				}
			}
			return result
		}

		let inputTokens = 0
		try {
			inputTokens = await this.countTokens([{ type: "text", text: systemPrompt }, ...toContentBlocks(messages)])
		} catch (err) {
			console.error("[LmStudio] Failed to count input tokens:", err)
			inputTokens = 0
		}

		// Create abort controller for this request
		this.currentAbortController = new AbortController()
		const abortSignal = this.currentAbortController.signal

		let assistantText = ""

		try {
			const params: any = {
				model: this.getModel().id,
				messages: openAiMessages,
				temperature: this.options.modelTemperature ?? LMSTUDIO_DEFAULT_TEMPERATURE,
				stream: true,
				...(useNativeTools && { tools: this.convertToolsForOpenAI(metadata.tools) }),
				...(useNativeTools && metadata.tool_choice && { tool_choice: metadata.tool_choice }),
				...(useNativeTools && { parallel_tool_calls: metadata?.parallelToolCalls ?? false }),
			}

			if (this.options.lmStudioSpeculativeDecodingEnabled && this.options.lmStudioDraftModelId) {
				params.draft_model = this.options.lmStudioDraftModelId
			}

			console.log(`[LmStudio] Starting streaming request with axios (no timeout limit)`)

			// Use axios with responseType: 'stream' to get raw stream
			const response = await axios({
				method: "POST",
				url: `${this.baseUrl}/chat/completions`,
				data: params,
				timeout: 0, // No timeout with axios - bypasses undici 300s limit
				responseType: "stream",
				signal: abortSignal, // Enable cancellation
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
			})

			console.log(`[LmStudio] Stream started, response status: ${response.status}`)

			const sseParser = new SSEParser()
			const matcher = new XmlMatcher(
				"think",
				(chunk) =>
					({
						type: chunk.matched ? "reasoning" : "text",
						text: chunk.data,
					}) as const,
			)

			// Store stream reference for abort()
			this.currentStream = response.data

			if (!this.currentStream) {
				throw new Error("No stream data received from LM Studio")
			}

			// Process streaming response
			for await (const chunk of this.currentStream) {
				// Check if we've been aborted
				if (abortSignal.aborted) {
					console.log("[LmStudio] Detected abort signal during stream processing")
					break
				}

				const chunkStr = chunk.toString("utf-8")
				const dataChunks = sseParser.parse(chunkStr)

				for (const data of dataChunks) {
					try {
						const parsed = JSON.parse(data)
						const delta = parsed.choices?.[0]?.delta
						const finishReason = parsed.choices?.[0]?.finish_reason

						if (delta?.content) {
							assistantText += delta.content
							for (const processedChunk of matcher.update(delta.content)) {
								yield processedChunk
							}
						}

						// Handle tool calls in stream - emit partial chunks for NativeToolCallParser
						if (delta?.tool_calls) {
							for (const toolCall of delta.tool_calls) {
								yield {
									type: "tool_call_partial",
									index: toolCall.index,
									id: toolCall.id,
									name: toolCall.function?.name,
									arguments: toolCall.function?.arguments,
								}
							}
						}

						// Process finish_reason to emit tool_call_end events
						if (finishReason) {
							const endEvents = NativeToolCallParser.processFinishReason(finishReason)
							for (const event of endEvents) {
								yield event
							}
						}
					} catch (e) {
						console.error("[LmStudio] Failed to parse SSE data:", data, e)
					}
				}
			}

			// Only process final buffer if not aborted
			if (!abortSignal.aborted) {
				// Process final buffer
				const finalChunks = sseParser.final()
				for (const data of finalChunks) {
					try {
						const parsed = JSON.parse(data)
						const delta = parsed.choices?.[0]?.delta

						if (delta?.content) {
							assistantText += delta.content
							for (const processedChunk of matcher.update(delta.content)) {
								yield processedChunk
							}
						}
					} catch (e) {
						// Ignore parse errors in final buffer
					}
				}

				// Flush matcher
				for (const processedChunk of matcher.final()) {
					yield processedChunk
				}

				let outputTokens = 0
				try {
					outputTokens = await this.countTokens([{ type: "text", text: assistantText }])
				} catch (err) {
					console.error("[LmStudio] Failed to count output tokens:", err)
					outputTokens = 0
				}

				yield {
					type: "usage",
					inputTokens,
					outputTokens,
				} as const

				console.log(`[LmStudio] Stream completed successfully`)
			} else {
				console.log("[LmStudio] Stream processing stopped due to abort")
			}
		} catch (error: any) {
			// Handle cancellation - don't treat as error
			if (axios.isCancel(error) || error.name === "CanceledError" || abortSignal.aborted) {
				console.log("[LmStudio] Request was cancelled")
				return // Exit gracefully on cancellation
			}
			if (error.code === "ECONNABORTED") {
				throw new Error("Request timed out. This shouldn't happen with axios - please check your setup.")
			}
			if (error.code === "ERR_STREAM_DESTROYED") {
				console.log("[LmStudio] Stream was destroyed (likely due to cancellation)")
				return // Exit gracefully
			}
			console.error("[LmStudio] Stream error:", error)
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Roo Code's prompts.",
			)
		} finally {
			// Clean up: destroy stream and clear references
			if (this.currentStream && !this.currentStream.destroyed) {
				this.currentStream.destroy()
				console.log("[LmStudio] Stream destroyed in finally block")
			}
			this.currentStream = null
			this.currentAbortController = null
		}
	}

	override getModel(): { id: string; info: ModelInfo } {
		const models = getModelsFromCache("lmstudio")
		if (models && this.options.lmStudioModelId && models[this.options.lmStudioModelId]) {
			return {
				id: this.options.lmStudioModelId,
				info: models[this.options.lmStudioModelId],
			}
		} else {
			return {
				id: this.options.lmStudioModelId || "",
				info: openAiModelInfoSaneDefaults,
			}
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const params: any = {
				model: this.getModel().id,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? LMSTUDIO_DEFAULT_TEMPERATURE,
				stream: false,
			}

			if (this.options.lmStudioSpeculativeDecodingEnabled && this.options.lmStudioDraftModelId) {
				params.draft_model = this.options.lmStudioDraftModelId
			}

			const response = await axios({
				method: "POST",
				url: `${this.baseUrl}/chat/completions`,
				data: params,
				timeout: 0, // No timeout
				headers: {
					"Content-Type": "application/json",
				},
			})

			return response.data?.choices?.[0]?.message?.content || ""
		} catch (error) {
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Roo Code's prompts.",
			)
		}
	}
}

export async function getLmStudioModels(baseUrl = "http://localhost:1234") {
	try {
		if (!URL.canParse(baseUrl)) {
			return []
		}

		const response = await axios.get(`${baseUrl}/v1/models`)
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
