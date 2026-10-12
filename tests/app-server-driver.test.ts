import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { EngineBinding, ExecutionContext, NativeActivityKind, NativeApproval } from '../shared/types.ts';
import { codexAppServerArguments, createCodexAppServerDriver, NativeOutcomeUnknownError } from '../server/codex-app-server.ts';
import type { CodexAppServerOptions } from '../server/codex-app-server.ts';

type Frame = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown };
/** In-memory official-protocol peer; no provider, account access, commands or filesystem edits. */
class NativeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  frames: Frame[] = []; signals: NodeJS.Signals[] = []; closed = false; ignoreClose = false; ignoreSignals = false;
  constructor(handler: (frame: Frame, child: NativeChild) => void) {
    super();
    let pending = '';
    this.stdin.on('data', chunk => {
      pending += String(chunk);
      let boundary: number;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        const frame = JSON.parse(pending.slice(0, boundary)) as Frame;
        pending = pending.slice(boundary + 1); this.frames.push(frame);
        queueMicrotask(() => handler(frame, this));
      }
    });
    this.stdin.on('finish', () => { if (!this.ignoreClose) queueMicrotask(() => this.close()); });
  }
  frame(frame: unknown) { this.stdout.write(JSON.stringify(frame) + '\n'); }
  reply(id: string | number | undefined, result: unknown) { this.frame({ id, result }); }
  notify(method: string, params: Record<string, unknown>) { this.frame({ method, params }); }
  request(id: string | number, method: string, params: Record<string, unknown>) { this.frame({ id, method, params }); }
  terminal(status = 'completed', items: unknown[] = []) { this.notify('turn/completed', { threadId: 'native-thread', turn: { id: 'native-turn', status, items } }); }
  close() { if (this.closed) return; this.closed = true; this.stdout.end(); this.stderr.end(); this.emit('close', 0); }
  kill(signal: NodeJS.Signals) { this.signals.push(signal); if (!this.ignoreSignals) queueMicrotask(() => this.close()); return true; }
}
function config() {
  return {
    features: Object.fromEntries(['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'image_generation', 'multi_agent', 'multi_agent_v2', 'hooks', 'skill_mcp_dependency_install', 'tool_suggest', 'workspace_dependencies', 'memories', 'shell_snapshot', 'shell_snapshot_v2'].map(key => [key, false])),
    notify: [], agents: { enabled: false }, shell_environment_policy: { inherit: 'none' },
    forced_login_method: 'chatgpt', model_provider: 'openai', openai_base_url: '', chatgpt_base_url: 'https://chatgpt.com/backend-api/', web_search: 'disabled', allow_login_shell: false,
  };
}
interface Scenario {
  config?: Record<string, unknown> | ((processIndex: number) => Record<string, unknown>);
  thread?: (workspace: string, child: NativeChild) => unknown;
  remoteStatus?: string;
  authMode?: string;
  start?: (frame: Frame, child: NativeChild) => void;
  turn?: (child: NativeChild) => void;
  interrupt?: (child: NativeChild) => void;
  response?: (frame: Frame, child: NativeChild) => void;
  read?: unknown;
}
async function fixture(t: TestContext, scenario: Scenario = {}, options: Partial<CodexAppServerOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-native-'));
  const workspace = realpathSync(directory);
  const children: NativeChild[] = [];
  const spawns: { args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
  const driver = createCodexAppServerDriver({
    executable: process.execPath, workspace, model: 'local-model', env: { HOME: '/home', PATH: '/bin', OPENAI_API_KEY: 'SECRET', CODEX_THREAD_ID: 'parent', NODE_OPTIONS: 'SECRET', CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '0' },
    timeoutMs: 1000, requestTimeoutMs: 300, approvalTimeoutMs: 500, interruptTimeoutMs: 50, killGraceMs: 5, stopConfirmationMs: 10,
    versionProbe: () => ({ status: 0, stdout: 'codex-cli 0.162.1\n' }), ...options,
    spawnProcess(_file, args, settings) {
      const child = new NativeChild((frame, peer) => {
        const effective = { thread: { id: 'native-thread', ephemeral: false, status: { type: 'idle' }, turns: [] }, cwd: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, model: 'local-model' };
        if (frame.method === 'initialize') {
          peer.reply(frame.id, {});
          peer.notify('remoteControl/status/changed', { status: scenario.remoteStatus ?? 'disabled' });
          peer.notify('account/updated', { authMode: scenario.authMode ?? 'chatgpt', planType: null });
          peer.notify('configWarning', { summary: 'SECRET synthetic startup warning', details: 'SECRET' });
        }
        else if (frame.method === 'config/read') peer.reply(frame.id, { config: typeof scenario.config === 'function' ? scenario.config(children.indexOf(peer)) : scenario.config ?? config(), origins: {} });
        else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
          peer.notify('thread/goal/cleared', { threadId: 'native-thread' });
          peer.notify('thread/goal/updated', { threadId: 'native-thread', turnId: null, goal: { threadId: 'native-thread', objective: 'SECRET synthetic metadata', status: 'active', createdAt: 1, updatedAt: 1, timeUsedSeconds: 0, tokensUsed: 0 } });
          peer.reply(frame.id, scenario.thread ? scenario.thread(workspace, peer) : effective);
        }
        else if (frame.method === 'turn/start') {
          if (scenario.start) { scenario.start(frame, peer); return; }
          peer.reply(frame.id, { turn: { id: 'native-turn', status: 'inProgress', items: [] } });
          peer.notify('turn/started', { threadId: 'native-thread', turn: { id: 'native-turn', status: 'inProgress', items: [] } });
          if (scenario.turn) scenario.turn(peer);
          else {
            peer.notify('item/completed', { threadId: 'native-thread', turnId: 'native-turn', completedAtMs: 1, item: { id: 'answer', type: 'agentMessage', text: 'native answer' } });
            peer.terminal();
          }
        } else if (frame.method === 'turn/interrupt') { peer.reply(frame.id, {}); if (scenario.interrupt) scenario.interrupt(peer); else peer.terminal('interrupted'); }
        else if (frame.method === 'thread/read') peer.reply(frame.id, scenario.read ?? { thread: { id: 'native-thread', turns: [] } });
        else if (!frame.method) scenario.response?.(frame, peer);
      });
      children.push(child); spawns.push({ args, options: settings });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  t.after(async () => { children.forEach(child => { child.ignoreSignals = false; child.close(); }); await driver.close(); await rm(directory, { recursive: true, force: true }); });
  return { driver, children, spawns, workspace, binding: { driverId: 'codex-app-server', threadId: 'native-thread', workspace, version: '0.162.1' } as EngineBinding };
}
function context(binding?: EngineBinding) {
  const controller = new AbortController();
  const messages = new Map<string, string>(); const bindings: EngineBinding[] = []; const turns: string[] = []; const approvals: NativeApproval[] = []; const resolved: string[] = []; const terminals: string[] = [];
  const activities: NativeActivityKind[] = [];
  const input: ExecutionContext = {
    task: { id: 'local-task', sessionId: 'local-session', adapterId: 'codex-app-server', prompt: 'latest prompt', mode: 'chat', status: 'running', createdAt: 'now', updatedAt: 'now', events: [] },
    history: [{ id: 'history', taskId: 'old-task', role: 'user', content: 'must not replay local history', createdAt: 'before' }], signal: controller.signal, emit: () => assert.fail('native driver must use item upserts'),
    native: {
      binding, onBinding: value => { bindings.push(value); }, onTurn: value => { turns.push(value); },
      upsertMessage: (id, text) => { messages.set(id, text); }, onApproval: value => { approvals.push(value); },
      onApprovalResolved: id => { resolved.push(id); }, onTerminal: status => { terminals.push(status); },
      onActivity: kind => { activities.push(kind); },
    },
  };
  return { input, controller, messages, bindings, turns, approvals, resolved, terminals, activities };
}
async function until(predicate: () => boolean) { for (let n = 0; n < 300; n++) { if (predicate()) return; await delay(2); } assert.fail('offline fixture timed out'); }
const approvalParams = (workspace: string, extra = {}) => ({ threadId: 'native-thread', turnId: 'native-turn', itemId: 'command-item', startedAtMs: 1, command: 'echo harmless', cwd: workspace, ...extra });

test('native driver pins safe stdio startup, persists binding before prompt, and resumes without replaying local history', async t => {
  const f = await fixture(t); const first = context();
  first.input.native!.onBinding = async binding => {
    assert.equal(f.children[0].frames.some(frame => frame.method === 'turn/start'), false);
    first.bindings.push(binding); await delay(1);
  };
  await f.driver.execute(first.input);
  assert.equal(first.bindings[0].threadId, 'native-thread'); assert.deepEqual(first.turns, ['native-turn']);
  assert.equal(first.messages.get('answer'), 'native answer'); assert.deepEqual(first.terminals, ['completed']);
  assert.ok(f.children[0].closed);
  assert.deepEqual(f.spawns[0].args, codexAppServerArguments());
  for (const required of ['--strict-config', 'agents.enabled=false', 'model_provider="openai"', 'openai_base_url=""', 'chatgpt_base_url="https://chatgpt.com/backend-api/"', 'shell_snapshot_v2', 'stdio://']) assert.ok(f.spawns[0].args.includes(required));
  assert.equal(f.spawns[0].options.shell, false);
  assert.deepEqual(f.spawns[0].options.env, { HOME: '/home', PATH: '/bin', CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' });
  const turn = f.children[0].frames.find(frame => frame.method === 'turn/start')!;
  assert.deepEqual(turn.params!.input, [{ type: 'text', text: 'latest prompt' }]);
  assert.deepEqual(turn.params!.environments, []);
  assert.equal(JSON.stringify(f.children[0].frames).includes('must not replay'), false);
  const second = context(first.bindings[0]); await f.driver.execute(second.input);
  assert.equal(f.children[1].frames.filter(frame => frame.method === 'thread/resume').length, 1);
  assert.equal(f.children[1].frames.filter(frame => frame.method === 'thread/start').length, 0);
});

test('preflight rejects inherited connectors, permissions configuration and custom endpoints before any native thread', async t => {
  const bad = [
    { ...config(), mcp_servers: { private: { command: 'SECRET' } } },
    { ...config(), notify: ['SECRET executable'] },
    { ...config(), features: { ...config().features, plugins: true } },
    { ...config(), shell_environment_policy: { inherit: 'none', set: { SECRET: 'token' } } },
    { ...config(), model_provider: 'custom' },
    { ...config(), openai_base_url: 'https://SECRET.example' },
    { ...config(), chatgpt_base_url: 'https://SECRET.example' },
  ];
  for (const config of bad) {
    const f = await fixture(t, { config });
    await assert.rejects(f.driver.execute(context().input), error => error instanceof Error && !error.message.includes('SECRET'));
    assert.ok(!f.children[0].frames.some(frame => frame.method?.startsWith('thread/')));
  }
});

test('MCP discovery starts no thread, disables each scoped name only in the replacement process and revalidates', async t => {
  const secretName = 'synthetic_connector-1';
  const f = await fixture(t, { config: index => ({ ...config(), mcp_servers: { [secretName]: { enabled: index === 0, command: 'SECRET' } } }) });
  await f.driver.execute(context().input);
  assert.equal(f.children.length, 2); assert.ok(f.children[0].closed);
  assert.ok(!f.children[0].frames.some(frame => frame.method?.startsWith('thread/') || frame.method === 'turn/start'));
  assert.ok(f.spawns[1].args.includes(`mcp_servers.${secretName}.enabled=false`));
  assert.equal(f.children[1].frames.filter(frame => frame.method === 'turn/start').length, 1);
  const changed = await fixture(t, { config: index => ({ ...config(), mcp_servers: index === 0 ? { original: { enabled: true } } : { original: { enabled: false }, unexpected: { enabled: false } } }) });
  await assert.rejects(changed.driver.execute(context().input), /MCP 禁用配置/);
  assert.ok(changed.children.every(child => !child.frames.some(frame => frame.method === 'thread/start')));
  for (const name of ['private.connector', 'quoted"name', 'name with spaces']) {
    const unsafe = await fixture(t, { config: { ...config(), mcp_servers: { [name]: { enabled: true } } } });
    await assert.rejects(unsafe.driver.execute(context().input), /MCP 名称/);
    assert.equal(unsafe.children.length, 1);
    assert.ok(!unsafe.children[0].frames.some(frame => frame.method === 'thread/start'));
  }
});

test('remote control must be disabled and fatal thread-stage notifications prevent prompt submission', async t => {
  for (const remoteStatus of ['connecting', 'connected', 'errored']) {
    const f = await fixture(t, { remoteStatus });
    await assert.rejects(f.driver.execute(context().input));
    assert.ok(!f.children[0].frames.some(frame => frame.method === 'thread/start'));
  }
  for (const authMode of ['apikey', 'chatgptAuthTokens', 'headers']) {
    const f = await fixture(t, { authMode });
    await assert.rejects(f.driver.execute(context().input));
    assert.ok(!f.children[0].frames.some(frame => frame.method === 'thread/start'));
  }
  const f = await fixture(t, { thread: (workspace, child) => {
    child.notify('unrecognized/capability', { SECRET: 'never expose' });
    return { thread: { id: 'native-thread', ephemeral: false }, cwd: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, model: 'local-model' };
  } });
  await assert.rejects(f.driver.execute(context().input), error => error instanceof Error && !error.message.includes('SECRET'));
  assert.ok(!f.children[0].frames.some(frame => frame.method === 'turn/start'));
});

test('binding persistence failure or effective thread permission mismatch prevents submitting a prompt', async t => {
  const f = await fixture(t); const c = context();
  c.input.native!.onBinding = () => { throw new Error('disk failure'); };
  await assert.rejects(f.driver.execute(c.input));
  assert.ok(!f.children[0].frames.some(frame => frame.method === 'turn/start'));
  const wrong = await fixture(t, { thread: workspace => ({ thread: { id: 'native-thread' }, cwd: workspace, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, model: 'local-model' }) });
  await assert.rejects(wrong.driver.execute(context().input), /权限/);
  assert.ok(!wrong.children[0].frames.some(frame => frame.method === 'turn/start'));
});

test('environment lifecycle metadata is permitted only in the explicit local environment profile', async t => {
  for (const method of ['thread/environment/connected', 'thread/environment/disconnected']) {
    const scenario: Scenario = { thread: (workspace, child) => {
      child.notify(method, { threadId: 'native-thread', environmentId: 'synthetic-local-environment' });
      return { thread: { id: 'native-thread', ephemeral: false }, cwd: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, model: 'local-model' };
    } };
    const blocked = await fixture(t, scenario);
    await assert.rejects(blocked.driver.execute(context().input));
    assert.ok(!blocked.children[0].frames.some(frame => frame.method === 'turn/start'));
    const allowed = await fixture(t, scenario, { environmentAccess: true });
    const c = context(); await allowed.driver.execute(c.input);
    assert.deepEqual(c.terminals, ['completed']);
    assert.equal(allowed.children[0].frames.find(frame => frame.method === 'turn/start')!.params!.environments, undefined);
  }
  const malformed = await fixture(t, { thread: (workspace, child) => {
    child.notify('thread/goal/updated', { threadId: 'native-thread', goal: { threadId: 'another-thread' } });
    return { thread: { id: 'native-thread' }, cwd: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, model: 'local-model' };
  } });
  await assert.rejects(malformed.driver.execute(context().input));
  assert.ok(!malformed.children[0].frames.some(frame => frame.method === 'turn/start'));
});

test('native item identities deduplicate completions while identical text deltas remain legitimate and final text reconciles', async t => {
  const f = await fixture(t, { turn: child => {
    for (const delta of ['ha', 'ha']) child.notify('item/agentMessage/delta', { threadId: 'native-thread', turnId: 'native-turn', itemId: 'answer', delta });
    const completed = { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'answer', type: 'agentMessage', text: 'corrected final' } };
    child.notify('item/completed', completed); child.notify('item/completed', completed); child.terminal();
  } });
  const c = context(); const updates: string[] = [];
  c.input.native!.upsertMessage = (_id, text) => { updates.push(text); };
  await f.driver.execute(c.input);
  assert.deepEqual(updates, ['ha', 'haha', 'corrected final']);
});

test('native command approvals retain typed request identities, support one-shot decisions and never inherit approval by item', async t => {
  let workspace = '';
  const f = await fixture(t, {
    turn: child => {
      child.request(1, 'item/commandExecution/requestApproval', approvalParams(workspace));
      child.request(1, 'item/commandExecution/requestApproval', approvalParams(workspace));
      child.request('1', 'item/commandExecution/requestApproval', approvalParams(workspace, { approvalId: 'second-subcommand' }));
    },
    response: (frame, child) => { if (frame.id === '1') child.terminal(); },
  }, { environmentAccess: true }); workspace = f.workspace;
  const c = context(); const execution = f.driver.execute(c.input);
  await until(() => c.approvals.length === 2);
  assert.deepEqual(c.approvals.map(approval => approval.requestId), [1, '1']);
  assert.ok(c.approvals[0].allowedDecisions.includes('accept'));
  await f.driver.decideApproval(c.approvals[0].id, 'decline');
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'accept'), /失效/);
  assert.equal(f.children[0].frames.filter(frame => frame.id === 1 && frame.result).length, 1);
  await f.driver.decideApproval(c.approvals[1].id, 'accept');
  await execution;
  assert.equal(c.resolved.length, 2);
});

test('file approvals require unchanged complete diffs; missing previews, extra permissions and path escapes cannot be accepted', async t => {
  let workspace = '';
  const f = await fixture(t, { turn: child => {
    child.notify('item/started', { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'file', type: 'fileChange', changes: [{ path: join(workspace, 'demo.txt'), diff: '+demo', kind: { type: 'add' } }] } });
    child.request('file-request', 'item/fileChange/requestApproval', { ...approvalParams(workspace), itemId: 'file', command: undefined, cwd: undefined });
    child.request('missing', 'item/fileChange/requestApproval', { ...approvalParams(workspace), itemId: 'missing-file' });
    child.request('unsafe-command', 'item/commandExecution/requestApproval', approvalParams(workspace, { additionalPermissions: { network: true } }));
  } }, { environmentAccess: true }); workspace = f.workspace;
  const c = context(); const execution = f.driver.execute(c.input);
  await until(() => c.approvals.length === 3);
  assert.deepEqual(c.approvals[0].changes, [{ path: join(workspace, 'demo.txt'), diff: '+demo' }]);
  assert.ok(c.approvals[0].allowedDecisions.includes('accept'));
  assert.ok(c.approvals.slice(1).every(approval => !approval.allowedDecisions.includes('accept')));
  f.children[0].notify('item/fileChange/patchUpdated', { threadId: 'native-thread', turnId: 'native-turn', itemId: 'file', changes: [{ path: join(workspace, 'demo.txt'), diff: '+changed' }] });
  await until(() => c.resolved.includes(c.approvals[0].id));
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'accept'), /失效/);
  f.children[0].terminal(); await execution;
  const escaped = await fixture(t, { turn: child => {
    child.notify('item/started', { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'file', type: 'fileChange', changes: [{ path: join(workspace, 'escape', 'x'), diff: '+unsafe' }] } });
    child.request('escape', 'item/fileChange/requestApproval', { ...approvalParams(workspace), itemId: 'file' });
  } }, { environmentAccess: true });
  workspace = escaped.workspace; await symlink(tmpdir(), join(workspace, 'escape'));
  const e = context(); const running = escaped.driver.execute(e.input); await until(() => e.approvals.length === 1);
  assert.ok(!e.approvals[0].allowedDecisions.includes('accept'));
  escaped.children[0].terminal(); await running;
});

