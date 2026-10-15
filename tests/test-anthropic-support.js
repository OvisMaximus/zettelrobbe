'use strict';

/**
 * The shared rules for talking to the Claude API (services/anthropicSupport.js).
 *
 * Every Anthropic request in the app — document analysis, generateText, OCR —
 * builds its thinking fields, its completion cap and its usage record through
 * these helpers. The cases pin the parts a wrong guess turns into a 400:
 *
 *   1. the default model is Claude Haiku 5.5
 *   2. thinking off: Haiku 5.5 'disabled', Sonnet 5.5 'between_tools',
 *      Opus 5.5 nothing (always on), each with effort 'low'
 *   3. thinking on only asks for adaptive where the model would not think
 *   4. reasoning null sends only the configured effort, where accepted
 *   5. an effort the model does not know is dropped, not sent
 *   6. older models without effort get no output_config at all
 *   7. an unknown, newer model is treated like the current generation
 *   8. the completion cap prefers the caller, then the config, then 16000
 *   9. the answer is the text blocks, read by type, thinking skipped
 *  10. usage maps to promptTokens/completionTokens/totalTokens with cache counts
 *  11. stop_reason max_tokens throws the shared truncation error
 *  12. stop_reason refusal throws ai_refused with the category
 *  13. end_turn passes
 *  14. the client honours a proxy URL and drops trailing slashes
 */

const assert = require('assert');

const {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_SUGGESTED_MODELS,
  anthropicModelTraits,
  anthropicThinkingParams,
  anthropicMaxTokens,
  anthropicMessageText,
  mapAnthropicUsage,
  assertAnthropicCompleted,
  createAnthropicClient,
} = require('../services/anthropicSupport');

let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}: ${error.message}`);
  }
};

const thrown = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

check('1. the default model is Claude Haiku 5.5', () => {
  assert.strictEqual(ANTHROPIC_DEFAULT_MODEL, 'claude-haiku-5-5');
  assert.strictEqual(ANTHROPIC_SUGGESTED_MODELS[0].id, 'claude-haiku-5-5');
});

check('2. thinking off sends what each model accepts', () => {
  assert.deepStrictEqual(
    anthropicThinkingParams('claude-haiku-5-5', { reasoning: false }),
    { thinking: { type: 'disabled' }, output_config: { effort: 'low' } }
  );
  assert.deepStrictEqual(
    anthropicThinkingParams('claude-sonnet-5-5', { reasoning: false }),
    { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } }
  );
  assert.deepStrictEqual(
    anthropicThinkingParams('claude-opus-5-5', {
      reasoning: false,
      effort: 'high',
    }),
    { output_config: { effort: 'low' } }
  );
});

check(
  '3. thinking on asks for adaptive only where it is off by default',
  () => {
    assert.deepStrictEqual(
      anthropicThinkingParams('claude-opus-4-8', { reasoning: true }),
      { thinking: { type: 'adaptive' } }
    );
    assert.deepStrictEqual(
      anthropicThinkingParams('claude-haiku-5-5', { reasoning: true }),
      {}
    );
    assert.deepStrictEqual(
      anthropicThinkingParams('claude-haiku-4-5', { reasoning: true }),
      {}
    );
  }
);

check('4. reasoning null sends only the configured effort', () => {
  assert.deepStrictEqual(
    anthropicThinkingParams('claude-haiku-5-5', { effort: 'Medium' }),
    { output_config: { effort: 'medium' } }
  );
  assert.deepStrictEqual(anthropicThinkingParams('claude-haiku-5-5'), {});
});

check('5. an unknown or unsupported effort is dropped', () => {
  assert.deepStrictEqual(
    anthropicThinkingParams('claude-haiku-5-5', { effort: 'turbo' }),
    {}
  );
  assert.deepStrictEqual(
    anthropicThinkingParams('claude-sonnet-4-6', { effort: 'xhigh' }),
    {}
  );
});

check('6. models without effort get no output_config', () => {
  assert.deepStrictEqual(
    anthropicThinkingParams('claude-haiku-4-5', { reasoning: false }),
    {}
  );
});

check('7. a newer, unknown model is treated as current generation', () => {
  const traits = anthropicModelTraits('claude-opus-6');
  assert.strictEqual(traits.thinkingOff, null);
  assert.strictEqual(traits.structuredOutput, true);
  assert.ok(traits.effortLevels.includes('low'));
  assert.strictEqual(
    anthropicModelTraits('claude-opus-5').thinkingOff,
    'disabled'
  );
  assert.strictEqual(anthropicModelTraits('claude-opus-5-5').thinkingOff, null);
});

check('8. the completion cap: caller, then config, then 16000', () => {
  assert.strictEqual(anthropicMaxTokens(300, 8000), 300);
  assert.strictEqual(anthropicMaxTokens(null, 8000), 8000);
  assert.strictEqual(anthropicMaxTokens(undefined, ''), 16000);
  assert.strictEqual(anthropicMaxTokens(-1, 'nope'), 16000);
});

check('9. the answer is the text blocks, thinking skipped', () => {
  assert.strictEqual(
    anthropicMessageText({
      content: [
        { type: 'thinking', thinking: '', signature: 'abc' },
        { type: 'text', text: '{"tags":' },
        { type: 'text', text: '[]}' },
      ],
    }),
    '{"tags":[]}'
  );
  assert.strictEqual(anthropicMessageText({}), '');
});

check('10. usage maps to the shared shape with cache counts', () => {
  assert.deepStrictEqual(
    mapAnthropicUsage({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    }),
    {
      promptTokens: 1000,
      completionTokens: 40,
      totalTokens: 1040,
      reasoningTokens: null,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    }
  );
  assert.strictEqual(mapAnthropicUsage(null), null);
});

check('11. max_tokens throws the shared truncation error', () => {
  const error = thrown(() =>
    assertAnthropicCompleted(
      { stop_reason: 'max_tokens', usage: { output_tokens: 16000 } },
      'Anthropic',
      'Raise ANTHROPIC_MAX_TOKENS.',
      { partialText: '{"tags":' }
    )
  );
  assert.ok(error, 'expected a throw');
  assert.strictEqual(error.code, 'ai_response_truncated');
  assert.strictEqual(error.partialText, '{"tags":');
  assert.match(error.message, /16000 tokens/);
});

check('12. refusal throws ai_refused with the category', () => {
  const error = thrown(() =>
    assertAnthropicCompleted(
      { stop_reason: 'refusal', stop_details: { category: 'cyber' } },
      'Anthropic',
      'n/a'
    )
  );
  assert.ok(error, 'expected a throw');
  assert.strictEqual(error.code, 'ai_refused');
  assert.match(error.message, /cyber/);
});

check('13. end_turn passes', () => {
  assert.strictEqual(
    thrown(() =>
      assertAnthropicCompleted({ stop_reason: 'end_turn' }, 'Anthropic', '')
    ),
    null
  );
});

check('14. the client honours a proxy URL', () => {
  const client = createAnthropicClient({
    apiKey: 'sk-ant-test',
    apiUrl: 'http://proxy.local:8080/',
  });
  assert.strictEqual(client.baseURL, 'http://proxy.local:8080');
  const direct = createAnthropicClient({ apiKey: 'sk-ant-test' });
  assert.match(String(direct.baseURL), /api\.anthropic\.com/);
});

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll anthropic-support checks passed');
