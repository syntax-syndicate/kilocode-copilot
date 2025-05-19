import * as vscode from "vscode"
import { KiloCodeIDEAdapter } from "./KiloCodeIDEAdapter"
import { KiloCodeConfigAdapter } from "./KiloCodeConfigAdapter"
import { ApiHandler, buildApiHandler } from "../../api"
import { ProviderSettings } from "../../shared/api"
import { CompletionCache } from "./CompletionCache"
import { ContextGatherer } from "./ContextGatherer"
import { PromptRenderer } from "./PromptRenderer"
import { AutocompletePreviewManager } from "./AutocompletePreviewManager"

/**
 * Provider for autocomplete functionality
 */
export class AutocompleteProvider {
	private apiHandler: ApiHandler | null = null
	private enabled: boolean = true
	private cache: CompletionCache
	private contextGatherer: ContextGatherer
	private promptRenderer: PromptRenderer
	private ide: KiloCodeIDEAdapter
	private config: KiloCodeConfigAdapter
	private activeCompletionId: string | null = null
	private debounceTimeout: NodeJS.Timeout | null = null
	private debounceDelay: number = 150
	private previewManager: AutocompletePreviewManager

	constructor() {
		this.ide = new KiloCodeIDEAdapter()
		this.config = new KiloCodeConfigAdapter()
		this.cache = new CompletionCache()
		this.contextGatherer = new ContextGatherer(this.ide)
		this.promptRenderer = new PromptRenderer()
		this.previewManager = new AutocompletePreviewManager()
	}

