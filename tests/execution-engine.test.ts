import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EngineBinding, EngineDriver, NativeApproval, NativeRecovery, Session, TaskStatus } from '../shared/types.ts';
import { TaskEngine } from '../server/engine.ts';
import { NativeOutcomeUnknownError } from '../server/execution.ts';

const binding: EngineBinding = { driverId: 'hermes', threadId: 'hermes-session', version: 'test-version' };
const codexBinding: EngineBinding = { driverId: 'codex-app-server', threadId: 'codex-session', workspace: '/synthetic', version: '0.162.1' };
function store(initial: Session[] = []) {
  const rows = new Map(initial.map(row => [row.id, structuredClone(row)]));
  return { all: () => [...rows.values()].map(row => structuredClone(row)), save: (row: Session) => { rows.set(row.id, structuredClone(row)); }, close() {} };
}
function driver(execute: EngineDriver['execute'], recover?: EngineDriver['recover']): EngineDriver {
  return { info: { id: 'hermes', kind: 'http', available: true, name: 'Hermes fixture', description: 'Offline only' }, execute,
    async decideApproval() {}, recover: recover ?? (async () => ({ status: 'unknown', messages: [] })), async close() {} };
}
async function state(engine: TaskEngine, sessionId: string, status: TaskStatus) {
  for (let i = 0; i < 250; i++) {
    const session = engine.get(sessionId);
    if (session.tasks.at(-1)?.status === status) return session;
    await sleep(4);
  }
  assert.fail(`Expected ${status}: ${JSON.stringify(engine.get(sessionId).tasks.at(-1))}`);
}
function approval(): NativeApproval {
  return { id: 'tool-approval', kind: 'tool', requestId: 'request', threadId: binding.threadId, turnId: 'hermes-run', itemId: 'tool-call', operation: 'Synthetic file operation', allowedDecisions: ['accept', 'decline', 'cancel'], status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
}
function interrupted(engineBinding: EngineBinding | undefined = binding, nativeTurnId: string | undefined = 'hermes-run'): Session {
  const at = new Date().toISOString();
  return { id: 'saved-session', title: 'Saved', adapterId: 'hermes', createdAt: at, updatedAt: at, engineBinding, messages: [], tasks: [{ id: 'saved-task', sessionId: 'saved-session', adapterId: 'hermes', prompt: 'Do not replay', mode: 'chat', status: 'unknown', stopUnconfirmed: true, nativeTurnId, createdAt: at, updatedAt: at, events: [] }] };
}

test('Hermes tool approval persists intent, routes to its driver and exposes provider metadata', async t => {
  const snapshots = store(); let finish!: () => void; let sends = 0; let closes = 0;
  const hermes = driver(async ({ native, signal }) => {
    await native!.onBinding(binding); await native!.onTurn('hermes-run');
    await native!.onActivity!('command'); await native!.onApproval(approval());
    await new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
    await native!.upsertMessage('answer', 'Synthetic result'); await native!.onTerminal('completed');
  });
  hermes.decideApproval = async (id, decision) => {
    sends++; assert.equal(id, 'tool-approval'); assert.equal(decision, 'accept');
    assert.equal(snapshots.all()[0].tasks[0].nativeApprovals![0].status, 'responding'); finish();
  };
  hermes.close = async () => { closes++; };
  const codex: EngineDriver = { ...driver(async () => assert.fail('Wrong driver')), info: { id: 'codex-app-server', kind: 'cli', available: true, name: 'Codex fixture', description: 'Offline' }, decideApproval: async () => assert.fail('Wrong approval driver') };
  const engine = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes, codex], store: snapshots });
  t.after(() => engine.close());
  const session = engine.create('hermes'); const task = engine.submit(session.id, 'Synthetic', 'chat');
  await state(engine, session.id, 'awaiting_approval');
  const feed = engine.taskFeed().items[0];
  assert.equal(feed.adapterId, 'hermes'); assert.equal(feed.provider, 'Hermes'); assert.equal(feed.project, null);
  assert.equal(feed.pendingApprovals[0].kind, 'tool');
  assert.ok(engine.taskActivity(task.id).items.some(item => item.kind === 'command'));
  await engine.decideNativeApproval(task.id, 'tool-approval', 'accept');
  await assert.rejects(engine.decideNativeApproval(task.id, 'tool-approval', 'accept'), /失效/);
  const done = await state(engine, session.id, 'completed');
  assert.equal(done.messages.at(-1)?.content, 'Synthetic result'); assert.equal(sends, 1);
  assert.equal(engine.taskFeed({ scope: 'history' }).items[0].status, 'completed');
  await engine.close(); assert.equal(closes, 1);
});

test('Hermes cancellation waits for confirmation, preserves a raced completion and quarantines missing receipts', async t => {
  for (const terminal of ['cancelled', 'completed', undefined] as const) {
    let confirm!: () => void;
    const hermes = driver(async ({ native, signal }) => {
      await native!.onBinding(binding); await native!.onTurn('hermes-run');
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { confirm = resolve; }, { once: true }));
      if (terminal) await native!.onTerminal(terminal);
    });
    const engine = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes] });
    t.after(async () => { confirm?.(); await engine.close(); });
    const session = engine.create('hermes'); const task = engine.submit(session.id, 'Synthetic', 'chat');
    await state(engine, session.id, 'running');
    assert.equal(engine.cancel(task.id).status, 'cancelling');
    await sleep(10); assert.equal(engine.get(session.id).tasks[0].status, 'cancelling');
    confirm(); const result = await state(engine, session.id, terminal ?? 'unknown');
    if (!terminal) assert.equal(result.tasks[0].stopUnconfirmed, true);
  }
});

