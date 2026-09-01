# LLM Service Refactoring Plan

## The Goal

Four provider services offer the same business service through different AI APIs. Implement the
business logic **once** and keep the API-specific parts in thin, injected adapters.

In scope: `openaiService.js`, `azureService.js`, `customService.js`, `ollamaService.js`, and the
resolution of `manualService.js` (see Finding 1 — it is dead code, not the refactoring target it was
assumed to be).

Rules for this work:

- Apply TDD.
- Adhere to the conventions in `/CLAUDE.md` (English only, singleton services, `{ success, data }`
  API shape, OpenAPI kept in sync, commit body as the single source of truth).
- Prefer **delegation over inheritance**. No abstract base class, no `extends`.
- New tests must be symmetrical to the existing tests and registered in the test runner.

### Expected Benefits

- Single point of business logic (prompt building, token budgeting, parsing, result shaping).
- Easier maintenance and extension — a new provider is one adapter plus one composition root.
- Better test coverage: injected collaborators make the seams testable without `require.cache` tricks.
- Centralized, consistent error handling and result shaping.
- Removal of ~2000 lines of near-duplicate code across four services.

---

## Validation Against the Source Code

The following was verified against the working tree before rewriting this plan. Each finding either
corrects the plan or constrains the design.

### 1. `manualService.js` is dead code — the premise needs correcting

A repo-wide search across all file types finds **no reference** to `services/manualService.js`
(no `require`, no route, no view, no test). Refactoring it in isolation changes nothing at runtime.

The duplication that the "manual" business service actually suffers from lives in
`routes/setup.js`, which switches on `process.env.AI_PROVIDER` inline over the four _dedicated_
singletons:

- `routes/setup.js:7511-7578` — `POST /manual/analyze`, four-way switch calling `analyzeDocument()`.
- `routes/setup.js:7657-7717` — `POST /manual/playground`, four-way switch calling `analyzePlayground()`.

Further evidence that `manualService.js` was abandoned rather than maintained:

- `services/manualService.js:270` calls `this._parseResponse(...)`, a method that **does not exist**
  on `ManualService` (it exists only on `OllamaService`). The Ollama path throws `TypeError` on any
  non-object response.
- `existingTagsList` is computed and never used in all four methods
  (`manualService.js:52`, `:110`, `:166`) — would fail `no-unused-vars` under `eslint.config.mjs`.
- `manualService.js:273-276` contains German user-facing strings
  (`'Die Analyse hat zu lange gedauert...'`), violating the English-only rule in `/CLAUDE.md`.
- It is the only service exporting a **class** (`module.exports = ManualService;`) instead of a
  singleton, contrary to the documented service-layer convention.
- Its Ollama path never sends the document content at all — `prompt` is just
  `process.env.SYSTEM_PROMPT` (`manualService.js:218`).

**Decision:** delete `services/manualService.js` as part of this work and point the two
`/manual/*` endpoints at `AIServiceFactory.getService()`. Do not port its behaviour — it is strictly
worse than the dedicated services on every axis catalogued in `services/AiServices.md`.

### 2. The real duplication is larger than the original plan assumed

| Service            | Lines | Relationship                                    |
| ------------------ | ----- | ----------------------------------------------- |
| `openaiService.js` | 629   | ~90 % identical to azure/custom                 |
| `azureService.js`  | 597   | ~90 % identical to openai/custom                |
| `customService.js` | 706   | ~90 % identical, plus the strongest JSON parser |
| `ollamaService.js` | 1164  | genuinely different transport and token model   |

The largest duplicated block is **prompt construction**, which the original plan did not mention at
all: the `CUSTOM_FIELDS` → `customFieldsTemplate` → `%CUSTOMFIELDS%` block appears **six times**
(`openaiService.js:125-160`, `azureService.js:114-149`, `customService.js:209-244`,
`ollamaService.js:147-179`, `:434-469`, `:585-622`), followed each time by the same
`useExistingData` / `mustHavePrompt` / `RestrictionPromptService` / `USE_PROMPT_TAGS` /
`customPrompt` cascade.

