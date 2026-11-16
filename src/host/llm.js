import { parseAnswer, redactSecrets } from '../shared/text.js';

export class ModelError extends Error {
  constructor(message, { code = 'MODEL_ERROR', retryable = false, status = 0, model = '' } = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.model = model;
  }
}

const RETRYABLE_CODES = new Set(['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'SERVER', 'OVERLOADED', 'QUOTA']);
const KEY_REF_PATTERN = /^EVALFORGE_[A-Z0-9_]{2,64}$/;

function classifyStatus(status) {
  if (status === 429) return { code: 'RATE_LIMIT', retryable: true };
  if (status === 408) return { code: 'TIMEOUT', retryable: true };
  if (status >= 500) return { code: 'SERVER', retryable: true };
  if (status === 401 || status === 403) return { code: 'AUTH', retryable: false };
  if (status === 404) return { code: 'NOT_FOUND', retryable: false };
  return { code: 'HTTP_ERROR', retryable: false };
}

function usageFromNative(usage) {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = Number(usage.inputTokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.outputTokens ?? usage.completion_tokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.totalTokens ?? usage.total_tokens ?? prompt + completion) || prompt + completion,
  };
}

/**
 * One gateway over the two model paths DeepSeek Harness can offer a plugin:
 *
 *  - `native`: the Host's `ctx.llm` service, which already holds the user's
 *    configured providers, credentials and model catalog.
 *  - `openai`: an OpenAI-compatible endpoint whose key lives in the Host
 *    credential store (never in plugin config or logs).
 */
export class ModelGateway {
  constructor({ llm = null, credentials = null } = {}) {
    this.llm = llm;
    this.credentials = credentials;
    this.memoryKeys = new Map();
  }

  setServices({ llm, credentials }) {
    if (llm !== undefined) this.llm = llm;
    if (credentials !== undefined) this.credentials = credentials;
  }

  get nativeAvailable() {
    return Boolean(this.llm && typeof this.llm.listProviders === 'function');
  }

  /** Providers registered on the Host's LLM service. */
  listProviders() {
    if (!this.nativeAvailable) return [];
    try {
      return this.llm.listProviders().map((provider) => ({
        id: provider.id,
        label: provider.displayName || provider.name || provider.id,
        models: Array.isArray(provider.models) ? provider.models : undefined,
      }));
    } catch {
      return [];
    }
  }

  /** Enumerate the native model catalog; one failing provider must not blank the list. */
  async listNativeCatalog() {
    const out = [];
    for (const provider of this.listProviders()) {
      try {
        const models = await this.llm.listModels(provider.id);
        for (const model of models || []) {
          out.push({
            kind: 'native',
            provider: provider.id,
            provider_label: provider.label,
            model: model.id,
            model_label: model.name || model.id,
            description: model.description || '',
          });
        }
      } catch (err) {
        out.push({
          kind: 'native',
          provider: provider.id,
          provider_label: provider.label,
          model: '',
          model_label: '',
          error: redactSecrets(err?.message || String(err)),
        });
      }
    }
    return out;
  }

  async resolveKey(ref) {
    if (!ref) return '';
    if (this.memoryKeys.has(ref)) return this.memoryKeys.get(ref);
    if (this.credentials?.resolve) {
      try {
        const hit = await this.credentials.resolve(ref);
        if (hit?.value) return hit.value;
      } catch {
        // Fall through to environment.
      }
    }
    return process.env[ref] || '';
  }

  async describeKey(ref) {
    if (!ref) return { ref, configured: false, source: 'unset', writable: true };
    if (this.memoryKeys.has(ref)) return { ref, configured: true, source: 'session-memory', writable: true };
    if (this.credentials?.describe) {
      try {
        const info = await this.credentials.describe(ref);
        if (info) {
          return {
            ref,
            configured: Boolean(info.configured),
            source: info.source || 'credential-store',
            writable: info.writable !== false,
          };
        }
      } catch {
        // Fall through.
      }
    }
    const envValue = process.env[ref];
    return { ref, configured: Boolean(envValue), source: envValue ? 'environment' : 'unset', writable: true };
  }

  async setKey({ ref, key, remember = true }) {
    if (!KEY_REF_PATTERN.test(String(ref || ''))) {
      throw new ModelError('EvalForge may only write credential references prefixed with EVALFORGE_', { code: 'BAD_KEY_REF' });
    }
    const value = String(key || '').trim();
    if (value.length < 8) throw new ModelError('API key is too short', { code: 'BAD_KEY' });
    if (value.length > 1000) throw new ModelError('API key is too long', { code: 'BAD_KEY' });
    this.memoryKeys.set(ref, value);
    let stored = false;
    let warning = '';
    if (remember) {
      if (!this.credentials?.set) {
        warning = 'Credential store is unavailable; the key is kept in this Host session only.';
      } else {
        try {
          await this.credentials.set(ref, value);
          stored = true;
        } catch (err) {
          warning = `Credential store rejected the key; kept in Host memory only: ${redactSecrets(err?.message || err)}`;
        }
      }
    }
    return { ref, configured: true, stored, source: stored ? 'credential-store' : 'session-memory', warning };
  }

  async clearKey(ref) {
    if (!KEY_REF_PATTERN.test(String(ref || ''))) throw new ModelError('invalid EvalForge credential reference', { code: 'BAD_KEY_REF' });
    this.memoryKeys.delete(ref);
    if (this.credentials?.unset) {
      try {
        await this.credentials.unset(ref);
      } catch {
        // Clearing memory still succeeded.
      }
    }
    return { ref, configured: Boolean(process.env[ref]), source: process.env[ref] ? 'environment' : 'unset' };
  }

  /* ------------------------------------------------------------------ */

  async chat(spec, { messages, temperature = 0.2, maxTokens = 512, timeoutMs = 90000, signal, jsonMode = false } = {}) {
    if (!spec || !spec.model) throw new ModelError('model id is required', { code: 'BAD_MODEL' });
    const effectiveTimeout = Math.max(1000, Number(timeoutMs) || 90000);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    // A provider adapter is not required to honour the abort signal, so the call
    // is also raced against a hard deadline. Without it one stalled stream would
    // hold an evaluation cell (and its worker) open indefinitely.
    let hardTimer = null;
    // Small grace on top of the provider timeout, bounded so tests stay fast.
    const hardLimit = effectiveTimeout + Math.min(5000, Math.max(500, Math.floor(effectiveTimeout * 0.1)));
    const hardDeadline = new Promise((_, reject) => {
      hardTimer = setTimeout(() => {
        reject(new ModelError(`${spec.label || spec.model} did not finish within ${effectiveTimeout}ms`, {
          code: 'TIMEOUT',
          retryable: true,
          model: spec.model,
        }));
      }, hardLimit);
    });
    const started = Date.now();
    try {
      const call = spec.kind === 'native'
        ? this.chatNative(spec, { messages, temperature, maxTokens, signal: controller.signal, jsonMode, started })
        : this.chatOpenAi(spec, { messages, temperature, maxTokens, signal: controller.signal, jsonMode, started });
      return await Promise.race([call, hardDeadline]);
    } catch (err) {
      if (timedOut) {
        throw new ModelError(`${spec.label || spec.model} timed out after ${timeoutMs}ms`, { code: 'TIMEOUT', retryable: true, model: spec.model });
      }
      if (err?.name === 'AbortError') {
        throw new ModelError('cancelled', { code: 'ABORTED', retryable: false, model: spec.model });
      }
      if (err instanceof ModelError) throw err;
      throw new ModelError(redactSecrets(`${spec.label || spec.model} request failed: ${err?.message || err}`), {
        code: 'NETWORK',
        retryable: true,
        model: spec.model,
      });
    } finally {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async chatNative(spec, { messages, temperature, maxTokens, signal, jsonMode, started }) {
    if (!this.nativeAvailable) {
      throw new ModelError('the Host LLM service is not available in this profile', { code: 'NO_LLM_SERVICE' });
    }
    // The Host protocol accepts request-only user messages; put the whole prompt
    // in one user message so no system-message shape is assumed.
    const text = messages.map((message) => message.content).join('\n\n');
    const stream = this.llm.stream({
      provider: spec.provider,
      model: spec.model,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      temperature: Math.min(2, Math.max(0, Number(temperature) || 0)),
      maxTokens: Number(maxTokens) > 0 ? Number(maxTokens) : undefined,
      signal,
    });
    let assembled = '';
    let reasoning = '';
    let usage = null;
    let finish = null;
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') assembled += chunk.text;
      else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text;
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && !assembled) assembled = chunk.block.text;
      else if (chunk?.type === 'usage') usage = chunk.usage;
      else if (chunk?.type === 'finish') finish = chunk.reason;
    }
    if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
      const failure = finish.failure || {};
      const code = failure.code || (finish.kind === 'aborted' ? 'ABORTED' : 'MODEL_ERROR');
      throw new ModelError(redactSecrets(failure.message || `provider failure (${code})`), {
        code,
        retryable: RETRYABLE_CODES.has(code),
        status: failure.status || 0,
        model: spec.model,
      });
    }
    if (!assembled.trim()) {
      if (finish?.kind === 'max-tokens') {
        // The model was cut off inside its reasoning. If that reasoning already
        // states one unambiguous option, keep it as a transparently flagged
        // answer instead of discarding a real attempt.
        const derived = parseAnswer(reasoning.slice(-1200));
        if (derived.label) {
          return {
            text: `答案: ${derived.label}`,
            usage: usageFromNative(usage),
            latency_ms: Date.now() - started,
            model: spec.model,
            provider: spec.provider,
            finish_reason: 'max-tokens',
            derived_from_reasoning: true,
            raw_meta: usage ? { usage, reasoning_chars: reasoning.length } : { reasoning_chars: reasoning.length },
          };
        }
        throw new ModelError(
          `${spec.model} spent its whole output budget on reasoning and returned no answer; raise the max-token setting`,
          { code: 'MAX_TOKENS', retryable: false, model: spec.model },
        );
      }
      throw new ModelError(`${spec.model} returned an empty completion`, { code: 'EMPTY_RESPONSE', retryable: true, model: spec.model });
    }
    return {
      text: assembled,
      usage: usageFromNative(usage),
      latency_ms: Date.now() - started,
      model: spec.model,
      provider: spec.provider,
      finish_reason: finish?.kind || 'stop',
      derived_from_reasoning: false,
      raw_meta: usage ? { usage } : null,
    };
  }

  async chatOpenAi(spec, { messages, temperature, maxTokens, signal, jsonMode, started }) {
    const apiKey = await this.resolveKey(spec.apiKeyRef);
    if (!apiKey) {
      throw new ModelError(`missing credential ${spec.apiKeyRef}; save the key before running`, { code: 'MISSING_CREDENTIAL' });
    }
    const base = String(spec.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new ModelError('base URL is empty', { code: 'BAD_BASE_URL' });
    const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const body = {
      model: spec.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: Math.min(2, Math.max(0, Number(temperature) || 0)),
      stream: false,
    };
    if (Number(maxTokens) > 0) body.max_tokens = Number(maxTokens);
    if (jsonMode) body.response_format = { type: 'json_object' };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || rawText || response.statusText;
      const { code, retryable } = classifyStatus(response.status);
      throw new ModelError(redactSecrets(`${spec.model} returned HTTP ${response.status}: ${String(detail).slice(0, 400)}`), {
        code,
        retryable,
        status: response.status,
        model: spec.model,
      });
    }
    if (!payload) throw new ModelError(`${spec.model} returned a non-JSON response`, { code: 'BAD_RESPONSE', retryable: true, model: spec.model });
    const content = payload.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
        : '';
    if (!text.trim()) throw new ModelError(`${spec.model} returned an empty completion`, { code: 'EMPTY_RESPONSE', retryable: true, model: spec.model });
    return {
      text,
      usage: {
        prompt_tokens: Number(payload.usage?.prompt_tokens) || 0,
        completion_tokens: Number(payload.usage?.completion_tokens) || 0,
        total_tokens: Number(payload.usage?.total_tokens) || 0,
      },
      latency_ms: Date.now() - started,
      model: payload.model || spec.model,
      provider: spec.provider || spec.baseUrl,
      finish_reason: payload.choices?.[0]?.finish_reason || 'stop',
      raw_meta: { id: payload.id, created: payload.created },
    };
  }
}
