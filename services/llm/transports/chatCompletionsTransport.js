'use strict';

/**
 * Talks to one chat completions API: OpenAI, Azure OpenAI, or any
 * OpenAI-compatible server behind a custom base URL.
 *
 * A transport owns the client and the request/response mapping, and nothing
 * else. It throws on a transport failure and on a provider-reported cut-off
 * (error.code 'ai_response_truncated'); it never shapes an analysis result —
 * that is analysisResult.js.
 */

const {
  assertCompletionNotTruncated,
  extractChatMessageContent,
} = require('../../serviceUtils');

/** What an operator can do about an analysis answer that hit the cap. */
const ANALYSIS_TRUNCATION_REMEDY =
  'Reduce the number of custom fields the prompt asks for, or use a model with a larger completion limit.';

class ChatCompletionsTransport {
  /**
   * @param {Object} options
   * @param {string} options.label - Provider name used in logs and errors
   * @param {() => Object|null} options.createClient - Builds the SDK client;
   *   null when the provider is not configured, which leaves it not ready
   * @param {(response:Object, message:Object) => string} [options.describeMissingContent]
   *   The error message for an answer without usable text. It must keep the
   *   "Invalid API response structure" phrase the OCR fallback matches on.
   */
  constructor({ label, createClient, describeMissingContent }) {
    this.label = label;
    this.client = null;
    this._createClient = createClient;
    this._describeMissingContent =
      describeMissingContent || (() => 'Invalid API response structure');
  }

  /** Build the client on first use; a client set from outside is kept. */
  initialize() {
    if (!this.client) {
      this.client = this._createClient() || null;
    }
  }

  isReady() {
    return Boolean(this.client);
  }

  /**
   * Send one analysis request.
   *
   * @param {Object} request
   * @param {string} request.systemPrompt
   * @param {string} request.userContent
   * @param {string} request.model
   * @param {number} [request.temperature] - Not sent when undefined
   * @returns {Promise<{payload:string, metrics:{promptTokens:number, completionTokens:number, totalTokens:number}}>}
   */
  async complete({ systemPrompt, userContent, model, temperature }) {
    const timestamp = new Date().toLocaleString('de-DE', {
      dateStyle: 'short',
      timeStyle: 'short',
    });

    const response = await this.client.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      ...(temperature !== undefined && { temperature }),
    });

    assertCompletionNotTruncated(
      response,
      this.label,
      ANALYSIS_TRUNCATION_REMEDY
    );
    const message = response?.choices?.[0]?.message;
    const payload = extractChatMessageContent(message, this.label);
    if (!payload) {
      throw new Error(this._describeMissingContent(response, message));
    }

    console.log(`[DEBUG] [${timestamp}] ${this.label} request sent`);
    console.log(
      `[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`
    );

    const usage = response.usage;
    return {
      payload,
      metrics: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
    };
  }
}

module.exports = { ChatCompletionsTransport, ANALYSIS_TRUNCATION_REMEDY };
