import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunExecutor, cellKey, selectableItems } from '../src/host/runner.js';
import { ModelError } from '../src/host/llm.js';
import { Store } from '../src/host/store.js';
import { buildMcqPrompt } from '../src/host/prompt.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalforge-run-'));
  return new Store(dir);
}

function benchmark(items = 2) {
  return {
    id: 'bench-test',
    name: 'Runner test benchmark',
    hash: 'abc',
    items: Array.from({ length: items }, (_, index) => ({
      id: `MED-${String(index + 1).padStart(6, '0')}`,
      task_type: 'endpoint_selection',
      query: `Question ${index + 1}?`,
      options: { A: 'alpha', B: 'beta', C: 'gamma', D: 'delta' },
      ground_truth: { answer: 'A', type: 'registry_reference', source_field: 'primaryOutcomes' },
      evidence: { nct_id: `NCT0000000${index}`, source_url: 'https://clinicaltrials.gov/study/NCT00000000', source_field: 'primaryOutcomes' },
      quality: { status: 'valid', experimental: false },
      context: {},
    })),
  };
}

const models = [
  { id: 'm1', kind: 'native', label: 'Model 1', provider: 'p', model: 'model-1' },
  { id: 'm2', kind: 'native', label: 'Model 2', provider: 'p', model: 'model-2' },
  { id: 'm3', kind: 'native', label: 'Model 3', provider: 'p', model: 'model-3' },
];

function fakeGateway(handler) {
  return {
    calls: 0,
    async chat(spec, options) {
      this.calls += 1;
      return handler(spec, options, this.calls);
    },
  };
}

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timeout waiting for run');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a run plans one cell per item × model × repeat', () => {
  const store = tempStore();
  const executor = new RunExecutor({ store, gateway: fakeGateway(async () => ({ text: '答案: A', usage: {}, latency_ms: 1 })) });
  const run = executor.create({ benchmark: benchmark(3), models, settings: { repeats: 2 } });
  assert.equal(run.progress.total, 3 * 3 * 2);
  assert.equal(run.results.length, 0);
  assert.equal(run.models.length, 3);
  assert.equal(run.items.length, 3);
});

test('three models are evaluated uniformly and scored by exact match', async () => {
  const store = tempStore();
  const gateway = fakeGateway(async (spec) => ({
    text: spec.model === 'model-2' ? '答案: B' : '答案: A',
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    latency_ms: 12,
  }));
  const executor = new RunExecutor({ store, gateway });
  const created = executor.create({ benchmark: benchmark(2), models });
  executor.start(created.id);
  const done = await waitFor(async () => {
    const run = executor.get(created.id);
    return ['completed', 'completed_with_errors'].includes(run.status) ? run : null;
  });
  assert.equal(done.results.length, 6);
  assert.equal(done.progress.success, 6);
  const byModel = new Map();
  for (const cell of done.results) byModel.set(cell.model_id, (byModel.get(cell.model_id) || 0) + 1);
  assert.deepEqual([...byModel.entries()].sort(), [['m1', 2], ['m2', 2], ['m3', 2]]);
  const m1 = done.results.filter((cell) => cell.model_id === 'm1');
  const m2 = done.results.filter((cell) => cell.model_id === 'm2');
  assert.ok(m1.every((cell) => cell.correct === true));
  assert.ok(m2.every((cell) => cell.correct === false));
  assert.equal(m2[0].cell_key, cellKey('MED-000001', 'm2', 0));
});

test('an API failure is recorded as an error cell, never as a wrong answer', async () => {
  const store = tempStore();
  const gateway = fakeGateway(async () => {
    throw new ModelError('rate limited', { code: 'RATE_LIMIT', retryable: false });
  });
  const executor = new RunExecutor({ store, gateway });
  const created = executor.create({ benchmark: benchmark(1), models: [models[0]], settings: { retries: 2 } });
  executor.start(created.id);
  const done = await waitFor(async () => {
    const run = executor.get(created.id);
    return ['completed', 'completed_with_errors'].includes(run.status) ? run : null;
  });
  assert.equal(done.status, 'completed_with_errors');
  assert.equal(done.results[0].status, 'error');
  assert.equal(done.results[0].correct, null);
  assert.equal(done.results[0].error.code, 'RATE_LIMIT');
  assert.equal(done.progress.error, 1);
});

test('retryable failures are retried before being reported', async () => {
  const store = tempStore();
  let attempts = 0;
  const gateway = fakeGateway(async () => {
    attempts += 1;
    if (attempts === 1) throw new ModelError('temporary', { code: 'SERVER', retryable: true });
    return { text: '答案: A', usage: {}, latency_ms: 5 };
  });
  const executor = new RunExecutor({ store, gateway });
  const created = executor.create({ benchmark: benchmark(1), models: [models[0]], settings: { retries: 2 } });
  executor.start(created.id);
  const done = await waitFor(async () => {
    const run = executor.get(created.id);
    return ['completed', 'completed_with_errors'].includes(run.status) ? run : null;
  });
  assert.equal(attempts, 2);
  assert.equal(done.results[0].status, 'success');
  assert.equal(done.results[0].attempts, 2);
});

