import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { EngineBinding, ExecutionContext, NativeApproval } from '../shared/types.ts';
import { createHermesDriver, createHermesDriverFromEnvironment } from '../server/hermes-driver.ts';
import { NativeOutcomeUnknownError } from '../server/execution.ts';

const apiKey = 'test-only-independent-key';
const binding: EngineBinding = { driverId: 'hermes', threadId: 'api-session', version: 'hermes-runs-v1' };
const capabilities = {
  object: 'hermes.api_server.capabilities', platform: 'hermes-agent', auth: { type: 'bearer', required: true },
  features: { run_submission: true, run_status: true, run_stop: true, run_approval_response: true, runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 } },
};
const run = (status = 'completed', extra = {}) => ({ run_id: 'run-1', session_id: 'api-session', status, output: status === 'completed' ? 'done' : '', ...extra });
const approval = { kind: 'approval', prompt_id: 'prompt-1', execution_generation: 3, command: 'specific native tool operation', description: 'native reason', choices: ['once', 'deny', 'always'] };
function context(existingBinding?: EngineBinding) {
  const controller = new AbortController(); const bindings: EngineBinding[] = []; const turns: string[] = [];
  const messages = new Map<string, string>(); const approvals: NativeApproval[] = []; const resolved: string[] = []; const terminals: string[] = [];
  const input: ExecutionContext = {
    task: { id: 'local-task', sessionId: 'local-session', adapterId: 'hermes', prompt: 'latest prompt', mode: 'chat', status: 'running', createdAt: 'now', updatedAt: 'now', events: [] },
    history: [{ id: 'history', taskId: 'old-task', role: 'user', content: 'do not replay history', createdAt: 'before' }], signal: controller.signal,
    emit: () => assert.fail('native driver uses item upserts'),
    native: { binding: existingBinding, onBinding: value => { bindings.push(value); }, onTurn: value => { turns.push(value); },
      upsertMessage: (id, text) => { messages.set(id, text); }, onApproval: value => { approvals.push(value); },
      onApprovalResolved: id => { resolved.push(id); }, onTerminal: status => { terminals.push(status); } },
  };
  return { input, controller, bindings, turns, messages, approvals, resolved, terminals };
}
interface Call { path: string; method: string; headers: Headers; body?: Record<string, unknown>; redirect?: RequestRedirect; signal?: AbortSignal | null }
function fixture(handler: (call: Call) => unknown | Promise<unknown>, options: Partial<Parameters<typeof createHermesDriver>[0]> = {}) {
  const calls: Call[] = [];
  const driver = createHermesDriver({ baseUrl: 'http://127.0.0.1:8642', apiKey, pollIntervalMs: 1, requestTimeoutMs: 50, timeoutMs: 300, stopConfirmationMs: 80, ...options,
    fetch: async (url, init) => {
      const call = { path: new URL(String(url)).pathname, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined, redirect: init?.redirect, signal: init?.signal };
      calls.push(call);
      const value = call.path === '/v1/capabilities' ? capabilities : await handler(call);
      return value instanceof Response ? value : new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { driver, calls };
}
async function until(condition: () => boolean) { for (let n = 0; n < 150; n++) { if (condition()) return; await delay(2); } assert.fail('offline fixture did not settle'); }

test('Hermes submits only latest input, persists real IDs, and completes from GET receipt', async () => {
  let polls = 0;
  const f = fixture(call => call.method === 'POST' ? { run_id: 'run-1', status: 'started' } : run(polls++ ? 'completed' : 'running'));
  const c = context(); await f.driver.execute(c.input);
  assert.deepEqual(c.turns, ['run-1']); assert.deepEqual(c.bindings, [binding]);
  assert.deepEqual(c.terminals, ['completed']); assert.equal(c.messages.get('run-1:answer'), 'done');
  const post = f.calls.find(call => call.method === 'POST')!;
  assert.deepEqual(post.body, { input: 'latest prompt' }); assert.equal(post.headers.get('Idempotency-Key'), 'local-task');
  for (const call of f.calls) { assert.equal(call.redirect, 'manual'); assert.equal(call.headers.get('Authorization'), `Bearer ${apiKey}`); }
  assert.ok(!JSON.stringify(f.calls.map(call => call.body)).includes('do not replay'));
  const next = context(binding); await f.driver.execute(next.input);
  assert.deepEqual(f.calls.filter(call => call.method === 'POST')[1].body, { input: 'latest prompt', session_id: 'api-session' });
  await f.driver.close();
});

test('Hermes lost creation response is unknown and is never submitted again', async () => {
  const f = fixture(() => { throw new Error(`SECRET ${apiKey} internal stack`); });
  const c = context(); await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError);
  assert.deepEqual(c.terminals, []); assert.deepEqual(c.turns, []);
  await assert.rejects(f.driver.execute(context().input));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  const recovery = await f.driver.recover(undefined); assert.equal(recovery.status, 'unknown');
  assert.ok(!JSON.stringify(recovery).includes(apiKey));
});

test('run ID is saved before first status request; missing initial binding recovers by exact GET only', async () => {
  let failPoll = true; const c = context();
  const f = fixture(call => {
    if (call.method === 'POST') return { run_id: 'run-1', status: 'started' };
    assert.deepEqual(c.turns, ['run-1']);
    if (failPoll) throw new Error('first GET connection lost');
    return run();
  });
  await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError); assert.deepEqual(c.bindings, []);
  failPoll = false;
  const result = await f.driver.recover(undefined, c.turns[0]);
  assert.equal(result.status, 'completed'); assert.deepEqual(result.binding, binding);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.at(-1)?.path, '/v1/runs/run-1');
});

