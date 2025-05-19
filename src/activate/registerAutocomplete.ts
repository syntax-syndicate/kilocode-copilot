import * as vscode from "vscode"
import { AutocompleteProvider } from "../services/autocomplete/AutocompleteProvider"

// Create a context key for tracking when ghost text is visible

/**
 * Register the autocomplete provider with VSCode
 * @param context The extension context
 */
export function registerAutocomplete(context: vscode.ExtensionContext) {
	// Add configuration for autocomplete
	const config = vscode.workspace.getConfiguration()

	// Create and register the autocomplete provider
	const autocompleteProvider = new AutocompleteProvider()
	const disposable = autocompleteProvider.register(context)

	// Initialize the ghost text visibility context to false
	vscode.commands.executeCommand("setContext", "kilo-code.ghostTextVisible", false)

	// Subscribe to the event in the AutocompleteProvider
	context.subscriptions.push({
		dispose: () => {
			// Clean up the provider when extension is deactivated
			if (disposable) {
				disposable.dispose()
			}

			// Reset the context when disposing
			vscode.commands.executeCommand("setContext", "kilo-code.ghostTextVisible", false)

			// Dispose the autocomplete provider
			autocompleteProvider.dispose()
		},
	})

	// Ensure the configuration exists
	if (!config.has("kilo-code.autocomplete.enabled")) {
		config.update("kilo-code.autocomplete.enabled", true, vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.debounceDelay")) {
		config.update("kilo-code.autocomplete.debounceDelay", 150, vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.useCache")) {
		config.update("kilo-code.autocomplete.useCache", true, vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.useImports")) {
		config.update("kilo-code.autocomplete.useImports", true, vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.useRecentlyEdited")) {
		config.update("kilo-code.autocomplete.useRecentlyEdited", true, vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.onlyMyCode")) {
		config.update("kilo-code.autocomplete.onlyMyCode", true, vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.multilineCompletions")) {
		config.update("kilo-code.autocomplete.multilineCompletions", "auto", vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.disableInFiles")) {
		config.update("kilo-code.autocomplete.disableInFiles", "*.md,*.txt", vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.model")) {
		config.update("kilo-code.autocomplete.model", "qwen2.5-coder:1.5b", vscode.ConfigurationTarget.Global)
	}

	if (!config.has("kilo-code.autocomplete.providerName")) {
		config.update("kilo-code.autocomplete.providerName", "ollama", vscode.ConfigurationTarget.Global)
	}

	// Log that autocomplete has been registered
	console.log("Kilo Code autocomplete provider registered")
}
