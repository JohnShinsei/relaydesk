import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AccountInfo, Options, PermissionResult, SDKControlInitializeResponse, SDKMessage, SDKUserMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeDriver, createClaudeDriverFromEnvironment, claudeEnvironment } from '../server/claude-driver.ts';
import type { ClaudeOptions, ClaudeSdkPort } from '../server/claude-driver.ts';
import type { EngineBinding, ExecutionContext, NativeApproval } from '../shared/types.ts';
import { NativeOutcomeUnknownError } from '../server/execution.ts';

const sessionId = '10000000-0000-4000-8000-000000000001';
// Exact metadata observed from the pinned official CLI after subscription login.
const account: AccountInfo = { apiProvider: 'firstParty', subscriptionType: 'Claude Max' };
const builtins = ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'];
class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); killed = false; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  ignoreClose = false;
  exit(code = 0) { if (this.exitCode !== null) return; this.exitCode = code; this.emit('exit', code, null); }
  kill(signal: NodeJS.Signals) { this.killed = true; this.signalCode = signal; this.exitCode = 1; this.emit('exit', 1, signal); return true; }
}
class Frames {
  queue: SDKMessage[] = []; wake?: (value: IteratorResult<SDKMessage>) => void; ended = false;
  push(message: unknown) { if (this.wake) { const wake = this.wake; this.wake = undefined; wake({ value: message as SDKMessage, done: false }); } else this.queue.push(message as SDKMessage); }
  end() { this.ended = true; this.wake?.({ value: undefined, done: true }); this.wake = undefined; }
  next(): Promise<IteratorResult<SDKMessage>> { const value = this.queue.shift(); if (value) return Promise.resolve({ value, done: false }); if (this.ended) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolve => { this.wake = resolve; }); }
  [Symbol.asyncIterator]() { return this; }
}
interface Scenario {
  account?: AccountInfo; handshakeVersion?: string;
  preflightPlugins?: { name: string; path: string }[]; preflightSkills?: string[];
  init?: Record<string, unknown>; noResult?: boolean; noExit?: boolean;
  send?: (f: { frames: Frames; input: SDKUserMessage; options: Options; child: Child; result: (extra?: Record<string, unknown>) => void }) => void | Promise<void>;
  interrupt?: (frames: Frames, input: SDKUserMessage | undefined, child: Child) => unknown;
}
async function fixture(t: TestContext, scenario: Scenario = {}, changes: Partial<ClaudeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-claude-')); const workspace = realpathSync(directory);
  await writeFile(join(workspace, 'sample.txt'), 'offline fixture\n');
  const calls: Options[] = []; const inputs: SDKUserMessage[] = []; const children: Child[] = []; const reads: unknown[] = []; const queries: { closeCount: number; interruptCount: number }[] = [];
  const sdk: ClaudeSdkPort = {
    query({ prompt, options }) {
      const frames = new Frames(); const child = new Child(); child.ignoreClose = scenario.noExit ?? false; children.push(child); calls.push(options);
      options.spawnClaudeCodeProcess!({ command: process.execPath, cwd: workspace, env: options.env ?? {}, args: [], signal: new AbortController().signal });
      const stats = { closeCount: 0, interruptCount: 0 }; queries.push(stats);
      let currentInput: SDKUserMessage | undefined;
      void (async () => {
        try {
          for await (const input of prompt) {
            currentInput = input; inputs.push(input);
            frames.push({ type: 'system', subtype: 'init', session_id: options.resume ?? sessionId, claude_code_version: '2.1.309', cwd: workspace, permissionMode: 'default', apiKeySource: 'none', agents: builtins, tools: options.tools ?? [], mcp_servers: [], plugins: [], skills: [], ...scenario.init });
            const result = (extra: Record<string, unknown> = {}) => {
              frames.push({ type: 'result', subtype: 'success', is_error: false, result: 'official result', session_id: options.resume ?? sessionId, user_message_uuid: input.uuid, terminal_reason: 'completed', ...extra });
              if (!scenario.noExit) { child.exit(); frames.end(); }
            };
            await delay(1);
            if (scenario.send) await scenario.send({ frames, input, options, child, result });
            else if (!scenario.noResult) result();
            else if (!scenario.noExit) { child.exit(); frames.end(); }
          }
        } catch { frames.end(); }
      })();
      return {
        [Symbol.asyncIterator]: () => frames,
        initializationResult: async () => ({ claude_code_version: scenario.handshakeVersion ?? '2.1.309', account: scenario.account ?? account, agents: builtins.map(name => ({ name })) } as unknown as SDKControlInitializeResponse),
        accountInfo: async () => scenario.account ?? account,
        reloadPlugins: async () => ({ plugins: scenario.preflightPlugins ?? [], commands: [], agents: builtins.map(name => ({ name, description: 'pinned built-in' })), mcpServers: [], error_count: 0 }),
        reloadSkills: async () => ({ skills: (scenario.preflightSkills ?? []).map(name => ({ name })) }) as Awaited<ReturnType<import('@anthropic-ai/claude-agent-sdk').Query['reloadSkills']>>,
        async interrupt() {
          stats.interruptCount++;
          if (scenario.interrupt) scenario.interrupt(frames, currentInput, child);
          else { frames.push({ type: 'result', subtype: 'error_during_execution', session_id: options.resume ?? sessionId, user_message_uuid: currentInput?.uuid, terminal_reason: 'aborted_tools' }); child.exit(); frames.end(); }
          return { still_queued: [] };
        },
        close() { stats.closeCount++; if (!child.ignoreClose) child.exit(); frames.end(); },
      };
    },
    async getSessionMessages(id, options) { reads.push({ id, options }); return [{ type: 'assistant', uuid: sessionId, session_id: id, message: { content: 'this is not terminal proof' }, parent_tool_use_id: null, parent_agent_id: null }]; },
  };
  const driver = createClaudeDriver({ workspace, executablePath: process.execPath, env: { PATH: 'local-runtime', HOME: '/test-home', ANTHROPIC_API_KEY: 'SECRET', ANTHROPIC_AUTH_TOKEN: 'SECRET', ANTHROPIC_BASE_URL: 'https://SECRET', NODE_OPTIONS: 'SECRET', CLAUDE_CODE_OAUTH_TOKEN: 'SECRET' }, sdk,
    versionProbe: () => ({ status: 0, stdout: '2.1.309 (Claude Code)\n' }), requestTimeoutMs: 40, timeoutMs: 400, stopConfirmationMs: 40, approvalTimeoutMs: 60,
    spawnProcess: () => children.at(-1)! as unknown as SpawnedProcess, ...changes });
  t.after(async () => { children.forEach(child => { child.ignoreClose = false; child.exit(); }); await driver.close(); await rm(directory, { recursive: true, force: true }); });
  return { driver, workspace, calls, inputs, children, queries, reads, binding: { driverId: 'claude', threadId: sessionId, workspace, version: '2.1.309' } as EngineBinding };
}
function context(binding?: EngineBinding) {
  const controller = new AbortController(); const bindings: EngineBinding[] = []; const turns: string[] = []; const approvals: NativeApproval[] = []; const messages: string[] = []; const terminals: string[] = []; const resolved: string[] = [];
  const input: ExecutionContext = {
    task: { id: 'local-task', sessionId: 'local-session', adapterId: 'claude', prompt: '/untrusted-prompt @file', mode: 'chat', status: 'running', createdAt: 'now', updatedAt: 'now', events: [] },
    history: [{ id: 'old', taskId: 'old-task', role: 'user', content: 'do not replay', createdAt: 'then' }], signal: controller.signal, emit: () => assert.fail('use native messages'),
    native: { binding, onBinding: value => { bindings.push(value); }, onTurn: value => { turns.push(value); }, onApproval: value => { approvals.push(value); },
      onApprovalResolved: value => { resolved.push(value); }, upsertMessage: (_id, text) => { messages.push(text); }, onTerminal: status => { terminals.push(status); } },
  };
  return { input, controller, bindings, turns, approvals, messages, terminals, resolved };
}
async function until(condition: () => boolean) { for (let n = 0; n < 150; n++) { if (condition()) return; await delay(2); } assert.fail('fixture did not reach expected event'); }
async function tool(options: Options, name: string, input: Record<string, unknown>, extra = {}) {
  return options.canUseTool!(name, input, { signal: new AbortController().signal, requestId: 'request-1', toolUseID: 'tool-1', ...extra });
}