test('read-only recovery rejects mismatched session or protocol and never creates a replacement', async () => {
  const f = fixture(() => run());
  assert.equal((await f.driver.recover({ ...binding, threadId: 'other-session' }, 'run-1')).status, 'unknown');
  assert.equal((await f.driver.recover({ ...binding, version: 'different' }, 'run-1')).status, 'unknown');
  assert.equal((await f.driver.recover(binding, '../bad')).status, 'unknown');
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('cancel requests stop with independent signal and waits through stopping for cancelled receipt', async () => {
  const c = context(); let stopped = false; let stopPolls = 0;
  const f = fixture(call => {
    if (call.path.endsWith('/stop')) { assert.equal(call.signal?.aborted, false); stopped = true; return { status: 'stopping' }; }
    if (call.method === 'POST') return { run_id: 'run-1', status: 'started' };
    if (!stopped) { c.controller.abort(); return run('running'); }
    if (++stopPolls === 1) { assert.deepEqual(c.terminals, []); return run('stopping'); }
    return run('cancelled');
  });
  await f.driver.execute(c.input); assert.deepEqual(c.terminals, ['cancelled']); assert.equal(stopPolls, 2);
  assert.equal(f.calls.filter(call => call.path.endsWith('/stop')).length, 1);
});

test('unconfirmed stop expires to unknown, never cancelled', async () => {
  const c = context();
  const f = fixture(call => {
    if (call.path.endsWith('/stop')) return { status: 'stopping' };
    if (call.method === 'POST') return { run_id: 'run-1', status: 'started' };
    c.controller.abort(); return run('stopping');
  }, { stopConfirmationMs: 12 });
  await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError); assert.deepEqual(c.terminals, []);
});

test('cancellation during an approval poll stops without publishing a new approval', async () => {
  const c = context(); let stopped = false;
  const f = fixture(call => {
    if (call.path.endsWith('/stop')) { stopped = true; return { run_id: 'run-1', status: 'stopping' }; }
    if (call.method === 'POST') return { run_id: 'run-1', status: 'started' };
    if (stopped) return run('cancelled');
    c.controller.abort(); return run('waiting_for_approval', { execution_generation: 3, pending_controls: [approval] });
  });
  c.input.native!.onApproval = () => assert.fail('cancelled engine cannot accept a fresh approval');
  await f.driver.execute(c.input); assert.deepEqual(c.terminals, ['cancelled']);
});

test('exact canonical approval grants only once and duplicate clicks never resend', async () => {
  const c = context(); let accepted = false;
  const f = fixture(call => {
    if (call.path.endsWith('/approval')) {
      assert.deepEqual(call.body, { request_id: 'prompt-1', execution_generation: 3, choice: 'once' });
      accepted = true; return { run_id: 'run-1', prompt_id: 'prompt-1', status: 'resolved' };
    }
    if (call.method === 'POST') return { run_id: 'run-1', status: 'started' };
    return accepted ? run() : run('waiting_for_approval', { execution_generation: 3, pending_controls: [approval] });
  });
  const execution = f.driver.execute(c.input); await until(() => c.approvals.length > 0);
  assert.deepEqual(c.approvals[0].allowedDecisions, ['accept', 'decline']);
  assert.equal(c.approvals[0].operation, 'native reason\nspecific native tool operation');
  await Promise.all([f.driver.decideApproval(c.approvals[0].id, 'accept'), f.driver.decideApproval(c.approvals[0].id, 'accept')]);
  await execution;
  assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 1);
  assert.deepEqual(c.resolved, [c.approvals[0].id]);
});

