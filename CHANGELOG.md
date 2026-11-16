# Changelog

All notable changes to EvalForge are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-16

First public release.

### Added

- DeepSeek Harness plugin (Host + Client halves) that mounts a five-tab page and
  an authenticated API under `/api/evalforge`.
- ClinicalTrials.gov API v2 collector: condition/phase/study-type/status filters,
  pagination, rate-limit backoff, retry with `Retry-After`, NCT de-duplication,
  record-version tracking, raw payload retention and missing-field flags.
- Three benchmark generators (primary endpoint selection, eligibility criteria
  matching, experimental completion prediction) with registry-derived ground
  truth, same-domain distractors, near-duplicate and length-shortcut guards.
- Six deterministic quality rules with `valid` / `needs_review` / `invalid`
  buckets; only valid items are evaluated by default.
- Unified model gateway: native Harness `ctx.llm` providers and OpenAI-compatible
  endpoints whose keys live in the Harness credential store.
- Resumable evaluation runner with concurrency, retries, hard timeouts,
  cancellation, option shuffling and per-cell persistence.
- Exact-match scoring that never counts API failures or unparsable replies as
  wrong answers; reasoning-truncation recovery is flagged explicitly.
- Meta-evaluation: accuracy, macro-F1, difficulty, discrimination (declared or
  exploratory), version monotonicity, repeat stability, contentious items and
  failure statistics.
- Exports: `benchmark.jsonl`, `eval_results.csv`, `eval_results.json`,
  `meta_eval_report.md`.
- 70 automated tests, a static plugin check, and a headless self-test harness.
- Real example artifacts generated from 40 registry records and two live models
  (`examples/`), with the full validation log in `docs/validation.md`.

### Notes

- The project was renamed from *MedEval Factory* to **EvalForge** before the
  first public release. Item identifiers keep the `MED-` prefix so previously
  exported benchmarks stay comparable.
- Completion prediction remains experimental: no pre-outcome registry snapshot
  is available, so those items are never treated as prospective predictions.
