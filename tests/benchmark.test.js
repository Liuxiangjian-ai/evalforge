import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompletionCandidate,
  buildEligibilityCandidate,
  buildEndpointCandidate,
  completionLabel,
  generateBenchmark,
  isNearDuplicateOption,
} from '../src/host/benchmark.js';
import { normalizeComparable } from '../src/shared/text.js';
import { fixture, loadFixtures, generateFromFixtures } from './helpers.js';

const sourceText = (record, field) => {
  if (field === 'primaryOutcomes') {
    return record.primary_outcomes
      .map((outcome) => [outcome.measure, outcome.time_frame].filter(Boolean).join(' '))
      .join(' | ');
  }
  if (field === 'eligibilityCriteria') return record.eligibility_criteria;
  return record.overall_status;
};

test('every generated item carries registry-derived ground truth', () => {
  const { items, stats } = generateFromFixtures();
  assert.ok(items.length >= 5, `expected items, got ${items.length}`);
  assert.equal(stats.invalid, 0);
  for (const item of items) {
    assert.match(item.id, /^MED-\d{6}$/);
    assert.ok(item.options[item.ground_truth.answer], `${item.id} answer must be an option`);
    assert.equal(item.ground_truth.type, 'registry_reference');
    assert.match(item.evidence.nct_id, /^NCT\d{8}$/);
    assert.equal(item.evidence.source_url, `https://clinicaltrials.gov/study/${item.evidence.nct_id}`);
    assert.ok(item.evidence.original_text.length > 0);
    assert.ok(item.rubric.type === 'exact_match' && item.rubric.max_score === 1);
    const record = fixture(item.evidence.nct_id);
    const haystack = normalizeComparable(sourceText(record, item.ground_truth.source_field));
    assert.ok(
      haystack.includes(normalizeComparable(item.evidence.original_text)),
      `${item.id}: ground truth must appear verbatim in ${item.ground_truth.source_field}`,
    );
  }
});

test('endpoint items use the registered primary outcome and four distinct options', () => {
  const { items } = generateFromFixtures({ task_types: ['endpoint_selection'] });
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.equal(Object.keys(item.options).length, 4);
    const values = Object.values(item.options);
    assert.equal(new Set(values.map(normalizeComparable)).size, 4, `${item.id}: duplicate options`);
    const record = fixture(item.evidence.nct_id);
    const registered = record.primary_outcomes.map((outcome) => normalizeComparable(outcome.measure));
    const answer = normalizeComparable(item.options[item.ground_truth.answer]);
    assert.ok(registered.some((measure) => answer.includes(measure) || measure.includes(answer)));
    assert.equal(item.quality.temporal_validation_required, false);
    assert.ok(item.distractor_sources.length >= 3);
    assert.ok(item.distractor_sources.every((source) => source.nct_id !== item.evidence.nct_id));
  }
});

test('eligibility items keep the registered polarity and never invent a patient vignette', () => {
  const { items } = generateFromFixtures({ task_types: ['eligibility_criteria_matching'] });
  assert.ok(items.length > 0);
  for (const item of items) {
    const record = fixture(item.evidence.nct_id);
    assert.ok(['inclusion', 'exclusion'].includes(item.ground_truth.polarity));
    assert.ok(normalizeComparable(record.eligibility_criteria).includes(normalizeComparable(item.evidence.original_text)));
    assert.ok(!/\b(patient|mr\.|mrs\.|69-year-old)\b/i.test(item.query.slice(0, 40)));
    assert.equal(Object.keys(item.options).length, 4);
  }
});

test('option assembly is deterministic for a fixed seed', () => {
  const a = generateFromFixtures({ seed: 7, per_task: 4 }).items;
  const b = generateFromFixtures({ seed: 7, per_task: 4 }).items;
  assert.deepEqual(a.map((item) => [item.id, item.options, item.ground_truth.answer]), b.map((item) => [item.id, item.options, item.ground_truth.answer]));
});

test('dedupe keys are unique inside a generated benchmark', () => {
  const { items } = generateFromFixtures();
  const keys = items.map((item) => item.dedupe_key);
  assert.equal(new Set(keys).size, keys.length);
});

test('a disabled task type produces no items for that type', () => {
  const { items, stats } = generateFromFixtures({ task_types: ['endpoint_selection'] });
  assert.ok(items.every((item) => item.task_type === 'endpoint_selection'));
  assert.equal(stats.per_task.eligibility_criteria_matching, undefined);
});

test('a corpus below four trials cannot build four-option items', () => {
  const result = generateBenchmark({ records: loadFixtures().slice(0, 2), config: { per_task: 5 } });
  assert.equal(result.items.length, 0);
  assert.equal(result.rejected[0].reason, 'corpus_too_small');
});

test('completion items are experimental, leak-guarded and never formally valid', () => {
  const fixtures = loadFixtures().filter((record) => completionLabel(record));
  const { items } = generateBenchmark({
    records: fixtures,
    config: { task_types: ['trial_completion_prediction'], per_task: 4, include_experimental: true },
  });
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.equal(item.quality.experimental, true);
    assert.equal(item.quality.temporal_validation_required, true);
    assert.notEqual(item.quality.status, 'valid');
    assert.equal(Object.keys(item.options).length, 2);
    assert.ok(!/\bcompleted\b|\bterminated\b|\bwithdrawn\b/i.test(item.query), 'completion prompt must not leak the status');
    assert.ok(!item.query.includes(fixture(item.evidence.nct_id).overall_status));
  }
});

test('completion task is skipped unless explicitly enabled', () => {
  const { items, stats } = generateBenchmark({
    records: loadFixtures(),
    config: { task_types: ['trial_completion_prediction'], per_task: 4 },
  });
  assert.equal(items.length, 0);
  assert.equal(stats.per_task.trial_completion_prediction.skipped, 'experimental_task_disabled');
});

test('near-duplicate option detection catches reworded thresholds', () => {
  assert.equal(isNearDuplicateOption('Male or female, age above or equal to 18 years at the time of signing informed consent', 'Males and females, Age≥18 years old at the time of signing informed consent').duplicate, true);
  assert.equal(isNearDuplicateOption('HbA1c between 7% and 9.5%', 'HbA1c below 7%').duplicate, false);
  assert.equal(isNearDuplicateOption('Change in body weight at week 52', 'Time to cardiovascular death').duplicate, false);
});

test('endpoint builders refuse a target with only a placeholder outcome', () => {
  const record = structuredClone(fixture('NCT06716216'));
  record.primary_outcomes = [{ measure: 'Primary Outcome Measure', description: '', time_frame: 'Week 44' }];
  const candidate = buildEndpointCandidate(record, loadFixtures(), {});
  assert.equal(candidate.rejected, 'no_usable_outcome_measure');
});

test('eligibility builder rejects a criterion set it cannot separate', () => {
  const record = structuredClone(fixture('NCT06716203'));
  record.eligibility_criteria = 'Inclusion Criteria:\n1. Willing and able to provide informed consent.';
  record.raw.protocolSection.eligibilityModule.eligibilityCriteria = record.eligibility_criteria;
  const candidate = buildEligibilityCandidate(record, [record], {});
  assert.equal(candidate.rejected, 'no_verifiable_criterion');
});

test('completion builder rejects records with a non-terminal status', () => {
  const record = structuredClone(fixture('NCT06716203'));
  record.overall_status = 'RECRUITING';
  assert.equal(buildCompletionCandidate(record, [], {}).rejected, 'indeterminate_status');
});
