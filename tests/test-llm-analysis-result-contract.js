/**
 * The analysis result contract, pinned across all four providers.
 *
 * Safety net for the LLM service refactoring (services/ManualServiceRefactoring.md,
 * step 1). It describes what analyzeDocument() promises its three callers today —
 * server.js:766-821, services/mistralOcrService.js:988-997, and
 * routes/setup.js:3167-3177 — so that collapsing four implementations into one
 * cannot quietly change the shape they read.
 *
 * Two properties carry the weight:
 *
 *   1. Success returns the full { document, metrics, truncated } record. Every
 *      field of `document` is written back by paperlessService.updateDocument();
 *      a narrowed document does not fail loudly, it silently stops setting the
 *      title, type, date, language, and custom fields.
 *
 *   2. Failure returns { document: { tags: [], correspondent: null },
 *      metrics: null, error, errorCode } and **never throws**. server.js relies
 *      on this: a throw escapes the per-document try in the scan loop instead of
 *      routing the document to the OCR queue.
 *
 * The provider client is the only collaborator stubbed. The thumbnail cache is
 * pre-seeded so the analysis path reaches the client without a Paperless call.
 */

const assert = require('assert');
const fs = require('fs').promises;

process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'gpt-4';
process.env.AZURE_API_KEY = 'test-key';
process.env.AZURE_ENDPOINT = 'https://example.invalid';
process.env.AZURE_DEPLOYMENT_NAME = 'test-deployment';
process.env.CUSTOM_BASE_URL = 'https://example.invalid/v1';
process.env.CUSTOM_API_KEY = 'test-key';
process.env.CUSTOM_MODEL = 'test-model';
process.env.SYSTEM_PROMPT = 'Analyse the document.';

const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const openaiService = require('../services/openaiService');
const azureService = require('../services/azureService');
const customService = require('../services/customService');
const ollamaService = require('../services/ollamaService');

