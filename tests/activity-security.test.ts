import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AdapterId, EngineDriver, NativeApproval, Session, Task, TaskActivity, TaskFeedPage, TaskStatus } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { HttpError, TaskEngine } from '../server/engine.ts';
import { SessionStore } from '../server/store.ts';

const time = '2026-01-01T00:00:00.000Z';
const secret = 'SYNTHETIC_PRIVATE_SENTINEL_DO_NOT_RENDER';
function snapshots(initial: Session[] = []) {
  const rows = new Map(initial.map(row => [row.id, structuredClone(row)]));
  return {
    all: () => [...rows.values()].map(row => structuredClone(row)),
    save: (row: Session) => { rows.set(row.id, structuredClone(row)); },
    close() {},
  };
}
function task(id: string, adapterId: AdapterId = 'codex-app-server', status: TaskStatus = 'completed'): Task {
  return { id, sessionId: `session-${id}`, adapterId, prompt: secret, mode: 'chat', status, createdAt: time, updatedAt: time, events: [{ status, at: time, detail: secret }], error: secret };
}
function session(item: Task): Session {
  return {
    id: item.sessionId, title: secret, adapterId: item.adapterId, createdAt: time, updatedAt: time,
    messages: [{ id: 'message', role: 'assistant', content: secret, taskId: item.id, createdAt: time }], tasks: [item],
    engineBinding: { driverId: 'codex-app-server', version: '0.162.1', threadId: 'private-native-thread', workspace: `/synthetic/${secret}` },
  };
}
function approval(index: number): NativeApproval {
  return { id: `approval-${index}`, kind: 'file-change', requestId: index, threadId: secret, turnId: secret, itemId: secret, operation: secret, cwd: secret, changes: [{ path: secret, diff: secret }], allowedDecisions: ['accept', 'decline'], status: 'pending', createdAt: time, expiresAt: '2099-01-01T00:00:00.000Z' };
}
function badRequest(action: () => unknown) {
  assert.throws(action, error => error instanceof HttpError && error.status === 400);
}
function cursor(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

test('task feed and activity project only bounded native metadata, never conversation or approval payloads', async t => {
  const item = task('native-private', 'codex-app-server', 'unknown');
  item.nativeApprovals = Array.from({ length: 14 }, (_, index) => approval(index));
  item.activitySeq = 4;
  item.activity = [
    { seq: 1, at: time, kind: 'reasoning', label: secret, text: secret, output: secret, config: secret } as TaskActivity,
    { seq: 2, at: time, kind: 'command', label: secret },
    { seq: 3, at: time, kind: 'file-change', label: secret },
    { seq: 4, at: time, kind: secret, label: secret } as unknown as TaskActivity,
  ];
  const excluded = (['mock-codex', 'mock-claude', 'codex'] as const).map(id => session(task(`excluded-${id}`, id)));
  const claude = session(task('claude-private', 'claude'));
  claude.engineBinding = { driverId: 'claude', threadId: 'private-claude-thread', workspace: `/synthetic/${secret}`, version: 'synthetic-sdk' };
  claude.tasks[0].nativeApprovals = [approval(20)];
  claude.tasks[0].activity = [{ seq: 1, at: time, kind: 'command', label: secret }];
  const engine = new TaskEngine(':memory:', 1, undefined, { store: snapshots([session(item), claude, ...excluded]) });
  t.after(() => engine.close());
  const feed = engine.taskFeed({ scope: 'all' });
  const activity = engine.taskActivity(item.id);
  assert.deepEqual(feed.items.map(row => row.id), [item.id, claude.tasks[0].id]);
  assert.equal(feed.activeCount, 1); assert.equal(feed.historyCount, 1);
  assert.equal(feed.items[0].pendingApprovalCount, 14);
  assert.equal(feed.items[0].pendingApprovals.length, 10);
  assert.match(feed.items[0].project!.id, /^workspace-[a-f0-9]{16}$/);
  assert.equal(feed.items[1].provider, 'Claude');
  assert.equal(feed.items[1].project!.label, 'Claude Agent 本地工作区');
  assert.match(feed.items[1].project!.id, /^workspace-[a-f0-9]{16}$/);
  assert.equal(feed.items[1].project!.id, feed.items[0].project!.id);
  assert.deepEqual(activity.items.map(row => row.kind), ['file-change', 'command', 'reasoning']);
  assert.ok(activity.items.every(row => Object.keys(row).sort().join(',') === 'at,kind,label,seq'));
  assert.ok(feed.items[0].pendingApprovals.every(row => Object.keys(row).sort().join(',') === 'createdAt,expiresAt,id,kind,status'));
  const serialized = JSON.stringify({ feed, activity, claudeActivity: engine.taskActivity(claude.tasks[0].id) });
  for (const forbidden of [secret, 'private-native-thread', 'private-claude-thread', '/synthetic/', 'allowedDecisions', 'requestId', 'messages', 'prompt', 'error', 'changes']) assert.ok(!serialized.includes(forbidden), forbidden);
  for (const row of excluded) assert.throws(() => engine.taskActivity(row.tasks[0].id), error => error instanceof HttpError && error.status === 404);
});

test('legacy native tasks get an honest status fallback without inventing activity history', async t => {
  const item = task('legacy');
  const row = session(item); delete row.engineBinding;
  const engine = new TaskEngine(':memory:', 1, undefined, { store: snapshots([row]) }); t.after(() => engine.close());
  const feed = engine.taskFeed({ scope: 'history' });
  assert.equal(feed.items[0].project, null);
  assert.equal(feed.items[0].currentActivity!.kind, 'completed');
  assert.equal(feed.items[0].currentActivity!.seq, 0);
  assert.equal(feed.items[0].elapsedMs, 0);
  assert.equal(feed.items[0].endedAt, time);
  const activity = engine.taskActivity(item.id);
  assert.deepEqual(activity.items, []); assert.equal(activity.retainedFrom, null);
  assert.equal(activity.latestSeq, 0); assert.equal(activity.nextBefore, null); assert.equal(activity.truncated, false);
  assert.ok(!JSON.stringify({ feed, activity }).includes(secret));
});

test('task cursors reject altered scope, nonexistent anchors, noncanonical encodings and invalid limits', async t => {
  const rows = ['a', 'b', 'c'].map(id => session(task(id)));
  rows.push(session(task('unknown', 'codex-app-server', 'unknown')), session(task('mock-anchor', 'mock-codex')));
  const engine = new TaskEngine(':memory:', 1, undefined, { store: snapshots(rows) }); t.after(() => engine.close());
  const first = engine.taskFeed({ scope: 'history', limit: 1 });
  assert.equal(first.items[0].id, 'c'); assert.equal(first.total, 3);
  assert.equal(first.activeCount, 1); assert.equal(first.historyCount, 3); assert.equal(first.truncated, true);
  const second = engine.taskFeed({ scope: 'history', limit: 1, cursor: first.nextCursor! });
  const third = engine.taskFeed({ scope: 'history', limit: 1, cursor: second.nextCursor! });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(row => row.id), ['c', 'b', 'a']);
  assert.equal(third.nextCursor, null); assert.equal(third.truncated, false);
  const value = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()) as Record<string, unknown>;
  badRequest(() => engine.taskFeed({ scope: 'active', cursor: first.nextCursor! }));
  for (const altered of [{ ...value, id: 'missing' }, { ...value, id: 'mock-anchor' }, { ...value, createdAt: '2000-01-01T00:00:00.000Z' }, { ...value, extra: true }, { ...value, v: 2 }]) badRequest(() => engine.taskFeed({ scope: 'history', cursor: cursor(altered) }));
  for (const invalid of [first.nextCursor! + '=', '!', 'a'.repeat(513), cursor(null), cursor([]), Buffer.from(JSON.stringify(value, null, 2)).toString('base64url')]) badRequest(() => engine.taskFeed({ scope: 'history', cursor: invalid }));
  for (const limit of [0, -1, 51, 1.5, NaN, Infinity]) badRequest(() => engine.taskFeed({ limit }));
  badRequest(() => engine.taskFeed({ scope: 'synthetic-invalid' as 'active' }));
});