test('Claude starts a fresh SDK process per task, saves intent before input and closes after exact result+exit', async t => {
  const f = await fixture(t); const c = context();
  c.input.native!.onTurn = id => { assert.equal(f.inputs.length, 0); c.turns.push(id); };
  await f.driver.execute(c.input);
  assert.deepEqual(c.terminals, ['completed']); assert.deepEqual(c.messages, ['official result']); assert.deepEqual(c.bindings, [f.binding]);
  assert.equal(f.inputs[0].uuid, c.turns[0]); assert.equal(f.inputs[0].client_composed, true); assert.deepEqual(f.inputs[0].message, { role: 'user', content: '/untrusted-prompt @file' });
  assert.ok(f.queries[0].closeCount > 0); assert.equal(f.children[0].exitCode, 0);
  await f.driver.execute(context(f.binding).input); assert.equal(f.children.length, 2); assert.equal(f.calls[1].resume, sessionId);
  assert.equal(f.calls[1].continue, false); assert.equal(f.calls[1].forkSession, false);
});

test('default tools, settings and runtime environment do not inherit API keys, endpoints or customizations', async t => {
  const f = await fixture(t); await f.driver.execute(context().input); const opts = f.calls[0];
  assert.deepEqual(opts.tools, []); assert.deepEqual(opts.settingSources, []); assert.deepEqual(opts.mcpServers, {}); assert.equal(opts.strictMcpConfig, true);
  assert.deepEqual(opts.agents, {}); assert.deepEqual(opts.plugins, []); assert.deepEqual(opts.skills, []); assert.deepEqual(opts.hooks, {});
  assert.deepEqual(opts.extraArgs, { 'safe-mode': null, 'disable-slash-commands': null });
  assert.equal(typeof opts.settings === 'object' && opts.settings.disableBundledSkills, true);
  assert.equal(typeof opts.settings === 'object' && opts.settings.enabledPlugins?.['cc-plugin-agents-md@builtin'], false);
  assert.equal(opts.permissionMode, 'default'); assert.equal(opts.allowDangerouslySkipPermissions, false); assert.equal(opts.persistSession, true);
  assert.ok(!JSON.stringify(opts.env).includes('SECRET')); assert.equal(opts.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal((await tool(opts, 'Read', { file_path: join(f.workspace, 'sample.txt') }))?.behavior, 'deny');
  assert.equal(claudeEnvironment({ ANTHROPIC_API_KEY: 'SECRET', CLAUDE_CODE_OAUTH_TOKEN: 'SECRET', NODE_OPTIONS: 'SECRET' }).ANTHROPIC_API_KEY, undefined);
});

test('native plugin and skill preflight must be empty before any prompt despite empty SDK configuration', async t => {
  for (const scenario of [{ preflightPlugins: [{ name: 'cc-plugin-agents-md', path: 'builtin' }] }, { preflightSkills: ['deep-research'] }]) {
    const f = await fixture(t, scenario); const c = context();
    await assert.rejects(f.driver.execute(c.input), error => error instanceof Error && !(error instanceof NativeOutcomeUnknownError));
    assert.deepEqual(f.inputs, []); assert.deepEqual(c.turns, []); assert.equal(f.children[0].exitCode, 0);
  }
});

test('cancellation while durable intent is saved does not deliver the prompt afterward', async t => {
  const f = await fixture(t, {}, { stopConfirmationMs: 5 }); const c = context();
  c.input.native!.onTurn = async id => { c.turns.push(id); c.controller.abort(); await delay(1); };
  await assert.rejects(f.driver.execute(c.input), error => error instanceof Error && !(error instanceof NativeOutcomeUnknownError));
  assert.equal(c.turns.length, 1); assert.deepEqual(f.inputs, []); assert.equal(f.children[0].exitCode, 0);
});

test('non-subscription or mismatched CLI handshakes refuse before any user prompt', async t => {
  for (const scenario of [ { account: { ...account, apiKeySource: 'ANTHROPIC_API_KEY' } }, { account: { ...account, apiProvider: 'bedrock' as const } }, { account: { ...account, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } }, { account: { apiProvider: 'firstParty' as const } }, { account: { ...account, subscriptionType: undefined } }, { account: { ...account, subscriptionType: 'not Claude Max' } }, { handshakeVersion: 'new-version' } ]) {
    const f = await fixture(t, scenario); await assert.rejects(f.driver.execute(context().input), error => error instanceof Error && !(error instanceof NativeOutcomeUnknownError));
    assert.deepEqual(f.inputs, []); assert.ok(f.queries[0].closeCount > 0);
  }
});

test('init scope mismatch or missing result stays unknown even if assistant text or exit 0 exists', async t => {
  for (const scenario of [ { init: { tools: ['Bash'] } }, { init: { permissionMode: 'bypassPermissions' } }, { init: { apiKeySource: 'ANTHROPIC_API_KEY' } }, { noResult: true }, { send: async ({ frames, child }: Parameters<NonNullable<Scenario['send']>>[0]) => { frames.push({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null }); child.exit(); frames.end(); } } ]) {
    const f = await fixture(t, scenario); const c = context(); await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError); assert.deepEqual(c.terminals, []);
    await assert.rejects(f.driver.execute(context().input));
  }
});