test('rename destinations cannot be hidden by dropping the native file-change kind', async t => {
  const f = await fixture(t, { turn: child => {
    child.notify('item/started', { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'renamed', type: 'fileChange', changes: [{ path: 'local.txt', diff: '+change', kind: { type: 'update', move_path: '/outside/target.txt' } }] } });
    child.request('rename', 'item/fileChange/requestApproval', { threadId: 'native-thread', turnId: 'native-turn', itemId: 'renamed', startedAtMs: 1 });
  } }, { environmentAccess: true });
  const c = context();
  await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError);
  assert.deepEqual(c.approvals, []);
});

test('approval pipe-write failure is rejected and cannot be reported as an accepted decision', async t => {
  let workspace = '';
  const f = await fixture(t, { turn: child => child.request('approval', 'item/commandExecution/requestApproval', approvalParams(workspace)) }, { environmentAccess: true });
  workspace = f.workspace;
  const c = context(); const execution = f.driver.execute(c.input);
  await until(() => c.approvals.length === 1);
  f.children[0].stdin.write = ((_chunk: unknown, callback: (error?: Error | null) => void) => {
    queueMicrotask(() => callback(new Error('SECRET write failure'))); return false;
  }) as typeof f.children[0]['stdin']['write'];
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'accept'), error => error instanceof NativeOutcomeUnknownError && !error.message.includes('SECRET'));
  await assert.rejects(execution, NativeOutcomeUnknownError);
  assert.deepEqual(c.terminals, []);
});

