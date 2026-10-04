const assert = require('assert');

const configModulePath = require.resolve('../config/config');
const paperlessServiceModulePath =
  require.resolve('../services/paperlessService');
const documentModelModulePath = require.resolve('../models/document');
const aiServiceFactoryModulePath =
  require.resolve('../services/aiServiceFactory');
const mistralOcrServiceModulePath =
  require.resolve('../services/mistralOcrService');
const documentProcessingServiceModulePath =
  require.resolve('../services/documentProcessingService');
const dashboardStatsServiceModulePath =
  require.resolve('../services/dashboardStatsService');

function loadMistralServiceWithMocks() {
  delete require.cache[configModulePath];
  delete require.cache[paperlessServiceModulePath];
  delete require.cache[documentModelModulePath];
  delete require.cache[aiServiceFactoryModulePath];
  delete require.cache[mistralOcrServiceModulePath];
  delete require.cache[documentProcessingServiceModulePath];
  delete require.cache[dashboardStatsServiceModulePath];

  const state = {
    saveOriginalCalled: false,
    addProcessedCalled: false,
    addMetricsCalled: false,
    addHistoryCalled: false,
  };

  const paperlessServiceMock = {
    getTags: async () => [],
    listCorrespondentsNames: async () => [],
    listDocumentTypesNames: async () => [],
    getDocument: async () => ({ title: 'Original', created: '2026-06-05' }),
    processTags: async () => ({ tagIds: [], errors: [] }),
    getOrCreateDocumentType: async () => null,
    getOrCreateCorrespondent: async () => null,
    updateDocument: async () => null,
  };

  const documentModelMock = {
    saveOriginalData: async () => {
      state.saveOriginalCalled = true;
      return true;
    },
    addProcessedDocument: async () => {
      state.addProcessedCalled = true;
      return true;
    },
    addOpenAIMetrics: async () => {
      state.addMetricsCalled = true;
      return true;
    },
    addToHistory: async () => {
      state.addHistoryCalled = true;
      return true;
    },
  };

  const aiServiceFactoryMock = {
    getService: () => ({
      analyzeDocument: async () => ({
        document: {
          tags: [],
          title: 'AI Title',
          document_date: '2026-06-04',
          document_type: null,
          correspondent: null,
          language: 'en',
        },
        metrics: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
        },
      }),
    }),
  };

  require.cache[paperlessServiceModulePath] = {
    id: paperlessServiceModulePath,
    filename: paperlessServiceModulePath,
    loaded: true,
    exports: paperlessServiceMock,
  };
  require.cache[documentModelModulePath] = {
    id: documentModelModulePath,
    filename: documentModelModulePath,
    loaded: true,
    exports: documentModelMock,
  };
  require.cache[aiServiceFactoryModulePath] = {
    id: aiServiceFactoryModulePath,
    filename: aiServiceFactoryModulePath,
    loaded: true,
    exports: aiServiceFactoryMock,
  };

  const mistralOcrService = require('../services/mistralOcrService');
  return { mistralOcrService, state };
}

async function main() {
  const { mistralOcrService, state } = loadMistralServiceWithMocks();

  let threw = false;
  try {
    await mistralOcrService._runAiAnalysis(1952, 'OCR content');
  } catch (error) {
    threw = true;
    assert.ok(
      error.message.includes('Paperless update failed for document 1952'),
      'Expected update failure to bubble up'
    );
  }

  assert.strictEqual(
    threw,
    true,
    'Expected _runAiAnalysis to fail when Paperless update fails'
  );
  assert.strictEqual(
    state.addProcessedCalled,
    false,
    'Must not mark processed when Paperless update fails'
  );
  assert.strictEqual(
    state.addMetricsCalled,
    false,
    'Must not persist metrics when Paperless update fails'
  );
  assert.strictEqual(
    state.addHistoryCalled,
    false,
    'Must not add history when Paperless update fails'
  );
  assert.strictEqual(
    state.saveOriginalCalled,
    true,
    'The pre-AI snapshot is saved before the update, so the document stays restorable'
  );
}

main()
  .then(() => {
    console.log(
      '[PASS] OCR AI flow does not persist processed/history/metrics when Paperless update fails'
    );
  })
  .catch((error) => {
    console.error(
      '[FAIL] OCR no-processed-on-update-failure test failed:',
      error.message
    );
    process.exitCode = 1;
  });
