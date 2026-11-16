import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BENCHMARK_SCHEMA_VERSION } from '../shared/constants.js';
import { nowIso, safeJsonParse, sha256Hex } from '../shared/text.js';

/** Resolve the plugin data root; `DSH_HOME` wins so the app and CLI agree. */
export function resolveDataDir() {
  if (process.env.EVALFORGE_DATA_DIR) return process.env.EVALFORGE_DATA_DIR;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'evalforge');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = safeJsonParse(text, undefined);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Atomic JSON write: a crash cannot leave a half-written benchmark. */
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_CONFIG = {
  version: 1,
  models: [],
  settings: {
    temperature: 0.2,
    maxTokens: 512,
    concurrency: 3,
    retries: 2,
    timeoutMs: 90000,
    repeats: 1,
    include_experimental: false,
  },
  last_fetch: null,
  updated_at: '',
};

export class Store {
  constructor(baseDir = resolveDataDir()) {
    this.baseDir = baseDir;
    ensureDir(this.baseDir);
    ensureDir(path.join(this.baseDir, 'benchmarks'));
    ensureDir(path.join(this.baseDir, 'runs'));
    ensureDir(path.join(this.baseDir, 'exports'));
    this.corpusPath = path.join(this.baseDir, 'corpus.json');
    this.configPath = path.join(this.baseDir, 'config.json');
    this.metaPath = path.join(this.baseDir, 'meta.json');
    this._corpus = null;
    this._config = null;
    this._meta = null;
  }

  /* ------------------------------ config ------------------------------ */

  getConfig() {
    if (!this._config) {
      const stored = readJson(this.configPath, null);
      this._config = { ...DEFAULT_CONFIG, ...(stored || {}), settings: { ...DEFAULT_CONFIG.settings, ...(stored?.settings || {}) } };
    }
    return this._config;
  }

  saveConfig(patch = {}) {
    const current = this.getConfig();
    const next = {
      ...current,
      ...patch,
      settings: { ...current.settings, ...(patch.settings || {}) },
      updated_at: nowIso(),
    };
    this._config = next;
    writeJson(this.configPath, next);
    return next;
  }

  /* ------------------------------ counters ---------------------------- */

  getMeta() {
    if (!this._meta) this._meta = readJson(this.metaPath, { item_seq: 0, created_at: nowIso() });
    return this._meta;
  }

  /** Monotonic benchmark item ids (MED-000001 …) across sessions. */
  nextItemId(count = 1) {
    const meta = this.getMeta();
    const first = Number(meta.item_seq || 0) + 1;
    meta.item_seq = first + count - 1;
    writeJson(this.metaPath, meta);
    return first;
  }

  peekItemSeq() {
    return Number(this.getMeta().item_seq || 0);
  }

  /* ------------------------------ corpus ------------------------------ */

  loadCorpus() {
    if (!this._corpus) {
      const stored = readJson(this.corpusPath, null);
      this._corpus = stored && Array.isArray(stored.trials)
        ? stored
        : { version: 1, updated_at: '', trials: [], batches: [] };
    }
    return this._corpus;
  }

  /** Merge a fetched batch, deduplicating by NCT ID and keeping provenance. */
  ingestTrials(records, batch) {
    const corpus = this.loadCorpus();
    const index = new Map(corpus.trials.map((trial) => [trial.nct_id, trial]));
    let added = 0;
    let updated = 0;
    for (const record of records) {
      if (index.has(record.nct_id)) {
        const existing = index.get(record.nct_id);
        // A newer registry version replaces the stored record but keeps the
        // earliest fetch timestamp for provenance.
        const newer = String(record.record_version || '') > String(existing.record_version || '');
        if (newer) {
          index.set(record.nct_id, {
            ...record,
            source: { ...record.source, fetched_at: existing.source?.fetched_at || record.source?.fetched_at },
          });
          updated += 1;
        }
      } else {
        index.set(record.nct_id, record);
        added += 1;
      }
    }
    corpus.trials = [...index.values()].sort((a, b) => a.nct_id.localeCompare(b.nct_id));
    corpus.batches = [batch, ...(corpus.batches || [])].slice(0, 25);
    corpus.updated_at = nowIso();
    corpus.version = 1;
    this._corpus = corpus;
    writeJson(this.corpusPath, corpus);
    return { added, updated, total: corpus.trials.length, batch };
  }

  listTrials({ condition = '', phase = '', status = '', search = '', has_outcomes = false, limit = 500 } = {}) {
    const corpus = this.loadCorpus();
    const phrase = search.trim().toLowerCase();
    const filtered = corpus.trials.filter((trial) => {
      if (phase && !(trial.phases || []).includes(phase) && trial.phase !== phase) return false;
      if (status && trial.overall_status !== status) return false;
      if (has_outcomes && !(trial.primary_outcomes || []).length) return false;
      if (condition) {
        const hay = (trial.conditions || []).join(' ').toLowerCase();
        if (!hay.includes(condition.toLowerCase())) return false;
      }
      if (phrase) {
        const hay = `${trial.nct_id} ${trial.brief_title} ${(trial.conditions || []).join(' ')}`.toLowerCase();
        if (!hay.includes(phrase)) return false;
      }
      return true;
    });
    return {
      total: corpus.trials.length,
      filtered: filtered.length,
      batches: corpus.batches || [],
      trials: filtered.slice(0, limit),
    };
  }

  getTrial(nctId) {
    return this.loadCorpus().trials.find((trial) => trial.nct_id === nctId) || null;
  }

  getTrialsByIds(nctIds) {
    const wanted = new Set(nctIds || []);
    return this.loadCorpus().trials.filter((trial) => wanted.has(trial.nct_id));
  }

