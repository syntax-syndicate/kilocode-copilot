import * as vscode from "vscode"
import { KiloCodeIDEAdapter } from "./KiloCodeIDEAdapter"
import { KiloCodeConfigAdapter } from "./KiloCodeConfigAdapter"
import { ApiHandler, buildApiHandler } from "../../api"
import { ProviderSettings } from "../../shared/api"
import { CompletionCache } from "./CompletionCache"
import { ContextGatherer } from "./ContextGatherer"
import { PromptRenderer } from "./PromptRenderer"
import { AutocompletePreviewManager } from "./AutocompletePreviewManager"

// Default configuration values
const DEFAULT_DEBOUNCE_DELAY = 150
const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:1.5b"
const DEFAULT_OLLAMA_URL = "http://localhost:11434"
const MIN_TYPED_LENGTH_FOR_COMPLETION = 4

export class AutocompleteProvider {
	private apiHandler: ApiHandler | null = null
	private enabled: boolean = true
	private activeCompletionId: string | null = null
	private debounceTimeout: NodeJS.Timeout | null = null
	private debounceDelay: number = DEFAULT_DEBOUNCE_DELAY

	private readonly cache: CompletionCache
	private readonly contextGatherer: ContextGatherer
	private readonly promptRenderer: PromptRenderer
	private readonly ide: KiloCodeIDEAdapter
	private readonly config: KiloCodeConfigAdapter
	private readonly previewManager: AutocompletePreviewManager

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
	register(context: vscode.ExtensionContext): vscode.Disposable {
		this.previewManager.register(context)
		this.initializeApiHandler()

		// Register UI components and event handlers
		const statusBarItem = this.registerStatusBarItem(context)
		this.registerConfigurationWatcher(context)
		this.registerToggleCommand(context, statusBarItem)

		// Register completion provider
		const disposable = this.registerCompletionProvider()
		context.subscriptions.push(disposable)

		return disposable
	}

