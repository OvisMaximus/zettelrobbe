const fs = require('fs');
const path = require('path');

function assertIncludes(content, snippet, message) {
  if (!content.includes(snippet)) {
    throw new Error(message);
  }
}

function assertNotIncludes(content, snippet, message) {
  if (content.includes(snippet)) {
    throw new Error(message);
  }
}

// Whitespace-tolerant so the check survives Prettier reflowing a long
// path.join(...) call across multiple lines.
function assertMatches(content, regex, message) {
  if (!regex.test(content)) {
    throw new Error(message);
  }
}

function run() {
  console.log('\n=== Native Install Log Path Checks ===');

  // Step-6 structural relocation: services/{custom,azure}Service.js are now
  // one-line re-export shims over services/llm/providers/*; the response-log
  // path built here moved with the business logic into the composition roots,
  // so this guard sniffs the new locations (same invariant: cwd-relative, no
  // hardcoded '/app').
  const filesUsingResponseLogPath = [
    'services/llm/documentAnalyzer.js',
    'services/llm/providers/customProvider.js',
    'services/llm/providers/azureProvider.js',
  ];

  filesUsingResponseLogPath.forEach((relativePath) => {
    const fullPath = path.join(process.cwd(), relativePath);
    const content = fs.readFileSync(fullPath, 'utf8');

    assertNotIncludes(
      content,
      "path.join('/app'",
      `${relativePath} must not hardcode the Docker '/app' path for AI response logging`
    );
    assertMatches(
      content,
      /path\.join\(\s*process\.cwd\(\)/,
      `${relativePath} must resolve the AI response log path relative to process.cwd()`
    );
  });

  const serviceUtilsPath = path.join(
    process.cwd(),
    'services',
    'serviceUtils.js'
  );
  const serviceUtilsContent = fs.readFileSync(serviceUtilsPath, 'utf8');

  assertNotIncludes(
    serviceUtilsContent,
    "'/app/data/logs/prompt.txt'",
    "serviceUtils.js's writePromptToFile() must not default to a hardcoded '/app' path"
  );
  assertIncludes(
    serviceUtilsContent,
    "path.join(process.cwd(), 'data', 'logs', 'prompt.txt')",
    "serviceUtils.js's writePromptToFile() must default to a process.cwd()-relative prompt log path"
  );

  console.log('✅ All native install log path checks passed');
}

run();
console.log('✅ test-native-install-log-paths passed');
