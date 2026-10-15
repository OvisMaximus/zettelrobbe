/**
 * A page whose session has ended must say so by going to the login page.
 *
 * Signed-in routes answer a missing or expired session with a redirect to
 * /login. fetch follows it, so the caller got the login page as a 200, could
 * not read it as JSON and showed a generic failure ("Model discovery failed")
 * while the page went on looking signed in.
 *
 * public/js/csrf.js and public/js/session-guard.js are executed here in the
 * order <head> loads them, so case 5 is the whole path a tab took after a
 * restart: stale CSRF token, refresh, retry, and the retry ends at /login.
 *
 *   1. a request redirected to /login sends the page there
 *   2. any other answer, redirects elsewhere included, changes nothing
 *   3. on the login page itself nothing happens (no reload loop)
 *   4. several requests ending at once navigate only once
 *   5. after a CSRF retry that ends at /login, the page goes there
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

const readScript = (name) =>
  fs.readFileSync(path.join(__dirname, '..', 'public', 'js', name), 'utf8');
const csrfSource = readScript('csrf.js');
const guardSource = readScript('session-guard.js');

const ORIGIN = 'http://zettelrobbe.local:3000';

/**
 * @param {object} options
 * @param {string} [options.pathname] the page the tab is on
 * @param {function} options.respond (url, config, attempt) => fake Response
 */
function loadPage({ pathname = '/settings', respond }) {
  const calls = [];
  const navigations = [];
  let metaContent = 'stale-token';

  const sandbox = {
    Headers,
    ReadableStream,
    URL,
    console,
    document: {
      querySelector(selector) {
        if (selector !== 'meta[name="csrf-token"]') return null;
        return {
          getAttribute: () => metaContent,
          setAttribute: (_name, value) => {
            metaContent = value;
          },
        };
      },
    },
    location: {
      origin: ORIGIN,
      pathname,
      href: `${ORIGIN}${pathname}`,
      assign: (target) => navigations.push(target),
    },
  };
  sandbox.window = sandbox;
  sandbox.fetch = async (url, config = {}) => {
    calls.push({ url, config });
    return respond(url, config, calls.length);
  };

  vm.createContext(sandbox);
  vm.runInContext(csrfSource, sandbox);
  vm.runInContext(guardSource, sandbox);

  return {
    fetch: (...args) => sandbox.window.fetch(...args),
    calls,
    navigations,
  };
}

const answer = (status, body, { redirectedTo = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  redirected: Boolean(redirectedTo),
  url: redirectedTo ? `${ORIGIN}${redirectedTo}` : '',
  json: async () => body,
  clone: () => ({ text: async () => JSON.stringify(body) }),
  text: async () => JSON.stringify(body),
});

const loginPage = () =>
  answer(200, '<!doctype html><title>Login</title>', {
    redirectedTo: '/login',
  });

(async () => {
  console.log('\n=== Session guard ===');

  await check(
    '1. a request redirected to /login sends the page there',
    async () => {
      const page = loadPage({ respond: loginPage });
      const response = await page.fetch('/api/settings/ocr/models', {
        method: 'POST',
      });
      assert.deepStrictEqual(page.navigations, ['/login']);
      // The caller still gets its answer; the page is leaving anyway.
      assert.strictEqual(response.status, 200);
    }
  );

  await check('2. any other answer changes nothing', async () => {
    const page = loadPage({
      respond: (url) => {
        if (url === '/api/ok') return answer(200, { success: true });
        if (url === '/api/forbidden') return answer(403, { error: 'no' });
        return answer(200, { success: true }, { redirectedTo: '/dashboard' });
      },
    });
    await page.fetch('/api/ok');
    await page.fetch('/api/forbidden', { method: 'POST' });
    await page.fetch('/api/moved');
    assert.deepStrictEqual(page.navigations, []);
  });

  await check('3. on the login page itself nothing happens', async () => {
    const page = loadPage({ pathname: '/login', respond: loginPage });
    await page.fetch('/api/anything');
    assert.deepStrictEqual(page.navigations, []);
  });

  await check('4. several requests ending at once navigate once', async () => {
    const page = loadPage({ respond: loginPage });
    await Promise.all([
      page.fetch('/api/processing-status'),
      page.fetch('/api/settings/ocr/models', { method: 'POST' }),
      page.fetch('/api/settings/ai/models', { method: 'POST' }),
    ]);
    assert.deepStrictEqual(page.navigations, ['/login']);
  });

  await check(
    '5. a CSRF retry that ends at /login sends the page there',
    async () => {
      const page = loadPage({
        respond: (url, _config, attempt) => {
          if (url === '/api/csrf-token') {
            return answer(200, { csrfToken: 'fresh' });
          }
          if (attempt === 1)
            return answer(403, { error: 'Invalid CSRF token' });
          return loginPage();
        },
      });

      await page.fetch('/api/settings/ocr/models', { method: 'POST' });

      assert.strictEqual(page.calls.length, 3, 'expected try, refresh, retry');
      assert.deepStrictEqual(page.navigations, ['/login']);
    }
  );

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll session-guard checks passed');
})();
