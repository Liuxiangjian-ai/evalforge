import { TASK_TYPES } from '../shared/constants.js';
import { nowIso } from '../shared/text.js';

/**
 * Meta-evaluation over a finished (or partial) run.
 *
 * Everything here is descriptive measurement. Nothing infers a model's general
 * capability from this benchmark, and discrimination is only labelled "formal"
 * when the caller declares independent capability groups up front.
 */

const TASK_LIST = Object.values(TASK_TYPES);

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function spearman(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const rank = (values) => {
    const sorted = [...values].map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const ranks = new Array(values.length);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].value === sorted[i].value) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[sorted[k].index] = avg;
      i = j + 1;
    }
    return ranks;
  };
  const xs = rank(pairs.map((pair) => pair[0]));
  const ys = rank(pairs.map((pair) => pair[1]));
  const mx = mean(xs);
  const my = mean(ys);
  let numerator = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return numerator / Math.sqrt(dx * dy);
}

/** Multiclass macro-F1 over answer labels, with explicit support counts. */
export function macroF1(cells) {
  const labels = new Set();
  for (const cell of cells) {
    if (cell.ground_truth) labels.add(cell.ground_truth);
    if (cell.canonical_answer) labels.add(cell.canonical_answer);
  }
  if (!labels.size) return { macro_f1: null, per_label: {} };
  const perLabel = {};
  let total = 0;
  let counted = 0;
  for (const label of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const cell of cells) {
      const truth = cell.ground_truth;
      const predicted = cell.canonical_answer;
      if (predicted === label && truth === label) tp += 1;
      else if (predicted === label && truth !== label) fp += 1;
      else if (predicted !== label && truth === label) fn += 1;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;
    perLabel[label] = { precision: round(precision), recall: round(recall), f1: round(f1), support: tp + fn };
    total += f1;
    counted += 1;
  }
  return { macro_f1: counted ? round(total / counted) : null, per_label: perLabel };
}

function scoredCells(run) {
  return (run.results || []).filter((cell) => cell.status === 'success' && typeof cell.correct === 'boolean');
}

function cellGroups(run) {
  const cells = run.results || [];
  const byModel = new Map();
  const byItem = new Map();
  const byItemModel = new Map();
  for (const cell of cells) {
    if (!byModel.has(cell.model_id)) byModel.set(cell.model_id, []);
    byModel.get(cell.model_id).push(cell);
    if (!byItem.has(cell.item_id)) byItem.set(cell.item_id, []);
    byItem.get(cell.item_id).push(cell);
    const key = `${cell.item_id}|${cell.model_id}`;
    if (!byItemModel.has(key)) byItemModel.set(key, []);
    byItemModel.get(key).push(cell);
  }
  return { byModel, byItem, byItemModel };
}