test('resolved and expired approvals cannot replay responses; unsupported requests fail closed', async t => {
  let workspace = '';
  const f = await fixture(t, { turn: child => child.request('approval', 'item/commandExecution/requestApproval', approvalParams(workspace)) }, { approvalTimeoutMs: 20 }); workspace = f.workspace;
  const c = context(); const execution = f.driver.execute(c.input);
  await until(() => c.approvals.length === 1); await execution;
  await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'decline'), /失效/);
  assert.deepEqual(c.terminals, ['cancelled']);
  const bad = await fixture(t, { turn: child => child.request('unsupported', 'item/tool/call', { threadId: 'native-thread', turnId: 'native-turn', itemId: 'tool' }) });
  await assert.rejects(bad.driver.execute(context().input), NativeOutcomeUnknownError);
});

test('interrupt acknowledgement is not completion; cancel races honor the actual native terminal', async t => {
  const f = await fixture(t, { turn() {}, interrupt() {} }); const c = context();
  const execution = f.driver.execute(c.input); let settled = false;
  void execution.then(() => { settled = true; });
  await until(() => c.turns.length === 1); c.controller.abort();
  await until(() => f.children[0].frames.some(frame => frame.method === 'turn/interrupt'));
  await delay(5); assert.equal(settled, false); assert.deepEqual(c.terminals, []);
  f.children[0].terminal('completed'); await execution;
  assert.deepEqual(c.terminals, ['completed']);
});