test('decline maps to deny, cancellation is not an approval grant', async () => {
  const c = context(); let denied = false;
  const f = fixture(call => {
    if (call.path.endsWith('/approval')) { assert.equal(call.body?.choice, 'deny'); denied = true; return { run_id: 'run-1', prompt_id: 'prompt-1', status: 'resolved' }; }
    if (call.method === 'POST') return { run_id: 'run-1', status: 'started' };
    return denied ? run() : run('waiting_for_approval', { execution_generation: 3, pending_controls: [approval] });
  });
  const execution = f.driver.execute(c.input); await until(() => c.approvals.length > 0);
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'cancel'));
  await f.driver.decideApproval(c.approvals[0].id, 'decline'); await execution;
});

test('lost approval receipt remains unknown, and identical or changed decisions cannot repeat POST', async () => {
  const c = context();
  const f = fixture(call => {
    if (call.path.endsWith('/approval')) throw new Error('lost receipt');
    if (call.method === 'POST') return { run_id: 'run-1', status: 'started' };
    return run('waiting_for_approval', { execution_generation: 3, pending_controls: [approval] });
  });
  const execution = f.driver.execute(c.input); const rejection = assert.rejects(execution, NativeOutcomeUnknownError);
  await until(() => c.approvals.length > 0);
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'accept'), NativeOutcomeUnknownError);
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'accept'));
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'decline'));
  await rejection;
  assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 1); assert.deepEqual(c.terminals, []);
});

test('approval settled by another viewer cannot report this later accept as granted', async () => {
  const c = context(); let settledElsewhere = false;
  const f = fixture(call => {
    if (call.path.endsWith('/approval')) {
      // The UI saw a pending prompt, but a native deny/timeout won before our POST.
      settledElsewhere = true;
      return { run_id: 'run-1', prompt_id: 'prompt-1', status: 'already_resolved' };
    }
    if (call.method === 'POST') return { run_id: 'run-1', status: 'started' };
    return settledElsewhere ? run() : run('waiting_for_approval', { execution_generation: 3, pending_controls: [approval] });
  });
  const execution = f.driver.execute(c.input); const rejection = assert.rejects(execution, NativeOutcomeUnknownError);
  await until(() => c.approvals.length > 0);
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'accept'), NativeOutcomeUnknownError);
  await rejection;
  assert.deepEqual(c.terminals, []);
  assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 1);
});

test('legacy approval, missing operation, edited files, and clarification fail closed', async () => {
  for (const extra of [
    {}, { execution_generation: 3, pending_controls: [{ ...approval, command: '', description: '' }] },
    { execution_generation: 3, pending_controls: [{ ...approval, edit: { diff: 'incomplete' } }] },
    { execution_generation: 3, pending_controls: [{ ...approval, kind: 'clarify' }] },
    { execution_generation: 3, pending_controls: [{ ...approval, execution_generation: 4 }] },
  ]) {
    const f = fixture(call => call.method === 'POST' ? { run_id: 'run-1', status: 'started' } : run('waiting_for_approval', extra));
    const c = context(); await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError);
    assert.deepEqual(c.approvals, []); assert.deepEqual(c.terminals, []);
  }
});