test('mismatched result identity and automatic interrupted-turn resumes are never accepted', async t => {
  for (const extra of [{ user_message_uuid: sessionId }, { session_id: 'other-session' }, { resume_reason: 'interrupted_turn' }, { queued_turn_count: 1 }]) {
    const f = await fixture(t, { send: ({ result }) => result(extra) }); const c = context();
    await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError); assert.deepEqual(c.terminals, []);
  }
});

test('environment reads require single approval with frozen parameters, never persistent permission updates', async t => {
  let answer: PermissionResult | null = null;
  const f = await fixture(t, { send: async ({ options, result }) => { const original = { file_path: join(f.workspace, 'sample.txt') }; answer = await tool(options, 'Read', original); original.file_path = 'mutated'; result(); } }, { environment: true });
  const c = context(); const execution = f.driver.execute(c.input); await until(() => c.approvals.length === 1);
  assert.equal(c.approvals[0].kind, 'tool'); assert.equal(c.approvals[0].cwd, f.workspace); assert.ok(c.approvals[0].operation.includes('sample.txt'));
  await f.driver.decideApproval(c.approvals[0].id, 'accept'); await execution;
  assert.equal((answer as unknown as PermissionResult)?.behavior, 'allow');
  assert.equal((answer as unknown as { updatedInput: { file_path: string } }).updatedInput.file_path, join(f.workspace, 'sample.txt'));
  assert.ok(!('updatedPermissions' in answer!)); await assert.rejects(f.driver.decideApproval(c.approvals[0].id, 'accept'));
  assert.deepEqual(c.terminals, ['completed']);
});