test('an unparsable reply is not scored as a wrong answer', async () => {
  const store = tempStore();
  const gateway = fakeGateway(async () => ({ text: 'I would need more context.', usage: {}, latency_ms: 3 }));
  const executor = new RunExecutor({ store, gateway });
  const created = executor.create({ benchmark: benchmark(1), models: [models[0]] });
  executor.start(created.id);
  const done = await waitFor(async () => {
    const run = executor.get(created.id);
    return ['completed', 'completed_with_errors'].includes(run.status) ? run : null;
  });
  assert.equal(done.results[0].status, 'parse_failed');
  assert.equal(done.results[0].correct, null);
  assert.equal(done.progress.parse_failed, 1);
  assert.equal(done.progress.success, 0);
});

test('shuffled repeats present different option orders and still score correctly', async () => {
  const store = tempStore();
  const orders = [];
  const gateway = fakeGateway(async (spec, options) => {
    orders.push(options.messages[1].content);
    return { text: '答案: A', usage: {}, latency_ms: 4 };
  });
  const executor = new RunExecutor({ store, gateway });
  const created = executor.create({ benchmark: benchmark(1), models: [models[0]], settings: { repeats: 3, shuffle_options: true } });
  executor.start(created.id);
  const done = await waitFor(async () => {
    const run = executor.get(created.id);
    return ['completed', 'completed_with_errors'].includes(run.status) ? run : null;
  });
  const signatures = new Set(done.results.map((cell) => JSON.stringify(cell.display_order)));
  assert.ok(signatures.size >= 2, 'repeats must not all use the same option order');
  // The model always answers the first displayed label, so canonical answers differ.
  for (const cell of done.results) {
    assert.equal(cell.correct, cell.canonical_answer === 'A');
  }
  assert.equal(done.results.length, 3);
});

test('cancelling a run stops it and marks it cancelled', async () => {
  const store = tempStore();
  const gateway = fakeGateway(() => new Promise(() => {}));
  const executor = new RunExecutor({ store, gateway });
  const created = executor.create({ benchmark: benchmark(2), models: [models[0]], settings: { timeoutMs: 60000 } });
  executor.start(created.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelled = executor.cancel(created.id);
  assert.equal(cancelled.cancel_requested, true);
  const done = await waitFor(async () => {
    const run = executor.get(created.id);
    return run.status === 'cancelled' ? run : null;
  });
  assert.equal(done.status, 'cancelled');
});

test('resume skips finished cells and retries failed ones', async () => {
  const store = tempStore();
  let fail = true;
  const gateway = fakeGateway(async () => {
    if (fail) throw new ModelError('boom', { code: 'SERVER', retryable: false });
    return { text: '答案: A', usage: {}, latency_ms: 1 };
  });
  const executor = new RunExecutor({ store, gateway });
  const created = executor.create({ benchmark: benchmark(1), models: [models[0]], settings: { retries: 0 } });
  executor.start(created.id);
  const first = await waitFor(async () => {
    const run = executor.get(created.id);
    return ['completed', 'completed_with_errors'].includes(run.status) ? run : null;
  });
  assert.equal(first.progress.error, 1);

  fail = false;
  executor.resume(created.id, { retryFailed: true });
  const second = await waitFor(async () => {
    const run = executor.get(created.id);
    return ['completed', 'completed_with_errors'].includes(run.status) && !executor.active.has(created.id) ? run : null;
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.results.length, 1);
  assert.equal(second.results[0].status, 'success');
});

test('the quality policy excludes experimental items unless asked', () => {
  const items = [
    { id: 'a', quality: { status: 'valid', experimental: false } },
    { id: 'b', quality: { status: 'valid', experimental: true } },
    { id: 'c', quality: { status: 'needs_review', experimental: false } },
  ];
  assert.deepEqual(selectableItems(items, {}).map((item) => item.id), ['a']);
  assert.deepEqual(selectableItems(items, { include_experimental: true }).map((item) => item.id), ['a', 'b']);
  assert.deepEqual(selectableItems(items, { include_needs_review: true }).map((item) => item.id), ['a', 'c']);
});

test('prompt rendering is stable for identical inputs', () => {
  const item = benchmark(1).items[0];
  const a = buildMcqPrompt(item, { shuffle: true, seed: 'repeat-0' });
  const b = buildMcqPrompt(item, { shuffle: true, seed: 'repeat-0' });
  const c = buildMcqPrompt(item, { shuffle: true, seed: 'repeat-1' });
  assert.equal(a.prompt_sha256, b.prompt_sha256);
  assert.notEqual(a.prompt_sha256, c.prompt_sha256);
});
