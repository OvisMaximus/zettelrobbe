/**
 * The analysis answer, parsed once for all four providers.
 *
 * Step 3 of the LLM service refactoring (services/ManualServiceRefactoring.md).
 * Finding 7d: there were three parsers. Custom matched braces and stripped
 * <think> blocks, openai and azure stripped fences and called JSON.parse on
 * the rest, Ollama took everything from the first "{" to the last "}" and
 * repaired trailing commas and unquoted keys. The same answer could therefore
 * succeed on one provider and fail on the next. services/llm/responseParser.js
 * is the union of the three.
 *
 * The first half pins what the parser accepts and how it fails. The second
 * half sends the same answers through every provider, so a provider that
 * keeps a private parser, or narrows the result again, fails here.
 *
 * Every failure must keep the "Invalid JSON response from API" phrase: the
 * OCR fallback matches on it (Finding 4).
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
delete process.env.CUSTOM_FIELDS;

const {
  THUMBNAIL_CACHE_DIR,
  getThumbnailCachePath,
} = require('../services/thumbnailCachePaths');
const {
  parseAnalysisResponse,
  stripResponseWrapping,
} = require('../services/llm/responseParser');
const { shouldQueueForOcrOnAiError } = require('../services/serviceUtils');
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
const DOCUMENT_ID = 'testLlmResponseParser';

const RESULT = {
  title: 'Telekom invoice July',
  correspondent: 'Telekom Deutschland GmbH',
  tags: ['invoice'],
  document_type: 'Rechnung',
  document_date: '2026-09-03',
  language: 'de',
  custom_fields: { 0: { field_name: 'Amount', value: '12.50' } },
};
const JSON_ANSWER = JSON.stringify(RESULT, null, 2);

/** Answers every provider has to read, and what each one is a case of. */
const READABLE_ANSWERS = [
  ['plain JSON', JSON_ANSWER],
  ['a fenced block', '```json\n' + JSON_ANSWER + '\n```'],
  ['an upper-case fence', '```JSON\n' + JSON_ANSWER + '\n```'],
  [
    'a <think> block in front',
    '<think>The sender is "Telekom" {maybe}.</think>\n' + JSON_ANSWER,
  ],
  [
    'prose around the object',
    'Here is the analysis:\n' + JSON_ANSWER + '\nLet me know {if} it helps.',
  ],
  ['a trailing comma', JSON_ANSWER.replace(/\n}$/, ',\n}')],
  [
    'braces inside a string value',
    'Result: ' +
      JSON_ANSWER.replace('Telekom invoice July', 'Invoice {July} }') +
      ' (done)',
  ],
];

/** The object a READABLE_ANSWERS entry stands for. */
function expectedFor(name) {
  return name === 'braces inside a string value'
    ? { ...RESULT, title: 'Invoice {July} }' }
    : RESULT;
}

/** Answers no provider can read; none of them may count as a success. */
const UNREADABLE_ANSWERS = [
  ['no JSON at all', 'The document is a scanned letter.'],
  ['an object cut off mid-way', '{"title": "Telekom", "tags": ["inv'],
  ['an object beyond repair', '{"title": "Telekom" "tags" ["invoice"]}'],
];

/* --- the providers, each with a client that answers a fixed text ---------- */

function chatClient(service, content) {
  service.client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        }),
      },
    },
    models: { list: async () => ({ data: [] }) },
  };
}

function ollamaClient(response) {
  ollamaService.client = {
    post: async () => ({
      data: {
        response,
        done_reason: 'stop',
        eval_count: 3,
        prompt_eval_count: 9,
      },
    }),
    get: async () => ({ status: 200, data: { models: [] } }),
  };
}

const PROVIDERS = [
  ['OpenAI', openaiService, (answer) => chatClient(openaiService, answer)],
  ['Azure', azureService, (answer) => chatClient(azureService, answer)],
  ['Custom', customService, (answer) => chatClient(customService, answer)],
  ['Ollama', ollamaService, ollamaClient],
];

async function analyze(service, answerWith, answer) {
  answerWith(answer);
  return service.analyzeDocument(
    'Document body text.',
    [],
    [],
    [],
    DOCUMENT_ID
  );
}