test('early cancellation waits for native activity and dispatches exactly one interrupt', async t => {
  for (const cancelBeforeResponse of [false, true]) {
    const c = context(); let startFrame: Frame | undefined;
    const f = await fixture(t, { start: (frame, child) => {
      startFrame = frame;
      if (cancelBeforeResponse) c.controller.abort();
      else child.reply(frame.id, { turn: { id: 'native-turn', status: 'inProgress', items: [] } });
    } });
    const execution = f.driver.execute(c.input);
    await until(() => !!startFrame);
    if (!cancelBeforeResponse) { await until(() => c.turns.length === 1); c.controller.abort(); }
    await delay(2);
    assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/interrupt').length, 0);
    if (cancelBeforeResponse) {
      f.children[0].reply(startFrame!.id, { turn: { id: 'native-turn', status: 'inProgress', items: [] } });
      await until(() => c.turns.length === 1);
      assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/interrupt').length, 0);
    }
    f.children[0].notify('turn/started', { threadId: 'native-thread', turn: { id: 'native-turn', status: 'inProgress', items: [] } });
    await execution;
    assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/interrupt').length, 1);
    assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.deepEqual(c.terminals, ['cancelled']);
  }
});

test('completion before active notification wins early cancellation without sending an interrupt', async t => {
  const f = await fixture(t, { start: (frame, child) => child.reply(frame.id, { turn: { id: 'native-turn', status: 'inProgress', items: [] } }) });
  const c = context(); const execution = f.driver.execute(c.input);
  await until(() => c.turns.length === 1); c.controller.abort();
  f.children[0].terminal('completed'); await execution;
  assert.deepEqual(c.terminals, ['completed']);
  assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/interrupt').length, 0);
});