`callAPI(prompt)` as the only seam therefore leaves the biggest duplicate in place.

### 3. The return contract in the original plan would break every caller

The plan proposed `interface AnalysisResult { tags, correspondent }`. The actual contract, produced
by all four services and consumed by three call sites, is:

```js
{ document: { tags, correspondent, title, document_type, document_date, language, custom_fields },
  metrics: { promptTokens, completionTokens, totalTokens } | null,
  truncated: boolean,
  error?: string,
  errorCode?: string }
```

Consumers: `server.js:766-821`, `services/mistralOcrService.js:988-997`,
`routes/setup.js:3167-3177`. Narrowing to `{ tags, correspondent }` would drop title, document type,
date, language, custom fields and all metrics.

### 4. The error contract is load-bearing and phrase-matched — it must be preserved verbatim

`analyzeDocument()` **never throws**; it returns the failure in `error`/`errorCode`.
`server.js:774-821` then routes the document to the OCR queue based on
`shouldQueueForOcrOnAiError()` / `classifyOcrQueueReasonFromAiError()`
(`services/serviceUtils.js:812-861`), which match on **exact phrases**:

- `'insufficient content for ai analysis'`
- `'invalid response structure'`
- `'could not determine assignable metadata'`
- `'invalid json response from api'`
- `'invalid api response structure'`

Rewording any of these silently disables OCR fallback. Guarded by the `ocr-fallback-ai-errors` and
`response-truncation-detection` tests. The `error.code = 'ai_response_truncated'` marker
(`serviceUtils.js:802`, `ollamaService.js:920`) has the same status.

Consequence for the plan: the proposed "fails on missing SYSTEM_PROMPT → `expect(...).toThrow()`"
test asserts a behaviour change that would break the scan loop. Dropped (see Test Strategy).

### 5. The committed `services/llmService.js` does not parse, and its logic is doubly wrong

```js
class LlmService {
  function parseJSONResponse(response) {   // ← SyntaxError: `function` in a class body
```

Beyond the syntax error: the function takes a _response object_ but calls `JSON.parse(response)` on
it, then reads `json.choices[0].message.content.tags` — treating `content` as an object although the
provider delivers it as a JSON **string**. Both halves cannot be true at once. The file also
exports `{ LlmService }` while the repo convention is a singleton export.

### 6. The committed `tests/test-llm-service.js` cannot run — test-framework mismatch

- It imports `vitest` (`describe/it/beforeEach/expect`) but the runner executes tests as plain node:
  `spawnSync(process.execPath, [filePath])` at `scripts/run-tests.js:471`. Vitest globals do not
  exist under `node tests/test-llm-service.js`.
- It additionally calls `jest.fn()` (`test-llm-service.js:34`) — `jest` is not defined anywhere.
- `require('../services/LlmService')` vs. the actual file `services/llmService.js`: works on
  Windows, **fails on Linux CI and in Docker**.
- `parseJSONResponse(...)` is called as a free function, not on `service`.
- `LlmService.calculateNumCtx(...)` is called as a **static** that does not exist.
- `LlmService.calculateNum2024(500, 1024)` (`:55`) is a typo for a method that does not and should
  not exist.
- Test 4 asserts `calculateNumCtx(100, 1024) === 1124`, which contradicts the plan's own §7 formula
  `min(floor(100/2), 1024) === 50`, and both contradict the real implementation (Finding 7).

Every existing test in `tests/` is a plain node script: `require('assert')`, a `main()`, and
`[PASS]`/`[FAIL]` plus `process.exitCode = 1`. `tests/test-ollama-temperature-wiring.js` is the
closest model for service tests, including its `require.cache` injection helper
(`:26-39`).

**Decision:** revert the `vitest` devDependency from `package.json` and the 53 lockfile
entries, and write plain-node tests. A new test framework is a dependency-manifest change that
additionally triggers `docker-check.yml`, for zero benefit over the house style — and the mixed
`vitest` + `jest` API in one file shows the two idioms do not survive contact.

### 7. The `num_ctx` formula in the original plan §7 is wrong