/** Ollama fills the fields a model left out; the chat providers pass them on. */
function sameDocument(label, actual, expected) {
  if (label !== 'Ollama') {
    assert.deepStrictEqual(actual, expected);
    return;
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(actual[key], value, key);
  }
}

(async () => {
  console.log('\n=== LLM response parser ===');

  /* --- the parser on its own --------------------------------------------- */

  for (const [name, answer] of READABLE_ANSWERS) {
    await check(`reads ${name}`, () => {
      const { parsed } = parseAnalysisResponse(answer);
      assert.deepStrictEqual(parsed, expectedFor(name));
    });
  }

  await check('normalized is the JSON that was parsed', () => {
    const { normalized } = parseAnalysisResponse(
      '<think>x</think>Sure:\n' + JSON_ANSWER + '\nDone.'
    );
    assert.deepStrictEqual(JSON.parse(normalized), RESULT);
    assert.ok(normalized.startsWith('{'), normalized);
    assert.ok(normalized.endsWith('}'), normalized);
  });

  await check('an answer that is already an object passes through', () => {
    const { parsed, normalized } = parseAnalysisResponse(RESULT);
    assert.strictEqual(parsed, RESULT);
    assert.deepStrictEqual(JSON.parse(normalized), RESULT);
  });

  await check('the first top-level object wins, not one nested in it', () => {
    // The outer object is beyond repair; its custom_fields entry would parse
    // on its own, but it is not the answer and must not be taken for one.
    const answer = '{"title": "A" "custom_fields": {"0": {"value": "1"}}}';
    assert.throws(() => parseAnalysisResponse(answer), /Invalid JSON/);
  });

  await check(
    'an unreadable object does not hide a readable one after it',
    () => {
      const { parsed } = parseAnalysisResponse(
        'Example: {broken "x"}\nAnswer: ' + JSON_ANSWER
      );
      assert.deepStrictEqual(parsed, RESULT);
    }
  );

  for (const [name, answer] of UNREADABLE_ANSWERS) {
    await check(`fails on ${name} with the OCR fallback phrase`, () => {
      assert.throws(
        () => parseAnalysisResponse(answer),
        (error) =>
          /^Invalid JSON response from API/.test(error.message) &&
          shouldQueueForOcrOnAiError(error.message)
      );
    });
  }

  await check('fails on an empty answer with the OCR fallback phrase', () => {
    for (const answer of ['', '   ', null, undefined]) {
      assert.throws(
        () => parseAnalysisResponse(answer),
        (error) => /^Invalid JSON response from API/.test(error.message)
      );
    }
  });

  await check('stripResponseWrapping drops reasoning and fences only', () => {
    assert.strictEqual(
      stripResponseWrapping('<think>a\nb</think>\n```json\n{"a":1}\n```\n'),
      '{"a":1}'
    );
    assert.strictEqual(stripResponseWrapping("I'm sorry."), "I'm sorry.");
  });

  /* --- every provider reads the same answers ----------------------------- */

  await fs.mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  await fs.writeFile(getThumbnailCachePath(DOCUMENT_ID), 'thumbnail');

  for (const [label, service, answerWith] of PROVIDERS) {
    for (const [name, answer] of READABLE_ANSWERS) {
      await check(`${label}: reads ${name}`, async () => {
        const analysis = await analyze(service, answerWith, answer);
        assert.strictEqual(analysis.error, undefined, analysis.error);
        sameDocument(label, analysis.document, expectedFor(name));
      });
    }

    for (const [name, answer] of UNREADABLE_ANSWERS) {
      await check(`${label}: ${name} reaches the OCR fallback`, async () => {
        const analysis = await analyze(service, answerWith, answer);
        assert.match(analysis.error || '', /Invalid JSON response from API/);
        assert.ok(shouldQueueForOcrOnAiError(analysis.error), analysis.error);
      });
    }
  }

  await check('Ollama: an answer object is used as it is', async () => {
    const analysis = await analyze(ollamaService, ollamaClient, RESULT);
    assert.strictEqual(analysis.error, undefined, analysis.error);
    sameDocument('Ollama', analysis.document, RESULT);
  });

  await fs.rm(getThumbnailCachePath(DOCUMENT_ID), { force: true });

  if (failed > 0) {
    console.error(`\n${failed} response parser case(s) failed`);
    process.exit(1);
  }
  console.log('\nAll response parser cases passed');
})();