test('Bash, Edit, Write, MCP and subagents are denied even when environment is enabled', async t => {
  const decisions: unknown[] = [];
  const f = await fixture(t, { send: async ({ options, result }) => {
    for (const name of ['Bash', 'Edit', 'Write', 'Agent', 'Task', 'Skill', 'mcp__remote__tool']) decisions.push(await tool(options, name, { command: 'never run' }));
    decisions.push(await tool(options, 'Read', { file_path: join(f.workspace, 'sample.txt') }, { agentID: 'subagent' })); result();
  } }, { environment: true });
  const c = context(); await f.driver.execute(c.input); assert.equal(decisions.length, 8); assert.ok(decisions.every(value => (value as PermissionResult).behavior === 'deny')); assert.deepEqual(c.approvals, []);
});

test('read scope rejects external real paths, symlink escapes, invalid fields and traversal globs', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'relaydesk-claude-outside-')); await writeFile(join(outside, 'private.txt'), 'never read');
  t.after(() => rm(outside, { recursive: true, force: true }));
  const decisions: unknown[] = [];
  const f = await fixture(t, { send: async ({ options, result }) => {
    decisions.push(await tool(options, 'Read', { file_path: join(outside, 'private.txt') }));
    decisions.push(await tool(options, 'Read', { file_path: join(f.workspace, 'escape', 'private.txt') }));
    decisions.push(await tool(options, 'Read', { file_path: join(f.workspace, 'sample.txt'), injectedCommand: 'never run' }));
    decisions.push(await tool(options, 'Glob', { pattern: '../**/*' }));
    decisions.push(await tool(options, 'Glob', { pattern: '{.,..}/**' }));
    decisions.push(await tool(options, 'Glob', { pattern: 'C:/**' }));
    decisions.push(await tool(options, 'Read', { file_path: join(f.workspace, 'sample.txt') + ':hidden-stream' }));
    decisions.push(await tool(options, 'Glob', { pattern: '**/*' }));
    decisions.push(await tool(options, 'Grep', { pattern: 'private', path: f.workspace }));
    decisions.push(await tool(options, 'Grep', { pattern: 'private', path: join(f.workspace, 'escape') })); result();
  } }, { environment: true });
  await symlink(outside, join(f.workspace, 'escape'), 'junction');
  const c = context(); await f.driver.execute(c.input); assert.ok(decisions.every(value => (value as PermissionResult).behavior === 'deny')); assert.deepEqual(c.approvals, []);
});

