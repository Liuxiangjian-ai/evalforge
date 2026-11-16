# EvalForge — Evaluation Report

Generated: 2026-11-16T14:11:41.339Z

- **Run ID**: `run-20261116140420-yydlyz`
- **Benchmark**: EvalForge Type 2 Diabetes v0.1 (`evalforge-type-2-diabetes-2026-11-16-7ste`)
- **Run status**: completed_with_errors
- **Created**: 2026-11-16T14:04:20.386Z
- **Prompt version**: evalforge-mcq-v2
- **Benchmark schema**: 0.1.0

## 1. Data source and provenance

All items were generated from public ClinicalTrials.gov registry records; no patient-level data was used.

- **Registry**: ClinicalTrials.gov API v2
- **Conditions**: Obesity, Overweight or Obesity, Type 2 Diabetes, Type 2 Diabetes Mellitus (T2DM), Type 1 Diabetes Mellitus, Diabetes Mellitus, Type 2, Type 2 Diabetes Mellitus, Type II Diabetes Mellitus
- **Trials in corpus**: 40
- **Trials used as item sources**: 6
- **Fetch window**: 2026-11-14T13:03:24.764Z
- **Item ID range**: MED-000050 … MED-000061

## 2. Generation method

Rules extract the ground truth first; language models never produce it.

- **Primary Endpoint Selection** — ground truth is the registered `primaryOutcomes` measure(s); distractors are primary outcomes from other trials of the same condition/phase.
- **Eligibility Criteria Matching** — ground truth is one registered inclusion (or exclusion) criterion; distractors are same-polarity criteria from other trials, or documented numeric mutations when the corpus is too small.
- **Trial Completion Prediction** — experimental only: the prompt excludes status, termination reason, completion dates, results and actual enrolment, and every item is marked `temporal_validation_required`.
- **Quality control** — six deterministic rules (traceability, answer uniqueness, completeness, option validity, leakage, evidence consistency) bucket items into valid / needs review / invalid.

## 3. Benchmark composition

- **Items in benchmark**: 12
- **Valid (officially evaluable)**: 12
- **Needs review**: 0
- **Invalid**: 0
- **Task mix**: endpoint_selection (6), eligibility_criteria_matching (6)
- **Items evaluated in this run**: 12

## 4. Models

| Model | Provider / model | Accuracy | Macro-F1 | Scored | Failures | Unparsed | Mean latency |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-account · DeepSeek-V4.1-Flash | deepseek-account / deepseek-flash | 75.0% | 0.732 | 12 | 0 | 0 | 16102 ms |
| deepseek-account · DeepSeek-V4-Pro | deepseek-account / deepseek-v4-pro | 72.7% | 0.724 | 11 | 1 | 0 | 33472 ms |

## 5. Scoring

- **Rubric**: exact match on the option label (0.2 temperature, max 8192 tokens, 1 repeat(s) per item).
- API failures and unparsable replies are excluded from the accuracy denominator and counted separately.
- 5 answer(s) were recovered from a reasoning trace cut off by the output-token cap; each is flagged `derived_from_reasoning` in the CSV.
- Option order is shuffled per repeat when stability mode is on; answers are mapped back to the canonical label before scoring.

### Accuracy by task

| Task | Items | deepseek-account · DeepSeek-V4.1-Flash | deepseek-account · DeepSeek-V4-Pro |
| --- | --- | --- | --- |
| endpoint_selection | 6 | 100.0% (n=6) | 100.0% (n=6) |
| eligibility_criteria_matching | 6 | 50.0% (n=6) | 40.0% (n=5) |

## 6. Item difficulty

| Difficulty band | Items |
| --- | --- |
| 0.00–0.19 (very easy) | 8 |
| 0.20–0.39 | 0 |
| 0.40–0.59 | 2 |
| 0.60–0.79 | 0 |
| 0.80–1.00 (very hard) | 2 |

Hardest items:

| Item | Task | Difficulty | P(correct) | Models |
| --- | --- | --- | --- | --- |
| MED-000060 | eligibility_criteria_matching | 1.00 | 0.00 | 2 |
| MED-000061 | eligibility_criteria_matching | 1.00 | 0.00 | 2 |
| MED-000057 | eligibility_criteria_matching | 0.50 | 0.50 | 2 |
| MED-000059 | eligibility_criteria_matching | 0.50 | 0.50 | 2 |
| MED-000050 | endpoint_selection | 0.00 | 1.00 | 2 |

## 7. Discrimination and stability

- **Exploratory discrimination only**: groups were split by this run's overall accuracy, so the value describes this sample and is not an independent capability measure.

| Item | P(high) | P(low) | D | Mode |
| --- | --- | --- | --- | --- |
| MED-000057 | 0.00 | 1.00 | -1.000 | exploratory |
| MED-000059 | 1.00 | 0.00 | 1.000 | exploratory |
| MED-000050 | 1.00 | 1.00 | 0.000 | exploratory |
| MED-000051 | 1.00 | 1.00 | 0.000 | exploratory |
| MED-000052 | 1.00 | 1.00 | 0.000 | exploratory |
| MED-000053 | 1.00 | 1.00 | 0.000 | exploratory |
| MED-000054 | 1.00 | 1.00 | 0.000 | exploratory |
| MED-000055 | 1.00 | 1.00 | 0.000 | exploratory |

- **Stability was not measured**: this run used a single sample per item.

## 8. Version monotonicity

- No ordered model series was declared for this run, so monotonicity was not measured.

## 9. Failures and limitations

| Model | Code | Count | Sample message |
| --- | --- | --- | --- |
| deepseek-account · DeepSeek-V4-Pro | TIMEOUT | 1 | deepseek-account · DeepSeek-V4-Pro timed out after 120000ms |

- Registry-derived answers describe **historical trial design practice**, not optimal clinical decisions.
- v0.1 uses exact match only; rubric-based LLM judging is an interface stub, not an active scorer.
- Completion Prediction is experimental: no pre-outcome registry snapshot is available, so those items are never treated as prospective predictions.
- Small samples: accuracy with few items is unstable; each table reports its own n.
- Sample size: 12 items × 2 models = 24 cells (23 scored).

## 10. Reproducibility

- **Run configuration**: temperature 0.2, max tokens 8192, concurrency 3, retries 1, repeats 1.
- **Models**: deepseek-account · DeepSeek-V4.1-Flash (deepseek-flash), deepseek-account · DeepSeek-V4-Pro (deepseek-v4-pro)
- **Benchmark hash**: 00fa7d88055bcea2e80a4969ad5df90ee80fc847fc8c6ef03b6b27b86cbf1c77
- **Exports**: `benchmark.jsonl`, `eval_results.csv`, `eval_results.json`, `meta_eval_report.md`.
