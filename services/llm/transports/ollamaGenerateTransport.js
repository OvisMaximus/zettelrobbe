'use strict';

/**
 * Talks to Ollama's native /api/generate.
 *
 * Owns what makes Ollama different from the chat completions APIs: a prompt
 * and a system string instead of messages, a `format` schema for structured
 * output, num_ctx/num_predict, the `think` switch, one bounded retry for
 * transient failures, and the done_reason cut-off check. Like every
 * transport it throws on failure and never shapes an analysis result.
 *
 * The axios client is handed in rather than created here: the service builds
 * it, and tests replace it there.
 */

const config = require('../../../config/config');

/**
 * One bounded retry for transient failures (backend EOF, 5xx). The field
 * report behind this: an MLX runner closed its connection once under memory
 * pressure; the immediate second attempt succeeded.
 */
const MAX_ATTEMPTS = 2;

class OllamaGenerateTransport {
  /**
   * @param {Object} options
   * @param {Object} options.client - axios instance
   * @param {string} options.apiUrl - Ollama base URL
   * @param {string} options.model - Default model
   * @param {number} [options.retryDelayMs=1000] - Pause before the retry
   */
  constructor({ client, apiUrl, model, retryDelayMs = 1000 }) {
    this.label = 'Ollama';
    this.client = client;
    this.apiUrl = apiUrl;
    this.model = model;
    this.retryDelayMs = retryDelayMs;
  }

  initialize() {}

  isReady() {
    return Boolean(this.client);
  }

