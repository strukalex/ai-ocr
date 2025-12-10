const path = require('path');
const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,
  setupFilesAfterEnv: [
    ...(nxPreset.setupFilesAfterEnv ?? []),
    path.join(__dirname, 'jest.setup.ts'),
  ],
  // Ensure consistent coverage outputs for all projects
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary', 'html'],
};
