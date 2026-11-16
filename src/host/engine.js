import { BENCHMARK_SCHEMA_VERSION, DEFAULT_EVAL, PLUGIN_VERSION, QUALITY_STATUS, TASK_TYPES } from '../shared/constants.js';
import { nowIso, sha256Hex, stableStringify } from '../shared/text.js';
import { collectTrials, summarizeRecord } from './ctgov.js';
import { generateBenchmark } from './benchmark.js';
import { buildMetaEvaluation } from './metrics.js';
import { RunExecutor, newRunId, selectableItems } from './runner.js';
import { buildMarkdownReport, benchmarkJsonl, reportFilenames, toCsv } from './report.js';

const BENCHMARK_HASH_FIELDS = (benchmark) => ({
  id: benchmark.id,
  version: benchmark.version,
  items: (benchmark.items || []).map((item) => ({
    id: item.id,
    task_type: item.task_type,
    query: item.query,
    options: item.options,
    answer: item.ground_truth?.answer,
    evidence: item.evidence?.nct_id,
  })),
});

export function benchmarkHash(benchmark) {
  return sha256Hex(stableStringify(BENCHMARK_HASH_FIELDS(benchmark)));
}

function slug(value) {
  return String(value || 'benchmark')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'benchmark';
}

export class EvalForgeEngine {
  constructor(ctx, { store, gateway, config = {} }) {
    this.ctx = ctx;
    this.store = store;
    this.gateway = gateway;
    this.config = config || {};
    this.executor = new RunExecutor({ store, gateway, logger: ctx?.logger || null });
    this.lastFetch = null;
  }

  dispose() {
    this.executor.dispose();
  }

  /* ---------------------------- bootstrap ---------------------------- */

  async bootstrap() {
    const config = this.store.getConfig();
    const corpus = this.store.corpusStats();
    const benchmarks = this.store.listBenchmarks();
    const runs = this.store.listRuns(30);
    const providers = this.gateway.listProviders();
    let catalog = [];
    let catalogError = '';
    try {
      catalog = await this.gateway.listNativeCatalog();
    } catch (err) {
      catalogError = String(err?.message || err);
    }
    return {
      plugin: { name: 'dsh-plugin-evalforge', version: PLUGIN_VERSION, schema: BENCHMARK_SCHEMA_VERSION },
      config,
      corpus,
      benchmarks,
      runs,
      providers,
      native_models: catalog,
      native_available: this.gateway.nativeAvailable,
      catalog_error: catalogError,
      data: this.store.describe(),
      task_types: TASK_TYPES,
      quality_statuses: QUALITY_STATUS,
      defaults: DEFAULT_EVAL,
    };
  }

  /* ------------------------------ data ------------------------------- */

