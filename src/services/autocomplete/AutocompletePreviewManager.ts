import * as vscode from "vscode"

/**
 * Manages the preview/ghost text functionality for autocomplete
 */
export class AutocompletePreviewManager {
	// Decoration-based ghost text properties
	private decoration: vscode.TextEditorDecorationType
	private currentGhostText: string = ""
	private isShowingDecoration: boolean = false

	// Context key for keybindings
	private ghostTextVisibleContextKey: string = "kilo-code.ghostTextVisible"

	// Throttling properties
	private throttleTimeout: NodeJS.Timeout | null = null
	private throttleDelay: number = 75 // 75ms is a good balance between responsiveness and performance
	private pendingEditor: vscode.TextEditor | null = null

	constructor() {
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
	/**
	 * Updates the ghost text decoration at the current cursor position
	 * This is the direct update method without throttling
	 * @param editor The active text editor
	 * @param text The ghost text to display
	 */
	public updateGhostText(editor: vscode.TextEditor, text: string) {
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
		this.updateGhostTextVisibility(true)
	}

	/**
	 * Updates the VSCode context variable that controls the visibility of ghost text
	 * This is used by keybindings to determine when the tab key should accept ghost text
	 * @param visible Whether ghost text is visible
	 */
	private updateGhostTextVisibility(visible: boolean): void {
		vscode.commands.executeCommand("setContext", this.ghostTextVisibleContextKey, visible)
	}

	/**
	 * Throttled method to update ghost text
	 * Accumulates text chunks and only updates the UI every throttleDelay ms
	 * @param editor The active text editor
	 * @param textRaw The text chunk to accumulate
	 */
	public throttledUpdateGhostText(editor: vscode.TextEditor, textRaw: string) {
		const text = this.cleanMarkdownCodeBlocks(textRaw)

		this.pendingEditor = editor

		this.updateGhostText(this.pendingEditor, text)
	}

	/**
	 * Clears any displayed ghost text
	 * @param editor The active text editor
	 */
	public clearGhostText(editor: vscode.TextEditor) {
		editor.setDecorations(this.decoration, [])
		this.isShowingDecoration = false

		// Update the context for keybindings
		this.updateGhostTextVisibility(false)
	}

	/**
	 * Cleans markdown-style code blocks from text
	 * Handles both complete and partial code blocks that might appear in streaming responses
	 * @param text The text to clean
	 * @returns The cleaned text without markdown code block formatting
	 */
	public cleanMarkdownCodeBlocks(text: string): string {
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

	/**
	 * Checks if ghost text is currently being displayed
	 * @returns True if ghost text is being displayed, false otherwise
	 */
	public isShowingGhostText(): boolean {
		return this.isShowingDecoration
	}

	/**
	 * Gets the current ghost text
	 * @returns The current ghost text
	 */
	public getCurrentGhostText(): string {
		return this.currentGhostText
	}

	/**
	 * Registers event handlers for ghost text functionality
	 * @param context The extension context
	 */
	public register(context: vscode.ExtensionContext) {
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
	}

	/**
	 * Dispose of resources
	 */
	public dispose() {
		// Dispose of the decoration type
		this.decoration.dispose()

		// Clear any throttle timeout
		if (this.throttleTimeout) {
			clearTimeout(this.throttleTimeout)
			this.throttleTimeout = null
		}

		// Clear any active ghost text
		const editor = vscode.window.activeTextEditor
		if (editor && this.isShowingDecoration) {
			this.clearGhostText(editor)
		}
	}
}