test('activity paging exposes retention boundaries, rejects invalid cursors and sanitizes stored labels', async t => {
  const item = task('retained');
  item.activitySeq = 260;
  item.activity = Array.from({ length: 260 }, (_, index) => ({ seq: index + 1, at: time, kind: index % 2 ? 'reasoning' : 'command', label: secret }));
  const engine = new TaskEngine(':memory:', 1, undefined, { store: snapshots([session(item)]) }); t.after(() => engine.close());
  const first = engine.taskActivity(item.id, { limit: 100 });
  const second = engine.taskActivity(item.id, { limit: 100, before: first.nextBefore! });
  assert.equal(first.retainedFrom, 61); assert.equal(first.latestSeq, 260); assert.equal(first.truncated, true);
  assert.deepEqual([...first.items, ...second.items].map(row => row.seq), Array.from({ length: 200 }, (_, index) => 260 - index));
  assert.equal(second.nextBefore, null); assert.equal(second.truncated, true);
  const evicted = engine.taskActivity(item.id, { before: 61 });
  assert.deepEqual(evicted.items, []); assert.equal(evicted.retainedFrom, 61); assert.equal(evicted.truncated, true);
  assert.equal(engine.taskActivity(item.id, { before: 261, limit: 1 }).items[0].seq, 260);
  assert.ok(!JSON.stringify([first, second]).includes(secret));
  for (const before of [0, -1, 1.5, 262, Infinity, Number.MAX_SAFE_INTEGER + 1]) badRequest(() => engine.taskActivity(item.id, { before }));
  for (const limit of [0, -1, 101, 1.5, NaN]) badRequest(() => engine.taskActivity(item.id, { limit }));
});

