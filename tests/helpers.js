import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateBenchmark } from '../src/host/benchmark.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.join(here, 'fixtures', 'trials.json');

let cache = null;

/** Real, trimmed ClinicalTrials.gov records captured by scripts/make-fixtures.mjs. */
export function loadFixtures() {
  if (!cache) {
    const payload = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    cache = payload.records;
  }
  return cache;
}

export function fixture(nctId) {
  const record = loadFixtures().find((item) => item.nct_id === nctId);
  if (!record) throw new Error(`fixture ${nctId} not found`);
  return record;
}

export function generateFromFixtures(overrides = {}) {
  return generateBenchmark({
    records: loadFixtures(),
    config: {
      task_types: ['endpoint_selection', 'eligibility_criteria_matching'],
      per_task: 5,
      seed: 42,
      ...overrides,
    },
    startId: 1,
  });
}

/** A minimal run object for metric tests (clearly synthetic; metrics are pure). */
export function syntheticRun({ models = 3, items = 4 } = {}) {
  const modelSpecs = Array.from({ length: models }, (_, index) => ({
    id: `m${index + 1}`,
    label: `Model ${index + 1}`,
    model: `model-${index + 1}`,
    kind: 'native',
    provider: 'test',
  }));
  const runItems = Array.from({ length: items }, (_, index) => ({
    id: `MED-${String(index + 1).padStart(6, '0')}`,
    task_type: 'endpoint_selection',
    query: `Question ${index + 1}?`,
    options: { A: 'a', B: 'b', C: 'c', D: 'd' },
    ground_truth: { answer: 'A' },
    quality: { status: 'valid' },
  }));
  const results = [];
  runItems.forEach((item, itemIndex) => {
    modelSpecs.forEach((model, modelIndex) => {
      // Item 1: everyone right. Item 2: only model 1 right. Item 3: none right.
      const correct = itemIndex === 0 ? true : itemIndex === 1 ? modelIndex === 0 : false;
      results.push({
        cell_key: `${item.id}|${model.id}|0`,
        item_id: item.id,
        task_type: item.task_type,
        model_id: model.id,
        model_label: model.label,
        model: model.model,
        repeat: 0,
        status: 'success',
        correct,
        parsed_answer: correct ? 'A' : 'B',
        canonical_answer: correct ? 'A' : 'B',
        ground_truth: 'A',
        latency_ms: 100 + modelIndex * 50,
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        display_order: ['A', 'B', 'C', 'D'],
      });
    });
  });
  return {
    id: 'run-test',
    benchmark_id: 'bench-test',
    benchmark_name: 'Test benchmark',
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    models: modelSpecs,
    items: runItems,
    results,
    settings: { temperature: 0, maxTokens: 16, repeats: 1, concurrency: 2, retries: 0 },
    capability_groups: null,
    version_order: null,
  };
}
