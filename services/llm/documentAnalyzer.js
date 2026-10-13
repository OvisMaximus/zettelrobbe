'use strict';

/**
 * The single business logic behind the LLM document analysis.
 *
 * Every provider is a composition root: it wires this analyzer to its own
 * transport, token budget, prompt builder and response parser, and exports
 * the singleton. Nothing extends DocumentAnalyzer — the collaborators arrive
 * through the constructor. That is what keeps the tests cheap: a fake
 * transport is an object literal with a `complete()` and a `generate()`, so
 * no `require.cache` surgery and no network.
 */

const {
  writePromptToFile,
  calculateTokens,
  truncateToTokenLimit,
} = require('../serviceUtils');
const config = require('../../config/config');
const fs = require('fs').promises;
const path = require('path');
const {
  buildSuccess,
  buildFailure,
  buildInsufficientContent,
  assertAssignableMetadata,
  withDocumentDefaults,
} = require('./analysisResult');
const { isInsufficientContentAnswer } = require('./responseParser');

class DocumentAnalyzer {
  /**
   * @param {Object} deps
   * @param {Object} deps.transport - One API family: `initialize()`,
   *   `isReady()`, `complete(request)`, `generate(prompt, options)`,
   *   `checkStatus()`, and the `client` / `lastGenerateTextUsage` seams
   * @param {Object} deps.tokenBudget - `reserve(systemPrompt, extraPrompts, model)`
   *   and `fit(content, availableTokens, model)`
   * @param {Object} deps.promptBuilder - `buildAnalysisPrompt(input)`
   * @param {Object} deps.responseParser - `parseAnalysisResponse(raw)`,
   *   `stripResponseWrapping(raw)`
   * @param {() => string} deps.resolveModel - The provider's model for this
   *   request: prompt counting, the completion request, the token budget
   * @param {Object} [deps.thumbnailCache] - `cache(id)`; the real
   *   thumbnailCache in production, a stub for tests
   * @param {string} [deps.clientNotReadyMessage] - analyzeDocument's error
   *   when the transport has no client
   * @param {() => Promise<Object>} [deps.checkStatus] - A provider-specific
   *   status probe that needs more than the transport's default (e.g. a model
   *   in the result); falls back to `transport.checkStatus()` without one
   */
  constructor({
    transport,
    tokenBudget,
    promptBuilder,
    responseParser,
    resolveModel,
    thumbnailCache,
    clientNotReadyMessage = 'client not initialized',
    checkStatus,
  }) {
    this.transport = transport;
    this.tokenBudget = tokenBudget;
    this.promptBuilder = promptBuilder;
    this.responseParser = responseParser;
    this.resolveModel = resolveModel;
    this.thumbnailCache = thumbnailCache || { cache: async () => false };
    this.clientNotReadyMessage = clientNotReadyMessage;
    this._checkStatus = checkStatus || null;
  }

  /** The SDK client. It lives on the transport; tests replace it here. */
  get client() {
    return this.transport.client;
  }

  set client(client) {
    this.transport.client = client;
  }

  /** Usage of the last generateText() call; read by the AI review features. */
  get lastGenerateTextUsage() {
    return this.transport.lastGenerateTextUsage;
  }

  set lastGenerateTextUsage(usage) {
    this.transport.lastGenerateTextUsage = usage;
  }

  initialize() {
    this.transport.initialize();
  }

  /**
   * Analyze one document. Never throws: a failed analysis is the same
   * failure record the OCR fallback matches on.
   *
   * @param {string} content - Extracted text
   * @param {string[]} [existingTags]
   * @param {string[]} [existingCorrespondentList]
   * @param {string[]} [existingDocumentTypesList]
   * @param {string|number} id - Paperless document id
   * @param {string|null} [customPrompt] - Replaces the system prompt (WebHook)
   * @param {Object} [options] - `externalApiData` to embed, pre-validated elsewhere
   * @returns {Promise<Object>} The AnalysisResult: success, refusal or failure
   */
  async analyzeDocument(
    content,
    existingTags = [],
    existingCorrespondentList = [],
    existingDocumentTypesList = [],
    id,
    customPrompt = null,
    options = {}
  ) {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error(this.clientNotReadyMessage);
      }

      // Cache the thumbnail for the UI; never let it affect the analysis.
      await this.thumbnailCache.cache(id);