export function buildMetaEvaluation(run) {
  const models = run.models || [];
  const items = run.items || [];
  const results = run.results || [];
  const scored = scoredCells(run);
  const errors = results.filter((cell) => cell.status === 'error');
  const unparsed = results.filter((cell) => cell.status === 'parse_failed');
  const { byModel, byItem } = cellGroups(run);

  const modelRows = models.map((model) => {
    const cells = byModel.get(model.id) || [];
    const good = cells.filter((cell) => cell.status === 'success' && typeof cell.correct === 'boolean');
    const correct = good.filter((cell) => cell.correct).length;
    const failures = cells.filter((cell) => cell.status === 'error').length;
    const unparsedCells = cells.filter((cell) => cell.status === 'parse_failed').length;
    const latency = good.map((cell) => cell.latency_ms).filter((value) => Number.isFinite(value) && value > 0);
    const tokens = cells.reduce((sum, cell) => sum + (cell.usage?.total_tokens || 0), 0);
    const f1 = macroF1(good);
    return {
      model_id: model.id,
      label: model.label,
      model: model.model,
      provider: model.provider,
      kind: model.kind,
      attempts: cells.length,
      scored: good.length,
      correct,
      accuracy: good.length ? round(correct / good.length) : null,
      macro_f1: f1.macro_f1,
      f1_by_label: f1.per_label,
      failures,
      failure_rate: cells.length ? round(failures / cells.length) : null,
      unparsed: unparsedCells,
      total_tokens: tokens,
      mean_latency_ms: latency.length ? Math.round(mean(latency)) : null,
    };
  });

  const tasks = TASK_LIST.filter((task) => items.some((item) => item.task_type === task)).map((task) => {
    const taskCells = scored.filter((cell) => cell.task_type === task);
    const perModel = models.map((model) => {
      const cells = taskCells.filter((cell) => cell.model_id === model.id);
      return {
        model_id: model.id,
        label: model.label,
        n: cells.length,
        correct: cells.filter((cell) => cell.correct).length,
        accuracy: cells.length ? round(cells.filter((cell) => cell.correct).length / cells.length) : null,
      };
    });
    const ranked = perModel.filter((row) => row.accuracy !== null).sort((a, b) => b.accuracy - a.accuracy);
    return {
      task_type: task,
      items: items.filter((item) => item.task_type === task).length,
      cells: taskCells.length,
      per_model: perModel,
      best: ranked[0] || null,
      worst: ranked[ranked.length - 1] || null,
    };
  });

  // Difficulty uses per-model means first, so unequal repeat counts cannot bias it.
  const difficulty = items.map((item) => {
    const cells = (byItem.get(item.id) || []).filter((cell) => cell.status === 'success' && typeof cell.correct === 'boolean');
    const perModelRates = [];
    for (const model of models) {
      const modelCells = cells.filter((cell) => cell.model_id === model.id);
      if (!modelCells.length) continue;
      perModelRates.push(modelCells.filter((cell) => cell.correct).length / modelCells.length);
    }
    const pCorrect = mean(perModelRates);
    return {
      item_id: item.id,
      task_type: item.task_type,
      n_models: perModelRates.length,
      n_cells: cells.length,
      p_correct: round(pCorrect),
      difficulty: pCorrect === null ? null : round(1 - pCorrect),
      spread: perModelRates.length > 1 ? round(Math.max(...perModelRates) - Math.min(...perModelRates)) : null,
      quality_status: item.quality?.status,
    };
  });

  const declared = run.capability_groups || null;
  let discriminationMode = 'not_computable';
  let highIds = [];
  let lowIds = [];
  if (declared && Array.isArray(declared.high) && Array.isArray(declared.low) && declared.high.length && declared.low.length) {
    highIds = declared.high;
    lowIds = declared.low;
    discriminationMode = 'declared';
  } else if (modelRows.filter((row) => row.accuracy !== null).length >= 2) {
    const ranked = [...modelRows].filter((row) => row.accuracy !== null).sort((a, b) => b.accuracy - a.accuracy);
    const mid = Math.ceil(ranked.length / 2);
    highIds = ranked.slice(0, mid).map((row) => row.model_id);
    lowIds = ranked.slice(mid).map((row) => row.model_id);
    discriminationMode = lowIds.length ? 'exploratory' : 'not_computable';
  }

  const discrimination = items.map((item) => {
    const cells = (byItem.get(item.id) || []).filter((cell) => cell.status === 'success' && typeof cell.correct === 'boolean');
    const rate = (ids) => {
      const subset = cells.filter((cell) => ids.includes(cell.model_id));
      if (!subset.length) return null;
      return subset.filter((cell) => cell.correct).length / subset.length;
    };
    const pHigh = rate(highIds);
    const pLow = rate(lowIds);
    return {
      item_id: item.id,
      task_type: item.task_type,
      p_high: round(pHigh),
      p_low: round(pLow),
      d: pHigh !== null && pLow !== null ? round(pHigh - pLow) : null,
      n_high_cells: cells.filter((cell) => highIds.includes(cell.model_id)).length,
      n_low_cells: cells.filter((cell) => lowIds.includes(cell.model_id)).length,
      mode: discriminationMode,
    };
  });

  let monotonicity = { status: 'not_computable', reason: 'no ordered model series was provided', points: [], rho: null };
  const versionOrder = Array.isArray(run.version_order) ? run.version_order.filter((id) => models.some((model) => model.id === id)) : [];
  if (versionOrder.length >= 2) {
    const points = versionOrder.map((id, index) => {
      const row = modelRows.find((entry) => entry.model_id === id);
      return {
        order: index,
        model_id: id,
        label: row?.label || id,
        accuracy: row?.accuracy ?? null,
        n: row?.scored || 0,
      };
    }).filter((point) => point.accuracy !== null);
    const rho = spearman(points.map((point) => [point.order, point.accuracy]));
    const increasing = points.every((point, index) => index === 0 || point.accuracy >= points[index - 1].accuracy);
    monotonicity = {
      status: points.length >= 2 ? 'descriptive' : 'not_computable',
      reason: 'a declared version order is a hypothesis, not evidence of a capability gradient',
      points,
      rho: round(rho),
      strictly_increasing: increasing,
    };
  }

  const repeats = Math.max(1, run.settings?.repeats || 1);
  const stability = [];
  if (repeats > 1) {
    for (const item of items) {
      const cells = (byItem.get(item.id) || []).filter((cell) => cell.status === 'success' && cell.canonical_answer);
      if (cells.length < 2) continue;
      const consistency = [];
      const byOrder = new Map();
      const byRepeat = new Map();
      for (const model of models) {
        const modelCells = cells.filter((cell) => cell.model_id === model.id);
        if (modelCells.length < 2) continue;
        const counts = new Map();
        for (const cell of modelCells) counts.set(cell.canonical_answer, (counts.get(cell.canonical_answer) || 0) + 1);
        consistency.push(Math.max(...counts.values()) / modelCells.length);
      }
      for (const cell of cells) {
        const signature = JSON.stringify(cell.display_order || []);
        if (!byOrder.has(signature)) byOrder.set(signature, []);
        byOrder.get(signature).push(cell.correct ? 1 : 0);
        if (!byRepeat.has(cell.repeat)) byRepeat.set(cell.repeat, []);
        byRepeat.get(cell.repeat).push(cell.correct ? 1 : 0);
      }
      if (!consistency.length) continue;
      const orderAccuracies = [...byOrder.values()].map((values) => mean(values));
      // Correct-rate spread is computed over repeats, not over the pooled sample.
      const repeatAccuracies = [...byRepeat.values()].map((values) => mean(values));
      stability.push({
        item_id: item.id,
        task_type: item.task_type,
        n_cells: cells.length,
        consistency: round(mean(consistency)),
        correct_rate_min: round(Math.min(...repeatAccuracies)),
        correct_rate_max: round(Math.max(...repeatAccuracies)),
        correct_rate_fluctuation: round(Math.max(...repeatAccuracies) - Math.min(...repeatAccuracies)),
        order_effect: orderAccuracies.length > 1 ? round(Math.max(...orderAccuracies) - Math.min(...orderAccuracies)) : null,
        order_variants: orderAccuracies.length,
      });
    }
  }

  const itemById = new Map(items.map((item) => [item.id, item]));
  const contentious = difficulty
    .filter((row) => row.p_correct !== null && row.n_models >= 2)
    .map((row) => ({ ...row, distance_from_half: Math.abs((row.p_correct ?? 0) - 0.5) }))
    .filter((row) => row.p_correct > 0 && row.p_correct < 1)
    .sort((a, b) => a.distance_from_half - b.distance_from_half)
    .slice(0, 25)
    .map((row) => ({
      ...row,
      question: itemById.get(row.item_id)?.query?.slice(0, 220) || '',
      nct_id: itemById.get(row.item_id)?.evidence?.nct_id || '',
      ground_truth: itemById.get(row.item_id)?.ground_truth?.answer || '',
    }));

  const failureAgg = new Map();
  for (const cell of errors) {
    const key = `${cell.model_id}|${cell.error?.code || 'UNKNOWN'}`;
    if (!failureAgg.has(key)) {
      failureAgg.set(key, { model_id: cell.model_id, label: cell.model_label, code: cell.error?.code || 'UNKNOWN', count: 0, sample: cell.error?.message || '' });
    }
    failureAgg.get(key).count += 1;
  }

  return {
    run_id: run.id,
    generated_at: nowIso(),
    sample: {
      items: items.length,
      models: models.length,
      cells: results.length,
      scored: scored.length,
      failures: errors.length,
      unparsed: unparsed.length,
      reasoning_derived: results.filter((cell) => cell.derived_from_reasoning === true).length,
      repeats,
      benchmark_id: run.benchmark_id,
      benchmark_name: run.benchmark_name,
      scoreable: results.length > 0,
    },
    models: modelRows.sort((a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1)),
    tasks,
    difficulty,
    discrimination,
    discrimination_mode: discriminationMode,
    capability_groups: discriminationMode === 'declared' ? { high: highIds, low: lowIds } : null,
    exploratory_groups: discriminationMode === 'exploratory' ? { high: highIds, low: lowIds } : null,
    monotonicity,
    stability,
    contentious,
    failures: [...failureAgg.values()],
    notes: [
      'Accuracy denominators exclude API failures and unparsable replies; both are reported separately.',
      'Answers recovered from a truncated reasoning trace are marked `derived_from_reasoning` in eval_results.csv.',
      discriminationMode === 'exploratory'
        ? 'Discrimination is exploratory: groups were derived from this run\'s overall accuracy, not from an independent capability measure.'
        : 'Discrimination uses capability groups declared before the run.',
      'Registry-derived answers describe historical trial design practice, not optimal clinical decisions.',
    ],
  };
}
