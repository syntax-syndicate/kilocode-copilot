import * as vscode from "vscode"
import { KiloCodeIDEAdapter } from "./KiloCodeIDEAdapter"
import { KiloCodeConfigAdapter } from "./KiloCodeConfigAdapter"
import { ApiHandler, buildApiHandler } from "../../api"
import { ProviderSettings } from "../../shared/api"
import { CompletionCache } from "./CompletionCache"
import { ContextGatherer } from "./ContextGatherer"
import { PromptRenderer } from "./PromptRenderer"

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

	// Decoration-based ghost text properties
	private decoration: vscode.TextEditorDecorationType
	private currentGhostText: string = ""
	private isShowingDecoration: boolean = false

	constructor() {
		this.ide = new KiloCodeIDEAdapter()
		this.config = new KiloCodeConfigAdapter()
		this.cache = new CompletionCache()
		this.contextGatherer = new ContextGatherer(this.ide)
		this.promptRenderer = new PromptRenderer()

		// Initialize the decoration type for ghost text
		this.decoration = vscode.window.createTextEditorDecorationType({
			after: {
				// Use the same styling as the built-in ghost text
				color: new vscode.ThemeColor("editorGhostText.foreground"),
				margin: "0 0 0 0.5em",
			},
		})
	}

	/**
	 * Updates the ghost text decoration at the current cursor position
	 * @param editor The active text editor
	 * @param text The ghost text to display
	 */
	private updateGhostText(editor: vscode.TextEditor, text: string) {
		this.currentGhostText = text

		if (!text) {
			this.clearGhostText(editor)
			return
		}

		const pos = editor.selection.active
		const range = new vscode.Range(pos, pos)
		const decoration: vscode.DecorationOptions = {
			range,
			renderOptions: { after: { contentText: text } },
		}

		editor.setDecorations(this.decoration, [decoration])
		this.isShowingDecoration = true

		// Update the context for keybindings
		if ((this as any).updateGhostTextVisibility) {
			;(this as any).updateGhostTextVisibility(true)
		}
	}

	/**
	 * Clears any displayed ghost text
	 * @param editor The active text editor
	 */
	private clearGhostText(editor: vscode.TextEditor) {
		editor.setDecorations(this.decoration, [])
		this.isShowingDecoration = false

		// Update the context for keybindings
		if ((this as any).updateGhostTextVisibility) {
			;(this as any).updateGhostTextVisibility(false)
		}

		// Update the context for keybindings
		if ((this as any).updateGhostTextVisibility) {
			;(this as any).updateGhostTextVisibility(false)
		}
	}

	/**
	 * Register the autocomplete provider with VSCode
	 */
	register(context: vscode.ExtensionContext) {
		// Debug: Check if API handler initializes correctly
		console.log("🔍 AutocompleteProvider: Starting register method, initializing API handler...")
		this.initializeApiHandler()

		// Register configuration for autocomplete
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("kilo-code.autocomplete")) {
					// Reset API handler to pick up new configuration
					this.apiHandler = null

					// Update debounce delay
					const config = vscode.workspace.getConfiguration("kilo-code")
					this.debounceDelay = config.get("autocomplete.debounceDelay") || 150
				}
			}),
		)

		// Register cursor position change event to update ghost text position
		context.subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (this.isShowingDecoration && e.textEditor) {
					// Update the ghost text position when cursor moves
					if (this.currentGhostText) {
						this.updateGhostText(e.textEditor, this.currentGhostText)
					}
				}
			}),
		)

		// Register document change event to clear ghost text when document changes
		context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				const editor = vscode.window.activeTextEditor
				if (editor && e.document === editor.document && this.isShowingDecoration) {
					// Clear ghost text when document changes
					this.clearGhostText(editor)
				}
			}),
		)

		// Register status bar item to show autocomplete status
		const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
		statusBarItem.text = "$(sparkle) Autocomplete"
		statusBarItem.tooltip = "Kilo Code Autocomplete"
		statusBarItem.command = "kilo-code.toggleAutocomplete"
		statusBarItem.show()
		context.subscriptions.push(statusBarItem)

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
					console.log(
						"🚀 ~ AutocompleteProvider ~ provideInlineCompletionItems: ~ document, position, context, token:",
						{ document, position, context, token },
					)
					// Check if autocomplete is enabled
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

					// Create a new completion with debounce
					return new Promise((resolve) => {
						this.debounceTimeout = setTimeout(async () => {
							try {
								// Initialize API handler if needed
								this.apiHandler = await this.initializeApiHandler()

								if (!this.apiHandler) {
									resolve(null)
									return
								}

								// No need to initialize completion streamer anymore

								// Check if we have a cached completion
								const cursorIndex = document.offsetAt(position)
								const cachedCompletion = this.cache.get(
									document.uri.toString(),
									document.getText(),
									cursorIndex,
								)

								console.log("🚀 ~ AutocompleteProvider ~ cachedCompletion:", cachedCompletion)
								if (cachedCompletion) {
									const completionItem = new vscode.InlineCompletionItem(
										cachedCompletion,
										new vscode.Range(position, position),
									)
									resolve([completionItem])
									return
								}

								// Generate a unique ID for this completion
								const completionId = crypto.randomUUID()
								this.activeCompletionId = completionId

								// Get configuration (commented out for now as we're using a placeholder)
								const { config: conf } = await this.config.loadConfig()
								const useImports = conf?.tabAutocompleteOptions?.useImports || false
								const useDefinitions = conf?.tabAutocompleteOptions?.onlyMyCode || false
								const multilineCompletions =
									conf?.tabAutocompleteOptions?.multilineCompletions || "auto"

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

								// Stream the completion from the API
								const request = {
									prompt,
									systemPrompt,
									maxTokens: 1024,
									temperature: 0.2,
									stopSequences: ["```"],
								}
								console.log("🚀 ~ AutocompleteProvider ~ request:", request)

								// Log API handler details
								console.log("AutocompleteProvider: API handler details:", {
									provider: this.apiHandler?.getModel().id,
									modelInfo: this.apiHandler?.getModel().info,
								})

								console.log(
									"AutocompleteProvider: Starting streamCompletion with completionId:",
									completionId,
								)

								console.log("AutocompleteProvider: Using streaming approach")

								try {
									// API handler should already be initialized
									// No need to get provider settings here as it's handled in initializeApiHandler

									// Create a cancellation flag
									let isCancelled = false

									// Store the active completion ID to check for cancellation
									const currentCompletionId = completionId

									// Function to check if the request has been cancelled
									const checkCancellation = () => {
										if (this.activeCompletionId !== currentCompletionId) {
											isCancelled = true
											console.log("AutocompleteProvider: Completion cancelled, ID mismatch")
											return true
										}
										return false
									}

									// Initialize an empty completion
									latestCompletion = ""

									// Create a message stream using the API handler
									const systemPromptMessage = request.systemPrompt
									const userMessage = request.prompt

									// Create the stream using the API handler's createMessage method
									const stream = this.apiHandler.createMessage(systemPromptMessage, [
										{ role: "user", content: [{ type: "text", text: userMessage }] },
									])

									console.log("AutocompleteProvider: Started streaming completion")

									// Process the stream
									for await (const chunk of stream) {
										// Check for cancellation before processing each chunk
										if (checkCancellation()) {
											break
										}

										// Process text chunks
										if (chunk.type === "text") {
											// Clean markdown code blocks from the chunk text
											// const cleanedText = this.cleanMarkdownCodeBlocks(chunk.text)
											// const cleanedText = this.cleanMarkdownCodeBlocks(chunk.text)

											// Append the cleaned chunk text to the completion
											latestCompletion += chunk.text

											// Update the ghost text as chunks arrive
											const editor = vscode.window.activeTextEditor
											if (editor && editor.document === document) {
												const cleanedText = this.cleanMarkdownCodeBlocks(chunk.text)
												this.updateGhostText(editor, cleanedText)
											}
										}
									}

									const finalCompletion = this.cleanMarkdownCodeBlocks(latestCompletion)

									// If cancelled, don't proceed with the completion
									if (isCancelled) {
										console.log("AutocompleteProvider: Completion was cancelled")
										resolve(null)
										return
									}

									console.log("AutocompleteProvider: Completed streaming:", {
										completionLength: finalCompletion.length,
										completion:
											finalCompletion.substring(0, 100) +
											(finalCompletion.length > 100 ? "..." : ""),
									})

									const selectedCompletionInfo = context.selectedCompletionInfo

									// This code checks if there is a selected completion suggestion in the given context and ensures that it is valid
									// To improve the accuracy of suggestions it checks if the user has typed at least 4 characters
									// This helps refine and filter out irrelevant autocomplete options
									if (selectedCompletionInfo) {
										const { text, range } = selectedCompletionInfo
										const typedText = document.getText(range)
										const typedLength = range.end.character - range.start.character

										if (typedLength < 4) {
											return null
										}

										if (!text.startsWith(typedText)) {
											return null
										}
									}

									// Cache the completion
									this.cache.set(
										document.uri.toString(),
										document.getText(),
										cursorIndex,
										finalCompletion,
									)

									// Update the ghost text using our decoration approach
									const editor = vscode.window.activeTextEditor
									console.log("🚀 ~ AutocompleteProvider ~ finalCompletion:", finalCompletion)
									if (editor && editor.document === document) {
										this.updateGhostText(editor, finalCompletion)
									}

									// Return null since we're handling the display ourselves with decorations
									resolve(null)
								} catch (error) {
									console.log("🚀 ~ AutocompleteProvider ~ error:", error)
									console.error("Error getting completion:", error)
									// Log more details about the error
									if (error instanceof Error) {
										console.error("Error name:", error.name)
										console.error("Error message:", error.message)
										console.error("Error stack:", error.stack)
									}
									resolve(null)
								}

								// No unreachable code here
							} catch (error) {
								console.log("🚀 ~ AutocompleteProvider ~ error:", error)
								console.error("Error providing autocomplete:", error)
								resolve(null)
								return null
							}
						}, this.debounceDelay)
					})
				},
			},
		)

		context.subscriptions.push(disposable)

		// Register command to accept the current ghost text
		const acceptCommand = vscode.commands.registerCommand("kilo-code.acceptGhostText", () => {
			const editor = vscode.window.activeTextEditor
			if (editor && this.isShowingDecoration && this.currentGhostText) {
				const pos = editor.selection.active

				// Insert the ghost text at the current position
				editor
					.edit((editBuilder) => {
						editBuilder.insert(pos, this.currentGhostText)
					})
					.then(() => {
						// Clear the ghost text after insertion
						this.clearGhostText(editor)
					})
			}
		})

		// Register command to dismiss the current ghost text
		const dismissCommand = vscode.commands.registerCommand("kilo-code.dismissGhostText", () => {
			const editor = vscode.window.activeTextEditor
			if (editor && this.isShowingDecoration) {
				this.clearGhostText(editor)
			}
		})

		context.subscriptions.push(acceptCommand, dismissCommand)

		return disposable
	}

	/**
	 * Initialize the API handler and return it
	 * @returns The initialized API handler or null if initialization fails
	 */
	/**
	 * Cleans markdown-style code blocks from text
	 * Handles both complete and partial code blocks that might appear in streaming responses
	 * @param text The text to clean
	 * @returns The cleaned text without markdown code block formatting
	 */
	private cleanMarkdownCodeBlocks(text: string): string {
		// Handle complete code blocks
		// Replace ```language\n...\n``` with just the content
		let cleanedText = text.replace(/```[\w-]*\n([\s\S]*?)\n```/g, "$1")

		// Handle opening code block markers at the beginning of a chunk
		// This handles partial blocks that might start in this chunk
		cleanedText = cleanedText.replace(/^```[\w-]*\n/g, "")

		// Handle opening code block markers in the middle of a chunk
		// This handles cases where a new code block starts within this chunk
		cleanedText = cleanedText.replace(/\n```[\w-]*\n/g, "\n")

		// Handle closing code block markers
		// This handles partial blocks that might end in this chunk
		cleanedText = cleanedText.replace(/\n```$/g, "")

		return cleanedText
	}

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

	/**
	 * Dispose of resources
	 */
	dispose() {
		// Dispose of the decoration type
		this.decoration.dispose()

		// Clear any active ghost text
		const editor = vscode.window.activeTextEditor
		if (editor && this.isShowingDecoration) {
			this.clearGhostText(editor)
		}
	}
}