Real implementation (`ollamaService.js:691-702`):

```js
_calculateNumCtx(promptTokenCount, expectedResponseTokens) {
  return Math.min(promptTokenCount + expectedResponseTokens, Number(config.tokenLimit));
}
```

The plan's `min(floor(promptLength / 2), maxCtx)` conflates **characters** with **tokens** and drops
the response reservation entirely — it would size the window at half the prompt and guarantee
truncation.

The `/2` divisor belongs to a _different_ function, `_calculatePromptTokenCount`
(`ollamaService.js:678-683`), and its conservative value is deliberate and documented (non-English
tokenization). `manualService.js:234` used `/4`. Centralizing these must **preserve `/2` for
Ollama**, not unify the divisors.

### 8. `callAPI(prompt)` is too narrow a signature for Ollama

Ollama's transport needs `(prompt, systemPrompt, numCtx, schema)` (`ollamaService.js:811`), sends
`format: schema` for structured output, computes `num_ctx`/`num_predict`, carries a bounded retry for
transient failures (`:841-861`), and inspects `done_reason` for truncation (`:886-922`). Its response
may arrive as a **JS object** rather than a string (`:929-949`). A one-argument `callAPI` cannot
carry any of this.

### 9. Behavioural drift between the four services — each item needs an explicit decision

The refactor collapses four implementations into one, which forces a choice wherever they differ
today. These are the actual bugs the work will surface:

| #   | Drift                                                                                             | Location                                                                                                                                                                         | Proposed resolution                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a   | Azure hardcodes `temperature: 0.3` while openai/custom use `config.aiTemperatureAnalysis`         | `azureService.js:258`, `:426`                                                                                                                                                    | Use the config value. Fixes a real bug; `test-ai-temperature-config.js` only covers config parsing, not the Azure wiring, so add a wiring test.                    |
| b   | `return;` (undefined!) when a thumbnail is missing — callers then read `.document` of `undefined` | `openaiService.js:87`, `azureService.js:76`, `customService.js:171`                                                                                                              | Adopt Ollama's behaviour (`_handleThumbnailCaching`, `:708-725`): warn and continue. This is a latent crash.                                                       |
| c   | "Insufficient content" early return exists only in OpenAI                                         | `openaiService.js:310-332`, `:505-527`                                                                                                                                           | Keep, apply to all providers. The phrase feeds OCR fallback (Finding 4).                                                                                           |
| d   | Three different JSON parsers                                                                      | `customService.js:35-126` (brace-matched, strongest) vs. `openaiService.js:299-334` / `azureService.js:286-298` (naive strip) vs. `ollamaService.js:977-1053` (regex + sanitize) | One parser built from custom's `_extractFirstJsonValue` + `<think>` stripping + Ollama's sanitize fallback; keep Ollama's object passthrough as a pre-step.        |
| e   | Only custom normalizes timeouts                                                                   | `customService.js:428-436`                                                                                                                                                       | Apply `isTimeoutError`/`buildTimeoutErrorMessage` for all providers.                                                                                               |
| f   | `generateText` max-token handling differs four ways                                               | openai: none; `azureService.js:528`: `max_tokens`; `customService.js:625-654`: clamped; `ollamaService.js:1105`: `num_predict`                                                   | Keep custom's clamping as the shared rule; the transport maps it to its own knob.                                                                                  |
| g   | `checkStatus` differs by nature                                                                   | openai/custom `models.list()`; `azureService.js:574-580` REST GET; `ollamaService.js:1143` `/api/ps`                                                                             | Stays in the transport. Not business logic.                                                                                                                        |
| h   | Unreachable branches in `openaiService.initialize()` for providers `ollama` and `custom`          | `openaiService.js:33-44`                                                                                                                                                         | `aiServiceFactory` never routes those providers here and both direct call sites in `routes/setup.js` are guarded by `AI_PROVIDER === 'openai'`. Verify, then drop. |
| i   | Thumbnail caching sits inside `analyzeDocument` although the thumbnail never enters the prompt    | all four                                                                                                                                                                         | Out of scope. Preserve behaviour; note as a follow-up.                                                                                                             |

