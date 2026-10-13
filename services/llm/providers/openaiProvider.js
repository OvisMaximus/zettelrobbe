'use strict';

/**
 * The OpenAI composition root.
 *
 * Wires the DocumentAnalyzer to the chat completions transport, the
 * tiktoken budget, the prompt builder and the response parser, and owns the
 * OpenAI generation request dialect. The singleton is the service facade:
 * services/openaiService.js re-exports it, and the sibling providers
 * (Azure, custom, Ollama) follow the same shape with their own transport,
 * budget and dialect.
 */

const DocumentAnalyzer = require('../documentAnalyzer');
const {
  ChatCompletionsTransport,
} = require('../transports/chatCompletionsTransport');
const tiktokenBudget = require('../tokenBudget/tiktokenBudget');
const promptBuilder = require('../promptBuilder');
const responseParser = require('../responseParser');
const { cacheThumbnail } = require('../../thumbnailCache');
const {
  hasNumber,
  hasSystemPrompt,
  modelOverride,
  reasoningEffortForOpenAi,
  reasoningEnabled,
} = require('../../aiGenerateOptions');
const OpenAI = require('openai');
const config = require('../../../config/config');

/** The provider's model for this request: prompt counting, the transport. */
function resolveModel() {
  return process.env.OPENAI_MODEL || config.openai.model;
}

/** What an operator can do about an answer that hit the completion cap. */
const TRUNCATION_REMEDY =
  'Reduce the number of custom fields the prompt asks for, or use a model with a larger completion limit.';

/**
 * The OpenAI generateText() request: what differs between the providers.
 * The transport sends it, streams it and reads the answer.
 *
 * @param {string} prompt
 * @param {object} options - see generateText()
 * @returns {object} The chat completions request
 */
function buildGenerationRequest(prompt, options = {}) {
  const model = modelOverride(options) || resolveModel();
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

/**
 * The provider-specific status probe: the token-free endpoint the old
 * openaiService used for connectivity/auth checks. The transport's default
 * would work too; the probe adds the model the probe ran against.
 * @param {Object} transport - The transport holding the client
 * @returns {Promise<{status:string, model?:string, error?:string}>}
 */
async function openAiCheckStatus(transport) {
  try {
    if (!transport.client) {
      throw new Error('OpenAI client not initialized - missing API key');
    }
    await transport.client.models.list();
    return { status: 'ok', model: resolveModel() };
  } catch (error) {
    console.error(`Error checking OpenAI status: ${error.message}`);
    console.debug(error);
    return { status: 'error', error: error.message };
  }
}

const openaiProvider = new DocumentAnalyzer({
  transport: new ChatCompletionsTransport({
    label: 'OpenAI',
    generation: {
      notReadyMessage: 'OpenAI client not initialized - missing API key',
      remedy: TRUNCATION_REMEDY,
      buildRequest: (prompt, options) =>
        buildGenerationRequest(prompt, options),
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
  }),
  tokenBudget: tiktokenBudget,
  promptBuilder,
  responseParser,
  resolveModel,
  thumbnailCache: { cache: async (id) => cacheThumbnail(id) },
  checkStatus: (transport) => openAiCheckStatus(transport),
  clientNotReadyMessage: 'OpenAI client not initialized',
});

module.exports = openaiProvider;
module.exports.openaiProvider = openaiProvider;
module.exports.buildGenerationRequest = buildGenerationRequest;