test('cancellation awaiting native activity remains bounded and never infers a terminal', async t => {
  const f = await fixture(t, { start: (frame, child) => child.reply(frame.id, { turn: { id: 'native-turn', status: 'inProgress', items: [] } }) }, { interruptTimeoutMs: 10 });
  const c = context(); const execution = f.driver.execute(c.input);
  await until(() => c.turns.length === 1); c.controller.abort();
  await assert.rejects(execution, NativeOutcomeUnknownError);
  assert.deepEqual(c.terminals, []);
  assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/interrupt').length, 0);
  assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/start').length, 1);
});

test('disconnect or unconfirmed interruption becomes unknown without resubmitting; global execution remains serialized', async t => {
  const f = await fixture(t, { turn() {}, interrupt() {} }, { interruptTimeoutMs: 10 }); const c = context();
  const execution = f.driver.execute(c.input);
  await until(() => c.turns.length === 1);
  await assert.rejects(f.driver.execute(context().input), /已有原生/);
  c.controller.abort(); await assert.rejects(execution, NativeOutcomeUnknownError);
  assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/start').length, 1);
  const disconnected = await fixture(t, { turn: child => child.close() });
  await assert.rejects(disconnected.driver.execute(context().input), NativeOutcomeUnknownError);
  assert.equal(disconnected.children.length, 1);
});

