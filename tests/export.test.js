import assert from 'node:assert/strict';
import test from 'node:test';

import { benchmarkJsonl, buildMarkdownReport, reportFilenames, toCsv } from '../src/host/report.js';
import { buildMetaEvaluation } from '../src/host/metrics.js';
import { syntheticRun } from './helpers.js';

function sampleRun() {
  const run = syntheticRun({ models: 2, items: 2 });
  run.status = 'completed';
  run.settings.repeats = 1;
  return run;
}

test('CSV export has a stable header and quotes unsafe cells', () => {
  const run = sampleRun();
  run.results[0].response_text = '答案: A, because "alpha" was registered.\nsecond line';
  const csv = toCsv(run);
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].startsWith('run_id,question_id,task_type,model_id'));
  assert.ok(csv.includes('"答案: A, because ""alpha"" was registered.\nsecond line"'));
  // Every cell is present: header + one physical line per cell, plus the wrapped line.
  assert.equal(lines.length - 1, run.results.length + 1);
});

test('CSV records failures as blank correctness, never as wrong answers', () => {
  const run = sampleRun();
  run.results[0].status = 'error';
  run.results[0].correct = null;
  run.results[0].error = { code: 'RATE_LIMIT', message: 'slow down' };
  const csv = toCsv(run);
  const row = csv.split('\n')[1].split(',');
  const correctIndex = csv.split('\n')[0].split(',').indexOf('correct');
  assert.equal(row[correctIndex], '');
  assert.ok(csv.includes('RATE_LIMIT'));
});

test('benchmark JSONL round-trips to valid objects with evidence', () => {
  const benchmark = {
    id: 'bench-1',
    version: '0.1.0',
    items: [
      {
        id: 'MED-000001',
        task_type: 'endpoint_selection',
        query: 'Q?',
        options: { A: 'a', B: 'b', C: 'c', D: 'd' },
        ground_truth: { answer: 'B', type: 'registry_reference', source_field: 'primaryOutcomes' },
        rubric: { type: 'exact_match', max_score: 1 },
        evidence: { nct_id: 'NCT12345678', source_url: 'https://clinicaltrials.gov/study/NCT12345678', original_text: 'b', record_version: '2026-01-01' },
        quality: { status: 'valid', source_verified: true, unique_answer: true, expert_reviewed: false, temporal_validation_required: false },
        distractor_sources: [],
        context: {},
        prompt_version: 'evalforge-mcq-v1',
      },
    ],
  };
  const lines = benchmarkJsonl(benchmark).trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.id, 'MED-000001');
  assert.equal(parsed.evidence.nct_id, 'NCT12345678');
  assert.equal(parsed.ground_truth.source_field, 'primaryOutcomes');
});

test('markdown report includes provenance, results, limitations and sample size', () => {
  const run = sampleRun();
  const benchmark = {
    id: run.benchmark_id,
    name: run.benchmark_name,
    benchmark_schema_version: '0.1.0',
    source_summary: {
      registry: 'ClinicalTrials.gov API v2',
      conditions: ['Type 2 Diabetes'],
      trials: 40,
      used_trials: 12,
      fetched_at: '2026-11-14T12:00:00.000Z',
      id_range: 'MED-000001 … MED-000010',
    },
    items: run.items,
  };
  const meta = buildMetaEvaluation(run);
  const markdown = buildMarkdownReport({ run, benchmark, meta });
  for (const heading of [
    '# EvalForge',
    '## 1. Data source and provenance',
    '## 2. Generation method',
    '## 3. Benchmark composition',
    '## 4. Models',
    '## 5. Scoring',
    '## 6. Item difficulty',
    '## 7. Discrimination and stability',
    '## 9. Failures and limitations',
    '## 10. Reproducibility',
  ]) {
    assert.ok(markdown.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(markdown.includes('Sample size: 2 items × 2 models'));
  assert.ok(markdown.includes('ClinicalTrials.gov'));
  assert.ok(markdown.includes('historical trial design practice'));
});

test('report filenames match the documented export contract', () => {
  assert.deepEqual(reportFilenames('run-1'), {
    benchmark: 'benchmark.jsonl',
    csv: 'eval_results.csv',
    json: 'eval_results.json',
    markdown: 'meta_eval_report.md',
  });
});
