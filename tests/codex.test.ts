import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { ExecutionAdapter, ExecutionContext, Message, Task } from '../shared/types.ts';
import { codexArguments, codexEnvironment, codexTranscript, createCodexAdapter, createCodexAdapterFromEnvironment } from '../server/codex-adapter.ts';
import type { CodexOptions } from '../server/codex-adapter.ts';
import { TaskEngine } from '../server/engine.ts';
import { SessionStore } from '../server/store.ts';
import type { Session } from '../shared/types.ts';

/** An in-memory subprocess port: tests never execute a provider, access auth, or use network. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  input = '';
  ignoreTerm = false;
  ignoreAllSignals = false;
  closed = false;
  private keepAlive = setInterval(() => {}, 1000);
  constructor() {
    super();
    this.stdin.on('data', chunk => { this.input += String(chunk); });
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (!this.ignoreAllSignals && (signal !== 'SIGTERM' || !this.ignoreTerm)) queueMicrotask(() => this.close(null));
    return true;
  }
  close(code: number | null = 0) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.stdout.end(); this.stderr.end(); this.emit('close', code);
  }
  event(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n'); }
}

function context(signal = new AbortController().signal): ExecutionContext & { output: string[] } {
  const timestamp = new Date().toISOString();
  const task: Task = { id: 'task-one', sessionId: 'session-one', adapterId: 'codex', prompt: '你好', mode: 'chat', status: 'running', createdAt: timestamp, updatedAt: timestamp, events: [] };
  const output: string[] = [];
  return { task, history: [{ id: 'message-one', role: 'user', content: '你好', createdAt: timestamp, taskId: task.id }], signal, emit: chunk => output.push(chunk), output };
}

async function adapterFixture(t: TestContext, scenario: (child: FakeChild) => void, extra: Partial<CodexOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-codex-'));
  const children: FakeChild[] = [];
  const calls: { executable: string; args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
  const adapter = createCodexAdapter({
    executablePath: process.execPath, workspace: join(directory, 'workspace'), timeoutMs: 1000, killGraceMs: 10,
    versionProbe: () => ({ status: 0, stdout: 'codex-cli 0.142.2\n' }),
    env: { HOME: '/local-home', PATH: '/local-bin', CODEX_HOME: '/existing-codex-home', OPENAI_API_KEY: 'do-not-forward', CODEX_THREAD_ID: 'parent-thread', RELAYDESK_ENABLE_CODEX: '1', NODE_OPTIONS: 'do-not-forward' },
    ...extra,
    spawnProcess(executable, args, options) {
      const child = new FakeChild();
      children.push(child); calls.push({ executable, args, options });
      queueMicrotask(() => scenario(child));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  t.after(async () => { children.forEach(child => child.close()); await rm(directory, { recursive: true, force: true }); });
  return { adapter, children, calls, directory };
}

test('Codex invocation uses fixed read-only args, stdin transcript, isolated cwd, and allowlisted environment', async t => {
  const f = await adapterFixture(t, child => {
    child.event({ type: 'thread.started', thread_id: 'do-not-resume-this' });
    child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: '你好！' } });
    child.event({ type: 'turn.completed', usage: {} });
    child.close();
  }, { model: 'allowed-model' });
  const input = context();
  await f.adapter.execute(input);
  assert.deepEqual(input.output, ['你好！']);
  assert.equal(f.calls[0].executable, process.execPath);
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.cwd, join(f.directory, 'workspace'));
  assert.equal(f.calls[0].args.at(-1), '-');
  assert.ok(!f.calls[0].args.some(arg => arg.includes('你好')));
  assert.deepEqual(f.calls[0].args, codexArguments(join(f.directory, 'workspace'), 'allowed-model', '0.142.2'));
  assert.ok(!f.calls[0].args.includes('agents.enabled=false'));
  for (const required of ['--strict-config', '--ignore-user-config', '--ephemeral', 'read-only', 'never', 'web_search="disabled"', 'history.persistence="none"', 'notify=[]', 'forced_login_method="chatgpt"', 'shell_environment_policy.inherit="none"', 'remote_plugin', 'multi_agent', 'multi_agent_v2']) assert.ok(f.calls[0].args.includes(required), required);
  for (const forbidden of ['--ignore-rules', '--yolo', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--full-auto']) assert.ok(!f.calls[0].args.includes(forbidden));
  assert.deepEqual(f.calls[0].options.env, { HOME: '/local-home', PATH: '/local-bin', CODEX_HOME: '/existing-codex-home' });
  assert.equal(f.children[0].input, codexTranscript(input.history));
  assert.equal(f.children[0].input.match(/你好/g)?.length, 1);
  assert.equal((await stat(join(f.directory, 'workspace'))).mode & 0o777, 0o700);
});

test('startup probes the exact configured executable once with bounded output, no stdin and the same restricted environment', async t => {
  let probes = 0;
  const f = await adapterFixture(t, child => {
    child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'ok' } });
    child.event({ type: 'turn.completed' });
    child.close();
  }, {
    versionProbe(executable, args, options) {
      probes++;
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, ['--version']);
      assert.equal(options.shell, false);
      assert.equal(options.encoding, 'utf8');
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 4096);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.ok(String(options.cwd).endsWith('/workspace'));
      assert.deepEqual(options.env, { HOME: '/local-home', PATH: '/local-bin', CODEX_HOME: '/existing-codex-home' });
      return { status: 0, stdout: 'codex-cli 0.162.1\n', stderr: 'SECRET nonfatal PATH alias warning' };
    },
  });
  await f.adapter.execute(context());
  await f.adapter.execute(context());
  assert.equal(probes, 1);
  assert.equal(f.calls.length, 2);
  const latest = f.calls[0].args;
  assert.deepEqual(latest, codexArguments(join(f.directory, 'workspace'), undefined, '0.162.1'));
  const agentsSetting = latest.indexOf('agents.enabled=false');
  assert.ok(agentsSetting > 0);
  assert.equal(latest[agentsSetting - 1], '-c');
  // The verified new-version profile only adds a restriction; every old restriction remains.
  const withoutNewRestriction = latest.toSpliced(agentsSetting - 1, 2);
  assert.deepEqual(withoutNewRestriction, codexArguments(join(f.directory, 'workspace'), undefined, '0.142.2'));
});

test('unknown versions, malformed version output and failed probes reject startup without leaking diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const results = [
    { status: 0, stdout: 'codex-cli 0.163.0\n' },
    { status: 0, stdout: 'codex-cli 0.162.1-alpha.1\n' },
    { status: 0, stdout: 'codex-cli 0.162.1\nSECRET extra output' },
    { status: 0, stdout: '' },
    { status: 1, stdout: 'codex-cli 0.162.1\n', stderr: 'SECRET failure' },
    { status: null, stdout: '', error: new Error('SECRET timeout or output limit') },
    { status: null, stdout: 'codex-cli 0.162.1\n', signal: 'SIGKILL' as const },
  ];
  let executionSpawns = 0;
  for (const result of results) {
    assert.throws(() => createCodexAdapter({
      executablePath: process.execPath, workspace: directory,
      versionProbe: () => result,
      spawnProcess: () => { executionSpawns++; throw new Error('must not execute'); },
    }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Codex CLI 版本/);
      assert.doesNotMatch(error.message, /SECRET|0\.163\.0|alpha/);
      return true;
    });
  }
  assert.throws(() => createCodexAdapter({
    executablePath: process.execPath, workspace: directory,
    versionProbe: () => { throw new Error('SECRET launch failure'); },
  }), error => error instanceof Error && /无法验证/.test(error.message) && !error.message.includes('SECRET'));
  assert.equal(executionSpawns, 0);
});

test('production version probing rejects a real local non-Codex executable without contacting a provider', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-native-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.throws(() => createCodexAdapter({ executablePath: process.execPath, workspace: directory, env: {} }), /版本尚未验证/);
});

test('only known completed assistant items are emitted; UTF-8/JSONL fragments and duplicates are handled', async t => {
  const f = await adapterFixture(t, child => {
    child.stderr.write('SECRET diagnostic /private/path account-name');
    child.event({ type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: 'internal reasoning is not user output' } });
    child.event({ type: 'item.updated', item: { id: 'reply', type: 'agent_message', text: 'do-not-duplicate' } });
    const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: '中文 🐈' } }) + '\n');
    for (let offset = 0; offset < bytes.length; offset += 2) child.stdout.write(bytes.subarray(offset, offset + 2));
    child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'duplicate' } });
    child.event({ type: 'item.completed', item: { id: 'reply-two', type: 'agent_message', text: '继续。' } });
    child.stdout.write(JSON.stringify({ type: 'turn.completed' }));
    child.close();
  });
  const input = context();
  await f.adapter.execute(input);
  assert.equal(input.output.join(''), '中文 🐈\n\n继续。');
});

test('malformed events, provider failures, nonzero exits, and missing answers fail without leaking diagnostics', async t => {
  const scenarios: ((child: FakeChild) => void)[] = [
    child => { child.stdout.write('SECRET invalid JSON\n'); },
    child => { child.event(['SECRET invalid event']); },
    child => { child.event({ type: 'error', message: 'SECRET user@email.example failure' }); child.close(1); },
    child => { child.event({ type: 'turn.failed', error: { message: 'SECRET failure' } }); },
    child => { child.stderr.write('SECRET token'); child.close(9); },
    child => { child.event({ type: 'turn.completed' }); child.close(); },
    child => { child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'partial answer' } }); child.close(); },
    child => { child.emit('error', new Error('SECRET spawn details')); child.close(); },
  ];
  for (const scenario of scenarios) {
    const f = await adapterFixture(t, scenario);
    await assert.rejects(f.adapter.execute(context()), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('SECRET'));
      assert.match(error.message, /Codex/);
      return true;
    });
  }
});

test('unsupported model errors provide a local configuration action without exposing raw provider text', async t => {
  const f = await adapterFixture(t, child => child.event({ type: 'turn.failed', error: { message: 'SECRET model xyz is not supported with current account' } }));
  await assert.rejects(f.adapter.execute(context()), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /RELAYDESK_CODEX_MODEL/);
    assert.ok(!error.message.includes('SECRET'));
    assert.ok(!error.message.includes('xyz'));
    return true;
  });
});

test('nested JSON terminal diagnostics requiring a newer Codex version return a sanitized CLI update hint', async t => {
  const message = JSON.stringify({
    type: 'error', status: 400,
    error: { type: 'invalid_request_error', message: "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." },
  });
  const f = await adapterFixture(t, child => {
    child.event({ type: 'error', message });
    child.event({ type: 'turn.failed', error: { message } });
  });
  const input = context();
  await assert.rejects(f.adapter.execute(input), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /需要更新版本的官方 Codex CLI/);
    assert.doesNotMatch(error.message, /gpt-6-astra|invalid_request_error|requires a newer|400/);
    return true;
  });
  assert.deepEqual(input.output, []);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});

test('nonterminal CLI diagnostic items permit a successful turn without exposing raw warnings', async t => {
  for (const message of [
    'Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
    'SECRET diagnostic /private/account user@example.invalid',
  ]) {
    const f = await adapterFixture(t, child => {
      child.event({ type: 'item.completed', item: { id: 'diagnostic', type: 'error', message } });
      child.event({ type: 'turn.started' });
      child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'completed answer' } });
      child.event({ type: 'turn.completed' });
      child.close();
    });
    const input = context();
    await f.adapter.execute(input);
    assert.deepEqual(input.output, ['completed answer']);
    assert.deepEqual(f.children[0].signals, []);
  }
});

test('a recoverable top-level error waits for terminal success instead of killing the process', async t => {
  const f = await adapterFixture(t, child => {
    child.event({ type: 'error', message: 'SECRET reconnecting stream for user@example.invalid' });
    child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'reconnected answer' } });
    child.event({ type: 'turn.completed' });
    child.close();
  });
  const input = context();
  await f.adapter.execute(input);
  assert.deepEqual(input.output, ['reconnected answer']);
  assert.deepEqual(f.children[0].signals, []);
});

test('diagnostics cannot turn failed, incomplete, nonzero-exit, or timed-out requests into success', async t => {
  const warning = { type: 'item.completed', item: { id: 'warning', type: 'error', message: 'SECRET Model metadata for `private-model` not found; fallback metadata' } };
  const scenarios: { run: (child: FakeChild) => void; expected: RegExp }[] = [
    { run: child => { child.event(warning); child.event({ type: 'turn.failed', error: { message: 'SECRET fatal account error' } }); }, expected: /Codex 请求失败/ },
    { run: child => { child.event({ type: 'error', message: 'SECRET model private-model is not supported' }); child.close(1); }, expected: /RELAYDESK_CODEX_MODEL/ },
    { run: child => { child.event({ type: 'error', message: 'SECRET stream error' }); child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'partial' } }); child.event({ type: 'turn.completed' }); child.close(1); }, expected: /Codex 请求失败/ },
    { run: child => { child.event(warning); child.close(); }, expected: /未完成有效回复/ },
    { run: child => { child.event({ type: 'error', message: 'SECRET reconnecting' }); child.close(); }, expected: /Codex 请求失败/ },
    { run: child => { child.event(warning); }, expected: /超时/ },
  ];
  for (const scenario of scenarios) {
    const f = await adapterFixture(t, scenario.run, { timeoutMs: 20 });
    await assert.rejects(f.adapter.execute(context()), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, scenario.expected);
      assert.doesNotMatch(error.message, /SECRET|private-model|Model metadata/);
      return true;
    });
  }
});

test('tool items and unknown protocols stop immediately before any later assistant output', async t => {
  for (const phase of ['item.started', 'item.updated', 'item.completed']) {
    for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'unknown_tool']) {
      const f = await adapterFixture(t, child => {
        child.event({ type: phase, item: { id: 'tool', type, text: 'SECRET tool result' } });
        child.event({ type: 'item.completed', item: { id: 'later', type: 'agent_message', text: 'must not emit' } });
        child.event({ type: 'turn.completed' });
      });
      const input = context();
      await assert.rejects(f.adapter.execute(input), /工具事件/);
      assert.deepEqual(input.output, []);
      assert.deepEqual(f.children[0].signals, ['SIGTERM']);
    }
  }
  for (const event of [{ type: 'future.protocol' }, { type: 'item.completed' }, { type: 'item.completed', item: { type: 'agent_message', text: 'missing-id' } }]) {
    const f = await adapterFixture(t, child => child.event(event));
    await assert.rejects(f.adapter.execute(context()), /未知的事件协议/);
  }
});

test('an output callback failure stops the process without leaking its exception or crashing', async t => {
  const f = await adapterFixture(t, child => child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'answer' } }));
  const input = context(); input.emit = () => { throw new Error('SECRET storage path'); };
  await assert.rejects(f.adapter.execute(input), /无法记录 Codex 回复/);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});

test('one real Codex execution at a time across sessions; the slot releases only after close', async t => {
  const f = await adapterFixture(t, () => {});
  const first = f.adapter.execute(context());
  await sleep(1);
  const secondInput = context(); secondInput.task.sessionId = 'another-session';
  await assert.rejects(f.adapter.execute(secondInput), /一次仅运行一个/);
  assert.equal(f.calls.length, 1);
  f.children[0].event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'done' } });
  f.children[0].event({ type: 'turn.completed' });
  f.children[0].close();
  await first;
  const second = f.adapter.execute(secondInput);
  await sleep(1);
  assert.equal(f.calls.length, 2);
  f.children[1].event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'second done' } });
  f.children[1].event({ type: 'turn.completed' });
  f.children[1].close();
  await second;
});

test('output, line, reply, and full-history limits stop execution instead of truncating silently', async t => {
  for (const fixture of [
    { scenario: (child: FakeChild) => child.stderr.write('x'.repeat(2048)), options: { maxOutputBytes: 1024 } },
    { scenario: (child: FakeChild) => child.stdout.write('x'.repeat(2048)), options: { maxLineBytes: 1024 } },
    { scenario: (child: FakeChild) => child.event({ type: 'item.completed', item: { id: 'long', type: 'agent_message', text: 'x'.repeat(129 * 1024) } }), options: {} },
  ]) {
    const f = await adapterFixture(t, fixture.scenario, fixture.options);
    await assert.rejects(f.adapter.execute(context()), /超出/);
    assert.ok(f.children[0].signals.includes('SIGTERM'));
  }
  const f = await adapterFixture(t, () => {}, { maxPromptBytes: 40 });
  await assert.rejects(f.adapter.execute(context()), /历史超出/);
  assert.equal(f.calls.length, 0);
});

test('abort kills the subprocess and rejects all late output; pre-aborted work never spawns', async t => {
  const controller = new AbortController();
  const f = await adapterFixture(t, child => {
    controller.abort();
    child.event({ type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'must not emit' } });
    child.event({ type: 'turn.completed' });
  });
  const input = context(controller.signal);
  await assert.rejects(f.adapter.execute(input), /取消/);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  assert.deepEqual(input.output, []);
  await assert.rejects(f.adapter.execute(context(controller.signal)), /取消/);
  assert.equal(f.calls.length, 1);
});

test('timeout escalates from SIGTERM to SIGKILL when a process ignores termination', async t => {
  const f = await adapterFixture(t, child => { child.ignoreTerm = true; }, { timeoutMs: 10, killGraceMs: 10 });
  await assert.rejects(f.adapter.execute(context()), /超时/);
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
});

test('unconfirmed termination fails explicitly and quarantines future executions', async t => {
  const f = await adapterFixture(t, child => { child.ignoreAllSignals = true; }, { timeoutMs: 5, killGraceMs: 5, stopConfirmationMs: 5 });
  await assert.rejects(f.adapter.execute(context()), /无法确认 Codex 进程已停止/);
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(f.adapter.execute(context()), /已暂停此适配器/);
  assert.equal(f.calls.length, 1);
  f.children[0].close();
});

test('real local Node subprocesses are killed and reaped on cancellation and timeout without contacting a provider', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const action of ['cancel', 'timeout']) {
    let child: ChildProcessWithoutNullStreams | undefined;
    const controller = new AbortController();
    const adapter = createCodexAdapter({
      executablePath: process.execPath, workspace: directory,
      versionProbe: () => ({ status: 0, stdout: 'codex-cli 0.142.2\n' }),
      timeoutMs: action === 'timeout' ? 250 : 2000, killGraceMs: 25, stopConfirmationMs: 1000,
      spawnProcess(_executable, _args, options) {
        child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); process.stdout.write(JSON.stringify({type:'item.completed',item:{id:'ready',type:'agent_message',text:'ready'}})+'\\n'); setInterval(() => {},1000);`], { ...options, stdio: 'pipe' });
        return child;
      },
    });
    const input = context(controller.signal);
    input.emit = () => { if (action === 'cancel') controller.abort(); };
    await assert.rejects(adapter.execute(input), action === 'cancel' ? /取消/ : /超时/);
    assert.ok(child?.pid);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(child!.pid!, 0), { code: 'ESRCH' });
    if (process.platform !== 'win32') assert.throws(() => process.kill(-child!.pid!, 0), { code: 'ESRCH' });
  }
});

test('running real tasks remain cancelling until confirmed close and retain the session mutex', async t => {
  const f = await adapterFixture(t, child => { child.ignoreAllSignals = true; }, { timeoutMs: 1000, killGraceMs: 10, stopConfirmationMs: 500 });
  const engine = new TaskEngine(':memory:', 1, f.adapter);
  t.after(() => engine.close());
  const session = engine.create('codex');
  const task = engine.submit(session.id, 'cancel carefully', 'chat');
  while (!f.children.length) await sleep(2);
  assert.equal(engine.cancel(task.id).status, 'cancelling');
  await sleep(30);
  assert.equal(engine.get(session.id).tasks[0].status, 'cancelling');
  assert.throws(() => engine.submit(session.id, 'must wait', 'chat'), /进行中的任务/);
  assert.throws(() => engine.cancel(task.id), /等待执行进程停止/);
  f.children[0].close();
  await sleep(2);
  assert.equal(engine.get(session.id).tasks[0].status, 'cancelled');
  assert.deepEqual(engine.get(session.id).tasks[0].events.map(event => event.status), ['queued', 'running', 'cancelling', 'cancelled']);
});

test('unconfirmed real cancellation becomes failed, while queued cancellation never starts a process', async t => {
  const f = await adapterFixture(t, child => { child.ignoreAllSignals = true; }, { timeoutMs: 1000, killGraceMs: 5, stopConfirmationMs: 5 });
  const engine = new TaskEngine(':memory:', 5, f.adapter);
  t.after(() => engine.close());
  const queued = engine.create('codex');
  const queuedTask = engine.submit(queued.id, 'queued', 'chat');
  assert.equal(engine.cancel(queuedTask.id).status, 'cancelled');
  await sleep(10);
  assert.equal(f.calls.length, 0);
  const session = engine.create('codex');
  const task = engine.submit(session.id, 'cannot confirm exit', 'chat');
  while (!f.children.length) await sleep(2);
  engine.cancel(task.id);
  await sleep(25);
  const failed = engine.get(session.id).tasks[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /无法确认/);
  assert.ok(!failed.events.some(event => event.status === 'cancelled'));
  f.children[0].close();
});

test('startup requires explicit opt-in and absolute executable; model and environment cannot inject CLI flags', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(createCodexAdapterFromEnvironment({}, directory), undefined);
  assert.equal(createCodexAdapterFromEnvironment({ RELAYDESK_ENABLE_CODEX: 'true' }, directory), undefined);
  assert.throws(() => createCodexAdapterFromEnvironment({ RELAYDESK_ENABLE_CODEX: '1' }, directory), /absolute path/);
  assert.throws(() => createCodexAdapterFromEnvironment({ RELAYDESK_ENABLE_CODEX: '1', RELAYDESK_CODEX_PATH: 'codex' }, directory), /absolute path/);
  for (const model of ['', '--yolo', 'model --yolo', 'model\n--yolo', '$(echo injected)', 'x'.repeat(101)]) {
    assert.throws(() => createCodexAdapter({ executablePath: process.execPath, workspace: directory, model }), /model identifier/);
  }
  const enabled = createCodexAdapterFromEnvironment({ RELAYDESK_ENABLE_CODEX: '1', RELAYDESK_CODEX_PATH: process.execPath, RELAYDESK_CODEX_MODEL: 'local-model' }, directory, {
    versionProbe: () => ({ status: 0, stdout: 'codex-cli 0.162.1\n' }),
  });
  assert.equal(enabled?.info.id, 'codex');
  assert.equal(enabled?.info.available, true);
  assert.deepEqual(codexEnvironment({ HOME: '/h', CODEX_THREAD_ID: 'parent', OPENAI_API_KEY: 'key', ANTHROPIC_API_KEY: 'key', NODE_OPTIONS: '--require evil', AWS_SECRET_ACCESS_KEY: 'key', CODEX_HOME: '/existing' }), { HOME: '/h', CODEX_HOME: '/existing' });
});

test('real adapter rejects approval demos before starting a process', async t => {
  const f = await adapterFixture(t, () => {});
  const input = context(); input.task.mode = 'approval-demo';
  await assert.rejects(f.adapter.execute(input), /不支持模拟审批/);
  assert.equal(f.calls.length, 0);
});

test('engine routes real sessions independently, replays full local history, and rejects unsupported approval or disabled reuse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-real-engine-'));
  const histories: Message[][] = [];
  const adapter: ExecutionAdapter = {
    info: { id: 'codex', kind: 'cli', available: true, name: 'Codex CLI', description: 'test injected provider' },
    async execute(input) { histories.push(structuredClone(input.history)); input.emit(`答复：${input.task.prompt}`); },
  };
  const db = join(directory, 'sessions.sqlite');
  let engine = new TaskEngine(db, 1, adapter);
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(engine.catalog().find(info => info.id === 'codex')?.available, true);
  const first = engine.create('codex');
  const second = engine.create('codex');
  assert.throws(() => engine.submit(first.id, 'not approved', 'approval-demo'), /不支持模拟审批/);
  assert.equal(engine.get(first.id).tasks.length, 0);
  async function complete(id: string) {
    for (let attempts = 0; attempts < 200; attempts++) {
      if (engine.get(id).tasks.at(-1)?.status === 'completed') return;
      await sleep(2);
    }
    assert.fail('Task did not complete');
  }
  engine.submit(first.id, 'private first-session text', 'chat'); await complete(first.id);
  engine.submit(second.id, 'separate second-session text', 'chat'); await complete(second.id);
  engine.submit(first.id, 'follow-up first-session', 'chat'); await complete(first.id);
  assert.deepEqual(histories[0].map(message => message.content), ['private first-session text']);
  assert.deepEqual(histories[1].map(message => message.content), ['separate second-session text']);
  assert.deepEqual(histories[2].map(message => message.content), ['private first-session text', '答复：private first-session text', 'follow-up first-session']);
  const snapshot = engine.get(first.id);
  assert.ok(snapshot.tasks.every(task => task.events.every(event => !event.detail.includes('模拟'))));
  await engine.close();
  engine = new TaskEngine(db, 1);
  assert.equal(engine.catalog().find(info => info.id === 'codex')?.available, false);
  assert.throws(() => engine.submit(first.id, 'must not run after disabled', 'chat'), /未启用/);
  assert.throws(() => engine.create('codex'), /未启用/);
  assert.deepEqual(engine.get(first.id), snapshot);
});

test('persistent storage failure aborts the child, drains jobs, rejects writes, and does not claim state was saved', async t => {
  const f = await adapterFixture(t, child => {
    child.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'triggers storage failure' } });
    child.event({ type: 'turn.completed' });
  });
  const persisted = new Map<string, Session>();
  let writes = 0;
  let failedWrites = 0;
  let storeClosed = false;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });
  const engine = new TaskEngine(':memory:', 1, f.adapter, { store: {
    all: () => [...persisted.values()].map(session => structuredClone(session)),
    save(session) {
      writes++;
      if (session.messages.some(message => message.role === 'assistant')) { failedWrites++; throw new Error('SECRET full disk path'); }
      persisted.set(session.id, structuredClone(session));
    },
    close() { storeClosed = true; },
  } });
  const session = engine.create('codex');
  engine.submit(session.id, 'persistent disk failure', 'chat');
  for (let attempts = 0; attempts < 200 && !f.children[0]?.closed; attempts++) await sleep(2);
  assert.equal(f.children[0].closed, true);
  assert.ok(f.children[0].signals.includes('SIGTERM'));
  const failed = engine.get(session.id).tasks[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stopUnconfirmed, true);
  assert.match(failed.error!, /未确认保存/);
  assert.match(failed.error!, /内存/);
  assert.ok(!failed.error!.includes('SECRET'));
  assert.equal(persisted.get(session.id)!.tasks[0].status, 'running', 'the durable snapshot must not pretend the failure was saved');
  assert.equal(failedWrites, 1, 'persistent disk errors must not cause recursive retry writes');
  assert.ok(engine.catalog().every(info => !info.available));
  assert.throws(() => engine.create('mock-codex'), error => error instanceof Error && 'status' in error && error.status === 503);
  assert.throws(() => engine.submit(session.id, 'must not run', 'chat'), /存储写入失败/);
  const writesAtFailure = writes;
  await sleep(20);
  assert.equal(writes, writesAtFailure);
  await engine.close();
  assert.equal(storeClosed, true);
  assert.deepEqual(unhandled, []);

  // A subsequent healthy startup sees the durable running snapshot and isolates real execution.
  const restored = new TaskEngine(':memory:', 1, f.adapter, { store: {
    all: () => [...persisted.values()].map(value => structuredClone(value)),
    save(value) { persisted.set(value.id, structuredClone(value)); },
    close() {},
  } });
  assert.equal(restored.catalog().find(info => info.id === 'codex')?.available, false);
  assert.equal(restored.get(session.id).tasks[0].stopUnconfirmed, true);
  await restored.close();
});

test('interrupted real tasks remain quarantined across restarts until explicit local acknowledgement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-restart-quarantine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, 'sessions.sqlite');
  let executions = 0;
  const adapter: ExecutionAdapter = {
    info: { id: 'codex', kind: 'cli', available: true, name: 'Codex CLI', description: 'test injected provider' },
    async execute(input) { executions++; input.emit('approved local restart fixture'); },
  };
  const seed = new TaskEngine(db, 1, adapter);
  const session = seed.create('codex');
  await seed.close();
  const store = new SessionStore(db);
  const snapshot = store.all()[0];
  for (const status of ['queued', 'running', 'cancelling'] as const) {
    snapshot.tasks.push({ ...context().task, id: `interrupted-${status}`, sessionId: session.id, status });
  }
  snapshot.tasks.push({ ...context().task, id: 'already-unconfirmed', sessionId: session.id, status: 'failed', stopUnconfirmed: true });
  store.save(snapshot); store.close();
  for (let restart = 0; restart < 3; restart++) {
    const engine = new TaskEngine(db, 1, adapter);
    const restored = engine.get(session.id);
    assert.ok(restored.tasks.every(task => task.status === 'failed' && task.stopUnconfirmed));
    assert.equal(engine.catalog().find(info => info.id === 'codex')?.available, false);
    assert.throws(() => engine.create('codex'), /未确认结束/);
    assert.throws(() => engine.submit(session.id, 'blocked after restart', 'chat'), /未确认结束/);
    assert.equal(engine.create('mock-codex').adapterId, 'mock-codex', 'local simulations remain available');
    await engine.close();
  }
  assert.equal(executions, 0);
  const acknowledged = new TaskEngine(db, 1, adapter, { acknowledgeInterruptedCodex: true });
  assert.ok(acknowledged.get(session.id).tasks.every(task => !task.stopUnconfirmed));
  assert.equal(acknowledged.catalog().find(info => info.id === 'codex')?.available, true);
  acknowledged.submit(session.id, 'allowed after operator check', 'chat');
  for (let attempts = 0; attempts < 200 && acknowledged.get(session.id).tasks.at(-1)?.status !== 'completed'; attempts++) await sleep(2);
  assert.equal(executions, 1);
  await acknowledged.close();
  const later = new TaskEngine(db, 1, adapter);
  assert.equal(later.catalog().find(info => info.id === 'codex')?.available, true);
  assert.ok(later.get(session.id).tasks.every(task => !task.stopUnconfirmed));
  await later.close();
});

test('unconfirmed process stop persists quarantine even though its task is already failed', async t => {
  const f = await adapterFixture(t, child => { child.ignoreAllSignals = true; }, { timeoutMs: 5, killGraceMs: 5, stopConfirmationMs: 5 });
  const db = join(f.directory, 'persistent-quarantine.sqlite');
  const engine = new TaskEngine(db, 1, f.adapter);
  const session = engine.create('codex');
  engine.submit(session.id, 'unconfirmed stop', 'chat');
  for (let attempts = 0; attempts < 200 && engine.get(session.id).tasks[0].status !== 'failed'; attempts++) await sleep(2);
  assert.equal(engine.get(session.id).tasks[0].status, 'failed');
  assert.equal(engine.get(session.id).tasks[0].stopUnconfirmed, true);
  assert.equal(engine.catalog().find(info => info.id === 'codex')?.available, false);
  f.children[0].close();
  await engine.close();
  const replacement: ExecutionAdapter = { info: f.adapter.info, async execute() { assert.fail('a restarted adapter must not execute before acknowledgement'); } };
  for (let restart = 0; restart < 2; restart++) {
    const restored = new TaskEngine(db, 1, replacement);
    assert.equal(restored.get(session.id).tasks[0].stopUnconfirmed, true);
    assert.throws(() => restored.submit(session.id, 'blocked', 'chat'), /未确认结束/);
    await restored.close();
  }
});
