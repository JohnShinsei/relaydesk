import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { EngineBinding, EngineDriver, ExecutionContext, NativeApproval, Session, TaskStatus } from '../shared/types.ts';
import { HttpError, TaskEngine } from '../server/engine.ts';

const binding: EngineBinding = { driverId: 'codex-app-server', threadId: 'fixture-thread', workspace: '/synthetic/private-workspace', version: '0.162.1' };
const key = 'synthetic-request-key-0001';
function driver(execute: EngineDriver['execute']): EngineDriver {
  return { info: { id: 'codex-app-server', kind: 'cli', available: true, name: 'Offline fixture', description: 'No process or provider' }, execute, async decideApproval() {}, async recover() { return { status: 'unknown', messages: [] }; }, async close() {} };
}
async function until(predicate: () => boolean) { for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(2); } assert.fail('Fixture state timed out'); }
function state(engine: TaskEngine, sessionId: string, status: TaskStatus) { return until(() => engine.get(sessionId).tasks.at(-1)?.status === status); }
function conflict(fn: () => unknown) { assert.throws(fn, error => error instanceof HttpError && error.status === 409); }
function request(): NativeApproval {
  return { id: 'fixture-approval', kind: 'file-change', requestId: 1, threadId: binding.threadId, turnId: 'fixture-turn', itemId: 'patch', operation: 'PRIVATE proposed operation', changes: [{ path: '/PRIVATE/path', diff: 'PRIVATE diff' }], allowedDecisions: ['decline', 'cancel'], status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
}

test('task submission idempotency survives completion, disabled driver and SQLite restart without another execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-feed-'));
  const dbPath = join(directory, 'test.sqlite'); let calls = 0;
  const native = driver(async ({ native: context }) => { calls++; await context!.onBinding(binding); await context!.onTurn('fixture-turn'); await context!.onTerminal('completed'); });
  const engine = new TaskEngine(dbPath, 1, undefined, { nativeDriver: native });
  let closed = false;
  t.after(async () => { if (!closed) await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const session = engine.create('codex-app-server');
  const results = await Promise.all([1, 2].map(async () => engine.submit(session.id, 'PRIVATE prompt', 'chat', key)));
  assert.equal(results[0].id, results[1].id);
  conflict(() => engine.submit(session.id, 'changed', 'chat', key));
  assert.throws(() => engine.submit(session.id, 'x', 'chat', 'bad key'));
  await state(engine, session.id, 'completed');
  assert.equal(engine.submit(session.id, 'PRIVATE prompt', 'chat', key).status, 'completed');
  assert.equal(engine.get(session.id).messages.length, 1); assert.equal(calls, 1);
  await engine.close(); closed = true;
  const restored = new TaskEngine(dbPath, 1);
  try {
    assert.equal(restored.submit(session.id, 'PRIVATE prompt', 'chat', key).id, results[0].id);
    assert.equal(restored.taskFeed({ scope: 'history' }).items.length, 1);
    conflict(() => restored.submit(session.id, 'PRIVATE prompt', 'approval-demo', key));
    assert.equal(calls, 1);
  } finally { await restored.close(); }
});

test('real activity and message upserts advance persisted timestamps and revision while coalescing repeated categories', async t => {
  let current: ExecutionContext | undefined; let finish!: () => void;
  const native = driver(async context => {
    current = context; await context.native!.onBinding(binding); await context.native!.onTurn('fixture-turn');
    await new Promise<void>(resolve => { finish = resolve; context.signal.addEventListener('abort', () => resolve(), { once: true }); });
    await context.native!.onTerminal('completed');
  });
  const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native }); t.after(() => engine.close());
  const session = engine.create('codex-app-server'); const task = engine.submit(session.id, 'PRIVATE prompt', 'chat');
  await until(() => !!current);
  const before = engine.taskFeed(); const priorTask = engine.get(session.id).tasks[0];
  await delay(5); await current!.native!.onActivity!('reasoning');
  const first = engine.taskActivity(task.id); const firstTime = first.items[0].at;
  await delay(5); await current!.native!.onActivity!('reasoning');
  const second = engine.taskActivity(task.id);
  assert.equal(first.items[0].seq, second.items[0].seq); assert.ok(second.items[0].at > firstTime);
  await delay(5); await current!.native!.upsertMessage('item', 'PRIVATE reply');
  assert.ok(engine.get(session.id).tasks[0].updatedAt > second.items[0].at);
  await current!.native!.onActivity!('answering');
  const after = engine.taskFeed(); const actual = engine.get(session.id).tasks[0];
  assert.ok(actual.updatedAt > priorTask.updatedAt); assert.equal(after.items[0].lastActivityAt, actual.lastActivityAt);
  assert.equal(after.items[0].currentActivity!.kind, 'answering');
  assert.notEqual(before.revision, after.revision); assert.ok(!JSON.stringify(after).includes('PRIVATE'));
  finish(); await state(engine, session.id, 'completed');
  const terminal = engine.taskFeed({ scope: 'history' }).items[0]; await delay(5);
  assert.equal(engine.taskFeed({ scope: 'history' }).items[0].elapsedMs, terminal.elapsedMs);
  assert.equal(engine.taskFeed().activeCount, 0); assert.equal(engine.taskFeed().historyCount, 1);
});