test('live native activity remains bounded and private across persistence and restart', async t => {
  const saved = snapshots();
  const native: EngineDriver = {
    info: { id: 'codex-app-server', kind: 'cli', available: true, name: 'Synthetic metadata fixture', description: 'No provider calls' },
    async execute({ native: context }) {
      await context!.onBinding({ driverId: 'codex-app-server', threadId: 'synthetic-thread', workspace: `/synthetic/${secret}`, version: '0.162.1' });
      await context!.onTurn('synthetic-turn');
      for (let index = 0; index < 240; index++) await context!.onActivity!(index % 2 ? 'reasoning' : 'command');
      for (let index = 0; index < 20; index++) await context!.onActivity!('reasoning');
      await context!.upsertMessage('synthetic-answer', secret);
      await context!.onTerminal('failed', secret);
    },
    async decideApproval() { assert.fail('No approval expected'); },
    async recover() { assert.fail('No recovery expected'); },
    async close() {},
  };
  const engine = new TaskEngine(':memory:', 1, undefined, { store: saved, nativeDriver: native }); t.after(() => engine.close());
  const publications: string[] = [];
  engine.onFeedChange = () => { publications.push(JSON.stringify(engine.taskFeed({ scope: 'all' }))); };
  const row = engine.create('codex-app-server', secret); const submitted = engine.submit(row.id, secret, 'chat');
  for (let index = 0; index < 200 && engine.get(row.id).tasks[0].status !== 'failed'; index++) await sleep(5);
  const completed = engine.get(row.id).tasks[0];
  assert.equal(completed.status, 'failed');
  assert.equal(completed.activity!.length, 200);
  assert.equal(completed.activity!.at(-1)!.kind, 'failed');
  const durable = saved.all()[0].tasks[0];
  assert.equal(durable.activitySeq, completed.activitySeq);
  assert.ok(!JSON.stringify(durable.activity).includes(secret));
  assert.ok(publications.length > 2); assert.ok(publications.every(value => !value.includes(secret)));
  const before = engine.taskActivity(submitted.id, { limit: 100 });
  await engine.close();
  const restored = new TaskEngine(':memory:', 1, undefined, { store: saved, nativeDriver: native }); t.after(() => restored.close());
  const after = restored.taskActivity(submitted.id, { limit: 100 });
  assert.deepEqual(after.items, before.items); assert.equal(after.latestSeq, before.latestSeq); assert.equal(after.truncated, true);
});

test('stored activity timestamps cannot carry parseable private suffixes into the feed', async t => {
  const item = task('timestamp');
  const poisonedTime = `Thu Jan 01 2026 00:00:00 GMT+0000 (${secret})`;
  item.activitySeq = 1;
  item.updatedAt = poisonedTime; item.startedAt = poisonedTime; item.endedAt = poisonedTime; item.lastActivityAt = poisonedTime;
  item.activity = [{ seq: 1, at: poisonedTime, kind: 'reasoning', label: secret }];
  item.nativeApprovals = [{ ...approval(1), createdAt: poisonedTime, expiresAt: poisonedTime }];
  const engine = new TaskEngine(':memory:', 1, undefined, { store: snapshots([session(item)]) }); t.after(() => engine.close());
  assert.ok(!JSON.stringify({ feed: engine.taskFeed({ scope: 'all' }), activity: engine.taskActivity(item.id) }).includes(secret));
});