let failed = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}: ${error.message}`);
  }
};

/** Own id so the seeded thumbnail cannot collide with a real cached document. */
const DOCUMENT_ID = 'testLlmResultContract';

/**
 * Every field the write-back path reads. Deliberately includes the ones a
 * narrowed result would drop without any error surfacing.
 */
const ANSWER = {
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice', 'telecom'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
  custom_fields: [{ field_name: 'Amount', value: '49.99' }],
};

function completion(content = JSON.stringify(ANSWER)) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
  };
}

/** Replaces the SDK client with one that answers whatever the case needs. */
function stubClient(service, respond) {
  service.client = {
    chat: { completions: { create: respond } },
    models: { list: async () => ({ data: [] }) },
  };
}

/** Same for Ollama, which answers over axios instead of an SDK. */
function stubOllamaClient(respond) {
  ollamaService.client = {
    post: respond,
    get: async () => ({ status: 200, data: { models: [] } }),
  };
}

function openAiCompatibleProvider(label, service) {
  return {
    label,
    service,
    arrangeSuccess: () => stubClient(service, async () => completion()),
    arrangeAnswer: (content) =>
      stubClient(service, async () => completion(content)),
    arrangeThrow: (error) =>
      stubClient(service, async () => {
        throw error;
      }),
  };
}

const PROVIDERS = [
  openAiCompatibleProvider('OpenAI', openaiService),
  openAiCompatibleProvider('Azure', azureService),
  openAiCompatibleProvider('Custom', customService),
  {
    label: 'Ollama',
    service: ollamaService,
    arrangeSuccess: () =>
      stubOllamaClient(async () => ({
        data: {
          response: JSON.stringify(ANSWER),
          done_reason: 'stop',
          eval_count: 120,
          prompt_eval_count: 900,
        },
      })),
    arrangeAnswer: (content) =>
      stubOllamaClient(async () => ({
        data: {
          response: content,
          done_reason: 'stop',
          eval_count: 120,
          prompt_eval_count: 900,
        },
      })),
    arrangeThrow: (error) =>
      stubOllamaClient(async () => {
        throw error;
      }),
  },
];

/** Enough text that no provider takes an "insufficient content" shortcut. */
const CONTENT = 'Invoice from Telekom Deutschland GmbH. '.repeat(20);

const analyse = (service) =>
  service.analyzeDocument(CONTENT, [], [], [], DOCUMENT_ID);

/** The failure shape server.js:774-821 branches on. */
const assertFailureRecord = (analysis) => {
  assert.ok(analysis, 'analyzeDocument returned nothing at all');
  assert.deepStrictEqual(
    analysis.document,
    { tags: [], correspondent: null },
    'a failure must still carry an empty, well-formed document'
  );
  assert.strictEqual(analysis.metrics, null, 'a failure records no metrics');
  assert.strictEqual(
    typeof analysis.error,
    'string',
    'the failure reason must be a string — shouldQueueForOcrOnAiError() reads it'
  );
  assert.ok(analysis.error.trim(), 'the failure reason must not be empty');
};

(async () => {
  console.log('\n=== LLM analysis result contract ===');

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(
    getThumbnailCachePath(DOCUMENT_ID),
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  );

  for (const {
    label,
    service,
    arrangeSuccess,
    arrangeAnswer,
    arrangeThrow,
  } of PROVIDERS) {
    /* --- the success record ------------------------------------------- */

    await check(
      `${label}: a successful analysis returns the full record`,
      async () => {
        arrangeSuccess();
        const analysis = await analyse(service);

        assert.ok(analysis, 'analyzeDocument returned nothing at all');
        assert.strictEqual(
          analysis.error,
          undefined,
          `unexpected error: ${analysis.error}`
        );
        assert.strictEqual(
          typeof analysis.truncated,
          'boolean',
          'truncated must always be a boolean'
        );
      }
    );

    await check(
      `${label}: every document field survives to the caller`,
      async () => {
        arrangeSuccess();
        const { document } = await analyse(service);

        // Asserted field by field: paperlessService.updateDocument() writes each
        // of these, and a dropped one produces no error, just a missing value.
        assert.deepStrictEqual(document.tags, ANSWER.tags);
        assert.strictEqual(document.correspondent, ANSWER.correspondent);
        assert.strictEqual(document.title, ANSWER.title);
        assert.strictEqual(document.document_type, ANSWER.document_type);
        assert.strictEqual(document.document_date, ANSWER.document_date);
        assert.strictEqual(document.language, ANSWER.language);
        assert.deepStrictEqual(document.custom_fields, ANSWER.custom_fields);
      }
    );

    await check(
      `${label}: metrics are reported as named token counts`,
      async () => {
        arrangeSuccess();
        const { metrics } = await analyse(service);

        // documentModel.addOpenAIMetrics() reads these three names.
        assert.ok(metrics, 'a successful analysis must report metrics');
        assert.strictEqual(typeof metrics.promptTokens, 'number');
        assert.strictEqual(typeof metrics.completionTokens, 'number');
        assert.strictEqual(typeof metrics.totalTokens, 'number');
      }
    );

    /* --- the failure record, and the promise not to throw --------------- */

    // The message text itself is not pinned here: Custom rewrites anything
    // isTimeoutError() recognizes into "AI response timeout reached…", and
    // Ollama's retry wrapper replaces it with "Ollama request failed (…)".
    // Only the phrases that steer OCR fallback are pinned, in
    // test-llm-ocr-fallback-phrases.js.
    await check(
      `${label}: a transport failure is returned, not thrown`,
      async () => {
        arrangeThrow(new Error('socket hang up'));
        const analysis = await analyse(service);

        assertFailureRecord(analysis);
      }
    );

    await check(
      `${label}: an unparseable answer is returned, not thrown`,
      async () => {
        arrangeAnswer('this is not JSON at all');
        const analysis = await analyse(service);

        assertFailureRecord(analysis);
      }
    );

    await check(
      `${label}: an error carrying a code passes the code through`,
      async () => {
        // The scan loop reads errorCode to decide OCR fallback; a service that
        // raises the right error but drops the code loses that decision.
        const coded = new Error('provider stopped generating early');
        coded.code = 'ai_response_truncated';
        arrangeThrow(coded);
        const analysis = await analyse(service);

        assertFailureRecord(analysis);
        assert.strictEqual(analysis.errorCode, 'ai_response_truncated');
      }
    );

    await check(
      `${label}: an error without a code leaves errorCode unset`,
      async () => {
        arrangeThrow(new Error('socket hang up'));
        const analysis = await analyse(service);

        assert.strictEqual(
          analysis.errorCode,
          undefined,
          'an uncoded failure must not invent a code'
        );
      }
    );
  }

  /* --- an answer with no usable metadata: the providers disagree --------- */

  /* OpenAI, Azure and Custom raise "AI could not determine assignable
     metadata: no tags or correspondent found", which is one of the phrases
     shouldQueueForOcrOnAiError() matches, so the document reaches the OCR
     queue. Ollama only logs and returns an all-null document as a *success*:
     no error, metrics populated. The scan loop therefore writes nulls back to
     Paperless and never falls back to OCR. */

  for (const { label, service, arrangeAnswer } of PROVIDERS.filter(
    (p) => p.label !== 'Ollama'
  )) {
    await check(
      `${label}: an answer without usable metadata is a failure`,
      async () => {
        arrangeAnswer(JSON.stringify({ note: 'nothing usable here' }));
        const analysis = await analyse(service);

        assertFailureRecord(analysis);
        assert.match(
          analysis.error,
          /could not determine assignable metadata/i
        );
      }
    );
  }

  /* Pinned as it is today so the divergence is visible rather than absent.
     When the refactor unifies this path (Finding 7c/7k), this case will start
     failing — that is the point. Replace it with the assertion above and drop
     the Ollama exclusion from the loop overhead. */
  await check(
    'Ollama: an answer without usable metadata is NOT reported as a failure (known drift)',
    async () => {
      const ollama = PROVIDERS.find((p) => p.label === 'Ollama');
      ollama.arrangeAnswer(JSON.stringify({ note: 'nothing usable here' }));
      const analysis = await analyse(ollama.service);

      assert.strictEqual(
        analysis.error,
        undefined,
        'Ollama has started reporting this as an error — unify it and update this case'
      );
      assert.deepStrictEqual(analysis.document, {
        tags: [],
        correspondent: null,
        title: null,
        document_date: null,
        document_type: null,
        language: null,
        custom_fields: null,
      });
      assert.ok(analysis.metrics, 'the drift includes reporting metrics');
    }
  );

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed) {
    console.error(`\n${failed} analysis result contract case(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll analysis result contract cases passed');
})();
