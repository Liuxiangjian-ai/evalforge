import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMcqPrompt } from '../src/host/prompt.js';
import { selectableItems, scoreResponse } from '../src/host/runner.js';
import { buildMetaEvaluation, macroF1 } from '../src/host/metrics.js';
import { generateFromFixtures, syntheticRun } from './helpers.js';

const item = {
  id: 'MED-000001',
  query: 'Which endpoint was registered?',
  options: { A: 'alpha outcome', B: 'beta outcome', C: 'gamma outcome', D: 'delta outcome' },
  ground_truth: { answer: 'B' },
};

test('scoreResponse maps a displayed label back to the canonical label', () => {
  const optionMap = { A: 'C', B: 'A', C: 'B', D: 'D' };
  assert.equal(scoreResponse(item, 'C', optionMap).canonical_label, 'B');
  assert.equal(scoreResponse(item, 'C', optionMap).correct, true);
  assert.equal(scoreResponse(item, 'A', optionMap).correct, false);
});

test('prompt rendering keeps the option map consistent with the displayed text', () => {
  for (const seed of ['repeat-0', 'repeat-1', 'repeat-2']) {
    const prompt = buildMcqPrompt(item, { shuffle: true, seed });
    assert.equal(Object.keys(prompt.option_map).length, 4);
    assert.equal(new Set(Object.values(prompt.option_map)).size, 4, 'every canonical option appears once');
    for (const [displayed, original] of Object.entries(prompt.option_map)) {
      assert.ok(prompt.messages[1].content.includes(`${displayed}. ${item.options[original]}`));
    }
    assert.ok(prompt.prompt_sha256.length === 64);
  }
});

test('prompt rendering without shuffling keeps A→A order', () => {
  const prompt = buildMcqPrompt(item, {});
  assert.deepEqual(prompt.option_map, { A: 'A', B: 'B', C: 'C', D: 'D' });
  assert.ok(prompt.messages[1].content.includes('A. alpha outcome'));
});

test('selectableItems enforces the quality policy', () => {
  const items = [
    { id: 'a', quality: { status: 'valid', experimental: false } },
    { id: 'b', quality: { status: 'needs_review', experimental: false } },
    { id: 'c', quality: { status: 'invalid', experimental: false } },
    { id: 'd', quality: { status: 'valid', experimental: true } },
  ];
  assert.deepEqual(selectableItems(items, {}).map((entry) => entry.id), ['a']);
  assert.deepEqual(selectableItems(items, { include_needs_review: true }).map((entry) => entry.id), ['a', 'b']);
  assert.deepEqual(selectableItems(items, { include_needs_review: true, include_invalid: true, include_experimental: true }).map((entry) => entry.id), ['a', 'b', 'c', 'd']);
});

test('generated items are all selected by default when valid', () => {
  const { items } = generateFromFixtures();
  const selected = selectableItems(items, {});
  assert.ok(selected.length > 0);
  assert.ok(selected.every((entry) => entry.quality.status === 'valid'));
});

test('macroF1 averages per-label F1 over predicted and true labels', () => {
  const cells = [
    { ground_truth: 'A', canonical_answer: 'A' },
    { ground_truth: 'A', canonical_answer: 'B' },
    { ground_truth: 'B', canonical_answer: 'B' },
    { ground_truth: 'B', canonical_answer: 'B' },
  ];
  const result = macroF1(cells);
  assert.ok(result.macro_f1 > 0.6 && result.macro_f1 <= 1);
  assert.equal(result.per_label.A.support, 2);
});

