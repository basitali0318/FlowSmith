import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm';

test('Groq-style LLM engine: extract -> validate fails -> repair loop -> valid', async () => {
  const mock = await startMockLlm();
  process.env.LLM_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = mock.url;
  const { LlmService } = await import('../llm/llm.service');
  const { runPipeline } = await import('../pipeline/graph');
  const llm = new LlmService();
  const trace: string[] = [];
  const r = await runPipeline({ llm, onTrace: (t) => t.status !== 'running' && trace.push(`${t.step}:${t.status}`) }, 'Customer places an order. Sales checks stock.', 'llm');
  await mock.close();

  assert.equal(r.engine, 'llm');
  assert.equal(r.valid, true);
  assert.ok(r.repairs >= 1, 'repair loop should have run');
  assert.ok(trace.includes('validate:warn') && trace.includes('repair:warn'));
  assert.ok(mock.calls.every((c) => c.auth === 'Bearer test-key'), 'API key sent as bearer token');
  assert.match(r.summary, /Customers place orders/);
});

test('model auto-selection: retired default model is replaced by an available open model', async () => {
  const mock = await startMockLlm(['whisper-large-v3', 'llama-3.1-8b-instant', 'qwen/qwen3-32b', 'meta-llama/llama-guard-4-12b']);
  process.env.LLM_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = mock.url;
  delete process.env.LLM_MODEL;
  const { LlmService } = await import('../llm/llm.service');
  const llm = new LlmService();
  assert.equal(llm.model, 'llama-3.3-70b-versatile');
  assert.equal(await llm.isAvailable(), true);
  assert.equal(llm.model, 'qwen/qwen3-32b', 'prefers a large chat model, never whisper/guard');
  await llm.json('Return JSON', 'x');
  assert.equal(mock.calls.find((c) => c.url === '/v1/chat/completions').body.model, 'qwen/qwen3-32b');
  assert.equal(llm.describe().configuredModel, 'llama-3.3-70b-versatile');
  await mock.close();
});

test('model auto-selection: an explicitly pinned LLM_MODEL is respected', async () => {
  const mock = await startMockLlm(['llama-3.1-8b-instant']);
  process.env.LLM_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = mock.url;
  process.env.LLM_MODEL = 'my-pinned-model';
  const { LlmService } = await import('../llm/llm.service');
  const llm = new LlmService();
  await llm.isAvailable();
  assert.equal(llm.model, 'my-pinned-model');
  delete process.env.LLM_MODEL;
  await mock.close();
});

test('reasoning-model output: <think> blocks are stripped before JSON parsing', async () => {
  const { parseJsonLoose, stripThinking } = await import('../llm/llm.service');
  assert.deepEqual(parseJsonLoose('<think>maybe {"a": 1} first</think>\n{"title":"x"}'), { title: 'x' });
  assert.equal(stripThinking('<think>hidden</think>Visible'), 'Visible');
});
