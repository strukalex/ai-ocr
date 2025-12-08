const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,
  // Ensure consistent coverage outputs for all projects
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary', 'html'],
};
