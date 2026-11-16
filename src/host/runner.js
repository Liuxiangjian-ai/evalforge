import { DEFAULT_EVAL, PROMPT_VERSION, QUALITY_STATUS, TASK_TYPES } from '../shared/constants.js';
import { backoffDelay, nowIso, parseAnswer, redactSecrets, sleep } from '../shared/text.js';
import { ModelError } from './llm.js';
import { buildMcqPrompt } from './prompt.js';

export function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Exact-match scoring after translating the displayed label back to canonical. */
export function scoreResponse(item, displayedLabel, optionMap) {
  const canonical = optionMap?.[displayedLabel] || displayedLabel;
  return {
    canonical_label: canonical,
    answer: item.ground_truth?.answer || '',
    correct: canonical === item.ground_truth?.answer,
  };
}

export function cellKey(itemId, modelId, repeat) {
  return `${itemId}|${modelId}|${repeat}`;
}

/** Which items a run may use, given its quality policy. */
export function selectableItems(items, settings = {}) {
  const allowReview = settings.include_needs_review === true;
  const allowInvalid = settings.include_invalid === true;
  const allowExperimental = settings.include_experimental === true;
  return items.filter((item) => {
    if (item.quality?.experimental && !allowExperimental) return false;
    if (item.quality?.status === QUALITY_STATUS.VALID) return true;
    if (item.quality?.status === QUALITY_STATUS.NEEDS_REVIEW && allowReview) return true;
    if (item.quality?.status === QUALITY_STATUS.INVALID && allowInvalid) return true;
    return false;
  });
}

function compactItem(item) {
  return {
    id: item.id,
    task_type: item.task_type,
    query: item.query,
    options: item.options,
    ground_truth: item.ground_truth,
    evidence: {
      nct_id: item.evidence?.nct_id,
      source_url: item.evidence?.source_url,
      source_field: item.evidence?.source_field,
      record_version: item.evidence?.record_version,
    },
    quality: {
      status: item.quality?.status,
      experimental: item.quality?.experimental === true,
      temporal_validation_required: item.quality?.temporal_validation_required === true,
    },
    context: item.context || {},
  };
}

export class RunExecutor {
  constructor({ store, gateway, logger = null }) {
    this.store = store;
    this.gateway = gateway;
    this.logger = logger;
    this.active = new Map();
  }

  dispose() {
    for (const [, state] of this.active) {
      try {
        state.controller.abort();
      } catch {
        // best-effort
      }
    }
    this.active.clear();
  }

  create({ benchmark, models, settings = {}, label = '', itemIds = null }) {
    if (!benchmark) throw new Error('benchmark is required');
    const specs = (models || []).filter((model) => model && model.model);
    if (specs.length < 1) throw new Error('select at least one model');
    if (specs.length > 8) throw new Error('at most 8 models per run');
    const merged = { ...DEFAULT_EVAL, ...settings };
    let items = selectableItems(benchmark.items || [], merged);
    if (Array.isArray(itemIds) && itemIds.length) {
      const wanted = new Set(itemIds);
      items = items.filter((item) => wanted.has(item.id));
    }
    if (items.length === 0) {
      throw new Error('no items pass the current quality policy; relax the policy or generate more items');
    }
    const id = newRunId();
    const run = {
      id,
      label: label || `${benchmark.name} · ${new Date().toLocaleString()}`,
      status: 'queued',
      created_at: nowIso(),
      updated_at: nowIso(),
      benchmark_id: benchmark.id,
      benchmark_name: benchmark.name,
      benchmark_hash: benchmark.hash || '',
      benchmark_schema_version: benchmark.benchmark_schema_version || '',
      prompt_version: PROMPT_VERSION,
      models: specs.map((spec) => ({
        id: spec.id,
        kind: spec.kind,
        label: spec.label,
        provider: spec.provider,
        model: spec.model,
        base_url: spec.baseUrl || '',
        key_ref: spec.apiKeyRef || '',
        temperature: spec.temperature ?? merged.temperature,
        max_tokens: spec.maxTokens ?? merged.maxTokens,
        timeout_ms: spec.timeoutMs ?? merged.timeoutMs,
      })),
      settings: {
        temperature: merged.temperature,
        maxTokens: merged.maxTokens,
        concurrency: merged.concurrency,
        retries: merged.retries,
        timeoutMs: merged.timeoutMs,
        repeats: merged.repeats,
        shuffle_options: merged.shuffle_options === true,
        include_needs_review: merged.include_needs_review === true,
        include_invalid: merged.include_invalid === true,
        include_experimental: merged.include_experimental === true,
      },
      capability_groups: merged.capability_groups || null,
      version_order: merged.version_order || null,
      items: items.map(compactItem),
      results: [],
      events: [{ at: nowIso(), level: 'info', message: `Created run with ${items.length} items × ${specs.length} models.` }],
      progress: { total: 0, done: 0, success: 0, error: 0, parse_failed: 0, percent: 0 },
      cancel_requested: false,
      error: '',
    };
    run.progress.total = run.items.length * run.models.length * Math.max(1, run.settings.repeats);
    this.store.saveRun(run);
    return run;
  }

