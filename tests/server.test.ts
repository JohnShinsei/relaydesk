import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Bootstrap, ExecutionAdapter, Session, Task, TaskStatus } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { SessionStore } from '../server/store.ts';
import { CodexStopUnconfirmedError } from '../server/codex-adapter.ts';

async function fixture(t: TestContext, options: { delayMs?: number; dbPath?: string; staticDir?: string; codex?: ExecutionAdapter } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-test-'));
  const dbPath = options.dbPath ?? join(directory, 'sessions.sqlite');
  const app = createApp({ dbPath, delayMs: options.delayMs ?? 2, staticDir: options.staticDir ?? join(directory, 'missing-dist'), codex: options.codex });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function api<T>(path: string, data?: unknown, headers?: Record<string, string>) {
    const response = await fetch(url + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() as T, headers: response.headers };
  }
  async function session(adapterId = 'mock-codex') {
    const result = await api<{ session: Session }>('/api/sessions', { adapterId });
    assert.equal(result.status, 201);
    return result.data.session;
  }
  async function submit(sessionId: string, prompt: string, mode = 'chat') {
    const result = await api<{ task: Task }>(`/api/sessions/${sessionId}/tasks`, { prompt, mode });
    assert.equal(result.status, 202);
    return result.data.task;
  }
  async function state(sessionId: string, status: TaskStatus, taskId?: string) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const result = await api<{ session: Session }>(`/api/sessions/${sessionId}`);
      const selected = taskId ? result.data.session.tasks.find(task => task.id === taskId) : result.data.session.tasks.at(-1);
      if (selected?.status === status) return result.data.session;
      await sleep(5);
    }
    assert.fail(`Timed out waiting for ${status}`);
  }
  return { app, url, api, session, submit, state, dbPath, directory };
}

test('bootstrap honestly exposes mock adapters and planned channels; sessions start empty', async t => {
  const f = await fixture(t);
  const result = await f.api<Bootstrap>('/api/bootstrap');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.adapters.filter(adapter => adapter.available).map(adapter => adapter.id), ['mock-codex', 'mock-claude']);
  assert.ok(result.data.adapters.filter(adapter => adapter.kind === 'cli').every(adapter => !adapter.available && adapter.reason));
  assert.ok(result.data.channels.filter(channel => channel.id !== 'web').every(channel => channel.status === 'planned'));
  assert.deepEqual((await f.api<{ sessions: unknown[] }>('/api/sessions')).data.sessions, []);
  assert.equal((await f.api('/api/sessions', { adapterId: 'unknown' })).status, 400);
  assert.equal((await f.api('/api/sessions', { adapterId: 'codex' })).status, 409);
  assert.equal((await f.api('/api/sessions', { adapterId: 'claude' })).status, 409);
});

test('bootstrap reflects runtime CLI quarantine and HTTP cannot acknowledge an interrupted process', async t => {
  const codex: ExecutionAdapter = {
    info: { id: 'codex', kind: 'cli', name: 'Codex CLI', description: 'injected test adapter', available: true },
    async execute() { throw new CodexStopUnconfirmedError('无法确认 Codex 进程已停止。'); },
  };
  const f = await fixture(t, { codex });
  assert.equal((await f.api<Bootstrap>('/api/bootstrap')).data.adapters.find(info => info.id === 'codex')?.available, true);
  const session = await f.session('codex');
  await f.submit(session.id, 'trigger unconfirmed stop');
  const failed = await f.state(session.id, 'failed');
  assert.equal(failed.tasks[0].stopUnconfirmed, true);
  const catalog = (await f.api<Bootstrap>('/api/bootstrap')).data.adapters;
  assert.equal(catalog.find(info => info.id === 'codex')?.available, false);
  assert.match(catalog.find(info => info.id === 'codex')!.reason!, /未确认结束/);
  assert.equal((await f.api('/api/sessions', { adapterId: 'codex', acknowledgeInterruptedCodex: true })).status, 400);
  assert.equal((await f.api(`/api/sessions/${session.id}/tasks`, { prompt: 'bypass', stopUnconfirmed: false })).status, 400);
  assert.equal((await f.api('/api/sessions', { adapterId: 'codex' })).status, 409);
  await f.app.close();
  const restored = await fixture(t, { dbPath: f.dbPath, codex });
  assert.equal((await restored.api<Bootstrap>('/api/bootstrap')).data.adapters.find(info => info.id === 'codex')?.available, false);
  await restored.app.close();
});

