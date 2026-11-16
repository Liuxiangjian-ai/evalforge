import {
  CTGOV_API,
  CTGOV_STUDY_URL,
  DEFAULT_FETCH,
} from '../shared/constants.js';
import {
  backoffDelay,
  clip,
  formatDateOnly,
  normalizeWhitespace,
  nowIso,
  sleep,
  toArray,
} from '../shared/text.js';

const PAGE_SIZE_CAP = 200;
const REQUEST_INTERVAL_MS = 250;

export class RegistryError extends Error {
  constructor(message, { status = 0, body = '', retryable = false } = {}) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

/** Build the v2 query string for one collection request. */
export function buildQuery(params = {}, pageToken = undefined) {
  const search = new URLSearchParams();
  const condition = normalizeWhitespace(params.condition);
  if (condition) search.set('query.cond', condition);

  const advanced = [];
  const phases = toArray(params.phases).filter(Boolean);
  if (phases.length === 1) advanced.push(`AREA[Phase]${phases[0]}`);
  else if (phases.length > 1) advanced.push(`AREA[Phase](${phases.join(' OR ')})`);
  const studyTypes = toArray(params.studyTypes).filter(Boolean);
  if (studyTypes.length === 1) advanced.push(`AREA[StudyType]${studyTypes[0]}`);
  else if (studyTypes.length > 1) advanced.push(`AREA[StudyType](${studyTypes.join(' OR ')})`);
  if (advanced.length) search.set('filter.advanced', advanced.join(' AND '));

  const statuses = toArray(params.statuses).filter(Boolean);
  if (statuses.length) search.set('filter.overallStatus', statuses.join('|'));

  search.set('pageSize', String(Math.min(PAGE_SIZE_CAP, Math.max(1, Number(params.pageSize) || PAGE_SIZE_CAP))));
  search.set('countTotal', 'true');
  search.set('sort', 'LastUpdatePostDate:desc');
  if (pageToken) search.set('pageToken', pageToken);
  return search;
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * One HTTP request with bounded retries and Retry-After support.
 * `fetchImpl` is injectable so tests never touch the network.
 */
export async function requestStudies(params, { fetchImpl = fetch, signal, retries = 3, pageToken, onRetry } = {}) {
  const search = buildQuery(params, pageToken);
  const url = `${CTGOV_API}?${search.toString()}`;
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable = retryableStatus(response.status);
        if (retryable && attempt < retries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt);
          onRetry?.({ attempt, status: response.status, waitMs });
          attempt += 1;
          await sleep(waitMs, signal);
          continue;
        }
        throw new RegistryError(`ClinicalTrials.gov returned HTTP ${response.status}`, {
          status: response.status,
          body: text.slice(0, 600),
          retryable,
        });
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new RegistryError('ClinicalTrials.gov returned a non-JSON body', { status: response.status, body: text.slice(0, 300) });
      }
      return { payload, url, attempts: attempt + 1 };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (err instanceof RegistryError) throw err;
      if (attempt < retries) {
        const waitMs = backoffDelay(attempt);
        onRetry?.({ attempt, status: 0, waitMs, message: err?.message });
        attempt += 1;
        await sleep(waitMs, signal);
        continue;
      }
      throw new RegistryError(`ClinicalTrials.gov request failed: ${err?.message || err}`, { retryable: true });
    }
  }
}

function structuredDate(struct) {
  if (!struct) return '';
  return formatDateOnly(struct.date || struct);
}

/**
 * Normalize one v2 study into the record shape this plugin stores.
 * Every derived field keeps a `source_path` so the UI can point at the registry.
 */