      // Get external API data if available and validate it
      let externalApiData = options.externalApiData || null;
      let validatedExternalApiData = null;

      if (externalApiData) {
        try {
          validatedExternalApiData =
            await this._validateAndTruncateExternalApiData(externalApiData);
          console.log('[DEBUG] External API data validated and included');
        } catch (error) {
          console.warn(
            '[WARNING] External API data validation failed:',
            error.message
          );
          validatedExternalApiData = null;
        }
      }

      const model = this.resolveModel();
      const { systemPrompt, promptTags } =
        this.promptBuilder.buildAnalysisPrompt({
          existingTags,
          existingCorrespondentList,
          existingDocumentTypesList,
          externalApiData: validatedExternalApiData,
          customPrompt,
        });
      if (customPrompt) {
        console.log(
          '[DEBUG] Replace system prompt with custom prompt via WebHook'
        );
      }

      // Calculate tokens AFTER all prompt modifications are complete
      const { availableTokens } = await this.tokenBudget.reserve(
        systemPrompt,
        process.env.USE_PROMPT_TAGS === 'yes' ? [promptTags] : [],
        model
      );
      console.log(
        `[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`
      );
      console.log(
        `[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`
      );

      const truncatedContent = await this.tokenBudget.fit(
        content,
        availableTokens,
        model
      );

      await writePromptToFile(systemPrompt, truncatedContent);

      const { payload, metrics: mappedUsage } = await this.transport.complete({
        systemPrompt,
        userContent: truncatedContent,
        model,
        // The reasoning families reject the parameter.
        temperature:
          model !== 'o3-mini' ? config.aiTemperatureAnalysis : undefined,
      });
      let jsonContent = payload;

      let parsedResponse;
      try {
        const parsedResult =
          this.responseParser.parseAnalysisResponse(jsonContent);
        parsedResponse = parsedResult.parsed;
        jsonContent = parsedResult.normalized;
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`);
        console.debug(error);
        // Check if the response indicates the content is too minimal or API can't process it
        if (isInsufficientContentAnswer(jsonContent)) {
          console.warn(`Document ${id} has insufficient content for analysis`);
          // Return a default structure instead of throwing to prevent retry loops
          return buildInsufficientContent(id, mappedUsage);
        }
        throw error;
      }

      try {
        const responseLogPath = path.join(
          process.cwd(),
          'data',
          'logs',
          'response.txt'
        );
        await fs.mkdir(path.dirname(responseLogPath), { recursive: true });
        await fs.appendFile(responseLogPath, `${jsonContent}\n`);
      } catch (logError) {
        console.warn('Failed to write AI response log:', logError.message);
      }

      assertAssignableMetadata(parsedResponse);

      return buildSuccess(
        withDocumentDefaults(parsedResponse),
        mappedUsage,
        truncatedContent.length < content.length
      );
    } catch (error) {
      console.error(`Failed to analyze document: ${error.message}`);
      console.debug(error);
      return buildFailure(error);
    }
  }

  /**
   * Validate and truncate external API data to prevent token overflow
   * @param {any} apiData - The external API data to validate
   * @param {number} maxTokens - Maximum tokens allowed for external data (default: 500)
   * @returns {string} - Validated and potentially truncated data string
   */
  async _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
    if (!apiData) {
      return null;
    }

    const dataString =
      typeof apiData === 'object'
        ? JSON.stringify(apiData, null, 2)
        : String(apiData);

    // Calculate tokens for the data
    const dataTokens = await calculateTokens(dataString, this.resolveModel());

    if (dataTokens > maxTokens) {
      console.warn(
        `[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`
      );
      return await truncateToTokenLimit(
        dataString,
        maxTokens,
        this.resolveModel()
      );
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  /**
   * Generate text based on a prompt. Pure delegation: the request dialect,
   * streaming and the usage seam live on the transport and its provider's
   * buildRequest().
   * @param {string} prompt - The prompt to generate text from
   * @param {object} [options] - Optional overrides for this one call
   * @returns {Promise<string>} - The generated text
   */
  generateText(prompt, options = {}) {
    return this.transport.generate(prompt, options);
  }

  /** The provider-specific status probe; shaped by the transport. */
  checkStatus() {
    if (this._checkStatus) {
      return this._checkStatus(this.transport);
    }
    return this.transport.checkStatus();
  }
}

module.exports = DocumentAnalyzer;
