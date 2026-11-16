import {
  BENCHMARK_SCHEMA_VERSION,
  COMPLETION_LEAK_PATTERNS,
  PROMPT_VERSION,
  QUALITY_STATUS,
  TASK_TYPES,
} from '../shared/constants.js';
import {
  clip,
  jaccard,
  ngramContainment,
  normalizeComparable,
  normalizeWhitespace,
  nowIso,
  sha256Hex,
  tokenSet,
} from '../shared/text.js';
import { makeRng, shuffle } from '../shared/rng.js';
import { splitEligibility, rankCriteria, mutateNumericCriterion, rawEligibilityText } from './criteria.js';
import { runQualityChecks } from './qc.js';

const OPTION_LABELS = ['A', 'B', 'C', 'D'];

const COMPLETED_STATUSES = new Set(['COMPLETED']);
const EARLY_STOP_STATUSES = new Set(['TERMINATED', 'WITHDRAWN', 'SUSPENDED']);

/** Outcome names that carry no information and must never become an option. */
const GENERIC_MEASURE = /^(?:(?:primary|secondary|key|main|the)\s+)*(?:outcome|endpoint|outcome measure|endpoint measure|efficacy|safety|tolerability|efficacy and safety|pharmacokinetics?|pharmacodynamics?|biomarkers?)\s*(?:measures?)?$/i;

const CONCEPT_STOPWORDS = new Set([
  'change', 'changes', 'baseline', 'week', 'weeks', 'month', 'months', 'day', 'days', 'year', 'years',
  'from', 'through', 'until', 'percent', 'percentage', 'mean', 'median', 'absolute', 'relative',
  'value', 'values', 'level', 'levels', 'score', 'scores', 'rate', 'rates', 'time', 'point', 'visit',
  'end', 'study', 'treatment', 'period', 'overall', 'total', 'measured', 'measure', 'assessed',
  'assessment', 'evaluation', 'compared', 'comparison', 'group', 'groups', 'arm', 'arms', 'dose', 'doses',
  'subjects', 'subject', 'participants', 'participant', 'patients', 'patient', 'healthy', 'adult', 'adults',
]);

/**
 * Clinical synonym groups: registry authors write the same measure in several
 * ways ("HbA1c", "glycated haemoglobin"), so raw tokens cannot decide whether
 * two options describe the same endpoint.
 */
const CONCEPT_SYNONYMS = new Map([
  ['glycated', 'hba1c'], ['glycosylated', 'hba1c'], ['glycatedhaemoglobin', 'hba1c'],
  ['haemoglobin', 'hba1c'], ['hemoglobin', 'hba1c'], ['a1c', 'hba1c'], ['hba1c', 'hba1c'],
  ['systolic', 'bloodpressure'], ['diastolic', 'bloodpressure'], ['sbp', 'bloodpressure'],
  ['dbp', 'bloodpressure'], ['mssbp', 'bloodpressure'], ['mmhg', 'bloodpressure'],
  ['glomerular', 'gfr'], ['filtration', 'gfr'], ['egfr', 'gfr'], ['mgfr', 'gfr'],
  ['cardiovascular', 'cv'], ['mace', 'cv'], ['hfe', 'cv'],
  ['bodyweight', 'weight'], ['kg', 'weight'],
]);

function canonicalToken(word) {
  return CONCEPT_SYNONYMS.get(word) || word;
}

function conceptSignature(text) {
  const numbers = [...String(text).matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]).sort();
  let words = normalizeComparable(text)
    .replace(/\b\d+(?:\.\d+)?\b/g, ' ')
    .split(' ')
    .filter((word) => word && word.length >= 3 && !CONCEPT_STOPWORDS.has(word) && !GENERIC_WORDS.has(word))
    .map(canonicalToken);
  words = words.map((word) => (word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
  return { tokens: new Set(words), numbers };
}

const GENERIC_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'will', 'been', 'have', 'has', 'had', 'not', 'but', 'its', 'their', 'there', 'which', 'who', 'into', 'than', 'then', 'also', 'may', 'can', 'any', 'all', 'per', 'via', 'use', 'used', 'using', 'including', 'include']);