test('recovery reads only the exact persisted turn and never resumes or starts a prompt', async t => {
  const f = await fixture(t, { read: { thread: { id: 'native-thread', turns: [
    { id: 'unrelated-latest', status: 'completed', items: [{ id: 'wrong', type: 'agentMessage', text: 'not our answer' }] },
    { id: 'native-turn', status: 'interrupted', items: [{ id: 'answer', type: 'agentMessage', text: 'partial native output' }] },
  ] } } });
  assert.equal((await f.driver.recover(f.binding)).status, 'unknown'); assert.equal(f.children.length, 0);
  const recovery = await f.driver.recover(f.binding, 'native-turn');
  assert.equal(recovery.status, 'cancelled'); assert.deepEqual(recovery.messages, [{ itemId: 'answer', text: 'partial native output' }]);
  assert.ok(f.children[0].frames.every(frame => !['thread/start', 'thread/resume', 'turn/start'].includes(frame.method ?? '')));
  assert.equal((await f.driver.recover(f.binding, 'missing-turn')).status, 'unknown');
});

test('callback persistence failures and malformed protocol stop without crashing or leaking raw diagnostics', async t => {
  const f = await fixture(t); const c = context();
  c.input.native!.upsertMessage = () => { throw new Error('SECRET sqlite path'); };
  await assert.rejects(f.driver.execute(c.input), error => error instanceof NativeOutcomeUnknownError && !error.message.includes('SECRET'));
  const malformed = await fixture(t, { turn: child => child.stdout.write('SECRET bad JSON\n') });
  await assert.rejects(malformed.driver.execute(context().input), error => error instanceof NativeOutcomeUnknownError && !error.message.includes('SECRET'));
});