test('feed preserves cancelling until native confirmation and rejects repeated cancellation', async t => {
  let confirm!: () => void;
  const native = driver(async ({ native: context, signal }) => {
    await context!.onBinding(binding); await context!.onTurn('fixture-turn');
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { confirm = resolve; }, { once: true }));
    await context!.onTerminal('cancelled');
  });
  const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native });
  t.after(async () => { confirm?.(); await engine.close(); });
  const session = engine.create('codex-app-server'); const task = engine.submit(session.id, 'cancel fixture', 'chat');
  await until(() => !!engine.get(session.id).tasks[0].nativeTurnId);
  engine.cancel(task.id); conflict(() => engine.cancel(task.id));
  assert.equal(engine.taskFeed().items[0].status, 'cancelling');
  assert.equal(engine.taskFeed().items[0].endedAt, undefined);
  confirm(); await state(engine, session.id, 'cancelled');
  assert.equal(engine.taskFeed().items.length, 0);
  assert.equal(engine.taskFeed({ scope: 'history' }).items[0].currentActivity!.kind, 'cancelled');
});

test('pending approval feed tracks committed response intent and double decision dispatches only once', async t => {
  let complete!: () => void; let responseWritten!: () => void; let sends = 0;
  const native = driver(async ({ native: context, signal }) => {
    await context!.onBinding(binding); await context!.onTurn('fixture-turn'); await context!.onApproval(request());
    await new Promise<void>(resolve => { complete = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
    await context!.onTerminal('completed');
  });
  native.decideApproval = async () => { sends++; await new Promise<void>(resolve => { responseWritten = resolve; }); };
  const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native });
  t.after(async () => { responseWritten?.(); complete?.(); await engine.close(); });
  const session = engine.create('codex-app-server'); const task = engine.submit(session.id, 'approval fixture', 'chat');
  await state(engine, session.id, 'awaiting_approval');
  const pending = engine.taskFeed().items[0];
  assert.equal(pending.pendingApprovalCount, 1); assert.equal(pending.pendingApprovals[0].status, 'pending');
  assert.ok(!JSON.stringify(pending).includes('PRIVATE'));
  const deciding = engine.decideNativeApproval(task.id, 'fixture-approval', 'decline');
  assert.equal(engine.taskFeed().items[0].pendingApprovals[0].status, 'responding');
  await assert.rejects(engine.decideNativeApproval(task.id, 'fixture-approval', 'decline'), /失效/);
  assert.equal(sends, 1); responseWritten(); await deciding;
  assert.equal(engine.taskFeed().items[0].pendingApprovalCount, 0);
  complete(); await state(engine, session.id, 'completed');
});

test('expired approval cannot dispatch and feed switches to cancellation instead of claiming approval', async t => {
  let sends = 0;
  const native = driver(async ({ native: context, signal }) => {
    await context!.onBinding(binding); await context!.onTurn('fixture-turn');
    const expired = request(); expired.expiresAt = new Date(Date.now() - 1).toISOString();
    await context!.onApproval(expired);
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await context!.onTerminal('cancelled');
  });
  native.decideApproval = async () => { sends++; };
  const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native }); t.after(() => engine.close());
  const session = engine.create('codex-app-server'); const task = engine.submit(session.id, 'approval expiry', 'chat');
  await state(engine, session.id, 'awaiting_approval');
  await assert.rejects(engine.decideNativeApproval(task.id, 'fixture-approval', 'decline'), /过期/);
  await state(engine, session.id, 'cancelled');
  assert.equal(sends, 0); assert.equal(engine.taskFeed({ scope: 'history' }).items[0].pendingApprovalCount, 0);
});

test('restart uncertainty removes a stale endedAt and never adopts historical error text as activity', async t => {
  const at = new Date().toISOString();
  const session: Session = { id: 'session', title: 'PRIVATE', adapterId: 'codex-app-server', createdAt: at, updatedAt: at, messages: [], tasks: [{ id: 'task', sessionId: 'session', adapterId: 'codex-app-server', prompt: 'PRIVATE', mode: 'chat', status: 'failed', stopUnconfirmed: true, createdAt: at, updatedAt: at, endedAt: at, events: [], error: 'PRIVATE error' }] };
  const engine = new TaskEngine(':memory:', 1, undefined, { store: { all: () => [session], save() {}, close() {} } }); t.after(() => engine.close());
  const item = engine.taskFeed().items[0];
  assert.equal(item.status, 'unknown'); assert.equal(item.endedAt, undefined); assert.equal(item.currentActivity!.kind, 'unknown');
  assert.ok(!JSON.stringify(item).includes('PRIVATE'));
});