  /**
   * Build request headers, adding bearer auth when an API key is set.
   * The key is read at request time, so runtime config changes apply
   * without re-instantiating the singleton.
   * @returns {Object} Headers object
   */
  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY || config.ollama.apiKey || '';
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  /**
   * Extract the cause an Ollama (or its inference backend) reported in a
   * non-2xx response body. Ollama wraps backend failures — its runner closing
   * the connection on an oversized prompt, for example — into
   * `{ error: 'Post "http://…/v1/completions": EOF' }`; without this the
   * operator only ever sees "Request failed with status code 500" and cannot
   * tell an Ollama problem from a model-backend problem.
   *
   * @param {Object} axiosError
   * @returns {string|null}
   */
  extractUpstreamErrorMessage(axiosError) {
    const data = axiosError?.response?.data;
    if (!data) return null;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      try {
        return JSON.parse(trimmed)?.error || trimmed || null;
      } catch {
        return trimmed || null;
      }
    }
    return data.error || data.message || null;
  }

  /**
   * True for failures worth one more attempt: the connection dropped or the
   * server answered 5xx. A 4xx is a request problem and will fail again.
   *
   * @param {Object} axiosError
   * @returns {boolean}
   */
  isTransientFailure(axiosError) {
    if (!axiosError.response) {
      // No response at all: connection refused/reset/timeout.
      return true;
    }
    return axiosError.response.status >= 500;
  }

  /**
   * Wrap an axios failure with the upstream detail attached.
   *
   * @param {Object} axiosError - The axios error being wrapped
   * @param {number} attempt - Which attempt failed (1-based)
   * @returns {Error}
   */
  wrapRequestError(axiosError, attempt) {
    const upstream = this.extractUpstreamErrorMessage(axiosError);
    const status = axiosError?.response?.status;
    const detail = upstream ? `: ${upstream}` : '';
    const wrapped = new Error(
      `Ollama request failed (HTTP ${status || 'no response'}, attempt ${attempt})${detail}`,
      { cause: axiosError }
    );
    // Keep the axios code so the scan-loop classification (OCR fallback,
    // failure reasons) keeps working unchanged.
    wrapped.code = axiosError.code;
    return wrapped;
  }

  /**
   * Send one analysis request.
   *
   * @param {Object} request
   * @param {string} request.systemPrompt - Sent as `system`
   * @param {string} request.userContent - Sent as `prompt`
   * @param {string} [request.model] - Defaults to the transport's model
   * @param {number} request.temperature
   * @param {number} request.maxResponseTokens - Sent as num_predict
   * @param {number} request.numCtx - Context window to request
   * @param {Object|null} request.schema - Sent as `format`
   * @returns {Promise<{payload:string|Object, metrics:Object, raw:Object}>}
   */
  async complete({
    systemPrompt,
    userContent,
    model,
    temperature,
    maxResponseTokens,
    numCtx,
    schema,
  }) {
    const numPredict = maxResponseTokens;
    const requestBody = {
      model: model || this.model,
      prompt: userContent,
      system: systemPrompt,
      stream: false,
      format: schema,
      options: {
        temperature,
        top_p: 0.9,
        repeat_penalty: 1.1,
        top_k: 7,
        num_predict: numPredict,
        num_ctx: numCtx,
      },
    };

    // Disable thinking for reasoning models (e.g. Qwen3, DeepSeek-R1)
    // unless explicitly enabled via OLLAMA_THINK=true
    if (!config.ollama.think) {
      requestBody.think = false;
    }

    let response;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        response = await this.client.post(
          `${this.apiUrl}/api/generate`,
          requestBody,
          {
            headers: this.buildHeaders(),
          }
        );
        break;
      } catch (error) {
        const wrapped = this.wrapRequestError(error, attempt);
        console.error(`[ERROR] ${wrapped.message}`);
        if (attempt >= MAX_ATTEMPTS || !this.isTransientFailure(error)) {
          throw wrapped;
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }

    if (!response?.data) {
      throw new Error('Invalid response from Ollama API');
    }

    this.assertNotTruncated(response.data, numPredict, numCtx);
    return {
      payload: response.data.response,
      metrics: this.extractMetrics(response.data),
      raw: response.data,
    };
  }

  /**
   * A generation Ollama had to cut short comes back with done_reason "length".
   * What it returns is a prefix, and for structured output that means JSON
   * without its closing braces — which no amount of sanitizing recovers, so
   * there is nothing to do with it but say so.
   *
   * Two different limits produce the same done_reason and want opposite fixes:
   * num_predict is the response budget, but the context window can leave less
   * room than that, and then raising Response Tokens changes nothing. The
   * message names whichever one actually bit.
   *
   * @param {Object} responseData - Ollama /api/generate response
   * @param {number} numPredict - response token limit that was sent
   * @param {number} numCtx - context window that was sent
   * @param {Object} [extra] - what the caller salvaged from the cut-off answer
   * @param {string} [extra.partialText] - the text that did arrive, reasoning
   *   stripped; put on the error as `partialText` the way the OpenAI-compatible
   *   providers do, so a caller can keep it instead of asking twice
   */
  assertNotTruncated(responseData, numPredict, numCtx, extra) {
    const evalCount = Number(responseData?.eval_count) || 0;
    const promptEvalCount = Number(responseData?.prompt_eval_count) || 0;

    // done_reason is the direct signal. Reaching the limit exactly is the
    // fallback for an Ollama old enough not to send one.
    const stoppedOnLength =
      responseData?.done_reason === 'length' ||
      (!responseData?.done_reason && numPredict > 0 && evalCount >= numPredict);

    if (!stoppedOnLength) {
      return;
    }

    /* Which limit bit is read off the count itself rather than guessed from
       the context arithmetic: reaching num_predict exactly is the response
       budget, stopping short of it means the context filled up first. The
       arithmetic route was tried and got it backwards — the window is sized
       from an estimate of the prompt, so comparing it against the real
       prompt_eval_count blames the context for a run that generated its full
       budget. */
    const error =
      evalCount >= numPredict
        ? new Error(
            `Ollama stopped generating after ${evalCount} tokens, which is the configured response limit. Raise Response Tokens (RESPONSE_TOKENS) above ${numPredict}.`
          )
        : new Error(
            `Ollama stopped generating after ${evalCount} of ${numPredict} response tokens: the ${numCtx}-token context window was full, ${promptEvalCount} of it prompt. Raise Token Limit (TOKEN_LIMIT) or shorten the document.`
          );

    /* Carried as a code rather than matched out of the message later. The
       phrase-matching in serviceUtils classifies errors that arrive from
       elsewhere and have no better handle; this one is raised right here, so
       rewording it should not silently reclassify the failure. */
    error.code = 'ai_response_truncated';
    if (typeof extra?.partialText === 'string') {
      error.partialText = extra.partialText;
    }
    throw error;
  }

  /**
   * Token usage of an /api/generate response.
   * @param {Object} responseData - Ollama API response data
   * @returns {{promptTokens:number, completionTokens:number, totalTokens:number}}
   */
  extractMetrics(responseData) {
    const promptTokens = Number(responseData?.prompt_eval_count) || 0;
    const completionTokens = Number(responseData?.eval_count) || 0;

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }
}

module.exports = { OllamaGenerateTransport };
