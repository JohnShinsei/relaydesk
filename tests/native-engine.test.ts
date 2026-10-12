import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EngineBinding, EngineDriver, ExecutionContext, NativeApproval, NativeRecovery, Session, TaskStatus } from '../shared/types.ts';
import { TaskEngine } from '../server/engine.ts';
import { NativeOutcomeUnknownError } from '../server/codex-app-server.ts';

const binding: EngineBinding = { driverId: 'codex-app-server', threadId: 'synthetic-thread', workspace: '/synthetic/test-area', version: '0.162.1' };
function approval(): NativeApproval {
  return { id: 'approval-1', kind: 'file-change', requestId: 9, threadId: binding.threadId, turnId: 'turn-1', itemId: 'patch-1', operation: 'Create synthetic.txt', changes: [{ path: 'synthetic.txt', diff: '+synthetic' }], allowedDecisions: ['decline', 'cancel'], status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
}
function store(initial: Session[] = []) {
  const rows = new Map(initial.map(row => [row.id, structuredClone(row)]));
  return { all: () => [...rows.values()].map(row => structuredClone(row)), save: (row: Session) => { rows.set(row.id, structuredClone(row)); }, close() {} };
}
function driver(run: (context: ExecutionContext) => Promise<void>, recover?: () => Promise<NativeRecovery>): EngineDriver {
  return { info: { id: 'codex-app-server', kind: 'cli', available: true, name: 'Protocol fixture', description: 'Synthetic test only' }, execute: run, async decideApproval() {}, recover: recover ?? (async () => ({ status: 'unknown', messages: [] })), async close() {} };
}
async function state(engine: TaskEngine, id: string, status: TaskStatus) {
  for (let i = 0; i < 200; i++) {
    const session = engine.get(id);
    if (session.tasks.at(-1)?.status === status) return session;
    await sleep(5);
  }
  assert.fail(`Expected ${status}; got ${JSON.stringify(engine.get(id).tasks.at(-1))}`);
}

test('native approval persists intent before dispatch, rejects altered targets and duplicate decisions, and upserts items', async t => {
  const snapshots = store();
  let finish!: () => void;
  let sends = 0;
  const native = driver(async ({ native: context }) => {
    await context!.onBinding(binding); await context!.onTurn('turn-1');
    await context!.upsertMessage('answer-1', 'hello');
    await context!.upsertMessage('answer-1', 'hello hello');
    await context!.upsertMessage('answer-1', 'hello hello');
    await context!.onApproval(approval());
    await new Promise<void>(resolve => { finish = resolve; });
    await context!.onApprovalResolved('approval-1');
    await context!.onTerminal('completed');
  });
  native.decideApproval = async () => {
    sends++;
    assert.equal(snapshots.all()[0].tasks[0].nativeApprovals![0].status, 'responding');
    finish();
  };
  const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native, store: snapshots });
  t.after(() => engine.close());
  const session = engine.create('codex-app-server'); const task = engine.submit(session.id, 'synthetic prompt', 'chat');
  await state(engine, session.id, 'awaiting_approval');
  await assert.rejects(engine.decideNativeApproval(task.id, 'other-request', 'decline'), /失效/);
  await assert.rejects(engine.decideNativeApproval(task.id, 'approval-1', 'accept'), /不允许/);
  await engine.decideNativeApproval(task.id, 'approval-1', 'decline');
  await assert.rejects(engine.decideNativeApproval(task.id, 'approval-1', 'decline'), /失效/);
  const done = await state(engine, session.id, 'completed');
  assert.equal(sends, 1); assert.equal(done.messages.filter(item => item.role === 'assistant').length, 1);
  assert.equal(done.messages.at(-1)?.content, 'hello hello');
  assert.equal(done.tasks[0].nativeApprovals![0].status, 'declined');
});

test('uncertain native approval is quarantined without retry and blocks another prompt', async t => {
  let sends = 0;
  const native = driver(async ({ native: context, signal }) => {
    await context!.onBinding(binding); await context!.onTurn('turn-1'); await context!.onApproval(approval());
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new NativeOutcomeUnknownError('Synthetic interrupted connection');
  });
  native.decideApproval = async () => { sends++; throw new Error('Synthetic write uncertainty'); };
  const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native }); t.after(() => engine.close());
  const session = engine.create('codex-app-server'); const task = engine.submit(session.id, 'synthetic', 'chat');
  await state(engine, session.id, 'awaiting_approval');
  await assert.rejects(engine.decideNativeApproval(task.id, 'approval-1', 'decline'), /未知/);
  await assert.rejects(engine.decideNativeApproval(task.id, 'approval-1', 'decline'), /失效/);
  assert.throws(() => engine.submit(session.id, 'must not replay', 'chat'), /未知/);
  const unknown = await state(engine, session.id, 'unknown');
  assert.equal(unknown.tasks[0].stopUnconfirmed, true); assert.equal(sends, 1);
});