test('both adapters complete contextual streamed turns and persist across restart', async t => {
  const f = await fixture(t);
  for (const adapter of ['mock-codex', 'mock-claude']) {
    const session = await f.session(adapter);
    const first = await f.submit(session.id, '你好 🐈');
    assert.equal(first.status, 'queued');
    let snapshot = await f.state(session.id, 'completed');
    assert.deepEqual(snapshot.tasks[0].events.map(event => event.status), ['queued', 'running', 'completed']);
    assert.match(snapshot.messages[1].content, /本地模拟/);
    assert.match(snapshot.messages[1].content, /第 1 轮/);
    assert.match(snapshot.messages[1].content, /你好 🐈/);
    assert.match(snapshot.messages[1].content, adapter === 'mock-codex' ? /Codex/ : /Claude/);
    await f.submit(session.id, '继续');
    snapshot = await f.state(session.id, 'completed');
    assert.equal(snapshot.messages.length, 4);
    assert.match(snapshot.messages[3].content, /第 2 轮/);
    assert.equal(snapshot.title, '你好 🐈');
  }
  const before = (await f.api<{ sessions: { id: string }[] }>('/api/sessions')).data.sessions;
  await f.app.close();
  const second = await fixture(t, { dbPath: f.dbPath });
  const after = (await second.api<{ sessions: { id: string }[] }>('/api/sessions')).data.sessions;
  assert.deepEqual(after, before);
  const persisted = (await second.api<{ session: Session }>(`/api/sessions/${after[0].id}`)).data.session;
  assert.equal(persisted.messages.length, 4);
  assert.equal(persisted.tasks[1].status, 'completed');
  await second.app.close();
});