### 10. The original plan's §4/§5 test examples do not match the code

`service.analyze('content', [])` does not exist. The real seam is
`analyzeDocument(content, existingTags, existingCorrespondentList, existingDocumentTypesList, id, customPrompt, options)`.
`expect(result.tags).toEqual(['default-tag'])` asserts a default tag that no provider produces.
The `X-RateLimit-Remaining` suggestion has no counterpart in the codebase — no AI code path reads
that header; the `rate-limiting` test targets the app's own express-rate-limit. Dropped.

### 11. Plan step 8 (move tests into `tests/services/`) breaks the CI drift guard

`findUnregisteredTests()` (`scripts/run-tests.js:233-249`) reads `tests/` **non-recursively** and
matches `/^test-.*\.js$/`. Any test moved into `tests/services/` silently leaves the guard, which is
exactly the failure mode that guard exists to prevent. Registration itself would still work
(`path.join(__dirname, '..', 'tests', 'services/test-x.js')` is portable), but the discovery walk
must be made recursive in the same change.

Additionally, "move all tests testing solely production code in /services" would relocate a large
set of files unrelated to this refactor (`restriction-service`, `updated-service`,
`reconciliation-service`, the `ollama-*` and `ocr-*` families, …). That is churn that hides the
refactor in the diff. **Deferred to a separate PR** (see Out of Scope).

---

## Target Architecture

### Design principle: composition, not inheritance

One **concrete** business-logic class holds injected collaborators. There is no base class and
nothing `extends` anything. A provider is a _composition root_: it wires collaborators together and
exports the singleton facade.

```
services/llm/
  documentAnalyzer.js            the single business-logic implementation (concrete, never subclassed)
  promptBuilder.js               systemPrompt + user content assembly (replaces 6 duplicates)
  customFieldsTemplate.js        the %CUSTOMFIELDS% block
  responseParser.js              raw text|object -> document object
  analysisResult.js              buildSuccess() / buildFailure() — the one place the result shape lives
  tokenBudget/
    tiktokenBudget.js            openai/azure/custom: calculateTotalPromptTokens + truncateToTokenLimit
    charBudget.js                ollama: /2 estimate + _fitContentToContext
  transports/
    chatCompletionsTransport.js  OpenAI SDK, AzureOpenAI SDK, custom base URL — messages[]
    ollamaGenerateTransport.js   axios /api/generate, format schema, num_ctx/num_predict, retry
  providers/
    openaiProvider.js            composition root + singleton facade
    azureProvider.js
    customProvider.js
    ollamaProvider.js
```

The existing module paths stay as one-line re-exports
(`services/openaiService.js` → `module.exports = require('./llm/providers/openaiProvider');`) so that
`aiServiceFactory.js`, `routes/setup.js`, `server.js` and `mistralOcrService.js` need no change and
the diff stays reviewable. The four re-export shims can be collapsed in a later cleanup.

### The delegation contracts

Written as JSDoc typedefs in `services/llm/contracts.js`; enforced by tests, not by a base class.

```js
/**
 * @typedef {Object} CompletionRequest
 * @property {string}  systemPrompt
 * @property {string}  userContent
 * @property {string}  model
 * @property {number}  temperature
 * @property {number}  maxResponseTokens
 * @property {Object|null} schema           structured-output schema; null for chat transports
 * @property {'analysis'|'generation'} purpose
 */

/**
 * @typedef {Object} CompletionResult
 * @property {string|Object} payload        raw assistant text, or the object Ollama may return
 * @property {{promptTokens:number, completionTokens:number, totalTokens:number}|null} metrics
 */

/**
 * A transport owns exactly one thing: how to talk to one API family.
 * It throws on transport failure and on provider-reported truncation
 * (error.code === 'ai_response_truncated'); it never shapes an AnalysisResult.
 *
 * @typedef {Object} LlmTransport
 * @property {string} label                             'OpenAI' | 'AzureOpenAI' | 'Custom OpenAI' | 'Ollama'
 * @property {() => void} initialize                    lazy client construction, idempotent
 * @property {() => boolean} isReady
 * @property {(req: CompletionRequest) => Promise<CompletionResult>} complete
 * @property {() => Promise<{status:string, model?:string, error?:string}>} checkStatus
 */

/**
 * @typedef {Object} TokenBudget
 * @property {(systemPrompt:string, extraPrompts:string[], model:string) => Promise<{totalPromptTokens:number, availableTokens:number}>} reserve
 * @property {(content:string, availableTokens:number, model:string) => Promise<string>} fit
 */
```

