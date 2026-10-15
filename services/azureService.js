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
const axios = require('axios');
const AzureOpenAI = require('openai').AzureOpenAI;
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
  assertAssignableMetadata,
} = require('./llm/analysisResult');
const { parseAnalysisResponse } = require('./llm/responseParser');
const responseLogPath = path.join(
  process.cwd(),
  'data',
  'logs',
  'response.txt'
);
/** What an operator can do about an answer that hit the completion cap. */
const TRUNCATION_REMEDY = 'Raise Response Tokens (RESPONSE_TOKENS).';
/**
 * The first Azure API version that answers a streamed request with a usage
 * chunk. Older versions reject `stream_options` outright, which would turn a
 * working deployment into a 400 the moment progress is asked for.
 */
const STREAM_OPTIONS_SINCE = '2024-06-01';
/** Version aliases that always mean "the newest surface". */
const ROLLING_API_VERSIONS = ['preview', 'latest', 'v1'];

/**
 * Whether the configured API version understands
 * `stream_options: { include_usage: true }`.
 *
 * Azure versions are dates, so the comparison is a string comparison on the
 * leading YYYY-MM-DD; a preview of a supported date counts as supported.
 * Anything unrecognized is treated as too old and the token count for that
 * deployment stays an estimate, which is the harmless half of being wrong.
 *
 * @param {string} apiVersion
 * @returns {boolean}
 */
function supportsStreamOptions(apiVersion) {
  const version = String(apiVersion || '')
    .trim()
    .toLowerCase();
  if (ROLLING_API_VERSIONS.includes(version)) return true;
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(version);
  return date ? date[1] >= STREAM_OPTIONS_SINCE : false;
}

class AzureOpenAIService {
  constructor() {
    this.transport = new ChatCompletionsTransport({
      label: 'AzureOpenAI',
      generation: {
        notReadyMessage: 'AzureOpenAI client not initialized - missing API key',
        remedy: TRUNCATION_REMEDY,
        buildRequest: (prompt, options) =>
          this._buildGenerationRequest(prompt, options),
        // Only where the configured API version takes it; an older one would
        // answer 400 instead of streaming, so that deployment estimates.
        streamUsage: () => supportsStreamOptions(config.azure.apiVersion),
      },
      createClient: () =>
        config.aiProvider === 'azure'
          ? new AzureOpenAI({
              apiKey: config.azure.apiKey,
              endpoint: config.azure.endpoint,
              deploymentName: config.azure.deploymentName,
              apiVersion: config.azure.apiVersion,
            })
          : null,
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
        throw new Error('AzureOpenAI client not initialized');
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

      const model = process.env.AZURE_DEPLOYMENT_NAME;
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
        temperature: config.aiTemperatureAnalysis,
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
        parsedResponse,
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
      process.env.AZURE_DEPLOYMENT_NAME
    );

    if (dataTokens > maxTokens) {
      console.warn(
        `[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`
      );
      return await truncateToTokenLimit(
        dataString,
        maxTokens,
        process.env.AZURE_DEPLOYMENT_NAME
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
   * @param {number} [options.maxTokens] - Overrides RESPONSE_TOKENS
   * @param {AbortSignal} [options.signal] - Cancels the request in flight
   * @param {Function} [options.onProgress] - Streams the answer and reports it
   *   as it grows; see GenerateTextProgress in aiGenerateOptions
   * @param {boolean} [options.reasoning] - false sends reasoning_effort on the
   *   deployments that take it and nothing on the others, which have no
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
    const model = modelOverride(options) || process.env.AZURE_DEPLOYMENT_NAME;
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
      // Was a hardcoded 1000, which quarrelled with the setting the same way
      // Ollama's num_predict did — the reservation followed the operator,
      // the limit did not.
      max_tokens:
        hasNumber(options.maxTokens) && options.maxTokens > 0
          ? Math.floor(options.maxTokens)
          : Number(config.responseTokens),
    };
    // As on OpenAI: the reasoning deployments take reasoning_effort, every
    // other one answers 400 for it, so it is sent for those names only and
    // only when the caller asked for no thinking.
    if (reasoningEnabled(options) === false) {
      const effort = reasoningEffortForOpenAi(model);
      if (effort) request.reasoning_effort = effort;
    }

    return request;
  }

  async checkStatus() {
    try {
      this.initialize();

      if (!this.client) {
        throw new Error(
          'Azure OpenAI client not initialized - missing API key'
        );
      }

      const model = process.env.AZURE_DEPLOYMENT_NAME;

      // Token-free health check against deployment metadata endpoint.
      const endpoint = (config.azure.endpoint || '').replace(/\/$/, '');
      const apiVersion = config.azure.apiVersion;
      if (!endpoint || !apiVersion || !model) {
        throw new Error(
          'Azure endpoint, apiVersion, or deployment name missing'
        );
      }

      const url = `${endpoint}/openai/deployments/${model}?api-version=${encodeURIComponent(apiVersion)}`;
      const response = await axios.get(url, {
        headers: {
          'api-key': config.azure.apiKey,
        },
        timeout: 10000,
      });

      if (response.status < 200 || response.status >= 300) {
        return { status: 'error' };
      }

      return { status: 'ok', model: model };
    } catch (error) {
      console.error(
        `Error generating text with Azure OpenAI: ${error.message}`
      );
      console.debug(error);
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new AzureOpenAIService();