test('native cancellation waits for terminal and preserves a completion that wins the race', async t => {
  for (const terminal of ['cancelled', 'completed'] as const) {
    let confirm!: () => void;
    const native = driver(async ({ native: context, signal }) => {
      await context!.onBinding(binding); await context!.onTurn('turn-1');
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => { confirm = resolve; }, { once: true }); });
      await context!.onTerminal(terminal);
    });
    const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native }); t.after(() => engine.close());
    const session = engine.create('codex-app-server'); const task = engine.submit(session.id, 'synthetic', 'chat');
    await state(engine, session.id, 'running');
    assert.equal(engine.cancel(task.id).status, 'cancelling');
    await sleep(10); assert.equal(engine.get(session.id).tasks[0].status, 'cancelling');
    confirm(); await state(engine, session.id, terminal);
  }
});

test('native restart retains unknown approval and recovers only exact persisted turn without prompt replay', async t => {
  const snapshots = store(); let calls = 0;
  const native = driver(async ({ native: context, signal }) => {
    calls++; await context!.onBinding(binding); await context!.onTurn('turn-1'); await context!.onApproval(approval());
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  }, async () => ({ turnId: 'turn-1', status: 'completed', messages: [{ itemId: 'answer-1', text: 'durable answer' }] }));
  const first = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native, store: snapshots });
  const session = first.create('codex-app-server'); first.submit(session.id, 'synthetic', 'chat');
  await state(first, session.id, 'awaiting_approval'); await first.close();
  const second = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native, store: snapshots, acknowledgeInterruptedCodex: true });
  t.after(() => second.close());
  const restored = second.get(session.id);
  assert.equal(restored.tasks[0].status, 'unknown'); assert.equal(restored.tasks[0].nativeApprovals![0].status, 'unknown');
  const recovered = await second.recover(session.id);
  assert.equal(recovered.tasks[0].status, 'completed'); assert.equal(recovered.tasks[0].stopUnconfirmed, undefined);
  assert.equal(recovered.messages.at(-1)?.content, 'durable answer'); assert.equal(calls, 1);
  await assert.rejects(second.recover(session.id), /没有可核验/);
});

test('recovery cannot accept evidence from another turn or remove quarantine on unknown', async t => {
  const timestamp = new Date().toISOString();
  const session: Session = { id: 'local', title: 'Synthetic', adapterId: 'codex-app-server', createdAt: timestamp, updatedAt: timestamp, engineBinding: binding, messages: [], tasks: [{ id: 'task', sessionId: 'local', adapterId: 'codex-app-server', prompt: 'synthetic', mode: 'chat', status: 'unknown', stopUnconfirmed: true, nativeTurnId: 'turn-1', createdAt: timestamp, updatedAt: timestamp, events: [] }] };
  for (const evidence of [{ turnId: 'other', status: 'completed' as const, messages: [] }, { turnId: 'turn-1', status: 'unknown' as const, messages: [] }]) {
    const native = driver(async () => assert.fail('Recovery must not execute'), async () => evidence);
    const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native, store: store([session]) }); t.after(() => engine.close());
    if (evidence.turnId === 'other') await assert.rejects(engine.recover(session.id)); else await engine.recover(session.id);
    assert.equal(engine.get(session.id).tasks[0].status, 'unknown');
    assert.throws(() => engine.submit(session.id, 'again', 'chat'), /未知/);
  }
});

test('storage failure prevents native approval dispatch', async t => {
  const snapshots = store(); let fail = false; let sends = 0;
  const native = driver(async ({ native: context, signal }) => {
    await context!.onBinding(binding); await context!.onTurn('turn-1'); await context!.onApproval(approval());
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  native.decideApproval = async () => { sends++; };
  const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native, store: { ...snapshots, save: session => { if (fail) throw new Error('Synthetic disk failure'); snapshots.save(session); } } });
  t.after(() => engine.close()); const session = engine.create('codex-app-server'); const task = engine.submit(session.id, 'synthetic', 'chat');
  await state(engine, session.id, 'awaiting_approval'); fail = true;
  await assert.rejects(engine.decideNativeApproval(task.id, 'approval-1', 'decline'), /存储/);
  assert.equal(sends, 0); assert.equal(engine.get(session.id).tasks[0].stopUnconfirmed, true);
});

test('native driver resolving without terminal evidence cannot report completion', async t => {
  const native = driver(async ({ native: context }) => { await context!.onBinding(binding); await context!.onTurn('turn-1'); });
  const engine = new TaskEngine(':memory:', 1, undefined, { nativeDriver: native }); t.after(() => engine.close());
  const session = engine.create('codex-app-server'); engine.submit(session.id, 'synthetic', 'chat');
  const result = await state(engine, session.id, 'unknown');
  assert.equal(result.tasks[0].stopUnconfirmed, true);
  assert.throws(() => engine.submit(session.id, 'must not replay', 'chat'), /未知/);
});
