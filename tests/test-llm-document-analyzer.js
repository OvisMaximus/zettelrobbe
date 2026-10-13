/**
 * The single business logic behind the LLM document analysis.
 *
 * Step 6 of the LLM service refactoring (services/ManualServiceRefactoring.md,
 * "DocumentAnalyzer — the single business logic"). Every provider is a
 * composition root: it wires the DocumentAnalyzer to its own transport,
 * token budget, prompt builder and response parser, and exports the
 * singleton. Nothing extends DocumentAnalyzer — the collaborators arrive
 * through the constructor.
 *
 * This file checks the OpenAI composition root
 * (services/llm/providers/openaiProvider.js) as the reference case:
 *
 *  - the root is a DocumentAnalyzer, constructed — never extended;
 *  - the service seams the other providers' tests rely on live on the root
 *    itself (`client`, `lastGenerateTextUsage`);
 *  - analyzeDocument() runs the shared pipeline end to end against a fake
 *    client, keeping today's OpenAI behaviour (temperature, refusal
 *    placeholder, failure records, never a throw);
 *  - checkStatus() and generateText() delegate to the transport, and the
 *    OpenAI generation request dialect is owned by the provider;
 *  - the analyzer itself works with a fake transport object literal only —
 *    which is what keeps every composition root testable without network or
 *    require.cache surgery.
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
process.env.OLLAMA_API_KEY = 'test-key';

const config = require('../config/config');
const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const DocumentAnalyzer = require('../services/llm/documentAnalyzer');
const {
  openaiProvider,
  buildGenerationRequest,
} = require('../services/llm/providers/openaiProvider');
const responseParser = require('../services/llm/responseParser');

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
const DOCUMENT_ID = 'testLlmDocumentAnalyzer';

const ANSWER = {
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
};

/** Enough text that no provider takes an "insufficient content" shortcut. */
const CONTENT = 'Invoice from Telekom Deutschland GmbH. '.repeat(20);