`maxResponseTokens` is what each transport maps to its own knob: `max_tokens` for the chat
transports, `num_predict` plus a `num_ctx` sized by `min(promptTokens + maxResponseTokens, tokenLimit)`
for Ollama. That mapping is the only place the Ollama context arithmetic lives, and it keeps
Finding 7's real formula intact.

### DocumentAnalyzer — the single business logic

```js
class DocumentAnalyzer {
  /**
   * @param {Object} deps
   * @param {LlmTransport} deps.transport
   * @param {TokenBudget}  deps.tokenBudget
   * @param {Object}       deps.promptBuilder
   * @param {Object}       deps.responseParser
   * @param {() => string} deps.resolveModel      provider-specific model lookup
   * @param {Object}       [deps.thumbnailCache]  injected for testability
   */
  constructor({ transport, tokenBudget, promptBuilder, responseParser, resolveModel, thumbnailCache }) { ... }

  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [],
                        existingDocumentTypesList = [], id, customPrompt = null, options = {}) { ... }

  async analyzePlayground(content, prompt) { ... }
  async generateText(prompt) { ... }
  checkStatus() { return this.transport.checkStatus(); }
}
```

Every collaborator arrives through the constructor. That is what makes the tests cheap: a fake
transport is an object literal with a `complete()`, so no `require.cache` surgery and no network.

### Provider composition root (example)

```js
// services/llm/providers/azureProvider.js
const DocumentAnalyzer = require('../documentAnalyzer');
const ChatCompletionsTransport = require('../transports/chatCompletionsTransport');
const tiktokenBudget = require('../tokenBudget/tiktokenBudget');
const promptBuilder = require('../promptBuilder');
const responseParser = require('../responseParser');
const config = require('../../../config/config');

module.exports = new DocumentAnalyzer({
  transport: new ChatCompletionsTransport({
    label: 'AzureOpenAI',
    createClient: () =>
      new (require('openai').AzureOpenAI)({
        apiKey: config.azure.apiKey,
        endpoint: config.azure.endpoint,
        deploymentName: config.azure.deploymentName,
        apiVersion: config.azure.apiVersion,
      }),
    checkStatus: azureDeploymentProbe, // the REST GET from azureService.js:574
  }),
  tokenBudget: tiktokenBudget,
  promptBuilder,
  responseParser,
  resolveModel: () => process.env.AZURE_DEPLOYMENT_NAME,
});
```

Adding a fifth provider is: one `createClient`, one `resolveModel`, one `checkStatus` probe. No new
business logic, no subclass.

### Why not the base-class variant

An abstract `LlmService` with `callAPI()` overridden per provider forces Ollama's four extra
parameters, its object-shaped response, its retry loop and its char-based token model either into the
base class (where they are dead weight for three providers) or into an override that reimplements the
template method (which is the duplication we started with). Injecting a transport keeps Ollama's
peculiarities inside `ollamaGenerateTransport.js` and out of everyone else's way.

---

## Test Strategy

House style, no new framework: plain node scripts under `tests/`, `require('assert')`, one `main()`,
`[PASS]`/`[FAIL]` and `process.exitCode = 1`. Model: `tests/test-ollama-temperature-wiring.js`.

Because collaborators are injected, most tests need no module mocking at all — construct a
`DocumentAnalyzer` with a fake transport:

```js
const fakeTransport = {
  label: 'Fake',
  initialize() {},
  isReady: () => true,
  calls: [],
  async complete(request) {
    this.calls.push(request);
    return {
      payload: JSON.stringify({
        tags: ['tag1'],
        correspondent: 'John Doe',
        title: 't',
        document_type: 'Invoice',
        document_date: '2026-01-01',
        language: 'en',
      }),
      metrics: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  },
  async checkStatus() {
    return { status: 'ok' };
  },
};
```

