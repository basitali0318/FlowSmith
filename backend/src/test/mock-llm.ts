import http from 'node:http';

/** Minimal OpenAI-compatible (Groq-shaped) server used by tests; no real model involved. */
export function startMockLlm(): Promise<{ url: string; calls: any[]; close: () => Promise<void> }> {
  const calls: any[] = [];
  const broken = {
    title: 'Order Fulfilment',
    actors: ['Customer', 'Sales'],
    nodes: [
      { id: 'a', type: 'task', name: 'Place order', actor: 'Customer' },
      { id: 'b', type: 'task', name: 'Check stock', actor: 'Sales' },
      { id: 'c', type: 'xor', name: 'In stock?' },
      { id: 'd', type: 'task', name: 'Ship order', actor: 'Sales' },
      { id: 'e', type: 'task', name: 'Notify backorder', actor: 'Sales' },
    ],
    flows: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'c', to: 'e' },
    ],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      calls.push({ url: req.url, auth: req.headers.authorization, body: json });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      const sys: string = json.messages?.[0]?.content ?? '';
      const content = /repairing/.test(sys)
        ? JSON.stringify({ ...broken, nodes: [{ id: 's', type: 'start', name: 'Start' }, ...broken.nodes, { id: 'z', type: 'end', name: 'Done' }], flows: [{ from: 's', to: 'a' }, ...broken.flows.map((f) => (f.from === 'c' ? { ...f, label: f.to === 'd' ? 'Yes' : 'No' } : f)), { from: 'd', to: 'z' }, { from: 'e', to: 'z' }] })
        : json.response_format
          ? JSON.stringify(broken)
          : 'Customers place orders and sales checks stock; the main weakness is the missing start, end and unlabeled branches.';
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as any).port;
    resolve({ url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r())) });
  }));
}
