import assert from 'node:assert/strict';
import test from 'node:test';

import { runQualityChecks } from '../src/host/qc.js';
import { generateFromFixtures, loadFixtures } from './helpers.js';

function firstItem(taskType = 'endpoint_selection') {
  const { items } = generateFromFixtures({ task_types: [taskType], per_task: 3 });
  assert.ok(items.length > 0, `no ${taskType} item generated`);
  return structuredClone(items[0]);
}

function recordFor(item) {
  return loadFixtures().find((record) => record.nct_id === item.evidence.nct_id);
}

test('a freshly generated item passes every deterministic check', () => {
  const item = firstItem();
  const qc = runQualityChecks(item, recordFor(item));
  assert.equal(qc.status, 'valid');
  assert.equal(qc.checks.filter((check) => check.status === 'fail').length, 0);
  assert.equal(qc.checks.filter((check) => check.status === 'warn').length, 0);
});

test('duplicate options fail answer uniqueness', () => {
  const item = firstItem();
  const answer = item.ground_truth.answer;
  const other = Object.keys(item.options).find((label) => label !== answer);
  item.options[other] = item.options[answer];
  const qc = runQualityChecks(item, recordFor(item));
  assert.equal(qc.status, 'invalid');
  assert.ok(qc.checks.some((check) => check.rule === 'answer_uniqueness' && check.status === 'fail'));
});

test('tampered evidence fails traceability and evidence consistency', () => {
  const item = firstItem();
  // The option keeps the original answer text; only the recorded evidence lies.
  item.evidence.original_text = 'A completely different endpoint that is not in the registry';
  const qc = runQualityChecks(item, recordFor(item));
  assert.equal(qc.status, 'invalid');
  const failed = qc.checks.filter((check) => check.status === 'fail').map((check) => check.rule);
  assert.ok(failed.includes('gt_traceability'));
  assert.ok(failed.includes('evidence_consistency'));
});

test('a placeholder in the question stem fails completeness', () => {
  const item = firstItem();
  item.query = 'A trial is being designed for {disease}. Which outcome was registered?';
  const qc = runQualityChecks(item, recordFor(item));
  assert.equal(qc.status, 'invalid');
  assert.ok(qc.checks.some((check) => check.rule === 'question_completeness' && check.status === 'fail'));
});

test('an option pasted into the prompt fails leakage', () => {
  const item = firstItem();
  item.query = `${item.query}\nHint: the answer is exactly "${item.options[item.ground_truth.answer]}"`;
  const qc = runQualityChecks(item, recordFor(item));
  assert.equal(qc.status, 'invalid');
  assert.ok(qc.checks.some((check) => check.rule === 'data_leakage' && check.status === 'fail'));
});

test('a meta-option such as "all of the above" is invalid', () => {
  const item = firstItem();
  const other = Object.keys(item.options).find((label) => label !== item.ground_truth.answer);
  item.options[other] = 'All of the above primary endpoints';
  const qc = runQualityChecks(item, recordFor(item));
  assert.equal(qc.status, 'invalid');
  assert.ok(qc.checks.some((check) => check.rule === 'option_validity' && check.status === 'fail'));
});

test('missing record makes traceability fail rather than pass silently', () => {
  const item = firstItem();
  const qc = runQualityChecks(item, undefined);
  assert.equal(qc.status, 'invalid');
  assert.ok(qc.checks.some((check) => check.rule === 'gt_traceability' && check.status === 'fail'));
});

test('completion items are downgraded to needs_review by the temporal rule', () => {
  const { items } = generateFromFixtures({ task_types: ['trial_completion_prediction'], per_task: 3, include_experimental: true });
  assert.ok(items.length > 0);
  const item = items[0];
  const qc = runQualityChecks(item, recordFor(item));
  assert.equal(qc.status, 'needs_review');
  assert.ok(qc.checks.some((check) => check.rule === 'temporal_validation'));
});