test('Hermes unknown outcome recovers the exact run without executing or replaying a prompt', async t => {
  let executes = 0; let reads = 0;
  const snapshots = store();
  const hermes = driver(async ({ native }) => {
    executes++; await native!.onBinding(binding); await native!.onTurn('hermes-run');
    throw new NativeOutcomeUnknownError('Lost connection');
  }, async (saved, turnId) => {
    reads++; assert.deepEqual(saved, binding); assert.equal(turnId, 'hermes-run');
    return { turnId, status: 'completed', messages: [{ itemId: 'answer', text: 'Recovered result' }] };
  });
  const first = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes], store: snapshots });
  const session = first.create('hermes'); first.submit(session.id, 'Do not replay', 'chat');
  await state(first, session.id, 'unknown'); await first.close();
  const restarted = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes], store: snapshots }); t.after(() => restarted.close());
  const recovered = await restarted.recover(session.id);
  assert.equal(recovered.tasks[0].status, 'completed'); assert.equal(recovered.tasks[0].stopUnconfirmed, undefined);
  assert.equal(recovered.messages.at(-1)?.content, 'Recovered result'); assert.equal(executes, 1); assert.equal(reads, 1);
});

test('Hermes first-run recovery can establish a binding from a saved run ID; missing run ID stays isolated', async t => {
  let reads = 0;
  const hermes = driver(async () => assert.fail('Recovery cannot execute'), async (saved, runId) => {
    reads++; assert.equal(saved, undefined); assert.equal(runId, 'hermes-run');
    return { binding, turnId: runId, status: 'completed', messages: [] };
  });
  const recoverable = interrupted(); delete recoverable.engineBinding;
  const engine = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes], store: store([recoverable]) }); t.after(() => engine.close());
  const result = await engine.recover(recoverable.id);
  assert.deepEqual(result.engineBinding, binding); assert.equal(result.tasks[0].status, 'completed');
  const uncertain = interrupted(); delete uncertain.engineBinding; delete uncertain.tasks[0].nativeTurnId;
  const blocked = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes], store: store([uncertain]) }); t.after(() => blocked.close());
  await assert.rejects(blocked.recover(uncertain.id), /无法自动核验/);
  assert.equal(blocked.get(uncertain.id).tasks[0].status, 'unknown'); assert.equal(reads, 1);
});

test('one real task across sessions includes queued, approval, cancelling and unknown; simulations remain usable', async t => {
  let confirm!: () => void;
  const hermes = driver(async ({ native, signal }) => {
    await native!.onBinding(binding); await native!.onTurn('hermes-run'); await native!.onApproval(approval());
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { confirm = resolve; }, { once: true }));
  });
  const codex: EngineDriver = { ...driver(async () => assert.fail('Must be blocked')), info: { id: 'codex-app-server', kind: 'cli', available: true, name: 'Codex fixture', description: 'Offline' } };
  const engine = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes, codex] });
  t.after(async () => { confirm?.(); await engine.close(); });
  const session = engine.create('hermes'); const other = engine.create('hermes'); const codexSession = engine.create('codex-app-server');
  const task = engine.submit(session.id, 'Synthetic', 'chat');
  const conflict = () => {
    assert.throws(() => engine.submit(other.id, 'Blocked', 'chat'), /这台电脑已有/);
    assert.throws(() => engine.submit(codexSession.id, 'Blocked', 'chat'), /这台电脑已有/);
  };
  conflict(); await state(engine, session.id, 'awaiting_approval'); conflict();
  engine.cancel(task.id); conflict(); confirm(); await state(engine, session.id, 'unknown'); conflict();
  const mock = engine.create('mock-codex'); engine.submit(mock.id, 'Still works', 'chat');
  await state(engine, mock.id, 'completed');
});

test('mismatched driver bindings are rejected on submit, recovery and callbacks before adoption', async t => {
  let executes = 0; let reads = 0;
  const hermes = driver(async ({ native }) => { executes++; await native!.onBinding(codexBinding); }, async () => { reads++; return { status: 'completed', messages: [] }; });
  const saved = interrupted(codexBinding);
  const engine = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes], store: store([saved]) }); t.after(() => engine.close());
  await assert.rejects(engine.recover(saved.id), /不匹配/); assert.equal(reads, 0);
  const idle = interrupted(codexBinding); idle.id = 'idle'; idle.tasks = [];
  const invalid = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes], store: store([idle]) }); t.after(() => invalid.close());
  assert.throws(() => invalid.submit(idle.id, 'Blocked', 'chat'), /不匹配/); assert.equal(executes, 0);
  const fresh = new TaskEngine(':memory:', 1, undefined, { drivers: [hermes] }); t.after(() => fresh.close());
  const session = fresh.create('hermes'); fresh.submit(session.id, 'Synthetic', 'chat');
  await state(fresh, session.id, 'unknown'); assert.equal(fresh.get(session.id).engineBinding, undefined);
});

test('Hermes recovery cannot adopt evidence for a different driver or run', async t => {
  for (const evidence of [
    { binding: codexBinding, turnId: 'hermes-run', status: 'completed', messages: [] },
    { binding, turnId: 'other-run', status: 'completed', messages: [] },
  ] satisfies NativeRecovery[]) {
    const saved = interrupted();
    const engine = new TaskEngine(':memory:', 1, undefined, { drivers: [driver(async () => assert.fail('No replay'), async () => evidence)], store: store([saved]) }); t.after(() => engine.close());
    await assert.rejects(engine.recover(saved.id));
    const result = engine.get(saved.id); assert.equal(result.tasks[0].status, 'unknown'); assert.equal(result.tasks[0].stopUnconfirmed, true);
    assert.deepEqual(result.engineBinding, binding);
  }
});
