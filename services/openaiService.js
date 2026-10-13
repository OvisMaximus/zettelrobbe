'use strict';

// Step 6: the single business logic moved to the shared DocumentAnalyzer,
// and the OpenAI root is the composition root below. This module stays as a
// one-line re-export so aiServiceFactory, routes/setup and server keep
// working unchanged. See services/ManualServiceRefactoring.md, "Target
// Architecture".
module.exports = require('./llm/providers/openaiProvider');
