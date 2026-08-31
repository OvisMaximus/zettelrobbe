# ManualService Refactoring Plan
## The Goal

Refactor manualService.js. It has four functions, that are offering the same business
service using different AI APIs. We aim at implementing the business logic only once 
and coping with the API specific stuff In different Adapters.

We will also use these adapters to refactor ollamaService.js, openaiService.js, customService.js, 
and azureService.js.

Apply TDD

## The Plan

### 1. **Base Analyzer Pattern**
- Extract common logic to `BaseAnalyzer` class
- Handle prompt formatting, response parsing, and error handling
- Abstract API call interface for adapters

### 2. **Provider Adapters**
- Create separate adapter classes for each AI provider:
  - `OpenAIAdapter`
  - `OllamaAdapter`
  - `AzureAdapter`
  - `CustomAdapter`
- Implement provider-specific API call logic

### 3. **ManualService Refactor**
- Replace switch statement with adapter factory pattern
- Inject provider-specific configuration into adapters
- Centralize error handling and response validation

### 4. **Test Coverage Strategy**
- Mock each provider's API calls using `jest`/`sinon`
- Test scenarios:
  - Valid API responses
  - Malformed JSON responses
  - Network errors (e.g., `ECONNABORTED`)
  - Invalid configuration values
  - Empty/Null responses
- Validate token calculation logic for Ollama

### 5. **Edge Case Coverage**
- Test:
  - Empty `existingTags` array
  - Missing environment variables
  - Failed API authentication
  - API rate limiting
  - Large input content size

### 6. **Implementation Steps**
1. Create `BaseAnalyzer` with abstract `_callAPI` method
2. Implement provider-specific adapters
3. Update `ManualService` to use adapter factory
4. Add mock implementations for each provider
5. Write comprehensive tests for all edge cases
6. Validate token calculation logic in Ollama adapter

### 7. **Expected Benefits**
- Single point of business logic
- Easier maintenance and extension
- Better test coverage
- Improved error handling
- Reduced code duplication

### 8. **Next Steps**
- Implement `BaseAnalyzer` class
- Create adapter implementations
- Write mock tests for each provider
- Validate all edge cases