test('failed read-only recovery leaves unknown metadata and never leaks its error or resubmits', async t => {
  const item = task('recover', 'codex-app-server', 'unknown'); item.nativeTurnId = 'saved-turn';
  let reads = 0;
  const native: EngineDriver = {
    info: { id: 'codex-app-server', kind: 'cli', available: true, name: 'Synthetic recovery fixture', description: 'No provider calls' },
    async execute() { assert.fail('Recovery must never execute a prompt'); },
    async decideApproval() { assert.fail('Recovery must never send approval'); },
    async recover(_binding, turnId) { assert.equal(turnId, 'saved-turn'); reads++; throw new Error(secret); },
    async close() {},
  };
  const engine = new TaskEngine(':memory:', 1, undefined, { store: snapshots([session(item)]), nativeDriver: native }); t.after(() => engine.close());
  await assert.rejects(engine.recover(item.sessionId));
  const feed = engine.taskFeed();
  assert.equal(reads, 1); assert.equal(feed.items[0].status, 'unknown');
  assert.equal(feed.items[0].currentActivity!.kind, 'unknown');
  assert.equal(feed.items[0].endedAt, undefined);
  assert.ok(!JSON.stringify({ feed, activity: engine.taskActivity(item.id) }).includes(secret));
});

test('HTTP and reconnect snapshots expose only native metadata and reject ambiguous queries before SSE', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-activity-security-'));
  const dbPath = join(directory, 'sessions.sqlite');
  const persisted = new SessionStore(dbPath);
  const item = task('http-native');
  item.activity = [{ seq: 1, at: time, kind: 'reasoning', label: secret }]; item.activitySeq = 1;
  persisted.save(session(item)); persisted.save(session(task('http-mock', 'mock-codex'))); persisted.close();
  const app = createApp({ dbPath, staticDir: join(directory, 'missing-dist') });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await fetch(`${url}/api/task-feed?scope=all`);
  assert.equal(page.status, 200);
  const feed = await page.json() as { feed: TaskFeedPage };
  assert.deepEqual(feed.feed.items.map(row => row.id), ['http-native']);
  assert.ok(!JSON.stringify(feed).includes(secret));
  const activity = await fetch(`${url}/api/task-feed/http-native/activity`);
  assert.equal(activity.status, 200); assert.ok(!(await activity.text()).includes(secret));
  assert.equal((await fetch(`${url}/api/task-feed/http-mock/activity`)).status, 404);
  for (const path of [
    '/api/task-feed?scope=active&scope=history', '/api/task-feed?unknown=1', '/api/task-feed?limit=01',
    '/api/task-feed?limit=51', '/api/task-feed/events?scope=invalid', '/api/task-feed/events?cursor=abc',
    '/api/task-feed/http-native/activity?before=1&before=2', '/api/task-feed/http-native/activity?before=0',
    '/api/task-feed/http-native/activity?limit=101', '/api/task-feed/http-native/activity?scope=all',
  ]) {
    const response = await fetch(url + path);
    assert.equal(response.status, 400, path); assert.match(response.headers.get('content-type')!, /application\/json/);
  }
  assert.equal((await fetch(`${url}/api/task-feed`, { headers: { Origin: 'https://synthetic.invalid' } })).status, 403);
  const response = await fetch(`${url}/api/task-feed/events?scope=all&limit=1`, { headers: { 'Last-Event-ID': 'stale:99999999' }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader();
  let streamed = '';
  while (!streamed.includes('\n\n')) {
    const next = await reader.read(); assert.equal(next.done, false);
    streamed += new TextDecoder().decode(next.value);
  }
  await reader.cancel();
  assert.match(streamed, /event: snapshot/); assert.ok(!streamed.includes(secret));
  const data = streamed.split('\n').find(line => line.startsWith('data: '))!;
  const snapshot = JSON.parse(data.slice(6)) as { feed: TaskFeedPage };
  assert.deepEqual(snapshot.feed.items.map(row => row.id), ['http-native']);
  assert.notEqual(snapshot.feed.revision, 'stale:99999999');
});