	/**
	 * Register the autocomplete provider with VSCode
	 */
	register(context: vscode.ExtensionContext) {
		this.previewManager.register(context)

		this.initializeApiHandler()

		// Register status bar item to show autocomplete status
		const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
		statusBarItem.text = "$(sparkle) Autocomplete"
		statusBarItem.tooltip = "Kilo Code Autocomplete"
		statusBarItem.command = "kilo-code.toggleAutocomplete"
		statusBarItem.show()
		context.subscriptions.push(statusBarItem)

		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("kilo-code.autocomplete")) {
					this.apiHandler = null

					const config = vscode.workspace.getConfiguration("kilo-code")
					this.debounceDelay = config.get("autocomplete.debounceDelay") || 150
				}
			}),
		)

		// Register command to toggle autocomplete
		context.subscriptions.push(
			vscode.commands.registerCommand("kilo-code.toggleAutocomplete", () => {
				this.enabled = !this.enabled
				statusBarItem.text = this.enabled ? "$(sparkle) Autocomplete" : "$(circle-slash) Autocomplete"
				vscode.window.showInformationMessage(`Autocomplete ${this.enabled ? "enabled" : "disabled"}`)
			}),
		)

		// Register as VSCode completion provider (only once per registration)
		const disposable = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**" },
			{
				provideInlineCompletionItems: async (document, position, context, token) => {
					if (!this.enabled) {
						return null
					}

					// Check if autocomplete is disabled for this file
					const config = vscode.workspace.getConfiguration("kilo-code")
					const disabledPatterns = config.get<string>("autocomplete.disableInFiles") || ""
					const patterns = disabledPatterns
						.split(",")
						.map((p) => p.trim())
						.filter(Boolean)

					if (
						patterns.some((pattern) => {
							const glob = new vscode.RelativePattern(
								vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
								pattern,
							)
							return vscode.languages.match({ pattern: glob }, document)
						})
					) {
						return null
					}

					// Cancel any active completion
					if (this.activeCompletionId) {
						this.activeCompletionId = null
					}

					// Clear any existing debounce timeout
					if (this.debounceTimeout) {
						clearTimeout(this.debounceTimeout)
					}

					const editor = vscode.window.activeTextEditor

					this.debounceTimeout = setTimeout(async () => {
						try {
							// Initialize API handler if needed
							this.apiHandler = await this.initializeApiHandler()

							if (!this.apiHandler) {
								return
							}

							// Check if we have a cached completion
							const cursorIndex = document.offsetAt(position)
							const cachedCompletion = this.cache.get(
								document.uri.toString(),
								document.getText(),
								cursorIndex,
							)

							if (cachedCompletion) {
							}

							// Generate a unique ID for this completion
							const completionId = crypto.randomUUID()
							this.activeCompletionId = completionId

							// Get configuration (commented out for now as we're using a placeholder)
							const { config: conf } = await this.config.loadConfig()
							const useImports = conf?.tabAutocompleteOptions?.useImports || false
							const useDefinitions = conf?.tabAutocompleteOptions?.onlyMyCode || false
							const multilineCompletions = conf?.tabAutocompleteOptions?.multilineCompletions || "auto"

							// Gather context (commented out for now as we're using a placeholder)
							const codeContext = await this.contextGatherer.gatherContext(
								document,
								position,
								useImports,
								useDefinitions,
							)

							// Render prompt (commented out for now as we're using a placeholder)
							const prompt = this.promptRenderer.renderPrompt(codeContext, {
								language: document.languageId,
								includeImports: useImports,
								includeDefinitions: useDefinitions,
								multilineCompletions: multilineCompletions as any,
							})

							const systemPrompt = this.promptRenderer.renderSystemPrompt()

							// Create an abort controller that will be cancelled if the token is cancelled
							const abortController = new AbortController()
							token.onCancellationRequested(() => {
								abortController.abort()
								if (this.activeCompletionId === completionId) {
									this.activeCompletionId = null
								}
							})

							let latestCompletion = ""

							// Create a cancellation flag
							let isCancelled = false

							// Store the active completion ID to check for cancellation
							const currentCompletionId = completionId

							// Function to check if the request has been cancelled
							const checkCancellation = () => {
								if (this.activeCompletionId !== currentCompletionId) {
									isCancelled = true
									return true
								}
								return false
							}

							// Initialize an empty completion
							latestCompletion = ""

							// Create the stream using the API handler's createMessage method
							const stream = this.apiHandler.createMessage(systemPrompt, [
								{ role: "user", content: [{ type: "text", text: prompt }] },
							])

							// Process the stream
							for await (const chunk of stream) {
								if (checkCancellation()) {
									break
								}

								if (chunk.type === "text") {
									latestCompletion += chunk.text

									// Update the ghost text as chunks arrive (using throttled updates)
									if (editor && editor.document === document) {
										this.previewManager.throttledUpdateGhostText(editor, latestCompletion)
									}
								}
							}

							if (isCancelled) {
								return
							}

							// This code checks if there is a selected completion suggestion in the given context and ensures that it is valid
							// To improve the accuracy of suggestions it checks if the user has typed at least 4 characters
							// This helps refine and filter out irrelevant autocomplete options
							const selectedCompletionInfo = context.selectedCompletionInfo
							if (selectedCompletionInfo) {
								const { text, range } = selectedCompletionInfo
								const typedText = document.getText(range)
								const typedLength = range.end.character - range.start.character

								if (typedLength < 4 || !text.startsWith(typedText)) {
									return null
								}
							}

							// Cache the completion
							const finalCompletion = this.previewManager.cleanMarkdownCodeBlocks(latestCompletion)
							this.cache.set(document.uri.toString(), document.getText(), cursorIndex, finalCompletion)

							if (editor && editor.document === document) {
								this.previewManager.updateGhostText(editor, finalCompletion)
							}
						} catch (error) {
							console.error("Error getting completion:", error)
						}
					}, this.debounceDelay)
				},
			},
		)

		context.subscriptions.push(disposable)

		return disposable
	}

	/**
	 * Initialize the API handler and return it
	 * @returns The initialized API handler or null if initialization fails
	 */

	private async initializeApiHandler(): Promise<ApiHandler | null> {
		// Return existing API handler if it exists
		if (this.apiHandler) {
			return this.apiHandler
		}

		try {
			// Use simple Ollama settings without reading any configs
			const providerSettings: ProviderSettings = {
				apiProvider: "ollama",
				ollamaModelId: "qwen2.5-coder:1.5b", // Changed from apiModelId to ollamaModelId
				ollamaBaseUrl: "http://localhost:11434",
			}

			console.log("AutocompleteProvider: Initializing API handler with Ollama settings:", {
				apiProvider: providerSettings.apiProvider,
				ollamaModelId: providerSettings.ollamaModelId,
				ollamaBaseUrl: providerSettings.ollamaBaseUrl,
			})

			const apiHandler = buildApiHandler(providerSettings)

			// Perform a sanity check to verify the API is responsive
			return this.performApiSanityCheck(apiHandler)
		} catch (error) {
			console.error("Error initializing API handler:", error)
			vscode.window.showErrorMessage(
				`Failed to initialize autocomplete: ${error instanceof Error ? error.message : String(error)}`,
			)
			return null
		}
	}

	/**
	 * Performs a quick sanity check to verify the API handler is working correctly
	 * @param apiHandler The API handler to check
	 * @returns The API handler if it's working, or null if there's an issue
	 */
	private async performApiSanityCheck(apiHandler: ApiHandler): Promise<ApiHandler | null> {
		if (!apiHandler) {
			console.warn("AutocompleteProvider: Cannot perform sanity check - API handler is null")
			return null
		}

		try {
			console.log("AutocompleteProvider: Performing API sanity check...")

			// Check if the model information is available
			const modelInfo = apiHandler.getModel()
			if (!modelInfo || !modelInfo.id) {
				console.error("AutocompleteProvider: API sanity check failed - Model ID is missing")
				vscode.window.showWarningMessage("Autocomplete API sanity check failed: Model ID is missing")
				return null
			}

			console.log("AutocompleteProvider: Using model:", modelInfo.id)

			// Test the createMessage method with a minimal prompt to verify it works
			// This tests the exact same API functionality that will be used in the actual completion
			const systemPrompt = "You are a helpful assistant."
			const userPrompt = "Say hello"

			// Create a message stream to verify it works
			const stream = apiHandler.createMessage(systemPrompt, [
				{ role: "user", content: [{ type: "text", text: userPrompt }] },
			])

			// Just start the stream to verify it works, we don't need to process all chunks
			const iterator = stream[Symbol.asyncIterator]()
			await iterator.next()

			// If we get here without errors, the API is responsive and the model is correctly configured
			console.log(
				"AutocompleteProvider: API sanity check passed - API is responsive and model is configured correctly",
			)
			return apiHandler
		} catch (error) {
			console.error("AutocompleteProvider: API sanity check failed:", error)

			// Provide more specific error message for model-related issues
			let errorMessage = error instanceof Error ? error.message : String(error)
			if (errorMessage.includes("model is required") || errorMessage.includes("model not found")) {
				errorMessage = `Model configuration error: ${errorMessage}. Please check your model settings.`
			}

			vscode.window.showWarningMessage(`Autocomplete API sanity check failed: ${errorMessage}`)
			return null
		}
	}

	dispose() {
		// Dispose of the preview manager
		this.previewManager.dispose()
	}
}