export function normalizeStudy(study, context = {}) {
  const protocol = study?.protocolSection || {};
  const id = protocol.identificationModule || {};
  const status = protocol.statusModule || {};
  const description = protocol.descriptionModule || {};
  const conditions = protocol.conditionsModule || {};
  const design = protocol.designModule || {};
  const arms = protocol.armsInterventionsModule || {};
  const outcomes = protocol.outcomesModule || {};
  const eligibility = protocol.eligibilityModule || {};
  const sponsor = protocol.sponsorCollaboratorsModule || {};
  const locations = protocol.contactsLocationsModule || {};

  const nctId = normalizeWhitespace(id.nctId || '');
  if (!/^NCT\d{8}$/.test(nctId)) return { record: null, reason: 'invalid_nct_id' };

  const primaryOutcomes = (outcomes.primaryOutcomes || [])
    .map((outcome) => ({
      measure: normalizeWhitespace(outcome.measure || ''),
      description: normalizeWhitespace(outcome.description || ''),
      time_frame: normalizeWhitespace(outcome.timeFrame || ''),
    }))
    .filter((outcome) => outcome.measure.length > 0);

  const secondaryOutcomes = (outcomes.secondaryOutcomes || [])
    .map((outcome) => ({
      measure: normalizeWhitespace(outcome.measure || ''),
      description: normalizeWhitespace(outcome.description || ''),
      time_frame: normalizeWhitespace(outcome.timeFrame || ''),
    }))
    .filter((outcome) => outcome.measure.length > 0);

  const armGroups = (arms.armGroups || []).map((group) => ({
    label: normalizeWhitespace(group.label || ''),
    type: group.type || '',
    description: normalizeWhitespace(group.description || ''),
    intervention_names: toArray(group.interventionNames).map(normalizeWhitespace),
  }));

  const interventions = (arms.interventions || []).map((item) => ({
    type: item.type || '',
    name: normalizeWhitespace(item.name || ''),
    description: normalizeWhitespace(item.description || ''),
    other_names: toArray(item.otherNames).map(normalizeWhitespace),
    arm_group_labels: toArray(item.armGroupLabels).map(normalizeWhitespace),
  }));

  const phases = toArray(design.phases).map((phase) => String(phase).toUpperCase());
  const recordVersion = [
    structuredDate(status.lastUpdatePostDateStruct),
    status.statusVerifiedDate ? String(status.statusVerifiedDate) : '',
    structuredDate(status.studyFirstPostDateStruct),
  ].filter(Boolean).join('|');

  const record = {
    nct_id: nctId,
    brief_title: normalizeWhitespace(id.briefTitle || ''),
    official_title: normalizeWhitespace(id.officialTitle || ''),
    acronym: normalizeWhitespace(id.acronym || ''),
    brief_summary: normalizeWhitespace(description.briefSummary || ''),
    detailed_description: normalizeWhitespace(description.detailedDescription || ''),
    conditions: toArray(conditions.conditions).map(normalizeWhitespace).filter(Boolean),
    keywords: toArray(conditions.keywords).map(normalizeWhitespace).filter(Boolean),
    phase: phases[0] || 'NA',
    phases,
    study_type: String(design.studyType || '').toUpperCase(),
    design_info: {
      allocation: design.designInfo?.allocation || '',
      intervention_model: design.designInfo?.interventionModel || '',
      primary_purpose: design.designInfo?.primaryPurpose || '',
      masking: design.designInfo?.maskingInfo?.masking || '',
    },
    interventions,
    arm_groups: armGroups,
    eligibility_criteria: normalizeWhitespace(eligibility.eligibilityCriteria || ''),
    eligibility_fields: {
      sex: eligibility.sex || '',
      minimum_age: eligibility.minimumAge || '',
      maximum_age: eligibility.maximumAge || '',
      healthy_volunteers: eligibility.healthyVolunteers ?? null,
      std_ages: toArray(eligibility.stdAges),
    },
    primary_outcomes: primaryOutcomes,
    secondary_outcomes: secondaryOutcomes,
    enrollment: {
      count: Number.isFinite(Number(design.enrollmentInfo?.count)) ? Number(design.enrollmentInfo.count) : null,
      type: design.enrollmentInfo?.type || '',
    },
    overall_status: String(status.overallStatus || '').toUpperCase(),
    why_stopped: normalizeWhitespace(status.whyStopped || ''),
    has_results: study.hasResults === true,
    study_dates: {
      start: structuredDate(status.startDateStruct),
      primary_completion: structuredDate(status.primaryCompletionDateStruct),
      completion: structuredDate(status.completionDateStruct),
      first_posted: structuredDate(status.studyFirstPostDateStruct),
      last_update_posted: structuredDate(status.lastUpdatePostDateStruct),
      status_verified: status.statusVerifiedDate ? String(status.statusVerifiedDate) : '',
    },
    sponsor: normalizeWhitespace(sponsor.leadSponsor?.name || ''),
    locations_count: Array.isArray(locations.locations) ? locations.locations.length : 0,
    record_version: recordVersion,
    source: {
      registry: 'ClinicalTrials.gov',
      api_url: `${CTGOV_API}/${nctId}`,
      source_url: CTGOV_STUDY_URL(nctId),
      fetched_at: context.fetchedAt || nowIso(),
      query: context.query || null,
      raw_complete: true,
    },
    missing_fields: [],
    raw: study,
  };

  record.missing_fields = detectMissingFields(record);
  return { record, reason: null };
}

