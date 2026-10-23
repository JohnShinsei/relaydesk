import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.ts';
import { createHermesDriver } from '../server/hermes-driver.ts';
import type { Bootstrap, Session, Task, TaskFeedPage } from '../shared/types.ts';

// Two real HTTP hops, entirely synthetic: never connects to the installed Hermes or a model.
test('HTTP foundation: RelayDesk forwards one task to local Hermes, projects receipts and confirms stop without replay', async t => {
  const admissions: { headers: Record<string, unknown>; body: unknown }[] = [];
  let status = 'running';
  let stoppingPolls = 0;
  const upstream = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, 'Bearer synthetic-bridge-test-key');
      const respond = (value: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.url === '/v1/capabilities') return respond({ object: 'hermes.api_server.capabilities', platform: 'hermes-agent', auth: { type: 'bearer', required: true }, features: { run_submission: true, run_status: true, run_stop: true, run_approval_response: true, runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 } } });
      if (request.url === '/v1/runs' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += String(chunk);
        admissions.push({ headers: request.headers, body: JSON.parse(body) });
        return respond({ run_id: 'fixture-run', status: 'started' });
      }
      if (request.url === '/v1/runs/fixture-run/stop' && request.method === 'POST') { status = 'stopping'; return respond({ status }); }
      if (request.url === '/v1/runs/fixture-run') {
        if (status === 'stopping' && ++stoppingPolls > 1) status = 'cancelled';
        return respond({ run_id: 'fixture-run', session_id: 'fixture-session', status, output: '' });
      }
      response.writeHead(404).end();
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())));
  const driver = createHermesDriver({ baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: 'synthetic-bridge-test-key', pollIntervalMs: 5, requestTimeoutMs: 2000, timeoutMs: 5000, stopConfirmationMs: 2000 });
  const app = createApp({ dbPath: ':memory:', delayMs: 1, drivers: [driver] });
  t.after(() => app.close());
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function api<T>(path: string, body?: unknown) {
    const response = await fetch(origin + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as T };
  }
  const bootstrap = (await api<Bootstrap>('/api/bootstrap')).data;
  assert.equal(bootstrap.adapters.find(adapter => adapter.id === 'hermes')?.kind, 'http');
  assert.match(bootstrap.runtime.agent, /Hermes/);
  const created = await api<{ session: Session }>('/api/sessions', { adapterId: 'hermes' });
  assert.equal(created.status, 201);
  const sessionId = created.data.session.id;
  const payload = { prompt: 'synthetic task only', mode: 'chat', idempotencyKey: 'unique-browser-request-1' };
  const submitted = await api<{ task: Task }>(`/api/sessions/${sessionId}/tasks`, payload);
  assert.equal(submitted.status, 202);
  const taskId = submitted.data.task.id;
  for (let i = 0; i < 100; i++) {
    const session = (await api<{ session: Session }>(`/api/sessions/${sessionId}`)).data.session;
    if (session.engineBinding) break;
    await delay(10);
  }
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].headers['idempotency-key'], taskId);
  assert.deepEqual(admissions[0].body, { input: 'synthetic task only' });
  const retry = await api<{ task: Task }>(`/api/sessions/${sessionId}/tasks`, payload);
  assert.equal(retry.data.task.id, taskId);
  assert.equal(admissions.length, 1);
  const feed = (await api<{ feed: TaskFeedPage }>('/api/task-feed')).data.feed;
  assert.equal(feed.items[0].provider, 'Hermes');
  assert.ok(!JSON.stringify(feed).includes('synthetic task only'));
  const cancel = await api<{ task: Task }>(`/api/tasks/${taskId}/cancel`, {});
  assert.equal(cancel.data.task.status, 'cancelling');
  let final: Session | undefined;
  for (let i = 0; i < 100; i++) {
    final = (await api<{ session: Session }>(`/api/sessions/${sessionId}`)).data.session;
    if (final.tasks[0].status === 'cancelled') break;
    await delay(10);
  }
  assert.equal(final?.tasks[0].status, 'cancelled');
  assert.equal(admissions.length, 1);
  // HTTP requests cannot set the privileged bridge URL, executable, or tool configuration.
  assert.equal((await api('/api/sessions', { adapterId: 'hermes', baseUrl: 'http://other-host' })).status, 400);
});