	/**
	 * Register status bar item to show autocomplete status
	 */
	private registerStatusBarItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
		const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
		statusBarItem.text = "$(sparkle) Autocomplete"
		statusBarItem.tooltip = "Kilo Code Autocomplete"
		statusBarItem.command = "kilo-code.toggleAutocomplete"
		statusBarItem.show()
		context.subscriptions.push(statusBarItem)
		return statusBarItem
	}

	/**
	 * Register configuration change watcher
	 */
	private registerConfigurationWatcher(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("kilo-code.autocomplete")) {
					this.apiHandler = null

					const config = vscode.workspace.getConfiguration("kilo-code")
					this.debounceDelay = config.get("autocomplete.debounceDelay") || DEFAULT_DEBOUNCE_DELAY
				}
			}),
		)
	}

	/**
	 * Register command to toggle autocomplete
	 */
	private registerToggleCommand(context: vscode.ExtensionContext, statusBarItem: vscode.StatusBarItem): void {
		context.subscriptions.push(
			vscode.commands.registerCommand("kilo-code.toggleAutocomplete", () => {
				this.enabled = !this.enabled
				statusBarItem.text = this.enabled ? "$(sparkle) Autocomplete" : "$(circle-slash) Autocomplete"
				vscode.window.showInformationMessage(`Autocomplete ${this.enabled ? "enabled" : "disabled"}`)
			}),
		)
	}

	/**
	 * Register the inline completion provider
	 */
	private registerCompletionProvider(): vscode.Disposable {
		return vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**" },
			{
				provideInlineCompletionItems: async (document, position, context, token) => {
					if (!this.enabled) {
						return null
					}

					if (this.isFileDisabled(document)) {
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

					this.debounceTimeout = setTimeout(
						() => this.handleCompletion(document, position, context, token, editor),
						this.debounceDelay,
					)

					// Return null to indicate no immediate completions
					// The actual completions will be shown via the ghost text API after debounce
					return null
				},
			},
		)
	}

	/**
	 * Checks if autocomplete is disabled for the given document based on file patterns
	 */
	private isFileDisabled(document: vscode.TextDocument): boolean {
		const config = vscode.workspace.getConfiguration("kilo-code")
		const disabledPatterns = config.get<string>("autocomplete.disableInFiles") || ""
		const patterns = disabledPatterns
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)

		return patterns.some((pattern) => {
			const glob = new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "", pattern)
			return vscode.languages.match({ pattern: glob }, document)
		})
	}

	/**
	 * Handles the completion request after debounce
	 */
	private async handleCompletion(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
		editor: vscode.TextEditor | undefined,
	): Promise<void> {
		try {
			this.apiHandler = await this.initializeApiHandler()
			if (!this.apiHandler) {
				return
			}

			const cursorIndex = document.offsetAt(position)
			const cachedCompletion = this.cache.get(document.uri.toString(), document.getText(), cursorIndex)

			// If we have a valid cached completion, use it
			if (cachedCompletion) {
				if (editor && editor.document === document) {
					this.previewManager.updateGhostText(editor, cachedCompletion)
				}
				return
			}

			await this.generateCompletion(document, position, context, token, editor, cursorIndex)
		} catch (error) {
			console.error("Error getting completion:", error)
		}
	}

	/**
	 * Generates a new completion
	 */
	private async generateCompletion(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
		editor: vscode.TextEditor | undefined,
		cursorIndex: number,
	): Promise<void> {
		// Generate a unique ID for this completion
		const completionId = crypto.randomUUID()
		this.activeCompletionId = completionId

		// Load configuration
		const { config: conf } = await this.config.loadConfig()
		const useImports = conf?.tabAutocompleteOptions?.useImports || false
		const useDefinitions = conf?.tabAutocompleteOptions?.onlyMyCode || false
		const multilineCompletions = conf?.tabAutocompleteOptions?.multilineCompletions || "auto"

		// Gather context
		const codeContext = await this.contextGatherer.gatherContext(document, position, useImports, useDefinitions)

		// Render prompts
		const prompt = this.promptRenderer.renderPrompt(codeContext, {
			language: document.languageId,
			includeImports: useImports,
			includeDefinitions: useDefinitions,
			multilineCompletions: multilineCompletions as any,
		})
		const systemPrompt = this.promptRenderer.renderSystemPrompt()

		// Setup cancellation
		const abortController = new AbortController()
		token.onCancellationRequested(() => {
			abortController.abort()
			if (this.activeCompletionId === completionId) {
				this.activeCompletionId = null
			}
		})

		// Process the completion stream
		const result = await this.processCompletionStream(systemPrompt, prompt, completionId, document, editor)

		if (result.isCancelled) {
			return
		}

		// Validate completion against selection context
		if (!this.validateCompletionContext(context, document)) {
			return
		}

		// Cache and display the final completion
		const finalCompletion = this.previewManager.cleanMarkdownCodeBlocks(result.completion)
		this.cache.set(document.uri.toString(), document.getText(), cursorIndex, finalCompletion)

		if (editor && editor.document === document) {
			this.previewManager.updateGhostText(editor, finalCompletion)
		}
	}

	/**
	 * Processes the completion stream and returns the result
	 */
	private async processCompletionStream(
		systemPrompt: string,
		prompt: string,
		completionId: string,
		document: vscode.TextDocument,
		editor: vscode.TextEditor | undefined,
	): Promise<{ completion: string; isCancelled: boolean }> {
		let completion = ""
		let isCancelled = false
		const currentCompletionId = completionId

		// Function to check if the request has been cancelled
		const checkCancellation = () => {
			if (this.activeCompletionId !== currentCompletionId) {
				isCancelled = true
				return true
			}
			return false
		}

		// Create the stream using the API handler's createMessage method
		const stream = this.apiHandler!.createMessage(systemPrompt, [
			{ role: "user", content: [{ type: "text", text: prompt }] },
		])

		// Process the stream
		for await (const chunk of stream) {
			if (checkCancellation()) {
				break
			}

			if (chunk.type === "text") {
				completion += chunk.text

				// Update the ghost text as chunks arrive
				if (editor && editor.document === document) {
					this.previewManager.throttledUpdateGhostText(editor, completion)
				}
			}
		}

		return { completion, isCancelled }
	}

	/**
	 * Validates the completion context against the selected completion info
	 */
	private validateCompletionContext(context: vscode.InlineCompletionContext, document: vscode.TextDocument): boolean {
		const selectedCompletionInfo = context.selectedCompletionInfo
		if (selectedCompletionInfo) {
			const { text, range } = selectedCompletionInfo
			const typedText = document.getText(range)
			const typedLength = range.end.character - range.start.character

			if (typedLength < MIN_TYPED_LENGTH_FOR_COMPLETION || !text.startsWith(typedText)) {
				return false
			}
		}
		return true
	}

	/**
	 * Initialize the API handler and return it
	 */
	private async initializeApiHandler(): Promise<ApiHandler | null> {
		if (this.apiHandler) {
			return this.apiHandler
		}

		try {
			const providerSettings: ProviderSettings = {
				apiProvider: "ollama",
				ollamaModelId: DEFAULT_OLLAMA_MODEL,
				ollamaBaseUrl: DEFAULT_OLLAMA_URL,
			}

			console.log("AutocompleteProvider: Initializing API handler with Ollama settings:", {
				apiProvider: providerSettings.apiProvider,
				ollamaModelId: providerSettings.ollamaModelId,
				ollamaBaseUrl: providerSettings.ollamaBaseUrl,
			})

			const apiHandler = buildApiHandler(providerSettings)
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
	/**
	 * Performs a quick sanity check to verify the API handler is working correctly
	 */
	private async performApiSanityCheck(apiHandler: ApiHandler): Promise<ApiHandler | null> {
		if (!apiHandler) {
			console.warn("AutocompleteProvider: Cannot perform sanity check - API handler is null")
			return null
		}

		try {
			console.log("AutocompleteProvider: Performing API sanity check...")

			// Verify model information is available
			const modelInfo = apiHandler.getModel()
			if (!modelInfo || !modelInfo.id) {
				console.error("AutocompleteProvider: API sanity check failed - Model ID is missing")
				vscode.window.showWarningMessage("Autocomplete API sanity check failed: Model ID is missing")
				return null
			}

			console.log("AutocompleteProvider: Using model:", modelInfo.id)

			// Test the API with a minimal prompt
			const systemPrompt = "You are a helpful assistant."
			const userPrompt = "Say hello"
			const stream = apiHandler.createMessage(systemPrompt, [
				{ role: "user", content: [{ type: "text", text: userPrompt }] },
			])

			// Just verify the stream works by getting the first chunk
			const iterator = stream[Symbol.asyncIterator]()
			await iterator.next()

			console.log("AutocompleteProvider: API sanity check passed")
			return apiHandler
		} catch (error) {
			console.error("AutocompleteProvider: API sanity check failed:", error)

			// Provide specific error message for model-related issues
			let errorMessage = error instanceof Error ? error.message : String(error)
			if (errorMessage.includes("model is required") || errorMessage.includes("model not found")) {
				errorMessage = `Model configuration error: ${errorMessage}. Please check your model settings.`
			}

			vscode.window.showWarningMessage(`Autocomplete API sanity check failed: ${errorMessage}`)
			return null
		}
	}

	/**
	 * Cleans up resources when the provider is no longer needed
	 */
	dispose() {
		this.previewManager.dispose()

		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout)
			this.debounceTimeout = null
		}
	}
}
