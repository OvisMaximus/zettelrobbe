// Step 6 (Refactoring): CustomOpenAIService lives at services/llm/providers/ now; this shim preserves the legacy path.
// Re-export only — no business logic here (spec § target architecture: existing module paths stay re-exports).
const CustomOpenAIService = require('./llm/providers/customProvider');
module.exports = CustomOpenAIService;