  async fetchTrials(params = {}) {
    const result = await collectTrials({
      condition: params.condition,
      phases: params.phases,
      studyTypes: params.studyTypes,
      statuses: params.statuses,
      maxRecords: params.maxRecords,
      retries: params.retries,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
    let ingested = { added: 0, updated: 0, total: this.store.loadCorpus().trials.length };
    if (result.records.length) {
      ingested = this.store.ingestTrials(result.records, result.batch);
    }
    this.lastFetch = result.batch;
    this.store.saveConfig({ last_fetch: result.batch });
    return {
      batch: result.batch,
      ingested,
      trials: result.records.map(summarizeRecord),
      summary: this.store.corpusStats(),
      warnings: result.warnings,
      errors: result.errors,
    };
  }

  listTrials(filter) {
    const page = this.store.listTrials(filter);
    return {
      ...page,
      trials: page.trials.map((trial) => ({
        ...summarizeRecord(trial),
        brief_summary: trial.brief_summary?.slice(0, 320) || '',
        interventions: (trial.interventions || []).map((item) => item.name).slice(0, 4),
      })),
      summary: this.store.corpusStats(),
    };
  }

  getTrial(nctId) {
    const record = this.store.getTrial(nctId);
    if (!record) throw Object.assign(new Error(`trial ${nctId} is not in the local corpus`), { statusCode: 404 });
    return { trial: record };
  }

  deleteTrial(nctId) {
    return this.store.deleteTrial(nctId);
  }

  /* ---------------------------- benchmarks --------------------------- */

  generate(params = {}) {
    const ids = Array.isArray(params.nct_ids) ? params.nct_ids : [];
    const records = ids.length ? this.store.getTrialsByIds(ids) : this.store.loadCorpus().trials;
    if (!records.length) {
      throw Object.assign(new Error('no trials selected; fetch trials or select records first'), { statusCode: 409 });
    }
    const config = {
      task_types: params.task_types,
      per_task: params.per_task,
      seed: params.seed,
      drop_invalid: params.drop_invalid,
      include_experimental: params.include_experimental,
    };
    const startId = this.store.nextItemId(0) + 1;
    const { items, rejected, stats } = generateBenchmark({ records, config, startId });
    if (items.length) this.store.nextItemId(items.length);

    const stamp = new Date().toISOString().slice(0, 10);
    const conditionLabel = params.condition_label || params.label || (records[0]?.conditions || [])[0] || 'mixed';
    const conditionSlug = slug(conditionLabel);
    const id = `evalforge-${conditionSlug}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const taskMix = {};
    for (const item of items) taskMix[item.task_type] = (taskMix[item.task_type] || 0) + 1;
    const benchmark = {
      id,
      name: params.name || `EvalForge ${conditionSlug} ${stamp}`,
      version: '0.1.0',
      benchmark_schema_version: BENCHMARK_SCHEMA_VERSION,
      created_at: nowIso(),
      source: 'clinicaltrials.gov',
      generator: {
        method: 'rule-based extraction + deterministic option assembly',
        task_types: Object.keys(taskMix),
        seed: config.seed ?? 42,
        per_task: config.per_task ?? 10,
        llm_used_for_ground_truth: false,
      },
      source_summary: {
        registry: 'ClinicalTrials.gov API v2',
        conditions: [...new Set(records.flatMap((record) => (record.conditions || []).slice(0, 1)))].slice(0, 8),
        trials: records.length,
        used_trials: new Set(items.map((item) => item.evidence?.nct_id)).size,
        fetched_at: records[0]?.source?.fetched_at || '',
        id_range: items.length ? `${items[0].id} … ${items[items.length - 1].id}` : '',
      },
      task_mix: taskMix,
      items,
      rejected,
      stats,
      prompt_version: items[0]?.prompt_version || '',
    };
    benchmark.hash = benchmarkHash(benchmark);
    this.store.saveBenchmark(benchmark);
    return { benchmark, stats, rejected: rejected.slice(0, 50) };
  }

  listBenchmarks() {
    return this.store.listBenchmarks();
  }

  getBenchmark(id) {
    const benchmark = this.store.getBenchmark(id);
    if (!benchmark) throw Object.assign(new Error(`benchmark ${id} not found`), { statusCode: 404 });
    return benchmark;
  }

  deleteBenchmark(id) {
    return this.store.deleteBenchmark(id);
  }

  updateItem(payload = {}) {
    const benchmark = this.getBenchmark(payload.benchmark_id);
    const index = benchmark.items.findIndex((item) => item.id === payload.item_id);
    if (index < 0) throw Object.assign(new Error(`item ${payload.item_id} not found`), { statusCode: 404 });
    const item = benchmark.items[index];
    if (typeof payload.query === 'string' && payload.query.trim()) item.query = payload.query.trim();
    if (payload.options && typeof payload.options === 'object') {
      for (const [label, value] of Object.entries(payload.options)) {
        if (label in item.options && typeof value === 'string' && value.trim()) item.options[label] = value.trim();
      }
    }
    if (typeof payload.answer === 'string' && payload.answer in item.options) {
      item.ground_truth.answer = payload.answer;
    }
    if (payload.quality_status && Object.values(QUALITY_STATUS).includes(payload.quality_status)) {
      item.quality.status = payload.quality_status;
    }
    item.quality.expert_reviewed = payload.expert_reviewed === true;
    item.edited_at = nowIso();
    item.edited_fields = Object.keys(payload).filter((key) => !['benchmark_id', 'item_id'].includes(key));
    benchmark.items[index] = item;
    benchmark.updated_at = nowIso();
    benchmark.hash = benchmarkHash(benchmark);
    this.store.saveBenchmark(benchmark);
    return { item, benchmark };
  }

  deleteItem(payload = {}) {
    const benchmark = this.getBenchmark(payload.benchmark_id);
    const before = benchmark.items.length;
    benchmark.items = benchmark.items.filter((item) => item.id !== payload.item_id);
    benchmark.hash = benchmarkHash(benchmark);
    this.store.saveBenchmark(benchmark);
    return { removed: before - benchmark.items.length, remaining: benchmark.items.length, hash: benchmark.hash };
  }

  /* ------------------------------ models ----------------------------- */

  async listModels() {
    const config = this.store.getConfig();
    const native = await this.gateway.listNativeCatalog();
    const keys = [];
    for (const model of config.models || []) {
      if (model.apiKeyRef) keys.push(await this.gateway.describeKey(model.apiKeyRef));
    }
    return {
      models: config.models || [],
      settings: config.settings,
      native_models: native,
      native_available: this.gateway.nativeAvailable,
      keys,
    };
  }

  saveModels(payload = {}) {
    const patch = {};
    if (Array.isArray(payload.models)) {
      patch.models = payload.models.map((model, index) => ({
        id: model.id || `model-${index + 1}`,
        kind: model.kind === 'openai' ? 'openai' : 'native',
        label: String(model.label || model.model || `Model ${index + 1}`).slice(0, 120),
        provider: String(model.provider || '').slice(0, 120),
        model: String(model.model || '').slice(0, 160),
        baseUrl: String(model.baseUrl || '').slice(0, 300),
        apiKeyRef: String(model.apiKeyRef || '').slice(0, 80),
        temperature: Number.isFinite(Number(model.temperature)) ? Number(model.temperature) : DEFAULT_EVAL.temperature,
        maxTokens: Number.isFinite(Number(model.maxTokens)) ? Number(model.maxTokens) : DEFAULT_EVAL.maxTokens,
        timeoutMs: Number.isFinite(Number(model.timeoutMs)) ? Number(model.timeoutMs) : DEFAULT_EVAL.timeoutMs,
        enabled: model.enabled !== false,
      }));
    }
    if (payload.settings && typeof payload.settings === 'object') {
      patch.settings = {
        temperature: Number(payload.settings.temperature ?? DEFAULT_EVAL.temperature),
        maxTokens: Number(payload.settings.maxTokens ?? DEFAULT_EVAL.maxTokens),
        concurrency: Math.max(1, Math.min(8, Number(payload.settings.concurrency) || 3)),
        retries: Math.max(0, Math.min(5, Number(payload.settings.retries) || 0)),
        timeoutMs: Math.max(5000, Number(payload.settings.timeoutMs) || DEFAULT_EVAL.timeoutMs),
        repeats: Math.max(1, Math.min(5, Number(payload.settings.repeats) || 1)),
        include_experimental: payload.settings.include_experimental === true,
        include_needs_review: payload.settings.include_needs_review === true,
      };
    }
    const config = this.store.saveConfig(patch);
    return { config };
  }

  async setKey(payload) {
    return this.gateway.setKey(payload);
  }

  async clearKey(ref) {
    return this.gateway.clearKey(ref);
  }

  async keyStatus() {
    const config = this.store.getConfig();
    const refs = [...new Set((config.models || []).map((model) => model.apiKeyRef).filter(Boolean))];
    const keys = [];
    for (const ref of refs) keys.push(await this.gateway.describeKey(ref));
    return { keys };
  }

  async testModel(payload = {}) {
    const model = payload.model || (this.store.getConfig().models || []).find((entry) => entry.id === payload.model_id);
    if (!model) throw new Error('model not found');
    const started = Date.now();
    const response = await this.gateway.chat(
      { kind: model.kind, provider: model.provider, model: model.model, baseUrl: model.baseUrl, apiKeyRef: model.apiKeyRef, label: model.label },
      {
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        temperature: 0,
        maxTokens: 16,
        timeoutMs: Math.min(30000, model.timeoutMs || 30000),
      },
    );
    return { ok: true, text: response.text.slice(0, 200), latency_ms: Date.now() - started, usage: response.usage, model: response.model };
  }

  /* -------------------------------- runs ----------------------------- */

  createRun(payload = {}) {
    const benchmark = this.getBenchmark(payload.benchmark_id);
    const config = this.store.getConfig();
    const ids = Array.isArray(payload.model_ids) && payload.model_ids.length
      ? payload.model_ids
      : (config.models || []).filter((model) => model.enabled !== false).map((model) => model.id);
    const models = (config.models || []).filter((model) => ids.includes(model.id));
    if (!models.length) throw Object.assign(new Error('no configured model was selected'), { statusCode: 409 });
    const settings = {
      ...config.settings,
      ...(payload.settings || {}),
      capability_groups: payload.capability_groups || null,
      version_order: payload.version_order || null,
    };
    const run = this.executor.create({
      benchmark,
      models,
      settings,
      label: payload.label,
      itemIds: payload.item_ids,
    });
    return run;
  }

  startRun(runId) {
    return this.executor.start(runId);
  }

  runStatus(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw Object.assign(new Error(`run ${runId} not found`), { statusCode: 404 });
    return run;
  }

  cancelRun(runId) {
    return this.executor.cancel(runId);
  }

  resumeRun(runId, options) {
    return this.executor.resume(runId, options);
  }

  deleteRun(runId) {
    return this.store.deleteRun(runId);
  }

  listRuns(limit) {
    return this.store.listRuns(limit);
  }

  metaEvaluation(runId) {
    const run = this.runStatus(runId);
    return buildMetaEvaluation(run);
  }

  /* ------------------------------- export ---------------------------- */

  buildArtifacts(runId) {
    const run = this.runStatus(runId);
    const benchmark = this.store.getBenchmark(run.benchmark_id) || null;
    const meta = buildMetaEvaluation(run);
    return {
      run,
      benchmark,
      meta,
      files: {
        'benchmark.jsonl': benchmarkJsonl(benchmark || { items: run.items, id: run.benchmark_id, version: 'snapshot' }),
        'eval_results.csv': toCsv(run),
        'eval_results.json': JSON.stringify({
          generated_at: nowIso(),
          plugin_version: PLUGIN_VERSION,
          run,
          meta,
        }, null, 2),
        'meta_eval_report.md': buildMarkdownReport({ run, benchmark, meta }),
      },
    };
  }

  export(runId, format = 'all') {
    const artifacts = this.buildArtifacts(runId);
    const names = reportFilenames(runId);
    const written = [];
    for (const [name, content] of Object.entries(artifacts.files)) {
      written.push({ name, ...this.store.writeExport(runId, name, content) });
    }
    const map = {
      jsonl: ['benchmark.jsonl', 'application/x-ndjson'],
      benchmark: ['benchmark.jsonl', 'application/x-ndjson'],
      csv: ['eval_results.csv', 'text/csv; charset=utf-8'],
      json: ['eval_results.json', 'application/json; charset=utf-8'],
      markdown: ['meta_eval_report.md', 'text/markdown; charset=utf-8'],
      md: ['meta_eval_report.md', 'text/markdown; charset=utf-8'],
    };
    if (format === 'all') {
      return { files: written, bundle: artifacts.files };
    }
    const entry = map[String(format).toLowerCase()];
    if (!entry) throw Object.assign(new Error(`unsupported export format: ${format}`), { statusCode: 400 });
    const [filename, contentType] = entry;
    return { filename, contentType, body: artifacts.files[filename], files: written, names };
  }

  exportBenchmark(id) {
    const benchmark = this.getBenchmark(id);
    return {
      filename: `${benchmark.id}-benchmark.jsonl`,
      contentType: 'application/x-ndjson',
      body: benchmarkJsonl(benchmark),
    };
  }

  /* --------------------------- quality summary ----------------------- */

  qualitySummary(benchmark) {
    const items = benchmark.items || [];
    const byTask = {};
    for (const item of items) {
      byTask[item.task_type] = byTask[item.task_type] || { total: 0, valid: 0, needs_review: 0, invalid: 0 };
      byTask[item.task_type].total += 1;
      const status = item.quality?.status || 'invalid';
      if (byTask[item.task_type][status] !== undefined) byTask[item.task_type][status] += 1;
    }
    const checks = {};
    for (const item of items) {
      for (const check of item.quality?.checks || []) {
        checks[check.rule] = checks[check.rule] || { pass: 0, warn: 0, fail: 0 };
        if (checks[check.rule][check.status] !== undefined) checks[check.rule][check.status] += 1;
      }
    }
    return { by_task: byTask, checks, selectable: selectableItems(items, this.store.getConfig().settings).length };
  }
}

export { newRunId };
