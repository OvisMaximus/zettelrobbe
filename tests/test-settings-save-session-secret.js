/**
 * Saving the settings must not sign anybody out.
 *
 * JWT_SECRET is minted once at first start and sits in no form, while
 * setupService.saveConfig() rewrites runtime-overrides.json (and, in legacy
 * mode, data/.env) whole. The settings page saved without the secret, so the
 * restart that follows every save found none, minted a new one, and every open
 * session stopped verifying — the page that had just saved went on looking
 * signed in while each request it made landed on the login page.
 *
 *   1. runtime-first: the overrides keep the running secret after a save
 *   2. ... and a fresh process (the restart) starts with that same secret
 *   3. legacy mode: data/.env keeps it too
 *   4. a secret the configuration does carry (setup wizard) is the one saved
 *   5. a secret injected through the environment is still never written
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const configModulePath = require.resolve('../config/config');
const setupServiceModulePath = require.resolve('../services/setupService');

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const originalSnapshot = global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;

// What the settings page hands to saveConfig: its own keys, no JWT_SECRET.
const SETTINGS_SAVE = {
  PAPERLESS_API_URL: 'http://paperless.example',
  PAPERLESS_API_TOKEN: 'token',
  AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ANTHROPIC_MODEL: 'claude-haiku-5-5',
  API_KEY: 'api-key',
};

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

/**
 * Loads config and setupService fresh inside a new data directory, the way a
 * container start does: `injected` is what docker-compose put into the
 * environment, `overrides` what runtime-overrides.json already holds.
 */
function startInstance({ injected = {}, overrides = null, legacyEnv = null }) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zettelrobbe-session-secret-')
  );
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (overrides) {
    fs.writeFileSync(
      path.join(dataDir, 'runtime-overrides.json'),
      JSON.stringify(overrides, null, 2)
    );
  }
  if (legacyEnv !== null) {
    fs.writeFileSync(path.join(dataDir, '.env'), legacyEnv);
  }

  process.chdir(tempDir);
  process.env = {
    PATH: originalEnv.PATH || '',
    LOG_LEVEL: 'error',
    ...injected,
  };
  delete global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;
  delete require.cache[configModulePath];
  delete require.cache[setupServiceModulePath];
  require(configModulePath);

  return {
    tempDir,
    setupService: require(setupServiceModulePath),
    overrides: () =>
      JSON.parse(
        fs.readFileSync(path.join(dataDir, 'runtime-overrides.json'), 'utf8')
      ),
    envFile: () => fs.readFileSync(path.join(dataDir, '.env'), 'utf8'),
  };
}

/** The JWT_SECRET a freshly started process in `cwd` ends up with. */
function secretAfterRestart(cwd, env = {}) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(configModulePath)});` +
        "process.stdout.write(process.env.JWT_SECRET || '');",
    ],
    {
      cwd,
      env: { PATH: originalEnv.PATH || '', LOG_LEVEL: 'error', ...env },
      encoding: 'utf8',
    }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

(async () => {
  console.log('\n=== Settings save keeps the session secret ===');

  await check(
    '1+2. runtime-first: the secret survives the save and the restart',
    async () => {
      const instance = startInstance({
        overrides: {
          JWT_SECRET: 'minted-at-first-start',
          SCAN_INTERVAL: '0 * * * *',
        },
      });
      try {
        assert.strictEqual(process.env.JWT_SECRET, 'minted-at-first-start');
        await instance.setupService.saveConfig(SETTINGS_SAVE, {
          skipValidation: true,
        });

        assert.strictEqual(
          instance.overrides().JWT_SECRET,
          'minted-at-first-start',
          'runtime-overrides.json lost the secret'
        );
        assert.strictEqual(
          instance.overrides().ANTHROPIC_MODEL,
          'claude-haiku-5-5'
        );
        assert.strictEqual(
          secretAfterRestart(instance.tempDir),
          'minted-at-first-start',
          'the restarted process would mint a new secret'
        );
      } finally {
        fs.rmSync(instance.tempDir, { recursive: true, force: true });
      }
    }
  );

  await check('3. legacy mode: data/.env keeps the secret', async () => {
    const instance = startInstance({
      injected: { CONFIG_SOURCE_MODE: 'legacy' },
      legacyEnv: 'JWT_SECRET=minted-at-first-start\nSCAN_INTERVAL=0 * * * *\n',
    });
    try {
      assert.strictEqual(process.env.JWT_SECRET, 'minted-at-first-start');
      await instance.setupService.saveConfig(SETTINGS_SAVE, {
        skipValidation: true,
      });

      assert.match(instance.envFile(), /^JWT_SECRET=.*minted-at-first-start/m);
      assert.strictEqual(
        secretAfterRestart(instance.tempDir, { CONFIG_SOURCE_MODE: 'legacy' }),
        'minted-at-first-start'
      );
    } finally {
      fs.rmSync(instance.tempDir, { recursive: true, force: true });
    }
  });

  await check(
    '4. a secret the configuration carries is the one saved',
    async () => {
      const instance = startInstance({
        overrides: { JWT_SECRET: 'old' },
      });
      try {
        await instance.setupService.saveConfig(
          { ...SETTINGS_SAVE, JWT_SECRET: 'from-setup-wizard' },
          { skipValidation: true }
        );
        assert.strictEqual(
          instance.overrides().JWT_SECRET,
          'from-setup-wizard'
        );
      } finally {
        fs.rmSync(instance.tempDir, { recursive: true, force: true });
      }
    }
  );

  await check('5. an injected secret is never written', async () => {
    const instance = startInstance({
      injected: { JWT_SECRET: 'from-docker-compose' },
      overrides: { SCAN_INTERVAL: '0 * * * *' },
    });
    try {
      await instance.setupService.saveConfig(SETTINGS_SAVE, {
        skipValidation: true,
      });
      assert.ok(
        !Object.prototype.hasOwnProperty.call(
          instance.overrides(),
          'JWT_SECRET'
        ),
        'the operator-injected secret was copied into runtime-overrides.json'
      );
      assert.strictEqual(process.env.JWT_SECRET, 'from-docker-compose');
    } finally {
      fs.rmSync(instance.tempDir, { recursive: true, force: true });
    }
  });

  await check(
    'OIDC_* kept in the runtime overrides survive the save',
    async () => {
      const instance = startInstance({
        overrides: {
          JWT_SECRET: 'minted-at-first-start',
          OIDC_ENABLED: 'yes',
          OIDC_CLIENT_SECRET: 'oidc-secret',
        },
      });
      try {
        await instance.setupService.saveConfig(SETTINGS_SAVE, {
          skipValidation: true,
        });
        assert.strictEqual(instance.overrides().OIDC_ENABLED, 'yes');
        assert.strictEqual(
          instance.overrides().OIDC_CLIENT_SECRET,
          'oidc-secret'
        );
      } finally {
        fs.rmSync(instance.tempDir, { recursive: true, force: true });
      }
    }
  );

  process.chdir(originalCwd);
  process.env = originalEnv;
  if (typeof originalSnapshot === 'undefined') {
    delete global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__;
  } else {
    global.__PAPERLESS_AI_INJECTED_ENV_SNAPSHOT__ = originalSnapshot;
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll session-secret checks passed');
})();
