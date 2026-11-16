import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jaccard,
  ngramContainment,
  normalizeComparable,
  normalizeWhitespace,
  parseAnswer,
  redactSecrets,
  stableStringify,
  tokenSet,
} from '../src/shared/text.js';

test('parseAnswer accepts the documented answer formats', () => {
  assert.equal(parseAnswer('答案: B').label, 'B');
  assert.equal(parseAnswer('答案：C').label, 'C');
  assert.equal(parseAnswer('Answer: D').label, 'D');
  assert.equal(parseAnswer('The answer is A.').label, 'A');
  assert.equal(parseAnswer('B').label, 'B');
  assert.equal(parseAnswer('(C)').label, 'C');
  assert.equal(parseAnswer('选项：A').label, 'A');
});

test('parseAnswer refuses to guess when the reply is ambiguous', () => {
  assert.equal(parseAnswer('').label, null);
  assert.equal(parseAnswer('I am not sure which option is right because both A and B seem plausible.').label, null);
  assert.equal(parseAnswer('The registry does not say.').label, null);
});

test('parseAnswer reports how it matched', () => {
  assert.equal(parseAnswer('答案: A').matchedBy, 'zh-answer-line');
  assert.equal(parseAnswer('Answer: B').matchedBy, 'en-answer-line');
  assert.equal(parseAnswer('C').matchedBy, 'bare-label');
});

test('normalisation collapses whitespace and unifies punctuation', () => {
  assert.equal(normalizeWhitespace('  a \n\n b\t c '), 'a b c');
  assert.equal(normalizeComparable('HbA1c ≥ 7.0%'), 'hba1c 7 0');
  assert.equal(normalizeComparable('Males and females, age ≥18'), 'males and females age 18');
});

test('token similarity behaves monotonically', () => {
  const a = tokenSet('Change from baseline in Hemoglobin A1c at week 52');
  const b = tokenSet('Change in glycated haemoglobin at week 52');
  const c = tokenSet('Time to cardiovascular death');
  assert.ok(jaccard(a, b) > jaccard(a, c));
  assert.equal(jaccard(a, a), 1);
  assert.equal(jaccard(new Set(), a), 0);
});

test('ngramContainment detects a pasted answer', () => {
  const answer = 'Change from baseline in systolic blood pressure at week 12';
  const prompt = `A trial for hypertension. ${answer}`;
  assert.ok(ngramContainment(answer, prompt) > 0.9);
  assert.ok(ngramContainment(answer, 'A trial about something else entirely') < 0.1);
});

test('redactSecrets removes credential-looking strings', () => {
  // Assembled at runtime so the repository never contains a literal that looks
  // like a live API key (secret scanners and push protection would flag it).
  const bearer = ['abcdefghijklmnop', 'qrstuvwxyz123456'].join('');
  const prefixed = ['sk', '1234567890', 'abcdefghij'].join('-');
  const text = `Authorization: Bearer ${bearer} and ${prefixed}`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(bearer));
  assert.ok(!redacted.includes(prefixed));
  assert.ok(redacted.includes('[redacted]'));
});

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: [2, 3] }), stableStringify({ a: [2, 3], b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});
