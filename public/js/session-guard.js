/**
 * Sends the browser to the login page once a request finds the session gone.
 *
 * Every signed-in route answers a missing or expired session with a redirect
 * to /login, and fetch follows redirects silently: the caller receives the
 * login page with status 200, fails to read it as JSON and reports something
 * generic such as "Model discovery failed". The page itself kept looking
 * signed in, so every further action failed the same way and nothing pointed
 * at the session.
 *
 * Loaded in <head> right after csrf.js, so it wraps that patch and sees a
 * request's final answer, after any CSRF token retry.
 */
(function () {
  'use strict';

  const LOGIN_PATH = '/login';
  const innerFetch = window.fetch;
  let leaving = false;

  function endedAtLogin(response) {
    if (!response?.redirected || !response.url) return false;
    try {
      const target = new URL(response.url, window.location.href);
      return (
        target.origin === window.location.origin &&
        target.pathname === LOGIN_PATH
      );
    } catch {
      return false;
    }
  }

  window.fetch = async (...args) => {
    const response = await innerFetch(...args);

    if (
      !leaving &&
      window.location.pathname !== LOGIN_PATH &&
      endedAtLogin(response)
    ) {
      leaving = true;
      window.location.assign(LOGIN_PATH);
    }

    return response;
  };
})();