export function detectMissingFields(record) {
  const missing = [];
  if (!record.brief_title) missing.push('brief_title');
  if (!record.brief_summary) missing.push('brief_summary');
  if (!record.conditions?.length) missing.push('conditions');
  if (!record.interventions?.length) missing.push('interventions');
  if (!record.arm_groups?.length) missing.push('arm_groups');
  if (!record.eligibility_criteria) missing.push('eligibility_criteria');
  if (!record.primary_outcomes?.length) missing.push('primary_outcomes');
  if (record.enrollment?.count === null) missing.push('enrollment');
  if (!record.overall_status) missing.push('overall_status');
  if (!record.study_dates?.start) missing.push('start_date');
  return missing;
}

/**
 * Collect studies from ClinicalTrials.gov with pagination, retry, dedupe and
 * provenance. Never fabricates records: a short page simply yields fewer items.
 */
export async function collectTrials(options = {}) {
  const params = { ...DEFAULT_FETCH, ...options };
  const maxRecords = Math.max(1, Math.min(1000, Number(params.maxRecords) || 100));
  const fetchImpl = options.fetchImpl || fetch;
  const signal = options.signal;
  const started = Date.now();
  const fetchedAt = nowIso();
  const stats = {
    requested: maxRecords,
    available: null,
    fetched: 0,
    accepted: 0,
    duplicates: 0,
    invalid: 0,
    requests: 0,
    retries: 0,
    skipped_existing: 0,
  };
  const records = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();
  let pageToken = undefined;

  while (records.length < maxRecords) {
    if (signal?.aborted) break;
    const remaining = maxRecords - records.length;
    const page = await requestStudies(
      { ...params, pageSize: Math.min(PAGE_SIZE_CAP, remaining) },
      {
        fetchImpl,
        signal,
        retries: Number(params.retries ?? 3),
        pageToken,
        onRetry: () => {
          stats.retries += 1;
        },
      },
    );
    stats.requests += page.attempts;
    const payload = page.payload;
    if (stats.available === null && Number.isFinite(Number(payload.totalCount))) {
      stats.available = Number(payload.totalCount);
    }
    const studies = Array.isArray(payload.studies) ? payload.studies : [];
    if (studies.length === 0) break;

    for (const study of studies) {
      if (records.length >= maxRecords) break;
      stats.fetched += 1;
      const { record, reason } = normalizeStudy(study, { fetchedAt, query: params });
      if (!record) {
        stats.invalid += 1;
        errors.push({ nct_id: null, reason });
        continue;
      }
      if (seen.has(record.nct_id)) {
        stats.duplicates += 1;
        continue;
      }
      seen.add(record.nct_id);
      records.push(record);
      stats.accepted += 1;
    }

    pageToken = payload.nextPageToken;
    if (!pageToken) break;
    await sleep(REQUEST_INTERVAL_MS, signal);
  }

  if (!params.condition) warnings.push('No condition keyword was supplied; the registry query was unfiltered.');
  if (stats.available !== null && stats.available < stats.requested) {
    warnings.push(`Registry reports ${stats.available} matching studies; requested ${stats.requested}.`);
  }
  if (records.length === 0) warnings.push('No records were returned for these filters.');

  return {
    batch: {
      batch_id: `batch-${new Date(started).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`,
      fetched_at: fetchedAt,
      source: 'ClinicalTrials.gov API v2',
      query: {
        condition: params.condition || '',
        phases: toArray(params.phases),
        study_types: toArray(params.studyTypes),
        statuses: toArray(params.statuses),
        max_records: maxRecords,
      },
      stats,
      errors: errors.slice(0, 20),
      warnings,
      duration_ms: Date.now() - started,
      nct_ids: records.map((r) => r.nct_id),
    },
    records,
    stats,
    errors,
    warnings,
  };
}

/** Compact projection used in list views; keeps payloads small over the wire. */
export function summarizeRecord(record) {
  return {
    nct_id: record.nct_id,
    brief_title: clip(record.brief_title, 180),
    conditions: (record.conditions || []).slice(0, 4),
    phase: record.phase,
    study_type: record.study_type,
    overall_status: record.overall_status,
    enrollment: record.enrollment?.count ?? null,
    has_primary_outcomes: (record.primary_outcomes || []).length > 0,
    has_eligibility: Boolean(record.eligibility_criteria),
    missing_fields: record.missing_fields || [],
    last_update_posted: record.study_dates?.last_update_posted || '',
    source_url: record.source?.source_url || CTGOV_STUDY_URL(record.nct_id),
    fetched_at: record.source?.fetched_at || '',
  };
}