test('SSE starts with a snapshot, streams partial replies, reaches completion, and reconnects', async t => {
  const f = await fixture(t, { delayMs: 6 });
  const session = await f.session();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${f.url}/api/sessions/${session.id}/events`, { signal: controller.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  async function next(): Promise<Session> {
    const limit = AbortSignal.timeout(5000);
    while (true) {
      const boundary = pending.indexOf('\n\n');
      if (boundary >= 0) {
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = event.split('\n').find(line => line.startsWith('data: '));
        if (data) return (JSON.parse(data.slice(6)) as { session: Session }).session;
      } else {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => limit.addEventListener('abort', () => reject(new Error('SSE timed out')), { once: true })),
        ]);
        assert.equal(chunk.done, false);
        pending += decoder.decode(chunk.value, { stream: true });
      }
    }
  }
  assert.equal((await next()).messages.length, 0);
  await f.submit(session.id, '验证流式输出');
  const lengths: number[] = [];
  let completed: Session;
  while (true) {
    const snapshot = await next();
    const assistant = snapshot.messages.find(message => message.role === 'assistant');
    if (assistant) lengths.push(assistant.content.length);
    if (snapshot.tasks.at(-1)?.status === 'completed') { completed = snapshot; break; }
  }
  assert.ok(new Set(lengths).size > 4, 'multiple partial replies must be observable');
  assert.ok(lengths.every((length, i) => i === 0 || length >= lengths[i - 1]));
  controller.abort();
  const reconnect = new AbortController();
  const freshStream = await fetch(`${f.url}/api/sessions/${session.id}/events`, { signal: reconnect.signal });
  const freshChunk = await freshStream.body!.getReader().read();
  const freshText = new TextDecoder().decode(freshChunk.value);
  assert.ok(freshText.includes(JSON.stringify({ session: completed })));
  reconnect.abort();
});

test('one active task per session; queued cancellation prevents output and terminal changes', async t => {
  const f = await fixture(t, { delayMs: 50 });
  const session = await f.session();
  const task = await f.submit(session.id, '取消这个任务');
  assert.equal((await f.api(`/api/sessions/${session.id}/tasks`, { prompt: '重复提交' })).status, 409);
  assert.equal((await f.api(`/api/tasks/${task.id}/cancel`, {})).status, 200);
  assert.equal((await f.api(`/api/tasks/${task.id}/approve`, {})).status, 409);
  assert.equal((await f.api(`/api/tasks/${task.id}/cancel`, {})).status, 409);
  await sleep(180);
  const snapshot = await f.state(session.id, 'cancelled');
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.tasks[0].events.at(-1)?.status, 'cancelled');
});

test('cancellation during streaming freezes content and a new task can complete', async t => {
  const f = await fixture(t, { delayMs: 8 });
  const session = await f.session();
  const task = await f.submit(session.id, '中途取消');
  for (let attempts = 0; attempts < 200; attempts++) {
    const snapshot = (await f.api<{ session: Session }>(`/api/sessions/${session.id}`)).data.session;
    if (snapshot.messages.some(message => message.role === 'assistant')) break;
    await sleep(5);
  }
  assert.equal((await f.api(`/api/tasks/${task.id}/cancel`, {})).status, 200);
  const frozen = (await f.api<{ session: Session }>(`/api/sessions/${session.id}`)).data.session;
  assert.equal(frozen.messages.length, 2);
  await sleep(200);
  const later = (await f.api<{ session: Session }>(`/api/sessions/${session.id}`)).data.session;
  assert.deepEqual(later, frozen);
  const next = await f.submit(session.id, '第二个任务');
  const complete = await f.state(session.id, 'completed', next.id);
  assert.equal(complete.tasks[0].status, 'cancelled');
  assert.match(complete.messages.at(-1)!.content, /第 2 轮/);
});

test('approval pauses without output, survives restart, and accepts approval only once', async t => {
  const f = await fixture(t);
  const session = await f.session();
  const task = await f.submit(session.id, '整理工作计划', 'approval-demo');
  const waiting = await f.state(session.id, 'awaiting_approval');
  assert.equal(waiting.messages.length, 1);
  assert.ok(waiting.tasks[0].approval?.description.includes('不会执行命令'));
  await f.app.close();
  const second = await fixture(t, { dbPath: f.dbPath });
  assert.equal((await second.state(session.id, 'awaiting_approval')).messages.length, 1);
  const responses = await Promise.all([
    second.api(`/api/tasks/${task.id}/approve`, {}),
    second.api(`/api/tasks/${task.id}/approve`, {}),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  const completed = await second.state(session.id, 'completed');
  assert.equal(completed.messages.length, 2);
  assert.match(completed.messages[1].content, /本地模拟 · 已获批准/);
  assert.deepEqual(completed.tasks[0].events.map(event => event.status), ['queued', 'running', 'awaiting_approval', 'queued', 'running', 'completed']);
  assert.equal((await second.api(`/api/tasks/${task.id}/approve`, {})).status, 409);
  assert.equal((await second.api(`/api/tasks/${task.id}/cancel`, {})).status, 409);
  await second.app.close();
});

test('cancel and approve racing never resurrect a cancelled task', async t => {
  const f = await fixture(t, { delayMs: 10 });
  const session = await f.session();
  const task = await f.submit(session.id, '竞态测试', 'approval-demo');
  await f.state(session.id, 'awaiting_approval');
  const results = await Promise.all([
    f.api(`/api/tasks/${task.id}/approve`, {}),
    f.api(`/api/tasks/${task.id}/cancel`, {}),
  ]);
  assert.equal(results[1].status, 200);
  await sleep(100);
  const snapshot = await f.state(session.id, 'cancelled');
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.tasks[0].events.at(-1)?.status, 'cancelled');
});

test('/fail records a terminal error; users can retry after failure', async t => {
  const f = await fixture(t);
  const session = await f.session();
  await f.submit(session.id, '/fail');
  const failed = await f.state(session.id, 'failed');
  assert.match(failed.tasks[0].error!, /模拟失败/);
  assert.equal(failed.messages.length, 1);
  const retry = await f.submit(session.id, '重新开始');
  const completed = await f.state(session.id, 'completed', retry.id);
  assert.equal(completed.tasks[0].status, 'failed');
});

test('restart marks queued, running, and cancelling tasks failed and never resumes them', async t => {
  const f = await fixture(t, { delayMs: 100 });
  const session = await f.session();
  await f.submit(session.id, '被重启中断');
  await f.app.close();
  const store = new SessionStore(f.dbPath);
  const queued = store.all()[0];
  assert.ok(['queued', 'running'].includes(queued.tasks[0].status));
  const running = structuredClone(queued);
  running.id = 'restart-running-fixture';
  running.tasks[0].id = 'restart-running-task';
  running.tasks[0].sessionId = running.id;
  running.tasks[0].status = 'running';
  store.save(running);
  const cancelling = structuredClone(running);
  cancelling.id = 'restart-cancelling-fixture';
  cancelling.tasks[0].id = 'restart-cancelling-task';
  cancelling.tasks[0].sessionId = cancelling.id;
  cancelling.tasks[0].status = 'cancelling';
  store.save(cancelling);
  store.close();
  const second = await fixture(t, { dbPath: f.dbPath });
  for (const id of [session.id, running.id, cancelling.id]) {
    const failed = await second.state(id, 'failed');
    assert.match(failed.tasks[0].error!, /重启/);
    assert.equal(failed.tasks[0].events.at(-1)?.status, 'failed');
    assert.equal(failed.messages.length, 1);
  }
  await second.app.close();
});

test('validates JSON, prompt limits, task mode, ids, and unexpected fields', async t => {
  const f = await fixture(t);
  const session = await f.session();
  const endpoint = `/api/sessions/${session.id}/tasks`;
  for (const data of [{}, { prompt: '' }, { prompt: '  ' }, { prompt: 2 }, { prompt: 'a'.repeat(8001) }, { prompt: 'hi', mode: 'shell' }, { prompt: 'hi', command: 'echo hi' }, null, []]) {
    assert.equal((await f.api(endpoint, data)).status, 400);
  }
  const text = await fetch(f.url + endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"prompt":"hi"}' });
  assert.equal(text.status, 415);
  const malformed = await fetch(f.url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await f.api(endpoint, { prompt: 'a'.repeat(40000) })).status, 413);
  assert.equal((await f.api('/api/sessions/no-such-session')).status, 404);
  assert.equal((await f.api('/api/sessions/no-such-session/events')).status, 404);
  assert.equal((await f.api('/api/tasks/no-such-task/approve', {})).status, 404);
  assert.equal((await f.api('/api/tasks/no-such-task/cancel', {})).status, 404);
  assert.equal((await f.api('/api/sessions', { adapterId: 'mock-codex', title: 'a'.repeat(81) })).status, 400);
  assert.equal((await f.api(`/api/tasks/no-such-task/cancel`, { arbitrary: true })).status, 400);
});

test('Host, Origin, Fetch Metadata, and CORS defenses reject foreign browser requests', async t => {
  const f = await fixture(t);
  for (const origin of ['https://evil.example', 'null', 'http://localhost:6666', 'http://127.0.0.1:5173.evil.example', 'http://localhost:5173/path']) {
    const result = await f.api('/api/sessions', { adapterId: 'mock-codex' }, { Origin: origin });
    assert.equal(result.status, 403, origin);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await f.api('/api/sessions', { adapterId: 'mock-codex' }, { Origin: 'http://localhost:5173' })).status, 201);
  assert.equal((await f.api('/api/sessions', { adapterId: 'mock-codex' }, { Origin: f.url })).status, 201);
  assert.equal((await f.api('/api/sessions', { adapterId: 'mock-codex' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const host of ['evil.example', 'localhost:99999', '127.0.0.1:1', 'localhost:evil']) {
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const call = request(f.url + '/api/bootstrap', { headers: { Host: host } }, response => { response.resume(); resolve(response.statusCode!); });
      call.on('error', reject); call.end();
    });
    assert.equal(hostStatus, 403, host);
  }
  const options = await fetch(f.url + '/api/sessions', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(options.status, 403);
});

test('static serving returns only known build files, supports SPA and HEAD, never data or source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-static-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><h1>RelayDesk</h1>');
  await writeFile(join(dist, 'assets', 'main.js'), 'console.log("RelayDesk")');
  await writeFile(join(dist, 'secret.json'), '{"secret":"should-not-be-served"}');
  const f = await fixture(t, { staticDir: dist });
  const page = await fetch(f.url + '/sessions/example');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RelayDesk/);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const asset = await fetch(f.url + '/assets/main.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type')!, /javascript/);
  assert.equal((await fetch(f.url + '/assets/main.js', { method: 'HEAD' })).status, 200);
  for (const path of ['/secret.json', '/.data/relaydesk.sqlite', '/server/app.ts', '/assets/missing.js', '/%2e%2e%2fsecret.json']) {
    assert.equal((await fetch(f.url + path)).status, 404, path);
  }
});
