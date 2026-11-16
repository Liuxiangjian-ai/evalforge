/**
 * Local pipeline check: fetch real ClinicalTrials.gov records, build a
 * benchmark, and print provenance + quality diagnostics.
 *
 *   node scripts/e2e.mjs --condition "Type 2 Diabetes" --fetch 60 --per-task 8
 *
 * This script never calls a model and never writes to $DSH_HOME, so it is safe
 * to run while the Harness is open. Model evaluation happens inside the plugin.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectTrials } from '../src/host/ctgov.js';
import { generateBenchmark } from '../src/host/benchmark.js';
import { Store } from '../src/host/store.js';
import { EvalForgeEngine } from '../src/host/engine.js';
import { ModelGateway } from '../src/host/llm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      out[key] = next && !next.startsWith('--') ? next : true;
      if (out[key] !== true) i += 1;
    }
  }
  return out;
}

const options = args(process.argv.slice(2));
const condition = String(options.condition || 'Type 2 Diabetes');
const maxRecords = Number(options.fetch || 60);
const perTask = Number(options['per-task'] || 8);
const dataDir = path.resolve(root, String(options.data || 'data'));

const store = new Store(dataDir);
const gateway = new ModelGateway();
const engine = new EvalForgeEngine(null, { store, gateway, config: {} });

const log = (...values) => console.log(...values);

const run = async () => {
  log(`fetching ${maxRecords} trials for "${condition}" …`);
  const result = await collectTrials({
    condition,
    phases: ['PHASE2', 'PHASE3'],
    studyTypes: ['INTERVENTIONAL'],
    maxRecords,
  });
  log(`fetched ${result.records.length} records; registry reports ${result.stats.available} matches; ${result.stats.requests} request(s), ${result.stats.retries} retries`);
  if (result.warnings.length) log('warnings:', result.warnings);
  if (!result.records.length) throw new Error('no records fetched');
  const ingested = store.ingestTrials(result.records, result.batch);
  log('ingested:', ingested);

  const { items, rejected, stats } = generateBenchmark({
    records: result.records,
    config: { task_types: ['endpoint_selection', 'eligibility_criteria_matching'], per_task: perTask, seed: 42 },
    startId: 1,
  });
  log('generation stats:', JSON.stringify(stats, null, 2));
  log('rejected (first 12):', JSON.stringify(rejected.slice(0, 12), null, 2));

  const byTask = {};
  for (const item of items) byTask[item.task_type] = (byTask[item.task_type] || 0) + 1;
  log('items by task:', byTask);

  const sample = items[0];
  if (sample) {
    log('\n===== SAMPLE ITEM =====');
    log(JSON.stringify({
      id: sample.id,
      task_type: sample.task_type,
      query: sample.query,
      options: sample.options,
      ground_truth: sample.ground_truth,
      evidence: sample.evidence,
      quality: sample.quality,
      distractor_sources: sample.distractor_sources,
    }, null, 2));
  }

  // Persist through the engine so the CLI and the UI agree on the on-disk format.
  const generated = engine.generate({
    nct_ids: result.records.map((record) => record.nct_id),
    task_types: ['endpoint_selection', 'eligibility_criteria_matching'],
    per_task: perTask,
    seed: 42,
  });
  log(`\nbenchmark saved: ${generated.benchmark.id} (${generated.benchmark.items.length} items, hash ${generated.benchmark.hash.slice(0, 12)}…)`);
  log(`data dir: ${dataDir}`);
};

run().catch((err) => {
  console.error('FAILED', err);
  process.exitCode = 1;
});