test('unknown, malformed and expired upstream status are never successful completion', async () => {
  for (const response of [run('unknown'), run('brand-new-status'), run('completed', { session_id: 'different-session' }), run('completed', { run_id: 'different-run' }), new Response('SECRET upstream diagnostic', { status: 404 })]) {
    const f = fixture(call => call.method === 'POST' ? { run_id: 'run-1', status: 'started' } : response);
    const c = context(binding); await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError); assert.deepEqual(c.terminals, []);
  }
});

test('interrupted is failed; receipt completion can still win the stop race', async () => {
  for (const status of ['failed', 'interrupted', 'cancelled']) {
    const f = fixture(call => call.method === 'POST' ? { run_id: 'run-1', status: 'started' } : run(status));
    const c = context(); await f.driver.execute(c.input); assert.deepEqual(c.terminals, [status === 'interrupted' ? 'failed' : status]);
  }
});

test('operator configuration is opt-in and rejects remote, normalized, credentialed and path URLs', () => {
  assert.equal(createHermesDriverFromEnvironment({}), undefined);
  assert.equal(createHermesDriverFromEnvironment({ RELAYDESK_ENABLE_HERMES: 'true', RELAYDESK_HERMES_API_KEY: apiKey }), undefined);
  assert.throws(() => createHermesDriverFromEnvironment({ RELAYDESK_ENABLE_HERMES: '1', API_SERVER_KEY: apiKey }));
  for (const baseUrl of ['https://127.0.0.1:8642', 'http://example.com', 'http://127.1:8642', 'http://2130706433', 'http://127.0.0.1/path', 'http://localhost?key=x', 'http://localhost#fragment', 'http://key@localhost', 'http://localhost:99999']) assert.throws(() => createHermesDriver({ baseUrl, apiKey }));
  assert.throws(() => createHermesDriver({ baseUrl: 'http://localhost', apiKey: 'key\r\nHeader: value' }));
  for (const key of ['short-key', 'your_secret_key_here', 'change-me-local-dev', 'replace-with-generated-secret', 'sk-xxxxxxxxxxxxxxxx', 'xxxxxxxxxxxxxxxx', 'x_x-x_x-x_x-x_x-x_x-x_x']) assert.throws(() => createHermesDriver({ baseUrl: 'http://localhost', apiKey: key }));
  for (const baseUrl of ['http://localhost:8642', 'http://127.0.0.1', 'http://[::1]:8642/']) assert.equal(createHermesDriver({ baseUrl, apiKey }).info.id, 'hermes');
});

test('redirects and missing durable capabilities refuse submission without exposing upstream diagnostics', async () => {
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://SECRET.example' } }), new Response(JSON.stringify({ ...capabilities, features: { ...capabilities.features, runs_idempotency: { supported: true, durable: false } } })), new Response(JSON.stringify({ ...capabilities, auth: { type: 'bearer', required: false } }))]) {
    let count = 0;
    const driver = createHermesDriver({ baseUrl: 'http://localhost:8642', apiKey, fetch: async (_url, init) => { count++; assert.equal(init?.redirect, 'manual'); return response; } });
    await assert.rejects(driver.execute(context().input), error => error instanceof Error && !(error instanceof NativeOutcomeUnknownError) && !error.message.includes('SECRET'));
    assert.equal(count, 1);
  }
});

test('HTTP submit redirect never follows a key to another host and remains unknown', async () => {
  const f = fixture(() => new Response(null, { status: 307, headers: { Location: 'https://SECRET.example' } }));
  await assert.rejects(f.driver.execute(context().input), NativeOutcomeUnknownError);
  assert.equal(f.calls.length, 2);
});

test('bounded HTTP wait after submission is unknown and not automatically replayed', async () => {
  const f = fixture(() => new Promise(() => {}), { requestTimeoutMs: 8 });
  await assert.rejects(f.driver.execute(context().input), NativeOutcomeUnknownError);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