  deleteTrial(nctId) {
    const corpus = this.loadCorpus();
    const before = corpus.trials.length;
    corpus.trials = corpus.trials.filter((trial) => trial.nct_id !== nctId);
    corpus.updated_at = nowIso();
    this._corpus = corpus;
    writeJson(this.corpusPath, corpus);
    return { removed: before - corpus.trials.length, total: corpus.trials.length };
  }

  corpusStats() {
    const corpus = this.loadCorpus();
    const conditions = new Map();
    const phases = new Map();
    const statuses = new Map();
    for (const trial of corpus.trials) {
      for (const condition of trial.conditions || []) {
        conditions.set(condition, (conditions.get(condition) || 0) + 1);
      }
      phases.set(trial.phase || 'NA', (phases.get(trial.phase || 'NA') || 0) + 1);
      statuses.set(trial.overall_status || 'UNKNOWN', (statuses.get(trial.overall_status || 'UNKNOWN') || 0) + 1);
    }
    return {
      trials: corpus.trials.length,
      batches: (corpus.batches || []).length,
      updated_at: corpus.updated_at,
      top_conditions: [...conditions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
      phases: [...phases.entries()].map(([name, count]) => ({ name, count })),
      statuses: [...statuses.entries()].map(([name, count]) => ({ name, count })),
      with_outcomes: corpus.trials.filter((trial) => (trial.primary_outcomes || []).length).length,
      with_eligibility: corpus.trials.filter((trial) => Boolean(trial.eligibility_criteria)).length,
      completed_or_stopped: corpus.trials.filter((trial) => ['COMPLETED', 'TERMINATED', 'WITHDRAWN', 'SUSPENDED'].includes(trial.overall_status)).length,
    };
  }

  /* ---------------------------- benchmarks ---------------------------- */

  benchmarkPath(id) {
    return path.join(this.baseDir, 'benchmarks', `${id}.json`);
  }

  saveBenchmark(benchmark) {
    const payload = {
      ...benchmark,
      benchmark_schema_version: BENCHMARK_SCHEMA_VERSION,
      updated_at: nowIso(),
    };
    writeJson(this.benchmarkPath(benchmark.id), payload);
    const index = readJson(path.join(this.baseDir, 'benchmarks', 'index.json'), []);
    const nextIndex = index.filter((entry) => entry.id !== payload.id);
    nextIndex.unshift({
      id: payload.id,
      name: payload.name,
      created_at: payload.created_at,
      updated_at: payload.updated_at,
      items: (payload.items || []).length,
      valid: (payload.items || []).filter((item) => item.quality?.status === 'valid').length,
      task_mix: payload.task_mix || {},
      source: payload.source || 'clinicaltrials.gov',
    });
    writeJson(path.join(this.baseDir, 'benchmarks', 'index.json'), nextIndex.slice(0, 100));
    return payload;
  }

  listBenchmarks() {
    return readJson(path.join(this.baseDir, 'benchmarks', 'index.json'), []);
  }

  getBenchmark(id) {
    return readJson(this.benchmarkPath(id), null);
  }

  deleteBenchmark(id) {
    try {
      fs.unlinkSync(this.benchmarkPath(id));
    } catch {
      return { removed: false };
    }
    const index = readJson(path.join(this.baseDir, 'benchmarks', 'index.json'), []);
    writeJson(path.join(this.baseDir, 'benchmarks', 'index.json'), index.filter((entry) => entry.id !== id));
    return { removed: true };
  }

  /* -------------------------------- runs ------------------------------ */

  runPath(id) {
    return path.join(this.baseDir, 'runs', `${id}.json`);
  }

  saveRun(run) {
    const payload = { ...run, updated_at: nowIso() };
    writeJson(this.runPath(run.id), payload);
    const index = readJson(path.join(this.baseDir, 'runs', 'index.json'), []);
    const entry = {
      id: payload.id,
      label: payload.label || payload.id,
      created_at: payload.created_at,
      updated_at: payload.updated_at,
      status: payload.status,
      benchmark_id: payload.benchmark_id,
      benchmark_name: payload.benchmark_name,
      models: (payload.models || []).map((model) => model.label || model.model),
      items: (payload.items || []).length,
      cells: (payload.results || []).length,
      failures: (payload.results || []).filter((cell) => cell.status !== 'success').length,
    };
    const next = index.filter((row) => row.id !== entry.id);
    next.unshift(entry);
    writeJson(path.join(this.baseDir, 'runs', 'index.json'), next.slice(0, 100));
    return payload;
  }

  listRuns(limit = 40) {
    return readJson(path.join(this.baseDir, 'runs', 'index.json'), []).slice(0, limit);
  }

  getRun(id) {
    return readJson(this.runPath(id), null);
  }

  deleteRun(id) {
    try {
      fs.unlinkSync(this.runPath(id));
    } catch {
      return { removed: false };
    }
    const index = readJson(path.join(this.baseDir, 'runs', 'index.json'), []);
    writeJson(path.join(this.baseDir, 'runs', 'index.json'), index.filter((entry) => entry.id !== id));
    return { removed: true };
  }

  /* ------------------------------- exports ---------------------------- */

  writeExport(runId, filename, content) {
    const dir = ensureDir(path.join(this.baseDir, 'exports', runId));
    const file = path.join(dir, filename);
    fs.writeFileSync(file, content, 'utf8');
    return { file, bytes: Buffer.byteLength(content), sha256: sha256Hex(content) };
  }

  /** Path used by the UI to show where data lives. */
  describe() {
    return {
      data_dir: this.baseDir,
      corpus_file: this.corpusPath,
      config_file: this.configPath,
      count: this.loadCorpus().trials.length,
    };
  }
}