/**
 * Two option texts are duplicates when they express the same concept with the
 * same numeric thresholds. This is stricter than raw token overlap because
 * "age ≥18" and "Males and females, age ≥ 18 years" are the same rule.
 */
export function isNearDuplicateOption(a, b) {
  const left = conceptSignature(a);
  const right = conceptSignature(b);
  const similarity = jaccard(left.tokens, right.tokens);
  const sameNumbers = left.numbers.join(',') === right.numbers.join(',');
  if (similarity >= 0.8) return { duplicate: true, similarity, reason: 'concept' };
  if (similarity >= 0.62 && sameNumbers && left.numbers.length > 0) return { duplicate: true, similarity, reason: 'concept+threshold' };
  if (similarity >= 0.7 && !left.numbers.length && !right.numbers.length) return { duplicate: true, similarity, reason: 'concept-no-threshold' };
  return { duplicate: false, similarity };
}

/** Same measure family but a different timeframe is still ambiguous for a single-answer MCQ. */
function sameMeasureFamily(a, b) {
  const left = conceptSignature(a);
  const right = conceptSignature(b);
  if (!left.tokens.size || !right.tokens.size) return false;
  let shared = 0;
  for (const token of left.tokens) if (right.tokens.has(token)) shared += 1;
  // Overlap coefficient (not Jaccard): one option naming a subset of the other's
  // measures ("change in HbA1c" vs "change in HbA1c and blood pressure") is still
  // the same clinical concept and must not appear together.
  const overlap = shared / Math.min(left.tokens.size, right.tokens.size);
  return overlap >= 0.6;
}

function cleanOptionText(value) {
  return normalizeWhitespace(value)
    .replace(/^[\s\-•*]+/, '')
    .replace(/[;,.\s]+$/, '')
    .trim();
}

function isValidMeasure(text) {
  if (!text || text.length < 8) return false;
  // Strip a trailing timeframe so "Primary Outcome Measure (Week 44)" is still
  // recognised as the generic placeholder it is.
  const core = normalizeWhitespace(text).replace(/\s*\([^()]*\)\s*$/, '');
  if (GENERIC_MEASURE.test(core) || GENERIC_MEASURE.test(text)) return false;
  const tokens = tokenSet(core);
  return tokens.size >= 2;
}

/** Slightly prefer distractors close in length to the answer (reduces length shortcuts). */
function lengthPenalty(correctText, candidate) {
  const ratio = candidate.length / Math.max(12, correctText.length);
  if (ratio < 0.6 || ratio > 1.6) return 100;
  return Math.abs(Math.log(ratio));
}
;

export function composeOutcomeText(outcome) {
  const measure = normalizeWhitespace(outcome.measure || '');
  const frame = normalizeWhitespace(outcome.time_frame || '');
  if (!measure) return '';
  return frame ? `${measure} (${frame})` : measure;
}

/** Condition tokens used to prefer same-disease distractors. */
function conditionTokens(record) {
  return tokenSet((record.conditions || []).join(' '));
}

function conditionOverlap(a, b) {
  return jaccard(conditionTokens(a), conditionTokens(b));
}