test('meta-evaluation computes accuracy, difficulty and exploratory discrimination', () => {
  const run = syntheticRun({ models: 3, items: 4 });
  const meta = buildMetaEvaluation(run);
  assert.equal(meta.sample.cells, 12);
  assert.equal(meta.sample.scored, 12);
  const byId = Object.fromEntries(meta.models.map((row) => [row.model_id, row]));
  assert.equal(byId.m1.accuracy, 0.5);
  assert.equal(byId.m2.accuracy, 0.25);
  const difficulty = Object.fromEntries(meta.difficulty.map((row) => [row.item_id, row]));
  assert.equal(difficulty['MED-000001'].p_correct, 1);
  assert.equal(difficulty['MED-000001'].difficulty, 0);
  assert.equal(difficulty['MED-000003'].p_correct, 0);
  assert.equal(difficulty['MED-000003'].difficulty, 1);
  assert.equal(meta.discrimination_mode, 'exploratory');
  assert.ok(meta.notes.some((note) => /exploratory/i.test(note)));
});

test('declared capability groups switch discrimination to the formal mode', () => {
  const run = syntheticRun({ models: 3, items: 3 });
  run.capability_groups = { high: ['m1'], low: ['m3'] };
  const meta = buildMetaEvaluation(run);
  assert.equal(meta.discrimination_mode, 'declared');
  const item2 = meta.discrimination.find((row) => row.item_id === 'MED-000002');
  assert.equal(item2.p_high, 1);
  assert.equal(item2.p_low, 0);
  assert.equal(item2.d, 1);
});

test('api failures are excluded from accuracy but reported separately', () => {
  const run = syntheticRun({ models: 2, items: 2 });
  run.results.push({
    cell_key: 'MED-000001|m1|1',
    item_id: 'MED-000001',
    task_type: 'endpoint_selection',
    model_id: 'm1',
    model_label: 'Model 1',
    model: 'model-1',
    repeat: 1,
    status: 'error',
    correct: null,
    error: { code: 'RATE_LIMIT', message: 'too many requests' },
    usage: { total_tokens: 0 },
  });
  const meta = buildMetaEvaluation(run);
  assert.equal(meta.sample.failures, 1);
  assert.equal(meta.sample.scored, 4);
  const m1 = meta.models.find((row) => row.model_id === 'm1');
  assert.equal(m1.accuracy, 1, 'the failed call must not count as a wrong answer');
  assert.equal(m1.scored, 2);
  assert.equal(m1.failures, 1);
  assert.ok(meta.failures.some((row) => row.code === 'RATE_LIMIT'));
});

test('version monotonicity is descriptive and reports a rank correlation', () => {
  const run = syntheticRun({ models: 3, items: 3 });
  run.version_order = ['m3', 'm2', 'm1'];
  const meta = buildMetaEvaluation(run);
  assert.equal(meta.monotonicity.status, 'descriptive');
  assert.ok(meta.monotonicity.rho > 0.5);
  assert.ok(/hypothesis|descriptive|not evidence/i.test(`${meta.monotonicity.reason} ${meta.notes.join(' ')}`));
});

test('stability reports repeat consistency and option-order effects', () => {
  const run = syntheticRun({ models: 1, items: 1 });
  run.settings.repeats = 3;
  run.results = [];
  const orders = [['A', 'B', 'C', 'D'], ['B', 'A', 'D', 'C'], ['C', 'D', 'A', 'B']];
  orders.forEach((order, repeat) => {
    run.results.push({
      cell_key: `MED-000001|m1|${repeat}`,
      item_id: 'MED-000001',
      task_type: 'endpoint_selection',
      model_id: 'm1',
      model_label: 'Model 1',
      model: 'model-1',
      repeat,
      status: 'success',
      correct: repeat !== 2,
      parsed_answer: repeat === 2 ? 'B' : 'A',
      canonical_answer: repeat === 2 ? 'B' : 'A',
      ground_truth: 'A',
      latency_ms: 100,
      usage: { total_tokens: 10 },
      display_order: order,
    });
  });
  const meta = buildMetaEvaluation(run);
  assert.equal(meta.stability.length, 1);
  const row = meta.stability[0];
  assert.ok(row.consistency > 0.5 && row.consistency <= 1);
  assert.equal(row.correct_rate_fluctuation, 1);
  assert.equal(row.order_variants, 3);
  assert.ok(row.order_effect >= 0);
});
