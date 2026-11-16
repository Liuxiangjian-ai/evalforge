import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQuery, collectTrials, normalizeStudy, summarizeRecord } from '../src/host/ctgov.js';
import { loadFixtures, fixture } from './helpers.js';

test('buildQuery encodes condition, phase, study type, status and page size', () => {
  const search = buildQuery({
    condition: 'Type 2 Diabetes',
    phases: ['PHASE2', 'PHASE3'],
    studyTypes: ['INTERVENTIONAL'],
    statuses: ['COMPLETED', 'TERMINATED'],
    pageSize: 500,
  });
  assert.equal(search.get('query.cond'), 'Type 2 Diabetes');
  assert.equal(search.get('filter.advanced'), 'AREA[Phase](PHASE2 OR PHASE3) AND AREA[StudyType]INTERVENTIONAL');
  assert.equal(search.get('filter.overallStatus'), 'COMPLETED|TERMINATED');
  assert.equal(search.get('pageSize'), '200', 'page size must be capped at the API limit');
  assert.equal(search.get('countTotal'), 'true');
});

test('normalizeStudy maps registry fields and keeps provenance', () => {
  const record = fixture('NCT06716203');
  assert.equal(record.nct_id, 'NCT06716203');
  assert.ok(record.brief_title.length > 10);
  assert.ok(record.primary_outcomes.length >= 1);
  assert.ok(record.eligibility_criteria.length > 100);
  assert.equal(record.source.registry, 'ClinicalTrials.gov');
  assert.equal(record.source.source_url, 'https://clinicaltrials.gov/study/NCT06716203');
  assert.match(record.source.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(record.record_version.length > 0);
  assert.ok(Array.isArray(record.missing_fields));
  assert.ok(record.raw.protocolSection, 'raw registry payload is retained');
});

test('normalizeStudy rejects identifiers that are not NCT IDs', () => {
  const bad = normalizeStudy({ protocolSection: { identificationModule: { nctId: 'NOT-A-TRIAL' } } });
  assert.equal(bad.record, null);
  assert.equal(bad.reason, 'invalid_nct_id');
});

test('missing fields are recorded instead of invented', () => {
  const { record } = normalizeStudy({
    protocolSection: { identificationModule: { nctId: 'NCT12345678' } },
  });
  assert.ok(record.missing_fields.includes('brief_title'));
  assert.ok(record.missing_fields.includes('primary_outcomes'));
  assert.ok(record.missing_fields.includes('eligibility_criteria'));
});

const fakePage = (studies, nextPageToken) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ studies, nextPageToken, totalCount: studies.length }),
});

test('collectTrials paginates, deduplicates and honours maxRecords', async () => {
  const fixtures = loadFixtures();
  const first = fixtures.slice(0, 2).map((record) => record.raw);
  const second = [fixtures[2].raw, fixtures[0].raw]; // includes a duplicate
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1 ? fakePage(first, 'page-2') : fakePage(second, undefined);
  };
  const result = await collectTrials({ condition: 'test', maxRecords: 10, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.records.length, 3);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.requests, 2);
  assert.equal(new Set(result.records.map((record) => record.nct_id)).size, 3);
  assert.equal(result.batch.nct_ids.length, 3);
});

test('collectTrials retries a 429 and then succeeds', async () => {
  const fixtures = loadFixtures();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => (name === 'retry-after' ? '0' : null) },
        text: async () => 'rate limited',
      };
    }
    return fakePage([fixtures[0].raw], undefined);
  };
  const result = await collectTrials({ condition: 'test', maxRecords: 1, fetchImpl, retries: 2 });
  assert.equal(attempts, 2);
  assert.equal(result.records.length, 1);
  assert.equal(result.stats.retries, 1);
});

test('collectTrials surfaces a non-retryable HTTP failure without fabricating records', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad query' });
  await assert.rejects(
    () => collectTrials({ condition: 'test', maxRecords: 3, fetchImpl }),
    /HTTP 400/,
  );
});

test('an empty registry page yields zero records and a warning', async () => {
  const fetchImpl = async () => fakePage([], undefined);
  const result = await collectTrials({ condition: 'rare disease xyz', maxRecords: 5, fetchImpl });
  assert.equal(result.records.length, 0);
  assert.ok(result.warnings.some((warning) => /No records/.test(warning)));
});

test('summarizeRecord keeps list payloads small but faithful', () => {
  const summary = summarizeRecord(fixture('NCT06716203'));
  assert.equal(summary.nct_id, 'NCT06716203');
  assert.ok(summary.brief_title.length <= 181);
  assert.equal(typeof summary.has_primary_outcomes, 'boolean');
  assert.ok(summary.source_url.startsWith('https://clinicaltrials.gov/study/'));
});