test('approval timeout denies the specific call and never applies automatic allow', async t => {
  let decision: PermissionResult | null = null;
  const f = await fixture(t, { send: async ({ options, result }) => { decision = await tool(options, 'Grep', { pattern: 'offline' }); result(); } }, { environment: true, approvalTimeoutMs: 8 });
  const c = context(); await f.driver.execute(c.input); assert.equal((decision as unknown as PermissionResult)?.behavior, 'deny'); assert.equal(c.approvals.length, 1); assert.equal(c.resolved.length, 1);
});

test('stop requires interrupt receipt, matching aborted result and actual process exit', async t => {
  const f = await fixture(t, { send: async () => {} }); const c = context(); const execution = f.driver.execute(c.input);
  await until(() => c.bindings.length > 0); c.controller.abort(); await execution;
  assert.equal(f.queries[0].interruptCount, 1); assert.deepEqual(c.terminals, ['cancelled']); assert.equal(f.children[0].exitCode, 0);
});

test('stop acknowledgement alone or process exit alone cannot turn unknown into cancelled', async t => {
  const f = await fixture(t, { send: async () => {}, interrupt: (frames, _input, child) => { child.exit(); frames.end(); } });
  const c = context(); const execution = f.driver.execute(c.input); const rejection = assert.rejects(execution, NativeOutcomeUnknownError);
  await until(() => c.bindings.length > 0); c.controller.abort(); await rejection; assert.deepEqual(c.terminals, []);
});

test('unconfirmed pre-prompt process cleanup is globally unknown instead of an ordinary startup failure', async t => {
  const f = await fixture(t, { account: { ...account, apiKeySource: 'apiKeyHelper' }, noExit: true }, { stopConfirmationMs: 5 });
  const c = context(); await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError); assert.deepEqual(f.inputs, []); assert.deepEqual(c.terminals, []);
});

test('result without confirmed process exit is unknown and closes its query', async t => {
  const f = await fixture(t, { noExit: true }, { stopConfirmationMs: 5 }); const c = context();
  await assert.rejects(f.driver.execute(c.input), NativeOutcomeUnknownError); assert.deepEqual(c.terminals, []); assert.ok(f.queries[0].closeCount > 0);
});

test('recovery reads only exact native session and never treats transcript assistant text as a terminal result', async t => {
  const f = await fixture(t); const turn = '10000000-0000-4000-8000-000000000002';
  assert.equal((await f.driver.recover(f.binding, turn)).status, 'unknown'); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.reads, [{ id: sessionId, options: { dir: f.workspace, limit: 1 } }]);
  assert.equal((await f.driver.recover({ ...f.binding, threadId: '../foreign' }, turn)).status, 'unknown'); assert.equal(f.reads.length, 1);
});

test('startup factory is opt-in and rejects API billing and relative CLI paths', () => {
  assert.equal(createClaudeDriverFromEnvironment({}, process.cwd()), undefined);
  assert.throws(() => createClaudeDriverFromEnvironment({ RELAYDESK_ENABLE_CLAUDE: '1', RELAYDESK_CLAUDE_AUTH_MODE: 'api' }, process.cwd()));
  assert.throws(() => createClaudeDriver({ workspace: process.cwd(), executablePath: './claude.exe' }));
});