Planned tests (each registered in `TESTS` in `scripts/run-tests.js` and in an `AREAS` entry):

| Test name                         | Asserts                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `llm-response-parser`             | fenced ```json stripped; `<think>…</think>` stripped; brace-matched extraction from prose; trailing-comma/unquoted-key sanitize fallback; unparseable input throws with the exact phrase `Invalid JSON response from API`      |
| `llm-analysis-result-contract`    | success returns `{document, metrics, truncated}`; failure returns `{document:{tags:[],correspondent:null}, metrics:null, error, errorCode}` and **never throws**                                                               |
| `llm-ocr-fallback-phrases`        | every phrase in `shouldQueueForOcrOnAiError` is still produced by the refactored paths — the regression guard for Finding 4                                                                                                    |
| `llm-prompt-builder`              | `%CUSTOMFIELDS%` rendering for date/boolean/other; `useExistingData` branch; `USE_PROMPT_TAGS` override; `customPrompt` override; restriction placeholders delegated to `RestrictionPromptService`; external API data appended |
| `llm-token-budget`                | `tiktokenBudget.reserve` throws `Token limit exceeded: …` when `availableTokens <= 0`; `charBudget` uses the `/2` divisor and `min(promptTokens + responseTokens, tokenLimit)` for `num_ctx` — Finding 7                       |
| `llm-transport-request-mapping`   | chat transports send `messages[]` with system+user and omit `temperature` for `o3-mini`; Ollama transport sends `format`, `num_ctx`, `num_predict`, `think:false` unless `OLLAMA_THINK=true`                                   |
| `llm-azure-temperature-wiring`    | Azure analysis requests carry `config.aiTemperatureAnalysis`, not a hardcoded `0.3` — Finding 9a                                                                                                                               |
| `llm-missing-thumbnail-continues` | a missing thumbnail yields a full `AnalysisResult`, never `undefined` — Finding 9b                                                                                                                                             |
| `llm-provider-parity`             | all four composition roots expose `analyzeDocument`/`analyzePlayground`/`generateText`/`checkStatus` and, given the same fake transport payload, produce byte-identical `document` objects                                     |

Existing tests that must stay green without modification (they are the real acceptance criteria):
`ocr-fallback-ai-errors`, `response-truncation-detection`, `ollama-response-limit`,
`ollama-upstream-error`, `ollama-temperature-wiring`, `ollama-token-metrics`,
`prompt-existing-data-serialization`, `restriction-service`, `restricted-document-types-placeholder`,
`document-type-restriction`, `ai-temperature-config`, `playground-deprecation`.

Repo-hygiene steps that belong to this work:

- Delete `services/llmService.js` and `tests/test-llm-service.js` in their current form (Findings 5, 6).
- Revert the `vitest` devDependency in `package.json` and its lockfile entries.
- Register every new test in `TESTS`; run `node scripts/run-tests.js --all` — the registry drift
  check only runs on `--all`.
- `npx eslint <changed>`, `npx prettier --check <changed>` — CI lints the files touched by the PR.

---

## Implementation Steps

Each step ends with a green `node scripts/run-tests.js --all`. Steps 1-3 are pure preparation and
carry no behavioral risk; the risk starts at step 5.

1. **Clean the slate.** Remove `services/llmService.js` and `tests/test-llm-service.js`; revert the
   `vitest` devDependency and lockfile entries; keep the `llm-service` entry out of `TESTS` until a
   runnable test replaces it. Move this plan and `services/AiServices.md` out of `services/` (they
   are documents, not services — `docs/` or the PR body).
2. **Freeze the contract in tests first (TDD).** Write `llm-analysis-result-contract` and
   `llm-ocr-fallback-phrases` against the **current** `openaiService`/`ollamaService`. They must pass
   before any production code moves — that is what makes them a regression net rather than a
   description of the new code.
3. **Extract `customFieldsTemplate.js` and `promptBuilder.js`** with `llm-prompt-builder`, and have
   all four existing services call them. Six duplicates become one; no other behaviour changes.
   `prompt-existing-data-serialization` and the restriction tests are the guard.
4. **Extract `responseParser.js`** (custom's brace matcher + `<think>` stripping + Ollama's sanitize
   fallback + Ollama's object passthrough) with `llm-response-parser`, and route all four services
   through it. Resolves Finding 9d.
5. **Extract `analysisResult.js`** and the two `tokenBudget` strategies with `llm-token-budget`.
   Fix Finding 9b (missing thumbnail) here, with `llm-missing-thumbnail-continues` written first.
6. **Introduce the transports.** `chatCompletionsTransport.js` covering openai/azure/custom, and
   `ollamaGenerateTransport.js` carrying the retry, `format`, `num_ctx`/`num_predict` and
   `done_reason` truncation check moved verbatim from `ollamaService.js:811-922`. Cover with
   `llm-transport-request-mapping`.
7. **Introduce `documentAnalyzer.js`** and the four composition roots. Reduce
   `services/{openai,azure,custom,ollama}Service.js` to re-export shims. Add `llm-provider-parity`.
   Fix Finding 9a here (Azure temperature) with its test.
8. **Delete `services/manualService.js`** and repoint `POST /manual/analyze` and
   `POST /manual/playground` (`routes/setup.js:7511`, `:7657`) at `AIServiceFactory.getService()`,
   collapsing both four-way switches. Note that `/manual/analyze` currently calls
   `documentModel.addOpenAIMetrics()` only on the OpenAI branch while `/manual/playground` calls it on
   three of four — decide explicitly whether metrics are recorded for every provider, and if the
   response shape changes, update the `@swagger` JSDoc and run `node scripts/regen-openapi.js`
   (the CI drift check will fail otherwise).
9. **Verify Finding 9h** (unreachable `initialize()` branches in the former `openaiService`) and drop
   the dead branches.
10. **Full verification.** `node scripts/run-tests.js --all`; ESLint/Prettier on every changed file;
    `node scripts/regen-openapi.js` + `git diff --exit-code OPENAPI/openapi.json`; a manual smoke run
    of `/manual/analyze` and a scan cycle against a real provider, since no test exercises a live API.

---

## Out of Scope / Follow-ups

- **Relocating unrelated tests into `tests/services/`** (original step 8). Needs `findUnregisteredTests()`
  made recursive first (Finding 11) and would bury this refactor in rename noise. Separate PR.
- **Thumbnail caching inside `analyzeDocument`** (Finding 9i): the thumbnail is fetched, written to
  disk and never used in the prompt. Behaviour preserved here; worth its own issue.
- **Vision/multimodal analysis**, which is presumably why the thumbnail is cached at all.
- **`analyzePlayground` deduplication beyond the shared collaborators** — the endpoint is already
  deprecated (`routes/setup.js:7584`, `playground-deprecation` test); do not invest in it.
- **A structured-output (`response_format`/`format`) path for the chat transports** to match what
  Ollama already does. Would likely remove most of `responseParser`, but it is a behaviour change
  needing its own validation against real providers.

## Risks

| Risk                                                                         | Mitigation                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| OCR fallback silently stops working because an error phrase changed          | `llm-ocr-fallback-phrases` written in step 2, before any code moves                                                                  |
| A caller reads a field that the unified `document` object no longer carries  | `llm-provider-parity` compares full objects; `server.js:766`, `mistralOcrService.js:988`, `routes/setup.js:3167` reviewed explicitly |
| Ollama's token arithmetic subtly changes and long documents start truncating | `charBudget` keeps the `/2` divisor and the real `num_ctx` formula; `ollama-response-limit` and `ollama-token-metrics` guard it      |
| No test exercises a real provider API                                        | Step 10 keeps a manual smoke run against at least one live provider in the acceptance criteria                                       |
| The refactor lands as one unreviewable diff                                  | Steps 3-7 are individually green and individually landable                                                                           |
