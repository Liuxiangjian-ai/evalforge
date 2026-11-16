import { createHash } from 'node:crypto';

/** Deterministic short id helper. */
export function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

/** Stable JSON stringify (sorted object keys) for hashing and dedupe keys. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Collapse whitespace and unify unicode dashes/quotes so comparisons are stable. */
export function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase, punctuation-free form used for duplicate/leak comparison. */
export function normalizeComparable(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'will', 'been',
  'have', 'has', 'had', 'not', 'but', 'its', 'their', 'there', 'which', 'who', 'whom', 'into',
  'than', 'then', 'also', 'may', 'can', 'any', 'all', 'per', 'via', 'use', 'used', 'using',
  'study', 'studies', 'trial', 'trials', 'patient', 'patients', 'subject', 'subjects',
  'participant', 'participants', 'group', 'groups', 'arm', 'arms', 'including', 'include',
]);

export function tokenSet(value) {
  const words = normalizeComparable(value).split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Jaccard similarity over content tokens; 0 when either side is empty. */
export function jaccard(a, b) {
  const left = a instanceof Set ? a : tokenSet(a);
  const right = b instanceof Set ? b : tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Fraction of `needle` word 3-grams found verbatim inside `haystack`.
 * Used for answer-leakage detection: an option pasted into the prompt scores 1.
 */
export function ngramContainment(needle, haystack, n = 3) {
  const needleWords = normalizeComparable(needle).split(' ').filter(Boolean);
  const hayWords = normalizeComparable(haystack).split(' ').filter(Boolean);
  if (needleWords.length < n || hayWords.length < n) {
    const small = normalizeComparable(needle);
    return small.length > 0 && normalizeComparable(haystack).includes(small) ? 1 : 0;
  }
  const grams = new Set();
  for (let i = 0; i + n <= hayWords.length; i += 1) grams.add(hayWords.slice(i, i + n).join(' '));
  let hits = 0;
  let total = 0;
  for (let i = 0; i + n <= needleWords.length; i += 1) {
    total += 1;
    if (grams.has(needleWords.slice(i, i + n).join(' '))) hits += 1;
  }
  return total === 0 ? 0 : hits / total;
}

export function clip(value, max = 400) {
  const text = normalizeWhitespace(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
  /\b[A-Fa-f0-9]{32,64}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Remove anything that looks like a credential before logging or exporting. */
export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  return text;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      cleanup();
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with jitter, bounded so a run cannot stall indefinitely. */
export function backoffDelay(attempt, baseMs = 800, capMs = 15000) {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exponential * (0.7 + Math.random() * 0.6));
}

/**
 * Parse a model's answer label from free text.
 *
 * Deliberately strict: a run that cannot be parsed is recorded as a parse
 * failure instead of being scored as a wrong answer.
 */
export function parseAnswer(text, labels = ['A', 'B', 'C', 'D']) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { label: null, matchedBy: 'empty', confidence: 'none' };
  const allowed = labels.join('|');

  const patterns = [
    { re: new RegExp(`(?:答案|正确选项|选项)\\s*[:：]\\s*[（(\\[]?\\s*(${allowed})\\b`, 'i'), by: 'zh-answer-line' },
    { re: new RegExp(`(?:answer|option|choice|correct answer)\\s*(?:is)?\\s*[:：]?\\s*[（(\\[]?\\s*(${allowed})\\b`, 'i'), by: 'en-answer-line' },
    { re: new RegExp(`^\\s*[（(\\[]?\\s*(${allowed})\\s*[)）\\]]?\\s*[.。:：]?\\s*$`, 'i'), by: 'bare-label' },
    { re: new RegExp(`(?:^|\\n)\\s*[（(\\[]?\\s*(${allowed})\\s*[)）\\]]?\\s*[.。:：]\\s`, 'i'), by: 'line-label' },
  ];

  for (const { re, by } of patterns) {
    const match = re.exec(raw);
    if (match) return { label: match[1].toUpperCase(), matchedBy: by, confidence: by === 'bare-label' ? 'medium' : 'high' };
  }

  // Single unambiguous letter anywhere in a very short reply.
  const compact = normalizeWhitespace(raw);
  if (compact.length <= 12) {
    const match = new RegExp(`\\b(${allowed})\\b`, 'i').exec(compact);
    if (match) return { label: match[1].toUpperCase(), matchedBy: 'short-reply', confidence: 'low' };
  }
  return { label: null, matchedBy: 'unparsed', confidence: 'none' };
}

/** Guard for JSON payloads that must not be enormous. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

export function formatDateOnly(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}
