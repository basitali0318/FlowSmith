import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let base = '';
let close: () => Promise<void>;
let token = '';

before(async () => {
  process.env.LLM_PROVIDER = 'none';
  delete process.env.DATABASE_URL;
  process.env.JWT_SECRET = 'test';
  process.env.RATE_LIMIT = '1000';
  process.env.GENERATE_RATE_LIMIT = '1000';
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0);
  const url = await app.getUrl();
  base = url.replace('[::1]', 'localhost') + '/api';
  close = () => app.close();
});
after(async () => close());

const call = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as any) } });

test('health is public and reports storage + engine', async () => {
  const j: any = await (await call('/health')).json();
  assert.equal(j.status, 'ok');
  assert.equal(j.storage, 'memory');
  assert.equal(j.engine.mode, 'rules');
});

test('auth: rejects bad credentials and protects routes', async () => {
  assert.equal((await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@flowsmith.ai', password: 'wrong' }) })).status, 401);
  assert.equal((await call('/processes')).status, 401);
  const ok = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@flowsmith.ai', password: 'Demo@1234' }) });
  assert.equal(ok.status, 201);
  token = ((await ok.json()) as any).token;
  assert.ok(token);
});

test('register validates input and prevents duplicates', async () => {
  const bad = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: 'x', password: 'short' }) });
  assert.equal(bad.status, 400);
  const dup = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: 'DEMO@flowsmith.ai', password: 'longenough1' }) });
  assert.equal(dup.status, 409);
});

async function waitDone(id: string) {
  for (let i = 0; i < 50; i++) {
    const p: any = await (await call(`/processes/${id}`)).json();
    if (p.status === 'done' || p.status === 'failed') return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

test('generate from text: queued -> done with valid BPMN, trace and insights', async () => {
  const f = new FormData();
  f.set('description', 'The customer submits an order. The clerk checks stock. If the item is out of stock, the clerk notifies the customer and the process ends. The warehouse ships the order.');
  const r = await call('/processes', { method: 'POST', body: f });
  assert.equal(r.status, 201);
  const { id } = (await r.json()) as any;
  const p = await waitDone(id);
  assert.equal(p.status, 'done');
  assert.equal(p.result.valid, true);
  assert.match(p.result.xml, /<bpmn:exclusiveGateway/);
  assert.ok(p.trace.some((t: any) => t.step === 'validate'));
  assert.ok(p.result.metrics.tasks >= 4);
  assert.equal(p.userId, undefined, 'internal fields are not leaked');
});

test('generate from uploaded .txt file and list/delete', async () => {
  const f = new FormData();
  f.set('file', new Blob(['1. The employee submits a leave request.\n2. The manager approves the request.\n3. HR updates the leave balance.'], { type: 'text/plain' }), 'sop.txt');
  const { id } = (await (await call('/processes', { method: 'POST', body: f })).json()) as any;
  assert.equal((await waitDone(id)).status, 'done');
  const list: any[] = await (await call('/processes')).json();
  assert.ok(list.some((x) => x.id === id));
  assert.equal((await call(`/processes/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/processes/${id}`)).status, 404);
});

test('rejects too-short input and unsupported file types', async () => {
  const a = new FormData(); a.set('description', 'hi');
  assert.equal((await call('/processes', { method: 'POST', body: a })).status, 400);
  const b = new FormData(); b.set('file', new Blob(['x']), 'evil.exe');
  assert.equal((await call('/processes', { method: 'POST', body: b })).status, 400);
});

test('saving edited XML re-validates it', async () => {
  const f = new FormData();
  f.set('description', 'The employee submits a leave request. The manager approves the request. HR updates the leave balance.');
  const { id } = (await (await call('/processes', { method: 'POST', body: f })).json()) as any;
  const p = await waitDone(id);
  const broken = p.result.xml.replace(/<bpmn:endEvent[\s\S]*?<\/bpmn:endEvent>/, '');
  const res: any = await (await call(`/processes/${id}/xml`, { method: 'PUT', body: JSON.stringify({ xml: broken }) })).json();
  assert.equal(res.valid, false);
  assert.ok(res.issues.length > 0);
});
