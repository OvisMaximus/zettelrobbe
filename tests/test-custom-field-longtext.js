/**
 * Paperless-ngx has a `longtext` custom field type without the 128-character
 * limit of `string`. The processing path already passes such values through;
 * this test keeps it that way and keeps the type selectable in Settings, so
 * nobody has to hand-edit CUSTOM_FIELDS to use it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { validateCustomFieldValue } = require('../services/serviceUtils');

const SETTINGS_EJS = path.join(__dirname, '..', 'views', 'settings.ejs');

function main() {
  const longValue = 'Summary line.\n'.repeat(40).trim();
  assert.ok(longValue.length > 128, 'Fixture must exceed the string limit');

  const longtext = validateCustomFieldValue('Notes', longValue, 'longtext');
  assert.strictEqual(
    longtext.skip,
    false,
    'A longtext value over 128 characters must not be skipped'
  );
  assert.strictEqual(
    longtext.value,
    longValue,
    'A longtext value must reach Paperless-ngx unchanged, line breaks included'
  );

  const padded = validateCustomFieldValue(
    'Notes',
    `  ${longValue}  `,
    'longtext'
  );
  assert.strictEqual(
    padded.value,
    longValue,
    'Surrounding whitespace is trimmed'
  );

  const string = validateCustomFieldValue('Notes', longValue, 'string');
  assert.strictEqual(
    string.skip,
    true,
    'A string value over 128 characters is still skipped'
  );

  const viewSource = fs.readFileSync(SETTINGS_EJS, 'utf8');
  const typeSelect = viewSource.match(
    /<select id="newFieldType"[\s\S]*?<\/select>/
  );
  assert.ok(typeSelect, 'Could not find the custom field type selector');
  assert.ok(
    /<option value="longtext">/.test(typeSelect[0]),
    'The custom field type selector must offer longtext'
  );
  assert.ok(
    /<option value="string">/.test(typeSelect[0]),
    'The custom field type selector must still offer string'
  );
}

try {
  main();
  console.log(
    '[PASS] Long text custom fields pass validation and are selectable'
  );
} catch (error) {
  console.error('[FAIL] Long text custom field test failed:', error.message);
  process.exitCode = 1;
}
