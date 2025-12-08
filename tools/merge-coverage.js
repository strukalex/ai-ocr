/* Merge per-project Jest coverage into a single summary and lcov.
 *
 * Outputs:
 * - coverage/combined/coverage-summary.json
 * - coverage/combined/lcov.info
 *
 * This script is dependency-free (Node stdlib only).
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const coverageRoot = path.join(root, 'coverage');
const combinedDir = path.join(coverageRoot, 'combined');

function walk(dir, matcher) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full, matcher));
    } else if (matcher(full)) {
      results.push(full);
    }
  }
  return results;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function mergeSummaries(summaryPaths) {
  const totals = {
    lines: { total: 0, covered: 0 },
    statements: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
  };

  for (const file of summaryPaths) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const total = json.total;
    for (const key of Object.keys(totals)) {
      if (!total[key]) continue;
      totals[key].total += total[key].total ?? 0;
      totals[key].covered += total[key].covered ?? 0;
    }
  }

  const result = { total: {} };
  for (const [key, val] of Object.entries(totals)) {
    const pct = val.total === 0 ? 100 : (val.covered / val.total) * 100;
    result.total[key] = {
      total: val.total,
      covered: val.covered,
      skipped: 0,
      pct: Number(pct.toFixed(2)),
    };
  }
  return result;
}

function mergeLcov(lcovPaths) {
  return lcovPaths.map((p) => fs.readFileSync(p, 'utf8').trim()).join('\n');
}

function main() {
  if (!fs.existsSync(coverageRoot)) {
    console.error('No coverage directory found. Run test:coverage first.');
    process.exit(1);
  }

  const summaryPaths = walk(coverageRoot, (f) => f.endsWith('coverage-summary.json'));
  const lcovPaths = walk(coverageRoot, (f) => f.endsWith('lcov.info'));

  if (summaryPaths.length === 0 || lcovPaths.length === 0) {
    console.error('No coverage summaries or lcov files found. Run test:coverage first.');
    process.exit(1);
  }

  ensureDir(combinedDir);

  const combinedSummary = mergeSummaries(summaryPaths);
  fs.writeFileSync(
    path.join(combinedDir, 'coverage-summary.json'),
    JSON.stringify(combinedSummary, null, 2),
    'utf8',
  );

  const combinedLcov = mergeLcov(lcovPaths);
  fs.writeFileSync(path.join(combinedDir, 'lcov.info'), combinedLcov, 'utf8');

  console.log(`Merged ${summaryPaths.length} summaries and ${lcovPaths.length} lcov files into ${combinedDir}`);
}

main();
