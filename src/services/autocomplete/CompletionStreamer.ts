import { ApiHandler } from "../../api"
import { PromptRenderer } from "./PromptRenderer"

/**
 * Interface for completion request
 */
export interface CompletionRequest {
	prompt: string
	systemPrompt: string
	maxTokens: number
	temperature: number
	stopSequences?: string[]
}

/**
 * Interface for completion result
 */
export interface CompletionResult {
	completion: string
	isComplete: boolean
	error?: Error
}

/**
 * Handles streaming completions from the API
 */
export class CompletionStreamer {
	private apiHandler: ApiHandler
	private promptRenderer: PromptRenderer
	private activeRequests: Map<string, AbortController>

	/**
	 * Create a new completion streamer
	 * @param apiHandler API handler
	 * @param promptRenderer Prompt renderer
	 */
	constructor(apiHandler: ApiHandler, promptRenderer: PromptRenderer) {
		this.apiHandler = apiHandler
		this.promptRenderer = promptRenderer
		this.activeRequests = new Map<string, AbortController>()
	}

	/**
	 * Stream a completion from the API
	 * @param request Completion request
	 * @param completionId Unique ID for this completion request
	 * @param onPartialCompletion Callback for partial completions
	 * @param signal AbortSignal to cancel the request
	 * @returns Promise that resolves when the completion is done
	 */
	async streamCompletion(
		request: CompletionRequest,
		completionId: string,
		onPartialCompletion: (result: CompletionResult) => void,
		signal?: AbortSignal,
	): Promise<CompletionResult> {
		// Create an abort controller for this request
		const abortController = new AbortController()
		this.activeRequests.set(completionId, abortController)

		// If an external signal is provided, link it to our abort controller
		if (signal) {
			signal.addEventListener("abort", () => {
				abortController.abort()
			})
		}

		try {
			let fullCompletion = ""

			// Create messages for the API
			const messages = [
				{
					role: "user" as const,
					content: request.prompt,
				},
			]

			// Create a stream from the API
			console.log(`CompletionStreamer: Creating stream with completionId ${completionId}`)
			const stream = this.apiHandler.createMessage(
				request.systemPrompt,
				messages,
				completionId, // Use completionId as cache key
			)

			// Process the stream
			console.log(`CompletionStreamer: Starting to process stream`)
			let chunkCount = 0
			for await (const chunk of stream) {
				chunkCount++
				console.log(`CompletionStreamer: Received chunk #${chunkCount}:`, chunk)

				if (!chunk) {
					console.warn(`CompletionStreamer: Received empty chunk`)
					continue
				}

				if (chunk.type === "text") {
					// Extract the completion from the chunk
					console.log(`CompletionStreamer: Processing text chunk: "${chunk.text}"`)
					const extractedCompletion = this.promptRenderer.extractCompletion(chunk.text)
					console.log(`CompletionStreamer: Extracted completion: "${extractedCompletion}"`)
					fullCompletion += extractedCompletion

					// Call the callback with the partial completion
					console.log(
						`CompletionStreamer: Calling onPartialCompletion with completion length ${fullCompletion.length}`,
					)
					onPartialCompletion({
						completion: fullCompletion,
						isComplete: false,
					})
				} else {
					console.log(`CompletionStreamer: Received non-text chunk type: ${chunk.type}`)
				}

				// Check if the request was aborted
				if (abortController.signal.aborted) {
					break
				}
			}

			// Clean up
			this.activeRequests.delete(completionId)
			console.log(
				`CompletionStreamer: Stream completed with ${chunkCount} chunks. Final completion:`,
				fullCompletion,
			)

			// Return the final completion
			return {
				completion: fullCompletion,
				isComplete: true,
			}
		} catch (error) {
			// Clean up
			this.activeRequests.delete(completionId)
			console.log(`CompletionStreamer: Error in stream:`, error)

			// If the request was aborted, don't treat it as an error
			if (error instanceof Error && error.name === "AbortError") {
				return {
					completion: "",
					isComplete: false,
				}
			}

			// Return the error
			return {
				completion: "",
				isComplete: false,
				error: error instanceof Error ? error : new Error(String(error)),
			}
		}
	}

	/**
	 * Cancel a completion request
	 * @param completionId ID of the completion to cancel
	 */
	cancelCompletion(completionId: string): void {
		const controller = this.activeRequests.get(completionId)
		if (controller) {
			controller.abort()
			this.activeRequests.delete(completionId)
		}
	}

	/**
	 * Cancel all active completion requests
	 */
	cancelAllCompletions(): void {
		for (const controller of this.activeRequests.values()) {
			controller.abort()
		}
		this.activeRequests.clear()
	}
}
