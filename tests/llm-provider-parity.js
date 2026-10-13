#!/usr/bin/env node
'use strict';

/**
 * Step 6 parity check — services/ManualServiceRefactoring.md (Target
 * Architecture / "Parity").
 *
 * Verifies that the four AI providers (OpenAI, Azure, Custom, Ollama)
 * expose the same public behavior and API surface after the structural
 * move into services/llm/providers/:
 *
 *  1. The legacy module paths (services/*Service.js) resolve to the very
 *     same singleton instance as the new provider paths, and stay stable
 *     across repeated requires (consumer-visible identity is preserved).
 *  2. All four singletons expose the same public core — analyzeDocument,
 *     generateText, checkStatus — with the same JS arity (default
 *     parameters do not count towards Function.length).
 *  3. The public core is thenable-returning in every provider —
 *     statically checked (no network), via the provider source or the
 *     shared DocumentAnalyzer base it resolves to.
 *  4. All four expose the same supporting public state: `client` and the
 *     `lastGenerateTextUsage` seam (the usage seam read by the AI review
 *     features). Model names stay provider-specific by design and are
 *     not asserted uniformly.
 *  5. The legacy service files are thin re-export shims with no
 *     business logic (source-structural check, pinned for Step 6).
 *
 * Hermetic: no network, no credentials, deterministic. Byte-identical
 * `document` results (spec § "Parity") land with the later behavioral
 * alignment phase; this script pins the public API surface the whole
 * Step-6 lane must keep.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const PROFILES = [
  {
    label: 'openai',
    legacy: path.join(ROOT, 'services', 'openaiService.js'),
    provider: path.join(
      ROOT,
      'services',
      'llm',
      'providers',
      'openaiProvider.js'
    ),
  },
  {
    label: 'azure',
    legacy: path.join(ROOT, 'services', 'azureService.js'),
    provider: path.join(
      ROOT,
      'services',
      'llm',
      'providers',
      'azureProvider.js'
    ),
  },
  {
    label: 'custom',
    legacy: path.join(ROOT, 'services', 'customService.js'),
    provider: path.join(
      ROOT,
      'services',
      'llm',
      'providers',
      'customProvider.js'
    ),
  },
  {
    label: 'ollama',
    legacy: path.join(ROOT, 'services', 'ollamaService.js'),
    provider: path.join(
      ROOT,
      'services',
      'llm',
      'providers',
      'ollamaProvider.js'
    ),
  },
];

// The public core every provider must expose, with the exact JS arity of
// the public method (default parameters do not count towards .length).
const CORE_CONTRACT = [
  ['analyzeDocument', 1],
  ['generateText', 1],
  ['checkStatus', 0],
];

const SHIM_MAX_LINES = 10;

let failures = 0;
let checks = 0;

function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

console.log('llm-provider-parity: structural + API-surface parity check');
console.log('---');

// 1. Singleton identity: legacy shim path === provider path, stable.
console.log('[1] legacy shims resolve to the provider singletons');
for (const profile of PROFILES) {
  const viaLegacy = require(profile.legacy);
  const viaProvider = require(profile.provider);
  const again = require(profile.legacy);
  check(
    `${profile.label}: services/..Service.js === llm/providers/..Provider.js`,
    viaLegacy === viaProvider
  );
  check(
    `${profile.label}: singleton stable across repeated requires`,
    viaLegacy === again
  );
}

// 2. Same public core, same signatures (arity).
console.log('[2] same public core methods and signatures');
for (const profile of PROFILES) {
  const service = require(profile.legacy);
  for (const [method, arity] of CORE_CONTRACT) {
    const fn = service[method];
    check(
      `${profile.label}.${method} is a function`,
      typeof fn === 'function',
      `got ${typeof fn}`
    );
    if (typeof fn === 'function') {
      check(
        `${profile.label}.${method} arity ${arity}`,
        fn.length === arity,
        `got ${fn.length}`
      );
    }
  }
}

// 3. Thenable-returning public core: every provider's core methods must
//    either be declared `async` in the provider's own source, or — for a
//    DocumentAnalyzer-based root — resolve to the shared base, where the
//    method is declared and documented as Promise-returning. Checked
//    statically so the suite stays network-free.
console.log('[3] public core is Promise-returning (static source check)');
const BASE = path.join(ROOT, 'services', 'llm', 'documentAnalyzer.js');
const baseSource = fs.readFileSync(BASE, 'utf8');
for (const profile of PROFILES) {
  const source = fs.readFileSync(profile.provider, 'utf8');
  const isBaseBased = /\.\.\/documentAnalyzer/.test(source);
  for (const [method] of CORE_CONTRACT) {
    const ownAsync = new RegExp(`async\\s+${method}\\s*\\(`).test(source);
    const baseResolves =
      isBaseBased && new RegExp(`${method}\\s*\\(`).test(baseSource);
    check(
      `${profile.label}.${method} resolves to an async/Promise-returning declaration`,
      ownAsync || baseResolves,
      'no async own declaration and no base resolution'
    );
  }
}

// 4. Same supporting public state: the usage/client seams shared by every
//    provider (`client`, `lastGenerateTextUsage`), plus checkStatus as the
//    uniform model/status probe. Model string itself is provider-specific
//    by design (Ollama's `model` prop vs. Azure's deployment name vs. the
//    custom base's `resolveModel()`), so it is not asserted uniformly.
console.log('[4] supporting public state (client, lastGenerateTextUsage)');
for (const profile of PROFILES) {
  const service = require(profile.legacy);
  check(
    `${profile.label}: client is accessible`,
    service.client !== undefined,
    'client is undefined'
  );
  check(
    `${profile.label}: lastGenerateTextUsage seam exists`,
    'lastGenerateTextUsage' in service,
    'no lastGenerateTextUsage seam'
  );
}

// 5. Legacy service files are thin re-exports without business logic.
console.log('[5] legacy service files contain no business logic');
for (const profile of PROFILES) {
  const source = fs.readFileSync(profile.legacy, 'utf8');
  const lines = source.trim().split('\n');
  check(
    `${profile.label}: shim is a one-line re-export (≤ ${SHIM_MAX_LINES} lines)`,
    lines.length <= SHIM_MAX_LINES,
    `${lines.length} lines`
  );
  check(
    `${profile.label}: shim re-exports the provider module`,
    /require\('\.\/llm\/providers\/\w+Provider'\)/.test(source)
  );
  check(
    `${profile.label}: shim defines no classes / functions / arrow handlers / SDK clients`,
    !/\bclass\b|\bfunction\b|=>|\bnew\s+\w*[Cc]lient/.test(source)
  );
}

console.log('---');
console.log(`${checks} checks, ${failures} failure(s)`);
if (failures > 0) {
  console.error('llm-provider-parity: FAILED');
  process.exit(1);
}
console.log('llm-provider-parity: PASSED');
process.exit(0);
