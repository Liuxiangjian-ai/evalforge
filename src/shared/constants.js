/**
 * Shared constants for EvalForge.
 *
 * These values appear in exported benchmark files and reports, so treat them
 * as a public contract: version them rather than renaming in place.
 */

export const PLUGIN_VERSION = '0.1.0';
export const NAMESPACE = 'evalforge';
export const API_PREFIX = '/api/evalforge';
export const BENCHMARK_SCHEMA_VERSION = '0.1.0';

export const TASK_TYPES = /** @type {const} */ ({
  ENDPOINT: 'endpoint_selection',
  ELIGIBILITY: 'eligibility_criteria_matching',
  COMPLETION: 'trial_completion_prediction',
});

export const TASK_LABELS = {
  [TASK_TYPES.ENDPOINT]: 'Primary Endpoint Selection',
  [TASK_TYPES.ELIGIBILITY]: 'Eligibility Criteria Matching',
  [TASK_TYPES.COMPLETION]: 'Trial Completion Prediction (experimental)',
};

/** Quality buckets a generated item can land in. Only `valid` is officially evaluated. */
export const QUALITY_STATUS = /** @type {const} */ ({
  VALID: 'valid',
  NEEDS_REVIEW: 'needs_review',
  INVALID: 'invalid',
});

/** Deterministic quality-control rules. Semantic LLM review is recorded separately. */
export const QC_RULES = [
  'gt_traceability',
  'answer_uniqueness',
  'question_completeness',
  'option_validity',
  'data_leakage',
  'evidence_consistency',
];

export const ANSWER_LABELS = ['A', 'B', 'C', 'D'];

export const DEFAULT_FETCH = {
  condition: 'Type 2 Diabetes',
  phases: [],
  studyTypes: ['INTERVENTIONAL'],
  statuses: [],
  maxRecords: 100,
};

export const STUDY_STATUSES = [
  'RECRUITING',
  'ACTIVE_NOT_RECRUITING',
  'COMPLETED',
  'TERMINATED',
  'WITHDRAWN',
  'SUSPENDED',
  'NOT_YET_RECRUITING',
  'ENROLLING_BY_INVITATION',
  'UNKNOWN',
];

export const STUDY_TYPES = ['INTERVENTIONAL', 'OBSERVATIONAL', 'EXPANDED_ACCESS'];

export const PHASES = [
  'EARLY_PHASE1',
  'PHASE1',
  'PHASE2',
  'PHASE3',
  'PHASE4',
  'NA',
];

/** US National Library of Medicine public registry; no patient-level data is used. */
export const CTGOV_API = 'https://clinicaltrials.gov/api/v2/studies';
export const CTGOV_STUDY_URL = (nctId) => `https://clinicaltrials.gov/study/${nctId}`;

/**
 * Fields whose presence in a *completion* prompt would leak the outcome label.
 * The generator refuses to emit an item when any of these appear in the query.
 */
export const COMPLETION_LEAK_PATTERNS = [
  /\bcompleted?\b/i,
  /\bterminat(ed|ion)\b/i,
  /\bwithdrawn\b/i,
  /\bsuspended\b/i,
  /\bwhy\s*stopped\b/i,
  /\bstudy\s+results?\b/i,
  /\bhas\s+results\b/i,
  /\bfinal\s+enrollment\b/i,
  /\bactual\s+enrollment\b/i,
];

export const DEFAULT_EVAL = {
  temperature: 0.2,
  // Reasoning models spend output tokens before the visible answer; a small cap
  // truncates them into an empty completion, which would be scored as a failure.
  maxTokens: 8192,
  concurrency: 3,
  retries: 2,
  timeoutMs: 120000,
  repeats: 1,
  shuffleOptions: false,
};

/** Prompt is frozen per run so results stay reproducible. */
export const PROMPT_VERSION = 'evalforge-mcq-v2';

export const SYSTEM_PROMPT =
  'You are answering a multiple-choice question about a registered clinical trial. '
  + 'Use only the information in the question. Do not use tools and do not ask clarifying questions.';

export function mcqInstruction() {
  return [
    'Answer the question by choosing exactly one option.',
    // Long option sets tempt reasoning models into restating every candidate,
    // which can exhaust the output budget before they emit a label.
    'Decide directly. Do not restate, quote, or compare the options at length.',
    'Reply with a single line in the form: 答案: X',
    'X must be one of A, B, C, D. Do not add explanations.',
  ].join('\n');
}
