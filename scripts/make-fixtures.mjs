/**
 * Build test fixtures from *real* ClinicalTrials.gov records.
 *
 * Fixtures are trimmed real registry records (raw payload reduced to the
 * modules the tests exercise). They are inputs for unit tests only — no test
 * asserts benchmark or evaluation results from them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectTrials } from '../src/host/ctgov.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'tests', 'fixtures', 'trials.json');

const trim = (study) => ({
  protocolSection: {
    identificationModule: study.protocolSection.identificationModule,
    statusModule: study.protocolSection.statusModule,
    descriptionModule: study.protocolSection.descriptionModule,
    conditionsModule: study.protocolSection.conditionsModule,
    designModule: study.protocolSection.designModule,
    armsInterventionsModule: study.protocolSection.armsInterventionsModule,
    outcomesModule: study.protocolSection.outcomesModule,
    eligibilityModule: study.protocolSection.eligibilityModule,
  },
  hasResults: study.hasResults,
});

const main = async () => {
  const wanted = [];
  for (const query of [
    { condition: 'Type 2 Diabetes', phases: ['PHASE3'], maxRecords: 6 },
    { condition: 'Hypertension', phases: ['PHASE2', 'PHASE3'], statuses: ['COMPLETED', 'TERMINATED'], maxRecords: 6 },
  ]) {
    const result = await collectTrials({ studyTypes: ['INTERVENTIONAL'], ...query });
    for (const record of result.records) {
      wanted.push({
        ...record,
        raw: trim(record.raw),
      });
    }
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    generated_from: 'ClinicalTrials.gov API v2',
    note: 'Trimmed real registry records; test inputs only.',
    fetched_at: new Date().toISOString(),
    records: wanted,
  }, null, 2));
  console.log(`wrote ${wanted.length} fixtures (${(fs.statSync(outFile).size / 1024).toFixed(0)} KiB) to ${outFile}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