/** Sentence-level filter that removes any sentence echoing the ground truth. */
function safeSummary(record, secretText, maxChars = 520) {
  const summary = normalizeWhitespace(record.brief_summary || record.detailed_description || '');
  if (!summary) return '';
  const parts = String(secretText).split(/\s*;\s*/).filter(Boolean);
  const sentences = summary.split(/(?<=[.!?])\s+(?=[A-Z(])/).filter(Boolean);
  const kept = [];
  for (const sentence of sentences) {
    const tokens = tokenSet(sentence);
    let leaks = jaccard(tokens, tokenSet(secretText)) >= 0.35;
    for (const part of parts) {
      if (leaks) break;
      if (ngramContainment(part, sentence, 3) >= 0.4) leaks = true;
      else if (jaccard(tokens, tokenSet(part)) >= 0.4) leaks = true;
    }
    if (leaks) continue;
    kept.push(sentence);
    if (kept.join(' ').length >= maxChars) break;
  }
  return clip(kept.join(' ').replace(/\s+([.,;])/g, '$1'), maxChars);
}

function interventionSummary(record, limit = 4) {
  const items = (record.interventions || []).slice(0, limit).map((item) => {
    const name = normalizeWhitespace(item.name);
    return item.type ? `${item.type}: ${name}` : name;
  }).filter((item) => item.length > 0);
  return items.join('; ');
}

function phaseLabel(record) {
  if (!record.phases?.length) return 'an unspecified phase';
  const labels = record.phases.map((phase) => phase.replace('_', ' ').replace('PHASE', 'Phase '));
  return labels.join(' / ');
}

function titleFor(record) {
  return normalizeWhitespace(record.brief_title || record.official_title || '');
}

function makeItemIdFactory(startAt = 1) {
  let counter = startAt;
  return () => {
    const id = `MED-${String(counter).padStart(6, '0')}`;
    counter += 1;
    return id;
  };
}

function assignOptions(correctText, distractorTexts, rng) {
  const values = shuffle([correctText, ...distractorTexts], rng);
  const options = {};
  values.forEach((value, index) => {
    options[OPTION_LABELS[index]] = value;
  });
  const answer = OPTION_LABELS[values.indexOf(correctText)];
  return { options, answer };
}

function baseEvidence(record, sourceField, originalText, fieldPath) {
  return {
    nct_id: record.nct_id,
    registry: 'ClinicalTrials.gov',
    source_url: record.source?.source_url || `https://clinicaltrials.gov/study/${record.nct_id}`,
    api_url: record.source?.api_url || `https://clinicaltrials.gov/api/v2/studies/${record.nct_id}`,
    record_version: record.record_version || record.study_dates?.last_update_posted || '',
    last_update_posted: record.study_dates?.last_update_posted || '',
    fetched_at: record.source?.fetched_at || '',
    source_field: sourceField,
    field_path: fieldPath,
    original_text: originalText,
  };
}

/* ------------------------------------------------------------------ */
/* Task 1 — primary endpoint selection                                 */
/* ------------------------------------------------------------------ */

function endpointDistractorPool(pool, target) {
  const candidates = [];
  for (const record of pool) {
    if (record.nct_id === target.nct_id) continue;
    const outcomes = (record.primary_outcomes || []).slice(0, 3);
    for (const outcome of outcomes) {
      const text = cleanOptionText(composeOutcomeText(outcome));
      if (!isValidMeasure(text)) continue;
      candidates.push({
        text,
        nct_id: record.nct_id,
        field_path: 'protocolSection.outcomesModule.primaryOutcomes',
        overlap: conditionOverlap(target, record),
        phaseMatch: record.phase === target.phase ? 1 : 0,
      });
    }
  }
  return candidates;
}

export function buildEndpointCandidate(target, pool, { seed = 42, usage = new Map() } = {}) {
  const outcomes = (target.primary_outcomes || []).slice(0, 3);
  if (outcomes.length === 0) return { rejected: 'no_primary_outcomes' };
  if (outcomes.length > 3) return { rejected: 'too_many_primary_outcomes' };
  const outcomeTexts = outcomes.map((outcome) => cleanOptionText(composeOutcomeText(outcome))).filter(isValidMeasure);
  if (!outcomeTexts.length) return { rejected: 'no_usable_outcome_measure' };
  const correctText = outcomeTexts.join('; ');
  if (correctText.length < 12 || correctText.length > 320) return { rejected: 'outcome_text_length' };

  // Prefer same-condition, same-phase, similar-length, rarely used distractors.
  const ranked = endpointDistractorPool(pool, target)
    .map((candidate) => ({
      ...candidate,
      rankScore: candidate.overlap * 2 + candidate.phaseMatch - lengthPenalty(correctText, candidate.text) * 0.6 - (usage.get(candidate.text) || 0) * 0.35,
    }))
    .sort((a, b) => b.rankScore - a.rankScore);

  const picked = [];
  const pickedSources = [];
  for (const candidate of ranked) {
    if (picked.length === 3) break;
    if (lengthPenalty(correctText, candidate.text) >= 100) continue;
    if (outcomeTexts.some((outcome) => sameMeasureFamily(outcome, candidate.text) || isNearDuplicateOption(outcome, candidate.text).duplicate)) continue;
    if (picked.some((existing) => sameMeasureFamily(existing, candidate.text) || isNearDuplicateOption(existing, candidate.text).duplicate)) continue;
    picked.push(candidate.text);
    pickedSources.push({
      nct_id: candidate.nct_id,
      kind: 'registry_outcome',
      condition_overlap: Number(candidate.overlap.toFixed(2)),
    });
  }
  if (picked.length < 3) return { rejected: 'insufficient_same_domain_distractors' };
  for (const text of picked) usage.set(text, (usage.get(text) || 0) + 1);

  const rng = makeRng('endpoint', target.nct_id, seed);
  const { options, answer } = assignOptions(correctText, picked, rng);
  const summary = safeSummary(target, correctText);
  const lines = [
    `A clinical trial is being designed for ${(target.conditions || []).join(', ') || 'the stated condition'}.`,
    `Registry title: "${clip(titleFor(target), 220)}".`,
    summary ? `Registry summary: "${summary}"` : '',
    `Planned phase: ${phaseLabel(target)}. Study type: ${target.study_type || 'INTERVENTIONAL'}.`,
    interventionSummary(target) ? `Planned interventions: ${interventionSummary(target)}.` : '',
    'Based only on this trial design information, which option lists the primary outcome measure(s) that the trial actually registered?',
  ].filter(Boolean);

  return {
    task_type: TASK_TYPES.ENDPOINT,
    query: lines.join('\n'),
    options,
    ground_truth: {
      answer,
      type: 'registry_reference',
      source_field: 'primaryOutcomes',
      field_path: 'protocolSection.outcomesModule.primaryOutcomes',
      value: correctText,
      note: 'Registered reference, not a claim of medical optimality.',
    },
    rubric: { type: 'exact_match', max_score: 1 },
    evidence: baseEvidence(target, 'primaryOutcomes', correctText, 'protocolSection.outcomesModule.primaryOutcomes'),
    quality: {
      source_verified: true,
      unique_answer: true,
      expert_reviewed: false,
      temporal_validation_required: false,
      experimental: false,
    },
    distractor_sources: pickedSources,
    context: {
      condition: (target.conditions || [])[0] || '',
      phase: target.phase || '',
      study_type: target.study_type || '',
      record_last_update: target.study_dates?.last_update_posted || '',
    },
  };
}

/* ------------------------------------------------------------------ */
/* Task 2 — eligibility criteria matching                              */
/* ------------------------------------------------------------------ */

function criteriaDistractorPool(pool, target, polarity) {
  const candidates = [];
  for (const record of pool) {
    if (record.nct_id === target.nct_id) continue;
    const split = splitEligibility(rawEligibilityText(record));
    const items = polarity === 'exclusion' ? split.exclusion : split.inclusion;
    for (const item of rankCriteria(items, { polarity })) {
      candidates.push({
        text: item.text,
        nct_id: record.nct_id,
        polarity,
        score: item.score,
        overlap: conditionOverlap(target, record),
        phaseMatch: record.phase === target.phase ? 1 : 0,
      });
    }
  }
  candidates.sort((a, b) => (b.overlap * 2 + b.phaseMatch + b.score) - (a.overlap * 2 + a.phaseMatch + a.score));
  return candidates;
}

export function buildEligibilityCandidate(target, pool, { seed = 42, usage = new Map() } = {}) {
  const raw = rawEligibilityText(target);
  if (!raw) return { rejected: 'no_eligibility_criteria' };
  const split = splitEligibility(raw);
  const inclusion = rankCriteria(split.inclusion, { polarity: 'inclusion' });
  const exclusion = rankCriteria(split.exclusion, { polarity: 'exclusion' });
  const ranked = inclusion.length ? inclusion : exclusion;
  if (!ranked.length) return { rejected: 'no_verifiable_criterion' };

  const chosen = ranked[0];
  const polarity = chosen.polarity;
  const correctText = cleanOptionText(chosen.text);

  const candidates = criteriaDistractorPool(pool, target, polarity)
    .map((candidate) => ({
      ...candidate,
      text: cleanOptionText(candidate.text),
      rankScore: candidate.overlap * 2 + candidate.phaseMatch + candidate.score * 0.5
        - lengthPenalty(correctText, candidate.text) * 0.6
        - (usage.get(cleanOptionText(candidate.text)) || 0) * 0.5,
    }))
    .sort((a, b) => b.rankScore - a.rankScore);

  const picked = [];
  const pickedSources = [];
  let synthetic = 0;
  for (const candidate of candidates) {
    if (picked.length === 3) break;
    if (candidate.text.length < 30 || candidate.text.length > 380) continue;
    if (lengthPenalty(correctText, candidate.text) >= 100) continue;
    if (isNearDuplicateOption(correctText, candidate.text).duplicate) continue;
    if (picked.some((existing) => isNearDuplicateOption(existing, candidate.text).duplicate)) continue;
    picked.push(candidate.text);
    pickedSources.push({
      nct_id: candidate.nct_id,
      kind: 'registry_criterion',
      condition_overlap: Number(candidate.overlap.toFixed(2)),
    });
  }
  while (picked.length < 3) {
    const mutated = mutateNumericCriterion(correctText, `${seed}-${picked.length}`);
    if (!mutated.text || normalizeComparable(mutated.text) === normalizeComparable(correctText)) return { rejected: 'distractor_mutation_failed' };
    if (picked.some((existing) => isNearDuplicateOption(existing, mutated.text).duplicate || jaccard(existing, mutated.text) >= 0.65)) {
      return { rejected: 'synthetic_distractor_collision' };
    }
    picked.push(mutated.text);
    pickedSources.push({ nct_id: target.nct_id, kind: 'mutated_criterion', mutation: mutated.mutation });
    synthetic += 1;
  }
  for (const text of picked) usage.set(text, (usage.get(text) || 0) + 1);

  const rng = makeRng('eligibility', target.nct_id, seed);
  const { options, answer } = assignOptions(correctText, picked, rng);
  const designBits = [];
  if (target.design_info?.allocation) designBits.push(`allocation ${target.design_info.allocation.toLowerCase()}`);
  if (target.design_info?.intervention_model) designBits.push(`model ${target.design_info.intervention_model.toLowerCase().replace(/_/g, ' ')}`);
  if (target.design_info?.masking) designBits.push(`masking ${target.design_info.masking.toLowerCase().replace(/_/g, ' ')}`);

  const lines = [
    `A ${phaseLabel(target)} ${String(target.study_type || 'INTERVENTIONAL').toLowerCase()} trial is planned for ${(target.conditions || []).join(', ') || 'the stated condition'}.`,
    `Registry title: "${clip(titleFor(target), 200)}".`,
    interventionSummary(target) ? `Planned intervention(s): ${interventionSummary(target)}.` : '',
    designBits.length ? `Trial design: ${designBits.join(', ')}.` : '',
    `The protocol must state its participant eligibility rules before enrolment.`,
    `Which of the following is an ${polarity === 'exclusion' ? 'exclusion' : 'inclusion'} criterion that this trial registered?`,
  ].filter(Boolean);

  const item = {
    task_type: TASK_TYPES.ELIGIBILITY,
    query: lines.join('\n'),
    options,
    ground_truth: {
      answer,
      type: 'registry_reference',
      source_field: 'eligibilityCriteria',
      field_path: `protocolSection.eligibilityModule.eligibilityCriteria#${polarity}`,
      value: correctText,
      polarity,
      note: 'Registered eligibility text; the alternative options come from other trials or documented mutations.',
    },
    rubric: { type: 'exact_match', max_score: 1 },
    evidence: baseEvidence(target, 'eligibilityCriteria', correctText, 'protocolSection.eligibilityModule.eligibilityCriteria'),
    quality: {
      source_verified: true,
      unique_answer: true,
      expert_reviewed: false,
      temporal_validation_required: false,
      experimental: false,
      synthetic_distractors: synthetic > 0,
    },
    distractor_sources: pickedSources,
    context: {
      condition: (target.conditions || [])[0] || '',
      phase: target.phase || '',
      study_type: target.study_type || '',
      polarity,
      record_last_update: target.study_dates?.last_update_posted || '',
    },
  };

  // The raw criteria blob is far larger than the quoted item; keep the exact
  // criterion for traceability and the blob hash for integrity checks.
  item.evidence.criteria_blob_sha256 = sha256Hex(raw);
  item.evidence.criteria_item_index = split[polarity].findIndex((value) => normalizeComparable(value) === normalizeComparable(correctText));
  return item;
}

/* ------------------------------------------------------------------ */
/* Task 3 — trial completion prediction (experimental)                 */
/* ------------------------------------------------------------------ */

export function completionLabel(record) {
  const status = String(record.overall_status || '').toUpperCase();
  if (COMPLETED_STATUSES.has(status)) return 'completed';
  if (EARLY_STOP_STATUSES.has(status)) return 'early_stop';
  return null;
}

export function buildCompletionCandidate(target, _pool, { seed = 42 } = {}) {
  const label = completionLabel(target);
  if (!label) return { rejected: 'indeterminate_status' };
  if (!target.phases?.length) return { rejected: 'missing_phase' };
  if (!target.eligibility_criteria) return { rejected: 'missing_eligibility' };

  const arms = target.arm_groups || [];
  const armDescriptions = arms.slice(0, 4).map((arm) => {
    const description = clip(arm.description || '', 180);
    return description ? `${arm.label} (${arm.type || 'arm'}): ${description}` : `${arm.label} (${arm.type || 'arm'})`;
  });
  const elig = target.eligibility_fields || {};
  const eligBits = [
    elig.minimum_age ? `minimum age ${elig.minimum_age}` : '',
    elig.maximum_age ? `maximum age ${elig.maximum_age}` : '',
    elig.sex && elig.sex !== 'ALL' ? `sex ${elig.sex}` : '',
  ].filter(Boolean);

  const outcomes = (target.primary_outcomes || []).slice(0, 2).map(composeOutcomeText).filter(Boolean);
  const lines = [
    'You are reviewing a trial protocol at the feasibility-assessment stage. The trial has already been registered, and its final outcome is unknown to you.',
    `Condition: ${(target.conditions || []).join(', ') || 'not stated'}.`,
    `Registry title: "${clip(titleFor(target), 200)}".`,
    `Phase: ${phaseLabel(target)}. Study type: ${String(target.study_type || '').toLowerCase() || 'not stated'}.`,
    `Planned arms (${arms.length}): ${armDescriptions.join(' | ') || 'not stated'}.`,
    interventionSummary(target) ? `Intervention(s): ${interventionSummary(target)}.` : '',
    `Design: ${[target.design_info?.allocation, target.design_info?.intervention_model, target.design_info?.masking, target.design_info?.primary_purpose].filter(Boolean).map((value) => String(value).toLowerCase().replace(/_/g, ' ')).join(', ') || 'not stated'}.`,
    eligBits.length ? `Eligibility frame: ${eligBits.join(', ')}.` : '',
    outcomes.length ? `Primary outcome measure(s): ${outcomes.join('; ')}.` : '',
    'Based on this design information alone, what happened to the trial?',
  ].filter(Boolean);

  const query = lines.join('\n');
  for (const pattern of COMPLETION_LEAK_PATTERNS) {
    if (pattern.test(query)) return { rejected: `leakage:${pattern.source}` };
  }

  const completedText = 'The trial reached its registered completion.';
  const earlyText = 'The trial was stopped early (terminated, withdrawn, or suspended).';
  const correctText = label === 'completed' ? completedText : earlyText;
  const rng = makeRng('completion', target.nct_id, seed);
  const { options, answer } = assignOptions(correctText, [label === 'completed' ? earlyText : completedText], rng);

  return {
    task_type: TASK_TYPES.COMPLETION,
    query,
    options,
    ground_truth: {
      answer,
      type: 'registry_reference',
      source_field: 'overallStatus',
      field_path: 'protocolSection.statusModule.overallStatus',
      value: correctText,
      label,
      raw_status: target.overall_status,
      note: 'Recorded final status. Experimental: no pre-outcome snapshot exists, so this item is not a prospective prediction benchmark.',
    },
    rubric: { type: 'exact_match', max_score: 1 },
    evidence: baseEvidence(target, 'overallStatus', target.overall_status, 'protocolSection.statusModule.overallStatus'),
    quality: {
      source_verified: true,
      unique_answer: true,
      expert_reviewed: false,
      temporal_validation_required: true,
      experimental: true,
    },
    distractor_sources: [{ nct_id: target.nct_id, kind: 'status_alternative' }],
    context: {
      condition: (target.conditions || [])[0] || '',
      phase: target.phase || '',
      study_type: target.study_type || '',
      completion_label: label,
      record_last_update: target.study_dates?.last_update_posted || '',
    },
  };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

function eligibleTargets(records, taskType) {
  switch (taskType) {
    case TASK_TYPES.ENDPOINT:
      return records.filter((record) => (record.primary_outcomes || []).length > 0 && titleFor(record));
    case TASK_TYPES.ELIGIBILITY:
      return records.filter((record) => Boolean(rawEligibilityText(record)) && titleFor(record));
    case TASK_TYPES.COMPLETION:
      return records.filter((record) => completionLabel(record) !== null && Boolean(record.eligibility_criteria));
    default:
      return [];
  }
}

function candidateBuilder(taskType) {
  if (taskType === TASK_TYPES.ENDPOINT) return buildEndpointCandidate;
  if (taskType === TASK_TYPES.ELIGIBILITY) return buildEligibilityCandidate;
  return buildCompletionCandidate;
}

/**
 * Generate benchmark items from a real trial corpus.
 *
 * Ground truth always comes from a registry field; this function never asks a
 * model to produce the answer. Invalid candidates are reported in `rejected`
 * instead of being silently downgraded.
 */
export function generateBenchmark({ records, config = {}, startId = 1 } = {}) {
  const taskTypes = (config.task_types && config.task_types.length ? config.task_types : [TASK_TYPES.ENDPOINT, TASK_TYPES.ELIGIBILITY])
    .filter((task) => Object.values(TASK_TYPES).includes(task));
  const perTask = Math.max(1, Math.min(200, Number(config.per_task) || 10));
  const seed = Number.isFinite(Number(config.seed)) ? Number(config.seed) : 42;
  const dropInvalid = config.drop_invalid !== false;
  const includeExperimental = config.include_experimental === true;
  const pool = (records || []).filter((record) => record && record.nct_id);
  const corpusIndex = new Map(pool.map((record) => [record.nct_id, record]));
  const nextId = makeItemIdFactory(startId);

  const items = [];
  const rejected = [];
  const perTaskStats = {};
  // Distractor texts are shared across items; the usage map keeps options diverse.
  const usage = new Map();

  if (pool.length < 4) {
    return {
      items,
      rejected: [{ reason: 'corpus_too_small', detail: 'at least 4 trials are required to build 4-option items', task_type: null }],
      stats: { generated: 0, valid: 0, needs_review: 0, invalid: 0, candidates: 0, per_task: {}, corpus_size: pool.length, seed },
    };
  }

  for (const taskType of taskTypes) {
    if (taskType === TASK_TYPES.COMPLETION && !includeExperimental) {
      perTaskStats[taskType] = { skipped: 'experimental_task_disabled', generated: 0 };
      continue;
    }
    const builder = candidateBuilder(taskType);
    const targets = eligibleTargets(pool, taskType)
      .slice()
      .sort((a, b) => a.nct_id.localeCompare(b.nct_id));
    if (taskType === TASK_TYPES.COMPLETION) {
      // Interleave completed and early-stopped trials so the class balance is usable.
      const completed = targets.filter((record) => completionLabel(record) === 'completed');
      const early = targets.filter((record) => completionLabel(record) === 'early_stop');
      targets.length = 0;
      const max = Math.max(completed.length, early.length);
      for (let i = 0; i < max; i += 1) {
        if (completed[i]) targets.push(completed[i]);
        if (early[i]) targets.push(early[i]);
      }
    }

    let generated = 0;
    const taskRejected = [];
    for (const target of targets) {
      if (generated >= perTask) break;
      let candidate;
      try {
        candidate = builder(target, pool, { seed, usage });
      } catch (err) {
        taskRejected.push({ task_type: taskType, nct_id: target.nct_id, reason: 'builder_error', detail: String(err?.message || err) });
        continue;
      }
      if (!candidate || candidate.rejected) {
        taskRejected.push({ task_type: taskType, nct_id: target.nct_id, reason: candidate?.rejected || 'empty_candidate' });
        continue;
      }

      const sourceRecord = corpusIndex.get(target.nct_id);
      const qc = runQualityChecks(candidate, sourceRecord);
      const id = nextId();
      const item = {
        id,
        benchmark_schema_version: BENCHMARK_SCHEMA_VERSION,
        task_type: candidate.task_type,
        query: candidate.query,
        options: candidate.options,
        ground_truth: candidate.ground_truth,
        rubric: candidate.rubric,
        evidence: candidate.evidence,
        quality: {
          ...candidate.quality,
          status: qc.status,
          checks: qc.checks,
          llm_review: {
            status: 'not_run',
            note: 'Deterministic rules only in v0.1; LLM-assisted review is an explicit opt-in added in a later version.',
          },
        },
        distractor_sources: candidate.distractor_sources,
        context: candidate.context,
        dedupe_key: sha256Hex([
          candidate.task_type,
          sourceRecord?.nct_id || '',
          normalizeComparable(candidate.ground_truth.value),
        ].join('|')),
        generated_at: nowIso(),
        prompt_version: PROMPT_VERSION,
      };

      if (qc.status === QUALITY_STATUS.INVALID && dropInvalid) {
        taskRejected.push({
          task_type: taskType,
          nct_id: target.nct_id,
          reason: 'qc_invalid',
          detail: qc.checks.filter((check) => check.status === 'fail').map((check) => `${check.rule}: ${check.detail}`).join('; '),
        });
        continue;
      }
      items.push(item);
      generated += 1;
    }
    rejected.push(...taskRejected);
    perTaskStats[taskType] = {
      generated,
      candidates_considered: targets.length,
      rejected: taskRejected.length,
      valid: items.filter((item) => item.task_type === taskType && item.quality.status === QUALITY_STATUS.VALID).length,
      needs_review: items.filter((item) => item.task_type === taskType && item.quality.status === QUALITY_STATUS.NEEDS_REVIEW).length,
      invalid: items.filter((item) => item.task_type === taskType && item.quality.status === QUALITY_STATUS.INVALID).length,
    };
  }

  const stats = {
    generated: items.length,
    valid: items.filter((item) => item.quality.status === QUALITY_STATUS.VALID).length,
    needs_review: items.filter((item) => item.quality.status === QUALITY_STATUS.NEEDS_REVIEW).length,
    invalid: items.filter((item) => item.quality.status === QUALITY_STATUS.INVALID).length,
    candidates: taskTypes.reduce((sum, task) => sum + (perTaskStats[task]?.candidates_considered || 0), 0),
    per_task: perTaskStats,
    corpus_size: pool.length,
    seed,
  };

  return { items, rejected, stats };
}