const CHAT_ANSWER = {
  choices: [
    { message: { content: JSON.stringify(ANSWER) }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
};

/** Records the requests it is given; `respond` overrides the payload. */
const fakeChatClient = (requests, respond = async () => CHAT_ANSWER) => ({
  chat: {
    completions: {
      create: async (request) => {
        requests.push(request);
        return respond(request);
      },
    },
  },
});

(async () => {
  console.log('\n=== LLM document analyzer (OpenAI composition root) ===');

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(getThumbnailCachePath(DOCUMENT_ID), 'thumbnail');

  const analyse = (service) =>
    service.analyzeDocument(CONTENT, [], [], [], DOCUMENT_ID);

  /* --- the composition root itself -------------------------------------- */

  await check('the OpenAI root is a DocumentAnalyzer, never a subclass', () => {
    assert.ok(
      openaiProvider instanceof DocumentAnalyzer,
      'openaiProvider must be constructed, not extended'
    );
    assert.strictEqual(
      openaiProvider.constructor,
      DocumentAnalyzer,
      'no inheritance: the root wires the analyzer, it does not extend it'
    );
  });

  await check('the root keeps the client seam on itself', () => {
    const client = fakeChatClient([]);
    openaiProvider.client = client;
    assert.strictEqual(openaiProvider.client, client);
    assert.strictEqual(openaiProvider.transport.client, client);
  });

  await check('the root keeps the lastGenerateTextUsage seam on itself', () => {
    const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    openaiProvider.lastGenerateTextUsage = usage;
    assert.deepStrictEqual(openaiProvider.lastGenerateTextUsage, usage);
  });

  /* --- analyzeDocument through the shared pipeline ---------------------- */

  await check(
    'analyzeDocument runs the shared pipeline end to end',
    async () => {
      const requests = [];
      openaiProvider.client = fakeChatClient(requests);
      const analysis = await analyse(openaiProvider);

      assert.strictEqual(analysis.error, undefined, analysis.error);
      assert.deepStrictEqual(analysis.document.tags, ['invoice']);
      assert.strictEqual(
        analysis.document.correspondent,
        'Telekom Deutschland GmbH'
      );
      assert.deepStrictEqual(analysis.metrics, {
        promptTokens: 900,
        completionTokens: 120,
        totalTokens: 1020,
      });
      assert.strictEqual(analysis.truncated, false);
      assert.strictEqual(requests.length, 1, 'exactly one completion request');
      assert.strictEqual(requests[0].model, 'gpt-4');
      assert.strictEqual(
        requests[0].temperature,
        config.aiTemperatureAnalysis,
        'the analysis temperature follows the config'
      );
      assert.deepStrictEqual(
        requests[0].messages.map((m) => m.role),
        ['system', 'user']
      );
    }
  );

  await check(
    'a refusal is the insufficient-content placeholder, not a throw',
    async () => {
      openaiProvider.client = fakeChatClient(
        [],
        async () => ({
          ...CHAT_ANSWER,
          choices: [
            {
              message: {
                content: "I'm sorry, I cannot analyse this document.",
              },
              finish_reason: 'stop',
            },
          ],
        })
      );
      const analysis = await analyse(openaiProvider);

      assert.strictEqual(
        analysis.error,
        'Insufficient content for AI analysis'
      );
      assert.deepStrictEqual(analysis.document.tags, []);
      assert.strictEqual(analysis.document.correspondent, 'Unknown');
      assert.ok(analysis.metrics, 'the refusal still costs tokens');
    }
  );

  await check(
    'a missing usable message is a failure record, never a throw',
    async () => {
      openaiProvider.client = fakeChatClient(
        [],
        async () => ({ choices: [] })
      );
      const analysis = await analyse(openaiProvider);

      assert.ok(analysis, 'analyzeDocument returned nothing at all');
      assert.deepStrictEqual(
        analysis.document,
        { tags: [], correspondent: null },
        'a failure must still carry an empty, well-formed document'
      );
      assert.strictEqual(analysis.metrics, null);
      assert.match(
        analysis.error,
        /Invalid API response structure/,
        'the OCR fallback matches this phrase'
      );
    }
  );

  await check(
    'a note without tags or correspondent records a failure',
    async () => {
      openaiProvider.client = fakeChatClient(
        [],
        async () => ({
          ...CHAT_ANSWER,
          choices: [
            { message: { content: '{"note": "nothing usable here"}' } },
          ],
        })
      );
      const analysis = await analyse(openaiProvider);

      assert.ok(analysis, 'analyzeDocument returned nothing at all');
      assert.strictEqual(analysis.metrics, null);
      assert.match(
        analysis.error,
        /could not determine assignable metadata/i
      );
    }
  );

  /* --- checkStatus delegates to the transport's probe ------------------- */

  await check('checkStatus reports ok through the transport probe', async () => {
    openaiProvider.client = { models: { list: async () => ({ data: [] }) } };
    const status = await openaiProvider.checkStatus();
    assert.deepStrictEqual(status, { status: 'ok', model: 'gpt-4' });
  });

  await check(
    'checkStatus without a ready client reports the not-ready error',
    async () => {
      openaiProvider.client = null;
      openaiProvider.transport._createClient = () => null;
      const status = await openaiProvider.checkStatus();
      assert.deepStrictEqual(status, {
        status: 'error',
        error: 'OpenAI client not initialized - missing API key',
      });
    }
  );

  /* --- generateText delegates with the OpenAI request dialect ----------- */

  await check('generateText delegates to the transport', async () => {
    const requests = [];
    openaiProvider.client = fakeChatClient(requests, async () => ({
      choices: [{ message: { content: 'hello answer' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));

    const text = await openaiProvider.generateText('hello');
    assert.strictEqual(text, 'hello answer');
    assert.strictEqual(requests[0].model, 'gpt-4');
    assert.strictEqual(
      requests[0].temperature,
      config.aiTemperatureGeneration
    );
    assert.deepStrictEqual(requests[0].messages, [
      { role: 'user', content: 'hello' },
    ]);
    assert.strictEqual(
      openaiProvider.lastGenerateTextUsage.totalTokens,
      15,
      'usage of the last call stays on the root'
    );
  });

  await check('the OpenAI generation request keeps its own dialect', () => {
    const plain = buildGenerationRequest('prompt');
    assert.deepStrictEqual(plain.messages, [
      { role: 'user', content: 'prompt' },
    ]);
    assert.strictEqual(plain.temperature, config.aiTemperatureGeneration);
    assert.ok(!('max_tokens' in plain));
    assert.ok(!('reasoning_effort' in plain));

    const system = buildGenerationRequest('prompt', {
      systemPrompt: 'be brief',
    });
    assert.deepStrictEqual(system.messages, [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'prompt' },
    ]);

    // The thinking switch exists on the reasoning families only, and only
    // when the caller asked for no thinking: an ordinary model would answer
    // 400 for the field, a caller without a stance sends nothing.
    const oSeries = buildGenerationRequest('prompt', {
      model: 'o3-mini',
      reasoning: false,
    });
    assert.strictEqual(oSeries.reasoning_effort, 'low');
    const gptFive = buildGenerationRequest('prompt', {
      model: 'gpt-5',
      reasoning: false,
    });
    assert.strictEqual(gptFive.reasoning_effort, 'minimal');
    const ordinary = buildGenerationRequest('prompt', {
      model: 'gpt-4',
      reasoning: false,
    });
    assert.ok(!('reasoning_effort' in ordinary));
    const noStance = buildGenerationRequest('prompt', {
      model: 'o3-mini',
    });
    assert.ok(!('reasoning_effort' in noStance));

    const explicit = buildGenerationRequest('prompt', {
      model: 'gpt-4',
      temperature: 0.1,
      maxTokens: 100.9,
    });
    assert.strictEqual(explicit.temperature, 0.1);
    assert.strictEqual(explicit.max_tokens, 100);
  });

  /* --- the analyzer with injected fakes only ---------------------------- */

  await check(
    'DocumentAnalyzer works with a fake transport object literal only',
    async () => {
      const calls = [];
      const fakeTransport = {
        label: 'Fake',
        client: {},
        lastGenerateTextUsage: null,
        initialize() {},
        isReady: () => true,
        calls,
        async complete(request) {
          calls.push(request);
          return {
            payload: JSON.stringify({
              tags: ['tag1'],
              correspondent: 'John Doe',
            }),
            metrics: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          };
        },
        async checkStatus() {
          return { status: 'ok' };
        },
        async generate() {
          return 'generated';
        },
      };

      const analyzer = new DocumentAnalyzer({
        transport: fakeTransport,
        tokenBudget: {
          reserve: async () => ({
            totalPromptTokens: 10,
            reservedTokens: 5,
            availableTokens: 4096,
          }),
          fit: async (content) => content,
        },
        promptBuilder: {
          buildAnalysisPrompt: () => ({ systemPrompt: 'stub prompt' }),
        },
        responseParser,
        resolveModel: () => 'test-model',
        thumbnailCache: { cache: async () => false },
        clientNotReadyMessage: 'stub client not initialized',
      });

      const analysis = await analyzer.analyzeDocument(
        'content',
        [],
        [],
        [],
        'stub-id'
      );
      assert.strictEqual(analysis.error, undefined, analysis.error);
      assert.deepStrictEqual(analysis.document.tags, ['tag1']);
      assert.strictEqual(calls.length, 1, 'exactly one completion request');
      assert.strictEqual(calls[0].systemPrompt, 'stub prompt');
      assert.strictEqual(calls[0].userContent, 'content');
      assert.strictEqual(calls[0].model, 'test-model');
      assert.strictEqual(
        analysis.metrics.totalTokens,
        15,
        'the transport metrics reach the result'
      );

      assert.strictEqual(
        await analyzer.generateText('p'),
        'generated',
        'generateText is pure delegation'
      );
      assert.deepStrictEqual(await analyzer.checkStatus(), { status: 'ok' });
    }
  );

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed) {
    console.error(`\n${failed} document analyzer case(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll document analyzer cases passed');
})();
