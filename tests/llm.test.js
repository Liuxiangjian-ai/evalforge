import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelError, ModelGateway } from '../src/host/llm.js';

/** A fake Host LLM service whose stream never yields. */
function hangingLlm() {
  return {
    listProviders: () => [{ id: 'fake', displayName: 'Fake Provider' }],
    listModels: async () => [{ provider: 'fake', id: 'fake-model', name: 'Fake Model' }],
    stream: () => ({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) };
      },
    }),
  };
}

test('a stalled provider stream cannot hold a call open indefinitely', async () => {
  const gateway = new ModelGateway({ llm: hangingLlm() });
  const started = Date.now();
  await assert.rejects(
    () => gateway.chat(
      { kind: 'native', provider: 'fake', model: 'fake-model', label: 'Fake' },
      { messages: [{ role: 'user', content: 'hi' }], timeoutMs: 600 },
    ),
    (err) => {
      assert.ok(err instanceof ModelError);
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.ok(Date.now() - started < 4000, 'the hard deadline must fire near the timeout');
});

test('the native catalog survives one failing provider', async () => {
  const gateway = new ModelGateway({
    llm: {
      listProviders: () => [{ id: 'ok', displayName: 'OK' }, { id: 'bad', displayName: 'Bad' }],
      listModels: async (provider) => {
        if (provider === 'bad') throw new Error('provider exploded');
        return [{ provider: 'ok', id: 'm1', name: 'Model 1' }];
      },
    },
  });
  const catalog = await gateway.listNativeCatalog();
  assert.equal(catalog.filter((entry) => entry.model).length, 1);
  assert.ok(catalog.some((entry) => entry.error));
});

test('an OpenAI-compatible call without a credential fails with a clear code', async () => {
  const gateway = new ModelGateway({ credentials: { resolve: async () => ({ value: '' }) } });
  await assert.rejects(
    () => gateway.chat(
      { kind: 'openai', baseUrl: 'https://example.invalid/v1', model: 'm', apiKeyRef: 'EVALFORGE_TEST_KEY', label: 'M' },
      { messages: [{ role: 'user', content: 'hi' }], timeoutMs: 1000 },
    ),
    (err) => err.code === 'MISSING_CREDENTIAL',
  );
});

test('plugin keys may only be written under the EVALFORGE_ prefix', async () => {
  const gateway = new ModelGateway();
  await assert.rejects(() => gateway.setKey({ ref: 'OTHER_KEY', key: 'x'.repeat(20) }), /EVALFORGE_/);
  const saved = await gateway.setKey({ ref: 'EVALFORGE_TEST_KEY', key: 'sk-test-1234567890', remember: false });
  assert.equal(saved.configured, true);
  assert.equal(saved.stored, false);
  assert.equal(await gateway.resolveKey('EVALFORGE_TEST_KEY'), 'sk-test-1234567890');
});

test('native stream assembly ignores empty completions but keeps reasoning-derived answers', async () => {
  const makeLlm = (chunks) => ({
    listProviders: () => [],
    stream: () => (async function* gen() { for (const chunk of chunks) yield chunk; })(),
  });

  const empty = new ModelGateway({ llm: makeLlm([{ type: 'finish', reason: { kind: 'stop' } }]) });
  await assert.rejects(
    () => empty.chat({ kind: 'native', provider: 'p', model: 'm' }, { messages: [{ role: 'user', content: 'x' }], timeoutMs: 1000 }),
    (err) => err.code === 'EMPTY_RESPONSE',
  );

  const derived = new ModelGateway({
    llm: makeLlm([
      { type: 'reasoning-delta', index: 0, text: 'The registered outcome is A because ... 答案: C' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]),
  });
  const result = await derived.chat(
    { kind: 'native', provider: 'p', model: 'm' },
    { messages: [{ role: 'user', content: 'x' }], timeoutMs: 1000 },
  );
  assert.equal(result.derived_from_reasoning, true);
  assert.equal(result.text, '答案: C');
  assert.equal(result.finish_reason, 'max-tokens');
});

test('native stream assembly collects text, usage and finish reason', async () => {
  const gateway = new ModelGateway({
    llm: {
      listProviders: () => [],
      stream: () => (async function* gen() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '答案: ' };
        yield { type: 'text-delta', index: 0, text: 'B' };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
    },
  });
  const result = await gateway.chat({ kind: 'native', provider: 'p', model: 'm' }, { messages: [{ role: 'user', content: 'x' }], timeoutMs: 1000 });
  assert.equal(result.text, '答案: B');
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.completion_tokens, 2);
  assert.equal(result.derived_from_reasoning, false);
});
