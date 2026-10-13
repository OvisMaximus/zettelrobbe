// Step 6 (Refactoring): AzureOpenAIService lives at services/llm/providers/ now; this shim preserves the legacy path.
// Re-export only — no business logic here (spec § target architecture: existing module paths stay re-exports).
const AzureOpenAIService = require('./llm/providers/azureProvider');
module.exports = AzureOpenAIService;
