const {
  calculateTokens,
  truncateToTokenLimit,
  writePromptToFile,
} = require('./serviceUtils');
const {
  hasNumber,
  hasSystemPrompt,
  modelOverride,
  reasoningEffortForOpenAi,
  reasoningEnabled,
} = require('./aiGenerateOptions');
const OpenAI = require('openai');
const config = require('../config/config');
const fs = require('fs').promises;
const path = require('path');
const { cacheThumbnail } = require('./thumbnailCache');
const { buildAnalysisPrompt } = require('./llm/promptBuilder');
const tiktokenBudget = require('./llm/tokenBudget/tiktokenBudget');
const {
  ChatCompletionsTransport,
} = require('./llm/transports/chatCompletionsTransport');
const {
  buildSuccess,
  buildFailure,
  buildInsufficientContent,
  assertAssignableMetadata,
  withDocumentDefaults,
} = require('./llm/analysisResult');
const {
  parseAnalysisResponse,
  stripResponseWrapping,
} = require('./llm/responseParser');
const responseLogPath = path.join(
  process.cwd(),
  'data',
  'logs',
  'response.txt'
);
/** What an operator can do about an answer that hit the completion cap. */
const TRUNCATION_REMEDY =
  'Reduce the number of custom fields the prompt asks for, or use a model with a larger completion limit.';

class OpenAIService {
  constructor() {
    this.transport = new ChatCompletionsTransport({
      label: 'OpenAI',
      generation: {
        notReadyMessage: 'OpenAI client not initialized - missing API key',
        remedy: TRUNCATION_REMEDY,
        buildRequest: (prompt, options) =>
          this._buildGenerationRequest(prompt, options),
      },
      createClient: () => {
        if (config.aiProvider === 'ollama') {
          return new OpenAI({
            baseURL: config.ollama.apiUrl + '/v1',
            // Ollama ignores the key unless the endpoint enforces auth (e.g. a
            // reverse proxy); the OpenAI SDK requires a non-empty value.
            apiKey: config.ollama.apiKey || 'ollama',
          });
        }
        if (config.aiProvider === 'custom') {
          return new OpenAI({
            baseURL: config.custom.apiUrl,
            apiKey: config.custom.apiKey,
          });
        }
        if (config.aiProvider === 'openai' && config.openai.apiKey) {
          return new OpenAI({
            apiKey: config.openai.apiKey,
          });
        }
        return null;
      },
    });
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
        throw new Error('OpenAI client not initialized');
      }

      // Cache the thumbnail for the UI; never let it affect the analysis.
      await cacheThumbnail(id);

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

      const model = process.env.OPENAI_MODEL;
      const { systemPrompt, promptTags } = buildAnalysisPrompt({
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
      const { availableTokens } = await tiktokenBudget.reserve(
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

      const truncatedContent = await tiktokenBudget.fit(
        content,
        availableTokens,
        model
      );

      await writePromptToFile(systemPrompt, truncatedContent);

      const { payload, metrics: mappedUsage } = await this.transport.complete({
        systemPrompt,
        userContent: truncatedContent,
        model,
        // o3-mini rejects the parameter.
        temperature:
          model !== 'o3-mini' ? config.aiTemperatureAnalysis : undefined,
      });
      let jsonContent = payload;

      let parsedResponse;
      try {
        const parsedResult = parseAnalysisResponse(jsonContent);
        parsedResponse = parsedResult.parsed;
        jsonContent = parsedResult.normalized;
      } catch (error) {
        console.error(`Failed to parse JSON response: ${error.message}`);
        console.debug(error);
        // Check if the response indicates the content is too minimal or API can't process it
        jsonContent = stripResponseWrapping(jsonContent);
        if (
          jsonContent &&
          (jsonContent.toLowerCase().includes("i'm sorry") ||
            jsonContent.toLowerCase().includes('i cannot') ||
            jsonContent.toLowerCase().includes('insufficient'))
        ) {
          console.warn(`Document ${id} has insufficient content for analysis`);
          // Return a default structure instead of throwing to prevent retry loops
          return buildInsufficientContent(id, mappedUsage);
        }
        throw error;
      }

      try {
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
    const dataTokens = await calculateTokens(
      dataString,
      process.env.OPENAI_MODEL
    );

    if (dataTokens > maxTokens) {
      console.warn(
        `[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`
      );
      return await truncateToTokenLimit(
        dataString,
        maxTokens,
        process.env.OPENAI_MODEL
      );
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  /**
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @param {object} [options] - Optional overrides for this one call
   * @param {string} [options.systemPrompt] - Sent as the system message
   * @param {number} [options.temperature] - Overrides AI_TEMPERATURE_GENERATION
   * @param {number} [options.maxTokens] - Completion cap for this call
   * @param {AbortSignal} [options.signal] - Cancels the request in flight
   * @param {Function} [options.onProgress] - Streams the answer and reports it
   *   as it grows; see GenerateTextProgress in aiGenerateOptions
   * @param {boolean} [options.reasoning] - false sends reasoning_effort on the
   *   model families that take it and nothing on the others, which have no
   *   thinking switch; true and null send nothing
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt, options = {}) {
    return this.transport.generate(prompt, options);
  }

  /**
   * This provider's generateText() request. The transport sends it, streams
   * it and reads the answer; what differs between the providers is here.
   * @param {string} prompt
   * @param {object} options - see generateText()
   * @returns {Object} The chat completions request
   */
  _buildGenerationRequest(prompt, options) {
    const model =
      modelOverride(options) || process.env.OPENAI_MODEL || config.openai.model;
    const messages = [];
    if (hasSystemPrompt(options)) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const request = {
      model: model,
      messages,
      temperature: hasNumber(options.temperature)
        ? options.temperature
        : config.aiTemperatureGeneration,
    };
    // Without a cap the model answers with whatever the deployment allows,
    // which is what every caller before the AI review wanted.
    if (hasNumber(options.maxTokens) && options.maxTokens > 0) {
      request.max_tokens = Math.floor(options.maxTokens);
    }
    // The one thinking switch this API has, and it exists on the reasoning
    // families only: an ordinary model answers 400 for the field, so it is
    // sent for those names and for no others, and only when the caller
    // asked for no thinking.
    if (reasoningEnabled(options) === false) {
      const effort = reasoningEffortForOpenAi(model);
      if (effort) request.reasoning_effort = effort;
    }

    return request;
  }

  async checkStatus() {
    // Use a token-free endpoint for connectivity/auth checks.
    try {
      this.initialize();

      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }

      await this.client.models.list();
      return { status: 'ok', model: process.env.OPENAI_MODEL };
    } catch (error) {
      console.error(`Error checking OpenAI status: ${error.message}`);
      console.debug(error);
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new OpenAIService();
