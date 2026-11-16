import { API_PREFIX } from '../shared/constants.js';
import { redactSecrets } from '../shared/text.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fail(err) {
  const status = err?.statusCode || (err?.code === 'MISSING_CREDENTIAL' ? 409 : 400);
  return json(
    {
      ok: false,
      error: redactSecrets(err?.message || String(err)),
      code: err?.code || 'BAD_REQUEST',
    },
    status,
  );
}

async function readBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 });
  }
}

function query(request) {
  return new URL(request.url).searchParams;
}

function requireParam(params, key) {
  const value = params.get(key);
  if (!value) throw Object.assign(new Error(`missing query parameter ${key}`), { statusCode: 400 });
  return value;
}

function route(ctx, path, methods, handler) {
  const dispose = ctx.connection.fetch.register({
    path: `${API_PREFIX}${path}`,
    methods,
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handler(request);
      } catch (err) {
        return fail(err);
      }
    },
  });
  return typeof dispose === 'function' ? dispose : () => {};
}

export function registerApi(ctx, engine) {
  const disposers = [];
  const add = (path, methods, handler) => {
    try {
      disposers.push(route(ctx, path, methods, handler));
    } catch (err) {
      // A failed registration must not leave a half-mounted API behind.
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // best-effort rollback
        }
      }
      throw err;
    }
  };
  add('/health', ['GET'], async () => json({
    ok: true,
    plugin: 'dsh-plugin-evalforge',
    llm: engine.gateway.nativeAvailable,
    data_dir: engine.store.describe().data_dir,
  }));

  add('/bootstrap', ['GET'], async () => json({ ok: true, ...(await engine.bootstrap()) }));

  /* ------------------------------ data ------------------------------ */

  add('/trials/fetch', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...(await engine.fetchTrials(payload)) });
  });

  add('/trials', ['GET'], async (request) => {
    const params = query(request);
    const page = engine.listTrials({
      condition: params.get('condition') || '',
      phase: params.get('phase') || '',
      status: params.get('status') || '',
      search: params.get('search') || '',
      has_outcomes: params.get('has_outcomes') === 'true',
      limit: Number(params.get('limit') || 500),
    });
    return json({ ok: true, ...page });
  });

  add('/trial', ['GET'], async (request) => {
    const nctId = requireParam(query(request), 'nct_id');
    return json({ ok: true, ...engine.getTrial(nctId) });
  });

  add('/trials/delete', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...engine.deleteTrial(payload.nct_id) });
  });

  /* --------------------------- benchmarks --------------------------- */

  add('/benchmark/generate', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...engine.generate(payload) });
  });

  add('/benchmarks', ['GET'], async () => json({ ok: true, benchmarks: engine.listBenchmarks() }));

  add('/benchmark', ['GET'], async (request) => {
    const id = requireParam(query(request), 'id');
    const benchmark = engine.getBenchmark(id);
    return json({ ok: true, benchmark, quality: engine.qualitySummary(benchmark) });
  });

  add('/benchmark/delete', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...engine.deleteBenchmark(payload.id) });
  });

  add('/benchmark/quality', ['GET'], async (request) => {
    const id = requireParam(query(request), 'id');
    return json({ ok: true, quality: engine.qualitySummary(engine.getBenchmark(id)) });
  });

  add('/item/update', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...engine.updateItem(payload) });
  });

  add('/item/delete', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...engine.deleteItem(payload) });
  });

  add('/benchmark/export', ['GET'], async (request) => {
    const id = requireParam(query(request), 'id');
    const artifact = engine.exportBenchmark(id);
    return new Response(artifact.body, {
      status: 200,
      headers: {
        'content-type': artifact.contentType,
        'content-disposition': `attachment; filename="${artifact.filename}"`,
        'cache-control': 'no-store',
      },
    });
  });

  /* ----------------------------- models ----------------------------- */

  add('/models', ['GET'], async () => json({ ok: true, ...(await engine.listModels()) }));

  add('/models/save', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...engine.saveModels(payload) });
  });

  add('/models/test', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...(await engine.testModel(payload)) });
  });

  add('/keys', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...(await engine.setKey(payload)) });
  });

  add('/keys/clear', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...(await engine.clearKey(payload.ref)) });
  });

  add('/keys/status', ['GET'], async () => json({ ok: true, ...(await engine.keyStatus()) }));

  /* ------------------------------ runs ------------------------------ */

  // One registration per exact path: the connection rejects a duplicate path
  // even when the method differs, so GET and POST share one handler.
  add('/runs', ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      const limit = Number(query(request).get('limit') || 30);
      return json({ ok: true, runs: engine.listRuns(limit) });
    }
    const payload = await readBody(request);
    const run = engine.createRun(payload);
    const started = payload.auto_start === false ? run : engine.startRun(run.id);
    return json({ ok: true, run: started });
  });

  add('/run', ['GET'], async (request) => {
    const runId = requireParam(query(request), 'run_id');
    return json({ ok: true, run: engine.runStatus(runId) });
  });

  add('/run/cancel', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, run: engine.cancelRun(payload.run_id) });
  });

  add('/run/resume', ['POST'], async (request) => {
    const payload = await readBody(request);
    const run = engine.resumeRun(payload.run_id, { retryFailed: payload.retry_failed !== false });
    return json({ ok: true, run });
  });

  add('/run/delete', ['POST'], async (request) => {
    const payload = await readBody(request);
    return json({ ok: true, ...engine.deleteRun(payload.run_id) });
  });

  add('/meta', ['GET'], async (request) => {
    const runId = requireParam(query(request), 'run_id');
    return json({ ok: true, meta: engine.metaEvaluation(runId) });
  });

  add('/export', ['GET'], async (request) => {
    const params = query(request);
    const runId = requireParam(params, 'run_id');
    const format = (params.get('format') || 'markdown').toLowerCase();
    const artifact = engine.export(runId, format);
    return new Response(artifact.body, {
      status: 200,
      headers: {
        'content-type': artifact.contentType,
        'content-disposition': `attachment; filename="${artifact.filename}"`,
        'cache-control': 'no-store',
      },
    });
  });

  return disposers;
}
