import { nowIso } from '../shared/text.js';

const CSV_COLUMNS = [
  'run_id',
  'question_id',
  'task_type',
  'model_id',
  'model_label',
  'repeat',
  'response',
  'parsed_answer',
  'canonical_answer',
  'ground_truth',
  'correct',
  'derived_from_reasoning',
  'latency_ms',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'status',
  'error_code',
  'error_message',
];

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(run) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const cell of run.results || []) {
    rows.push([
      run.id,
      cell.item_id,
      cell.task_type,
      cell.model_id,
      cell.model_label,
      cell.repeat,
      cell.response_text,
      cell.parsed_answer,
      cell.canonical_answer,
      cell.ground_truth,
      cell.status === 'success' ? (cell.correct ? '1' : '0') : '',
      cell.derived_from_reasoning ? '1' : '0',
      cell.latency_ms,
      cell.usage?.prompt_tokens ?? 0,
      cell.usage?.completion_tokens ?? 0,
      cell.usage?.total_tokens ?? 0,
      cell.status,
      cell.error?.code || '',
      cell.error?.message || '',
    ].map(csvCell).join(','));
  }
  return `${rows.join('\n')}\n`;
}

export function toJsonl(items) {
  return `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;
}

export function benchmarkJsonl(benchmark) {
  return toJsonl((benchmark.items || []).map((item) => ({
    id: item.id,
    task_type: item.task_type,
    query: item.query,
    options: item.options,
    ground_truth: item.ground_truth,
    rubric: item.rubric,
    evidence: item.evidence,
    quality: {
      source_verified: item.quality?.source_verified,
      unique_answer: item.quality?.unique_answer,
      expert_reviewed: item.quality?.expert_reviewed,
      temporal_validation_required: item.quality?.temporal_validation_required,
      status: item.quality?.status,
      checks: item.quality?.checks,
    },
    distractor_sources: item.distractor_sources,
    context: item.context,
    benchmark_id: benchmark.id,
    benchmark_version: benchmark.version,
    prompt_version: item.prompt_version,
  })));
}

function pct(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function num(value, digits = 2) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(digits);
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [head, sep, body].filter(Boolean).join('\n');
}

function difficultyHistogram(difficulty) {
  const buckets = [
    { label: '0.00–0.19 (very easy)', min: 0, max: 0.2, count: 0 },
    { label: '0.20–0.39', min: 0.2, max: 0.4, count: 0 },
    { label: '0.40–0.59', min: 0.4, max: 0.6, count: 0 },
    { label: '0.60–0.79', min: 0.6, max: 0.8, count: 0 },
    { label: '0.80–1.00 (very hard)', min: 0.8, max: 1.0001, count: 0 },
  ];
  for (const row of difficulty) {
    if (row.difficulty === null || row.difficulty === undefined) continue;
    const bucket = buckets.find((entry) => row.difficulty >= entry.min && row.difficulty < entry.max);
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

/**
 * Human-readable report. Everything included here is measured from the run;
 * sections without evidence are printed as explicitly unavailable.
 */
export function buildMarkdownReport({ run, benchmark, meta }) {
  const lines = [];
  const models = meta?.models || [];
  const difficulty = meta?.difficulty || [];
  const stability = meta?.stability || [];

  lines.push(`# EvalForge — Evaluation Report`);
  lines.push('');
  lines.push(`Generated: ${nowIso()}`);
  lines.push('');
  lines.push(`- **Run ID**: \`${run.id}\``);
  lines.push(`- **Benchmark**: ${run.benchmark_name} (\`${run.benchmark_id}\`)`);
  lines.push(`- **Run status**: ${run.status}`);
  lines.push(`- **Created**: ${run.created_at}`);
  lines.push(`- **Prompt version**: ${run.prompt_version || 'unknown'}`);
  lines.push(`- **Benchmark schema**: ${run.benchmark_schema_version || benchmark?.benchmark_schema_version || 'unknown'}`);
  lines.push('');

  lines.push('## 1. Data source and provenance');
  lines.push('');
  lines.push('All items were generated from public ClinicalTrials.gov registry records; no patient-level data was used.');
  lines.push('');
  if (benchmark?.source_summary) {
    const source = benchmark.source_summary;
    lines.push(`- **Registry**: ${source.registry || 'ClinicalTrials.gov API v2'}`);
    lines.push(`- **Conditions**: ${(source.conditions || []).join(', ') || '—'}`);
    lines.push(`- **Trials in corpus**: ${source.trials ?? '—'}`);
    lines.push(`- **Trials used as item sources**: ${source.used_trials ?? '—'}`);
    lines.push(`- **Fetch window**: ${source.fetched_at || '—'}`);
    lines.push(`- **Item ID range**: ${source.id_range || '—'}`);
  } else {
    lines.push('- Source summary was not recorded for this benchmark.');
  }
  lines.push('');

  lines.push('## 2. Generation method');
  lines.push('');
  lines.push('Rules extract the ground truth first; language models never produce it.');
  lines.push('');
  lines.push('- **Primary Endpoint Selection** — ground truth is the registered `primaryOutcomes` measure(s); distractors are primary outcomes from other trials of the same condition/phase.');
  lines.push('- **Eligibility Criteria Matching** — ground truth is one registered inclusion (or exclusion) criterion; distractors are same-polarity criteria from other trials, or documented numeric mutations when the corpus is too small.');
  lines.push('- **Trial Completion Prediction** — experimental only: the prompt excludes status, termination reason, completion dates, results and actual enrolment, and every item is marked `temporal_validation_required`.');
  lines.push('- **Quality control** — six deterministic rules (traceability, answer uniqueness, completeness, option validity, leakage, evidence consistency) bucket items into valid / needs review / invalid.');
  lines.push('');

  lines.push('## 3. Benchmark composition');
  lines.push('');
  const items = benchmark?.items || run.items || [];
  const counts = { valid: 0, needs_review: 0, invalid: 0 };
  const taskCounts = {};
  for (const item of items) {
    const status = item.quality?.status || 'unknown';
    if (counts[status] !== undefined) counts[status] += 1;
    taskCounts[item.task_type] = (taskCounts[item.task_type] || 0) + 1;
  }
  lines.push(`- **Items in benchmark**: ${items.length}`);
  lines.push(`- **Valid (officially evaluable)**: ${counts.valid}`);
  lines.push(`- **Needs review**: ${counts.needs_review}`);
  lines.push(`- **Invalid**: ${counts.invalid}`);
  lines.push(`- **Task mix**: ${Object.entries(taskCounts).map(([task, count]) => `${task} (${count})`).join(', ') || '—'}`);
  lines.push(`- **Items evaluated in this run**: ${meta?.sample?.items ?? '—'}`);
  lines.push('');

  lines.push('## 4. Models');
  lines.push('');
  if (models.length) {
    lines.push(table(
      ['Model', 'Provider / model', 'Accuracy', 'Macro-F1', 'Scored', 'Failures', 'Unparsed', 'Mean latency'],
      models.map((row) => [
        row.label,
        `${row.provider || row.kind || ''} / ${row.model}`,
        pct(row.accuracy),
        num(row.macro_f1, 3),
        row.scored,
        row.failures,
        row.unparsed,
        row.mean_latency_ms ? `${row.mean_latency_ms} ms` : '—',
      ]),
    ));
  } else {
    lines.push('No model results were recorded.');
  }
  lines.push('');

  lines.push('## 5. Scoring');
  lines.push('');
  lines.push(`- **Rubric**: exact match on the option label (${run.settings?.temperature ?? '—'} temperature, max ${run.settings?.maxTokens ?? '—'} tokens, ${run.settings?.repeats ?? 1} repeat(s) per item).`);
  lines.push('- API failures and unparsable replies are excluded from the accuracy denominator and counted separately.');
  if (meta?.sample?.reasoning_derived) {
    lines.push(`- ${meta.sample.reasoning_derived} answer(s) were recovered from a reasoning trace cut off by the output-token cap; each is flagged \`derived_from_reasoning\` in the CSV.`);
  }
  lines.push('- Option order is shuffled per repeat when stability mode is on; answers are mapped back to the canonical label before scoring.');
  lines.push('');

  if (meta?.tasks?.length) {
    lines.push('### Accuracy by task');
    lines.push('');
    const modelHeaders = models.map((row) => row.label);
    const rows = meta.tasks.map((task) => [
      task.task_type,
      task.items,
      ...models.map((model) => {
        const entry = task.per_model.find((row) => row.model_id === model.model_id);
        return entry ? `${pct(entry.accuracy)} (n=${entry.n})` : '—';
      }),
    ]);
    lines.push(table(['Task', 'Items', ...modelHeaders], rows));
    lines.push('');
  }

  lines.push('## 6. Item difficulty');
  lines.push('');
  if (difficulty.length) {
    const hist = difficultyHistogram(difficulty);
    lines.push(table(['Difficulty band', 'Items'], hist.map((bucket) => [bucket.label, bucket.count])));
    lines.push('');
    const ranked = [...difficulty].filter((row) => row.difficulty !== null).sort((a, b) => b.difficulty - a.difficulty);
    lines.push('Hardest items:');
    lines.push('');
    lines.push(table(
      ['Item', 'Task', 'Difficulty', 'P(correct)', 'Models'],
      ranked.slice(0, 5).map((row) => [row.item_id, row.task_type, num(row.difficulty), num(row.p_correct), row.n_models]),
    ));
    lines.push('');
  } else {
    lines.push('No item was answered by more than one model, so difficulty cannot be estimated.');
    lines.push('');
  }

  lines.push('## 7. Discrimination and stability');
  lines.push('');
  const mode = meta?.discrimination_mode || 'not_computable';
  if (mode === 'declared') {
    lines.push('- **Formal discrimination**: computed from capability groups declared before the run (P(high) − P(low)).');
  } else if (mode === 'exploratory') {
    lines.push('- **Exploratory discrimination only**: groups were split by this run\'s overall accuracy, so the value describes this sample and is not an independent capability measure.');
  } else {
    lines.push('- **Discrimination unavailable**: fewer than two models produced scorable answers, and no capability groups were declared.');
  }
  const reproducible = (meta?.discrimination || []).filter((row) => row.d !== null)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 8);
  if (reproducible.length) {
    lines.push('');
    lines.push(table(
      ['Item', 'P(high)', 'P(low)', 'D', 'Mode'],
      reproducible.map((row) => [row.item_id, num(row.p_high), num(row.p_low), num(row.d, 3), row.mode]),
    ));
  }
  lines.push('');
  if (stability.length) {
    lines.push(`- **Stability**: ${stability.length} item(s) had repeated samples; mean consistency ${num(
      stability.reduce((sum, row) => sum + (row.consistency || 0), 0) / stability.length,
      3,
    )}.`);
    const orderEffect = stability.filter((row) => row.order_effect !== null);
    if (orderEffect.length) {
      lines.push(`- **Option-order effect**: mean |Δaccuracy| across ${orderEffect.length} item(s) = ${num(
        orderEffect.reduce((sum, row) => sum + row.order_effect, 0) / orderEffect.length,
        3,
      )}.`);
    }
  } else {
    lines.push('- **Stability was not measured**: this run used a single sample per item.');
  }
  lines.push('');

  lines.push('## 8. Version monotonicity');
  lines.push('');
  if (meta?.monotonicity && meta.monotonicity.status !== 'not_computable') {
    lines.push(`- Spearman ρ (declared version order vs accuracy): ${num(meta.monotonicity.rho, 3)}`);
    lines.push(`- Declared order: ${(meta.monotonicity.points || []).map((point) => `${point.label} (${pct(point.accuracy)})`).join(' → ')}`);
    lines.push('- This is descriptive: a family version order is not assumed to imply strictly increasing medical capability.');
  } else {
    lines.push('- No ordered model series was declared for this run, so monotonicity was not measured.');
  }
  lines.push('');

  lines.push('## 9. Failures and limitations');
  lines.push('');
  if (meta?.failures?.length) {
    lines.push(table(
      ['Model', 'Code', 'Count', 'Sample message'],
      meta.failures.map((row) => [row.label, row.code, row.count, String(row.sample || '').replace(/\|/g, '/').slice(0, 120)]),
    ));
    lines.push('');
  } else {
    lines.push('- No API failures were recorded.');
    lines.push('');
  }
  lines.push('- Registry-derived answers describe **historical trial design practice**, not optimal clinical decisions.');
  lines.push('- v0.1 uses exact match only; rubric-based LLM judging is an interface stub, not an active scorer.');
  lines.push('- Completion Prediction is experimental: no pre-outcome registry snapshot is available, so those items are never treated as prospective predictions.');
  lines.push('- Small samples: accuracy with few items is unstable; each table reports its own n.');
  if (meta?.sample) {
    lines.push(`- Sample size: ${meta.sample.items} items × ${meta.sample.models} models = ${meta.sample.cells} cells (${meta.sample.scored} scored).`);
  }
  lines.push('');

  lines.push('## 10. Reproducibility');
  lines.push('');
  lines.push(`- **Run configuration**: temperature ${run.settings?.temperature}, max tokens ${run.settings?.maxTokens}, concurrency ${run.settings?.concurrency}, retries ${run.settings?.retries}, repeats ${run.settings?.repeats}.`);
  lines.push(`- **Models**: ${models.map((row) => `${row.label} (${row.model})`).join(', ') || '—'}`);
  lines.push(`- **Benchmark hash**: ${run.benchmark_hash || '—'}`);
  lines.push('- **Exports**: `benchmark.jsonl`, `eval_results.csv`, `eval_results.json`, `meta_eval_report.md`.');
  lines.push('');
  return lines.join('\n');
}

export function reportFilenames(runId) {
  return {
    benchmark: 'benchmark.jsonl',
    csv: 'eval_results.csv',
    json: 'eval_results.json',
    markdown: 'meta_eval_report.md',
  };
}
