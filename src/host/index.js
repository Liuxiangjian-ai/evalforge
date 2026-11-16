import { PLUGIN_VERSION } from '../shared/constants.js';
import { registerApi } from './api.js';
import { EvalForgeEngine } from './engine.js';
import { ModelGateway } from './llm.js';
import { runSelfTest } from './selftest.js';
import { Store } from './store.js';

export const name = 'dsh-plugin-evalforge';
export const version = PLUGIN_VERSION;
/**
 * Every service is optional so the same bundle activates in `web` (routes),
 * `headless` (self-test) and any other profile.
 */
export const inject = [];

/**
 * EvalForge Host entry.
 *
 * The Host owns registry requests, ground-truth extraction, storage writes and
 * every model call. The browser only receives display-safe state through the
 * authenticated Connection Fetch routes under /api/evalforge.
 */
export function apply(ctx, config = {}) {
  const store = new Store(config.dataDir);
  const gateway = new ModelGateway();
  const engine = new EvalForgeEngine(ctx, { store, gateway, config });
  const say = (message, ...args) => {
    try {
      if (ctx.logger?.info) ctx.logger.info(message, ...args);
      else console.log(`[evalforge] ${String(message).replace(/%s/g, () => String(args.shift() ?? ''))}`);
    } catch {
      // logging must never break activation
    }
  };
  say('host apply start (data dir %s)', store.baseDir);

  ctx.effect(() => () => engine.dispose(), 'evalforge: engine lifetime');

  ctx.inject(['connection'], (scoped) => {
    try {
      const disposers = registerApi(scoped, engine);
      scoped.effect(
        () => () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // Route disposal is best-effort during plugin unload.
            }
          }
        },
        'evalforge: api routes',
      );
      say('API mounted at /api/evalforge (%s routes)', String(disposers.length));
    } catch (err) {
      console.error('[evalforge] failed to mount API routes:', err?.stack || err);
    }
  });

  ctx.inject(['llm'], (scoped) => {
    gateway.setServices({ llm: scoped.llm });
    scoped.logger?.info?.('EvalForge attached to the Host LLM service (%s providers)', gateway.listProviders().length);
    return () => gateway.setServices({ llm: null });
  });

  ctx.inject(['credentials'], (scoped) => {
    gateway.setServices({ credentials: scoped.credentials });
    return () => gateway.setServices({ credentials: null });
  });

  if (config.selfTest && config.selfTest.enabled) {
    const timer = setTimeout(() => {
      runSelfTest(engine, config.selfTest, ctx.logger || console).catch((err) => {
        ctx.logger?.error?.(`EvalForge self-test crashed: ${err?.message || err}`);
      });
    }, Number(config.selfTest.delay_ms || 1500));
    if (typeof timer.unref === 'function') timer.unref();
    ctx.effect(() => () => clearTimeout(timer), 'evalforge: self-test timer');
  }

  ctx.logger?.info?.('EvalForge loaded (v%s)', PLUGIN_VERSION);
}

export default { name, inject, apply, version: PLUGIN_VERSION };
