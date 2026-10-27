import assert from 'node:assert/strict';
import test from 'node:test';
import { LoopbackOllamaModelGoalGenerator } from '../src/core/loopback-ollama-model-goal-generator.ts';
import { validateModelGoalProposal } from '../src/core/model-goal-proposal.ts';

const scope = {
  objective: 'Inspect an explicitly approved help page',
  approvedBrowserOrigins: ['https://docs.example.test'],
  approvedRoots: []
};
const proposal = {
  goal: { kind: 'browser-navigation', url: 'https://docs.example.test/help' },
  successConditions: ['Observed page URL matches']
};
const request = (signal = new AbortController().signal) => ({
  modelId: 'gemma3:1b', prompt: JSON.stringify(scope),
  maxOutputTokens: 512, signal
});
function response(text = JSON.stringify(proposal)) {
  return new Response(JSON.stringify({ model: 'gemma3:1b', response: text, done: true }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
}

test('C05 loopback Ollama adapter sends only fixed local JSON-only text generation', async () => {
  let sent = 0;
  const generator = new LoopbackOllamaModelGoalGenerator({
    fetchFn: (async (url, options) => {
      sent++;
      assert.equal(url, 'http://127.0.0.1:11434/api/generate');
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.cache, 'no-store');
      assert.equal(options?.referrerPolicy, 'no-referrer');
      assert.equal(options?.headers && (options.headers as Record<string, string>)['content-type'], 'application/json');
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(Object.keys(body).sort(), ['format','model','options','prompt','stream'].sort());
      assert.equal(body.format, 'json');
      assert.equal(body.stream, false);
      assert.equal(body.model, 'gemma3:1b');
      assert.deepEqual(body.options, { temperature: 0, num_predict: 512 });
      assert.equal(body.prompt, JSON.stringify(scope));
      return response();
    }) as typeof fetch
  });
  const result = await generator.generate(request());
  assert.equal(sent, 1);
  assert.deepEqual(JSON.parse(result.text), proposal);
  assert.deepEqual(validateModelGoalProposal(JSON.parse(result.text), scope), proposal);
});

test('C05 invalid model ids, oversized prompts and forbidden token requests never fetch', async () => {
  let fetched = 0;
  const generator = new LoopbackOllamaModelGoalGenerator({
    fetchFn: (async () => { fetched++; return response(); }) as typeof fetch
  });
  for (const bad of [
    { modelId: 'https://evil.example/model' },
    { modelId: 'model name with spaces' },
    { prompt: 'x'.repeat(17 * 1024) },
    { maxOutputTokens: 100_000 },
    { maxOutputTokens: 1 }
  ]) {
    await assert.rejects(generator.generate({ ...request(), ...bad }),
      (e: any) => e?.code === 'TASK_LOCAL_MODEL_CONFIG_INVALID');
  }
  assert.equal(fetched, 0);
});

test('C05 already-cancelled model request fails before fetch and without unhandled rejection', async () => {
  const aborted = new AbortController();
  aborted.abort();
  let fetched = 0;
  const generator = new LoopbackOllamaModelGoalGenerator({
    fetchFn: (async () => { fetched++; return response(); }) as typeof fetch
  });
  await assert.rejects(generator.generate(request(aborted.signal)),
    (e: any) => e?.code === 'TASK_LOCAL_MODEL_ABORTED');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched, 0);
});

test('C05 cancellation rejects promptly even when transport ignores AbortSignal', async () => {
  const parent = new AbortController();
  const generator = new LoopbackOllamaModelGoalGenerator({
    timeoutMs: 1000,
    fetchFn: (async () => await new Promise<Response>(() => {})) as typeof fetch
  });
  const result = generator.generate(request(parent.signal));
  parent.abort();
  await assert.rejects(result, (e: any) => e?.code === 'TASK_LOCAL_MODEL_ABORTED');
});

test('C05 timeout ignores hung transport and cannot return a late model proposal', async () => {
  const generator = new LoopbackOllamaModelGoalGenerator({
    timeoutMs: 30,
    fetchFn: (async () => await new Promise<Response>(() => {})) as typeof fetch
  });
  await assert.rejects(generator.generate(request()),
    (e: any) => e?.code === 'TASK_LOCAL_MODEL_TIMEOUT');
});

test('C05 body and output text limits reject untrusted oversized local model responses', async () => {
  const generator = new LoopbackOllamaModelGoalGenerator({
    fetchFn: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(65 * 1024)));
        controller.close();
      }
    }))) as typeof fetch
  });
  await assert.rejects(generator.generate(request()),
    (e: any) => e?.code === 'TASK_LOCAL_MODEL_OVERSIZE');
  const textTooBig = new LoopbackOllamaModelGoalGenerator({
    fetchFn: (async () => response('x'.repeat(34 * 1024))) as typeof fetch
  });
  await assert.rejects(textTooBig.generate(request()),
    (e: any) => e?.code === 'TASK_LOCAL_MODEL_INVALID');
});

test('C05 errors and redirects never expose external transport details', async () => {
  const errorGenerator = new LoopbackOllamaModelGoalGenerator({
    fetchFn: (async () => { throw new Error('private-provider-token-in-error'); }) as typeof fetch
  });
  await assert.rejects(errorGenerator.generate(request()), (e: any) => {
    assert.equal(e?.code, 'TASK_LOCAL_MODEL_UNAVAILABLE');
    assert.equal(String(e?.message).includes('private-provider-token-in-error'), false);
    return true;
  });
  const rejectedHttp = new LoopbackOllamaModelGoalGenerator({
    fetchFn: (async () => new Response('foreign service', { status: 503 })) as typeof fetch
  });
  await assert.rejects(rejectedHttp.generate(request()),
    (e: any) => e?.code === 'TASK_LOCAL_MODEL_UNAVAILABLE');
});

test('C05 malformed model envelopes fail closed without claiming a verified task', async () => {
  for (const raw of ['not-json', '{}', '{"response":{}}', '{"response":""}']) {
    const generator = new LoopbackOllamaModelGoalGenerator({
      fetchFn: (async () => new Response(raw, { status: 200 })) as typeof fetch
    });
    await assert.rejects(generator.generate(request()),
      (e: any) => e?.code === 'TASK_LOCAL_MODEL_INVALID');
  }
});