  get(runId) {
    return this.store.getRun(runId);
  }

  event(run, message, level = 'info') {
    run.events.push({ at: nowIso(), level, message: redactSecrets(message) });
    if (run.events.length > 240) run.events = run.events.slice(-240);
  }

  progress(run) {
    const results = run.results || [];
    const success = results.filter((cell) => cell.status === 'success').length;
    const parseFailed = results.filter((cell) => cell.status === 'parse_failed').length;
    const error = results.filter((cell) => cell.status === 'error').length;
    const done = results.length;
    run.progress = {
      total: run.progress?.total || run.items.length * run.models.length * Math.max(1, run.settings.repeats),
      done,
      success,
      parse_failed: parseFailed,
      error,
      percent: run.progress?.total ? Math.round((done / run.progress.total) * 1000) / 10 : 0,
    };
    return run.progress;
  }

  /** Start (or resume) a run. Returns immediately; the caller polls `get`. */
  start(runId, { resume = false } = {}) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (this.active.has(runId)) throw new Error('this run is already executing');
    if (!resume && run.status === 'completed') throw new Error('run already completed');
    run.status = 'running';
    run.error = '';
    run.cancel_requested = false;
    this.event(run, resume ? 'Resuming interrupted run.' : 'Starting evaluation.');
    this.store.saveRun(run);
    const state = { controller: new AbortController(), cancelled: false };
    // One shared abort promise: every in-flight cell races against it, so a
    // cancel releases all workers even if an adapter ignores the signal.
    state.aborted = new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'ABORTED', name: 'AbortError' }));
      if (state.controller.signal.aborted) abort();
      else state.controller.signal.addEventListener('abort', abort, { once: true });
    });
    state.aborted.catch(() => {});
    this.active.set(runId, state);
    this.loop(run, state).catch((err) => {
      const fresh = this.store.getRun(runId) || run;
      fresh.status = 'failed';
      fresh.error = redactSecrets(err?.message || String(err));
      this.event(fresh, `Run failed: ${fresh.error}`, 'error');
      this.store.saveRun(fresh);
    }).finally(() => {
      this.active.delete(runId);
    });
    return this.store.getRun(runId);
  }

  async loop(run, state) {
    const executed = new Set((run.results || []).filter((cell) => cell.status === 'success' || cell.status === 'parse_failed').map((cell) => cell.cell_key));
    const pending = [];
    for (const item of run.items) {
      for (const model of run.models) {
        for (let repeat = 0; repeat < Math.max(1, run.settings.repeats); repeat += 1) {
          const key = cellKey(item.id, model.id, repeat);
          if (executed.has(key)) continue;
          pending.push({ item, model, repeat, key });
        }
      }
    }
    this.event(run, `${pending.length} cells pending.`);

    const concurrency = Math.max(1, Math.min(8, Number(run.settings.concurrency) || 3));
    let cursor = 0;
    let completedSinceSave = 0;
    const saveEvery = 3;

    const worker = async () => {
      for (;;) {
        if (state.cancelled || run.cancel_requested) return;
        const index = cursor;
        cursor += 1;
        if (index >= pending.length) return;
        const cell = pending[index];
        const result = await this.executeCell(run, cell, state);
        const existing = run.results.find((entry) => entry.cell_key === result.cell_key);
        if (existing) Object.assign(existing, result);
        else run.results.push(result);
        this.progress(run);
        completedSinceSave += 1;
        if (completedSinceSave >= saveEvery) {
          completedSinceSave = 0;
          this.store.saveRun(run);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker));

    if (state.cancelled || run.cancel_requested) {
      run.status = 'cancelled';
      this.event(run, 'Run cancelled by the user.', 'warn');
    } else {
      const failures = (run.results || []).filter((cell) => cell.status === 'error').length;
      run.status = failures > 0 ? 'completed_with_errors' : 'completed';
      this.event(run, `Run finished: ${run.progress.success} scored, ${run.progress.parse_failed} unparsed, ${failures} failed.`, failures ? 'warn' : 'info');
    }
    this.progress(run);
    this.store.saveRun(run);
  }

  async executeCell(run, { item, model, repeat, key }, state) {
    const settings = run.settings;
    // The seed includes the repeat so repeated samples are genuinely different
    // presentations, which is what the stability metric needs.
    const effective = buildMcqPrompt(item, { shuffle: settings.shuffle_options === true, seed: `repeat-${repeat}` });
    const base = {
      cell_key: key,
      item_id: item.id,
      task_type: item.task_type,
      model_id: model.id,
      model_label: model.label,
      model: model.model,
      repeat,
      option_map: effective.option_map,
      display_order: effective.display_order,
      prompt_sha256: effective.prompt_sha256,
      started_at: nowIso(),
    };
    const attempts = Math.max(0, Number(settings.retries) || 0) + 1;
    let lastError = null;
    let attemptsUsed = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (state.cancelled) break;
      attemptsUsed = attempt + 1;
      try {
        // Cancellation must not depend on the model adapter honouring the
        // signal: race the call against the run's abort promise so a user
        // cancel releases the worker immediately.
        const response = await Promise.race([
          this.gateway.chat(
            {
              kind: model.kind,
              provider: model.provider,
              model: model.model,
              baseUrl: model.base_url,
              apiKeyRef: model.key_ref,
              label: model.label,
            },
            {
              messages: effective.messages,
              temperature: model.temperature ?? settings.temperature,
              maxTokens: model.max_tokens ?? settings.maxTokens,
              timeoutMs: model.timeout_ms ?? settings.timeoutMs,
              signal: state.controller.signal,
            },
          ),
          state.aborted,
        ]);
        const parsed = parseAnswer(response.text);
        const displayed = parsed.label;
        const scored = displayed ? scoreResponse(item, displayed, effective.option_map) : null;
        return {
          ...base,
          status: scored ? 'success' : 'parse_failed',
          response_text: response.text.slice(0, 8000),
          parsed_answer: displayed,
          canonical_answer: scored?.canonical_label || null,
          ground_truth: item.ground_truth?.answer || '',
          correct: scored ? scored.correct : null,
          parse_confidence: parsed.confidence,
          matched_by: parsed.matchedBy,
          latency_ms: response.latency_ms,
          usage: response.usage,
          finish_reason: response.finish_reason,
          derived_from_reasoning: response.derived_from_reasoning === true,
          attempts: attempt + 1,
          error: null,
          finished_at: nowIso(),
        };
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ModelError ? err.retryable : true;
        const aborted = err?.code === 'ABORTED' || state.cancelled;
        if (aborted || !retryable || attempt === attempts - 1) break;
        this.event(run, `Retry ${attempt + 1}/${attempts - 1} for ${item.id} · ${model.label}: ${err.message}`, 'warn');
        await sleep(backoffDelay(attempt), state.controller.signal).catch(() => {});
      }
    }
    return {
      ...base,
      status: 'error',
      response_text: '',
      parsed_answer: null,
      canonical_answer: null,
      ground_truth: item.ground_truth?.answer || '',
      correct: null,
      latency_ms: 0,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      attempts: Math.max(1, attemptsUsed),
      error: {
        code: lastError?.code || 'UNKNOWN',
        message: redactSecrets(lastError?.message || 'unknown failure'),
        retryable: lastError?.retryable === true,
      },
      finished_at: nowIso(),
    };
  }

  cancel(runId) {
    const state = this.active.get(runId);
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    run.cancel_requested = true;
    if (state) {
      state.cancelled = true;
      try {
        state.controller.abort();
      } catch {
        // best-effort
      }
    } else if (['queued', 'running'].includes(run.status)) {
      run.status = 'cancelled';
    }
    this.store.saveRun(run);
    return run;
  }

  /** Resume an interrupted run, retrying cells that previously failed. */
  resume(runId, { retryFailed = true } = {}) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (retryFailed) {
      run.results = (run.results || []).filter((cell) => cell.status !== 'error');
    }
    this.store.saveRun(run);
    return this.start(runId, { resume: true });
  }
}

/** Convenience for the API layer: aggregate cells per model without touching the store. */
export function summarizeRun(run) {
  const results = run?.results || [];
  const byModel = new Map();
  for (const cell of results) {
    const key = cell.model_id;
    if (!byModel.has(key)) {
      byModel.set(key, { model_id: key, label: cell.model_label, model: cell.model, scored: 0, correct: 0, errors: 0, unparsed: 0, latency: [] });
    }
    const row = byModel.get(key);
    if (cell.status === 'success') {
      row.scored += 1;
      if (cell.correct) row.correct += 1;
      if (cell.latency_ms) row.latency.push(cell.latency_ms);
    } else if (cell.status === 'parse_failed') {
      row.unparsed += 1;
    } else {
      row.errors += 1;
    }
  }
  return [...byModel.values()].map((row) => ({
    ...row,
    accuracy: row.scored ? row.correct / row.scored : null,
    mean_latency_ms: row.latency.length ? Math.round(row.latency.reduce((a, b) => a + b, 0) / row.latency.length) : null,
  }));
}

export const TASK_TYPE_SET = new Set(Object.values(TASK_TYPES));
