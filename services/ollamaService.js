// Step 6 (Refactoring): OllamaService lives at services/llm/providers/ now; this shim preserves the legacy path.
// Re-export only — no business logic here (spec § target architecture: existing module paths stay re-exports).
const OllamaService = require('./llm/providers/ollamaProvider');
module.exports = OllamaService;
