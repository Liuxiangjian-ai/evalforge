import {
  COMPLETION_LEAK_PATTERNS,
  QUALITY_STATUS,
  QC_RULES,
  TASK_TYPES,
} from '../shared/constants.js';
import {
  clip,
  jaccard,
  ngramContainment,
  normalizeComparable,
  normalizeWhitespace,
  tokenSet,
} from '../shared/text.js';

const OK = (rule, detail = '') => ({ rule, status: 'pass', detail });
const WARN = (rule, detail) => ({ rule, status: 'warn', detail });
const FAIL = (rule, detail) => ({ rule, status: 'fail', detail });

/** Resolve the registry text a check should compare against. */
export function sourceTextFor(record, sourceField) {
  switch (sourceField) {
    case 'primaryOutcomes':
      return (record.primary_outcomes || [])
        .map((outcome) => [outcome.measure, outcome.time_frame].filter(Boolean).join(' '))
        .join(' | ');
    case 'eligibilityCriteria':
      return record.eligibility_criteria || record.raw?.protocolSection?.eligibilityModule?.eligibilityCriteria || '';
    case 'overallStatus':
      return record.overall_status || '';
    default:
      return '';
  }
}

function checkTraceability(item, record) {
  if (!record) return FAIL('gt_traceability', 'source record is missing from the corpus');
  if (!item.evidence?.nct_id || item.evidence.nct_id !== record.nct_id) {
    return FAIL('gt_traceability', 'evidence NCT ID does not match the source record');
  }
  const original = normalizeComparable(item.evidence?.original_text);
  if (!original) return FAIL('gt_traceability', 'ground-truth text is empty');
  const haystack = normalizeComparable(sourceTextFor(record, item.ground_truth?.source_field));
  if (!haystack) return FAIL('gt_traceability', `source field ${item.ground_truth?.source_field} is empty`);
  if (!haystack.includes(original)) {
    return FAIL('gt_traceability', 'ground-truth text is not found verbatim in the registry field');
  }
  if (!/^https:\/\/clinicaltrials\.gov\/study\/NCT\d{8}$/.test(item.evidence?.source_url || '')) {
    return WARN('gt_traceability', 'source URL is not a canonical ClinicalTrials.gov study URL');
  }
  return OK('gt_traceability', `${record.nct_id} · ${item.ground_truth?.source_field}`);
}

function checkUniqueness(item) {
  const labels = Object.keys(item.options || {});
  const expected = item.task_type === TASK_TYPES.COMPLETION ? 2 : 4;
  if (labels.length !== expected) return FAIL('answer_uniqueness', `expected ${expected} options, found ${labels.length}`);
  const answer = item.ground_truth?.answer;
  if (!labels.includes(answer)) return FAIL('answer_uniqueness', 'ground-truth label is not an option');
  const normalized = labels.map((label) => normalizeComparable(item.options[label]));
  const key = normalizeComparable(item.options[answer]);
  const matches = normalized.filter((value) => value === key).length;
  if (matches !== 1) return FAIL('answer_uniqueness', `${matches} options are identical to the ground truth`);
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const similarity = jaccard(tokenSet(item.options[labels[i]]), tokenSet(item.options[labels[j]]));
      if (similarity >= 0.8) {
        return FAIL('answer_uniqueness', `options ${labels[i]} and ${labels[j]} are semantically near-identical (${similarity.toFixed(2)})`);
      }
    }
  }
  return OK('answer_uniqueness', `${labels.length} distinct options, single registry answer`);
}

function checkCompleteness(item) {
  const query = normalizeWhitespace(item.query);
  if (query.length < 80) return FAIL('question_completeness', 'question stem is shorter than 80 characters');
  if (query.length > 4000) return WARN('question_completeness', 'question stem exceeds 4000 characters');
  if (!query.endsWith('?')) return WARN('question_completeness', 'question stem does not end with a question mark');
  if (/\{[a-z_]+\}|<[a-z_]+>|TODO|TBD|LOREM/i.test(query)) {
    return FAIL('question_completeness', 'question stem still contains a placeholder token');
  }
  if (!/\b(phase|trial|study|participants|patients|criteria)\b/i.test(query)) {
    return WARN('question_completeness', 'question stem does not state the study context');
  }
  return OK('question_completeness', `${query.length} characters`);
}

