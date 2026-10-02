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
