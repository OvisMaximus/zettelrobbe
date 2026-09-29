/**
 * Saving Settings refuses a custom field whose name Paperless-ngx already has
 * under another data type. Without the check the save went through,
 * createCustomFieldSafely() quietly adopted the existing field, and every
 * value its type cannot hold (a long text in a `string` field, say) was
 * dropped during processing.
 *
 * Entries that were configured before the save only warn: CUSTOM_FIELDS may
 * be injected by the operator, and a mismatch there must not lock the page.
 */

const assert = require('assert');
const { mountRouter } = require('./helpers/mount-router');

const API_KEY = 'custom-field-conflict-key';
const START_ENV = {
  API_KEY,
  CUSTOM_FIELDS: JSON.stringify({
    custom_fields: [{ value: 'Legacy', data_type: 'date' }],
  }),
};

// What Paperless-ngx has. null makes the custom field listing fail.
let paperlessFields = [
  { id: 5, name: 'Notes', data_type: 'string' },
  { id: 6, name: 'Legacy', data_type: 'string' },
];

let passed = 0;
let failed = 0;

// A successful POST /settings schedules process.exit(0) five seconds later.
const realExit = process.exit.bind(process);
process.exit = () => {};

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅  ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌  ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

function finish() {
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit = realExit;
  realExit(failed > 0 ? 1 : 0);
}

(async () => {
  const savedConfigs = [];
  const createdFields = [];
  const harness = await mountRouter({
    env: START_ENV,
    stub: ({ setupService, paperlessService }) => {
      setupService.saveConfig = async (config) => {
        savedConfigs.push(config);
      };
      paperlessService.client.get = async (url) => {
        if (paperlessFields === null) {
          throw new Error('connect ECONNREFUSED');
        }
        assert.strictEqual(url, '/custom_fields/');
        return { data: { results: paperlessFields, next: null } };
      };
      paperlessService.createCustomFieldSafely = async (name, type) => {
        createdFields.push({ name, type });
        return { id: 99, name, data_type: type };
      };
    },
  });

  const postFields = async (fields) => {
    savedConfigs.length = 0;
    createdFields.length = 0;
    const response = await fetch(harness.base + '/settings', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customFields: JSON.stringify({ custom_fields: fields }),
      }),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    await test('a new field with another type than in Paperless-ngx is refused', async () => {
      const { status, body } = await postFields([
        { value: 'Legacy', data_type: 'date' },
        { value: 'notes', data_type: 'longtext' },
      ]);
      assert.strictEqual(status, 400, JSON.stringify(body));
      assert.strictEqual(body.success, false);
      assert.match(body.error, /"notes"/);
      assert.match(body.error, /type "string", not "longtext"/);
      assert.ok(
        !body.error.includes('Legacy'),
        'the entry configured before the save is not part of the refusal'
      );
      assert.strictEqual(savedConfigs.length, 0, 'nothing is saved');
      assert.strictEqual(createdFields.length, 0, 'nothing is created');
    });

    await test('a mismatch that was configured before only warns', async () => {
      const { status, body } = await postFields([
        { value: 'Legacy', data_type: 'date' },
      ]);
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.strictEqual(savedConfigs.length, 1);
    });

    await test('matching and unknown fields are saved and created', async () => {
      const { status, body } = await postFields([
        { value: 'Notes', data_type: 'string' },
        { value: 'Summary', data_type: 'longtext' },
      ]);
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.strictEqual(savedConfigs.length, 1);
      assert.deepStrictEqual(JSON.parse(savedConfigs[0].CUSTOM_FIELDS), {
        custom_fields: [
          { value: 'Notes', data_type: 'string' },
          { value: 'Summary', data_type: 'longtext' },
        ],
      });
      assert.deepStrictEqual(createdFields, [
        { name: 'Notes', type: 'string' },
        { name: 'Summary', type: 'longtext' },
      ]);
    });

    await test('an unreachable Paperless-ngx does not block saving', async () => {
      paperlessFields = null;
      const { status, body } = await postFields([
        { value: 'Notes', data_type: 'longtext' },
      ]);
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.strictEqual(savedConfigs.length, 1);
    });
  } finally {
    await harness.close();
    finish();
  }
})().catch((error) => {
  console.error('[FATAL]', error);
  process.exit = realExit;
  realExit(1);
});