function checkOptions(item) {
  const labels = Object.keys(item.options || {});
  if (!labels.length) return FAIL('option_validity', 'no options were produced');
  const seen = new Map();
  for (const label of labels) {
    const text = normalizeWhitespace(item.options[label]);
    if (text.length < 12) return FAIL('option_validity', `option ${label} is too short to be a real criterion`);
    if (text.length > 420) return FAIL('option_validity', `option ${label} is longer than 420 characters`);
    if (/\b(all|none) of the above\b/i.test(text)) return FAIL('option_validity', `option ${label} is a meta-option`);
    const key = normalizeComparable(text);
    if (seen.has(key)) return FAIL('option_validity', `options ${seen.get(key)} and ${label} are duplicates`);
    seen.set(key, label);
  }
  return OK('option_validity', `${labels.length} well-formed, distinct options`);
}

function checkLeakage(item) {
  if (item.task_type === TASK_TYPES.COMPLETION) {
    for (const pattern of COMPLETION_LEAK_PATTERNS) {
      const match = pattern.exec(item.query);
      if (match) return FAIL('data_leakage', `completion prompt leaks outcome wording: "${match[0]}"`);
    }
    return OK('data_leakage', 'no outcome wording in the completion prompt');
  }
  const answerText = item.options?.[item.ground_truth?.answer] || '';
  const containment = ngramContainment(answerText, item.query, 3);
  if (containment >= 0.5) {
    return FAIL('data_leakage', `the prompt reproduces ${(containment * 100).toFixed(0)}% of the answer text`);
  }
  if (containment >= 0.3) {
    return WARN('data_leakage', `prompt/answer 3-gram overlap is ${(containment * 100).toFixed(0)}%`);
  }
  return OK('data_leakage', `prompt/answer overlap ${(containment * 100).toFixed(0)}%`);
}

function checkEvidence(item, record) {
  const version = item.evidence?.record_version;
  if (!version) return WARN('evidence_consistency', 'record version/date is missing');
  if (record && !sourceTextFor(record, item.ground_truth?.source_field)) {
    return FAIL('evidence_consistency', 'source field is empty on the stored record');
  }
  if (item.task_type === TASK_TYPES.COMPLETION) {
    // The answer is an interpretation of a status code, so compare the label
    // mapping instead of the rendered option text.
    const status = normalizeComparable(item.evidence?.original_text);
    const expected = item.ground_truth?.label === 'completed' ? 'completed' : 'terminated';
    const matchesStatus = status === 'completed'
      ? expected === 'completed'
      : ['terminated', 'withdrawn', 'suspended'].includes(status) && expected === 'terminated';
    if (!matchesStatus) {
      return FAIL('evidence_consistency', `status "${item.evidence?.original_text}" does not support label "${item.ground_truth?.label}"`);
    }
    return OK('evidence_consistency', `status ${item.evidence?.original_text} → ${item.ground_truth?.label} · version ${clip(version, 40)}`);
  }
  const answerText = normalizeComparable(item.options?.[item.ground_truth?.answer]);
  const evidenceText = normalizeComparable(item.evidence?.original_text);
  if (!answerText || !evidenceText) return FAIL('evidence_consistency', 'option or evidence text is empty');
  if (answerText !== evidenceText) return FAIL('evidence_consistency', 'answer option diverges from the recorded evidence text');
  return OK('evidence_consistency', `verbatim match · version ${clip(version, 40)}`);
}

/**
 * Run every deterministic quality rule.
 * LLM-assisted review is intentionally separate (`quality.llm_review`).
 */
export function runQualityChecks(item, record) {
  const checks = [
    checkTraceability(item, record),
    checkUniqueness(item),
    checkCompleteness(item),
    checkOptions(item),
    checkLeakage(item),
    checkEvidence(item, record),
  ];
  const failures = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  let status = QUALITY_STATUS.VALID;
  if (failures.length) status = QUALITY_STATUS.INVALID;
  else if (warnings.length) status = QUALITY_STATUS.NEEDS_REVIEW;

  // Experimental tasks cannot be officially valid until temporal evidence exists.
  if (item.quality?.temporal_validation_required && status === QUALITY_STATUS.VALID) {
    status = QUALITY_STATUS.NEEDS_REVIEW;
    checks.push({
      rule: 'temporal_validation',
      status: 'warn',
      detail: 'no pre-outcome registry snapshot is available for this record',
    });
  }
  if (item.quality?.synthetic_distractors && status === QUALITY_STATUS.VALID) {
    status = QUALITY_STATUS.NEEDS_REVIEW;
    checks.push({
      rule: 'distractor_provenance',
      status: 'warn',
      detail: 'at least one distractor was produced by mutating a real criterion',
    });
  }

  return {
    status,
    checks,
    counts: {
      rules: QC_RULES.length,
      passed: checks.filter((check) => check.status === 'pass').length,
      warnings: warnings.length,
      failures: failures.length,
    },
    checked_at: new Date().toISOString(),
  };
}
