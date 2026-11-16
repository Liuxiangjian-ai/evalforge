import { normalizeWhitespace } from '../shared/text.js';
import { makeRng } from '../shared/rng.js';

/**
 * Eligibility text helpers.
 *
 * ClinicalTrials.gov stores eligibility as one free-text blob with
 * "Inclusion Criteria:" / "Exclusion Criteria:" headings. We keep the raw blob
 * for splitting (newlines carry meaning) and normalize only the emitted text.
 */

export function rawEligibilityText(record) {
  const raw = record?.raw?.protocolSection?.eligibilityModule?.eligibilityCriteria;
  if (typeof raw === 'string' && raw.trim()) return raw;
  return record?.eligibility_criteria || '';
}

const INCLUSION_HEADER = /^\s*(inclusion criteria|key inclusion criteria|inclusion)\s*:?\s*$/i;
const EXCLUSION_HEADER = /^\s*(exclusion criteria|key exclusion criteria|exclusion)\s*:?\s*$/i;

function headingLine(line) {
  if (INCLUSION_HEADER.test(line)) return 'inclusion';
  if (EXCLUSION_HEADER.test(line)) return 'exclusion';
  return null;
}

/** Split one section into criterion items, preserving multi-line continuations. */
function splitSection(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let current = null;
  let sawNumbered = false;

  const NUMBER_MARKER = /^\s*(?:\d{1,2}[.)]|[•▪*]|[-–—]\s)\s*/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const numbered = NUMBER_MARKER.test(rawLine);
    if (numbered) sawNumbered = true;
    if (numbered && current) {
      items.push(current);
      current = line.replace(NUMBER_MARKER, '');
      continue;
    }
    if (!current) {
      current = numbered ? line.replace(NUMBER_MARKER, '') : line;
      continue;
    }
    // Continuation of the current item (e.g. nested sub-points or wrapped text).
    if (numbered) {
      items.push(current);
      current = line.replace(NUMBER_MARKER, '');
    } else {
      current = `${current} ${line}`;
    }
  }
  if (current) items.push(current);

  if (!sawNumbered && items.length === 1) {
    // No list markers: fall back to sentence-ish splitting on blank-line paragraph text.
    const sentences = items[0].split(/(?<=[.;])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length > 1) return sentences;
  }
  return items.map((item) => normalizeWhitespace(item)).filter((item) => item.length > 0);
}

/**
 * Parse a raw eligibility blob into inclusion/exclusion items.
 * @returns {{inclusion: string[], exclusion: string[], unlabeled: string[], sectionsFound: boolean}}
 */
export function splitEligibility(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n');
  const result = { inclusion: [], exclusion: [], unlabeled: [], sectionsFound: false };
  if (!text.trim()) return result;

  const lines = text.split('\n');
  let current = null;
  let buffer = [];
  const flush = () => {
    const section = splitSection(buffer.join('\n'));
    if (current === 'inclusion') result.inclusion.push(...section);
    else if (current === 'exclusion') result.exclusion.push(...section);
    else result.unlabeled.push(...section);
    buffer = [];
  };

  for (const line of lines) {
    const kind = headingLine(line);
    if (kind) {
      flush();
      current = kind;
      result.sectionsFound = true;
      continue;
    }
    buffer.push(line);
  }
  flush();

  const dedupe = (list) => {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const key = item.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };

  result.inclusion = dedupe(result.inclusion);
  result.exclusion = dedupe(result.exclusion);
  result.unlabeled = dedupe(result.unlabeled);
  return result;
}

