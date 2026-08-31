# ManualService Refactoring Plan
## The Goal

Refactor manualService.js. It has four functions, that are offering the same business
service using different AI APIs. We aim at implementing the business logic only once 
and coping with the API specific stuff In different Adapters.

We will also use these adapters to refactor ollamaService.js, openaiService.js, customService.js, 
and azureService.js.

Apply TDD


### **Expected Benefits**
- Single point of business logic
- Easier maintenance and extension
- Better test coverage with mocks
- Improved error handling with centralized `handleAPIError()`
- Reduced code duplication across providers


## The Plan

### design approach

#### 1. **Base Analyzer Pattern**
- Extract common logic to `BaseAnalyzer` class
  - Example: Centralize error handling with `handleAPIError()`
  - Example: Standardize response parsing with `parseJSONResponse()`
  - **Suggestion**: Add validation for `AnalysisResult` structure to reject unexpected keys (e.g., `correspondent` might be missing in some cases)

#### 2. **Provider Adapters**
- Create separate adapter classes for each AI provider:
  - `OpenAIAdapter`:
    ```js
    async callAPI(prompt) {
      return this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }]
      });
    }
    ```
  - `OllamaAdapter`:
    ```js
    async callAPI(prompt) {
      return this.ollama.post('/api/generate', {
        model: 'llama2',
        prompt
      });
    }
    ```
  - `AzureAdapter`:
    ```js
    async callAPI(prompt) {
      return this.openai.chat.completions.create({
        model: 'deployment-name',
        messages: [{ role: 'user', content: prompt }]
      });
    }
    ```
  - Standardize method signatures (e.g. all adapters return text containing a valid JSON object)

#### 3. **ManualService Refactor**
- Replace switch statement with adapter factory pattern:
  ```js
  const adapter = new (require(`services/analyzers/${config.aiProvider}Adapter`))(config);
  return await adapter.analyze(content, existingTags);
  ```
- Inject provider-specific configuration via constructor
- Centralize error handling with `handleAPIError()`

#### 4. **Test Coverage Strategy**
- Mock API calls using `jest`/`sinon`:
  - Example: Mock OpenAI API
    ```js
    jest.mock('openai', () => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: '{"tags":["tag1"],"correspondent":"John"}' }] }
          })
        }
      }
    }));
    ```
- Test scenarios:
  - Valid JSON response: `tags` array and `correspondent` string
  - Malformed JSON: `try/catch` validation
  - Network error: `ECONNABORTED` handling
  - Empty response: `null` check
- **Suggestion**: Add mock for `X-RateLimit-Remaining` header in rate-limiting tests

#### 5. **Edge Case Coverage**
- Test empty `existingTags` array:
  ```js
  test('handles empty existingTags', async () => {
    const result = await service.analyze('content', []);
    expect(result.tags).toEqual(['default-tag']);
  });
  ```
- Test missing environment variables:
  ```js
  test('fails on missing SYSTEM_PROMPT', () => {
    process.env.SYSTEM_PROMPT = undefined;
    expect(() => service.analyze()).toThrow();
  });
  ```
- Test API rate limiting: Validate `X-RateLimit-Remaining` header
- Test large input content: Validate token calculation for Ollama

#### 6. **Return Value Structure**
All adapters must return objects with this structure:
```ts
interface AnalysisResult {
  tags: string[]; // Array of tag names
  correspondent: string | null; // Correspondent name or null
}
```
Example:
```js
{ tags: ['tag1', 'tag2'], correspondent: 'John Doe' }
```
Error case:
```js
{ tags: [], correspondent: null }
```

### 7. **Token Calculation Centralization**
**Suggestion**: Centralize Ollama token calculation logic in `calculateNumCtx()` (input prompt characters / 2 or /4) to avoid duplication. Example:
```js
function calculateNumCtx(promptLength, maxCtx) {
  return Math.min(Math.floor(promptLength / 2), maxCtx);
}
```

###  **Implementation Steps**
1. Write tests for `BaseAnalyzer` first (TDD)
2. Implement `BaseAnalyzer` with abstract `callAPI()`
3. Add tests for derived Adapters
4. Add Ollama token calculation tests:
   ```js
   test('calculates num_ctx correctly', () => {
     expect(ollamaAdapter.calculateNumCtx(100, 1024)).toBe(1124);
   });
   ```
5. Create adapter classes with provider-specific `callAPI()`
6. Mock API calls for each provider in tests
7. Validate all edge cases with test scenarios
