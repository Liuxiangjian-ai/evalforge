import fs from 'node:fs';
import path from 'node:path';

import { nowIso } from '../shared/text.js';

/**
 * Headless end-to-end verification harness.
 *
 * Enabled only through an explicit `selfTest` config block, so a normal install
 * never runs it. It fetches real registry records, builds a real benchmark,
 * evaluates the configured models and writes every export — the same path the
 * UI uses, minus the browser.
 */
export async function runSelfTest(engine, config = {}, logger = console) {
  const log = (message, level = 'info') => {
    try {
      logger?.[level]?.(`[evalforge selftest] ${message}`);
    } catch {
      // logging must never abort the test
    }
  };
  const started = Date.now();
  const report = {
    started_at: nowIso(),
    plugin: 'dsh-plugin-evalforge',
    steps: [],
    ok: false,
    error: null,
  };
  const step = (name, detail) => {
    report.steps.push({ name, at: nowIso(), ...detail });
    log(`${name}: ${JSON.stringify(detail).slice(0, 400)}`);
  };

  try {
    const fetchConfig = config.fetch || {};
    log(`fetching ${fetchConfig.max_records || 60} trials for "${fetchConfig.condition || 'Type 2 Diabetes'}"`);
    const fetched = await engine.fetchTrials({
      condition: fetchConfig.condition || 'Type 2 Diabetes',
      phases: fetchConfig.phases || ['PHASE2', 'PHASE3'],
      studyTypes: fetchConfig.study_types || ['INTERVENTIONAL'],
      statuses: fetchConfig.statuses || [],
      maxRecords: fetchConfig.max_records || 60,
    });
    step('fetch', {
      fetched: fetched.trials.length,
      ingested: fetched.ingested,
      warnings: fetched.warnings,
      nct_sample: fetched.trials.slice(0, 5).map((trial) => trial.nct_id),
    });
    if (fetched.trials.length < (config.min_trials || 30)) {
      throw new Error(`only ${fetched.trials.length} trials were fetched; at least ${config.min_trials || 30} are required`);
    }

    const genConfig = config.generate || {};
    const generated = engine.generate({
      nct_ids: fetched.trials.map((trial) => trial.nct_id),
      task_types: genConfig.task_types || ['endpoint_selection', 'eligibility_criteria_matching'],
      per_task: genConfig.per_task || 8,
      seed: genConfig.seed || 42,
      drop_invalid: true,
      include_experimental: genConfig.include_experimental === true,
      condition_label: fetchConfig.condition || 'mixed',
      name: `EvalForge ${fetchConfig.condition || 'mixed'} self-test`,
    });
    const benchmark = generated.benchmark;
    step('generate', {
      benchmark_id: benchmark.id,
      items: benchmark.items.length,
      stats: generated.stats,
      valid: benchmark.items.filter((item) => item.quality.status === 'valid').length,
      rejected_sample: generated.rejected.slice(0, 5),
    });
    if (benchmark.items.filter((item) => item.quality.status === 'valid').length < (config.min_items || 10)) {
      throw new Error(`only ${benchmark.items.filter((item) => item.quality.status === 'valid').length} valid items were generated`);
    }

    let evaluation = null;
    let selectedModels = config.models;
    if (!selectedModels || !selectedModels.length) {
      // No explicit models: use the Host's own configured catalog, which is what
      // the UI offers. This keeps the self-test honest about what is available.
      const catalog = (await engine.gateway.listNativeCatalog()).filter((entry) => entry.model);
      const seenProvider = new Set();
      selectedModels = [];
      for (const entry of catalog) {
        if (selectedModels.some((model) => model.model === entry.model)) continue;
        selectedModels.push({
          id: `native-${selectedModels.length + 1}`,
          kind: 'native',
          provider: entry.provider,
          label: `${entry.provider_label} · ${entry.model_label || entry.model}`,
          model: entry.model,
        });
        seenProvider.add(entry.provider);
        if (selectedModels.length >= (config.max_models || 3)) break;
      }
      step('model_selection', {
        catalog: catalog.length,
        providers: [...seenProvider],
        selected: selectedModels.map((model) => `${model.provider}/${model.model}`),
      });
    }

    if (selectedModels && selectedModels.length) {
      const settings = {
        ...(config.settings || {}),
        // A reasoning model needs room to think before it prints the label.
        maxTokens: Math.max(8192, Number(config.settings?.maxTokens) || 0),
        include_experimental: genConfig.include_experimental === true,
      };
      engine.saveModels({ models: selectedModels, settings });
      const run = engine.createRun({
        benchmark_id: benchmark.id,
        model_ids: selectedModels.map((model) => model.id),
        settings,
        label: 'self-test run',
      });
      engine.startRun(run.id);
      const deadline = Date.now() + (config.timeout_ms || 900000);
      let current = engine.runStatus(run.id);
      while (['queued', 'running'].includes(current.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        current = engine.runStatus(run.id);
      }
      if (['queued', 'running'].includes(current.status)) {
        engine.cancelRun(run.id);
        throw new Error('self-test evaluation timed out');
      }
      const meta = engine.metaEvaluation(run.id);
      const exported = engine.export(run.id, 'markdown');
      const written = engine.store.writeExport(run.id, 'eval_results.csv', engine.export(run.id, 'csv').body);
      const jsonl = engine.store.writeExport(run.id, 'benchmark.jsonl', engine.exportBenchmark(benchmark.id).body);
      step('evaluate', {
        run_id: run.id,
        status: current.status,
        cells: current.results.length,
        scored: meta.sample.scored,
        failures: meta.sample.failures,
        accuracy: meta.models.map((row) => ({ model: row.label, accuracy: row.accuracy, scored: row.scored, failures: row.failures })),
        exports: [exported.files.map((file) => file.name), written.file, jsonl.file],
        failure_codes: [...new Set((current.results || []).filter((cell) => cell.status === 'error').map((cell) => cell.error?.code))],
      });
      evaluation = { run_id: run.id, meta, exports: exported.files.map((file) => file.file) };
    } else {
      step('evaluate', { skipped: 'no models configured in selfTest.models' });
    }

    report.benchmark = {
      id: benchmark.id,
      hash: benchmark.hash,
      items: benchmark.items.length,
      task_mix: benchmark.task_mix,
    };
    report.evaluation = evaluation;
    report.duration_ms = Date.now() - started;
    report.ok = true;
  } catch (err) {
    report.error = String(err?.stack || err);
    report.duration_ms = Date.now() - started;
    log(`FAILED: ${err?.message || err}`, 'error');
  }

  if (config.out) {
    try {
      fs.mkdirSync(path.dirname(config.out), { recursive: true });
      fs.writeFileSync(config.out, JSON.stringify(report, null, 2), 'utf8');
      log(`report written to ${config.out}`);
    } catch (err) {
      log(`could not write report: ${err?.message || err}`, 'error');
    }
  }
  if (config.exit_when_done) {
    log(`exiting with code ${report.ok ? 0 : 1} (exit_when_done)`);
    // Give stdout a tick to flush before the host process ends.
    setTimeout(() => process.exit(report.ok ? 0 : 1), 250);
  }
  return report;
}