const NUMERIC_CRITERION = /\b\d+(?:\.\d+)?\s*(?:%|mg|ml|kg|mmhg|cm|mm|years?|months?|weeks?|days?|hours?|iu\/l|u\/l|mmol\/l|mg\/dl|g\/dl|bpm|cells?\/|x\s*10)\b/i;
const COMPARATOR = /(?:>=|<=|>|<|≥|≤|at least|at most|no more than|no less than|greater than|less than)\s*[-+]?\d/i;
const VERIFIABLE_HINTS = [
  /age[sd]?\s*(?:of|:)?\s*\d/i,
  /diagnos(?:is|ed)\s+of/i,
  /history\s+of/i,
  /prior\s+(?:treatment|therapy|surgery)/i,
  /documented/i,
  /confirmed/i,
  /pregnan/i,
  /contraindicat/i,
  /ejection fraction/i,
  /hba1c|egfr|bmi|anc|platelet|hemoglobin|creatinine|bilirubin|ast|alt/i,
  /ecog|karnofsky/i,
  /informed consent/i,
  /life expectancy/i,
];
const UNVERIFIABLE_HINTS = [
  /investigator (?:judg|opinion|assess)/i,
  /in the opinion of/i,
  /deemed (?:appropriate|suitable|eligible)/i,
  /as determined by the (?:investigator|sponsor)/i,
  /other (?:clinically )?(?:significant|acceptable)/i,
  /able to (?:understand|comply)/i,
  /willing (?:and able )?to/i,
];

/**
 * Score how suitable a criterion is for a deterministic MCQ.
 * Higher is better: explicit thresholds are traceable and falsifiable.
 */
export function scoreCriterion(item) {
  const text = normalizeWhitespace(item);
  if (text.length < 40 || text.length > 320) return { score: -1, reason: 'length' };
  if (UNVERIFIABLE_HINTS.some((re) => re.test(text))) return { score: -1, reason: 'subjective' };
  let score = 0;
  if (NUMERIC_CRITERION.test(text)) score += 3;
  if (COMPARATOR.test(text)) score += 2;
  if (VERIFIABLE_HINTS.some((re) => re.test(text))) score += 1;
  if (text.split(/\s+/).length > 8) score += 1;
  // Extremely long, list-like criteria contain several independent rules and
  // make a single-answer MCQ ambiguous.
  if (/;/g.test(text) && (text.match(/;/g) || []).length > 2) score -= 3;
  return { score, reason: score > 0 ? 'ok' : 'low-signal' };
}

/** Pick the best criteria of one section, deterministically by score then order. */
export function rankCriteria(items, { polarity = 'inclusion', min = 40, max = 320 } = {}) {
  const scored = [];
  for (const item of items) {
    const text = normalizeWhitespace(item);
    if (text.length < min || text.length > max) continue;
    const { score, reason } = scoreCriterion(text);
    if (score <= 0) continue;
    scored.push({ text, score, reason, polarity });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function numericTokens(text) {
  const tokens = [];
  const re = /(>=|<=|>|<|≥|≤)?\s*(\d+(?:\.\d+)?)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    tokens.push({ raw: match[0], comparator: match[1] || '', value: Number(match[2]), index: match.index });
  }
  return tokens;
}

/**
 * Build a "near miss" distractor by changing one numeric threshold.
 *
 * This is only used when the corpus cannot supply three real criteria of the
 * same polarity; the mutation is recorded so reviewers can see it is synthetic.
 */
export function mutateNumericCriterion(text, seed) {
  const rng = makeRng('mutate', text, seed);
  const tokens = numericTokens(text).filter((token) => token.value > 0);
  if (tokens.length === 0) {
    const r = 1.5 + rng();
    return { text: `${text} (threshold raised by a factor of ${r.toFixed(1)})`, mutation: 'appended-qualifier' };
  }
  const target = tokens[Math.floor(rng() * tokens.length)];
  const factor = rng() < 0.5 ? 1.5 : 2;
  let mutatedValue = Math.round(target.value * factor * 10) / 10;
  if (mutatedValue === target.value) mutatedValue += 1;
  const before = text.slice(0, target.index);
  const after = text.slice(target.index + target.raw.length);
  const mutated = `${before}${target.comparator ? `${target.comparator} ` : ''}${mutatedValue}${after}`;
  return { text: normalizeWhitespace(mutated), mutation: `numeric:${target.value}->${mutatedValue}` };
}