test('native activity reports exact metadata only and refreshes repeated deltas and completed items', async t => {
  const scope = { threadId: 'native-thread', turnId: 'native-turn' };
  const answer = { id: 'answer', type: 'agentMessage', text: 'SECRET assistant answer' };
  const command = { id: 'command', type: 'commandExecution', command: 'SECRET command', cwd: '/SECRET/workspace', aggregatedOutput: 'SECRET output' };
  const file = { id: 'file', type: 'fileChange', changes: [{ path: 'SECRET/file.txt', diff: '+SECRET patch' }] };
  const reasoning = { id: 'reason', type: 'reasoning', summary: ['SECRET reasoning'], content: ['SECRET private reasoning'] };
  const f = await fixture(t, { turn: child => {
    child.notify('item/started', { ...scope, item: reasoning });
    child.notify('item/reasoning/summaryPartAdded', { ...scope, itemId: 'reason', summaryIndex: 0 });
    child.notify('item/reasoning/summaryTextDelta', { ...scope, itemId: 'reason', summaryIndex: 0, delta: 'SECRET summary' });
    child.notify('item/reasoning/textDelta', { ...scope, itemId: 'reason', contentIndex: 0, delta: 'SECRET reasoning delta' });
    child.notify('item/completed', { ...scope, item: reasoning });
    child.notify('item/started', { ...scope, item: { ...answer, text: '' } });
    for (const delta of ['SECRET', 'SECRET']) child.notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta });
    child.notify('item/completed', { ...scope, item: answer });
    child.notify('item/completed', { ...scope, item: answer });
    child.notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: 'SECRET ignored after completion' });
    child.notify('item/started', { ...scope, item: command });
    child.notify('item/commandExecution/outputDelta', { ...scope, itemId: 'command', delta: 'SECRET command output' });
    child.notify('item/commandExecution/terminalInteraction', { ...scope, itemId: 'command', processId: 'SECRET process', stdin: 'SECRET input' });
    child.notify('item/completed', { ...scope, item: command });
    child.notify('item/started', { ...scope, item: file });
    child.notify('item/fileChange/patchUpdated', { ...scope, itemId: 'file', changes: file.changes });
    child.notify('item/fileChange/outputDelta', { ...scope, itemId: 'file', delta: 'SECRET file output' });
    child.notify('item/completed', { ...scope, item: file });
    child.terminal('completed', [answer]);
  } });
  const c = context(); const argumentsSeen: unknown[][] = [];
  c.input.native!.onActivity = async (...args) => { argumentsSeen.push(args); c.activities.push(args[0]); await delay(1); };
  await f.driver.execute(c.input);
  assert.deepEqual(c.activities, [
    'connecting', 'thread-ready', 'turn-started',
    'reasoning', 'reasoning', 'reasoning', 'reasoning', 'reasoning',
    'answering', 'answering', 'answering', 'answering', 'answering', 'answering',
    'command', 'command', 'command', 'command',
    'file-change', 'file-change', 'file-change', 'file-change', 'answering',
  ]);
  assert.ok(argumentsSeen.every(args => args.length === 1 && typeof args[0] === 'string'));
  assert.equal(JSON.stringify(argumentsSeen).includes('SECRET'), false);
  assert.equal(c.messages.get('answer'), answer.text);
  const count = c.activities.length;
  await f.driver.recover(f.binding, 'native-turn');
  assert.equal(c.activities.length, count);
  assert.ok(f.children[1].frames.some(frame => frame.method === 'thread/read'));
});

test('activity waits for lifecycle persistence and ignores unsubmitted or unrelated native notifications', async t => {
  const scope = { threadId: 'native-thread', turnId: 'native-turn' };
  const emitItems = (child: NativeChild, identity: typeof scope) => {
    child.notify('item/agentMessage/delta', { ...identity, itemId: 'foreign-answer', delta: 'SECRET' });
    for (const method of ['item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction', 'item/fileChange/outputDelta']) {
      child.notify(method, { ...identity, itemId: 'foreign-item', summaryIndex: 0, contentIndex: 0, delta: 'SECRET', processId: 'process', stdin: 'SECRET' });
    }
    for (const method of ['item/started', 'item/completed']) {
      child.notify(method, { ...identity, item: { id: 'foreign-command', type: 'commandExecution', command: 'SECRET', cwd: '/SECRET' } });
      child.notify(method, { ...identity, item: { id: 'foreign-file', type: 'fileChange', changes: [{ path: 'SECRET', diff: '+SECRET' }] } });
      child.notify(method, { ...identity, item: { id: 'foreign-reason', type: 'reasoning', summary: ['SECRET'] } });
    }
    child.notify('item/fileChange/patchUpdated', { ...identity, itemId: 'foreign-file', changes: [{ path: 'SECRET', diff: '+SECRET' }] });
  };
  const f = await fixture(t, { turn: child => {
    child.notify('turn/started', { threadId: 'another-thread', turn: { id: 'another-turn' } });
    emitItems(child, { threadId: 'another-thread', turnId: 'native-turn' });
    emitItems(child, { threadId: 'native-thread', turnId: 'another-turn' });
    child.notify('account/updated', { authMode: 'chatgpt' });
    child.notify('configWarning', { summary: 'SECRET warning' });
    child.notify('account/rateLimits/updated', { SECRET: true });
    child.terminal();
  } });
  const c = context(); let persisted = false;
  c.input.native!.onBinding = async binding => {
    c.bindings.push(binding);
    f.children[0].notify('turn/started', { threadId: 'native-thread', turn: { id: 'premature-turn' } });
    emitItems(f.children[0], scope);
    await delay(2); persisted = true;
  };
  c.input.native!.onActivity = async kind => {
    c.activities.push(kind);
    if (kind === 'connecting') { await delay(1); assert.equal(f.children.length, 0); }
    if (kind === 'thread-ready') {
      assert.equal(persisted, true);
      await delay(1);
      assert.equal(f.children[0].frames.some(frame => frame.method === 'turn/start'), false);
    }
  };
  await f.driver.execute(c.input);
  assert.deepEqual(c.activities, ['connecting', 'thread-ready', 'turn-started']);
  assert.deepEqual(c.turns, ['native-turn']);
  assert.equal(c.messages.size, 0);
});

