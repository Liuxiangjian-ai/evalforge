# Contributing to EvalForge

Thanks for taking a look. This project has one non-negotiable rule:

> **Ground truth must come from a verifiable registry field. A model may rewrite a
> question, but it may never produce the answer.**

Anything that weakens that rule will not be merged.

## Ground rules

1. **No fabricated data.** Never add a benchmark item, trial record, evaluation
   score or report that was not produced by the code from a real source. Test
   fixtures must be real, trimmed registry records.
2. **No secrets in the repo.** API keys belong in the Harness credential store.
   Error messages, logs and exports are redacted by `redactSecrets()`; keep it
   that way.
3. **Failures are data.** A failed API call or an unparsable reply is reported
   separately — never scored as a wrong answer.
4. **Small, reviewable changes.** One behaviour per pull request, with a test.

## Development

Requirements: Node 22 or newer. There are no runtime dependencies, so no install
step is needed.

```bash
node scripts/check.mjs                       # manifest, exports, imports, client bundle shape
node --test --test-isolation=none tests/*.test.js
node scripts/e2e.mjs --condition "Type 2 Diabetes" --fetch 40 --per-task 6
```

- `npm test` runs the same test command as CI.
- `npm run e2e` hits the live ClinicalTrials.gov API; everything else is offline.
- On Windows, `tests/llm.test.js` starts a deliberately hanging provider stream;
  the hard deadline keeps the suite under a second, so do not remove that guard.

## Where things live

| Path | Responsibility |
| --- | --- |
| `src/host/ctgov.js` | registry client, normalisation, provenance |
| `src/host/criteria.js` | eligibility text splitting and verifiability scoring |
| `src/host/benchmark.js` | item generation, distractor selection, uniqueness rules |
| `src/host/qc.js` | the six deterministic quality rules |
| `src/host/llm.js` | model gateway (native `ctx.llm` + OpenAI-compatible) |
| `src/host/runner.js` | evaluation execution, retries, cancellation, resume |
| `src/host/metrics.js` | meta-evaluation |
| `src/host/report.js` | JSONL / CSV / JSON / Markdown export |
| `client.js` | browser bundle (no build step; React from the module table) |

## Adding a task type

1. Add the generator to `benchmark.js` returning the item contract documented in
   [`docs/benchmark-format.md`](../docs/benchmark-format.md).
2. Add the field mapping to `qc.js` (`sourceTextFor`) so traceability can be
   checked.
3. Add it to `TASK_TYPES`/`TASK_LABELS` and the task selector.
4. Extend `tests/benchmark.test.js` and `tests/qc.test.js` with a real fixture.

## Reporting problems

Please include the run ID, the benchmark hash and the failing JSONL line. Those
are enough to reproduce an item without sharing credentials.
