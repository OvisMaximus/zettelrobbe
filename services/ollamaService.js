const { writePromptToFile } = require('./serviceUtils');
const { hasNumber } = require('./aiGenerateOptions');
const axios = require('axios');
const config = require('../config/config');
const { cacheThumbnail } = require('./thumbnailCache');
const { buildAnalysisPrompt } = require('./llm/promptBuilder');
const { parseAnalysisResponse } = require('./llm/responseParser');
const charBudget = require('./llm/tokenBudget/charBudget');
const {
  OllamaGenerateTransport,
} = require('./llm/transports/ollamaGenerateTransport');
const {
  buildSuccess,
  buildFailure,
  assertAssignableMetadata,
  withDocumentDefaults,
} = require('./llm/analysisResult');
const { buildCustomFieldsBlock } = require('./llm/customFieldsTemplate');

/**
 * Service for document analysis using Ollama
 */
class OllamaService {
  /**
   * Initialize the Ollama service
   */
  constructor() {
    this.transport = new OllamaGenerateTransport({
      client: axios.create({
        timeout: 1800000, // 30 minutes timeout
      }),
      apiUrl: config.ollama.apiUrl,
      model: config.ollama.model,
    });

    // JSON schema for document analysis output
    this.documentAnalysisSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        correspondent: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        document_type: { type: 'string' },
        document_date: { type: 'string' },
        language: { type: 'string' },
        custom_fields: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: [
        'title',
        'correspondent',
        'tags',
        'document_type',
        'document_date',
        'language',
      ],
    };
  }

  /** The axios client. It lives on the transport; tests replace it here. */
  get client() {
    return this.transport.client;
  }

  set client(client) {
    this.transport.client = client;
  }

  get apiUrl() {
    return this.transport.apiUrl;
  }

  set apiUrl(apiUrl) {
    this.transport.apiUrl = apiUrl;
  }

  get model() {
    return this.transport.model;
  }

  set model(model) {
    this.transport.model = model;
  }

  /** Usage of the last generateText() call; read by the AI review features. */
  get lastGenerateTextUsage() {
    return this.transport.lastGenerateTextUsage;
  }

  set lastGenerateTextUsage(usage) {
    this.transport.lastGenerateTextUsage = usage;
  }

  /**
   * Analyzes a document to extract metadata and tags using an AI model.
   * @param {string} content - The content of the document to analyze.
   * @param {Array} existingTags - Array of pre-existing tags to consider during analysis.
   * @param {Array} existingCorrespondentList - Array of pre-existing correspondents.
   * @param {Array} existingDocumentTypesList - Array of pre-existing document types.
   * @param {string|number} id - Unique identifier for the document.
   * @param {string} [customPrompt] - Custom prompt to guide the analysis process.
   * @param {Object} [options] - Additional configuration options.
   * @param {Object} [options.externalApiData] - External data to include in the analysis.
   * @returns {Promise<Object>} An object containing analysis results, metrics, and status.
   * @returns {Object} document - Parsed response from the AI analysis.
   * @returns {Object} metrics - Performance metrics from the analysis process.
   * @returns {boolean} truncated - Indicates if the content was truncated during processing.
   * @returns {string} error - Error message if an exception occurred.
   * @returns {string} errorCode - Error code if an exception occurred.
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
      // Truncate content if needed
      content = this._truncateContent(content);

      // Cache the thumbnail for the UI; never let it affect the analysis.
      await cacheThumbnail(id);

      // Get external API data if available and validate it
      let externalApiData = options.externalApiData || null;
      let validatedExternalApiData = null;

      if (externalApiData) {
        try {
          validatedExternalApiData =
            this._validateAndTruncateExternalApiData(externalApiData);
          console.log('[DEBUG] External API data validated and included');
        } catch (error) {
          console.warn(
            '[WARNING] External API data validation failed:',
            error.message
          );
          validatedExternalApiData = null;
        }
      }

      // Build prompt
      let prompt;
      let promptPrefix;
      if (!customPrompt) {
        promptPrefix = this._buildPrompt(
          '',
          existingTags,
          existingCorrespondentList,
          existingDocumentTypesList,
          options
        );
      } else {
        promptPrefix =
          buildAnalysisPrompt({ customPrompt }).systemPrompt + '\n\n';
        console.log('[DEBUG] Ollama Service started with custom prompt');
      }

      // Fit the document into what is left of the context window. Without
      // this an oversized prompt silently changed the meaning of the request:
      // Ollama clamps num_ctx to the model's real limit, the long document
      // filled the window, and the answer was cut off mid-JSON — reported as
      // ai_response_truncated on exactly the long documents. With the content
      // fitted, prompt + reserved answer always fit the configured
      // TOKEN_LIMIT.
      const originalContentLength = String(content).length;
      const { availableTokens } = await charBudget.reserve(promptPrefix);
      content = await charBudget.fit(content, availableTokens);

      if (!customPrompt) {
        prompt = this._buildPrompt(
          content,
          existingTags,
          existingCorrespondentList,
          existingDocumentTypesList,
          options
        );
      } else {
        prompt = promptPrefix + JSON.stringify(content);
      }
      const contentWasTruncated =
        String(content).length < originalContentLength;

      // Generate custom fields for the prompt
      const customFieldsStr = this._generateCustomFieldsTemplate();

      // Generate system prompt
      const systemPrompt = this._generateSystemPrompt(customFieldsStr);

      // Calculate context window size
      const promptTokenCount = this._calculatePromptTokenCount(prompt);
      const numCtx = this._calculateNumCtx(
        promptTokenCount,
        Number(config.responseTokens)
      );

      console.log(
        `[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`
      );
      console.log(
        `[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`
      );

      // Call Ollama API
      const response = await this._callOllamaAPI(
        prompt,
        systemPrompt,
        numCtx,
        this.documentAnalysisSchema
      );

      // Process response
      const parsedResponse = this._processOllamaResponse(response);
      const metrics = this._extractOllamaMetrics(response);

      // Log the prompt and response
      await this._logPromptAndResponse(systemPrompt, prompt, parsedResponse);

      // Return results in consistent format
      return buildSuccess(parsedResponse, metrics, contentWasTruncated);
    } catch (error) {
      console.error(`Error analyzing document with Ollama: ${error.message}`);
      console.debug(error);
      return buildFailure(error);
    }
  }

  /**
   * Truncate content to maximum length if specified
   * @param {string} content - Content to truncate
   * @returns {string} Truncated content
   */
  _truncateContent(content) {
    try {
      if (process.env.CONTENT_MAX_LENGTH) {
        console.log(
          'Truncating content to max length:',
          process.env.CONTENT_MAX_LENGTH
        );
        return content.substring(0, process.env.CONTENT_MAX_LENGTH);
      }
    } catch (error) {
      console.error(`Error truncating content: ${error.message}`);
      console.debug(error);
    }
    return content;
  }

  /**
   * Builds and returns a system prompt string combining configuration, content, and metadata.
   * @param {string} content - The main content of the document to be processed.
   * @param {string[]} existingTags - Array of existing tags associated with the document.
   * @param {string[]} existingCorrespondent - Array of existing correspondents related to the document.
   * @param {string[]} existingDocumentTypes - Array of existing document types.
   * @param {Object} options - Optional configuration object. May include externalApiData for additional context.
   * @return {string} The constructed system prompt string combining configuration, content, and metadata.
   */
  _buildPrompt(
    content,
    existingTags = [],
    existingCorrespondent = [],
    existingDocumentTypes = [],
    options = {}
  ) {
    // Validate that existingCorrespondent is an array and handle if it's not
    const correspondentList = Array.isArray(existingCorrespondent)
      ? existingCorrespondent
      : [];

    // Get validated external API data if available
    let validatedExternalApiData = null;
    if (options.externalApiData) {
      try {
        validatedExternalApiData = this._validateAndTruncateExternalApiData(
          options.externalApiData
        );
        console.log('[DEBUG] External API data validated and included');
      } catch (error) {
        console.warn(
          '[WARNING] External API data validation failed:',
          error.message
        );
        validatedExternalApiData = null;
      }
    }

    const { systemPrompt } = buildAnalysisPrompt({
      existingTags,
      existingCorrespondentList: correspondentList,
      existingDocumentTypesList: existingDocumentTypes,
      externalApiData: validatedExternalApiData,
    });

    return `${systemPrompt}
        ${JSON.stringify(content)}
        `;
  }

  /**
   * Validate and truncate external API data to prevent token overflow
   * @param {any} apiData - The external API data to validate
   * @param {number} maxTokens - Maximum tokens allowed for external data (default: 500)
   * @returns {string} - Validated and potentially truncated data string
   */
  _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
    if (!apiData) {
      return null;
    }

    const dataString =
      typeof apiData === 'object'
        ? JSON.stringify(apiData, null, 2)
        : String(apiData);

    // Calculate tokens for the data (conservative 2 chars/token for non-English)
    const dataTokens = Math.ceil(dataString.length / 2);

    if (dataTokens > maxTokens) {
      console.warn(
        `[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`
      );
      // Simple truncation based on character count
      const maxChars = maxTokens * 2;
      return dataString.substring(0, maxChars);
    }

    console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
    return dataString;
  }

  /**
   * Generate custom fields template for prompts
   * @returns {string} Custom fields template as a string
   */
  _generateCustomFieldsTemplate() {
    return buildCustomFieldsBlock();
  }

  /**
   * Generate system prompt for document analysis
   * @param {string} customFieldsStr - Custom fields as a string
   * @returns {string} System prompt
   */
  _generateSystemPrompt(customFieldsStr) {
    let systemPromptTemplate = `
            You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
            YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
            YOU MUSTNOT: Return a response without the desired JSON format.
            YOU MUST: Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
            IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
            Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.
            {
                "title": "xxxxx",
                "correspondent": "xxxxxxxx",
                "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
                "document_type": "Invoice/Contract/...",
                "document_date": "YYYY-MM-DD",
                "language": "en/de/es/...",
                %CUSTOMFIELDS%
            }
            ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
        `;

    return systemPromptTemplate.replace('%CUSTOMFIELDS%', customFieldsStr);
  }

  /**
   * Calculate prompt token count
   * @param {string} prompt - Prompt text
   * @returns {number} Estimated token count
   */
  _calculatePromptTokenCount(prompt) {
    return charBudget.estimateTokens(prompt);
  }

  /**
   * Calculate context window size for Ollama
   * @param {number} promptTokenCount - Token count for prompt
   * @param {number} expectedResponseTokens - Expected response token count
   * @returns {number} Context window size
   */
  _calculateNumCtx(promptTokenCount, expectedResponseTokens) {
    const numCtx = charBudget.numCtx(promptTokenCount, expectedResponseTokens);

    console.log('Prompt Token Count:', promptTokenCount);
    console.log('Expected Response Tokens:', expectedResponseTokens);
    console.log('Dynamic calculated num_ctx:', numCtx);

    return numCtx;
  }

  /** Request headers, with bearer auth when an API key is set. */
  _buildRequestHeaders() {
    return this.transport.buildHeaders();
  }

  /**
   * Send the analysis request.
   * @param {string} prompt - Prompt text
   * @param {string} systemPrompt - System prompt
   * @param {number} numCtx - Context window size
   * @param {Object} schema - Response schema
   * @returns {Promise<Object>} The raw /api/generate response data
   */
  async _callOllamaAPI(prompt, systemPrompt, numCtx, schema) {
    const { raw } = await this.transport.complete({
      systemPrompt,
      userContent: prompt,
      temperature: config.aiTemperatureAnalysis,
      // The same number _calculateNumCtx() already reserved room for. It used
      // to be a hardcoded 256 while the reservation followed the setting, so
      // the context held space for an answer the model was then forbidden to
      // write.
      maxResponseTokens: Number(config.responseTokens),
      numCtx,
      schema,
    });
    return raw;
  }

  /** See OllamaGenerateTransport.assertNotTruncated(). */
  _assertNotTruncated(responseData, numPredict, numCtx, extra) {
    this.transport.assertNotTruncated(responseData, numPredict, numCtx, extra);
  }

  /**
   * Process Ollama API response
   *
   * The answer arrives as an object when Ollama applied the format schema,
   * and as text otherwise; responseParser handles both. Every exit either
   * returns something the caller can use or throws. Handing back
   * { tags: [], correspondent: null } for an unreadable answer is
   * indistinguishable from a model that genuinely found nothing, so the
   * document would be written back untouched and marked processed.
   *
   * @param {Object} responseData - Ollama API response data
   * @returns {Object} Parsed response
   */
  _processOllamaResponse(responseData) {
    if (!responseData.response) {
      throw new Error('No response data from Ollama API');
    }
    try {
      const { parsed } = parseAnalysisResponse(responseData.response);
      // On the parsed answer: the defaults would turn a missing `tags` into
      // [] and let every answer pass.
      assertAssignableMetadata(parsed);
      return withDocumentDefaults(parsed);
    } catch (error) {
      console.error('Error parsing Ollama response:', error.message);
      throw error;
    }
  }

  /**
   * Extract token usage metrics from an Ollama /api/generate response.
   * @param {Object} responseData - Ollama API response data
   * @returns {{promptTokens:number, completionTokens:number, totalTokens:number}}
   */
  _extractOllamaMetrics(responseData) {
    return this.transport.extractMetrics(responseData);
  }

  /**
   * Logs the prompt and response to a file. Combines the system prompt, user
   * prompt, and response into a formatted string and writes it to a file.
   * @param {string} systemPrompt - The system message provided to the model.
   * @param {string} prompt - The user's input prompt.
   * @param {Object} response - The model's generated response object.
   * @return {Promise<void>} A promise that resolves when the prompt and
   *          response are written to the file.
   */
  async _logPromptAndResponse(systemPrompt, prompt, response) {
    const content =
      '================================================================================' +
      prompt +
      '\n\n' +
      JSON.stringify(response) +
      '\n\n' +
      '================================================================================\n\n';

    await writePromptToFile(systemPrompt, content);
  }

  /**
   * Generate text based on a prompt
   * @param {string} prompt - The prompt to generate text from
   * @param {object} [options] - Optional overrides for this one call
   * @param {string} [options.systemPrompt] - Replaces the generic system prompt
   * @param {number} [options.temperature] - Overrides AI_TEMPERATURE_GENERATION
   * @param {number} [options.maxTokens] - Overrides RESPONSE_TOKENS (num_predict)
   * @param {AbortSignal} [options.signal] - Cancels the request in flight
   * @param {Function} [options.onProgress] - Streams the answer and reports it
   *   as it grows; see GenerateTextProgress in aiGenerateOptions
   * @param {boolean} [options.reasoning] - Sends `think` for this one call and
   *   overrules OLLAMA_THINK; without it the setting decides, as before
   * @returns {Promise<string>} - The generated text
   */
  async generateText(prompt, options = {}) {
    const responseTokens =
      hasNumber(options.maxTokens) && options.maxTokens > 0
        ? Math.floor(options.maxTokens)
        : Number(config.responseTokens);

    // Calculate context window size based on prompt length
    const promptTokenCount = this._calculatePromptTokenCount(prompt);
    const numCtx = this._calculateNumCtx(promptTokenCount, responseTokens);

    return this.transport.generate(prompt, options, { responseTokens, numCtx });
  }

  /**
   * Check if the Ollama service is running
   * @returns {Promise<boolean>} - True if the service is running, false otherwise
   */
  async checkStatus() {
    // use ollama status endpoint
    try {
      const response = await this.client.get(`${this.apiUrl}/api/ps`, {
        headers: this._buildRequestHeaders(),
      });
      if (response.status === 200) {
        const data = response.data;
        // Ensure data is an array and has at least one model
        let modelName = null;
        if (Array.isArray(data.models) && data.models.length > 0) {
          modelName = data.models[0].name;
        }
        console.log('Ollama model name:', modelName);
        return { status: 'ok', model: modelName };
      }
    } catch (error) {
      console.error(`Error checking Ollama service status: ${error.message}`);
      console.debug(error);
    }
    return { status: 'error' };
  }
}

module.exports = new OllamaService();