test('activity callback persistence failures stop safely and never expose callback diagnostics', async t => {
  for (const target of ['connecting', 'thread-ready', 'turn-started', 'reasoning', 'answering', 'command', 'file-change'] as const) {
    const f = await fixture(t, { turn: child => {
      const scope = { threadId: 'native-thread', turnId: 'native-turn' };
      child.notify('item/reasoning/textDelta', { ...scope, itemId: 'reason', contentIndex: 0, delta: 'SECRET reasoning' });
      child.notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: 'SECRET answer' });
      child.notify('item/started', { ...scope, item: { id: 'command', type: 'commandExecution', command: 'SECRET', cwd: '/SECRET' } });
      child.notify('item/started', { ...scope, item: { id: 'file', type: 'fileChange', changes: [{ path: 'SECRET', diff: '+SECRET' }] } });
      child.terminal();
    } });
    const c = context();
    c.input.native!.onActivity = async kind => {
      c.activities.push(kind);
      if (kind === target) { await delay(1); throw new Error('SECRET activity storage path'); }
    };
    const beforeSubmission = target === 'connecting' || target === 'thread-ready';
    await assert.rejects(f.driver.execute(c.input), error => error instanceof Error && !error.message.includes('SECRET') && (beforeSubmission ? !(error instanceof NativeOutcomeUnknownError) : error instanceof NativeOutcomeUnknownError));
    assert.equal(c.activities.at(-1), target);
    assert.deepEqual(c.terminals, []);
    assert.ok(f.children.every(child => child.closed));
    if (beforeSubmission) assert.ok(f.children.every(child => !child.frames.some(frame => frame.method === 'turn/start')));
    else assert.equal(f.children[0].frames.filter(frame => frame.method === 'turn/start').length, 1);
  }
});

test('turn activity waits for a matching turn-start response and drops metadata from mismatched native turns', async t => {
  for (const matches of [true, false]) {
    let startFrame: Frame | undefined;
    const notifiedTurn = matches ? 'native-turn' : 'old-native-turn';
    const f = await fixture(t, { start: (frame, child) => {
      startFrame = frame;
      child.notify('turn/started', { threadId: 'native-thread', turn: { id: notifiedTurn } });
      child.notify('item/reasoning/textDelta', { threadId: 'native-thread', turnId: notifiedTurn, itemId: 'reason', contentIndex: 0, delta: 'SECRET reasoning' });
      child.notify('item/agentMessage/delta', { threadId: 'native-thread', turnId: notifiedTurn, itemId: 'answer', delta: 'SECRET answer' });
    } });
    const c = context(); const execution = f.driver.execute(c.input);
    const failure = matches ? undefined : assert.rejects(execution, NativeOutcomeUnknownError);
    await until(() => !!startFrame && c.messages.has('answer'));
    assert.deepEqual(c.activities, ['connecting', 'thread-ready']);
    f.children[0].reply(startFrame!.id, { turn: { id: 'native-turn', status: 'inProgress', items: [] } });
    if (matches) {
      await until(() => c.activities.length === 5);
      assert.deepEqual(c.activities, ['connecting', 'thread-ready', 'turn-started', 'reasoning', 'answering']);
      f.children[0].terminal(); await execution;
    } else {
      await failure;
      assert.deepEqual(c.activities, ['connecting', 'thread-ready']);
      assert.deepEqual(c.terminals, []);
    }
  }
});

test('activity callback cancellation before connection does not create a native process', async t => {
  const f = await fixture(t); const c = context();
  c.input.native!.onActivity = async kind => {
    c.activities.push(kind); await delay(1); c.controller.abort();
  };
  await assert.rejects(f.driver.execute(c.input), /已取消/);
  assert.deepEqual(c.activities, ['connecting']);
  assert.equal(f.children.length, 0);
});
